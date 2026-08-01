// THE PRICE CHART — inline SVG over the candles /api/alt-coin already returned.
//
// It costs NO extra network. `payload.candles` is up to 730 daily bars and
// CoinDetail already runs ATR, swings, the whole precedent engine and the level
// stack over them; the pane then drew a 26px sparkline of the SEVEN-DAY markets
// row and dropped the two years. This is the same request, read.
//
// GEOMETRY IS IN lib/alts/chart.js AND NOT HERE. Every coordinate, every tick
// position and every refusal sentence is a pure function of the candles, tested
// against a flat tape, a one-point window and a tape with one timestamp — the
// three inputs that put a NaN in a `points` attribute, which renders NOTHING at
// all with no console error. This file measures a box, picks a range and prints
// strings. It computes no price.
//
// EVERY PRICE STRING IS `fmtAltPx`, THE BOARD'S OWN. The chart is opened from a
// row and sits directly above the directive's four levels, so an axis that
// rounded differently from the row would be the same coin quoted two ways on one
// screen — the reason AltBoard exports its formatters in the first place.
//
// IT MEASURES ITS BOX RATHER THAN SCALING ONE. `preserveAspectRatio="none"` is
// what the sparkline does, and it is right for a shape in a fixed cell — but it
// stretches TEXT, and this chart has axis labels on it. So the viewBox is the
// element's real pixel size, taken with a ResizeObserver, and the labels render
// at 1:1 at every pane width. Before the observer fires (server render, and the
// first frame in a browser) it draws at a 640px default: the line is honest at
// any width, so a first paint at the wrong width is a reflow, not a wrong
// number.
//
// TWO SIZES, ONE COMPONENT. Collapsed it is a 88px band with no axes — the same
// job the sparkline had, done over the range you chose. Expanded it is 260px
// with a price axis on the right and three dates under it. The axis padding is
// passed INTO the geometry, so a collapsed chart is not an expanded one with the
// labels hidden; the line genuinely uses the full width.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { priceChart, availableRanges, chartDirection } from '../../lib/alts/chart.js'
import { fmtAltPx, pctText } from './AltBoard.jsx'

const COLLAPSED_H = 88
const EXPANDED_H = 260
// Room for the price axis and the date row, in the expanded state only.
const AXIS_W = 52
const AXIS_H = 20
const PAD_TOP = 8
const FALLBACK_W = 640

