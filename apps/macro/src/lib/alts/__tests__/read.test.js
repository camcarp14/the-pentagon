// read.js is the headline of the Alts tab, which makes it the single most
// dangerous file in the alts libs: it is the one place a number appears that
// nobody cross-checks, because it IS the cross-check. This repo has already
// caught a score inventing 20 points out of a midpoint and flipping a call, so
// the cases below are weighted the same way pulse.test.js is — towards the
// REFUSALS and towards the two structural guarantees:
//
//   1. THE HEADLINE CANNOT CONTRADICT THE BOARD. The igniting count on the card
//      and the igniting segment on the distribution strip are one computation,
//      not two that agree. There is a search below that proves 8 of 10 is
//      unreachable over an empty igniting band, for every combination of the
//      three components — a theorem about the weights, not a spot check.
//   2. A MISSING INPUT DEGRADES TO A STATED REASON. Three refusals, three
//      different sentences, and two of them still answer the rows they measured.
import { describe, it, expect } from 'vitest'
import { altsRead } from '../read.js'
import { screenUniverse } from '../screen.js'
import { seasonRead } from '../season.js'
import { boardSnapshot, boardDelta, bandDistribution } from '../pulse.js'

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const DAY = 86_400_000
const LIVE = 'live'   // the STATE STRING, which is all read.js is given — see its docblock

/* ── fixtures: a real universe, screened by the real screener ─────────────────
 *
 * Nothing here hand-builds a screened row or a season object. Every input this
 * file is tested against comes out of screen.js, season.js and pulse.js exactly
 * as the panel gets it, because the whole claim of read.js is that it only
 * weighs what those three produced. A fixture that fabricated a `band` would
 * test the weighting and skip the guarantee. */

const spark = (base, gain) =>
  Array.from({ length: 168 }, (_, i) => base * (1 + (gain * i) / 167 + Math.sin(i / 9) * 0.004))

const row = (over = {}) => ({
  id: 'x', symbol: 'X', name: 'Coin X', rank: 1,
  price: 1, mcap: 1e9, vol24h: 1e8,
  chg1h: 0.2, chg24h: 1.5, chg7d: 4, chg30d: 9,
  ath: 3, athChangePct: -55, athDate: '2024-03-14T00:00:00.000Z',
  sparkline7d: spark(1, 0.04),
  ...over,
})

