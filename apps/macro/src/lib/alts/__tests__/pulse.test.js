// pulse.js is the layer that gives the alt tab a memory, and a memory is
// exactly the kind of feature that fails quietly: an empty diff and a diff that
// could not run render as the same blank strip unless something forces them
// apart. So the cases below are weighted towards the REFUSALS — no baseline, the
// same pass twice, a baseline newer than the board, a dominance history one day
// short — because those are the states this file ships in on day one and the
// ones where a neutral-looking "nothing changed" is a lie about the market.
//
// The other half is the arithmetic: a band transition has a direction, and the
// direction comes from screen.js's own ladder rather than from a second list
// written here. There is a test below that reads screen.js's source to prove the
// two orders are still the same order, because the day they drift every
// "quiet → starting" on the dashboard silently reverses.
import { describe, it, expect } from 'vitest'
import {
  BAND_SEQUENCE, BAND_PRIORITY, BAND_MEANING, ACTIONABLE_BANDS,
  bandStep, bandOrder, bandDistribution, boardSnapshot, boardDelta,
  altShareSeries, bandLeaders, spanLabel,
} from '../pulse.js'
import { screenUniverse } from '../screen.js'
import { seasonRead } from '../season.js'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

/** A screened-looking row. Only the five fields boardSnapshot reads matter. */
const row = (over = {}) => ({
  id: 'x', symbol: 'X', name: 'Coin X', score: 50, band: 'quiet',
  flags: { freshBreak: false, parabolic: false, thinLiquidity: false }, ...over,
})

const board = (rows, asOf = NOW) => boardSnapshot(rows, { asOf })

/* ══ the two band orders ═══════════════════════════════════════════════════ */

describe('the two band orders are two different things', () => {
  it('holds the same six bands in both, in different orders', () => {
    expect([...BAND_SEQUENCE].sort()).toEqual([...BAND_PRIORITY].sort())
    expect(BAND_SEQUENCE).not.toEqual(BAND_PRIORITY)
    for (const b of BAND_SEQUENCE) expect(BAND_MEANING[b], `${b} has no meaning line`).toBeTruthy()
  })

  it('knows exactly the bands screen.js can emit — no more and no fewer', () => {
    // THE DRIFT THIS EXISTS TO CATCH. `to > from` in boardDelta is what makes a
    // transition an ADVANCE, and `from`/`to` are indices into BAND_SEQUENCE. A
    // seventh band added to screen.js, or one renamed, gets `bandStep() === null`
    // here and silently stops producing transitions — a dashboard that reports
    // nothing happened on the day a coin crossed into the new state.
    //
    // It is a SET comparison and deliberately not an order one. bandOf() is a
    // first-match ladder and its order is not the move's order: `starting` is
    // tested before `underway` because it is the stricter test (it caps 7d at
    // 40%), not because ignition happens after a run. The sequence is authored
    // here, with that reason, and the two files share only the vocabulary.
    const { readFileSync } = require('node:fs')
    const { fileURLToPath } = require('node:url')
    const { dirname, join } = require('node:path')
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'screen.js'), 'utf8')
    const ladder = src.slice(src.indexOf('function bandOf'))
    const emitted = [...ladder.matchAll(/return '([a-z]+)'/g)].map((m) => m[1])
    expect(emitted.length, 'the bandOf ladder was not found').toBe(6)
    expect([...new Set(emitted)].sort()).toEqual([...BAND_SEQUENCE].sort())
    // and the ladder really is in a different order from the move, so nobody
    // "fixes" one to match the other
    expect([...emitted].reverse()).not.toEqual(BAND_SEQUENCE)
  })

  it('gives an unknown band no step and sorts it last, never first', () => {
    expect(bandStep('starting')).toBe(3)
    expect(bandStep('nope')).toBeNull()          // NOT -1, which would read as before 'cold'
    expect(bandStep(undefined)).toBeNull()
    expect(bandOrder('starting')).toBe(0)
    expect(bandOrder('nope')).toBe(BAND_PRIORITY.length)
  })

  it('puts starting first for the reader and fourth in the move', () => {
    expect(BAND_PRIORITY[0]).toBe('starting')
    expect(BAND_SEQUENCE.indexOf('starting')).toBe(3)
    expect(ACTIONABLE_BANDS).toEqual(['starting', 'warming', 'underway'])
  })
})