export default function PriceChart({ candles, quality = null, source = null, symbol = '' }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)
  const [width, setWidth] = useState(FALLBACK_W)

  // The ranges this tape can fill, and the one to open on. Keyed on the candles,
  // so switching coin re-picks a sensible default instead of keeping the last
  // coin's range on a tape that cannot fill it.
  const { ranges, initial, spanDays } = useMemo(() => availableRanges(candles), [candles])
  const [rangeId, setRangeId] = useState(initial)
  const active = ranges.find((r) => r.id === rangeId) ?? ranges[ranges.length - 1]
  useEffect(() => { setRangeId(initial) }, [initial, candles])

  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      // A pane that is `display: none` measures 0. Keeping the last good width
      // means the chart is already drawn at the right size the frame it is
      // revealed, instead of drawing once at zero and once again after.
      if (w > 0) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const height = open ? EXPANDED_H : COLLAPSED_H
  const read = useMemo(() => priceChart(candles, {
    rangeDays: active?.days ?? null,
    width, height,
    padTop: PAD_TOP,
    padRight: open ? AXIS_W : 0,
    padBottom: open ? AXIS_H : 0,
  }), [candles, active, width, height, open])

  const dir = chartDirection(read) ?? 'flat'
  const label = active?.label ?? 'Max'

  return (
    <div className="alt-chart" data-testid="alt-chart">
      <div className="alt-chart-top">
        <span className="alt-chart-k t-label">Price · daily</span>
        {read.ok && (
          <span className={`alt-chart-move num tone-${dir}`}>
            {read.changePct == null ? '—' : pctText(read.changePct)}
            <span className="alt-chart-movek"> over {label}</span>
          </span>
        )}
        {/* The range control. `.seg` is the kit's, so this is the same switch the
            Chart tab's MSTR/BTC toggle is — one dialect for one job. Only the
            ranges this tape can fill are rendered: a `1y` button on forty days
            of history is a control that redraws the same picture. */}
        <div className="seg alt-chart-seg" role="tablist" aria-label="Chart range">
          {ranges.map((r) => (
            <button
              key={r.id}
              type="button" role="tab"
              className={`seg-opt${r.id === active?.id ? ' active' : ''}`}
              aria-selected={r.id === active?.id}
              onClick={() => setRangeId(r.id)}
            >{r.label}</button>
          ))}
        </div>
        <button
          type="button" className="btn ghost sm alt-chart-exp"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >{open ? 'Smaller' : 'Expand'}</button>
      </div>

      <div className="alt-chart-box" ref={boxRef} style={{ height }}>
        {read.ok ? (
          <svg
            className={`alt-chartsvg dir-${dir}`}
            viewBox={`0 0 ${width} ${height}`}
            width="100%" height={height}
            role="img"
            aria-label={
              `${symbol || 'This coin'} daily closes over ${label}: ` +
              `${fmtAltPx(read.first)} to ${fmtAltPx(read.last)}` +
              `${read.changePct == null ? '' : `, ${pctText(read.changePct)}`}, ` +
              `low ${fmtAltPx(read.lo)}, high ${fmtAltPx(read.hi)}, ` +
              `${read.n} daily close${read.n === 1 ? '' : 's'}.`
            }
          >
            {/* Gridlines first, so the line is never drawn under one. Hairlines
                on `--line`, which has a light half — this chart is the same
                drawing in both themes. */}
            {read.yAxis.map((t) => (
              <line
                key={`g${t.y}`} className="alt-chart-grid"
                x1={read.plot.x} x2={read.plot.x + read.plot.w} y1={t.y} y2={t.y}
              />
            ))}
            {/* The wash under the line, in the line's own colour at 12%. It is
                what makes a 88px band read as a chart rather than a scribble. */}
            <polygon className="alt-chart-fill" points={read.area} />
            <polyline
              className="alt-chart-line" points={read.line}
              fill="none" stroke="currentColor" strokeWidth="1.75"
              strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
            />
            {/* The last price, marked. It is the number every level in the card
                below is measured from. */}
            <circle
              className="alt-chart-dot"
              cx={read.plot.x + read.plot.w} cy={lastY(read)} r="2.5"
            />
            {read.yAxis.map((t) => (
              <text
                key={`y${t.y}`} className="alt-chart-ylab"
                x={width - 4} y={clampLabelY(t.y, height)} textAnchor="end"
              >{fmtAltPx(t.v)}</text>
            ))}
            {read.xAxis.map((t, i) => (
              <text
                key={`x${t.t}`} className="alt-chart-xlab"
                x={t.x} y={height - 6}
                textAnchor={i === 0 ? 'start' : i === read.xAxis.length - 1 ? 'end' : 'middle'}
              >{dayLabel(t.t, read.windowDays)}</text>
            ))}
          </svg>
        ) : (
          // A refusal, in the lib's own words. Not an empty box: a blank chart
          // area says the price is flat, and the sentence says there is no line.
          <p className="sub t-foot alt-chart-none">{read.reason}</p>
        )}
      </div>

      <p className="tiny t-cap alt-chart-foot">
        {read.ok
          ? `${read.n} daily close${read.n === 1 ? '' : 's'} over ${read.windowDays} day${read.windowDays === 1 ? '' : 's'}` +
            `${read.drawn < read.n ? `, drawn from ${read.drawn} of them` : ''}` +
            `${Number.isFinite(spanDays) ? ` · ${spanDays} days on file` : ''}`
          : 'no line drawn'}
        {quality === 'close-only'
          // The one thing a line chart cannot show you about itself. Every bar
          // in this fallback has high = low = close, so the line is complete and
          // the RANGE inside each day is missing — which is also why the card
          // above has no ATR-based stop on this coin.
          ? ' · close-only candles (CoinGecko market_chart): one close per day, no intraday range'
          : ''}
        {source ? ` · ${source}` : ''}
      </p>
    </div>
  )
}

/** Where the last plotted point sits, for the marker. Read off the geometry
 *  rather than recomputed, so the dot cannot land anywhere the line does not. */
function lastY(read) {
  const pts = String(read.line).split(' ')
  const y = Number(pts[pts.length - 1]?.split(',')[1])
  return Number.isFinite(y) ? y : read.plot.y + read.plot.h / 2
}

/** Keep a price label inside the box. The top tick sits at y = padTop, and a
 *  baseline-aligned label there is clipped by the viewBox on its ascender. */
function clampLabelY(y, height) {
  return Math.min(height - 2, Math.max(9, y + 3.5))
}

/**
 * A date under the axis. Short windows want a day, long ones want a month —
 * "9 Oct" repeated three times across two years is not an axis.
 *
 * UTC, deliberately: the candles are daily bars stamped at 00:00 UTC by both
 * upstreams, so rendering them in the reader's zone shifts every label by a day
 * for anyone west of Greenwich.
 */
function dayLabel(tSec, windowDays) {
  const d = new Date(tSec * 1000)
  if (!Number.isFinite(d.getTime())) return ''
  const mon = d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })
  if (windowDays != null && windowDays > 200) {
    return `${mon} ${String(d.getUTCFullYear()).slice(2)}`
  }
  return `${d.getUTCDate()} ${mon}`
}
