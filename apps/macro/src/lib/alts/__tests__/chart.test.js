// The chart is geometry, and geometry is the part that fails silently.
//
// An SVG polyline with ONE NaN in its `points` attribute renders nothing at all
// — no console error, no broken box, just an empty rectangle where a chart was.
// So the assertions below are mostly "is every coordinate a finite number", run
// over the three inputs that produce NaN: a flat tape (0/0), a one-point window
// (width ÷ 0), and a tape whose bars all share a timestamp.
//
// Every test here fails against a naive implementation, which is the bar.

import { describe, it, expect } from 'vitest'
import { priceChart, availableRanges, chartDirection, CHART_RANGES } from '../chart.js'

const DAY = 86_400
const T0 = 1_700_000_000        // a Tuesday, seconds

/** `n` daily bars ending at T0, closes from `f(i)`. The shape alt-coin.mjs
 *  emits: seconds, and o/h/l/c together (close-only sets them all equal). */
const tape = (n, f = (i) => 100 + i) =>
  Array.from({ length: n }, (_, i) => {
    const c = f(i)
    return { t: T0 - (n - 1 - i) * DAY, o: c, h: c, l: c, c, v: 1000 }
  })

const coords = (s) => s.split(' ').map((p) => p.split(',').map(Number))
const allFinite = (s) => coords(s).every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))

describe('priceChart draws or refuses, never a blank box', () => {
  it('plots a normal tape inside the box, every coordinate finite', () => {
    const r = priceChart(tape(120), { rangeDays: 90, width: 600, height: 200, padTop: 8, padRight: 46, padBottom: 18 })
    expect(r.ok).toBe(true)
    expect(allFinite(r.line)).toBe(true)
    const xs = coords(r.line).map((p) => p[0])
    const ys = coords(r.line).map((p) => p[1])
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(r.plot.x)
    expect(Math.max(...xs)).toBeLessThanOrEqual(r.plot.x + r.plot.w + 0.01)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(r.plot.y - 0.01)
    expect(Math.max(...ys)).toBeLessThanOrEqual(r.plot.y + r.plot.h + 0.01)
  })

  it('windows by DAYS from the newest bar, not by a count of bars', () => {
    // A tape with a hole in it: 10 recent days, then a two-month gap, then 10.
    const recent = tape(10)
    const old = Array.from({ length: 10 }, (_, i) => ({ t: T0 - (90 + i) * DAY, c: 50 }))
    const r = priceChart([...old.reverse(), ...recent], { rangeDays: 30, width: 400, height: 150, padRight: 40, padBottom: 16 })
    // slice(-30) would have taken all 20 bars and called 100 days "30d".
    expect(r.n).toBe(10)
    expect(r.windowDays).toBe(9)
  })

  it('a FLAT tape draws on the midline with one axis label — not NaN, not three identical ticks', () => {
    const r = priceChart(tape(60, () => 1), { rangeDays: null, width: 400, height: 200, padTop: 8, padRight: 40, padBottom: 16 })
    expect(r.ok).toBe(true)
    expect(r.flat).toBe(true)
    expect(allFinite(r.line)).toBe(true)
    const ys = new Set(coords(r.line).map((p) => p[1]))
    expect(ys.size).toBe(1)
    expect([...ys][0]).toBeCloseTo(r.plot.y + r.plot.h / 2, 5)
    expect(r.yAxis).toHaveLength(1)
    expect(r.yAxis[0].v).toBe(1)
    expect(r.changePct).toBe(0)          // a measurement: it did not move
  })

  it('refuses a window with fewer than two closes, and says how many it had', () => {
    const r = priceChart(tape(1), { rangeDays: 30, width: 400, height: 200 })
    expect(r.ok).toBe(false)
    expect(r.line).toBeNull()
    expect(r.reason).toMatch(/1 daily close/)
    expect(r.reason).toMatch(/a line needs two points/)
  })

  it('refuses an empty or absent tape in words, and never throws on junk', () => {
    for (const junk of [null, undefined, [], 'x', [{}, { t: 'a', c: 'b' }], [{ t: 1 }]]) {
      const r = priceChart(junk, { width: 300, height: 100 })
      expect(r.ok).toBe(false)
      expect(typeof r.reason).toBe('string')
      expect(r.reason.length).toBeGreaterThan(20)
    }
  })

  it('refuses a box with no size rather than dividing by it', () => {
    expect(priceChart(tape(50), { width: 0, height: 200 }).ok).toBe(false)
    expect(priceChart(tape(50), { width: 300, height: 0 }).reason).toMatch(/no size/)
  })

  it('never divides by a zero time span when every bar shares a timestamp', () => {
    const same = Array.from({ length: 5 }, (_, i) => ({ t: T0, c: 10 + i }))
    const r = priceChart(same, { rangeDays: null, width: 300, height: 100, padRight: 40 })
    expect(r.ok).toBe(true)
    expect(allFinite(r.line)).toBe(true)
  })

  it('does not divide a change by a zero or negative first close', () => {
    const r = priceChart(tape(30, (i) => (i === 0 ? 0 : i)), { rangeDays: null, width: 300, height: 100 })
    expect(r.ok).toBe(true)
    expect(r.changePct).toBeNull()       // not Infinity, not 0
  })

  it('takes the scale from EVERY point in the window, not from the drawn sample', () => {
    // One spike, deliberately at an index the stride will skip.
    const bars = tape(700, (i) => (i === 351 ? 9999 : 100))
    const r = priceChart(bars, { rangeDays: null, width: 600, height: 200, padRight: 40, maxDrawn: 60 })
    expect(r.drawn).toBe(60)
    expect(r.n).toBe(700)
    expect(r.hi).toBe(9999)              // the axis knows about the spike
    // …and the drawn line still cannot leave the box.
    const ys = coords(r.line).map((p) => p[1])
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(r.plot.y - 0.01)
  })

  it('keeps the first and last bar through the downsample', () => {
    const r = priceChart(tape(700), { rangeDays: null, width: 600, height: 200, maxDrawn: 40 })
    expect(r.first).toBe(100)
    expect(r.last).toBe(799)
    expect(r.from).toBe(T0 - 699 * DAY)
    expect(r.to).toBe(T0)
  })

  it('emits axis TICK VALUES, never formatted strings — the caller owns the words', () => {
    const r = priceChart(tape(200), { rangeDays: 90, width: 600, height: 200, padRight: 46, padBottom: 18 })
    expect(r.yAxis).toHaveLength(3)
    for (const t of r.yAxis) { expect(typeof t.v).toBe('number'); expect(Number.isFinite(t.y)).toBe(true) }
    expect(r.yAxis[0].v).toBeCloseTo(r.hi, 6)
    expect(r.yAxis[2].v).toBeCloseTo(r.lo, 6)
    expect(r.xAxis).toHaveLength(3)
    for (const t of r.xAxis) expect(Number.isFinite(t.t)).toBe(true)
    expect(r.xAxis[0].t).toBe(r.from)
    expect(r.xAxis[2].t).toBe(r.to)
  })

  it('draws no axis at all when no room was reserved for one', () => {
    const r = priceChart(tape(200), { rangeDays: 30, width: 300, height: 88, padRight: 0, padBottom: 0 })
    expect(r.ok).toBe(true)
    expect(r.yAxis).toEqual([])
    expect(r.xAxis).toEqual([])
    expect(allFinite(r.line)).toBe(true)
  })

  it('draws a close-only tape identically — o=h=l=c changes nothing here', () => {
    const closes = tape(90)
    const flatBars = closes.map((b) => ({ t: b.t, o: b.c, h: b.c, l: b.c, c: b.c }))
    expect(priceChart(flatBars, { rangeDays: 90, width: 400, height: 150 }).line)
      .toBe(priceChart(closes, { rangeDays: 90, width: 400, height: 150 }).line)
  })

  it('closes the area path back to the baseline so a wash cannot leak upward', () => {
    const r = priceChart(tape(50), { rangeDays: null, width: 300, height: 120, padTop: 8, padBottom: 16 })
    const pts = coords(r.area)
    const base = r.plot.y + r.plot.h
    expect(pts[0][1]).toBeCloseTo(base, 2)
    expect(pts[pts.length - 1][1]).toBeCloseTo(base, 2)
    expect(allFinite(r.area)).toBe(true)
  })
})

