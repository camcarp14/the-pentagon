// The crowd read has exactly two ways to lie, and both of them are quiet.
//
//   1. Scoring a MISSING input as a neutral middle. Most coins on this board
//      have no listed perp, so "no crowding data" is the common case, and a
//      neutral 50 for it would drag every small cap toward the middle of the
//      state ladder — where it stops being read at all.
//   2. Confusing "we looked and nobody is interested" with "we could not look".
//      Those produce the same `trendingRank: null` and the first one is the most
//      bullish attention reading on the page.
//
// Most of this file is those two, plus the arithmetic stated by hand so the
// ladders at the top of sentiment.js can be checked against the code.
import { describe, it, expect } from 'vitest'
import { crowdRead } from '../sentiment.js'

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const community = (over = {}) => ({
  sentimentUpPct: 82, redditSubs: 210_000, redditActive48h: 4300, redditPosts48h: 12,
  twitterFollowers: 400_000, telegram: 20_000, watchlistUsers: 60_000,
  ...over,
})

const DAY = 86_400
const NOW = Date.parse('2026-07-31T12:00:00Z')
const at = (daysAgo) => Math.floor(NOW / 1000) - daysAgo * DAY

/** Binance long/short series — only the newest sample is read. */
const ls = (longPct, t = at(0)) => [
  { t: at(2), ratio: 1, longPct: 50, shortPct: 50 },
  { t, ratio: longPct / (100 - longPct), longPct, shortPct: 100 - longPct },
]

const derivs = (over = {}) => ({
  symbol: 'TESTUSDT', priceMultiplier: 1,
  markPrice: 1, lastFundingRate: 0.0003, nextFundingTime: NOW + 3_600_000,
  openInterest: [
    { t: at(1), oi: 100, oiValueUsd: 100_000 },
    { t: at(0), oi: 112, oiValueUsd: 112_000 },
  ],
  globalLongShort: ls(62),
  topLongShort: ls(55),
  degraded: [],
  sourceDetail: 'binance futures TESTUSDT',
  ...over,
})

const screened = (over = {}) => ({
  symbol: 'TEST', band: 'basing', score: 40, chg24h: 1, chg7d: 2, rsVsBtc7d: 1, ...over,
})

const points = (r, key) => r.parts.find((p) => p.key === key)?.points

/* ── the arithmetic, by hand ──────────────────────────────────────────────── */

describe('the 100 points, verified by hand', () => {
  // trending #5      → ≤7            → 12 / 20
  // reddit 4300/210k = 2.05%         → 12 / 15
  // up-vote 82       → ≥75           →  8 / 10
  // watchlist 60,000 → ≥50k          →  6 / 10
  // funding 0.0003 × 1095 = 32.85%/yr → ≥25 → 12 / 20
  // OI 100 → 112 = +12%              → ≥10 →  8 / 10
  // retail 62 − top 55 = +7 pts      → ≥3  →  8 / 15
  //                            earned 66 of an available 100 → score 66 → hot
  it('sums the scored parts and divides by what it could measure', () => {
    const r = crowdRead({ trendingRank: 5, community: community(), derivs: derivs(), screened: screened(), now: NOW })
    expect(r.parts.map((p) => [p.key, p.points])).toEqual([
      ['trending', 12], ['reddit', 12], ['upvote', 8], ['watchlist', 6],
      ['funding', 12], ['oi', 8], ['divergence', 8],
    ])
    expect(r.measured).toEqual({ earned: 66, of: 100 })
    expect(r.score).toBe(66)
    expect(r.state).toBe('hot')
  })

  it('score is always round(100 × earned ÷ available), for every combination of missing halves', () => {
    const cases = [
      { trendingRank: 5, community: community(), derivs: derivs() },
      { trendingRank: 5, community: community() },
      { trendingRank: null, derivs: derivs() },
      { community: community(), derivs: derivs() },
      { trendingRank: 1, community: community({ redditSubs: null }), derivs: derivs({ openInterest: null }) },
    ]
    for (const c of cases) {
      const r = crowdRead({ ...c, screened: screened(), now: NOW })
      const scored = r.parts.filter((p) => p.points != null)
      const earned = scored.reduce((s, p) => s + p.points, 0)
      const of = scored.reduce((s, p) => s + p.max, 0)
      expect(r.measured).toEqual({ earned, of })
      expect(r.score).toBe(Math.round((100 * earned) / of))
      expect(r.score).toBeGreaterThanOrEqual(0)
      expect(r.score).toBeLessThanOrEqual(100)
    }
  })
})