/* ══ the distribution ══════════════════════════════════════════════════════ */

describe('bandDistribution counts the board without inventing a denominator', () => {
  it('counts every band and reports shares that sum to 100', () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => row({ id: `i${i}`, band: 'starting' })),
      ...Array.from({ length: 6 }, (_, i) => row({ id: `b${i}`, band: 'quiet' })),
      ...Array.from({ length: 10 }, (_, i) => row({ id: `d${i}`, band: 'cold' })),
    ]
    const d = bandDistribution(rows)
    expect(d.total).toBe(20)
    expect(d.bands.map((b) => b.band)).toEqual(BAND_PRIORITY)
    expect(d.bands.find((b) => b.band === 'starting').n).toBe(4)
    expect(d.bands.find((b) => b.band === 'starting').pct).toBeCloseTo(20)
    expect(d.actionable).toBe(4)
    expect(Math.round(d.bands.reduce((s, b) => s + (b.pct ?? 0), 0))).toBe(100)
  })

  it('returns null shares on an empty board rather than a board that is 0% everything', () => {
    // A 0%-wide segment drawn off no rows is a measurement nobody took — the
    // same failure as scoring an unmeasured season part at its midpoint.
    const d = bandDistribution([])
    expect(d.total).toBe(0)
    expect(d.bands).toHaveLength(6)
    for (const b of d.bands) {
      expect(b.n).toBe(0)
      expect(b.pct, `${b.band} claimed a share of an empty board`).toBeNull()
    }
  })

  it('does not silently absorb a row whose band is not one of the six', () => {
    const d = bandDistribution([row({ band: 'quiet' }), row({ id: 'y', band: 'sideways' })])
    expect(d.total).toBe(1)
    expect(d.unbanded).toBe(1)
  })

  it('survives null, a non-array, and rows that are not objects', () => {
    for (const input of [null, undefined, 'nope', [null, 7, undefined]]) {
      expect(() => bandDistribution(input)).not.toThrow()
      expect(bandDistribution(input).total).toBe(0)
    }
  })
})

/* ══ the snapshot ══════════════════════════════════════════════════════════ */

describe('boardSnapshot stores what the diff needs and nothing else', () => {
  it('keeps five fields per row and drops the payload', () => {
    const s = board([row({ id: 'sol', symbol: 'SOL', score: 71, band: 'starting', sparkline7d: new Array(168).fill(1), parts: [{ key: 'rs7' }], facts: ['a'], flags: { freshBreak: true } })])
    expect(Object.keys(s.rows[0]).sort()).toEqual(['band', 'brk', 'id', 'place', 'score', 'symbol'])
    expect(s.rows[0]).toMatchObject({ id: 'sol', symbol: 'SOL', score: 71, band: 'starting', place: 1, brk: true })
    expect(JSON.stringify(s).length, 'a snapshot must not carry the sparkline').toBeLessThan(400)
  })

  it('numbers places from the order it was given, and skips unscored rows', () => {
    const s = board([row({ id: 'a', score: 90 }), row({ id: 'b', score: null }), row({ id: 'c', score: 40 })])
    expect(s.rows.map((r) => [r.id, r.place])).toEqual([['a', 1], ['c', 2]])
    expect(s.n).toBe(2)
  })

  it('carries the scan asOf and never a receive time it was not given', () => {
    expect(board([row()], NOW).asOf).toBe(NOW)
    expect(boardSnapshot([row()], {}).asOf).toBeNull()
  })
})

/* ══ the diff: the refusals first ══════════════════════════════════════════ */

