// The playbook is the file that carries opinions instead of arithmetic, so most
// of this suite is about keeping the opinions honest: every signal in
// EARLY_SIGNALS is actually measured, the late ones are labelled late and the
// copy never implies an attention spike is an entry, missing inputs come back as
// null rather than as a failed signal, and there is not one invented statistic
// anywhere in the exported prose.
//
// The two late derivative rows are tested against a REAL crowdRead rather than
// against a stub, because the property under test is that the two reads agree:
// the checklist and the crowd card sit on the same page, and they used to
// disagree about whether the same open-interest number was measurable at all.
import { describe, it, expect } from 'vitest'
import { PHASES, EARLY_SIGNALS, signalChecklist, phaseOf } from '../playbook.js'
import { crowdRead } from '../sentiment.js'

/* ── fixtures ─────────────────────────────────────────────────────────────── */

function rng(seed) {
  let s = (seed >>> 0) || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const DAY = 86_400
const T0 = Date.UTC(2023, 0, 1) / 1000

/** Turn a list of daily returns into candles. Everything below is built by
 *  composing return segments, so each fixture states its own shape in one line. */
function candlesFrom(rets, { start = 100, seed = 5, vol = () => 1e6 } = {}) {
  const rand = rng(seed)
  let close = start
  return rets.map((ret, i) => {
    const o = close
    close = o * (1 + ret)
    const wick = 0.0015 + Math.abs(ret) * 0.3 + rand() * 0.001
    return {
      t: T0 + i * DAY,
      o,
      h: Math.max(o, close) * (1 + wick),
      l: Math.min(o, close) * (1 - wick),
      c: close,
      v: Math.round(vol(i) * (0.85 + rand() * 0.3)),
    }
  })
}

const seg = (n, fn) => Array.from({ length: n }, (_, i) => fn(i, n))
const noise = (rand, amp) => (rand() - 0.5) * amp

// A 260-bar base then a 40-bar coil: the drift tapers to flat and the volume
// baseline ramps, which is compression AND accumulation at the same time —
// the two earliest signals on the list, by construction.
const COILING = (() => {
  const r = rng(21)
  const rets = [...seg(260, () => noise(r, 0.012)), ...seg(40, (i) => -0.0038 * (1 - i / 39) + noise(r, 0.0024))]
  return candlesFrom(rets, { seed: 21, vol: (i) => (i < 260 ? 1e6 : 1e6 * (1 + 0.9 * ((i - 260) / 39))) })
})()

// The same base with no coil and a flat volume baseline — nothing to see.
const QUIET = (() => {
  const r = rng(22)
  return candlesFrom(seg(300, () => noise(r, 0.012)), { seed: 22 })
})()

// Long decline, then a sharp rally that takes back the 200-day.
const RECLAIM = (() => {
  const r = rng(23)
  return candlesFrom([
    ...seg(240, () => -0.003 + noise(r, 0.01)),
    ...seg(25, () => 0.03 + noise(r, 0.006)),
  ], { seed: 23 })
})()

// The same decline, stopped before the rally.
const BELOW_200 = (() => {
  const r = rng(24)
  return candlesFrom(seg(240, () => -0.003 + noise(r, 0.01)), { seed: 24 })
})()

// A slow uptrend with regular pullbacks — a higher-low sequence you can point at.
const HIGHER_LOWS = candlesFrom(seg(300, (i) => 0.003 + 0.018 * Math.sin(i / 5)), { seed: 25 })

// What CoinGecko's market_chart hands us: flat bars, no range at all.
const CLOSE_ONLY = (() => {
  const r = rng(26)
  let c = 100
  return Array.from({ length: 300 }, (_, i) => {
    c *= 1 + noise(r, 0.03)
    return { t: T0 + i * DAY, o: c, h: c, l: c, c, v: Math.round(1e6 * (0.5 + r())) }
  })
})()

const screened = (over = {}) => ({
  symbol: 'TEST', band: 'basing', chg24h: 1, chg7d: 2, chg30d: 3,
  rsVsBtc7d: 1, rsVsBtc30d: -5, turnover: 0.04,
  accel: { d24VsWeek: 0.5, weekVsMonth: 0.1, daily7d: 0.29, daily30d: 0.1 },
  flags: { stablecoin: false, wrapper: false, parabolic: false, thinLiquidity: false, freshBreak: false, newListing: false },
  ...over,
})

// Shaped exactly as netlify/shared/alts.mjs's altDerivs() emits it: ONE flat
// envelope, funding at the top level and the three series beside it. That shape
// matters here — sentiment.js reads it by key, and since the checklist now takes
// sentiment's verdict rather than re-reading the feed, a fixture in a shape the
// data layer never produces would prove nothing about either file.
const NOW_MS = Date.UTC(2026, 6, 31)
const NOW_SEC = NOW_MS / 1000

const derivs = (over = {}) => ({
  symbol: 'TESTUSDT', priceMultiplier: 1, markPrice: 1.2,
  lastFundingRate: 0.0001,                       // +0.01% per 8h — Binance's own neutral
  nextFundingTime: NOW_MS + 3_600_000,
  openInterest: [
    { t: NOW_SEC - DAY, oi: 100, oiValueUsd: 120 },
    { t: NOW_SEC, oi: 112, oiValueUsd: 134 },
  ],
  globalLongShort: null, topLongShort: null, degraded: [],
  sourceDetail: 'binance futures TESTUSDT',
  ...over,
})

/** The pair the UI actually builds: one crowdRead over the derivatives, and a
 *  checklist handed both. `derivs` is passed on purpose — the checklist must
 *  ignore it and read the crowd read's verdict instead. */
const bothReads = (d, over = {}) => {
  const crowd = crowdRead({ derivs: d, screened: screened(), now: NOW_MS, ...over })
  return { crowd, rows: signalChecklist(COILING, screened(), { crowd, derivs: d, now: NOW_MS }) }
}

const byId = (rows, id) => rows.find((r) => r.id === id)
const partOf = (crowd, key) => crowd.parts.find((p) => p.key === key)

/* ── the phases ───────────────────────────────────────────────────────────── */

describe('PHASES', () => {
  it('runs the cycle in order and names every field', () => {
    expect(PHASES.map((p) => p.id)).toEqual(
      ['dormant', 'accumulation', 'ignition', 'markup', 'euphoria', 'distribution', 'bust'])
    for (const p of PHASES) {
      expect(p.label.length).toBeGreaterThan(3)
      for (const key of ['looksLike', 'whatToDo', 'failureMode']) {
        expect(typeof p[key]).toBe('string')
        expect(p[key].length).toBeGreaterThan(40)
      }
      expect(Array.isArray(p.typicalNext)).toBe(true)
      for (const next of p.typicalNext) expect(PHASES.some((x) => x.id === next)).toBe(true)
    }
  })

  it('gives every phase a failure mode, because the failure is the part that costs money', () => {
    for (const p of PHASES) expect(p.failureMode).not.toBe(p.whatToDo)
  })
})

/* ── the signals, and what the copy is allowed to say ─────────────────────── */

describe('EARLY_SIGNALS', () => {
  it('is ordered earliest first, with the confirmation signals last', () => {
    const stages = EARLY_SIGNALS.map((s) => s.stage)
    expect(stages.indexOf('late')).toBeGreaterThan(stages.lastIndexOf('early'))
    expect(EARLY_SIGNALS.filter((s) => s.stage === 'early')).toHaveLength(6)
    expect(EARLY_SIGNALS.filter((s) => s.stage === 'late')).toHaveLength(3)
    expect(EARLY_SIGNALS[0].id).toBe('compression')
    expect(EARLY_SIGNALS.map((s) => s.id).slice(-3)).toEqual(['attention', 'funding_flip', 'oi_expansion'])
  })

  it('has unique ids and states how each one is measured', () => {
    const ids = EARLY_SIGNALS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of EARLY_SIGNALS) {
      expect(s.howMeasured.length).toBeGreaterThan(60)
      expect(s.why.length).toBeGreaterThan(60)
      expect(s.leadTime.length).toBeGreaterThan(20)
    }
  })

  // The single most important thing in this file: an attention spike is the exit
  // half of a move. Copy that implies otherwise is worse than no copy.
  it('never implies a late signal is an entry', () => {
    for (const s of EARLY_SIGNALS.filter((x) => x.stage === 'late')) {
      expect(s.why).toMatch(/CONFIRMATION, NOT AN ENTRY/)
    }
    expect(byId(EARLY_SIGNALS, 'attention').why).toMatch(/exit liquidity|liquidity the move gets sold into/)
    expect(byId(EARLY_SIGNALS, 'funding_flip').why).toMatch(/no reading of this that is an early signal/)
  })

  it('says "rule of thumb" wherever a threshold is one, in those words', () => {
    for (const id of ['compression', 'volume_baseline', 'trigger_level', 'attention', 'funding_flip', 'oi_expansion']) {
      expect(byId(EARLY_SIGNALS, id).howMeasured).toMatch(/rules? of thumb, not (a )?measured thresholds?/)
    }
  })

  it('invents no statistics', () => {
    // The only base rates on this tab come out of precedent.js, counted over a
    // coin's own candles. Any "works N% of the time" in this file would be made
    // up, and would be indistinguishable on screen from one that was not.
    const prose = [
      ...PHASES.flatMap((p) => [p.looksLike, p.whatToDo, p.failureMode]),
      ...EARLY_SIGNALS.flatMap((s) => [s.why, s.howMeasured, s.leadTime]),
    ].join('\n')
    expect(prose).not.toMatch(/\d+\s?% of the time/i)
    expect(prose).not.toMatch(/on average,? \w+ \d/i)
    expect(prose).not.toMatch(/studies show|historically,? \d/i)
  })
})

