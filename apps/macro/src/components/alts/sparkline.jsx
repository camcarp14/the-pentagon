// The 7-day sparkline — inline SVG, built from `sparkline7d`. No chart library,
// no external asset, no network. It is a SHAPE, not a chart: no axes, no labels,
// no tooltip. The board already prints 24h / 7d / 30d in the columns beside it;
// what those numbers cannot say is whether +18% came from one candle or six days
// of grind, and that is the only question this column answers.
//
// THREE INPUTS THAT ARE NORMAL HERE AND EACH USED TO PRODUCE A BLANK COLUMN:
//
//   • null / undefined — CoinGecko omits `sparkline_in_7d` on plenty of rows,
//     and `parseCoinGeckoMarkets` passes that through as null rather than
//     inventing a series. `.filter()` on null throws; the guard is not optional.
//
//   • fewer than two points — a listing hours old. One point has no line to
//     draw and `width / (n - 1)` divides by zero.
//
//   • a perfectly flat series — a pegged row, a delisted row, a stub feed. The
//     range `max - min` is 0, so `(v - min) / range` is NaN for every point. An
//     SVG polyline with a single NaN in its `points` attribute renders NOTHING,
//     silently, with no console error — the column simply goes blank on exactly
//     the rows whose flatness is the interesting fact about them. A flat series
//     is drawn on the midline instead, which is what it actually looks like.
//
// WHY IT DOWNSAMPLES: the payload is 168 hourly closes. At 72px wide that is
// more than two points per pixel, and 250 rows × 168 coordinates is ~42,000
// numbers of markup for detail no one can see. Striding to 48 keeps the shape
// and cuts the string by two thirds.

const MAX_POINTS = 48

/**
 * The polyline `points` string, or null when there is nothing honest to draw.
 * Pure: no DOM, no defaults read from the document.
 *
 * @param series  number[] | null — hourly closes, oldest first
 * @returns string | null
 */
export function sparkPoints(series, { width = 72, height = 20, pad = 1.5, maxPoints = MAX_POINTS } = {}) {
  const clean = Array.isArray(series) ? series.filter((v) => Number.isFinite(v)) : []
  if (clean.length < 2) return null
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null

  const pts = stride(clean, Math.max(2, Math.round(maxPoints)))
  const lo = Math.min(...pts)
  const hi = Math.max(...pts)
  const span = hi - lo

  // The drawable band, inset by the stroke's own half-width so the extremes are
  // not clipped by the viewBox edge.
  const top = pad
  const bottom = Math.max(pad + 1, height - pad)
  const usable = bottom - top
  const dx = width / (pts.length - 1)

  const out = []
  for (let i = 0; i < pts.length; i++) {
    // span === 0 is the flat series: every point sits on the midline. This is
    // the divide-by-zero the header names.
    const t = span > 0 ? (pts[i] - lo) / span : 0.5
    out.push(`${trim(i * dx)},${trim(bottom - t * usable)}`)
  }
  return out.join(' ')
}

/** Which way the week went, for colour only. Null when there is no series. */
export function sparkDirection(series) {
  const clean = Array.isArray(series) ? series.filter((v) => Number.isFinite(v)) : []
  if (clean.length < 2) return null
  const first = clean[0]
  const last = clean[clean.length - 1]
  return last > first ? 'up' : last < first ? 'down' : 'flat'
}

/**
 * The component. Renders an em-dash placeholder rather than an empty box when
 * there is no series — a missing sparkline and a flat one must not look the
 * same, because one means "no data" and the other means "nothing happened".
 */
export function Sparkline({ data, width = 72, height = 20, label }) {
  const points = sparkPoints(data, { width, height })
  if (!points) {
    return (
      <span className="alt-spark-none num" title="no 7-day series on this row">—</span>
    )
  }
  const dir = sparkDirection(data) ?? 'flat'
  return (
    <svg
      className={`alt-spark dir-${dir}`}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      // The box is a fixed cell in a dense grid, so the drawing stretches to it;
      // `vector-effect` then keeps the stroke 1.5px instead of scaling with it.
      preserveAspectRatio="none"
      role="img"
      aria-label={label || '7-day price shape'}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/** Evenly spaced sample that always keeps the FIRST and LAST points — dropping
 *  the last one would hide a break that happened in the final hours, which is
 *  the single thing the board is hunting for. */
function stride(values, max) {
  if (values.length <= max) return values
  const step = (values.length - 1) / (max - 1)
  const out = []
  for (let i = 0; i < max; i++) out.push(values[Math.round(i * step)])
  return out
}

/** Two decimals is well under a device pixel at these sizes and halves the
 *  markup; `Number()` drops the trailing zeros `toFixed` adds back. */
function trim(x) { return Number(x.toFixed(2)) }