const BTC = row({ id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', rank: 1, price: 96_400, mcap: 1.9e12, vol24h: 4.2e10, chg24h: 0.8, chg7d: 2.1, chg30d: 5.4, sparkline7d: spark(96_000, 0.02) })
const ETH = row({ id: 'ethereum', symbol: 'ETH', name: 'Ethereum', rank: 2, price: 3_420, mcap: 4.1e11, vol24h: 1.8e10, chg24h: 1.9, chg7d: 6.4, chg30d: 11.2, sparkline7d: spark(3_300, 0.06) })
const SOL = row({ id: 'solana', symbol: 'SOL', name: 'Solana', rank: 5, price: 184, mcap: 8.7e10, vol24h: 5.1e9, chg24h: 6.2, chg7d: 14.8, chg30d: 22.5, sparkline7d: spark(160, 0.15) })
const PEPE = row({ id: 'pepe', symbol: 'PEPE', name: 'Pepe', rank: 31, price: 1.22e-5, mcap: 5.1e9, vol24h: 9.4e8, chg24h: 11.4, chg7d: 26.1, chg30d: 41.9, sparkline7d: spark(9.8e-6, 0.24) })
const MICRO = row({ id: 'micro', symbol: 'MICRO', name: 'Micro Thing', rank: 240, price: 0.041, mcap: 6.2e7, vol24h: 90_000, chg24h: -2.1, chg7d: -8.4, chg30d: -19.2, sparkline7d: spark(0.05, -0.08) })

const UNIVERSE = [BTC, ETH, SOL, PEPE, MICRO]

/** A dominance history long enough that the trend resolves — the difference
 *  between the day-one read and a settled one, which is a whole test below. */
const domHistory = (n = 12, step = -0.3) => Array.from({ length: n }, (_, i) => ({
  d: new Date(NOW - (n - 1 - i) * DAY).toISOString().slice(0, 10),
  btcDom: 56 + i * step, ethDom: 12, totalMcap: 3.4e12,
}))

/**
 * A season read that lands UNDER HALF coverage, which is the state season.js
 * refuses to publish a number for. Day one of the cron is 60 of 100 points and
 * still publishes; the way under the floor is to lose a breadth window, so BTC
 * carries no 30-day return here and the 30d count has no bar to measure against.
 */
function thinSeason() {
  const noMonth = UNIVERSE.map((r) => ({ ...r, chg30d: null }))
  return seasonRead({
    universe: noMonth, btcRow: noMonth[0], ethRow: null,
    global: null, fearGreed: null, domHistory: null, now: NOW,
  })
}

function marketOf(universe = UNIVERSE, over = {}) {
  const season = seasonRead({
    universe, btcRow: universe[0], ethRow: universe[1],
    global: { btcDominancePct: 54.2, ethDominancePct: 11.8, totalMcapUsd: 3.4e12 },
    fearGreed: { value: 62, label: 'Greed' },
    domHistory: null, now: NOW, ...over,
  })
  const rows = screenUniverse(universe, { btcRow: universe[0], ethRow: universe[1], season, now: NOW })
  return { season, rows }
}

const read = (over = {}) => {
  const { season, rows } = over.market ?? marketOf()
  return altsRead({ season, rows, delta: null, scanState: LIVE, live: true, ...over })
}

const rowByKey = (r, key) => r.rows.find((x) => x.key === key)
const textOf = (r) => [r.label, r.plain, ...r.rows.flatMap((x) => [x.v, x.note]), ...r.risks.map((x) => x.text), ...r.facts].join(' | ')

/* ══ 1. the guarantee: the headline is the board ════════════════════════════ */

describe('the headline and the board are one computation', () => {
  it('counts igniting rows out of the same object the distribution strip is drawn from', () => {
    const { season, rows } = marketOf()
    const r = altsRead({ season, rows, scanState: LIVE, live: true })
    const strip = bandDistribution(rows)

    // three routes to the same number: the card, the strip, and the rows the
    // board's own band filter would show
    expect(r.ignition.n).toBe(strip.bands.find((b) => b.band === 'igniting').n)
    expect(r.ignition.n).toBe(rows.filter((x) => x.band === 'igniting').length)
    expect(r.dist.total).toBe(strip.total)
    expect(r.dist.actionable).toBe(strip.actionable)
  })

  it('names only coins that are on the board, in the board’s own order', () => {
    const { season, rows } = marketOf()
    const r = altsRead({ season, rows, scanState: LIVE, live: true })
    const onBoard = rows.filter((x) => x.band === 'igniting')
    expect(r.ignition.top.length).toBeGreaterThan(0)
    expect(r.ignition.top.map((x) => x.symbol)).toEqual(onBoard.slice(0, 3).map((x) => x.symbol))
    // descending by score, because screenUniverse already sorted it that way and
    // this file does not re-sort — a second sort is a second opinion about which
    // coin is best.
    const scores = r.ignition.top.map((x) => x.score)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
    // and the row prints those symbols and no others
    const note = rowByKey(r, 'starting').note
    for (const s of r.ignition.top) expect(note).toContain(`${s.symbol} ${s.score}`)
  })

  it('CANNOT say yes over a board with nothing igniting — by search, not by spot check', () => {
    // THE THEOREM. The regime is worth 6 and the drift tilt 1, so the ceiling
    // with an empty igniting band is 7 and the `go` rung starts at 8. This walks
    // the whole reachable component space rather than asserting one case,
    // because the failure this guards against is a future weight change that
    // makes the sentence in the header quietly untrue.
    let checked = 0
    for (let seasonScore = 0; seasonScore <= 100; seasonScore++) {
      for (const igniting of [0, 1, 2, 4, 5, 9]) {
        for (const drift of [-1, 0, 1]) {
          const r = altsRead({
            season: fakeSeason(seasonScore),
            rows: boardWith(igniting),
            delta: fakeDelta(drift),
            scanState: LIVE, live: true,
          })
          checked++
          if (r.band === 'go') {
            expect(r.ignition.n, `a "go" over ${r.ignition.n} igniting rows`).toBeGreaterThanOrEqual(1)
            // …and a go always rests on a rotating tape too: 8 − 3 − 1 = 4 of 6
            // regime points, which is 59 out of 100 at the least.
            expect(r.regime.score).toBeGreaterThanOrEqual(59)
          }
          if (r.score != null && r.score >= 8) expect(r.ignition.n).toBeGreaterThanOrEqual(1)
        }
      }
    }
    expect(checked).toBe(101 * 6 * 3)
  })

  it('moves the score monotonically with the board it is describing', () => {
    // More igniting rows can never lower the read, and a hotter regime can never
    // lower it either. A weight table that broke this would put the card and the
    // board in opposite directions on the same market.
    const at = (igniting, seasonScore) => altsRead({
      season: fakeSeason(seasonScore), rows: boardWith(igniting), scanState: LIVE, live: true,
    }).score
    for (const s of [10, 40, 60, 80, 100]) {
      const series = [0, 1, 2, 5, 9].map((n) => at(n, s))
      expect([...series].sort((a, b) => a - b), `score fell as coins ignited at season ${s}`).toEqual(series)
    }
    for (const n of [0, 2, 5]) {
      const series = [0, 25, 50, 75, 100].map((s) => at(n, s))
      expect([...series].sort((a, b) => a - b), `score fell as the regime warmed at ${n} igniting`).toEqual(series)
    }
  })
})

/* ══ 2. the arithmetic, checkable by eye ═══════════════════════════════════ */

describe('the ten points add up the way the header says', () => {
  it('scales the regime by six hundredths and nothing else', () => {
    for (const [score100, pts] of [[0, 0], [8, 0], [9, 1], [50, 3], [58, 3], [59, 4], [76, 5], [100, 6]]) {
      const r = altsRead({ season: fakeSeason(score100), rows: boardWith(0), scanState: LIVE, live: true })
      expect(r.regime.points, `${score100} of 100 should be ${pts} of 6`).toBe(pts)
      expect(r.facts.join(' ')).toContain(`round(6 × ${score100} ÷ 100)`)
    }
  })

  it('runs the igniting ladder first-threshold-wins, like every other ladder here', () => {
    for (const [n, pts] of [[0, 0], [1, 1], [2, 2], [4, 2], [5, 3], [40, 3]]) {
      const r = altsRead({ season: fakeSeason(50), rows: boardWith(n), scanState: LIVE, live: true })
      expect(r.ignition.points, `${n} igniting should be ${pts} of 3`).toBe(pts)
    }
  })

  it('sums parts[] to the score, always', () => {
    for (const s of [0, 33, 66, 100]) {
      for (const n of [0, 3, 8]) {
        for (const d of [-1, 0, 1, null]) {
          const r = altsRead({ season: fakeSeason(s), rows: boardWith(n), delta: d == null ? null : fakeDelta(d), scanState: LIVE, live: true })
          const sum = r.parts.reduce((a, p) => a + p.points, 0)
          expect(sum, `parts do not sum to the score at ${s}/${n}/${d}`).toBe(r.score)
          expect(r.score).toBeGreaterThanOrEqual(0)
          expect(r.score).toBeLessThanOrEqual(10)
        }
      }
    }
  })

  it('needs a margin of two events before the drift tilt fires', () => {
    const pts = (forward, backward) => altsRead({
      season: fakeSeason(50), rows: boardWith(1), scanState: LIVE, live: true,
      delta: fakeDeltaCounts({ ignite: forward, fade: backward }),
    }).drift.points
    expect(pts(1, 0)).toBe(0)     // one event of difference on a whole board is noise
    expect(pts(2, 0)).toBe(1)
    expect(pts(5, 4)).toBe(0)
    expect(pts(5, 3)).toBe(1)
    expect(pts(0, 1)).toBe(0)
    expect(pts(0, 2)).toBe(-1)
  })

  it('clamps a negative tilt to the points that exist, so the table still adds up', () => {
    // screen.js's rule for its parabolic penalty, and its reason: clamp the
    // PENALTY and the floor is a true zero with parts[] still summing to it;
    // clamp the SCORE instead and the column of numbers stops matching the total
    // beside it, which is the one thing this table cannot survive.
    const r = altsRead({
      season: fakeSeason(0), rows: boardWith(0), scanState: LIVE, live: true,
      delta: fakeDeltaCounts({ fade: 4 }),
    })
    expect(r.score).toBe(0)
    expect(r.parts.reduce((a, p) => a + p.points, 0)).toBe(0)
    expect(r.parts.find((p) => p.key === 'drift').points).toBe(0)
    expect(r.facts.join(' ')).toMatch(/clamped to the nothing this read has to give back/)
  })

  it('leaves rank churn out of the direction, because it is zero-sum', () => {
    // A coin entering the top 15 is a coin leaving it. Counting either as
    // direction would score a reshuffle as a market that is going somewhere.
    const r = altsRead({
      season: fakeSeason(50), rows: boardWith(1), scanState: LIVE, live: true,
      delta: fakeDeltaCounts({ enter: 9, exit: 0 }),
    })
    expect(r.drift.forward).toBe(0)
    expect(r.drift.backward).toBe(0)
    expect(r.drift.points).toBe(0)
  })

  it('omits the drift part entirely with no baseline, rather than scoring it zero', () => {
    const r = altsRead({ season: fakeSeason(100), rows: boardWith(9), delta: null, scanState: LIVE, live: true })
    expect(r.drift.scored).toBe(false)
    expect(r.parts.map((p) => p.key)).toEqual(['regime', 'starting'])
    // the cost is stated rather than hidden, and it is stated as a cost
    expect(r.score).toBe(9)
    expect(r.facts.join(' ')).toMatch(/top of the scale is 9 on this pass/)
  })
})

/* ══ 3. the refusals ═══════════════════════════════════════════════════════ */

describe('a missing input becomes a stated reason, never a default', () => {
  it('refuses a scan the freshness ladder already refused, and answers nothing off it', () => {
    const { season, rows } = marketOf()
    const r = altsRead({ season, rows: [], delta: null, scanState: 'dead', live: false })
    expect(r.score).toBeNull()
    expect(r.band).toBe('unknown')
    expect(r.label).toBe('No read')
    expect(r.plain).toMatch(/freshness ladder refused this scan/)
    expect(r.rows, 'a refused payload may not answer a single row').toEqual([])
    // and it names no coin from the board it was handed
    expect(textOf(r)).not.toMatch(/SOL|PEPE/)
    void season
  })

  it('says a live scan with no ranked rows differently from a dead one', () => {
    const r = altsRead({ season: marketOf().season, rows: [], scanState: LIVE, live: true })
    expect(r.plain).toMatch(/no ranked rows/)
    expect(r.plain).not.toMatch(/freshness ladder/)
    expect(r.rows).toEqual([])
  })

  it('publishes no number when season would not publish one — and still answers the rest', () => {
    // THE CASE THIS FILE WAS BUILT AROUND. Under half its points measured,
    // season.js returns `score: null` on purpose. The regime is 6 of the 10
    // here, so a number built out of the other 4 would be a stand-down verdict
    // nobody measured. But "what is starting" and "since you last looked" WERE
    // measured, and blanking them would be its own dishonesty.
    const thin = thinSeason()
    expect(thin.score, 'the fixture did not reach season.js’s refusal').toBeNull()

    const rows = screenUniverse(UNIVERSE, { btcRow: BTC, ethRow: ETH, season: thin, now: NOW })
    const r = altsRead({ season: thin, rows, scanState: LIVE, live: true })

    expect(r.score).toBeNull()
    expect(r.band).toBe('unknown')
    expect(r.label).toBe('No read')
    expect(r.plain).toMatch(/published no score/)
    expect(r.plain).toMatch(/under half/i)
    expect(r.plain, 'the refusal must state its own arithmetic').toMatch(/\d+ of its 100 points/)
    // our clause, then season.js's sentence — and ours does not restate the
    // arithmetic season is about to state
    expect(r.plain).toContain(thin.plain)
    expect(r.plain.match(/of its 100 points/g), 'the coverage arithmetic is printed twice').toHaveLength(1)

    // the measured half still speaks, with real numbers in it
    expect(rowByKey(r, 'look').v).toBe('No read')
    expect(rowByKey(r, 'starting').v).toMatch(/\d+ igniting|nothing igniting/)
    expect(rowByKey(r, 'since').v).toBe('no baseline')
    // `no_regime` leads the fragility list — but the row does not repeat what
    // the first row of the same card already said four lines above it.
    expect(r.risks[0].key).toBe('no_regime')
    expect(rowByKey(r, 'wrong').v).not.toBe('no regime score')
    expect(rowByKey(r, 'wrong').note).not.toBe(rowByKey(r, 'look').note)
    expect(r.risks.map((x) => x.short)).toContain(rowByKey(r, 'wrong').v)
  })

  it('says there is no regime read at all differently from a thin one', () => {
    const r = altsRead({ season: null, rows: marketOf().rows, scanState: LIVE, live: true })
    expect(r.score).toBeNull()
    expect(r.plain).toMatch(/No regime read was run/)
    expect(r.plain).not.toMatch(/under half/i)
    // and one that could not count breadth at all gets season.js's own sentence
    const noBreadth = seasonRead({ universe: [], btcRow: null, now: NOW })
    const b = altsRead({ season: noBreadth, rows: marketOf().rows, scanState: LIVE, live: true })
    expect(b.plain).toMatch(/No regime score at all/)
    expect(b.plain).toContain(noBreadth.plain)
  })

  it('keeps “nothing moved” and “nothing to compare against” apart in the row as well as the score', () => {
    const { season, rows } = marketOf()
    const snap = (t) => boardSnapshot(rows, { asOf: t })

    const measured = altsRead({ season, rows, delta: boardDelta(snap(NOW - 2 * 3600_000), snap(NOW)), scanState: LIVE, live: true })
    expect(rowByKey(measured, 'since').v).toBe('nothing moved')
    expect(rowByKey(measured, 'since').note).toMatch(/on both boards across 2h of tape/)
    expect(measured.drift.scored).toBe(true)

    const absent = altsRead({ season, rows, delta: boardDelta(null, snap(NOW)), scanState: LIVE, live: true })
    expect(rowByKey(absent, 'since').v).toBe('no baseline')
    // pulse.js's own sentence, not a paraphrase written here
    expect(rowByKey(absent, 'since').note).toBe(boardDelta(null, snap(NOW)).reason)
    expect(absent.drift.scored).toBe(false)
  })

  it('says the board is quiet with a count when nothing is igniting', () => {
    // A zero that was measured looks nothing like a zero that was assumed: this
    // one states the two neighbouring bands and the denominator.
    const cold = UNIVERSE.map((r) => (r.symbol === 'BTC' ? r : { ...r, chg24h: -3, chg7d: -9, sparkline7d: spark(1, -0.1) }))
    const { season, rows } = marketOf(cold)
    const r = altsRead({ season, rows, scanState: LIVE, live: true })
    expect(r.ignition.n).toBe(0)
    expect(rowByKey(r, 'starting').v).toBe('nothing igniting')
    expect(rowByKey(r, 'starting').note).toMatch(/\d+ waking and \d+ running out of \d+ ranked/)
    expect(rowByKey(r, 'starting').note).toMatch(/prior 6-day high/)
  })
})

/* ══ 4. the band is only named where it cannot move ════════════════════════ */

describe('the call is named only where the unread points cannot move it', () => {
  it('names nothing when the unread regime points straddle a rung', () => {
    // 40 unread points is a ±2.4-point band on this scale, which cannot fit
    // inside the two-wide `armed` rung. season.js's own bounds, carried through
    // the same × 6 ÷ 100 as the score.
    const r = altsRead({ season: fakeSeason(60, { of: 60, low: 36, high: 76 }), rows: boardWith(2), scanState: LIVE, live: true })
    expect(r.score).toBe(6)
    expect(r.pinned).toBe(false)
    expect(r.band).toBe('unknown')
    expect(r.label).toMatch(/ to /)
    expect(r.plain).toMatch(/anywhere from \d+ to \d+/)
    expect(r.plain).toMatch(/no call is named off it/)
    expect(r.bounds.low).toBeLessThan(r.bounds.high)
  })

  it('names the call when both ends of the band land in one rung', () => {
    const r = altsRead({ season: fakeSeason(76, { of: 80, low: 61, high: 81 }), rows: boardWith(2), scanState: LIVE, live: true })
    expect(r.pinned).toBe(true)
    expect(r.band).toBe('armed')
    expect(r.label).toBe('Selectively')
    expect(r.facts.join(' ')).toMatch(/the same call at both ends/)
  })

  it('keeps the published score inside its own bounds, always', () => {
    for (let earned = 0; earned <= 100; earned += 5) {
      for (const of of [50, 60, 75, 80, 95, 100]) {
        if (earned > of) continue
        const score = Math.round((100 * earned) / of)
        const r = altsRead({
          season: fakeSeason(score, { of, low: earned, high: earned + (100 - of) }),
          rows: boardWith(2), delta: fakeDelta(0), scanState: LIVE, live: true,
        })
        expect(r.bounds.low).toBeLessThanOrEqual(r.score)
        expect(r.score).toBeLessThanOrEqual(r.bounds.high)
      }
    }
  })

  it('prints season’s own label in the row, refusal wording and all', () => {
    // season.js may decline to name a regime while this file still names a call
    // — different ladders, different boundaries. What the card must never do is
    // launder season's refusal into a regime name of its own.
    const { season, rows } = marketOf()
    expect(season.phase, 'the fixture did not reach season.js’s span refusal').toBe('unknown')
    const r = altsRead({ season, rows, scanState: LIVE, live: true })
    expect(rowByKey(r, 'look').note).toContain(season.label)
    expect(rowByKey(r, 'look').note).toMatch(/76 of 100, measured on 80 of those 100 points/)
  })
})

/* ══ 5. what would make me wrong ═══════════════════════════════════════════ */

describe('the fragilities are computed, not a standing disclaimer', () => {
  it('reports nothing thin when every input was measured', () => {
    const { season, rows } = marketOf(UNIVERSE, { domHistory: domHistory(12), fearGreed: { value: 62, label: 'Greed' } })
    expect(season.measured.of, 'the fixture left a gauge unread').toBe(100)
    const snap = (t) => boardSnapshot(rows, { asOf: t })
    const r = altsRead({
      season, rows, delta: boardDelta(snap(NOW - 2 * 3600_000), snap(NOW)), scanState: LIVE, live: true,
    })
    // the fixture's board is 5 rows, which is a real fragility and is reported;
    // everything that would have been boilerplate is absent.
    expect(r.risks.map((x) => x.key)).toEqual(['small_board'])
    const bigBoard = altsRead({
      season, rows: [...rows, ...boardWith(40)], delta: boardDelta(snap(NOW - 2 * 3600_000), snap(NOW)), scanState: LIVE, live: true,
    })
    expect(bigBoard.risks).toEqual([])
    expect(rowByKey(bigBoard, 'wrong').v).toBe('nothing thin')
    expect(rowByKey(bigBoard, 'wrong').note).toMatch(/all 100 regime points/)
  })

  it('names the unread regime points and the span they imply', () => {
    const r = read()
    const thin = r.risks.find((x) => x.key === 'regime_thin')
    expect(thin).toBeTruthy()
    expect(thin.short).toMatch(/^\d+ regime points unread$/)
    // season.js's own part labels, with their own arithmetic in them
    expect(thin.text).toMatch(/dominance trend unknown \(0 of 7 stored days needed\)/)
  })

  it('does not print the dominance day count twice', () => {
    // It is already inside the unread-points line above. A list of real
    // fragilities that repeats itself reads like boilerplate, which is how a
    // reader learns to skip the one line that mattered.
    const r = read()
    expect(r.risks.filter((x) => x.key === 'dominance_filling')).toEqual([])
    // …and it DOES fire where that line cannot: a read with no regime score has
    // no unread-points line to carry the day count.
    const r2 = altsRead({ season: thinSeason(), rows: marketOf().rows, scanState: LIVE, live: true })
    expect(r2.risks.map((x) => x.key)).toContain('dominance_filling')
    expect(r2.risks.find((x) => x.key === 'dominance_filling').text).toMatch(/0 of the 7 stored days/)
  })

  it('says an igniting count is not a shortlist when the rows are untradeable', () => {
    const thinCoin = row({
      id: 'thin', symbol: 'THIN', name: 'Thin Thing', rank: 180, price: 0.5, mcap: 2e8,
      vol24h: 120_000, chg24h: 9, chg7d: 12, chg30d: 15, sparkline7d: spark(0.4, 0.22),
    })
    const { season, rows } = marketOf([...UNIVERSE, thinCoin])
    const r = altsRead({ season, rows, scanState: LIVE, live: true })
    if (r.ignition.thin > 0) {
      const risk = r.risks.find((x) => x.key === 'thin_starts')
      expect(risk).toBeTruthy()
      expect(risk.text).toMatch(/is not \d+ names you can size/)
    } else {
      // the screener banded it somewhere else — then the claim must not be made
      expect(r.risks.find((x) => x.key === 'thin_starts')).toBeUndefined()
    }
  })

  it('shows the fragility that could move the read furthest, not the one that is always there', () => {
    // `no_baseline` is true on every first visit on every device, so leading
    // with it meant the "Wrong if" row said the same weakest thing forever while
    // a stale scan sat behind it unmentioned. A stale scan invalidates every
    // number at once and outranks it.
    const { season, rows } = marketOf(UNIVERSE, { domHistory: domHistory(12) })
    const r = altsRead({ season, rows, delta: null, scanState: 'stale', live: true })
    expect(r.risks[0].key).toBe('stale_scan')
    expect(r.risks.map((x) => x.key)).toContain('no_baseline')
    expect(rowByKey(r, 'wrong').v).toBe('scan is stale')
  })

  it('does not print the same refusal paragraph three times', () => {
    // The headline, the first row's note and the last row's note are three
    // places, and a refused read filled all three with one 60-word sentence.
    const r = altsRead({ season: thinSeason(), rows: marketOf().rows, scanState: LIVE, live: true })
    const note = rowByKey(r, 'look').note
    const risk = rowByKey(r, 'wrong').note
    expect(r.plain.length, 'the headline is the long form').toBeGreaterThan(120)
    expect(note.length, 'the row note is the short form').toBeLessThan(90)
    expect(note).not.toBe(r.plain)
    expect(risk).not.toBe(r.plain)
    expect(risk, 'and the two rows do not say the same thing either').not.toBe(note)
    // …and the short form still carries its own arithmetic
    expect(note).toMatch(/\d+ of 100 points measured/)
  })

  it('names a stale scan on the card, not only on the chip', () => {
    const { season, rows } = marketOf()
    const r = altsRead({ season, rows, scanState: 'stale', live: true })
    const risk = r.risks.find((x) => x.key === 'stale_scan')
    expect(risk.text).toMatch(/past its live window/)
    // the exact age is on the chip, which ticks; a memoised read that quoted it
    // would print a frozen one. See read.js's docblock on `scanState`.
    expect(risk.text).not.toMatch(/\d+[smhd] ago/)
  })
})

/* ══ 6. nothing on this card may be undefined ══════════════════════════════ */

describe('every line is a value that was computed', () => {
  it('never emits undefined, NaN or a bare null into a row or a fact', () => {
    const cases = [
      read(),
      altsRead({ season: null, rows: marketOf().rows, scanState: LIVE, live: true }),
      altsRead({ season: marketOf().season, rows: [], scanState: LIVE, live: true }),
      altsRead({}),
      altsRead({ season: marketOf().season, rows: marketOf().rows, delta: fakeDelta(1), scanState: LIVE, live: true }),
      altsRead({ season: marketOf(UNIVERSE, { domHistory: domHistory(12) }).season, rows: marketOf().rows, scanState: LIVE, live: true }),
    ]
    for (const r of cases) {
      const t = textOf(r)
      expect(t, `undefined leaked into:\n${t}`).not.toMatch(/undefined/)
      expect(t).not.toMatch(/NaN/)
      expect(t).not.toMatch(/\bnull\b/)
      for (const x of r.rows) {
        expect(typeof x.k).toBe('string')
        expect(typeof x.v).toBe('string')
        expect(typeof x.note).toBe('string')
        expect(['go', 'warn', 'flat', 'bad']).toContain(x.tone)
      }
    }
  })

  it('spends no amber on the row that is present every single visit', () => {
    // A permanent warning colour is how a screen teaches you to ignore the
    // colour that also means your stop is hit.
    for (const r of [read(), altsRead({ season: null, rows: marketOf().rows, scanState: LIVE, live: true })]) {
      expect(rowByKey(r, 'wrong').tone).toBe('flat')
    }
  })

  it('survives garbage without throwing', () => {
    for (const bad of [undefined, {}, { rows: null, season: undefined }, { rows: [null, 3, 'x'], season: {} }]) {
      expect(() => altsRead(bad)).not.toThrow()
    }
    expect(altsRead().score).toBeNull()
  })
})

/* ══ helpers: the smallest inputs that reach each branch ═══════════════════ */

/**
 * A season.js-shaped result. Bounds default to a fully measured read (low ===
 * high === score), which is the only case where a hand-made season is safe to
 * reason about — every test that cares about the band uses explicit bounds.
 */
function fakeSeason(score, { of = 100, low = score, high = score } = {}) {
  return {
    score, phase: 'majors_rotating', label: 'Majors rotating', plain: 'x',
    breadth: {}, dominance: { trend: 'falling', days: 30, changePctPts: -1.2, samples: 30, spanDays: 29 },
    ethBtc: null, fearGreed: null,
    parts: of >= 100 ? [] : [{ key: 'dominance', label: 'dominance trend unknown (0 of 7 stored days needed) — not scored', points: null, max: 20 }],
    measured: { earned: low, of }, coverage: of / 100, bounds: { low, high }, facts: [],
  }
}

/**
 * A board with exactly `n` igniting rows, in the shape bandDistribution and the
 * naming filter both read.
 *
 * The filler matters. `boardWith(0)` MUST be a board on which nothing is
 * igniting, not an empty board — those are different inputs and read.js answers
 * them differently on purpose (the second is a refusal). The first version of
 * this helper returned `[]` for n = 0 and every zero-ignition case in this file
 * was silently testing the empty-board refusal instead of the weighting.
 */
function boardWith(n, filler = 45) {
  const igniting = Array.from({ length: n }, (_, i) => ({
    id: `ig${i}`, symbol: `IG${i}`, name: `Igniting ${i}`, score: 90 - i, band: 'igniting',
    flags: { freshBreak: true, thinLiquidity: false, newListing: false, parabolic: false },
  }))
  const rest = Array.from({ length: filler }, (_, i) => ({
    id: `bs${i}`, symbol: `BS${i}`, name: `Basing ${i}`, score: 40 - (i % 30), band: 'basing',
    flags: { freshBreak: false, thinLiquidity: false, newListing: false, parabolic: false },
  }))
  return [...igniting, ...rest]
}

function fakeDeltaCounts(counts) {
  const zero = { ignite: 0, advance: 0, break: 0, enter: 0, climb: 0, fade: 0, slide: 0, exit: 0 }
  const c = { ...zero, ...counts }
  const events = Object.entries(c).flatMap(([kind, n]) =>
    Array.from({ length: n }, (_, i) => ({ key: `${kind}:${i}`, kind, symbol: `E${i}`, text: `${kind} event`, tone: 'go' })))
  return { ok: true, reason: null, spanMs: 2 * 3600_000, compared: 40, counts: c, events }
}

/** A diff whose direction is `sign`, built out of real event kinds. */
function fakeDelta(sign) {
  if (sign > 0) return fakeDeltaCounts({ ignite: 3 })
  if (sign < 0) return fakeDeltaCounts({ fade: 3 })
  return fakeDeltaCounts({})
}