/* ── the checklist measures every one of them ─────────────────────────────── */

describe('signalChecklist', () => {
  it('returns one row per signal, in EARLY_SIGNALS order, always', () => {
    for (const [c, s] of [[COILING, screened()], [null, null], [[], undefined], ['nope', {}], [CLOSE_ONLY, screened()]]) {
      const rows = signalChecklist(c, s, {})
      expect(rows.map((r) => r.id)).toEqual(EARLY_SIGNALS.map((x) => x.id))
      for (const r of rows) {
        expect(Object.keys(r)).toEqual(expect.arrayContaining(['id', 'label', 'pass', 'value', 'level', 'note']))
        expect([true, false, null]).toContain(r.pass)
        expect(['strong', 'moderate', 'weak', 'none', 'unknown']).toContain(r.level)
        expect(r.note.length).toBeGreaterThan(0)
      }
    }
  })

  it('reads compression and a rising volume baseline off a coiling series', () => {
    const rows = signalChecklist(COILING, screened(), { quality: 'ohlcv' })
    const comp = byId(rows, 'compression')
    expect(comp.pass).toBe(true)
    expect(comp.value).toBeLessThanOrEqual(20)
    expect(comp.note).toMatch(/ATR [\d.]+% of price \(\d+(st|nd|rd|th) percentile of 180 days\)/)
    expect(comp.note).toMatch(/judged on the higher of the two/)

    const vol = byId(rows, 'volume_baseline')
    expect(vol.pass).toBe(true)
    expect(vol.value).toBeGreaterThan(1.15)
    expect(vol.note).toMatch(/20-day volume baseline [\d.]+× the 60-day, price [+-][\d.]+% over the same 20 days/)
  })

  it('does not call a flat, quiet coin accumulation just because it is quiet', () => {
    const vol = byId(signalChecklist(QUIET, screened(), { quality: 'ohlcv' }), 'volume_baseline')
    expect(vol.pass).toBe(false) // flat price, flat volume — nobody is absorbing anything
  })

  it('reports "unknown" and names the reason on close-only candles, never a precise zero', () => {
    // ATR on a flat bar is 0, which would rank as maximum compression: the
    // strongest possible reading on this row, generated entirely by the choice
    // of data source.
    const rows = signalChecklist(CLOSE_ONLY, screened(), { quality: 'close-only' })
    const comp = byId(rows, 'compression')
    expect(comp.pass).toBeNull()
    expect(comp.level).toBe('unknown')
    expect(comp.note).toMatch(/close-only/)
    expect(byId(rows, 'trigger_level').note).toMatch(/contraction cannot be measured on close-only/)
  })

  it('detects flat bars even when the caller forgot to pass the quality label', () => {
    expect(byId(signalChecklist(CLOSE_ONLY, screened(), {}), 'compression').pass).toBeNull()
  })

  it('reads the RS inflection as ahead-on-the-week-behind-on-the-month', () => {
    const rows = (o) => byId(signalChecklist(COILING, screened(o), {}), 'rs_inflection')
    expect(rows({ rsVsBtc7d: 6, rsVsBtc30d: -14 }).pass).toBe(true)
    expect(rows({ rsVsBtc7d: 6, rsVsBtc30d: -14 }).level).toBe('strong')
    // Ahead on both windows is momentum, not an early signal — and the note has
    // to say which, or the row reads as a stronger version of the same thing.
    const late = rows({ rsVsBtc7d: 20, rsVsBtc30d: 40 })
    expect(late.pass).toBe(false)
    expect(late.note).toMatch(/inflection has already happened/)
    expect(rows({ rsVsBtc7d: -3, rsVsBtc30d: -14 }).pass).toBe(false)
  })

  it('reports pass:null, not pass:false, when the input is missing', () => {
    // A missing feed rendered as a failed signal is a lie that looks like
    // diligence: the row is indistinguishable from a measurement.
    const rows = signalChecklist(null, null, {})
    for (const id of ['compression', 'volume_baseline', 'rs_inflection', 'reclaim_200d', 'higher_lows', 'trigger_level']) {
      expect(byId(rows, id).pass).toBeNull()
      expect(byId(rows, id).level).toBe('unknown')
    }
    expect(byId(rows, 'rs_inflection').note).toMatch(/no relative-strength read/)
    expect(byId(rows, 'reclaim_200d').note).toMatch(/need 200 candles/)
  })

  it('reads the 200-day reclaim, and how long it had been below', () => {
    const back = byId(signalChecklist(RECLAIM, screened(), {}), 'reclaim_200d')
    expect(back.pass).toBe(true)
    expect(back.value).toBeGreaterThan(0)
    expect(back.note).toMatch(/reclaimed after \d+ days? below it/)

    const under = byId(signalChecklist(BELOW_200, screened(), {}), 'reclaim_200d')
    expect(under.pass).toBe(false)
    expect(under.note).toMatch(/below the 200-day — no reclaim/)
  })

  it('reads a higher-low sequence and hands back the level that invalidates it', () => {
    const hl = byId(signalChecklist(HIGHER_LOWS, screened(), {}), 'higher_lows')
    expect(hl.pass).toBe(true)
    expect(hl.value).toBeGreaterThan(0)
    expect(hl.note).toMatch(/last two confirmed swing lows .* → .*/)
    expect(hl.note).toMatch(/sequence breaks if price closes under/)
  })

  it('names a trigger level with the contraction into it', () => {
    const t = byId(signalChecklist(COILING, screened(), { quality: 'ohlcv' }), 'trigger_level')
    expect(t.note).toMatch(/trigger \$[\d.,]+/)
    expect(t.value).toBeGreaterThan(0) // price is under the level, which is what makes it a trigger
    expect(t.note).toMatch(/range is [\d.]+× the 30 before them/)
  })

  it('says a trigger that has already fired is a break to manage, not a setup', () => {
    const r = rng(31)
    const broken = candlesFrom([...seg(60, () => noise(r, 0.01)), 0.12], { seed: 31 })
    const t = byId(signalChecklist(broken, screened(), {}), 'trigger_level')
    expect(t.pass).toBe(false)
    expect(t.note).toMatch(/already through the 20-day high/)
  })
})