describe('boardDelta refuses in words rather than reporting a quiet market', () => {
  const curr = board([row({ id: 'a', score: 80 })])

  const cases = [
    ['no baseline at all', null, /no earlier board stored/i],
    ['an empty baseline', { v: 1, asOf: NOW - DAY, n: 0, rows: [] }, /no earlier board stored/i],
    ['a baseline with no timestamp', { v: 1, asOf: null, n: 1, rows: [{ id: 'a', symbol: 'A', score: 60, band: 'quiet', place: 1, brk: false }] }, /no scan timestamp/i],
    ['the same pass twice', board([row({ id: 'a', score: 80 })], NOW), /same pass/i],
    ['a baseline newer than the board', board([row({ id: 'a', score: 60 })], NOW + DAY), /NEWER than the scan/i],
  ]

  for (const [name, prev, re] of cases) {
    it(`refuses on ${name}, and says why`, () => {
      const d = boardDelta(prev, curr)
      expect(d.ok, `${name} produced a diff`).toBe(false)
      expect(d.reason).toMatch(re)
      expect(d.events).toEqual([])
      // The distinguishing property: a refusal is not a measured zero.
      expect(d.compared).toBe(0)
    })
  }

  it('refuses when the board on screen is empty, even with a good baseline', () => {
    const d = boardDelta(board([row({ id: 'a' })], NOW - DAY), board([], NOW))
    expect(d.ok).toBe(false)
    expect(d.reason).toMatch(/no ranked rows/i)
  })

  it('reports a genuinely quiet market as ok with zero events — the opposite claim', () => {
    const before = board([row({ id: 'a', score: 80 }), row({ id: 'b', score: 60 })], NOW - 2 * 3600_000)
    const after = board([row({ id: 'a', score: 80 }), row({ id: 'b', score: 60 })], NOW)
    const d = boardDelta(before, after)
    expect(d.ok).toBe(true)
    expect(d.reason).toBeNull()
    expect(d.events).toEqual([])
    expect(d.compared).toBe(2)
    expect(d.spanMs).toBe(2 * 3600_000)
  })
})

/* ══ the diff: the events ══════════════════════════════════════════════════ */

