// THE PRICE CHART — geometry only, from candles this app already fetched.
//
// /api/alt-coin returns up to 730 daily candles per coin and CoinDetail already
// computes ATR, swings, precedent and the whole level stack over them. It then
// drew a 104×26 sparkline of the SEVEN-DAY markets row and threw the two years
// away. This file turns those candles into a chart.
//
// NO CHART LIBRARY, AND THE MEASUREMENT THAT DECIDED IT. Macro already bundles
// lightweight-charts for the Chart tab — App.jsx imports ChartPanel eagerly, so
// it is in the same chunk whether or not this file exists, and reusing it would
// have added zero bytes. It is still not used here, for three reasons that are
// about behaviour rather than weight:
//   · it draws to a canvas, so it cannot read a CSS variable — ChartPanel says
//     so at its own palette block and hard-codes six hexes. A canvas chart in
//     the Alts detail pane would be the one surface on this tab that does not
//     follow the theme, in a repo whose house rule is that every surface has a
//     light half;
//   · it needs a mounted element with a width, and this pane renders under
//     react-dom/server in the suite and inside a `display: none` pane under
//     1020px. A chart that only exists after an effect cannot be asserted on;
//   · it instantiates per selection. The detail pane remounts on every row tap,
//     and a canvas + ResizeObserver + series rebuild per tap is real jank on a
//     phone for a line with 240 points in it.
// Inline SVG has none of those properties. `currentColor` inherits the theme,
// the markup exists at render time, and the whole geometry is the pure function
// below.
//
// PURE. No DOM, no Date.now(), no fetch. `width`/`height` come in as numbers the
// component measured; every string it prints is formatted by the component from
// the numbers returned here, so this file never decides how a price looks.
//
// THE THREE INPUTS THAT MUST NOT PRODUCE A BLANK BOX — the same three
// sparkline.jsx lists, because they are the same three and this file is the one
// with axes on it:
//
//   • fewer than two points in the window. `width / (n - 1)` divides by zero and
//     `Math.min()` of an empty array is Infinity. Refused in words, and the
//     words say how many points the window DID hold, because "1 close in 30
//     days" and "no candles at all" are different problems.
//   • a perfectly flat series. `(v - lo) / (hi - lo)` is 0/0 = NaN, and ONE NaN
//     in an SVG `points` attribute renders nothing at all, silently, with no
//     console error. A flat tape is a real state (a pegged row, a delisted row)
//     and it is drawn on the midline with ONE axis label, because three labels
//     reading the same number is an axis pretending to have a scale.
//   • close-only candles. The CoinGecko market_chart fallback sets
//     o = h = l = c on every bar and the payload says so in `candleQuality`.
//     This file only ever reads `.c`, so a close-only tape draws exactly the
//     same line as an OHLC one — but the CALLER is told, because a line chart
//     that silently swallows the difference is how "close-only" stops being
//     visible anywhere on the pane.

/**
 * The ranges offered. `days` is a WINDOW IN DAYS measured back from the newest
 * candle, never a count of candles: a coin with a two-week gap in its tape has
 * 30 candles that span two months, and `slice(-30)` would label that "30d".
 * Same rule season.js and pulse.js keep for the dominance history.
 */
export const CHART_RANGES = [
  { id: '30d', days: 30, label: '30d' },
  { id: '90d', days: 90, label: '90d' },
  { id: '1y', days: 365, label: '1y' },
  { id: 'max', days: null, label: 'Max' },
]

const DEFAULT_RANGE = '90d'
const MAX_DRAWN = 240

/**
 * Which ranges this tape can actually fill, plus the one to open on.
 *
 * A `1y` button on a coin with forty days of history is a control that redraws
 * the same picture — it looks like the chart is broken. Ranges wider than the
 * tape are dropped, `Max` always survives (it is whatever there is), and the
 * default falls back to the widest that fits.
 *
 * @param candles  [{ t, c }] — `t` in SECONDS, the shape alt-coin.mjs emits
 */
