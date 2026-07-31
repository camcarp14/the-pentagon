// The screener's one job is to tell a coin that is STARTING to move from one
// that has already moved. Most of this file is that assertion, made three ways:
// by the ranking (igniting beats extended beats already-ran), by the arithmetic
// (every worked example is computed by hand in the comments against the ladder
// at the top of screen.js), and by the exclusion set (a board with USDT on it
// is not a board).
import { describe, it, expect } from 'vitest'
import {
  screenCoin, screenUniverse, structure7d,
  isStablecoin, isWrapper, isExcluded, tierOf, kindOf,
} from '../screen.js'

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const ramp = (n, a, b) => Array.from({ length: n }, (_, i) => (n === 1 ? b : a + (b - a) * (i / (n - 1))))

const row = (over = {}) => ({
  id: 'test-coin', symbol: 'TEST', name: 'Test Coin', image: null,
  rank: 120, price: 1, mcap: 3e8, fdv: null, vol24h: 2e7,
  chg1h: null, chg24h: 0, chg7d: 0, chg14d: null, chg30d: 0, chg1y: null,
  ath: 3, athChangePct: -50, athDate: '2024-03-14T00:00:00.000Z', atl: 0.1,
  circulating: null, totalSupply: null, maxSupply: null,
  sparkline7d: null,
  ...over,
})

const BTC = { symbol: 'BTC', chg24h: 0.4, chg7d: 3.1, chg30d: 7.0 }

// A: IGNITING — flat week, one-day break to new 7d highs, real turnover.
//   rs7   18.4−3.1 = +15.3 pts   → 12
//   rs30  12.0−7.0 = +5.0  pts   → 5
//   a24   6.2 − 18.4/7(2.629)    = +3.571 → 10
//   a7v30 2.629 − 12/30(0.4)     = +2.229 → 12
//   turn  41M/310M = 0.1323      → 11
//   pos   1.00                   → 10
//   break yes                    → 10
//   room  62% below ATH          → 8
//                                = 78
const IGNITING = row({
  symbol: 'IGN', name: 'Ignition', chg24h: 6.2, chg7d: 18.4, chg30d: 12,
  vol24h: 41e6, mcap: 310e6, athChangePct: -62, price: 1.2,
  sparkline7d: [...ramp(144, 1.0, 1.05), ...ramp(24, 1.06, 1.2)],
})

// B: EXTENDED — the chase. Everything maxed, then the parabolic penalty.
//   15 + 10 + 18 + 12 + 15 + 10 + 10 + 0 = 90, then −25 = 65
const EXTENDED = row({
  symbol: 'EXT', name: 'Extended', chg24h: 47, chg7d: 130, chg30d: 260,
  vol24h: 900e6, mcap: 1.5e9, athChangePct: -5, price: 2.3,
  sparkline7d: ramp(168, 1.0, 2.3),
})

// C: ALREADY RAN — the coin a 30-day-return screener puts at the top.
//   rs7 −1.1 → 3 · rs30 +53 → 10 · a24 −1.286 → 0 · a7v30 −1.714 → 0
//   turn 0.0833 → 8 · pos 0.50 → 5 · break no → 0 · room 30% → 5   = 31
const ALREADY_RAN = row({
  symbol: 'RAN', name: 'Already Ran', chg24h: -1, chg7d: 2, chg30d: 60,
  vol24h: 25e6, mcap: 300e6, athChangePct: -30, price: 1.5,
  sparkline7d: [...ramp(144, 1.0, 2.0), ...ramp(24, 1.5, 1.5)],
})

const USDT = row({
  id: 'tether', symbol: 'USDT', name: 'Tether', price: 1.0,
  chg24h: 0.01, chg7d: 0.02, chg30d: 0.05, mcap: 140e9, vol24h: 60e9,
  athChangePct: -25, sparkline7d: ramp(168, 1.0, 1.0),
})

