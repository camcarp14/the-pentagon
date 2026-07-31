// The directive is the one line a user acts on, so the properties worth testing
// are the ones that keep it from being confidently wrong:
//
//   1. The ladder is a LADDER. First match wins, and safety outranks
//      opportunity — a stop breach can never be talked over by a fresh break.
//   2. New risk requires live data. No combination of a beautiful setup and a
//      dead feed produces ENTER, STARTER or ADD. This is the rule advice.js has
//      never relaxed and the one this file inherits verbatim.
//   3. Targets come from measured forward returns or they do not exist, and the
//      worst case rides along with every median.
//   4. AVOID speaks to a flat book. Telling someone not to buy a coin they
//      already hold is not advice, it is noise on the day they need an exit.
//   5. The scheduled sentinel's alert set is a subset of what its call shape can
//      actually produce. It once listed four rungs that call shape can never
//      reach, so four fifths of the "actionable" alerts had never fired and the
//      one that matters most had no rung at all.
import { describe, it, expect } from 'vitest'
import { altDirective } from '../directive.js'
// Imported only to pin the level definition against the shared one. directive.js
// itself imports nothing, on purpose — see the note at the top of that file.
import { highestHigh } from '../../ta.js'
// The sentinel's OWN call into this module, plus the set it alerts on. Imported
// rather than reconstructed so the sweep below cannot go stale against the pass
// it is there to justify.
import { ACTIONABLE, alertLine, safeDirective, transitionOf } from '../../../../../../netlify/functions/alt-watch.mjs'
// The board's own turnover formatter, so "same field, same units" is asserted
// against the surface the alert tells the reader to go and open, not against a
// literal that both could be wrong about together.
import { turnText } from '../../../components/alts/AltBoard.jsx'

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const DAY = 86_400
const T0 = Math.floor(Date.parse('2026-05-01T00:00:00Z') / 1000)
const NOW = Date.parse('2026-07-31T00:00:00Z')

/** n daily bars at `base` — high 10.1, low 9.9 when base is 10. */
const bars = (n = 60, base = 10) =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY, o: base, h: base * 1.01, l: base * 0.99, c: base, v: 1e6 }))

/** The CoinGecko fallback shape: one flat bar per day, o=h=l=c. */
const flatBars = (n = 60, base = 10) =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY, o: base, h: base, l: base, c: base, v: 0 }))

const screened = (over = {}) => ({
  id: 'test-coin', symbol: 'TEST', name: 'Test Coin', price: 11, mcap: 3e8, vol24h: 2e7,
  chg24h: 4, chg7d: 9, chg30d: 12, score: 72, band: 'igniting', tier: 'small', kind: 'utility',
  parts: [], facts: ['7d +9.0% vs BTC +3.0% — +6.0 pts of relative strength'],
  flags: { stablecoin: false, wrapper: false, parabolic: false, thinLiquidity: false, freshBreak: true, newListing: false },
  turnover: 0.066, rsVsBtc7d: 6, rsVsBtc30d: 5,
  accel: { d24VsWeek: 2.7, weekVsMonth: 0.9 }, drawdownFromAthPct: 62,
  range7d: { low: 9.5, high: 11.2, last: 11, pos: 0.9, freshBreak: true, priorHigh: 10.4, points: 168 },
  ...over,
})

const season = (over = {}) => ({ score: 61, phase: 'majors_rotating', label: 'Majors rotating', plain: 'Capital is leaving BTC for the large alts.', ...over })
const HOSTILE = season({ score: 30, phase: 'btc_only', label: 'BTC only', plain: 'Money is in BTC and staying there.' })

const precedent = (over = {}) => ({
  ok: true, reason: null, episodes: 5,
  baseRates: { medianFwd7: 12, medianFwd21: 38, medianFwd60: 61, bestRunPct: 210, worstFwd21: -18, hitRate21: 0.6, medianMaxDDPct: -24 },
  matchPct: 72, matched: [], today: {}, archetype: {}, facts: [],
  ...over,
})
const NO_PRECEDENT = precedent({ ok: false, reason: 'only 2 comparable episodes in 730 bars', episodes: 2, baseRates: null, matchPct: null, archetype: null })

const crowd = (over = {}) => ({ score: 40, state: 'warming', contrarian: 'neutral', attention: {}, crowding: null, parts: [], facts: [], extremes: [], ...over })
const HEADWIND = crowd({
  score: 78, state: 'hot', contrarian: 'headwind',
  crowding: { fundingAnnualPct: 120, divergencePts: 25 },
  facts: ['HEADWIND: funding at 120%/yr + retail 25 points longer than the top traders — the crowd is already positioned'],
  extremes: ['funding at 120%/yr', 'retail 25 points longer than the top traders'],
})

const plan = (over = {}) => ({
  stop: { stop: 9.2, basis: 'atr', detail: '3×ATR($0.60) below $11.00', warning: null, floored: false },
  size: {
    ok: true, error: null, units: 120, notional: 1320, riskUsd: 216, perUnitRisk: 1.8,
    positionPct: 1.32, advPct: 0.0066, capped: 'risk', reduced: false, liquidityUnknown: false,
    caps: { risk: 1320, position: 3000, liquidity: 40_000 }, minTicketUsd: 25,
  },
  ...over,
})

const LIVE = { scan: { state: 'live' }, coin: { state: 'live' } }

/** The everything-is-met call. Individual tests override one thing at a time. */
const ready = (over = {}) => ({
  screened: screened(), season: season(), precedent: precedent(), crowd: crowd(),
  plan: plan(), position: null, candles: bars(), freshness: LIVE, now: NOW,
  ...over,
})

/* ══ 1 — no data ═══════════════════════════════════════════════════════════ */