export function availableRanges(candles) {
  const bars = cleanBars(candles)
  if (bars.length < 2) return { ranges: [CHART_RANGES[CHART_RANGES.length - 1]], initial: 'max', spanDays: bars.length ? 0 : null }
  const spanDays = Math.round((bars[bars.length - 1].t - bars[0].t) / 86_400)
  // `days < spanDays`, not `<=`: a 30d button on a tape that spans exactly 30
  // days draws the identical line to Max.
  const ranges = CHART_RANGES.filter((r) => r.days == null || r.days < spanDays)
  const has = (id) => ranges.some((r) => r.id === id)
  const initial = has(DEFAULT_RANGE) ? DEFAULT_RANGE : ranges.length > 1 ? ranges[ranges.length - 2].id : 'max'
  return { ranges, initial, spanDays }
}

/**
 * Everything the SVG needs, for one range.
 *
 * @param candles  [{ t, c }] — daily bars, oldest first, `t` in seconds
 * @param opts
 *   rangeDays  window in days back from the NEWEST candle; null = the whole tape
 *   width      px of the drawing box, from the component's measurement
 *   height     px
 *   padRight   px reserved for the price axis (0 when it is not drawn)
 *   padBottom  px reserved for the date axis (0 when it is not drawn)
 *   padTop     px of headroom so the stroke is not clipped by the viewBox
 *   yTicks     how many price gridlines to place (clamped to 1 on a flat tape)
 *   xTicks     how many date labels to place
 *
 * @returns
 *   ok / reason              a refusal always says which arithmetic failed
 *   n / windowDays           how many closes were IN the window and its span
 *   drawn                    how many of them the polyline actually plots
 *   lo / hi                  the window's true extremes — see the note below
 *   first / last / changePct the ends of the window and the move between them
 *   flat                     hi === lo
 *   line                     the polyline `points` string
 *   area                     the same path closed to the baseline, for the wash
 *   yAxis / xAxis            [{ v, y }] and [{ t, x }] — VALUES, never strings
 *   plot                     { x, y, w, h } of the drawing box inside the svg
 *
 * lo/hi ARE TAKEN OVER EVERY POINT IN THE WINDOW, NOT OVER THE PLOTTED ONES.
 * The polyline is downsampled to MAX_DRAWN, and taking the extremes from the
 * SAMPLE would put the axis inside the data: a spike the stride skipped would
 * be labelled below the top gridline while the number beside it said otherwise.
 * Sampled ⊂ window, so the drawn line can never leave the box, and the axis
 * describes the window the caption names.
 */