const STETH = row({
  id: 'staked-ether', symbol: 'STETH', name: 'Lido Staked Ether', price: 3400,
  chg24h: 1.2, chg7d: 4.0, chg30d: 9.0, mcap: 30e9, vol24h: 200e6,
  athChangePct: -30, sparkline7d: ramp(168, 3200, 3400),
})

/* ── the whole ask ────────────────────────────────────────────────────────── */

describe('starting to move vs already moved — the entire point of the file', () => {
  it('ranks the igniting coin above the parabolic one and the already-ran one', () => {
    const ctx = { btcRow: BTC }
    const ign = screenCoin(IGNITING, ctx)
    const ext = screenCoin(EXTENDED, ctx)
    const ran = screenCoin(ALREADY_RAN, ctx)

    expect(ign.score).toBe(78)
    expect(ext.score).toBe(65)
    expect(ran.score).toBe(31)
    expect(ign.score).toBeGreaterThan(ext.score)
    expect(ign.score).toBeGreaterThan(ran.score)

    const board = screenUniverse([ALREADY_RAN, EXTENDED, IGNITING], ctx)
    expect(board.map((c) => c.symbol)).toEqual(['IGN', 'EXT', 'RAN'])
  })

  it('does not let the biggest 30-day return top the board', () => {
    // EXTENDED has 20× the 30d return of IGNITING and is still second, and
    // ALREADY_RAN has 3× IGNITING's and is last. A return-sorted screener would
    // invert this list exactly.
    const board = screenUniverse([ALREADY_RAN, EXTENDED, IGNITING], { btcRow: BTC })
    expect(board[0].chg30d).toBeLessThan(board[1].chg30d)
    expect(board[0].chg30d).toBeLessThan(board[2].chg30d)
  })

  it('bands the three by state, not by score bucket', () => {
    expect(screenCoin(IGNITING, { btcRow: BTC }).band).toBe('igniting')
    expect(screenCoin(EXTENDED, { btcRow: BTC }).band).toBe('extended')
    expect(screenCoin(ALREADY_RAN, { btcRow: BTC }).band).toBe('basing')
  })

  it('carries the acceleration numbers the ranking was built on', () => {
    const ign = screenCoin(IGNITING, { btcRow: BTC })
    expect(ign.accel.daily7d).toBeCloseTo(2.6286, 3)
    expect(ign.accel.d24VsWeek).toBeCloseTo(3.5714, 3)
    expect(ign.accel.weekVsMonth).toBeCloseTo(2.2286, 3)
    expect(ign.rsVsBtc7d).toBeCloseTo(15.3, 6)
    expect(ign.rsVsBtc30d).toBeCloseTo(5.0, 6)
  })
})

/* ── parts[] must sum to score ────────────────────────────────────────────── */

describe('parts[] sums to score', () => {
  const cases = [IGNITING, EXTENDED, ALREADY_RAN,
    row({}), row({ chg24h: NaN, chg7d: NaN, chg30d: NaN, mcap: NaN, vol24h: NaN }),
    row({ chg24h: 200, chg7d: 400, chg30d: 900, vol24h: 1e3, mcap: 1e5 }),
    row({ vol24h: 1000, mcap: 1e6, chg24h: 90 }),
  ]
  it.each(cases.map((c, i) => [i, c]))('case %i', (_i, r) => {
    const s = screenCoin(r, { btcRow: BTC })
    expect(s.parts.reduce((a, p) => a + p.points, 0)).toBe(s.score)
    expect(s.score).toBeGreaterThanOrEqual(0)
    expect(s.score).toBeLessThanOrEqual(100)
  })

  it('clamps a penalty to the points actually earned rather than clamping the score', () => {
    // A parabolic micro-cap: it earns almost nothing, so −25 −15 cannot take it
    // past zero and cannot make parts[] disagree with the total.
    const junk = row({
      symbol: 'JUNK', chg24h: 90, chg7d: -30, chg30d: -70,
      vol24h: 1000, mcap: 5e5, athChangePct: -99, sparkline7d: null,
    })
    const s = screenCoin(junk, { btcRow: BTC })
    expect(s.flags.parabolic).toBe(true)
    expect(s.flags.thinLiquidity).toBe(true)
    expect(s.score).toBe(0)
    expect(s.parts.reduce((a, p) => a + p.points, 0)).toBe(0)
    expect(s.parts.find((p) => p.key === 'parabolic').points).toBeGreaterThanOrEqual(-25)
  })
})