describe('NO_DATA outranks everything', () => {
  it('fires with no screened row', () => {
    expect(altDirective({ freshness: LIVE }).action).toBe('NO_DATA')
  })

  it('fires with no price, even on a perfect setup', () => {
    const d = altDirective(ready({ screened: screened({ price: null }) }))
    expect(d.action).toBe('NO_DATA')
  })

  it('fires when every feed is dead, and names them', () => {
    const d = altDirective(ready({ freshness: { scan: { state: 'dead' }, coin: { state: 'dead' } } }))
    expect(d.action).toBe('NO_DATA')
    expect(d.reasons.join(' ')).toMatch(/dead feeds: scan, coin/)
  })

  // The default is DEAD, exactly as advice.js defaults its quote. A caller who
  // has not wired the freshness ladder must not be rewarded with an ENTER.
  it('treats a missing freshness map as dead rather than as live', () => {
    expect(altDirective(ready({ freshness: null })).action).toBe('NO_DATA')
    expect(altDirective(ready({ freshness: {} })).action).toBe('NO_DATA')
  })

  it('accepts a single { state } as well as a map of named feeds', () => {
    expect(altDirective(ready({ freshness: { state: 'live' } })).action).toBe('ENTER')
    expect(altDirective(ready({ freshness: { state: 'dead' } })).action).toBe('NO_DATA')
  })

  it('is urgent when a position is open — check the exchange, not this screen', () => {
    const d = altDirective(ready({ freshness: { state: 'dead' }, position: { units: 120, avgEntry: 9.5 } }))
    expect(d.severity).toBe('urgent')
    expect(d.reasons.join(' ')).toMatch(/check the exchange directly/)
  })
})

/* ══ 2 — new risk requires live data ═══════════════════════════════════════ */

describe('a dead or stale feed can never produce new risk', () => {
  const RISK_ON = ['ENTER', 'STARTER', 'ADD']

  it('holds for every combination of non-live feeds, on a setup that would otherwise ENTER', () => {
    for (const scan of ['live', 'stale', 'dead']) {
      for (const coin of ['live', 'stale', 'dead']) {
        const d = altDirective(ready({ freshness: { scan: { state: scan }, coin: { state: coin } } }))
        if (scan === 'live' && coin === 'live') {
          expect(d.action).toBe('ENTER')
        } else {
          expect(RISK_ON).not.toContain(d.action)
        }
      }
    }
  })

  it('says the trigger fired rather than pretending it did not', () => {
    const d = altDirective(ready({ freshness: { scan: { state: 'live' }, coin: { state: 'stale' } } }))
    expect(d.action).toBe('WATCH')
    expect(d.headline).toMatch(/A break is live on TEST but the coin \(stale\) feed is not/)
    expect(d.reasons.join(' ')).toMatch(/is above \$10\.10/)
    expect(d.reasons.join(' ')).toMatch(/does not expire in a minute/)
  })

  it('blocks the pyramid add too, and says why in the hold rung', () => {
    const d = altDirective(ready({
      position: { units: 120, avgEntry: 9.0 },
      freshness: { scan: { state: 'live' }, coin: { state: 'dead' } },
    }))
    expect(d.action).toBe('WATCH')
    expect(d.reasons.join(' ')).toMatch(/add trigger live but blocked: the coin feed is dead — no new risk on blind data/)
  })

  it('every non-live feed becomes a guardrail on whatever rung is returned', () => {
    const d = altDirective(ready({ freshness: { scan: { state: 'stale' }, coin: { state: 'live' } } }))
    expect(d.guardrails.join(' ')).toMatch(/the scan feed is stale/)
  })
})

/* ══ 3 — held positions come before every opportunity rung ═════════════════ */

describe('exits outrank everything except NO_DATA', () => {
  const held = { units: 120, avgEntry: 9.5 }

  it('EXITs on a stop breach even while the trigger is live', () => {
    const d = altDirective(ready({ position: held, screened: screened({ price: 9.1 }) }))
    expect(d.action).toBe('EXIT')
    expect(d.severity).toBe('urgent')
    expect(d.headline).toMatch(/Sell your 120 TEST now/)
    expect(d.reasons.join(' ')).toMatch(/at or under the stop \$9\.20/)
    expect(d.reasons.join(' ')).toMatch(/The plan only works if the stop is real/)
  })

  it('EXITs on a broken thesis even when the stop is still far away', () => {
    const d = altDirective(ready({
      position: held,
      screened: screened({ price: 9.5 }),
      plan: plan({ stop: { stop: 8, basis: 'atr', detail: '', warning: null, floored: false } }),
    }))
    expect(d.action).toBe('EXIT')
    expect(d.reasons.join(' ')).toMatch(/lost the base low \$9\.90 \(20-day base low\)/)
    expect(d.reasons.join(' ')).toMatch(/hope, not a thesis/)
  })

  it('TRIMs a parabolic coin it is already long, instead of telling you to AVOID it', () => {
    const d = altDirective(ready({
      position: held,
      screened: screened({ price: 18, chg24h: 47, chg7d: 130, band: 'extended', flags: { ...screened().flags, parabolic: true } }),
    }))
    expect(d.action).toBe('TRIM')
    expect(d.severity).toBe('act')
    expect(d.reasons.join(' ')).toMatch(/\+47\.0% in 24h/)
    expect(d.reasons.join(' ')).toMatch(/open R: \+/)
  })

  it('TRIMs into euphoria — that is who you sell to', () => {
    const d = altDirective(ready({ position: held, crowd: crowd({ state: 'euphoric', score: 88 }) }))
    expect(d.action).toBe('TRIM')
    expect(d.reasons.join(' ')).toMatch(/the crowd is euphoric \(88\/100\)/)
  })

  it('holds when there is nothing to do, and shows R, P&L and the stop', () => {
    const d = altDirective(ready({
      position: held,
      screened: screened({ price: 10.0, band: 'running', flags: { ...screened().flags, freshBreak: false } }),
    }))
    expect(d.action).toBe('WATCH')
    expect(d.headline).toMatch(/Hold your 120 TEST/)
    expect(d.reasons.join(' ')).toMatch(/open R: \+1\.67R/)
    expect(d.reasons.join(' ')).toMatch(/position is up 5\.3%/)
    expect(d.reasons.join(' ')).toMatch(/stop \$9\.20 \(8\.0% below price\)/)
  })
})

