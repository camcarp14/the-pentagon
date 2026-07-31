// seasonRead has two properties worth defending with tests: the score is
// arithmetic anyone can redo on a phone (so every case below states the sum),
// and the dominance trend is the one number in the app that is allowed to say
// "I don't know" — because it is fed by a cron that has not run yet on the day
// this ships, and a fabricated trend there would move the phase label, which is
// the first thing read on the tab.
import { describe, it, expect } from 'vitest'
import { seasonRead } from '../season.js'

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const BTC = { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', rank: 1, mcap: 1.9e12, price: 96000, chg24h: 0.4, chg7d: 3, chg30d: 7 }

/**
 * `nAlts` rows where the first `beat7` beat BTC over 7d and the first `beat30`
 * beat it over 30d. Ranks start at 2 so BTC keeps rank 1 when it is added.
 */
function makeUniverse({ nAlts = 100, beat7 = 50, beat30 = 50, btc7 = 3, btc30 = 7 } = {}) {
  return Array.from({ length: nAlts }, (_, i) => ({
    id: `coin-${i}`, symbol: `C${i}`, name: `Coin ${i}`, rank: i + 2,
    price: 2.5, mcap: 5e8, vol24h: 1e7, chg24h: 1,
    chg7d: i < beat7 ? btc7 + 10 : btc7 - 10,
    chg30d: i < beat30 ? btc30 + 10 : btc30 - 10,
  }))
}

const DAY = 86_400_000
const BASE = Date.parse('2026-06-01T00:00:00Z')
const dstr = (i) => new Date(BASE + i * DAY).toISOString().slice(0, 10)
const domHist = (n, from, to) => Array.from({ length: n }, (_, i) => ({
  d: dstr(i), btcDom: n === 1 ? to : from + (to - from) * (i / (n - 1)), ethDom: 18, totalMcap: 2.4e12,
}))

const eth = (chg7d, chg30d) => ({ id: 'ethereum', symbol: 'ETH', name: 'Ethereum', rank: 2, mcap: 4e11, price: 3400, chg24h: 1, chg7d, chg30d })

/* ── the score is arithmetic ──────────────────────────────────────────────── */

describe('the 100 points, verified by hand', () => {
  // 63% over 7d → round(0.35×63) = 22
  // 48% over 30d → round(0.25×48) = 12
  // dominance unknown → midpoint 10 · ETH/BTC absent → 5 · F&G absent → 5
  //                                                              = 54
  it('scores a plain breadth-only read at the sum of its parts', () => {
    const s = seasonRead({ universe: makeUniverse({ beat7: 63, beat30: 48 }), btcRow: BTC })
    expect(s.parts.map((p) => [p.key, p.points])).toEqual([
      ['breadth7', 22], ['breadth30', 12], ['dominance', 10], ['ethbtc', 5], ['feargreed', 5],
    ])
    expect(s.score).toBe(54)
    expect(s.phase).toBe('btc_leads')
  })

  it('parts always sum to score, and score stays inside 0-100', () => {
    for (const beat7 of [0, 17, 50, 83, 100]) {
      for (const fgv of [0, 39, 65, 100, null]) {
        const s = seasonRead({
          universe: makeUniverse({ beat7, beat30: beat7 }),
          btcRow: BTC, ethRow: eth(5, 5),
          fearGreed: fgv == null ? null : { value: fgv, label: 'x' },
          domHistory: domHist(30, 56, 54),
        })
        expect(s.parts.reduce((a, p) => a + p.points, 0)).toBe(s.score)
        expect(s.score).toBeGreaterThanOrEqual(0)
        expect(s.score).toBeLessThanOrEqual(100)
      }
    }
  })

  it('walks the whole phase ladder on scores you can add up', () => {
    // risk_off: 3 + 1 + 0 + 0 + 1 = 5
    const off = seasonRead({
      universe: makeUniverse({ beat7: 8, beat30: 5 }), btcRow: BTC, ethRow: eth(-10, -20),
      fearGreed: { value: 12, label: 'Extreme Fear' }, domHistory: domHist(30, 54, 57),
    })
    expect(off.score).toBe(5)
    expect(off.phase).toBe('risk_off')

    // btc_only: 12 + 6 + 0 + 0 + 6 = 24
    const only = seasonRead({
      universe: makeUniverse({ beat7: 35, beat30: 25 }), btcRow: BTC, ethRow: eth(-10, -20),
      fearGreed: { value: 60, label: 'Greed' }, domHistory: domHist(30, 54, 57),
    })
    expect(only.score).toBe(24)
    expect(only.phase).toBe('btc_only')

    // majors_rotating: 21 + 14 + 20 + 5 + 7 = 67
    const majors = seasonRead({
      universe: makeUniverse({ beat7: 60, beat30: 55 }), btcRow: BTC, ethRow: eth(12, 2),
      fearGreed: { value: 65, label: 'Greed' }, domHistory: domHist(30, 56, 54),
    })
    expect(majors.score).toBe(67)
    expect(majors.phase).toBe('majors_rotating')

    // alt_season: 27 + 18 + 20 + 10 + 7 = 82
    const alt = seasonRead({
      universe: makeUniverse({ beat7: 78, beat30: 72 }), btcRow: BTC, ethRow: eth(12, 30),
      fearGreed: { value: 65, label: 'Greed' }, domHistory: domHist(30, 56, 54),
    })
    expect(alt.score).toBe(82)
    expect(alt.phase).toBe('alt_season')
  })

  // Euphoria needs corroboration from OUTSIDE the score: a high score on its own
  // is alt season, which is the good outcome, not the warning.
  it('only calls it euphoric when the crowd is already all-in', () => {
    const base = { universe: makeUniverse({ beat7: 78, beat30: 72 }), btcRow: BTC, ethRow: eth(12, 30), domHistory: domHist(30, 56, 54) }
    expect(seasonRead({ ...base, fearGreed: { value: 65, label: 'Greed' } }).phase).toBe('alt_season')
    expect(seasonRead({ ...base, fearGreed: { value: 85, label: 'Extreme Greed' } }).phase).toBe('euphoric')
    // ...or when breadth itself is at an extreme even with the index moderate.
    const wide = seasonRead({
      universe: makeUniverse({ beat7: 90, beat30: 80 }), btcRow: BTC, ethRow: eth(12, 30),
      fearGreed: { value: 65, label: 'Greed' }, domHistory: domHist(30, 56, 54),
    })
    expect(wide.phase).toBe('euphoric')
    expect(wide.plain).toMatch(/not where new positions get opened/)
  })

  it('reads fear & greed monotonically — risk appetite, not a contrarian tell', () => {
    const at = (v) => seasonRead({
      universe: makeUniverse({ beat7: 50, beat30: 50 }), btcRow: BTC,
      fearGreed: { value: v, label: 'x' },
    }).parts.find((p) => p.key === 'feargreed').points
    expect(at(0)).toBe(0)
    expect(at(39)).toBe(4)
    expect(at(100)).toBe(10)
    expect(at(39)).toBeLessThan(at(65))
  })

  it('clamps a fear & greed value that arrives outside 0-100', () => {
    const s = seasonRead({ universe: makeUniverse({}), btcRow: BTC, fearGreed: { value: 400 } })
    expect(s.fearGreed.value).toBe(100)
    expect(s.parts.find((p) => p.key === 'feargreed').points).toBe(10)
  })
})

/* ── dominance: the honest 'unknown' ──────────────────────────────────────── */

describe('dominance trend comes only from domHistory', () => {
  it('reports unknown with no history at all, and says how many days exist', () => {
    const s = seasonRead({ universe: makeUniverse({}), btcRow: BTC, domHistory: null })
    expect(s.dominance.trend).toBe('unknown')
    expect(s.dominance.days).toBe(0)
    expect(s.dominance.changePctPts30d).toBeNull()
    expect(s.facts.join('\n')).toMatch(/0 days of dominance history stored — the trend needs 7/)
  })

  it('stays unknown at six samples and resolves at seven', () => {
    const u = makeUniverse({})
    expect(seasonRead({ universe: u, btcRow: BTC, domHistory: domHist(6, 57, 54) }).dominance.trend).toBe('unknown')
    expect(seasonRead({ universe: u, btcRow: BTC, domHistory: domHist(7, 57, 54) }).dominance.trend).toBe('falling')
  })

  // The whole reason the rule exists: /global gives a dominance LEVEL every
  // scan and no history whatsoever. A level is not a trend.
  it('never infers a trend from the live global feed', () => {
    const s = seasonRead({
      universe: makeUniverse({}), btcRow: BTC, domHistory: null,
      global: { btcDominancePct: 58.4, ethDominancePct: 13.1, totalMcapUsd: 2.4e12, totalVol24hUsd: 9e10, mcapChange24hPct: -3.2 },
    })
    expect(s.dominance.pct).toBe(58.4)
    expect(s.dominance.trend).toBe('unknown')
    expect(s.parts.find((p) => p.key === 'dominance').points).toBe(10)
    expect(s.parts.find((p) => p.key === 'dominance').label).toMatch(/scored at the midpoint/)
  })

  it('classifies falling / rising / flat around a 0.5-point noise band', () => {
    const u = makeUniverse({})
    const trend = (from, to) => seasonRead({ universe: u, btcRow: BTC, domHistory: domHist(30, from, to) }).dominance.trend
    expect(trend(56, 54)).toBe('falling')   // −2.0
    expect(trend(54, 57)).toBe('rising')    // +3.0
    expect(trend(56, 56.3)).toBe('flat')    // +0.3
    expect(trend(56, 55.7)).toBe('flat')    // −0.3
  })

  it('measures across at most 30 stored days while still reporting the full depth', () => {
    // 60 samples running 60.0 → 50.0; the last 30 of them cover 54.92 → 50.00,
    // so the reported change is the 30-day one (−4.92) and NOT the 60-day one.
    const s = seasonRead({ universe: makeUniverse({}), btcRow: BTC, domHistory: domHist(60, 60, 50) })
    expect(s.dominance.days).toBe(60)
    expect(s.dominance.windowDays).toBe(30)
    expect(s.dominance.changePctPts30d).toBeCloseTo(-4.915, 2)
  })

  it('sorts the samples by date, so an out-of-order blob does not flip the sign', () => {
    const asc = domHist(30, 57, 54)
    const shuffled = [...asc].reverse()
    const a = seasonRead({ universe: makeUniverse({}), btcRow: BTC, domHistory: asc })
    const b = seasonRead({ universe: makeUniverse({}), btcRow: BTC, domHistory: shuffled })
    expect(b.dominance.trend).toBe('falling')
    expect(b.dominance.changePctPts30d).toBeCloseTo(a.dominance.changePctPts30d, 9)
  })

  it('prefers the live dominance level and falls back to the stored one, naming which', () => {
    const hist = domHist(10, 57, 55)
    const live = seasonRead({ universe: makeUniverse({}), btcRow: BTC, domHistory: hist, global: { btcDominancePct: 55.2 } })
    expect(live.dominance.pct).toBe(55.2)
    const stored = seasonRead({ universe: makeUniverse({}), btcRow: BTC, domHistory: hist, global: null })
    expect(stored.dominance.pct).toBeCloseTo(55, 9)
    expect(stored.facts.join('\n')).toMatch(/from stored history/)
  })

  it('says when the cron has stopped writing', () => {
    const s = seasonRead({
      universe: makeUniverse({}), btcRow: BTC, domHistory: domHist(30, 57, 55),
      now: BASE + 29 * DAY + 6 * DAY, // six days past the newest sample
    })
    expect(s.facts.join('\n')).toMatch(/dominance history has not been written for 6 days/)
  })

  // A 30-day field has to mean thirty days. Slicing the last 30 SAMPLES is the
  // same thing only while the cron has never missed a day.
  it('bounds the window by date, so an outage cannot be measured as a 30-day move', () => {
    const stale = [
      ...domHist(20, 62, 60).map((s, i) => ({ ...s, d: dstr(i - 90) })), // three months ago
      ...domHist(3, 55, 54.9),                                           // three recent samples
    ]
    const s = seasonRead({ universe: makeUniverse({}), btcRow: BTC, domHistory: stale })
    expect(s.dominance.days).toBe(23)
    expect(s.dominance.windowDays).toBe(3)
    expect(s.dominance.trend).toBe('unknown')     // not "falling 7 points"
    expect(s.dominance.changePctPts30d).toBeNull()
    expect(s.facts.join('\n')).toMatch(/only 3 of 23 stored dominance samples fall inside the last 30 days/)
  })

  it('drops samples with no btcDom rather than counting them as history', () => {
    const dirty = [...domHist(4, 57, 56), { d: dstr(4), btcDom: null }, { d: dstr(5) }, null]
    const s = seasonRead({ universe: makeUniverse({}), btcRow: BTC, domHistory: dirty })
    expect(s.dominance.days).toBe(4)
    expect(s.dominance.trend).toBe('unknown')
  })
})

/* ── breadth ──────────────────────────────────────────────────────────────── */

describe('breadth — the honest rotation measure', () => {
  it('counts the share of the eligible top 100 that beat BTC, per window', () => {
    const s = seasonRead({ universe: makeUniverse({ beat7: 63, beat30: 48 }), btcRow: BTC })
    expect(s.breadth.n).toBe(100)
    expect(s.breadth.beatBtc7dPct).toBeCloseTo(63, 9)
    expect(s.breadth.beatBtc30dPct).toBeCloseTo(48, 9)
    expect(s.facts.join('\n')).toMatch(/63 of 100 top-100 alts beat BTC over 7d \(63%\) — BTC did \+3\.0%/)
    expect(s.facts.join('\n')).toMatch(/48 of 100 beat BTC over 30d \(48%\)/)
  })

  it('excludes BTC itself, stablecoins and wrapped/staked derivatives', () => {
    const universe = [
      BTC,
      { id: 'tether', symbol: 'USDT', name: 'Tether', rank: 3, price: 1, mcap: 140e9, vol24h: 6e10, chg24h: 0.01, chg7d: 0.02, chg30d: 0.05 },
      { id: 'staked-ether', symbol: 'STETH', name: 'Lido Staked Ether', rank: 4, price: 3400, mcap: 3e10, chg24h: 1, chg7d: 40, chg30d: 40 },
      { id: 'wrapped-bitcoin', symbol: 'WBTC', name: 'Wrapped Bitcoin', rank: 5, price: 96000, mcap: 1e10, chg24h: 0.4, chg7d: 3, chg30d: 7 },
      ...makeUniverse({ nAlts: 10, beat7: 5, beat30: 5 }),
    ]
    const s = seasonRead({ universe, btcRow: BTC })
    expect(s.breadth.n).toBe(10)              // the ten alts, nothing else
    expect(s.breadth.excluded).toBe(3)        // USDT + stETH + WBTC
    expect(s.breadth.beatBtc7dPct).toBeCloseTo(50, 9)
    expect(s.facts.join('\n')).toMatch(/3 stablecoin\/wrapped rows excluded/)
  })

  // A recent listing has a 7d return and no 30d one. Folding both windows into
  // a single denominator understates 30d breadth by exactly the number of new
  // listings, which spikes in the market where this number matters most.
  it('gives each window its own denominator', () => {
    const universe = [
      ...makeUniverse({ nAlts: 10, beat7: 6, beat30: 6 }),
      { id: 'brand-new', symbol: 'NEW', name: 'Brand New', rank: 90, price: 4, mcap: 3e8, vol24h: 9e6, chg24h: 20, chg7d: 60, chg30d: null },
    ]
    const s = seasonRead({ universe, btcRow: BTC })
    expect(s.breadth.n).toBe(11)
    expect(s.breadth.n7).toBe(11)
    expect(s.breadth.n30).toBe(10)
    expect(s.breadth.beatBtc7dPct).toBeCloseTo((7 / 11) * 100, 6)
    expect(s.breadth.beatBtc30dPct).toBeCloseTo(60, 9)
  })

  it('takes the top 100 by rank whatever order the rows arrive in', () => {
    // 150 rows ranked 2–151, delivered backwards. Only ranks 2–101 count, so
    // the denominator is 100 and not 150 — an easy way to accidentally measure
    // breadth over the whole 250-row universe the scan actually fetches.
    const wide = makeUniverse({ nAlts: 150, beat7: 150, beat30: 150 })
    const s = seasonRead({ universe: [...wide].reverse(), btcRow: BTC })
    expect(s.breadth.n).toBe(100)
    expect(s.breadth.beatBtc7dPct).toBe(100)
  })
})

/* ── ETH/BTC ──────────────────────────────────────────────────────────────── */

describe('ETH/BTC is the pair return, not a subtraction', () => {
  it('reports +37.5% for ETH +120 against BTC +60, not +60', () => {
    const s = seasonRead({ universe: makeUniverse({}), btcRow: { ...BTC, chg7d: 60, chg30d: 60 }, ethRow: eth(120, 120) })
    expect(s.ethBtc.chg7dPct).toBeCloseTo(37.5, 6)
    expect(s.ethBtc.chg7dPct).not.toBeCloseTo(60, 1)
    expect(s.ethBtc.trend).toBe('rising')
  })

  it('reports null, not zero, for a window it cannot measure', () => {
    const s = seasonRead({ universe: makeUniverse({}), btcRow: BTC, ethRow: eth(9, null) })
    expect(s.ethBtc.chg7dPct).toBeCloseTo(5.825, 3)
    expect(s.ethBtc.chg30dPct).toBeNull()
    // 5 for the leg that resolved, the midpoint 2.5 for the one that did not.
    expect(s.parts.find((p) => p.key === 'ethbtc').points).toBe(8)
  })

  it('returns null with a stated reason when there is no ETH row', () => {
    const s = seasonRead({ universe: makeUniverse({}), btcRow: BTC, ethRow: null })
    expect(s.ethBtc).toBeNull()
    expect(s.facts.join('\n')).toMatch(/ETH\/BTC unavailable/)
    expect(s.parts.find((p) => p.key === 'ethbtc').points).toBe(5)
  })
})

/* ── degrade, don't crash ─────────────────────────────────────────────────── */

describe('degrade paths', () => {
  it('refuses to score with no universe and says why', () => {
    for (const universe of [null, undefined, [], 'nope']) {
      const s = seasonRead({ universe, btcRow: BTC })
      expect(s.score).toBeNull()
      expect(s.phase).toBe('unknown')
      expect(s.parts).toEqual([])
      expect(s.facts.join('\n')).toMatch(/no universe rows fetched/)
    }
  })

  it('refuses to score with no BTC bar to measure against', () => {
    for (const btcRow of [null, undefined, {}, { symbol: 'BTC', chg7d: NaN, chg30d: null }]) {
      const s = seasonRead({ universe: makeUniverse({}), btcRow })
      expect(s.score).toBeNull()
      expect(s.phase).toBe('unknown')
      expect(s.facts.join('\n')).toMatch(/no BTC row in the universe/)
    }
  })

  it('takes no arguments at all without throwing', () => {
    expect(() => seasonRead()).not.toThrow()
    expect(seasonRead().score).toBeNull()
    expect(seasonRead({}).phase).toBe('unknown')
  })

  it('survives junk rows inside a good universe', () => {
    const universe = [null, undefined, 42, 'x', {}, ...makeUniverse({ nAlts: 10, beat7: 5, beat30: 5 })]
    const s = seasonRead({ universe, btcRow: BTC })
    expect(s.breadth.n7).toBe(10)
    expect(s.score).not.toBeNull()
  })

  it('survives a malformed fearGreed payload', () => {
    for (const fg of [{}, { value: 'abc' }, { value: null }, 'nope', 0]) {
      const s = seasonRead({ universe: makeUniverse({}), btcRow: BTC, fearGreed: fg })
      expect(s.fearGreed).toBeNull()
      expect(s.parts.find((p) => p.key === 'feargreed').points).toBe(5)
    }
  })

  it('derives a fear & greed label when the payload omits one', () => {
    const s = seasonRead({ universe: makeUniverse({}), btcRow: BTC, fearGreed: { value: 82 } })
    expect(s.fearGreed.label).toBe('Extreme Greed')
  })

  it('mentions what is trending without letting it move the score', () => {
    const args = { universe: makeUniverse({ beat7: 63, beat30: 48 }), btcRow: BTC }
    const quiet = seasonRead(args)
    const loud = seasonRead({ ...args, trending: [{ symbol: 'pepe' }, { symbol: 'wif' }, { symbol: 'bonk' }, { symbol: 'sol' }] })
    expect(loud.score).toBe(quiet.score)
    expect(loud.facts.join('\n')).toMatch(/trending right now: PEPE, WIF, BONK$/m)
  })
})

/* ── the voice ────────────────────────────────────────────────────────────── */

describe('facts carry the numbers', () => {
  it('states every read in plain English with its figures in it', () => {
    const s = seasonRead({
      universe: makeUniverse({ beat7: 63, beat30: 48 }), btcRow: BTC, ethRow: eth(12, 30),
      global: { btcDominancePct: 54.3 }, fearGreed: { value: '39', label: 'Fear' },
      domHistory: domHist(30, 56.1, 54.3), now: BASE + 29 * DAY,
    })
    const f = s.facts.join('\n')
    expect(f).toMatch(/63 of 100 top-100 alts beat BTC over 7d \(63%\)/)
    expect(f).toMatch(/BTC dominance 54\.3%/)
    expect(f).toMatch(/BTC dominance falling: -1\.80 points across 30 stored days — capital is leaving BTC/)
    expect(f).toMatch(/ETH\/BTC \+8\.7% over 7d \(ETH \+12\.0% vs BTC \+3\.0%\)/)
    expect(f).toMatch(/fear & greed 39 \(Fear\)/)
    // No bare adjectives — every fact that makes a claim carries a figure.
    for (const fact of s.facts) expect(fact).toMatch(/\d/)
  })

  it('gives every phase a sentence about what it means for taking alt risk today', () => {
    const seen = new Set()
    const cases = [
      { universe: makeUniverse({ beat7: 8, beat30: 5 }), btcRow: BTC, ethRow: eth(-10, -20), fearGreed: { value: 12 }, domHistory: domHist(30, 54, 57) },
      { universe: makeUniverse({ beat7: 35, beat30: 25 }), btcRow: BTC, ethRow: eth(-10, -20), fearGreed: { value: 60 }, domHistory: domHist(30, 54, 57) },
      { universe: makeUniverse({ beat7: 63, beat30: 48 }), btcRow: BTC },
      { universe: makeUniverse({ beat7: 60, beat30: 55 }), btcRow: BTC, ethRow: eth(12, 2), fearGreed: { value: 65 }, domHistory: domHist(30, 56, 54) },
      { universe: makeUniverse({ beat7: 78, beat30: 72 }), btcRow: BTC, ethRow: eth(12, 30), fearGreed: { value: 65 }, domHistory: domHist(30, 56, 54) },
      { universe: makeUniverse({ beat7: 90, beat30: 80 }), btcRow: BTC, ethRow: eth(12, 30), fearGreed: { value: 85 }, domHistory: domHist(30, 56, 54) },
      {},
    ]
    for (const args of cases) {
      const s = seasonRead(args)
      seen.add(s.phase)
      expect(s.label.length).toBeGreaterThan(3)
      expect(s.plain.length).toBeGreaterThan(30)
    }
    expect(seen).toEqual(new Set([
      'risk_off', 'btc_only', 'btc_leads', 'majors_rotating', 'alt_season', 'euphoric', 'unknown',
    ]))
  })
})