/* ── exclusion is load-bearing ────────────────────────────────────────────── */

describe('stablecoin and wrapper exclusion', () => {
  it('scores USDT null and keeps it off the board despite the best turnover in the market', () => {
    const s = screenCoin(USDT, { btcRow: BTC })
    expect(s.flags.stablecoin).toBe(true)
    expect(s.score).toBeNull()
    expect(s.turnover).toBeCloseTo(60 / 140, 4) // 43% of its cap traded today
    expect(s.facts.join(' ')).toMatch(/stablecoin/i)

    const board = screenUniverse([USDT, IGNITING], { btcRow: BTC })
    expect(board.map((c) => c.symbol)).toEqual(['IGN'])
  })

  it('scores stETH null — a receipt for ETH is not an ETH-correlated mover', () => {
    const s = screenCoin(STETH, { btcRow: BTC })
    expect(s.flags.wrapper).toBe(true)
    expect(s.score).toBeNull()
    expect(screenUniverse([STETH, IGNITING], { btcRow: BTC })).toHaveLength(1)
  })

  it('catches a stablecoin that is not on the static list, by flatness on all three windows', () => {
    const unknownStable = row({
      symbol: 'XUSD', name: 'Xeno USD', price: 1.001,
      chg24h: 0.1, chg7d: 0.3, chg30d: 0.4, mcap: 3e9, vol24h: 4e8,
    })
    expect(isStablecoin(unknownStable)).toBe(true)
    expect(screenUniverse([unknownStable], { btcRow: BTC })).toHaveLength(0)
  })

  // The regression the tightened heuristic exists for. "|30d| < 2% on a $1B cap"
  // on its own deletes Bitcoin from the market in any quiet month.
  it('never classifies BTC as a stablecoin during a flat month', () => {
    const quietBtc = row({ symbol: 'BTC', name: 'Bitcoin', price: 96000, chg24h: 0.3, chg7d: 0.5, chg30d: 1.2, mcap: 1.9e12 })
    expect(isStablecoin(quietBtc)).toBe(false)
    expect(isExcluded(quietBtc)).toBe(false)
    expect(screenCoin(quietBtc, { btcRow: BTC }).score).not.toBeNull()
  })

  it('catches wrappers by name and by CoinGecko id, not by the letter W', () => {
    expect(isWrapper(row({ symbol: 'XBTC', name: 'Frobnitz Wrapped Bitcoin' }))).toBe(true)
    expect(isWrapper(row({ symbol: 'ZETH', name: 'Zeta Staked Ether' }))).toBe(true)
    expect(isWrapper(row({ id: 'bridged-usdc-mantle', symbol: 'QQQ', name: 'Some Token' }))).toBe(true)
    // Real coins whose ticker starts with W — a symbol-shape heuristic eats all
    // three, which is why there isn't one.
    for (const sym of ['WIF', 'WLD', 'WEN']) {
      expect(isWrapper(row({ symbol: sym, name: sym === 'WIF' ? 'dogwifhat' : sym === 'WLD' ? 'Worldcoin' : 'Wen' }))).toBe(false)
    }
  })

  it('excluded rows still report a full flag object, so the UI can say why', () => {
    const s = screenCoin(USDT, { btcRow: BTC })
    expect(Object.keys(s.flags).sort()).toEqual(
      ['freshBreak', 'newListing', 'parabolic', 'stablecoin', 'thinLiquidity', 'wrapper'])
  })
})

/* ── penalties and flags ──────────────────────────────────────────────────── */