/* ── the late signals, and the words attached to them ─────────────────────── */

describe('the coincident-to-late signals', () => {
  it('treats an attention spike as a warning, and says so in the row', () => {
    const hot = byId(signalChecklist(COILING, screened(), { trendingRank: 2 }), 'attention')
    expect(hot.pass).toBe(true)      // the signal has fired...
    expect(hot.level).toBe('strong') // ...loudly, which is not the same as well
    expect(hot.note).toMatch(/NOT an entry signal/)
    expect(hot.note).toMatch(/taking profit rather than opening risk/)
  })

  it('calls the absence of attention the good version of the row for an early setup', () => {
    // `trendingRank: null` is the MEASURED absence: the list answered and this
    // coin is not on it.
    const quiet = byId(signalChecklist(COILING, screened(), { trendingRank: null }), 'attention')
    expect(quiet.pass).toBe(false)
    expect(quiet.note).toMatch(/good version of this row/)
  })

  it('will not call a coin unwatched when the trending list never answered', () => {
    // An ABSENT key is not a measurement, and "not on the trending list" is the
    // most bullish reading this row has. Scoring a rate-limited feed as proof
    // nobody is looking is the exact failure crowdRead's absent-vs-null rule
    // exists to prevent, and the two reads must agree on the same pass.
    const unknown = byId(signalChecklist(COILING, screened(), {}), 'attention')
    expect(unknown.pass).toBeNull()
    expect(unknown.level).toBe('unknown')
    expect(unknown.note).toMatch(/did not answer|not measured/i)
    expect(unknown.note).not.toMatch(/good version of this row/)
  })

  it('prints the funding number sentiment.js annualised, not a second one of its own', () => {
    // 0.0001 per 8h × 3 settlements × 365 days = +10.95% a year. That 3×365 used
    // to exist in this file too, which netlify/shared/alts.mjs's parser comment
    // already promised it did not. Two copies that agree today are one number
    // that disagrees on the day either is corrected — so the row is asserted
    // against the crowd read's value, not against a literal.
    const { crowd, rows } = bothReads(derivs())
    const f = byId(rows, 'funding_flip')
    expect(crowd.crowding.fundingAnnualPct).toBeCloseTo(10.95, 6)
    expect(f.value).toBe(Math.round(crowd.crowding.fundingAnnualPct * 10) / 10)
    expect(f.pass).toBe(true)
    expect(f.note).toMatch(/longs are paying shorts/)
    expect(f.note).toMatch(/Confirmation of a move already underway/)
  })

  it('calls +30% annualised crowded, on the same arithmetic', () => {
    const { crowd, rows } = bothReads(derivs({ lastFundingRate: 0.0005 }))
    const f = byId(rows, 'funding_flip')
    expect(crowd.crowding.fundingAnnualPct).toBeCloseTo(54.75, 6)
    expect(f.value).toBeCloseTo(54.8, 1)
    expect(f.level).toBe('strong')
    expect(f.note).toMatch(/crowding warning/)
  })

  it('reads open interest as a 24h change and calls +5% expansion', () => {
    const { crowd, rows } = bothReads(derivs())
    const oi = byId(rows, 'oi_expansion')
    expect(crowd.crowding.oiChange24hPct).toBeCloseTo(12, 6)
    expect(oi.value).toBeCloseTo(12, 6)
    expect(oi.pass).toBe(true)
    expect(oi.note).toMatch(/Confirmation, not an entry/)
  })

  // ── the shared gate ──────────────────────────────────────────────────────
  //
  // This checklist and the crowd card render on the SAME card. They used to
  // disagree about whether the same number was measurable: crowdRead drops an
  // open-interest series whose newest sample is older than three days, because a
  // "24h change" measured across ten days is not a 24h change — and this file
  // recomputed it anyway from the last two samples and printed it as measured.
  // A page that says a number is both measurable and unmeasurable gives the
  // reader no way to tell which half is lying. One gate, applied once.

  it('refuses a stale open-interest series exactly when the crowd read refuses it', () => {
    const stale = derivs({
      openInterest: [
        { t: NOW_SEC - 11 * DAY, oi: 100, oiValueUsd: 120 },
        { t: NOW_SEC - 10 * DAY, oi: 112, oiValueUsd: 134 },
      ],
    })
    const { crowd, rows } = bothReads(stale)
    // The crowd read computed the change and then declined to score it — and it
    // still CARRIES the number on `crowding`. That is the trap: reading the
    // value alone gets you a stale 12% with no hint that it was refused, which
    // is what this row used to print. The verdict lives on the part, so the gate
    // is the part.
    expect(crowd.crowding.oiChange24hPct).toBeCloseTo(12, 6)
    expect(partOf(crowd, 'oi').points).toBeNull()
    expect(partOf(crowd, 'oi').label).toMatch(/stale/)

    const oi = byId(rows, 'oi_expansion')
    expect(oi.pass).toBeNull()
    expect(oi.value).toBeNull()
    expect(oi.level).toBe('unknown')
    // Same refusal, same words, so the two rows cannot be read as disagreeing.
    expect(oi.note).toContain(partOf(crowd, 'oi').label)
    expect(oi.note).toMatch(/not counted as neutral/)
  })

  it('refuses a stale funding snapshot on the same terms', () => {
    // The same gate on the other input: a snapshot whose next payment is already
    // more than an interval in the past is a cached read of a halted pair.
    const halted = derivs({ nextFundingTime: NOW_MS - 24 * 3_600_000 })
    const { crowd, rows } = bothReads(halted)
    expect(partOf(crowd, 'funding').points).toBeNull()
    expect(partOf(crowd, 'funding').label).toMatch(/stale/)

    const f = byId(rows, 'funding_flip')
    expect(f.pass).toBeNull()
    expect(f.value).toBeNull()
    expect(f.note).toContain(partOf(crowd, 'funding').label)
  })

  it('refuses a single open-interest sample rather than calling it a 24h change', () => {
    const one = derivs({ openInterest: [{ t: NOW_SEC, oi: 112, oiValueUsd: 134 }] })
    const { crowd, rows } = bothReads(one)
    expect(partOf(crowd, 'oi').points).toBeNull()
    expect(byId(rows, 'oi_expansion').pass).toBeNull()
    expect(byId(rows, 'oi_expansion').note).toContain(partOf(crowd, 'oi').label)
  })

  it('says a coin has no perp instead of scoring it neutral', () => {
    const { crowd, rows } = bothReads(null)
    expect(crowd.crowding).toBeNull()
    for (const [row, key] of [['funding_flip', 'funding'], ['oi_expansion', 'oi']]) {
      expect(byId(rows, row).pass).toBeNull()
      expect(byId(rows, row).note).toContain('no listed perp')
      expect(byId(rows, row).note).toContain(partOf(crowd, key).label)
      expect(byId(rows, row).note).toMatch(/not counted as neutral/)
    }
  })

  it('does not reach around the crowd read to the raw feed', () => {
    // The old code searched the derivatives payload BY SHAPE for anything
    // carrying a lastFundingRate, so it could resolve envelopes sentiment.js
    // cannot read — and that independence is precisely what let the two rows
    // disagree. An envelope the data layer does not emit is now a refusal on
    // BOTH reads together, which is the honest answer: if crowdRead cannot see
    // the funding rate, this card has not measured one.
    const wrongEnvelope = { premiumIndex: { lastFundingRate: -0.0002 }, oiHist: [{ t: NOW_SEC, oi: 200 }, { t: NOW_SEC, oi: 180 }] }
    const { crowd, rows } = bothReads(wrongEnvelope)
    expect(crowd.crowding).toBeNull()
    expect(byId(rows, 'funding_flip').value).toBeNull()
    expect(byId(rows, 'oi_expansion').value).toBeNull()

    // And with a perfectly good payload but no crowd read at all, the row says
    // the arithmetic's owner did not run — it does not derive a second version.
    const orphan = signalChecklist(COILING, screened(), { derivs: derivs(), now: NOW_MS })
    expect(byId(orphan, 'funding_flip').pass).toBeNull()
    expect(byId(orphan, 'funding_flip').note).toMatch(/no crowd read on this pass/)
    expect(byId(orphan, 'oi_expansion').pass).toBeNull()
  })

  it('survives junk where a crowd read should be', () => {
    for (const bad of ['nope', 42, [], {}, { parts: 'no' }, { parts: [{ key: 'oi' }] }, { parts: [{ key: 'funding', points: 3 }], crowding: {} }]) {
      expect(() => signalChecklist(COILING, screened(), { crowd: bad, now: NOW_MS })).not.toThrow()
      const rows = signalChecklist(COILING, screened(), { crowd: bad, now: NOW_MS })
      expect(byId(rows, 'funding_flip').pass).toBeNull()
      expect(byId(rows, 'oi_expansion').pass).toBeNull()
      expect(byId(rows, 'funding_flip').note.length).toBeGreaterThan(20)
    }
  })
})