/* ── the two silent lies ──────────────────────────────────────────────────── */

describe('a missing sub-read is never a neutral middle', () => {
  it('no listed perp ⇒ crowding null, three unscored parts, and a fact that says so', () => {
    const r = crowdRead({ trendingRank: 5, community: community(), derivs: null, screened: screened(), now: NOW })
    expect(r.crowding).toBeNull()
    for (const key of ['funding', 'oi', 'divergence']) {
      expect(points(r, key)).toBeNull()
      expect(r.parts.find((p) => p.key === key).label).toMatch(/no listed perp/)
    }
    // Scored out of 55, not out of 100 with 45 points of imaginary neutrality.
    expect(r.measured.of).toBe(55)
    expect(r.facts.join(' ')).toMatch(/no listed Binance perp/)
    expect(r.facts.join(' ')).toMatch(/none has been assumed/)
  })

  it('the same coin scores the same heat with and without a perp read', () => {
    // 38 of 55 on attention alone = 69. Adding a crowding half that happens to
    // score at the same rate must not move the state.
    const withPerp = crowdRead({ trendingRank: 5, community: community(), derivs: derivs(), screened: screened(), now: NOW })
    const without = crowdRead({ trendingRank: 5, community: community(), screened: screened(), now: NOW })
    expect(without.measured).toEqual({ earned: 38, of: 55 })
    expect(without.score).toBe(69)
    expect(without.state).toBe('hot')
    expect(withPerp.state).toBe('hot')
  })

  it('scores nothing at all rather than guessing, when there is nothing to score', () => {
    const r = crowdRead({})
    expect(r.score).toBeNull()
    expect(r.state).toBe('unknown')
    expect(r.contrarian).toBe('neutral')
    expect(r.attention).toBeNull()
    expect(r.crowding).toBeNull()
    expect(r.facts.join(' ')).toMatch(/unavailable, not neutral/)
  })
})