describe('availableRanges only offers a control that changes the picture', () => {
  it('drops ranges wider than the tape, and always keeps Max', () => {
    const short = availableRanges(tape(40))
    expect(short.ranges.map((r) => r.id)).toEqual(['30d', 'max'])
    expect(short.spanDays).toBe(39)
    const long = availableRanges(tape(730))
    expect(long.ranges.map((r) => r.id)).toEqual(CHART_RANGES.map((r) => r.id))
  })

  it('opens on 90d where the tape supports it, and on the widest that fits where it does not', () => {
    expect(availableRanges(tape(400)).initial).toBe('90d')
    expect(availableRanges(tape(40)).initial).toBe('30d')
    expect(availableRanges(tape(10)).initial).toBe('max')
  })

  it('survives a tape too short to span anything', () => {
    for (const junk of [null, [], tape(1)]) {
      const a = availableRanges(junk)
      expect(a.ranges).toHaveLength(1)
      expect(a.initial).toBe('max')
    }
  })
})

describe('chartDirection has three answers, not two', () => {
  const at = (n, f) => priceChart(tape(n, f), { rangeDays: null, width: 300, height: 100 })
  it('separates flat from up and down', () => {
    expect(chartDirection(at(30, (i) => 100 + i))).toBe('up')
    expect(chartDirection(at(30, (i) => 100 - i))).toBe('down')
    expect(chartDirection(at(30, () => 100))).toBe('flat')
    expect(chartDirection({ ok: false })).toBeNull()
  })
})