/* ══ 4 — AVOID, and only on a flat book ════════════════════════════════════ */

describe('AVOID', () => {
  it('refuses a stablecoin and a wrapper outright', () => {
    for (const flag of ['stablecoin', 'wrapper']) {
      const d = altDirective(ready({
        screened: screened({ score: null, band: 'dead', flags: { ...screened().flags, [flag]: true } }),
      }))
      expect(d.action).toBe('AVOID')
      expect(d.reasons.join(' ')).toMatch(/no independent move to catch/)
    }
  })

  it('refuses a coin nobody can get out of, and blames the exit rather than the entry', () => {
    const d = altDirective(ready({
      screened: screened({ vol24h: 180_000, flags: { ...screened().flags, thinLiquidity: true } }),
    }))
    expect(d.action).toBe('AVOID')
    expect(d.headline).toMatch(/untradeable at any size that matters/)
    expect(d.reasons.join(' ')).toMatch(/\$180k of 24h volume/)
    expect(d.reasons.join(' ')).toMatch(/the exit is the problem, not the entry/)
  })

  it('refuses the chase, and points at what would make it interesting again', () => {
    const d = altDirective(ready({
      screened: screened({ price: 18, chg24h: 47, chg7d: 130, band: 'extended', flags: { ...screened().flags, parabolic: true } }),
    }))
    expect(d.action).toBe('AVOID')
    expect(d.headline).toMatch(/already went — \+47\.0% in 24h, \+130\.0% in 7d/)
    expect(d.reasons.join(' ')).toMatch(/buying the exit liquidity of everyone who was early/)
  })

  it('refuses a coin the caps cannot size into a real ticket', () => {
    const d = altDirective(ready({
      plan: plan({ size: { ok: false, error: 'below_min_ticket', units: 0, notional: 12, capped: 'liquidity', minTicketUsd: 25, liquidityUnknown: false } }),
    }))
    expect(d.action).toBe('AVOID')
    expect(d.reasons.join(' ')).toMatch(/the caps allow \$12, under the \$25 minimum ticket/)
    expect(d.reasons.join(' ')).toMatch(/a size problem the risk settings cannot fix/)
  })

  // The documented departure from the contract's ladder order, pinned.
  it('never fires against a position you already hold — that book needs an exit plan', () => {
    const thin = screened({ price: 10, vol24h: 180_000, band: 'running', flags: { ...screened().flags, thinLiquidity: true, freshBreak: false } })
    expect(altDirective(ready({ screened: thin })).action).toBe('AVOID')
    const held = altDirective(ready({ screened: thin, position: { units: 120, avgEntry: 9.5 } }))
    expect(held.action).not.toBe('AVOID')
    expect(held.headline).toMatch(/Hold your 120 TEST/)
    // The warning does not disappear — it moves to where it belongs.
    expect(held.guardrails.join(' ')).toMatch(/you can get in and not out/)
  })
})

/* ══ 5 — the opportunity rungs ═════════════════════════════════════════════ */