export function priceChart(candles, {
  rangeDays = null, width = 640, height = 220,
  padTop = 8, padRight = 0, padBottom = 0, padLeft = 0,
  yTicks = 3, xTicks = 3, maxDrawn = MAX_DRAWN,
} = {}) {
  const refuse = (reason, extra = {}) => ({
    ok: false, reason,
    n: 0, drawn: 0, windowDays: null, lo: null, hi: null,
    first: null, last: null, changePct: null, flat: false,
    line: null, area: null, yAxis: [], xAxis: [],
    plot: { x: padLeft, y: padTop, w: 0, h: 0 },
    ...extra,
  })

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return refuse('the chart box has no size yet')
  }

  const all = cleanBars(candles)
  if (all.length === 0) {
    return refuse('no daily candles arrived for this coin, so there is no line to draw')
  }

  const newest = all[all.length - 1].t
  const window = Number.isFinite(rangeDays) && rangeDays > 0
    ? all.filter((b) => b.t > newest - rangeDays * 86_400)
    : all

  if (window.length < 2) {
    return refuse(Number.isFinite(rangeDays)
      ? `only ${window.length} daily close${window.length === 1 ? '' : 's'} inside the last ${rangeDays} days (the tape holds ${all.length}) — a line needs two points, so this range is not drawn rather than drawn as a dot`
      : `only ${all.length} daily close${all.length === 1 ? '' : 's'} in the whole tape — a line needs two points`,
    { n: window.length })
  }

  // Every point in the window decides the scale; a sample of them is drawn.
  const lo = Math.min(...window.map((b) => b.c))
  const hi = Math.max(...window.map((b) => b.c))
  const span = hi - lo
  const flat = !(span > 0)

  const first = window[0].c
  const last = window[window.length - 1].c
  // A zero or negative first close cannot be a denominator. That is not a
  // hypothetical on a micro cap whose feed printed a 0 — and a percentage off
  // it comes back as Infinity, which sorts and renders as a real number.
  const changePct = first > 0 ? ((last / first) - 1) * 100 : null

  const plot = {
    x: padLeft,
    y: padTop,
    w: Math.max(1, width - padLeft - padRight),
    h: Math.max(1, height - padTop - padBottom),
  }

  const pts = stride(window, Math.max(2, Math.round(maxDrawn)))
  const t0 = window[0].t
  const tSpan = window[window.length - 1].t - t0
  // A window whose bars all carry the same timestamp is malformed, not flat —
  // spacing by index is the only thing left that is not a divide by zero.
  const xOf = (b, i) => (tSpan > 0
    ? plot.x + ((b.t - t0) / tSpan) * plot.w
    : plot.x + (i / (pts.length - 1)) * plot.w)
  // flat: the midline. This is the 0/0 the header names.
  const yOf = (c) => (flat ? plot.y + plot.h / 2 : plot.y + plot.h - ((c - lo) / span) * plot.h)

  const coords = pts.map((b, i) => [r2(xOf(b, i)), r2(yOf(b.c))])
  const line = coords.map(([x, y]) => `${x},${y}`).join(' ')
  const baseline = r2(plot.y + plot.h)
  const area = `${coords[0][0]},${baseline} ${line} ${coords[coords.length - 1][0]},${baseline}`

  // ONE label on a flat tape. Three gridlines all reading $1.0000 is an axis
  // claiming a scale the data does not have.
  const nY = flat ? 1 : Math.max(1, Math.round(yTicks))
  const yAxis = []
  if (padRight > 0 || padLeft > 0) {
    for (let i = 0; i < nY; i++) {
      const f = nY === 1 ? 0.5 : i / (nY - 1)
      const v = flat ? lo : hi - f * span
      yAxis.push({ v, y: r2(plot.y + f * plot.h) })
    }
  }

  const nX = Math.max(2, Math.round(xTicks))
  const xAxis = []
  if (padBottom > 0) {
    for (let i = 0; i < nX; i++) {
      const f = i / (nX - 1)
      const idx = Math.round(f * (window.length - 1))
      xAxis.push({ t: window[idx].t, x: r2(plot.x + f * plot.w) })
    }
  }

  return {
    ok: true, reason: null,
    n: window.length,
    drawn: pts.length,
    windowDays: Math.round((window[window.length - 1].t - t0) / 86_400),
    lo, hi, first, last, changePct, flat,
    line, area, yAxis, xAxis, plot,
    from: t0, to: window[window.length - 1].t,
  }
}

/** Which way the window went, for colour only — and `flat` is a third answer,
 *  not a rounding of the other two. */
export function chartDirection(read) {
  if (!read?.ok) return null
  if (read.last > read.first) return 'up'
  if (read.last < read.first) return 'down'
  return 'flat'
}

/* ══ local helpers ══════════════════════════════════════════════════════════ */

/** Bars with a usable timestamp and close, oldest first. A bar missing either is
 *  dropped rather than interpolated — a chart is allowed to have a gap, it is
 *  not allowed to invent a price. */
function cleanBars(candles) {
  if (!Array.isArray(candles)) return []
  const out = []
  for (const b of candles) {
    if (!b || typeof b !== 'object') continue
    const t = Number(b.t)
    const c = Number(b.c)
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue
    out.push({ t, c })
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

/** Evenly spaced sample that always keeps the FIRST and LAST bars — sparkline
 *  .jsx's rule, for its reason: dropping the last one hides what happened in the
 *  final session, which is the only part of the tape anybody is trading. */
function stride(values, max) {
  if (values.length <= max) return values
  const step = (values.length - 1) / (max - 1)
  const out = []
  for (let i = 0; i < max; i++) out.push(values[Math.round(i * step)])
  return out
}

/** Two decimals is well under a device pixel at these sizes and roughly halves
 *  the markup; `Number()` drops the zeros `toFixed` adds back. */
function r2(x) { return Number(x.toFixed(2)) }