describe('boardDelta reports the events an operator opens the tab for', () => {
  const at = (t) => NOW - t * 3600_000

  it('calls out an ignition by name and puts it at the top of the list', () => {
    const before = board([
      row({ id: 'sol', symbol: 'SOL', score: 40, band: 'quiet' }),
      row({ id: 'pepe', symbol: 'PEPE', score: 35, band: 'cold' }),
    ], at(4))
    const after = board([
      row({ id: 'pepe', symbol: 'PEPE', score: 55, band: 'warming' }),
      row({ id: 'sol', symbol: 'SOL', score: 72, band: 'starting', flags: { freshBreak: true } }),
    ], at(0))

    const d = boardDelta(before, after)
    expect(d.ok).toBe(true)
    expect(d.events[0]).toMatchObject({ kind: 'ignite', symbol: 'SOL', tone: 'go' })
    expect(d.events[0].text).toBe('quiet → starting (+32 to 72)')
    expect(d.events[1]).toMatchObject({ kind: 'advance', symbol: 'PEPE' })
    expect(d.counts.ignite).toBe(1)
    expect(d.counts.advance).toBe(1)
  })

  it('gives one coin exactly one line, at its most important event', () => {
    // SOL ignited AND broke AND entered the top rows AND gained 32 points. Four
    // true statements, one of which is the reason to look.
    const before = board([
      ...Array.from({ length: 20 }, (_, i) => row({ id: `f${i}`, symbol: `F${i}`, score: 90 - i })),
      row({ id: 'sol', symbol: 'SOL', score: 40, band: 'quiet' }),
    ], at(6))
    const after = board([
      row({ id: 'sol', symbol: 'SOL', score: 95, band: 'starting', flags: { freshBreak: true } }),
      ...Array.from({ length: 20 }, (_, i) => row({ id: `f${i}`, symbol: `F${i}`, score: 90 - i })),
    ], at(0))

    const d = boardDelta(before, after)
    const sol = d.events.filter((e) => e.symbol === 'SOL')
    expect(sol, `SOL got ${sol.length} lines: ${sol.map((e) => e.kind)}`).toHaveLength(1)
    expect(sol[0].kind).toBe('ignite')
    // …and the raw buckets still hold every one of them, for anything that wants
    // to count rather than read.
    expect(d.advanced).toHaveLength(1)
    expect(d.broke).toHaveLength(1)
    expect(d.entered).toHaveLength(1)
    expect(d.climbed).toHaveLength(1)
  })

  it('reports a break only the pass it appears, not every pass it persists', () => {
    const withBreak = (id) => row({ id, symbol: id.toUpperCase(), score: 60, band: 'warming', flags: { freshBreak: true } })
    const first = boardDelta(board([row({ id: 'a', symbol: 'A', score: 60, band: 'warming' })], at(4)), board([withBreak('a')], at(2)))
    expect(first.events.map((e) => e.kind)).toEqual(['break'])
    const second = boardDelta(board([withBreak('a')], at(2)), board([withBreak('a')], at(0)))
    expect(second.ok).toBe(true)
    expect(second.events, 'the same break was reported twice').toEqual([])
  })

  it('separates a coin that fell down the board from one that left the scan', () => {
    const before = board([
      row({ id: 'a', symbol: 'A', score: 90 }), row({ id: 'gone', symbol: 'GONE', score: 80 }),
    ], at(3))
    const after = board([row({ id: 'a', symbol: 'A', score: 90 })], at(0))
    const d = boardDelta(before, after, { topN: 5 })
    const ev = d.events.find((e) => e.symbol === 'GONE')
    expect(ev.kind).toBe('exit')
    expect(ev.place, 'a coin that is absent has no rank to quote').toBeNull()
    expect(ev.text).toBe('gone from the scan — was #2')
  })

  it('names the real topN in the copy instead of a number typed into the text', () => {
    const before = board([
      ...Array.from({ length: 6 }, (_, i) => row({ id: `f${i}`, symbol: `F${i}`, score: 90 - i })),
      row({ id: 'z', symbol: 'Z', score: 10 }),
    ], at(3))
    const after = board([
      row({ id: 'z', symbol: 'Z', score: 95 }),
      ...Array.from({ length: 6 }, (_, i) => row({ id: `f${i}`, symbol: `F${i}`, score: 90 - i })),
    ], at(0))
    expect(boardDelta(before, after, { topN: 3 }).events.find((e) => e.symbol === 'Z').text)
      .toMatch(/into the top 3 at #1, from #7/)
    expect(boardDelta(before, after, { topN: 5 }).events.find((e) => e.symbol === 'Z').text)
      .toMatch(/into the top 5 /)
  })

  it('does not call a row we never stored an arrival unless it reaches the head', () => {
    const before = board([row({ id: 'a', symbol: 'A', score: 90 })], at(3))
    const after = board([
      row({ id: 'a', symbol: 'A', score: 90 }),
      ...Array.from({ length: 30 }, (_, i) => row({ id: `n${i}`, symbol: `N${i}`, score: 80 - i })),
    ], at(0))
    const d = boardDelta(before, after, { topN: 5 })
    // 30 unseen rows; only the four inside the top 5 are news.
    expect(d.entered).toHaveLength(4)
    expect(d.entered.every((e) => e.place <= 5)).toBe(true)
  })

  it('splits a score move by direction and tones it accordingly', () => {
    const before = board([row({ id: 'up', symbol: 'UP', score: 40 }), row({ id: 'dn', symbol: 'DN', score: 70 })], at(3))
    const after = board([row({ id: 'dn', symbol: 'DN', score: 55 }), row({ id: 'up', symbol: 'UP', score: 58 })], at(0))
    const d = boardDelta(before, after, { minScoreMove: 10, topN: 0 })
    expect(d.climbed.map((e) => e.symbol)).toEqual(['UP'])
    expect(d.slid.map((e) => e.symbol)).toEqual(['DN'])
    expect(d.events.find((e) => e.symbol === 'UP').tone).toBe('go')
    expect(d.events.find((e) => e.symbol === 'DN').tone).toBe('warn')
    expect(d.events.find((e) => e.symbol === 'DN').text).toMatch(/score -15 to 55/)
  })

  it('ignores a score move under the threshold — a screen that reshuffles is not news', () => {
    const before = board([row({ id: 'a', symbol: 'A', score: 60 })], at(3))
    const after = board([row({ id: 'a', symbol: 'A', score: 68 })], at(0))
    expect(boardDelta(before, after, { minScoreMove: 10, topN: 0 }).events).toEqual([])
  })

  it('caps the list and says how many it dropped', () => {
    const mk = (t, band) => board(Array.from({ length: 30 }, (_, i) => row({ id: `c${i}`, symbol: `C${i}`, score: 50, band })), t)
    const d = boardDelta(mk(at(3), 'quiet'), mk(at(0), 'underway'), { maxEvents: 5, topN: 0 })
    expect(d.events).toHaveLength(5)
    expect(d.truncated).toBe(25)
    expect(d.advanced).toHaveLength(30)
  })

  it('runs end to end on screenUniverse output, not just on hand-built rows', () => {
    // The shape boardSnapshot actually receives in the app. A field renamed in
    // screen.js has to fail here rather than on the tab.
    const btc = { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', rank: 1, mcap: 1.9e12, price: 96000, vol24h: 4e10, chg24h: 0.4, chg7d: 3, chg30d: 7 }
    const spark = (base, gain) => Array.from({ length: 168 }, (_, i) => base * (1 + (gain * i) / 167))
    const coin = (over) => ({ id: 'sol', symbol: 'SOL', name: 'Solana', rank: 5, mcap: 8e10, price: 180, vol24h: 5e9, chg24h: 1, chg7d: 4, chg30d: 9, sparkline7d: spark(160, 0.1), ...over })

    const cold = screenUniverse([btc, coin({})], { btcRow: btc, now: NOW })
    const hot = screenUniverse([btc, coin({ chg24h: 9, chg7d: 22, sparkline7d: spark(160, 0.22) })], { btcRow: btc, now: NOW })
    expect(cold.length).toBeGreaterThan(0)

    const d = boardDelta(boardSnapshot(cold, { asOf: at(4) }), boardSnapshot(hot, { asOf: at(0) }))
    expect(d.ok).toBe(true)
    expect(d.compared).toBe(cold.length)
    for (const e of d.events) {
      expect(e.text).not.toMatch(/undefined|NaN|null/)
      expect(e.symbol).toBeTruthy()
    }
  })
})

/* ══ the stored history ════════════════════════════════════════════════════ */

const dstr = (i) => new Date(NOW - i * DAY).toISOString().slice(0, 10)
/** `n` daily rows ending today, BTC dominance walking from `from` to `to`. */
const hist = (n, from, to, over = {}) => Array.from({ length: n }, (_, i) => ({
  d: dstr(n - 1 - i),
  btcDom: n === 1 ? to : from + ((to - from) * i) / (n - 1),
  ethDom: 12, totalMcap: 3e12, ...over,
}))

describe('altShareSeries reads the stored history and refuses when it is thin', () => {
  it('says how many of the seven days it has, in season.js’s own words', () => {
    const s = altShareSeries(hist(3, 56, 55), { now: NOW })
    expect(s.ok).toBe(false)
    expect(s.reason).toMatch(/3 of 7 stored days needed/)
    expect(s.trend).toBe('unknown')
    expect(s.changePctPts).toBeNull()
    // …and it still hands back what it HAS, so the card can say "3 readings"
    // rather than pretending the cron has never run.
    expect(s.points).toHaveLength(3)
    expect(s.samples).toBe(3)
  })

  it('names day one as day one', () => {
    const s = altShareSeries(null, { now: NOW })
    expect(s.ok).toBe(false)
    expect(s.reason).toMatch(/no dominance history stored yet — 0 of 7 days needed/)
    expect(s.points).toEqual([])
  })

  it('computes alt share as 100 minus dominance, and ex-BTC-and-ETH beside it', () => {
    const s = altShareSeries(hist(10, 56, 52), { now: NOW })
    expect(s.ok).toBe(true)
    expect(s.points[0].altShare).toBeCloseTo(44)
    expect(s.points[0].exBigTwo).toBeCloseTo(32)
    expect(s.last).toBeCloseTo(48)
    expect(s.changePctPts).toBeCloseTo(4)
    expect(s.trend).toBe('rising')
    expect(s.spanDays).toBe(9)
    expect(s.samples).toBe(10)
  })

  it('mirrors season.js exactly: dominance falling ⇔ alt share rising, same threshold', () => {
    // Two files, one series, and they render side by side. A different flat band
    // in either would put "dominance flat" next to "alt share rising".
    const universe = [
      { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', rank: 1, mcap: 1.9e12, chg7d: 3, chg30d: 7 },
      ...Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, symbol: `C${i}`, name: `C${i}`, rank: i + 2, mcap: 5e8, chg7d: 4, chg30d: 8 })),
    ]
    for (const [from, to, domTrend, altTrend] of [
      [56, 52, 'falling', 'rising'],
      [52, 56, 'rising', 'falling'],
      [56, 55.7, 'flat', 'flat'],
    ]) {
      const domHistory = hist(10, from, to)
      const season = seasonRead({ universe, btcRow: universe[0], global: { btcDominancePct: to }, domHistory, now: NOW })
      const alt = altShareSeries(domHistory, { now: NOW })
      expect(season.dominance.trend, `dominance ${from}→${to}`).toBe(domTrend)
      expect(alt.trend, `alt share ${from}→${to}`).toBe(altTrend)
    }
  })

  it('bounds the window by dates, not by a count of readings', () => {
    // Nine readings spread over 40 days: only the ones inside 30 count, and the
    // span reported is calendar days, not the reading count. `slice(-30)` would
    // have called this a 30-day move measured over 40.
    const spread = Array.from({ length: 9 }, (_, i) => ({
      d: dstr(40 - i * 5), btcDom: 56 - i * 0.5, ethDom: 12, totalMcap: 3e12,
    }))
    const s = altShareSeries(spread, { now: NOW })
    expect(s.days).toBe(9)
    expect(s.samples).toBeLessThan(9)
    expect(s.spanDays).toBeLessThanOrEqual(30)
  })

  it('leaves alt market cap null on a row with no total, instead of zeroing it', () => {
    const rows = hist(8, 56, 54)
    delete rows[3].totalMcap
    const s = altShareSeries(rows, { now: NOW })
    expect(s.points[3].altMcap, 'a missing total became a market that vanished').toBeNull()
    expect(s.points[2].altMcap).toBeGreaterThan(0)
    expect(s.altMcapChangePct).not.toBeNull()
  })

  it('drops half-written rows the way alts.mjs does and never counts them as days', () => {
    const rows = [...hist(8, 56, 54), { d: '2026-07-30', btcDom: null }, { btcDom: 55 }, null]
    const s = altShareSeries(rows, { now: NOW })
    expect(s.days).toBe(8)
    expect(s.ok).toBe(true)
  })

  it('reports how stale the newest sample is, so a dead cron is visible', () => {
    const stale = Array.from({ length: 8 }, (_, i) => ({ d: dstr(12 - i), btcDom: 56 - i * 0.2, ethDom: 12, totalMcap: 3e12 }))
    expect(altShareSeries(stale, { now: NOW }).latestAgeDays).toBe(5)
    expect(altShareSeries(hist(8, 56, 54), { now: NOW }).latestAgeDays).toBe(0)
    // No clock passed means no claim about staleness, not a claim of zero.
    expect(altShareSeries(hist(8, 56, 54), {}).latestAgeDays).toBeNull()
  })
})