describe('penalties', () => {
  it('flags parabolic on 24h > +40% and on 7d > +100%, separately', () => {
    expect(screenCoin(row({ chg24h: 41, chg7d: 45 }), { btcRow: BTC }).flags.parabolic).toBe(true)
    expect(screenCoin(row({ chg24h: 12, chg7d: 101 }), { btcRow: BTC }).flags.parabolic).toBe(true)
    expect(screenCoin(row({ chg24h: 40, chg7d: 100 }), { btcRow: BTC }).flags.parabolic).toBe(false)
  })

  it('costs exactly 25 points when the coin has 25 to lose', () => {
    const calm = row({ symbol: 'A', chg24h: 30, chg7d: 20, chg30d: 15, vol24h: 5e7, mcap: 4e8, athChangePct: -60 })
    const hot = { ...calm, chg24h: 41 }
    // Only the parabolic threshold differs, but a24 is on the same rung either
    // way (30 and 41 are both ≥ +8 over the week's pace), so the delta is clean.
    expect(screenCoin(calm, { btcRow: BTC }).score - screenCoin(hot, { btcRow: BTC }).score).toBe(25)
  })

  it('flags thin liquidity under $250k of 24h volume and says you cannot get out', () => {
    const thin = screenCoin(row({ vol24h: 180_000, mcap: 2e7 }), { btcRow: BTC })
    expect(thin.flags.thinLiquidity).toBe(true)
    expect(thin.facts.join(' ')).toMatch(/get in but not out/)
    expect(screenCoin(row({ vol24h: 250_000 }), { btcRow: BTC }).flags.thinLiquidity).toBe(false)
  })

  it('does not read a missing volume as thin liquidity', () => {
    expect(screenCoin(row({ vol24h: null }), { btcRow: BTC }).flags.thinLiquidity).toBe(false)
    expect(screenCoin(row({ vol24h: NaN }), { btcRow: BTC }).flags.thinLiquidity).toBe(false)
  })

  it('flags a new listing from the missing 30d window, not from a guess', () => {
    const fresh = screenCoin(row({ chg7d: 40, chg30d: null }), { btcRow: BTC })
    expect(fresh.flags.newListing).toBe(true)
    expect(fresh.facts.join(' ')).toMatch(/no 30-day history/)
    expect(screenCoin(row({ chg7d: null, chg30d: null }), { btcRow: BTC }).flags.newListing).toBe(false)
  })
})

/* ── 7-day structure ──────────────────────────────────────────────────────── */

