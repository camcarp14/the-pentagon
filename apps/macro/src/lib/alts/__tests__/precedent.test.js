// The precedent engine is tested against series whose answer is known because
// the test BUILT the answer: a quiet base, a coil that tightens into it, one
// ignition bar, a twenty-day markup, a decay, repeat. Every episode index in
// this file was planted, so "findEpisodes returned 4" is a real assertion and
// not a snapshot of whatever the code happened to do.
//
// The three things that separate an honest base rate from an impressive-looking
// one each get their own block: the day-before-liftoff fingerprint, the gap rule
// (without which one run is counted ten times), and the refusals.
import { describe, it, expect } from 'vitest'
import { findEpisodes, fingerprint, precedentRead } from '../precedent.js'

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/** Deterministic noise. A seeded LCG rather than Math.random, so a failure here
 *  is reproducible and "it passes most of the time" is not a possible state. */
function rng(seed) {
  let s = (seed >>> 0) || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const DAY = 86_400
const T0 = Date.UTC(2023, 0, 1) / 1000

/**
 * A daily OHLCV series with planted ignitions.
 *
 * Per ignition at index `at`:
 *   [at−40, at−1]  a coil — a drift that starts at −0.38%/day and tapers to
 *                  flat, on a fifth of the base's noise, with the volume
 *                  baseline ramping 1.0× → 1.9×. The drift is what makes the
 *                  answer knowable: inside the coil no close can exceed its own
 *                  prior 20-bar high, so no bar in the run-up can steal the
 *                  ignition index from the bar we planted. The TAPER is what
 *                  makes it a coil rather than a slide — a constant downward
 *                  drift widens Bollinger bandwidth (a trend has a standard
 *                  deviation), so the fixture would have compressed ATR and
 *                  expanded bands, which is exactly the combination the
 *                  compression read is built to reject.
 *   at             +10% — clears the prior 20-bar high by a wide margin.
 *   [at+1, at+20]  +4.5%/day → +141% from the ignition close, peak at at+20.
 *   [at+21, at+50] −2.2%/day back down, so the next base sits well under the
 *                  markup highs and no decay bar can register as a new break.
 *
 * `pendingAt` plants a coil with no ignition after it — a coin sitting in the
 * setup today, which is what the match score is supposed to recognise.
 */
function buildSeries({ n = 780, ignitions = [150, 330, 510, 690], pendingAt = null, seed = 11, start = 100 } = {}) {
  const rand = rng(seed)
  const marks = pendingAt == null ? ignitions : [...ignitions, pendingAt]
  const bars = []
  let close = start
  for (let i = 0; i < n; i++) {
    let ret = (rand() - 0.5) * 0.012 // base: ±0.6% a day
    let volMult = 1
    for (const at of marks) {
      if (i >= at - 40 && i <= at - 1) {
        const p = (i - (at - 40)) / 39
        ret = -0.0038 * (1 - p) + (rand() - 0.5) * 0.0024
        volMult = 1 + 0.9 * p
      } else if (i === at) {
        ret = 0.10
        volMult = 5
      } else if (i > at && i <= at + 20) {
        ret = 0.045 + (rand() - 0.5) * 0.004
        volMult = 3.5
      } else if (i > at + 20 && i <= at + 50) {
        ret = -0.022 + (rand() - 0.5) * 0.004
        volMult = 2
      }
    }
    const o = close
    close = o * (1 + ret)
    const wick = 0.0015 + Math.abs(ret) * 0.3 + rand() * 0.001
    bars.push({
      t: T0 + i * DAY,
      o,
      h: Math.max(o, close) * (1 + wick),
      l: Math.min(o, close) * (1 - wick),
      c: close,
      v: Math.round(1e6 * volMult * (0.85 + rand() * 0.3)),
    })
  }
  return bars
}

/** What CoinGecko's market_chart gives us: a price line wearing candle clothes. */
function buildCloseOnly({ n = 780, seed = 3 } = {}) {
  const rand = rng(seed)
  let c = 100
  return Array.from({ length: n }, (_, i) => {
    c *= 1 + (rand() - 0.5) * 0.05
    return { t: T0 + i * DAY, o: c, h: c, l: c, c, v: Math.round(1e6 * (0.5 + rand())) }
  })
}

const FOUR = buildSeries()                                                            // ignitions at 150, 330, 510, 690
// PENDING and MIDRUN are the same length with the same three episodes behind
// them, so the only thing that differs between their match scores is what today
// looks like. Anything else and the comparison would be measuring the fixture.
const PENDING = buildSeries({ n: 700, ignitions: [150, 330, 510], pendingAt: 700 })   // coiling today
const MIDRUN = buildSeries({ n: 700, ignitions: [150, 330, 510, 680] })               // 19 days into a run today
const ONE = buildSeries({ n: 500, ignitions: [200] })                                 // 1 episode

/* ── the episodes are the ones we planted ─────────────────────────────────── */

describe('findEpisodes', () => {
  it('finds exactly the ignitions the fixture planted', () => {
    const eps = findEpisodes(FOUR)
    expect(eps.map((e) => e.igniteIdx)).toEqual([150, 330, 510, 690])
    expect(eps.map((e) => e.daysToPeak)).toEqual([20, 20, 20, 20])
    for (const e of eps) {
      expect(e.runPct).toBeGreaterThan(130)
      expect(e.runPct).toBeLessThan(155)
      expect(e.igniteDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(e.peakIdx - e.igniteIdx).toBe(e.daysToPeak)
    }
  })

  it('measures every forward return from the ignition CLOSE', () => {
    const eps = findEpisodes(FOUR)
    for (const e of eps) {
      const base = FOUR[e.igniteIdx].c
      expect(e.fwd7).toBeCloseTo((FOUR[e.igniteIdx + 7].c / base - 1) * 100, 6)
      expect(e.fwd21).toBeCloseTo((FOUR[e.igniteIdx + 21].c / base - 1) * 100, 6)
      expect(e.fwd60).toBeCloseTo((FOUR[e.igniteIdx + 60].c / base - 1) * 100, 6)
    }
    // 1.045^7 ≈ +36% by construction — the check that the index is the ignition
    // bar and not the bar before it, which would read ~10% higher.
    expect(eps[0].fwd7).toBeGreaterThan(30)
    expect(eps[0].fwd7).toBeLessThan(43)
  })

  it('leaves the forward windows null rather than short-changing them', () => {
    // An ignition 40 bars from the end has a real fwd21 and no fwd60. Reporting
    // 0 there would count a coin we cannot see yet as a flat outcome.
    const late = buildSeries({ n: 620, ignitions: [150, 330, 570] })
    const eps = findEpisodes(late)
    const lastEp = eps[eps.length - 1]
    expect(lastEp.igniteIdx).toBe(570)
    expect(lastEp.fwd21).not.toBeNull()
    expect(lastEp.fwd60).toBeNull()
  })

  it('cannot find an episode in the last `window` bars, because the outcome is not known yet', () => {
    const eps = findEpisodes(MIDRUN)
    expect(eps.map((e) => e.igniteIdx)).toEqual([150, 330, 510])
    expect(eps.some((e) => e.igniteIdx === 760)).toBe(false)
  })

  it('measures the drawdown high-to-low over the same window as the run', () => {
    for (const e of findEpisodes(FOUR)) {
      expect(e.maxDrawdownDuringPct).toBeGreaterThan(0)
      expect(e.maxDrawdownDuringPct).toBeLessThan(100)
    }
  })

  it('degrades on short, empty and garbage input without throwing', () => {
    for (const bad of [null, undefined, [], 'nope', 42, [{}, {}], [{ c: NaN }], new Array(60).fill({ c: 1, h: 1, l: 1 })]) {
      expect(() => findEpisodes(bad)).not.toThrow()
      expect(findEpisodes(bad)).toEqual([])
    }
  })
})

/* ── the gap rule: one run is one episode ─────────────────────────────────── */

describe('minGapBars — without it a base rate is fiction', () => {
  it('counts one run once at the default gap and ten times without it', () => {
    const proper = findEpisodes(FOUR)
    const naive = findEpisodes(FOUR, { minGapBars: 1 })
    expect(proper).toHaveLength(4)
    // Every bar in the first half of each markup also closes above its own prior
    // 20-day high with 60% of the run still ahead of it. That is the bug: four
    // moves reported as a sample of forty.
    expect(naive.length).toBeGreaterThan(30)
    expect(naive.filter((e) => e.igniteIdx >= 150 && e.igniteIdx <= 170).length).toBeGreaterThan(5)
  })

  it('keeps every reported episode at least minGapBars apart', () => {
    for (const gap of [45, 60, 90, 200]) {
      const eps = findEpisodes(FOUR, { minGapBars: gap })
      for (let i = 1; i < eps.length; i++) {
        expect(eps[i].igniteIdx - eps[i - 1].igniteIdx).toBeGreaterThanOrEqual(gap)
      }
    }
  })

  it('produces base rates that disagree, which is the whole point of the rule', () => {
    const honest = precedentRead(FOUR, { quality: 'ohlcv' })
    const fiction = precedentRead(FOUR, { quality: 'ohlcv', minGapBars: 1 })
    expect(honest.episodes).toBe(4)
    expect(fiction.episodes).toBeGreaterThan(30)
    // The inflated sample is dominated by bars taken mid-markup, whose forward
    // 21 days land in the decay — so the same four moves produce a different,
    // and much more confident-looking, set of numbers.
    expect(fiction.baseRates.medianFwd21).not.toBeCloseTo(honest.baseRates.medianFwd21, 1)
  })
})

/* ── the fingerprint is the day BEFORE liftoff ────────────────────────────── */

describe('fingerprint', () => {
  it('is taken at igniteIdx − 1, not on the ignition bar', () => {
    const eps = findEpisodes(FOUR)
    for (const e of eps) {
      expect(e.pre.idx).toBe(e.igniteIdx - 1)
      expect(e.pre.date).toBe(fingerprint(FOUR, e.igniteIdx - 1).date)
    }
  })

  it('describes a coil, not a liftoff — which is the difference that makes it usable', () => {
    const e = findEpisodes(FOUR)[1] // ignition at 330
    const dayBefore = e.pre
    const igniteDay = fingerprint(FOUR, e.igniteIdx)

    // The ignition bar is +10% on 5× volume. Fingerprinting THAT and calling it
    // the setup would mean today can only ever match once the move has started.
    expect(igniteDay.volRatio20).toBeGreaterThan(2)
    expect(dayBefore.volRatio20).toBeLessThan(2)
    expect(igniteDay.distEma20Pct).toBeGreaterThan(dayBefore.distEma20Pct + 5)

    // ...and the day before is genuinely compressed against its own history.
    expect(dayBefore.ok).toBe(true)
    expect(dayBefore.atrPctile).toBeLessThan(20)
    expect(dayBefore.bandwidthPctile).toBeLessThan(30)
    expect(dayBefore.volTrend).toBeGreaterThan(1) // volume baseline rising under a flat price
  })

  it('returns the full shape with ok:false rather than throwing on bad input', () => {
    for (const [c, i] of [[null, 0], [[], 0], [FOUR, -1], [FOUR, 99999], [FOUR, 1.5], [FOUR, null]]) {
      const fp = fingerprint(c, i)
      expect(fp.ok).toBe(false)
      expect(fp.atrPct).toBeNull()
      expect(Object.keys(fp)).toContain('bandwidthPctile')
    }
  })

  it('leaves the percentiles null instead of ranking a value against ten readings', () => {
    const fp = fingerprint(FOUR, 40)
    expect(fp.atrPctile).toBeNull()      // fewer than 60 seeded ATR readings behind it
    expect(fp.atrPct).not.toBeNull()     // ...but the raw reading is still real
  })

  it('has no EMA200 before bar 200, and does not let that disqualify the day', () => {
    const early = fingerprint(FOUR, 149)
    expect(early.distEma200Pct).toBeNull()
    expect(early.ok).toBe(true) // requiring EMA200 would delete a quarter of the sample
    expect(fingerprint(FOUR, 329).distEma200Pct).not.toBeNull()
  })
})

/* ── refusals: the honest answers ─────────────────────────────────────────── */

describe('precedentRead refuses rather than guessing', () => {
  it('refuses under 250 candles and says how many it has', () => {
    const r = precedentRead(FOUR.slice(0, 200), { quality: 'ohlcv' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/need 250 daily candles/)
    expect(r.reason).toMatch(/have 200/)
    expect(r.baseRates).toBeNull()
    expect(r.matchPct).toBeNull()
    expect(r.matched).toEqual([])
    expect(r.facts[0]).toBe(r.reason)
  })

  it('refuses close-only candles, because ATR and bandwidth are meaningless on flat bars', () => {
    const r = precedentRead(buildCloseOnly(), { quality: 'close-only' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/close-only/)
    expect(r.reason).toMatch(/ATR, Bollinger bandwidth and volume/)
    expect(r.baseRates).toBeNull()
  })

  it('refuses flat bars even when nobody labelled them close-only', () => {
    // The caller forgetting to pass `quality` must not produce a precisely
    // computed, entirely meaningless zero-volatility fingerprint.
    const r = precedentRead(buildCloseOnly(), {})
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/no high\/low range/)
  })

  it('refuses under 3 episodes and names the count', () => {
    const r = precedentRead(ONE, { quality: 'ohlcv' })
    expect(r.ok).toBe(false)
    expect(r.episodes).toBe(1)
    expect(r.reason).toMatch(/only 1 prior ignition\b/)
    expect(r.reason).toMatch(/3 are needed/)
    expect(r.reason).toMatch(/not evidence/)
  })

  it('accepts exactly 3 — the floor is a floor, not a preference', () => {
    const r = precedentRead(PENDING, { quality: 'ohlcv' })
    expect(r.ok).toBe(true)
    expect(r.episodes).toBe(3)
  })

  it('still hands back today\'s fingerprint when it refuses, so the rest of the tab works', () => {
    const r = precedentRead(ONE, { quality: 'ohlcv' })
    expect(r.today.ok).toBe(true)
    expect(r.today.atrPct).toBeGreaterThan(0)
  })

  it('never throws on garbage', () => {
    for (const bad of [null, undefined, [], 'nope', 42, [{ nope: 1 }], new Array(300).fill({})]) {
      expect(() => precedentRead(bad, {})).not.toThrow()
      expect(precedentRead(bad, {}).ok).toBe(false)
    }
  })
})

/* ── base rates, with the worst case attached ─────────────────────────────── */

describe('base rates', () => {
  const read = precedentRead(FOUR, { quality: 'ohlcv' })

  it('reports the median, the worst case and the drawdown together', () => {
    const b = read.baseRates
    expect(read.ok).toBe(true)
    expect(b.medianFwd21).toBeGreaterThan(0)
    expect(b.worstFwd21).toBeLessThanOrEqual(b.medianFwd21)
    expect(b.medianMaxDDPct).toBeGreaterThan(0)
    expect(b.hitRate21).toBeGreaterThanOrEqual(0)
    expect(b.hitRate21).toBeLessThanOrEqual(100)
    expect(b.bestRunPct).toBeGreaterThanOrEqual(read.matched[0].runPct - 0.05)
  })

  it('gives every forward window its own denominator', () => {
    const late = precedentRead(buildSeries({ n: 620, ignitions: [150, 330, 570] }), { quality: 'ohlcv' })
    expect(late.baseRates.nFwd21).toBe(3)
    expect(late.baseRates.nFwd60).toBe(2) // the newest episode has no 60 days behind it
    expect(late.baseRates.medianFwd60).not.toBeNull()
  })

  it('puts the worst case in the same sentence as the median, in the facts', () => {
    const f = read.facts.join('\n')
    expect(f).toMatch(/21 days after those ignitions: median \+[\d.]+%, worst [+-][\d.]+%/)
    expect(f).toMatch(/% of them higher than the ignition close/)
    expect(f).toMatch(/median return is not the experience of holding it/)
  })

  it('says out loud that the 7- and 21-day numbers are conditioned on the selection', () => {
    // Without this line "median +136% in 21 days" reads as a forecast, and
    // nothing else on the screen would correct it.
    expect(read.facts.join('\n')).toMatch(/SELECTED for gaining 60%\+ within 30 days/)
    expect(read.facts.join('\n')).toMatch(/not the odds of getting one/)
  })

  it('returns every episode in `matched`, not the flattering ones', () => {
    expect(read.matched).toHaveLength(read.episodes)
    for (let i = 1; i < read.matched.length; i++) {
      expect(read.matched[i - 1].similarity).toBeGreaterThanOrEqual(read.matched[i].similarity)
    }
    for (const m of read.matched) {
      expect(m.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(m.maxDrawdownDuringPct).toBeGreaterThan(0) // the drawdown column is not optional
      expect(m.fwd21).not.toBeNull()
    }
  })
})

/* ── the match ────────────────────────────────────────────────────────────── */

describe('matchPct', () => {
  it('scores a coin sitting in the setup higher than one already 19 days into a run', () => {
    const coiling = precedentRead(PENDING, { quality: 'ohlcv' })
    const running = precedentRead(MIDRUN, { quality: 'ohlcv' })
    expect(coiling.episodes).toBe(3)
    expect(running.episodes).toBe(3)
    expect(coiling.matchPct).toBeGreaterThan(running.matchPct)
    expect(coiling.matchPct).toBeGreaterThan(30)
    // A coin nineteen days into a markup does not look like the day before
    // liftoff, and the metric has to be able to say so. If this number were
    // also 40 the match would be measuring nothing.
    expect(running.matchPct).toBeLessThan(15)
  })

  it('stays inside 0-100 and says it is not a probability', () => {
    for (const r of [precedentRead(PENDING, { quality: 'ohlcv' }), precedentRead(MIDRUN, { quality: 'ohlcv' }), precedentRead(FOUR, { quality: 'ohlcv' })]) {
      expect(r.matchPct).toBeGreaterThanOrEqual(0)
      expect(r.matchPct).toBeLessThanOrEqual(100)
      expect(r.facts.join('\n')).toMatch(/similarity score, not a probability/)
      expect(r.facts.join('\n')).toMatch(/standard deviations/)
    }
  })

  // The distance in the fact used to be stashed on a shared object by the same
  // function that computed the percentage, and the per-episode loop ran after
  // it — so the fact quoted whichever episode had been scored last. It looked
  // exactly like the right number and described something else.
  it('quotes the distance that produced matchPct, not the last episode scored', () => {
    const r = precedentRead(PENDING, { quality: 'ohlcv' })
    const d = Number(r.facts.join('\n').match(/RMS distance ([\d.]+) standard deviations/)[1])
    // matchPct = round(100 × (1 − D/3)); invert it and the two must agree.
    expect(Math.round(100 * (1 - d / 3))).toBe(r.matchPct)
  })

  it('builds an archetype that is a composite of the pre-ignition days', () => {
    const r = precedentRead(FOUR, { quality: 'ohlcv' })
    expect(r.archetype.ok).toBe(true)
    expect(r.archetype.date).toBeNull() // it is not any real day, and does not pretend to be
    expect(r.archetype.atrPctile).toBeLessThan(20)
    expect(r.archetype.volTrend).toBeGreaterThan(1)
  })
})

/* ── facts carry the numbers, in the voice of signals.js ──────────────────── */

describe('facts', () => {
  const f = precedentRead(FOUR, { quality: 'ohlcv', now: (T0 + 779 * DAY) * 1000 }).facts.join('\n')

  it('states how the episodes were counted, with every parameter in it', () => {
    expect(f).toMatch(/4 prior ignitions in 780 days of candles/)
    expect(f).toMatch(/close above the prior 20-day high that went on to gain 60%\+ within 30 days/)
    expect(f).toMatch(/no closer together than 45 days/)
  })

  it('reports today and the archetype with the actual readings', () => {
    expect(f).toMatch(/today: ATR [\d.]+% of price \(\d+(st|nd|rd|th) percentile of the last 180 days\)/)
    // "1th percentile" makes the whole line look generated. 11th/12th/13th are
    // correct English and are deliberately absent from this list.
    expect(f).not.toMatch(/\b(1|2|3|21|22|23|31|32|33)th\b/)
    expect(f).toMatch(/today: volume [\d.]+× its own 20-day average/)
    expect(f).toMatch(/the archetype \(median of the days before each ignition\)/)
  })

  it('flags stale tape when `now` is far past the last candle', () => {
    const stale = precedentRead(FOUR, { quality: 'ohlcv', now: (T0 + 790 * DAY) * 1000 })
    expect(stale.facts.join('\n')).toMatch(/newest candle is 11 days old/)
  })

  it('does not need `now`, and says nothing about staleness without it', () => {
    expect(precedentRead(FOUR, { quality: 'ohlcv' }).facts.join('\n')).not.toMatch(/days old/)
  })
})

/* ── holes in the feed ────────────────────────────────────────────────────── */

describe('a feed with holes', () => {
  it('drops bars with no close instead of letting one NaN void the file', () => {
    // ta.js's sma carries a running sum: a single NaN close turns every average
    // after it into NaN, so one bad bar would silently null out the back half of
    // every percentile in the fingerprint.
    const holed = FOUR.map((b, i) => (i === 300 || i === 301 ? { ...b, c: NaN } : b))
    const r = precedentRead(holed, { quality: 'ohlcv' })
    expect(r.ok).toBe(true)
    expect(r.today.atrPct).not.toBeNull()
    expect(r.facts.join('\n')).toMatch(/2 candles arrived without a close and were dropped/)
  })
})