/* ── the phase call ───────────────────────────────────────────────────────── */

describe('phaseOf', () => {
  it('says unknown — which is not one of PHASES — when there is nothing to read', () => {
    const p = phaseOf({})
    expect(p.id).toBe('unknown')
    expect(PHASES.some((x) => x.id === 'unknown')).toBe(false)
    expect(p.confidence).toBe('low')
    expect(p.why[0]).toMatch(/nothing here to place in a cycle/)
  })

  it('calls a coiling base accumulation, with the readings that made the call', () => {
    const p = phaseOf({ screened: screened({ band: 'basing' }), candles: COILING })
    expect(p.id).toBe('accumulation')
    expect(p.why.join(' ')).toMatch(/percentile of its own last 180 days|volume baseline is/)
    expect(p.why.join(' ')).toMatch(/trigger, the invalidation and the size/)
  })

  it('calls a fresh break ignition and quotes the coin\'s own base rate', () => {
    const p = phaseOf({
      screened: screened({ band: 'igniting', rsVsBtc7d: 12 }),
      candles: COILING,
      precedent: { ok: true, episodes: 4, baseRates: { medianFwd21: 41.2, worstFwd21: -12.5 } },
    })
    expect(p.id).toBe('ignition')
    expect(p.why.join(' ')).toMatch(/4 prior ignitions ran a median \+41\.2% over the next 21 days, worst -12\.5%/)
    expect(p.why.join(' ')).toMatch(/failed break is the common outcome/)
  })

  it('says so plainly when there is no precedent to lean on', () => {
    const p = phaseOf({ screened: screened({ band: 'igniting' }), candles: COILING, precedent: { ok: false, reason: 'x' } })
    expect(p.why.join(' ')).toMatch(/no usable precedent for this coin — size it on the plan/)
  })

  it('outranks ignition with euphoria, so a parabolic break is never called a setup', () => {
    const p = phaseOf({
      screened: screened({ band: 'igniting', chg24h: 62, chg7d: 180, flags: { ...screened().flags, parabolic: true } }),
      candles: COILING,
    })
    expect(p.id).toBe('euphoria')
    expect(p.why.join(' ')).toMatch(/new risk here is a chase/)
  })

  it('calls the stall after a big run distribution, not markup', () => {
    const r = rng(41)
    const rolled = candlesFrom([
      ...seg(200, () => noise(r, 0.01)),
      ...seg(60, () => 0.02 + noise(r, 0.01)),
      ...seg(20, () => -0.012 + noise(r, 0.01)),
    ], { seed: 41 })
    const p = phaseOf({
      screened: screened({ band: 'running', chg7d: -8, chg30d: 70 }),
      candles: rolled,
      crowd: { state: 'hot', score: 78 },
    })
    expect(p.id).toBe('distribution')
    expect(p.why.join(' ')).toMatch(/attention lags price/)
  })

  it('calls a deep drawdown bust and refuses to read the bounce as ignition', () => {
    const r = rng(42)
    const busted = candlesFrom([
      ...seg(200, () => 0.004 + noise(r, 0.01)),
      ...seg(70, () => -0.02 + noise(r, 0.01)),
      ...seg(4, () => 0.05),
    ], { seed: 42 })
    const p = phaseOf({ screened: screened({ band: 'igniting', chg7d: 18, chg30d: -55 }), candles: busted })
    expect(p.id).toBe('bust')
    expect(p.why.join(' ')).toMatch(/not an ignition until it takes back the 200-day/)
  })

  it('calls a trending, structurally-sound coin markup', () => {
    const r = rng(43)
    const trending = candlesFrom([...seg(200, () => noise(r, 0.008)), ...seg(60, () => 0.008 + noise(r, 0.008))], { seed: 43 })
    const p = phaseOf({ screened: screened({ band: 'running', chg7d: 6, chg30d: 28 }), candles: trending })
    expect(p.id).toBe('markup')
    expect(p.why.join(' ')).toMatch(/the stop only moves up/)
  })

  it('defaults to dormant and says what would change its mind', () => {
    const p = phaseOf({ screened: screened({ band: 'dead', chg7d: -1, chg30d: -4 }), candles: QUIET.slice(0, 40) })
    expect(p.id).toBe('dormant')
    expect(p.why.join(' ')).toMatch(/watchlist row until compression or a volume baseline shows up/)
  })

  it('rates confidence by how many independent inputs answered, not by how loud they were', () => {
    const one = phaseOf({ screened: screened({ band: 'basing' }) })
    const four = phaseOf({
      screened: screened({ band: 'basing' }),
      candles: COILING,
      precedent: { ok: true, episodes: 5, matchPct: 71, baseRates: { medianFwd21: 30, worstFwd21: -9 } },
      crowd: { state: 'ignored', score: 12 },
    })
    expect(one.confidence).toBe('low')
    expect(four.confidence).toBe('high')
    expect(four.why.join(' ')).toMatch(/matches this coin's day-before-liftoff archetype 71%/)
    expect(four.why.join(' ')).toMatch(/a similarity, not a probability/)
  })

  it('never throws, whatever it is handed', () => {
    for (const bad of [undefined, {}, { screened: null, candles: 'nope' }, { candles: [{}, {}] }, { screened: 42 }]) {
      expect(() => phaseOf(bad)).not.toThrow()
      const p = phaseOf(bad)
      expect(typeof p.id).toBe('string')
      expect(Array.isArray(p.why)).toBe(true)
    }
  })
})