describe('structure7d', () => {
  it('reads position in the range and the break of the prior six days', () => {
    const s = structure7d([...ramp(144, 1.0, 1.05), ...ramp(24, 1.06, 1.2)])
    expect(s.low).toBeCloseTo(1.0, 6)
    expect(s.high).toBeCloseTo(1.2, 6)
    expect(s.pos).toBeCloseTo(1.0, 6)
    expect(s.priorHigh).toBeCloseTo(1.05, 6)
    expect(s.freshBreak).toBe(true)
  })

  it('does not call a pullback from the highs a break', () => {
    const s = structure7d([...ramp(144, 1.0, 2.0), ...ramp(24, 1.5, 1.5)])
    expect(s.freshBreak).toBe(false)
    expect(s.pos).toBeCloseTo(0.5, 6)
  })

  it('survives a flat series without dividing by a zero range', () => {
    const s = structure7d(new Array(168).fill(2))
    expect(s.pos).toBeNull()
    expect(Number.isNaN(s.pos)).toBe(false)
    expect(s.freshBreak).toBe(false)
  })

  it('degrades on null, short and dirty series', () => {
    for (const bad of [null, undefined, [], [1, 2, 3], 'nope', [NaN, NaN, NaN]]) {
      const s = structure7d(bad)
      expect(s.pos).toBeNull()
      expect(s.freshBreak).toBe(false)
    }
    // Non-finite entries are dropped, not propagated into the min/max.
    const s = structure7d([1, 2, NaN, 3, 4, null, 5, 6, 7, 8])
    expect(s.low).toBe(1)
    expect(s.high).toBe(8)
  })

  // A truncated series (a coin listed four days ago) must still split into
  // "the last day" and "the days before it" rather than comparing 24 points
  // against whatever is left.
  it('derives the day window from the series length, not a hard-coded 24', () => {
    const short = [...ramp(60, 1.0, 1.1), ...ramp(10, 1.11, 1.4)] // 70 points, day ≈ 10
    const s = structure7d(short)
    expect(s.points).toBe(70)
    expect(s.freshBreak).toBe(true)
  })

  it('scores a coin with no sparkline at zero for structure, and labels why', () => {
    const s = screenCoin(row({ sparkline7d: null }), { btcRow: BTC })
    const range = s.parts.find((p) => p.key === 'range')
    const brk = s.parts.find((p) => p.key === 'break')
    expect(range.points).toBe(0)
    expect(brk.points).toBe(0)
    expect(range.label).toMatch(/sparkline missing/)
    expect(brk.label).toMatch(/too short/)
  })

  /* ── the RANGE and the LEVELS are two different pairs ─────────────────────
   *
   * `low`/`high` describe where the series has been, today included, and they
   * are the only correct denominator for `pos`. `priorLow`/`priorHigh` are what
   * price has to lose or clear, today EXCLUDED.
   *
   * They were not two pairs. `priorHigh` excluded today and `low` did not, and
   * directive.js's sparkline fallback used `low` as the invalidation level — so
   * the level equalled the price on every row making its own 7-day low, which is
   * a test of the series against itself. Every level the scheduled sentinel
   * alerts on comes from that fallback (alt-watch.mjs passes `candles: null`),
   * so this asymmetry was the one that reached the phone.
   */
  it('takes both levels from the SAME prior-six-day slice, today excluded', () => {
    // 168 points: the first 144 are the prior six days, the last 24 are today.
    const prior = ramp(144, 10.0, 10.3)
    for (const today of [
      ramp(24, 10.2, 9.0),                      // today makes the whole week's low
      ramp(24, 10.2, 30),                       // today makes the whole week's high
      [...ramp(12, 10.2, 1e-6), ...ramp(12, 1e-6, 10.2)],  // today spikes both ways
    ]) {
      const s = structure7d([...prior, ...today])
      expect(s.priorHigh).toBeCloseTo(10.3, 9)
      expect(s.priorLow).toBeCloseTo(10.0, 9)
      // Neither level saw today, however extreme today was — the same property
      // directive.js's 20-bar candle window is held to.
      expect(s.priorLow).toBeLessThanOrEqual(s.priorHigh)
    }
  })

  it('does not let the low be the live price, which is what made it a level and not a reading', () => {
    // A tape that ends at its own minimum — the shape the sentinel fired on.
    const s = structure7d([...ramp(144, 10.3, 10.0), ...ramp(24, 9.98, 9.0)])
    expect(s.last).toBe(9)
    expect(s.low).toBe(9)               // the RANGE floor IS the live point, correctly
    expect(s.priorLow).toBeCloseTo(10.0, 9)   // the LEVEL is not
    expect(s.priorLow).toBeGreaterThan(s.last)
  })

  it('keeps `low`/`high` as the range `pos` is measured in, unchanged', () => {
    // The other half of the bargain: fixing the level must not move the reading.
    // pos has to include today or it can exceed 1.
    const s = structure7d([...ramp(144, 1.0, 1.05), ...ramp(24, 1.06, 1.2)])
    expect(s.low).toBeCloseTo(1.0, 6)
    expect(s.high).toBeCloseTo(1.2, 6)
    expect(s.pos).toBeCloseTo(1.0, 6)
    expect(s.pos).toBeLessThanOrEqual(1)
  })

  it('publishes priorLow as null on every path that publishes priorHigh as null', () => {
    // The pair is total: a consumer that has one always has the other, so the
    // fallback can never take a level off one end of a window and not the other.
    for (const bad of [null, undefined, [], [1, 2, 3], 'nope', [NaN, NaN, NaN]]) {
      const s = structure7d(bad)
      expect(s.priorHigh).toBeNull()
      expect(s.priorLow).toBeNull()
    }
    // …and on the excluded-row stub, which is a hand-written literal.
    const stub = screenCoin(row({ symbol: 'USDT', name: 'Tether', price: 1, mcap: 5e10 }), { btcRow: BTC })
    expect(stub.score).toBeNull()
    expect(stub.range7d).toHaveProperty('priorLow', null)
    // Every real series long enough for a high is long enough for a low.
    for (const n of [8, 9, 13, 20, 40, 70, 100, 168]) {
      const s = structure7d(ramp(n, 1, 2))
      expect(Number.isFinite(s.priorHigh)).toBe(Number.isFinite(s.priorLow))
      expect(Number.isFinite(s.priorLow)).toBe(true)
    }
  })
})