describe('"not trending" and "no trending list" are different answers', () => {
  const base = { community: community(), screened: screened(), now: NOW }

  it('an explicit null rank is a measurement worth zero points, and it counts in the denominator', () => {
    const r = crowdRead({ ...base, trendingRank: null })
    expect(points(r, 'trending')).toBe(0)
    expect(r.measured).toEqual({ earned: 26, of: 55 })   // 0 + 12 + 8 + 6
    expect(r.score).toBe(47)
    expect(r.facts.join(' ')).toMatch(/not on CoinGecko's trending list/)
  })

  it('an ABSENT key is no measurement, so it leaves the denominator alone', () => {
    const r = crowdRead(base)
    expect(points(r, 'trending')).toBeNull()
    expect(r.measured).toEqual({ earned: 26, of: 35 })   // the same 26, out of 35
    expect(r.score).toBe(74)
    expect(r.parts.find((p) => p.key === 'trending').label).toMatch(/unavailable/)
    expect(r.facts.join(' ')).toMatch(/did not answer/)
  })

  // The bug this pair exists to prevent: a rate-limited trending feed would
  // otherwise mark every coin on the board "nobody is searching for this".
  it('a failed trending feed does not read as proof the coin is ignored', () => {
    const ignored = crowdRead({ ...base, trendingRank: null })
    const unknown = crowdRead(base)
    expect(unknown.score).toBeGreaterThan(ignored.score)
  })

  it('undefined is treated as absent, not as a null rank', () => {
    const r = crowdRead({ ...base, trendingRank: undefined })
    expect(points(r, 'trending')).toBeNull()
  })
})

/* ── crowding: the readings that are actually predictive ──────────────────── */

describe('funding', () => {
  it('annualises at the 8h interval and says so', () => {
    // 0.05% per 8h × 3 × 365 = 54.75%/yr → the ≥50 rung
    const r = crowdRead({ derivs: derivs({ lastFundingRate: 0.0005 }), screened: screened(), now: NOW })
    expect(points(r, 'funding')).toBe(16)
    expect(r.crowding.fundingAnnualPct).toBeCloseTo(54.75, 6)
    expect(r.facts.join(' ')).toMatch(/per 8h/)
    expect(r.facts.join(' ')).toMatch(/longs are paying shorts/)
  })

  it('negative funding scores zero heat and names who is paying whom', () => {
    const r = crowdRead({ derivs: derivs({ lastFundingRate: -0.0002 }), screened: screened(), now: NOW })
    expect(points(r, 'funding')).toBe(0)
    expect(r.facts.join(' ')).toMatch(/SHORTS are paying longs/)
  })

  it('refuses to score a funding snapshot whose next payment is already stale', () => {
    const r = crowdRead({ derivs: derivs({ nextFundingTime: NOW - 30 * 3_600_000 }), screened: screened(), now: NOW })
    expect(points(r, 'funding')).toBeNull()
    expect(r.facts.join(' ')).toMatch(/funding snapshot for TESTUSDT is stale/)
  })
})

describe('open interest is read in contracts, not in dollars', () => {
  // The whole point: a coin up 30% on unchanged positioning shows +30% USD open
  // interest. In base units it shows 0, which is the truth — nobody new got on.
  it('a price-driven USD jump on flat contracts is not new leverage', () => {
    const r = crowdRead({
      derivs: derivs({
        openInterest: [
          { t: at(1), oi: 1_000_000, oiValueUsd: 1_000_000 },
          { t: at(0), oi: 1_000_000, oiValueUsd: 1_300_000 },
        ],
      }),
      screened: screened(), now: NOW,
    })
    expect(r.crowding.oiChange24hPct).toBe(0)
    expect(points(r, 'oi')).toBe(4)             // the ≥−3 "flat" rung
    expect(r.facts.join(' ')).toMatch(/open interest \+0\.0% in 24h in contract terms/)
  })

  it('a single sample is not a 24h change', () => {
    const r = crowdRead({ derivs: derivs({ openInterest: [{ t: at(0), oi: 100, oiValueUsd: 1 }] }), screened: screened(), now: NOW })
    expect(points(r, 'oi')).toBeNull()
    expect(r.parts.find((p) => p.key === 'oi').label).toMatch(/only one open-interest sample/)
  })

  it('drops a stale series rather than relabelling old data as a 24h change', () => {
    const r = crowdRead({
      derivs: derivs({ openInterest: [{ t: at(9), oi: 100, oiValueUsd: 1 }, { t: at(8), oi: 130, oiValueUsd: 1 }] }),
      screened: screened(), now: NOW,
    })
    expect(points(r, 'oi')).toBeNull()
    expect(r.facts.join(' ')).toMatch(/too old to call a 24h change/)
  })
})

describe('retail vs top traders — the divergence is the signal', () => {
  it('scores the gap, not either side, and names both numbers', () => {
    const r = crowdRead({
      derivs: derivs({ globalLongShort: ls(71), topLongShort: ls(46) }),
      screened: screened(), now: NOW,
    })
    expect(r.crowding.retailLongPct).toBe(71)
    expect(r.crowding.topLongPct).toBe(46)
    expect(r.crowding.divergencePts).toBe(25)
    expect(points(r, 'divergence')).toBe(15)
    expect(r.facts.join(' ')).toMatch(/retail is 71% long while top traders are 46% long/)
    expect(r.facts.join(' ')).toMatch(/the crowd is on the wrong side/)
  })

  it('reads the other way round as the big accounts leaning in', () => {
    const r = crowdRead({
      derivs: derivs({ globalLongShort: ls(44), topLongShort: ls(66) }),
      screened: screened(), now: NOW,
    })
    expect(r.crowding.divergencePts).toBe(-22)
    expect(points(r, 'divergence')).toBe(0)
    expect(r.facts.join(' ')).toMatch(/MORE long than the crowd/)
  })

  it('half a pair is a fact, never a divergence', () => {
    const r = crowdRead({ derivs: derivs({ topLongShort: null }), screened: screened(), now: NOW })
    expect(points(r, 'divergence')).toBeNull()
    expect(r.crowding.divergencePts).toBeNull()
    expect(r.facts.join(' ')).toMatch(/no top-trader position ratio|top-trader series did not answer/)
  })
})

/* ── the contrarian call ──────────────────────────────────────────────────── */

describe('contrarian', () => {
  it('two extremes are a headwind on their own', () => {
    const r = crowdRead({
      trendingRank: 4,
      derivs: derivs({ lastFundingRate: 0.001, globalLongShort: ls(78), topLongShort: ls(50) }),
      community: community(), screened: screened({ band: 'running' }), now: NOW,
    })
    expect(r.crowding.fundingAnnualPct).toBeCloseTo(109.5, 6)
    expect(r.extremes.length).toBeGreaterThanOrEqual(2)
    expect(r.contrarian).toBe('headwind')
    expect(r.facts.join(' ')).toMatch(/buying their exit liquidity/)
  })

  it('one extreme on a cold coin is a curiosity, not a headwind', () => {
    // Funding spike, nothing else on: no community, not trending, low heat.
    const r = crowdRead({
      trendingRank: null,
      derivs: derivs({ lastFundingRate: 0.001, globalLongShort: ls(50), topLongShort: ls(50), openInterest: null }),
      screened: screened({ band: 'dead', chg7d: -2 }), now: NOW,
    })
    expect(r.extremes).toHaveLength(1)
    expect(r.score).toBeLessThan(62)
    expect(r.contrarian).not.toBe('headwind')
  })

  it('is a tailwind when the chart is moving and the crowd has not arrived', () => {
    const r = crowdRead({
      trendingRank: null,
      community: community({ sentimentUpPct: 30, redditSubs: 4000, redditActive48h: 4, watchlistUsers: 900 }),
      derivs: null,
      screened: screened({ band: 'waking', rsVsBtc7d: 6 }), now: NOW,
    })
    expect(r.score).toBeLessThanOrEqual(35)
    expect(r.attention.max).toBe(55)     // all four attention gauges answered
    expect(r.contrarian).toBe('tailwind')
    expect(r.facts.join(' ')).toMatch(/price is moving before the attention is/)
  })

  // THE MEASUREMENT FLOOR. "Nobody has noticed yet, which is the only order that
  // pays" is risk-INCREASING copy — it is quoted verbatim into the directive's
  // STALK and ENTER reasons — and it is a claim about absence. A coin whose only
  // measurable input is `trendingRank: null` scores 0 out of 20 and reads as the
  // most ignored asset on the board, when all that was established is that it is
  // not one of seven coins on a search list, which is true of almost every coin.
  it('will not call a tailwind off a score that rests on one attention gauge', () => {
    const r = crowdRead({ trendingRank: null, screened: screened({ band: 'basing' }), now: NOW })
    expect(r.score).toBe(0)
    expect(r.measured).toEqual({ earned: 0, of: 20 })
    expect(r.attention.max).toBe(20)
    expect(r.contrarian).toBe('neutral')
    expect(r.facts.join(' ')).not.toMatch(/TAILWIND/)
    expect(r.facts.join(' ')).toMatch(/rests on 20 of the 35 attention points this call needs/)
    expect(r.facts.join(' ')).toMatch(/"we barely looked", not "nobody is looking"/)
  })

  it('calls it the moment enough of the attention block has actually answered', () => {
    // The same cold coin, plus a subreddit we could measure: 35 attention points.
    const r = crowdRead({
      trendingRank: null,
      community: { redditSubs: 40_000, redditActive48h: 30 },
      screened: screened({ band: 'basing' }), now: NOW,
    })
    expect(r.attention.max).toBe(35)
    expect(r.contrarian).toBe('tailwind')
    expect(r.facts.join(' ')).toMatch(/measured across 35 points of attention/)
  })

  // The floor is on the tailwind rung only. A headwind fires on an extreme we
  // DID measure, and suppressing a measured warning for want of other data would
  // be the same failure pointing the other way.
  it('does not put a floor on the headwind rungs', () => {
    const r = crowdRead({ trendingRank: 1, screened: screened({ band: 'running' }), now: NOW })
    expect(r.measured).toEqual({ earned: 20, of: 20 })
    expect(r.contrarian).toBe('headwind')
  })

  it('is a tailwind when shorts pay longs into a flat chart', () => {
    const r = crowdRead({
      trendingRank: 6,
      community: community(),
      derivs: derivs({ lastFundingRate: -0.0004, globalLongShort: ls(50), topLongShort: ls(50) }),
      screened: screened({ band: 'basing' }), now: NOW,
    })
    expect(r.contrarian).toBe('tailwind')
    expect(r.facts.join(' ')).toMatch(/shorts are paying/)
  })

  it('has no opinion when there is no data to have one from', () => {
    expect(crowdRead({ screened: screened() }).contrarian).toBe('neutral')
  })
})

/* ── state ────────────────────────────────────────────────────────────────── */

describe('state', () => {
  // The property season.js and window.js are both built on: a label that can
  // disagree with its own number is a label nobody trusts twice.
  it('never gives two different states to the same score, outside the one overlay', () => {
    const seen = new Map()
    for (const trendingRank of [null, 1, 2, 5, 12, 40]) {
      for (const sentimentUpPct of [10, 55, 82, 95]) {
        for (const lastFundingRate of [-0.0002, 0, 0.0003, 0.001]) {
          for (const longPct of [40, 55, 71]) {
            const r = crowdRead({
              trendingRank, community: community({ sentimentUpPct }),
              derivs: derivs({ lastFundingRate, globalLongShort: ls(longPct) }),
              screened: screened(), now: NOW,
            })
            if (r.score == null || r.state === 'capitulating') continue
            if (seen.has(r.score)) expect(r.state).toBe(seen.get(r.score))
            else seen.set(r.score, r.state)
          }
        }
      }
    }
    expect(seen.size).toBeGreaterThan(5)
  })

  it('runs the whole ladder from ignored to euphoric on real inputs', () => {
    expect(crowdRead({ trendingRank: null, screened: screened(), now: NOW }).state).toBe('ignored')
    expect(crowdRead({ trendingRank: 1, screened: screened(), now: NOW }).state).toBe('euphoric')
  })

  it('calls a cold, bleeding coin with negative funding capitulating, not merely ignored', () => {
    const r = crowdRead({
      trendingRank: null,
      derivs: derivs({ lastFundingRate: -0.0006, globalLongShort: ls(40), topLongShort: ls(52), openInterest: null }),
      screened: screened({ band: 'dead', chg7d: -34 }), now: NOW,
    })
    expect(r.state).toBe('capitulating')
    expect(r.facts.join(' ')).toMatch(/where bases start and also where knives land/)
  })

  it('uses extreme fear as the other capitulation trigger, and never as points', () => {
    const r = crowdRead({
      trendingRank: null, fearGreed: { value: '11', label: 'Extreme Fear' },
      screened: screened({ band: 'dead', chg7d: -22 }), now: NOW,
    })
    expect(r.state).toBe('capitulating')
    // Fear & greed is market-wide and season.js already scores it — it must not
    // appear as a scored part here or the same reading moves two numbers.
    expect(r.parts.some((p) => p.key === 'feargreed')).toBe(false)
    expect(r.facts.join(' ')).toMatch(/fear & greed is 11/)
  })
})

/* ── attention detail ─────────────────────────────────────────────────────── */

describe('attention', () => {
  it('reads reddit as a RATIO of its own subscriber base', () => {
    const big = crowdRead({ community: community({ redditSubs: 3_000_000, redditActive48h: 4300 }), screened: screened() })
    const small = crowdRead({ community: community({ redditSubs: 21_000, redditActive48h: 4300 }), screened: screened() })
    // Identical raw counts, opposite readings — which is the entire point.
    expect(points(big, 'reddit')).toBeLessThan(points(small, 'reddit'))
    expect(small.attention.redditActivePct).toBeCloseTo(20.48, 2)
  })

  it('refuses to measure activity against a subreddit too small to be a base', () => {
    const r = crowdRead({ community: community({ redditSubs: 40, redditActive48h: 8 }), screened: screened() })
    expect(points(r, 'reddit')).toBeNull()
    expect(r.parts.find((p) => p.key === 'reddit').label).toMatch(/too small to measure \(40 subscribers\)/)
  })

  it('labels the up-vote poll as a poll and the watchlist count as a rule of thumb', () => {
    const r = crowdRead({ community: community(), screened: screened() })
    expect(r.facts.join(' ')).toMatch(/self-selected poll, not a measurement of flow/)
    expect(r.facts.join(' ')).toMatch(/rule of thumb, not a rate/)
  })

  it('reports a level even when only part of the attention block resolved', () => {
    const r = crowdRead({ trendingRank: 1, community: null, screened: screened() })
    expect(r.attention.level).toBe('extreme')
    expect(r.attention.points).toBe(20)
    expect(r.attention.max).toBe(20)
  })
})

/* ── degrade, don't crash ─────────────────────────────────────────────────── */

describe('every shape of garbage is a normal input', () => {
  const junk = [undefined, null, 0, '', NaN, Infinity, -1, {}, [], 'x', true, { value: null }]

  it('never throws', () => {
    for (const j of junk) {
      expect(() => crowdRead(j)).not.toThrow()
      expect(() => crowdRead({ fearGreed: j, community: j, derivs: j, screened: j, trendingRank: j, now: j })).not.toThrow()
    }
  })

  it('survives a derivs object with every series malformed', () => {
    const r = crowdRead({
      derivs: { symbol: 'XUSDT', lastFundingRate: null, openInterest: 'nope', globalLongShort: {}, topLongShort: [{}] },
      screened: screened(), now: NOW,
    })
    expect(r.crowding).toBeNull()
    expect(r.parts.filter((p) => p.points != null)).toHaveLength(0)
    expect(r.score).toBeNull()
  })

  it('coerces the fear & greed string without reading a null as Extreme Fear', () => {
    // Number(null) is 0, which is the loudest reading on the dial. season.js
    // documents the same trap; this file must not reintroduce it.
    const nulled = crowdRead({ trendingRank: 3, fearGreed: { value: null }, screened: screened({ chg7d: -40 }), now: NOW })
    expect(nulled.state).not.toBe('capitulating')
    expect(nulled.facts.join(' ')).not.toMatch(/fear & greed is 0/)
  })

  it('surfaces a partially degraded derivatives feed as a fact', () => {
    const r = crowdRead({ derivs: derivs({ degraded: ['open interest: 429'] }), screened: screened(), now: NOW })
    expect(r.facts.join(' ')).toMatch(/did not answer: open interest: 429/)
  })

  it('works with no `now`, just without the staleness checks', () => {
    const r = crowdRead({ trendingRank: 5, community: community(), derivs: derivs() })
    expect(r.score).toBe(66)
  })
})