describe('ENTER', () => {
  it('takes the full size when the break is live and it has a measured precedent', () => {
    const d = altDirective(ready())
    expect(d.action).toBe('ENTER')
    expect(d.severity).toBe('act')
    expect(d.headline).toMatch(/Buy 120 TEST — the break is live and it has a precedent/)
    expect(d.reasons.join(' ')).toMatch(/cleared \$10\.10 \(prior 20-day high\)/)
    // The median never appears without its worst case.
    expect(d.reasons.join(' ')).toMatch(/median 21d \+38\.0%, worst 21d -18\.0%/)
    expect(d.reasons.join(' ')).toMatch(/size 120 ≈ \$1,320 \(1\.32% of equity, 0\.0066% of a day's volume\)/)
    expect(d.reasons.join(' ')).toMatch(/risk if stopped \$216; stop \$9\.20 \(16\.4% below price\)/)
  })

  it('says which cap bound the size when one did', () => {
    const d = altDirective(ready({ plan: plan({ size: { ...plan().size, capped: 'liquidity', reduced: true } }) }))
    expect(d.reasons.join(' ')).toMatch(/CAPPED by liquidity/)
    expect(d.guardrails.join(' ')).toMatch(/size is capped by LIQUIDITY, not by risk/)
  })

  it('stands down in a hostile regime instead of buying the break', () => {
    const d = altDirective(ready({ season: HOSTILE }))
    expect(d.action).toBe('WATCH')
    expect(d.headline).toMatch(/broke out into a BTC only tape/)
    expect(d.reasons.join(' ')).toMatch(/Breakouts in this regime fail more often than they run/)
    expect(d.guardrails.join(' ')).toMatch(/alt risk is fighting the tape today/)
  })

  it('stands down when the position cannot be sized, and names the blocker', () => {
    const d = altDirective(ready({ plan: plan({ size: { ok: false, error: 'stop_not_below_price', units: 0 } }) }))
    expect(d.action).toBe('WATCH')
    expect(d.headline).toMatch(/cannot be sized/)
    expect(d.reasons.join(' ')).toMatch(/blocker: the computed stop is not below the current price/)
  })

  it('does not claim a coin cannot be sized when nothing tried to size it', () => {
    // alt-watch.mjs calls this with `plan: null` on purpose — sizing 60
    // watchlist coins would need 60 candle fetches inside a 30-second budget —
    // and it quotes the headline straight into a Telegram digest. "The position
    // cannot be sized" there reads as a verdict on the coin's liquidity rather
    // than on a size nobody computed.
    const d = altDirective(ready({ plan: null }))
    expect(d.action).toBe('WATCH')
    expect(d.headline).toMatch(/no position size was computed/)
    expect(d.headline).not.toMatch(/cannot be sized/)
    // the blocker is still named, and still honest about which it is
    expect(d.reasons.join(' ')).toMatch(/blocker: no sizing plan available/)
  })
})

describe('STARTER — a trigger with a leg missing is half a position, quantified', () => {
  it('fires when there is no base rate behind the setup', () => {
    const d = altDirective(ready({ precedent: NO_PRECEDENT }))
    expect(d.action).toBe('STARTER')
    expect(d.headline).toMatch(/no more than 60 \(half the sized 120\)/)
    expect(d.reasons.join(' ')).toMatch(/no base rate \(only 2 comparable episodes in 730 bars\)/)
    expect(d.reasons.join(' ')).toMatch(/half size risks \$108 instead of \$216/)
  })

  it('fires when the crowd is already positioned, however good the chart is', () => {
    const d = altDirective(ready({ crowd: HEADWIND }))
    expect(d.action).toBe('STARTER')
    expect(d.reasons.join(' ')).toMatch(/the crowd is already positioned here/)
    expect(d.guardrails.join(' ')).toMatch(/funding is 120%\/yr/)
  })

  it('fires on close-only candles, because the structure behind the trigger is flat bars', () => {
    const d = altDirective(ready({ candles: flatBars(), screened: screened({ price: 10.5 }) }))
    expect(d.action).toBe('STARTER')
    expect(d.reasons.join(' ')).toMatch(/close-only candles/)
    expect(d.guardrails.join(' ')).toMatch(/candles are CLOSE-ONLY/)
  })

  it('fires when today barely resembles the archetype it is being compared to', () => {
    const d = altDirective(ready({ precedent: precedent({ matchPct: 31 }) }))
    expect(d.action).toBe('STARTER')
    expect(d.reasons.join(' ')).toMatch(/matches the pre-ignition fingerprint 31%/)
  })

  it('fires on a real break that arrives late in the cycle', () => {
    for (const id of ['euphoria', 'distribution', 'bust']) {
      const d = altDirective(ready({ phase: { id, label: id[0].toUpperCase() + id.slice(1), confidence: 'high', why: [] } }))
      expect(d.action).toBe('STARTER')
      expect(d.reasons.join(' ')).toMatch(new RegExp(`the cycle read says ${id} — this is a break late in a move`))
    }
  })

  it('leaves an early-cycle phase as a full ENTER, and prints the read with its confidence', () => {
    for (const id of ['dormant', 'accumulation', 'ignition', 'markup']) {
      const d = altDirective(ready({ phase: { id, label: 'Markup', confidence: 'medium', why: [] } }))
      expect(d.action).toBe('ENTER')
      expect(d.reasons.join(' ')).toMatch(/cycle phase: Markup \(medium confidence\)/)
    }
    // An unreadable phase is left off the card rather than printed as "Unknown".
    const blank = altDirective(ready({ phase: { id: 'unknown', label: 'Unknown', confidence: 'low', why: [] } }))
    expect(blank.action).toBe('ENTER')
    expect(blank.reasons.join(' ')).not.toMatch(/cycle phase/)
  })
})

describe('ARM, STALK and WATCH', () => {
  it('ARMs at the level, and refuses to front-run it', () => {
    const d = altDirective(ready({ screened: screened({ price: 9.95, band: 'waking' }) }))
    expect(d.action).toBe('ARM')
    expect(d.headline).toMatch(/triggers on a close above \$10\.10/)
    expect(d.reasons.join(' ')).toMatch(/1\.5% below the trigger/)
    expect(d.reasons.join(' ')).toMatch(/Do not front-run it/)
  })

  it('STALKs a base that rhymes with the last one, and names both levels', () => {
    const d = altDirective(ready({
      screened: screened({ price: 9.95, band: 'basing', score: 44, flags: { ...screened().flags, freshBreak: false } }),
      precedent: precedent({ matchPct: 81 }),
    }))
    // A basing band at 44 is not armable — there is no setup yet, only a shape
    // that rhymes with one. That is the difference between STALK and ARM.
    expect(d.action).toBe('STALK')
    expect(d.headline).toMatch(/looks 81% like the day before its last ignition/)
    expect(d.reasons.join(' ')).toMatch(/a close above \$10\.10/)
    expect(d.reasons.join(' ')).toMatch(/the level that would kill it: \$9\.90/)
  })

  it('WATCHes something moving that cannot be acted on', () => {
    const d = altDirective(ready({
      screened: screened({ price: 9.95, band: 'running', score: 38, flags: { ...screened().flags, freshBreak: false } }),
      freshness: { scan: { state: 'live' }, coin: { state: 'stale' } },
    }))
    expect(d.action).toBe('WATCH')
    expect(d.headline).toMatch(/it is doing something, but nothing you can act on/)
  })

  it('falls through to cash, and says so in those words', () => {
    const d = altDirective(ready({
      screened: screened({ price: 9.95, band: 'dead', score: 11, flags: { ...screened().flags, freshBreak: false } }),
    }))
    expect(d.action).toBe('WATCH')
    expect(d.headline).toMatch(/Nothing here in TEST\. Cash is a position\./)
  })
})

describe('ADD', () => {
  it('pyramids only once the original position is already risk-free', () => {
    const d = altDirective(ready({ position: { units: 120, avgEntry: 9.0 } }))
    expect(d.action).toBe('ADD')
    expect(d.headline).toMatch(/Add 120 TEST — the trigger fired with the stop already at breakeven/)
    expect(d.reasons.join(' ')).toMatch(/the original 120 is already risk-free against \$9\.00/)
  })

  it('will not pyramid while the stop is still below the average entry', () => {
    const d = altDirective(ready({ position: { units: 120, avgEntry: 10.5 } }))
    expect(d.action).toBe('WATCH')
    expect(d.headline).toMatch(/Hold your 120 TEST/)
  })
})

/* ══ 6 — levels ════════════════════════════════════════════════════════════ */

describe('levels', () => {
  it('takes the trigger from the prior 20 bars, excluding today', () => {
    // 60 bars at 10 (high 10.1), then one spike bar today at 30.
    const spiked = [...bars(60), { t: T0 + 60 * DAY, o: 10, h: 30, l: 10, c: 29, v: 1e6 }]
    const d = altDirective(ready({ candles: spiked, screened: screened({ price: 29 }) }))
    expect(d.levels.trigger).toBeCloseTo(10.1, 10)   // today's 30 is not the level it must clear
    expect(d.levels.triggerBasis).toBe('prior 20-day high')
  })

  // directive.js inlines this arithmetic so a change in ta.js cannot move a stop
  // without its tests going red. The other half of that bargain is this test:
  // the inlined level must still BE the shared one, because precedent.js
  // measures its base rates from bars that closed above exactly this level, and
  // a trigger defined differently attaches one setup's statistics to another
  // setup's entry.
  it('is the same 20-bar high that signals.js breaks on and precedent.js ignites on', () => {
    const shapes = [
      [...bars(40), { t: 0, o: 10, h: 13, l: 9, c: 12, v: 1 }],
      [...bars(30), { t: 0, o: 10, h: 15, l: 8, c: 9, v: 1 }, ...bars(9, 12)],
      bars(21, 7),
      bars(200, 3),
    ]
    for (const cs of shapes) {
      const d = altDirective(ready({ candles: cs, screened: screened({ price: cs[cs.length - 1].c }) }))
      expect(d.levels.trigger).toBe(highestHigh(cs, 20, cs.length - 2))
    }
  })

  it('falls back to the sparkline when there is no candle history, and labels the weaker level', () => {
    const d = altDirective(ready({ candles: bars(5) }))
    expect(d.levels.trigger).toBe(10.4)              // range7d.priorHigh
    expect(d.levels.triggerBasis).toMatch(/prior 6-day high from the 7-day sparkline/)
    expect(d.levels.invalidation).toBe(9.5)          // range7d.low
  })

  it('has no trigger at all when neither source has one', () => {
    const d = altDirective(ready({ candles: null, screened: screened({ price: 11, range7d: { low: null, high: null, last: null, pos: null, freshBreak: false, priorHigh: null, points: 0 } }) }))
    expect(d.levels.trigger).toBeNull()
    expect(d.levels.invalidation).toBeNull()
    expect(d.levels.entry).toBe(11)
    expect(['WATCH', 'STALK']).toContain(d.action)
  })

  it('keeps the invalidation separate from the stop — they are different decisions', () => {
    const d = altDirective(ready())
    expect(d.levels.stop).toBe(9.2)
    expect(d.levels.invalidation).toBeCloseTo(9.9, 10)
    expect(d.levels.invalidationBasis).toBe('20-day base low')
  })

  it('publishes the level TESTS beside the levels, three-state', () => {
    // Both are consumed elsewhere (alt-watch.mjs alerts on their edges), so they
    // are part of the contract of this call and not an implementation detail.
    // null is not false: it means the level or the price was never measured.
    const live = altDirective(ready())                                  // price 11, trigger 10.1
    expect(live.levels.triggerLive).toBe(true)
    expect(live.levels.invalidated).toBe(false)

    const under = altDirective(ready({ screened: screened({ price: 9.5 }) }))
    expect(under.levels.triggerLive).toBe(false)
    expect(under.levels.invalidated).toBe(true)

    const blind = altDirective(ready({
      candles: null,
      screened: screened({ range7d: { low: null, high: null, last: null, pos: null, freshBreak: false, priorHigh: null, points: 0 } }),
    }))
    expect(blind.levels.triggerLive).toBeNull()
    expect(blind.levels.invalidated).toBeNull()
  })
})

/* ══ 6b — ONE WINDOW FOR BOTH LEVELS ═══════════════════════════════════════
 *
 * These two drifted apart once: the trigger excluded the current bar and the
 * invalidation included it. Today's low is by construction ≤ every price that
 * has traded today, so `price <= invalidation` was a self-referential test — the
 * EXIT-on-invalidation rung, a SAFETY rung, could only fire when the candle feed
 * was a day stale, and the "abandon it" price on the card walked down with price
 * every day, so the level a user wrote down could never be broken.
 *
 * Every test below pins BOTH ends of the window together. Pinning one of them is
 * how they came apart in the first place.
 */

describe('the level window is the same window for the trigger and the invalidation', () => {
  const DAY_T = (i) => T0 + i * DAY
  /** A series whose closed bars have a known high and low, so the window's two
   *  ends are checkable by hand as well as by slice. */
  const ramp = (n) => Array.from({ length: n }, (_, i) => ({
    t: DAY_T(i), o: 100, h: 100 + (i % 7), l: 100 - (i % 5), c: 100, v: 1e6,
  }))
  const closedWindow = (cs) => cs.slice(-21, -1)
  const levelsOf = (cs, price = 100) =>
    altDirective(ready({ candles: cs, screened: screened({ price }) })).levels

  it('draws both levels from exactly the last 20 CLOSED bars', () => {
    for (const n of [21, 22, 40, 200]) {
      const cs = ramp(n)
      const w = closedWindow(cs)
      const lv = levelsOf(cs)
      expect(w).toHaveLength(20)
      expect(lv.trigger).toBe(Math.max(...w.map((b) => b.h)))
      expect(lv.invalidation).toBe(Math.min(...w.map((b) => b.l)))
    }
  })

  it('lets neither level see today\'s bar, however extreme it is', () => {
    // The drift-proof assertion: today's bar is replaced with the widest bar in
    // the file and NOTHING moves. If either index ever creeps back onto
    // bars[len-1], exactly one of these four expectations goes red.
    const settled = ramp(60)
    const base = levelsOf(settled)
    for (const today of [
      { t: DAY_T(60), o: 100, h: 1e6, l: 1e-6, c: 100, v: 1e6 },   // both ends extreme
      { t: DAY_T(60), o: 100, h: 1e6, l: 100, c: 100, v: 1e6 },    // new high only
      { t: DAY_T(60), o: 100, h: 100, l: 1e-6, c: 100, v: 1e6 },   // new low only
    ]) {
      const lv = levelsOf([...settled.slice(0, -1), today])
      expect(lv.trigger).toBe(base.trigger)
      expect(lv.invalidation).toBe(base.invalidation)
    }
  })

  it('needs the same 21 bars for both, and falls back for both together', () => {
    // 20 bars cannot yield 20 CLOSED bars. Before the fix the invalidation took
    // that deal and the trigger did not, so one level came off candles and the
    // other off the sparkline with nothing on screen saying so.
    const short = levelsOf(ramp(20))
    expect(short.triggerBasis).toMatch(/sparkline/)
    expect(short.invalidationBasis).toMatch(/sparkline/)
    expect(short.trigger).toBe(10.4)          // range7d.priorHigh
    expect(short.invalidation).toBe(9.5)      // range7d.low

    const enough = levelsOf(ramp(21))
    expect(enough.triggerBasis).toBe('prior 20-day high')
    expect(enough.invalidationBasis).toBe('20-day base low')
  })

  it('makes the EXIT-on-invalidation rung reachable on a live tape', () => {
    // The reviewer's reproduction: a held position, down 70%, that has broken
    // every low in the file. With today's bar inside the window the invalidation
    // WAS today's own low (50), price 60 sat above it, and the directive said
    // "Hold your 10 FOO — nothing has changed."
    const falling = [
      ...Array.from({ length: 40 }, (_, i) => ({ t: DAY_T(i), o: 130, h: 140, l: 125.44 + (39 - i) * 2, c: 130, v: 1e6 })),
      { t: DAY_T(40), o: 70, h: 70, l: 50, c: 60, v: 1e6 },
    ]
    const d = altDirective(ready({
      candles: falling,
      screened: screened({ price: 60, band: 'dead', score: 20, flags: { ...screened().flags, freshBreak: false } }),
      position: { units: 10, avgEntry: 200 },
      plan: plan({ stop: { stop: 10, basis: 'pct', detail: '', warning: null, floored: false } }),
    }))
    expect(d.levels.invalidation).toBe(125.44)
    expect(d.levels.invalidation).toBeGreaterThan(60)     // a level ABOVE the live price is now possible
    expect(d.action).toBe('EXIT')
    expect(d.severity).toBe('urgent')
    expect(d.reasons.join(' ')).toMatch(/lost the base low \$125\.44 \(20-day base low\)/)
  })

  it('does not walk the invalidation down with price day after day', () => {
    // The other half of the same bug: the number a user writes down has to stay
    // put while price falls, or it is not a level. Three successive down days
    // against an unchanged base leave the level untouched.
    const base = Array.from({ length: 40 }, (_, i) => ({ t: DAY_T(i), o: 100, h: 101, l: 99, c: 100, v: 1e6 }))
    const seen = []
    for (const [i, low] of [[40, 90], [41, 80], [42, 70]]) {
      base.push({ t: DAY_T(i), o: low + 5, h: low + 5, l: low, c: low + 1, v: 1e6 })
      seen.push(levelsOf(base, low + 1).invalidation)
    }
    expect(seen[0]).toBe(99)                 // the settled base low, not today's 90
    // Once a broken low has itself CLOSED it legitimately enters the window —
    // the level moves because the base moved, not because price ticked.
    expect(seen[1]).toBe(90)
    expect(seen[2]).toBe(80)
  })

  it('prices targets off measured forward returns, with the worst case in the basis', () => {
    const d = altDirective(ready())
    expect(d.levels.targets).toHaveLength(2)
    expect(d.levels.targets[0].label).toBe('21-day median')
    expect(d.levels.targets[0].price).toBeCloseTo(11 * 1.38, 8)
    expect(d.levels.targets[0].basis).toMatch(/median 21-day return after 5 prior ignitions was \+38\.0%; worst 21d in that sample -18\.0%/)
    expect(d.levels.targets[1].price).toBeCloseTo(11 * 1.61, 8)
  })

  it('invents no target when there is no base rate behind one', () => {
    for (const p of [NO_PRECEDENT, null, { ok: true, baseRates: null }]) {
      const d = altDirective(ready({ precedent: p }))
      expect(d.levels.targets).toEqual([])
    }
    expect(altDirective(ready({ precedent: null })).guardrails.join(' ')).toMatch(/no precedent read was run/)
    expect(altDirective(ready({ precedent: NO_PRECEDENT })).guardrails.join(' ')).toMatch(/no usable precedent: only 2 comparable episodes/)
  })
})

/* ══ 6c — WHAT THE SCHEDULED SENTINEL CAN ACTUALLY EMIT ════════════════════
 *
 * netlify/functions/alt-watch.mjs alerts on a set of directive actions, and that
 * set once listed four rungs this call shape can never reach: it calls
 * altDirective with no sizing plan and no position, and the ladder gates
 * ENTER/STARTER/ARM/ADD on a computed size and EXIT/TRIM on a held position. An
 * alert set naming states that have never fired once is the trap altrisk.js's
 * header calls out — "a value the contract lists but the code can never produce
 * is a bug waiting for a reader" — and it hid the fact that the alert that
 * matters most, a break going live while you are away, had no rung of its own.
 *
 * The sweep below is driven through the sentinel's OWN safeDirective, not a
 * reconstruction of it, so the two cannot drift: change what that pass passes in
 * and this test tells you what the alert set is now allowed to contain.
 */

describe('the sentinel\'s call shape', () => {
  const BANDS = ['dead', 'basing', 'waking', 'igniting', 'running', 'extended']
  const SEASONS = ['risk_off', 'btc_only', 'btc_leads', 'majors_rotating', 'alt_season', 'euphoric', 'unknown']
  const SPARK = { low: 9, high: 11, last: 10, pos: 0.5, freshBreak: true, priorHigh: 11, points: 168 }
  const NO_SPARK = { low: null, high: null, last: null, pos: null, freshBreak: false, priorHigh: null, points: 0 }

  /** Every action the sentinel can produce, over every combination of the inputs
   *  a screened watchlist row can carry. */
  const sweep = () => {
    const seen = new Set()
    let n = 0
    for (const band of BANDS) {
      for (let score = 0; score <= 100; score += 5) {
        for (const parabolic of [false, true]) {
          for (const thinLiquidity of [false, true]) {
            for (const freshBreak of [false, true]) {
              for (const newListing of [false, true]) {
                for (const price of [null, 8, 10, 12]) {
                  for (const range7d of [SPARK, NO_SPARK]) {
                    for (const phase of SEASONS) {
                      n++
                      const row = screened({
                        price, score, band, range7d,
                        vol24h: thinLiquidity ? 1e5 : 2e7,
                        chg24h: parabolic ? 47 : 3, chg7d: parabolic ? 130 : 6,
                        flags: { stablecoin: false, wrapper: false, parabolic, thinLiquidity, freshBreak, newListing },
                      })
                      seen.add(safeDirective(row, season({ phase, label: phase }), NOW)?.action)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    return { seen, n }
  }

  it('can only ever produce four of the ten actions, and the alert set is a subset of those', () => {
    const { seen, n } = sweep()
    expect(n).toBeGreaterThan(100_000)
    expect([...seen].sort()).toEqual(['AVOID', 'NO_DATA', 'STALK', 'WATCH'])
    // Six rungs are unreachable BY CONSTRUCTION from this call shape. Named one
    // by one so that making any of them reachable — by giving the pass a sizing
    // plan or a position book — fails here and forces the alert set to be
    // reconsidered rather than silently left behind.
    for (const unreachable of ['ENTER', 'STARTER', 'ARM', 'ADD', 'EXIT', 'TRIM']) {
      expect([...seen]).not.toContain(unreachable)
    }
    for (const a of ACTIONABLE) expect([...seen]).toContain(a)
  })

  it('does not buzz for the two states that are not verdicts', () => {
    // WATCH is "nothing to do" and NO_DATA is a condition of our feed, not of
    // the market. A phone that buzzes for either gets silenced, which takes the
    // alerts that matter with it.
    expect(ACTIONABLE.has('WATCH')).toBe(false)
    expect(ACTIONABLE.has('NO_DATA')).toBe(false)
    expect(ACTIONABLE.size).toBeGreaterThan(0)
  })

  it('reaches AVOID and STALK on inputs a real watchlist row can carry', () => {
    const thin = screened({ vol24h: 1.4e5, flags: { ...screened().flags, thinLiquidity: true } })
    expect(safeDirective(thin, season(), NOW).action).toBe('AVOID')

    const basing = screened({ price: 10, band: 'basing', score: 52, range7d: SPARK, flags: { ...screened().flags, freshBreak: false } })
    expect(safeDirective(basing, season(), NOW).action).toBe('STALK')
  })

  // The alert that matters most. The sentinel has no candles, so the levels come
  // off the 7-day sparkline — but they ARE levels, they are computed, and their
  // edges are what "something is popping off while I am away" is made of.
  it('publishes a level test the sentinel can watch the edge of, with no candles at all', () => {
    const below = safeDirective(screened({ price: 10, range7d: SPARK }), season(), NOW)
    const above = safeDirective(screened({ price: 12, range7d: SPARK }), season(), NOW)
    expect(below.levels.trigger).toBe(11)
    expect(below.levels.triggerBasis).toMatch(/7-day sparkline/)
    expect(below.levels.triggerLive).toBe(false)
    expect(above.levels.triggerLive).toBe(true)
    expect(transitionOf(
      { band: 'basing', action: 'WATCH', triggerAbove: below.levels.triggerLive, invalidated: below.levels.invalidated },
      { band: 'basing', action: 'WATCH', triggerAbove: above.levels.triggerLive, invalidated: above.levels.invalidated },
    )).toEqual({ fired: true, why: ['trigger fired'] })
  })

  it('sends turnover to the phone in the units the board renders it in', () => {
    // `row.turnover` is the raw fraction vol24h ÷ mcap. screen.js labels it
    // "12.0% of cap", AltBoard renders "12%", and this line used to print
    // `turnover 0.12×` — the same field, a second unit, and a multiplier suffix
    // that makes a heavy day look like a light one. The alert has to carry the
    // number the board it points at is showing.
    const row = screened({ turnover: 0.12, chg24h: 12.3, chg7d: 40, score: 88, symbol: 'PEPE' })
    const curr = { band: 'igniting', action: 'STALK', triggerAbove: true, invalidated: false }
    const line = alertLine({ id: 'pepe', symbol: 'PEPE' }, row, ['basing → igniting'], curr, safeDirective(row, season(), NOW))
    expect(line).toContain('turnover 12.0% of cap')
    expect(line).not.toMatch(/turnover [\d.]+×/)
    expect(line).toContain('24h +12.3%')
    // What AltBoard puts on the same row. The assertion is on the UNIT and the
    // magnitude, not on the board's rounding — the two surfaces are allowed to
    // choose different decimals, they are not allowed to choose different units.
    expect(turnText(row.turnover)).toMatch(/^12(\.0)?%$/)
    // …and a row with no turnover prints nothing rather than a zero.
    expect(alertLine({ id: 'x' }, screened({ turnover: null }), [], curr, null)).not.toContain('turnover')
  })

  it('builds a line out of anything, because this file may never throw', () => {
    // A scheduled function that 500s writes no dominance row, and a hole in that
    // series can never be backfilled. So the formatter normalises rather than
    // trusting, even though its only caller builds its arguments itself.
    for (const junk of [undefined, null, 0, '', NaN, {}, [], 'x', true]) {
      expect(() => alertLine({ id: 'x' }, screened(), junk, junk, junk)).not.toThrow()
      expect(typeof alertLine({ id: 'x' }, screened(), junk, junk, junk)).toBe('string')
    }
  })

  it('names the level that fired, and which basis it came off', () => {
    // The sentinel has no candles, so this is the WEAKER sparkline level. A user
    // holding the alert next to the tab has to be able to tell which one moved.
    const row = screened({ price: 12, range7d: { low: 9, high: 12, last: 12, pos: 1, freshBreak: true, priorHigh: 11, points: 168 } })
    const curr = { band: 'igniting', action: 'WATCH', triggerAbove: true, invalidated: false }
    const line = alertLine({ id: 'x' }, row, ['trigger fired'], curr, safeDirective(row, season(), NOW))
    expect(line).toContain('trigger fired')
    expect(line).toContain('cleared $11.00 — prior 6-day high from the 7-day sparkline (no candle history)')
  })

  it('treats an unmeasured level as unmeasured, not as an un-fired one', () => {
    // A row with no sparkline has no trigger. Alerting on null → true would fire
    // on the day the data arrived rather than on the day price broke, which is
    // how a sentinel earns a mute.
    const blind = safeDirective(screened({ price: 12, range7d: NO_SPARK }), season(), NOW)
    expect(blind.levels.triggerLive).toBeNull()
    expect(transitionOf(
      { band: 'basing', action: 'WATCH', triggerAbove: null, invalidated: null },
      { band: 'basing', action: 'WATCH', triggerAbove: true, invalidated: false },
    ).fired).toBe(false)
  })
})

/* ══ 7 — degrade, don't crash ══════════════════════════════════════════════ */

describe('every shape of garbage is a normal input', () => {
  const junk = [undefined, null, 0, '', NaN, Infinity, -1, {}, [], 'x', true]

  it('never throws', () => {
    for (const j of junk) {
      expect(() => altDirective(j)).not.toThrow()
      expect(() => altDirective({
        screened: j, season: j, precedent: j, crowd: j, phase: j, plan: j,
        position: j, candles: j, freshness: j, candleQuality: j, now: j,
      })).not.toThrow()
    }
  })

  it('always returns the full contract shape, whatever it was handed', () => {
    for (const j of junk) {
      const d = altDirective({ screened: j, plan: j, freshness: j, candles: j })
      expect(typeof d.action).toBe('string')
      expect(typeof d.headline).toBe('string')
      expect(Array.isArray(d.reasons)).toBe(true)
      expect(Array.isArray(d.guardrails)).toBe(true)
      expect(['info', 'act', 'urgent']).toContain(d.severity)
      expect(Array.isArray(d.levels.targets)).toBe(true)
    }
  })

  it('only ever emits an action the contract lists', () => {
    const ACTIONS = ['NO_DATA', 'AVOID', 'WATCH', 'STALK', 'ARM', 'STARTER', 'ENTER', 'ADD', 'TRIM', 'EXIT']
    const variants = []
    for (const price of [9.1, 9.95, 11, 18]) {
      for (const band of ['dead', 'basing', 'waking', 'igniting', 'running', 'extended']) {
        for (const position of [null, { units: 120, avgEntry: 9.0 }, { units: 5, avgEntry: 12 }]) {
          for (const s of [season(), HOSTILE]) {
            variants.push(altDirective(ready({ screened: screened({ price, band }), position, season: s })))
          }
        }
      }
    }
    for (const d of variants) expect(ACTIONS).toContain(d.action)
    expect(variants.length).toBeGreaterThan(100)
  })

  it('drops null reasons rather than rendering an empty bullet', () => {
    for (const d of [altDirective(ready()), altDirective(ready({ position: { units: 1, avgEntry: 9 } })), altDirective({})]) {
      expect(d.reasons.every((x) => typeof x === 'string' && x.length > 0)).toBe(true)
    }
  })

  it('trusts an explicit candleQuality over its own detection', () => {
    const d = altDirective(ready({ candleQuality: 'close-only' }))
    expect(d.guardrails.join(' ')).toMatch(/CLOSE-ONLY/)
    expect(d.action).toBe('STARTER')
  })

  it('surfaces an unchecked liquidity cap as a guardrail rather than as silence', () => {
    const d = altDirective(ready({ plan: plan({ size: { ...plan().size, liquidityUnknown: true, advPct: null } }) }))
    expect(d.guardrails.join(' ')).toMatch(/liquidity cap could not be applied/)
  })
})