/* ── turnover, tier, kind ─────────────────────────────────────────────────── */

describe('turnover / tier / kind', () => {
  it('computes turnover as vol24h over mcap and refuses a zero cap', () => {
    expect(screenCoin(row({ vol24h: 5e7, mcap: 2e8 }), {}).turnover).toBeCloseTo(0.25, 6)
    expect(screenCoin(row({ vol24h: 5e7, mcap: 0 }), {}).turnover).toBeNull()
    expect(screenCoin(row({ vol24h: 5e7, mcap: null }), {}).turnover).toBeNull()
  })

  it('tiers by the contract thresholds', () => {
    expect(tierOf(2e10)).toBe('major')
    expect(tierOf(1e10)).toBe('major')
    expect(tierOf(5e9)).toBe('mid')
    expect(tierOf(5e8)).toBe('small')
    expect(tierOf(5e7)).toBe('micro')
    expect(tierOf(null)).toBe('unknown')
  })

  it('classifies kind from categories first, then the authored lists, then unknown', () => {
    expect(kindOf({ symbol: 'ZZZ', categories: ['Meme', 'Solana Ecosystem'] })).toBe('meme')
    expect(kindOf({ symbol: 'ZZZ', categories: ['Layer 1'] })).toBe('utility')
    expect(kindOf({ symbol: 'PEPE' })).toBe('meme')
    expect(kindOf({ symbol: 'LINK' })).toBe('utility')
    expect(kindOf({ symbol: 'ZZZ' })).toBe('unknown')
  })
})

/* ── degrade, don't crash ─────────────────────────────────────────────────── */

describe('degrade paths', () => {
  it('screens a row with no context at all', () => {
    const s = screenCoin(row({}), {})
    expect(s.rsVsBtc7d).toBeNull()
    expect(s.parts.find((p) => p.key === 'rs7').label).toMatch(/no 7d RS/)
    expect(s.score).toBeGreaterThanOrEqual(0)
  })

  it('screens garbage rows without throwing', () => {
    for (const bad of [null, undefined, {}, { symbol: 123 }, { chg7d: Infinity, mcap: -1 }]) {
      expect(() => screenCoin(bad, { btcRow: BTC })).not.toThrow()
    }
    expect(screenCoin({}, {}).score).toBeGreaterThanOrEqual(0)
  })

  it('screenUniverse tolerates a non-array, holes and junk entries', () => {
    expect(screenUniverse(null, {})).toEqual([])
    expect(screenUniverse(undefined, {})).toEqual([])
    expect(screenUniverse('nope', {})).toEqual([])
    const board = screenUniverse([null, undefined, 42, 'x', IGNITING], { btcRow: BTC })
    expect(board).toHaveLength(1)
    expect(board[0].symbol).toBe('IGN')
  })

  it('keeps the row fields the board renders', () => {
    const s = screenCoin(IGNITING, { btcRow: BTC })
    expect(s.id).toBe('test-coin')
    expect(s.symbol).toBe('IGN')
    expect(s.sparkline7d).toBe(IGNITING.sparkline7d)
    expect(s.mcap).toBe(310e6)
  })
})

/* ── ordering ─────────────────────────────────────────────────────────────── */