/* ══ leaders ═══════════════════════════════════════════════════════════════ */

describe('bandLeaders keeps an empty band visible', () => {
  it('returns every requested band, including the ones with nothing in them', () => {
    const rows = [row({ id: 'a', band: 'starting', score: 80 }), row({ id: 'b', band: 'starting', score: 70 })]
    const out = bandLeaders(rows, { perBand: 3 })
    expect(out.map((g) => g.band)).toEqual(ACTIONABLE_BANDS)
    expect(out[0].rows).toHaveLength(2)
    expect(out[1], 'a band with nothing in it must still be reported').toMatchObject({ band: 'warming', n: 0 })
    expect(out[1].rows).toEqual([])
    expect(out[0].meaning).toBe(BAND_MEANING.starting)
  })

  it('takes the first N in the order it was given, and does not re-rank', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({ id: `i${i}`, symbol: `I${i}`, band: 'starting', score: 90 - i }))
    const out = bandLeaders(rows, { bands: ['starting'], perBand: 2 })
    expect(out[0].rows.map((r) => r.symbol)).toEqual(['I0', 'I1'])
    expect(out[0].n).toBe(6)
  })
})

/* ══ the age label ═════════════════════════════════════════════════════════ */

describe('spanLabel says nothing rather than zero about an unknown gap', () => {
  it('formats in the coarsest honest unit', () => {
    expect(spanLabel(30_000)).toBe('under a minute')
    expect(spanLabel(9 * 60_000)).toBe('9m')
    expect(spanLabel(2 * 3600_000)).toBe('2h')
    expect(spanLabel(2 * 3600_000 + 10 * 60_000)).toBe('2h 10m')
    expect(spanLabel(26 * 3600_000)).toBe('1d 2h')
    expect(spanLabel(48 * 3600_000)).toBe('2d')
  })

  it('returns null for a gap it cannot measure', () => {
    for (const bad of [null, undefined, NaN, -1, Infinity, 'soon']) expect(spanLabel(bad)).toBeNull()
  })
})