describe('board ordering', () => {
  it('sorts by score descending', () => {
    const board = screenUniverse([ALREADY_RAN, IGNITING, EXTENDED, USDT, STETH], { btcRow: BTC })
    for (let i = 1; i < board.length; i++) expect(board[i - 1].score).toBeGreaterThanOrEqual(board[i].score)
  })

  // Without a total order the board reshuffles between two renders of identical
  // data, which reads as live movement.
  it('breaks ties deterministically, whatever order the universe arrives in', () => {
    const a = row({ id: 'a', symbol: 'AAA', mcap: 5e8 })
    const b = row({ id: 'b', symbol: 'BBB', mcap: 9e8 })
    const c = row({ id: 'c', symbol: 'CCC', mcap: 1e8 })
    const one = screenUniverse([a, b, c], { btcRow: BTC }).map((x) => x.symbol)
    const two = screenUniverse([c, a, b], { btcRow: BTC }).map((x) => x.symbol)
    const three = screenUniverse([b, c, a], { btcRow: BTC }).map((x) => x.symbol)
    expect(one).toEqual(two)
    expect(two).toEqual(three)
  })
})

/* ── facts carry the numbers ──────────────────────────────────────────────── */

describe('facts, in the voice of signals.js', () => {
  it('states the relative strength with both returns in it', () => {
    const f = screenCoin(IGNITING, { btcRow: BTC }).facts.join('\n')
    expect(f).toMatch(/7d \+18\.4% vs BTC \+3\.1% — \+15\.3 pts of relative strength/)
    expect(f).toMatch(/24h \+6\.2% against a 7-day pace of \+2\.63%\/day/)
    expect(f).toMatch(/\$41\.0M traded on a \$310\.0M cap — 13\.2% of the float in a day/)
    expect(f).toMatch(/62% below the all-time high/)
    expect(f).toMatch(/took out the prior 6-day high/)
  })

  it('prices sub-dollar coins in significant digits, never $0.00', () => {
    const meme = row({
      symbol: 'PEPE', name: 'Pepe', price: 0.0000082, ath: 0.0000175, athChangePct: -53,
      chg24h: 9, chg7d: 15, chg30d: 8, vol24h: 1e9, mcap: 3.4e9,
      sparkline7d: [...ramp(144, 0.0000061, 0.0000071), ...ramp(24, 0.0000072, 0.0000082)],
    })
    const f = screenCoin(meme, { btcRow: BTC }).facts.join('\n')
    expect(f).not.toMatch(/\$0\.00\b/)
    expect(f).toMatch(/0\.00000/)
  })

  // The regime changes what a good setup is WORTH, not what it scores. Folding
  // it into the number would make the same chart rank differently in different
  // markets, and the board would stop being a ranking of setups.
  it('lets the season add a fact and never a point', () => {
    const hostile = { phase: 'risk_off', label: 'Risk off', score: 8 }
    const neutral = screenCoin(IGNITING, { btcRow: BTC })
    const against = screenCoin(IGNITING, { btcRow: BTC, season: hostile })
    expect(against.score).toBe(neutral.score)
    expect(against.parts).toEqual(neutral.parts)
    expect(against.facts.join('\n')).toMatch(/lifting into a Risk off regime \(8\/100\)/)
    expect(neutral.facts.join('\n')).not.toMatch(/regime/)
    // ...and it stays quiet when the regime is not fighting the setup.
    expect(screenCoin(IGNITING, { btcRow: BTC, season: { phase: 'alt_season', label: 'Alt season', score: 82 } })
      .facts.join('\n')).not.toMatch(/regime/)
  })

  it('names the ATH age when now is supplied and stays silent when it is not', () => {
    const withNow = screenCoin(row({}), { btcRow: BTC, now: Date.parse('2025-03-14T00:00:00Z') })
    expect(withNow.facts.join(' ')).toMatch(/set 365 days ago/)
    expect(screenCoin(row({}), { btcRow: BTC }).facts.join(' ')).not.toMatch(/days ago/)
  })
})
