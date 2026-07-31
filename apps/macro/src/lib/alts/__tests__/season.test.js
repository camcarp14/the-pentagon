// seasonRead has three properties worth defending with tests: the score is
// arithmetic anyone can redo on a phone (so every case below states the sum);
// the dominance trend is the one number in the app that is allowed to say "I
// don't know" — because it is fed by a cron that has not run yet on the day this
// ships, and a fabricated trend there would move the phase label, which is the
// first thing read on the tab; and NOTHING THAT WAS NOT MEASURED CONTRIBUTES A
// POINT.
//
// That last one is why the whole midpoint block in this file was rewritten. The
// scoring used to hand a missing dominance trend 10 points, a missing ETH row 5
// and a failed fear & greed fetch 5, and the day-one state of this product is
// all three at once: 20 points on a 22/40/55/72 ladder that no fetched value
// produced, feeding a phase that directive.js gates ENTER on. The tests below
// pin the replacement — drop the part from both sides and renormalise — at both
// ends, because a rule that only fires on the flattering side is not a rule.
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
  // dominance falling → 20 · ETH/BTC up on both windows → 10 · F&G 65 → 7
  //                                                              = 71 of 100
  it('scores a fully measured read at the sum of its parts', () => {
    const s = seasonRead({
      universe: makeUniverse({ beat7: 63, beat30: 48 }), btcRow: BTC, ethRow: eth(12, 30),
      fearGreed: { value: 65, label: 'Greed' }, domHistory: domHist(30, 56, 54),
    })
    expect(s.parts.map((p) => [p.key, p.points])).toEqual([
      ['breadth7', 22], ['breadth30', 12], ['dominance', 20], ['ethbtc7', 5], ['ethbtc30', 5], ['feargreed', 7],
    ])
    expect(s.parts.every((p) => p.measured)).toBe(true)
    expect(s.measured).toEqual({ earned: 71, of: 100 })
    expect(s.coverage).toBe(1)
    expect(s.score).toBe(71)
    expect(s.phase).toBe('majors_rotating')
    // Nothing is unread, so the band has no width and the phase is the phase.
    expect(s.bounds).toEqual({ low: 71, high: 71 })
  })

  // The maxes are FIXED, so they add to 100 whatever answered — which is the
  // only reason `100 − of` can be trusted to equal the points that went
  // unmeasured. It shipped with an ETH/BTC part whose max shrank from 10 to 5
  // when one leg resolved: the achievable total became 95, the card's "every
  // input was measured" line could never fire again, and its "the other N are in
  // neither half of the fraction" said 30 while the parts it could name were
  // worth 25.
  it('always offers exactly 100 points, and never claims to have dropped more than it can name', () => {
    for (const ethRow of [null, eth(9, null), eth(9, 12), eth(-9, -12)]) {
      for (const btc30 of [7, null]) {
        for (const dom of [domHist(30, 56, 54), null]) {
          for (const fgv of [65, null]) {
            const s = seasonRead({
              universe: makeUniverse({ beat7: 60, beat30: 60 }), btcRow: { ...BTC, chg30d: btc30 },
              ethRow, domHistory: dom, fearGreed: fgv == null ? null : { value: fgv },
            })
            expect(s.parts.reduce((a, p) => a + p.max, 0)).toBe(100)
            const unnamed = s.parts.filter((p) => !p.measured).reduce((a, p) => a + p.max, 0)
            expect(100 - s.measured.of).toBe(unnamed)
            expect(s.coverage).toBeCloseTo(s.measured.of / 100, 9)
          }
        }
      }
    }
  })

  it('can still say "every input was measured" — the branch the shrinking max made unreachable', () => {
    const s = seasonRead({
      universe: makeUniverse({ beat7: 60, beat30: 60 }), btcRow: BTC, ethRow: eth(9, 12),
      fearGreed: { value: 62 }, domHistory: domHist(30, 56, 54),
    })
    expect(s.measured.of).toBe(100)          // was 100 only when BOTH ETH legs resolved AND the part was one part
    expect(s.parts.every((p) => p.measured)).toBe(true)
  })

  it('the measured parts sum to measured.earned, and the score is that sum renormalised', () => {
    for (const beat7 of [0, 17, 50, 83, 100]) {
      for (const fgv of [0, 39, 65, 100, null]) {
        for (const dom of [domHist(30, 56, 54), null]) {
          const s = seasonRead({
            universe: makeUniverse({ beat7, beat30: beat7 }),
            btcRow: BTC, ethRow: eth(5, 5),
            fearGreed: fgv == null ? null : { value: fgv, label: 'x' },
            domHistory: dom,
          })
          const scored = s.parts.filter((p) => p.measured)
          expect(scored.reduce((a, p) => a + p.points, 0)).toBe(s.measured.earned)
          expect(scored.reduce((a, p) => a + p.max, 0)).toBe(s.measured.of)
          expect(s.measured.of).toBeGreaterThanOrEqual(50)   // every case here publishes
          expect(s.score).toBe(Math.round((100 * s.measured.earned) / s.measured.of))
          expect(s.coverage).toBeCloseTo(s.measured.of / 100, 9)
          expect(s.score).toBeGreaterThanOrEqual(0)
          expect(s.score).toBeLessThanOrEqual(100)
          // The band, and the reason the phase can be trusted: `low` is this
          // market with every unread gauge at zero, `high` with every one of
          // them maxed, and the published number sits between them.
          expect(s.bounds.low).toBe(s.measured.earned)
          expect(s.bounds.high).toBe(s.measured.earned + (100 - s.measured.of))
          expect(s.score).toBeGreaterThanOrEqual(s.bounds.low)
          expect(s.score).toBeLessThanOrEqual(s.bounds.high)
          // An unmeasured part is null on both sides — never a 0 that reads as a
          // measured zero, and never a max that pads the denominator.
          for (const p of s.parts.filter((x) => !x.measured)) expect(p.points).toBeNull()
        }
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

/* ── nothing on screen is a number we did not compute ─────────────────────── */

describe('an unmeasured component is dropped from BOTH sides', () => {
  // THE DAY-ONE STATE, and the exact case that made this rewrite necessary: the
  // dominance cron has never run, CoinGecko's markets call came back without an
  // ETH row, and alternative.me 429'd. Under the midpoint rule this returned 20
  // points — dominance 10 + ETH/BTC 5 + fear & greed 5 — from three feeds that
  // never answered, which is a band and a half on a 22/40/55/72 ladder.
  const dayOne = (beat7, beat30) => seasonRead({
    universe: makeUniverse({ beat7, beat30 }), btcRow: BTC,
    domHistory: null, ethRow: null, fearGreed: null,
  })

  it('scores zero for a market where nothing beat BTC and nothing else was fetched', () => {
    const s = dayOne(0, 0)
    expect(s.score).toBe(0)              // was 20, from three feeds that did not answer
    expect(s.measured).toEqual({ earned: 0, of: 60 })
    // ...and it does NOT call that risk_off any more, which is a deliberate
    // loss and worth stating: the 40 unread points could reach 40, which is
    // btc_leads, so "nothing is rotating" is not established by this read even
    // though 0% breadth is. directive.js's veto is keyed on the phase, so day
    // one at zero breadth now downgrades to STARTER instead of refusing at
    // WATCH. The alternative — naming the rung the unread points cannot reach —
    // is the mirror of the bug this whole gate exists for: it manufactures a
    // hostile tape out of three feeds that never answered. `bounds` is published
    // so the veto can be rebuilt honestly one file over, on `high < 40`.
    expect(s.phase).toBe('unknown')
    expect(s.bounds).toEqual({ low: 0, high: 40 })
    expect(s.label).toBe('Risk off to BTC leads')
  })

  it('renormalises breadth over the points that existed, and nothing else moves it', () => {
    const s = dayOne(50, 50)
    expect(s.parts.map((p) => [p.key, p.points, p.measured])).toEqual([
      ['breadth7', 18, true], ['breadth30', 13, true], ['dominance', null, false],
      ['ethbtc7', null, false], ['ethbtc30', null, false], ['feargreed', null, false],
    ])
    // 31 points earned out of the 60 that were on offer → 52. Every one of those
    // 31 came off a counted row; the three feeds that did not answer are in
    // neither the numerator nor the denominator.
    expect(s.measured).toEqual({ earned: 31, of: 60 })
    expect(s.coverage).toBe(0.6)
    expect(s.score).toBe(52)
    // The same market with every input measured and every tilt sitting in the
    // middle of its own range — dominance flat, ETH edging BTC over one window
    // and level over the other, fear & greed at 50 — scores 51. Renormalising
    // AGREES with the full read; the midpoint dragged the partial one toward the
    // middle from wherever it actually was.
    const full = seasonRead({
      universe: makeUniverse({ beat7: 50, beat30: 50 }), btcRow: BTC,
      ethRow: eth(4, 7), fearGreed: { value: 50, label: 'Neutral' }, domHistory: domHist(30, 56, 56.2),
    })
    expect(full.parts.map((p) => p.points)).toEqual([18, 13, 10, 5, 0, 5])
    expect(full.score).toBe(51)
    // ...and 52 vs 51 is the ONE breadth level where the two agree. That is why
    // the phase above is refused rather than named off the 52: at 72% breadth
    // the same pair reads 72 (alt season) against 58 (majors rotating), and the
    // thinner read was the hotter one. See 'the band' below.
    expect(s.phase).toBe('unknown')
  })

  it('names every input it could not measure, in the same fact as the arithmetic', () => {
    const f = dayOne(50, 50).facts.join('\n')
    expect(f).toMatch(/31 of the 60 points on offer were earned, renormalised to 52 out of 100/)
    expect(f).toMatch(/the dominance trend, ETH\/BTC over 7d, ETH\/BTC over 30d and fear & greed were not measured/)
    expect(f).toMatch(/not evidence about the market in either direction/)
    // and the band, in the same voice, in the fact right after it
    expect(f).toMatch(/the 40 unread points put the fully measured read of this same market between 31 and 71 out of 100/)
  })

  it('drops the part label into "not scored", never into a midpoint', () => {
    for (const p of dayOne(50, 50).parts.filter((x) => !x.measured)) {
      expect(p.label).toMatch(/not scored/)
      expect(p.label).not.toMatch(/midpoint/)
      expect(p.max).toBeGreaterThan(0)   // the UI still shows what it would have been worth
    }
  })

  // UNDER HALF THE POINTS THERE IS NO NUMBER EITHER. This used to publish the
  // renormalised score and refuse only the label, which is how "100 / 100 with
  // all ten pips lit" arrived under the words "Not enough measured" — off the
  // 7-day breadth count and nothing else.
  it('refuses to publish a score at all under half the points, and says what it refused', () => {
    const only7 = makeUniverse({ beat7: 80, beat30: 80 }).map((r) => ({ ...r, chg30d: null }))
    const s = seasonRead({ universe: only7, btcRow: { ...BTC, chg30d: null }, domHistory: null })
    expect(s.measured).toEqual({ earned: 28, of: 35 })
    expect(s.coverage).toBe(0.35)
    expect(s.score).toBeNull()           // was 80, from 35 of the 100 points
    expect(s.phase).toBe('unknown')
    expect(s.label).toBe('Not enough measured')
    expect(s.bounds).toEqual({ low: 28, high: 93 })
    // The arithmetic is not lost, it is just not a score: the plain text carries
    // the band, because the card's coverage line only renders beside a number.
    expect(s.plain).toMatch(/35 of its 100 points/)
    expect(s.plain).toMatch(/anywhere from 28 to 93 out of 100/)
    expect(s.facts.join('\n')).toMatch(/only 35 of the 100 points had an input \(35% coverage\), which is under half/)
    expect(s.facts.join('\n')).toMatch(/more extrapolation than measurement/)
  })

  // The exact reading the re-review measured off one gauge, and the one below it.
  it('cannot print a maxed-out numeral off a single input, at either end of it', () => {
    const all = (v) => makeUniverse({ beat7: 100, beat30: 100 }).map((r) => ({ ...r, chg30d: v }))
    const only7 = seasonRead({ universe: all(null), btcRow: { ...BTC, chg30d: null }, domHistory: null })
    expect(only7.score).toBeNull()       // was 100 / 100, ten pips, "Not enough measured"
    const only30 = seasonRead({
      universe: makeUniverse({ beat7: 90, beat30: 90 }).map((r) => ({ ...r, chg7d: null })),
      btcRow: { ...BTC, chg7d: null }, domHistory: null,
    })
    expect(only30.score).toBeNull()      // was 92 / 100 off 25 points
    // It is arithmetic, not a list of cases: the largest single part is 35 and
    // the floor is 50, so no one gauge can reach it.
    const maxes = seasonRead({
      universe: makeUniverse({}), btcRow: BTC, ethRow: eth(9, 12),
      fearGreed: { value: 62 }, domHistory: domHist(30, 56, 54),
    }).parts.map((p) => p.max)
    expect(Math.max(...maxes)).toBeLessThan(50)
  })

  it('scores each ETH/BTC window as its own part, so the missing one has a name', () => {
    const s = seasonRead({ universe: makeUniverse({}), btcRow: BTC, ethRow: eth(9, null) })
    const p7 = s.parts.find((x) => x.key === 'ethbtc7')
    const p30 = s.parts.find((x) => x.key === 'ethbtc30')
    expect([p7.points, p7.max, p7.measured]).toEqual([5, 5, true])
    expect([p30.points, p30.max, p30.measured]).toEqual([null, 5, false])
    expect(p30.label).toBe('ETH/BTC over 30d unavailable — not scored')
    expect(s.measured.of).toBe(65)       // 35 + 25 + 5 — the 30d leg is not in the denominator
    // ...and the 35 points it says are missing are all named, which is the whole
    // repair: with one part whose max shrank, 5 of them belonged to nobody.
    expect(100 - s.measured.of).toBe(s.parts.filter((x) => !x.measured).reduce((a, x) => a + x.max, 0))
  })
})

/* ── the band, and what it is allowed to name ─────────────────────────────── */

// THE DEFECT THIS BLOCK EXISTS FOR. Renormalising a partial read makes the hot
// end hotter off less evidence: with breadth alone the arithmetic reduces to the
// breadth percentage, so 72% breadth read `alt_season` (72) on day one and
// `majors_rotating` (58) once the same market's tilts were actually fetched at
// neutral. The 50%-coverage gate written to stop it never bound, because day one
// leaves BOTH breadth windows measured — 35 + 25 = 60 of 100 — so a phase was
// named every time and the STARTER downgrade in directive.js never ran.
//
// Every test below fails against that source.
describe('the band: a phase is only named where the unread points cannot move it', () => {
  // The values each tilt can take, INCLUDING the extremes. `rising` is 0 points
  // and `falling` is 20, `down` is 0+0 and `up` is 5+5, `cold` is 0 and `hot` is
  // 10 — so the all-lowest completion earns exactly `bounds.low` and the
  // all-highest exactly `bounds.high`. That is what makes the biconditional at
  // the bottom of this block a proof rather than a spot check.
  const DOM = { rising: domHist(30, 54, 57), flat: domHist(30, 56, 56.2), falling: domHist(30, 56, 54) }
  const ETH = { down: eth(-10, -20), split: eth(12, -20), up: eth(12, 30) }
  const FG = { cold: { value: 0 }, mid: { value: 50 }, hot: { value: 100 } }

  const read = (b, dom, ethK, fgK) => seasonRead({
    universe: makeUniverse({ beat7: b, beat30: b }), btcRow: BTC,
    domHistory: dom == null ? null : DOM[dom],
    ethRow: ethK == null ? null : ETH[ethK],
    fearGreed: fgK == null ? null : FG[fgK],
  })
  // `euphoric` is an overlay on alt_season that needs the fear & greed VALUE
  // rather than its points, so a read with the index missing cannot fire it.
  // That is a warning we cannot make, never a permission we granted, so the
  // comparison below is on the rung.
  const rung = (s) => (s.phase === 'euphoric' ? 'alt_season' : s.phase)
  // Derived from `measured` rather than read off `bounds`, so these tests fail
  // on the BEHAVIOUR against a source that has no bounds field rather than on a
  // missing property. `bounds` is pinned against the same arithmetic above.
  const band = (s) => ({ low: s.measured.earned, high: s.measured.earned + (100 - s.measured.of) })

  it('never names a regime on day one, at any breadth', () => {
    for (let b = 0; b <= 100; b += 5) {
      const s = read(b, null, null, null)
      expect(s.measured.of).toBe(60)
      expect(s.coverage).toBe(0.6)
      expect(s.phase, `breadth ${b}% named a phase off two of five gauges`).toBe('unknown')
      // 40 unread points against a ladder whose widest rung on the 0–100 scale
      // is 28 (alt season, 72→100) — the band cannot fit inside any of them at
      // any breadth, which is why this is arithmetic and not a threshold
      // anyone picked.
      expect(band(s).high - band(s).low).toBe(40)
      expect(s.bounds).toEqual(band(s))
    }
  })

  it('is never hotter than the same market fully measured — it is IDENTICAL or unknown', () => {
    const opts = [
      [null, 'rising', 'flat', 'falling'],
      [null, 'down', 'split', 'up'],
      [null, 'cold', 'mid', 'hot'],
    ]
    let named = 0; let refused = 0
    for (const b of [0, 20, 40, 50, 60, 72, 80, 95, 100]) {
      for (const dom of opts[0]) {
        for (const e of opts[1]) {
          for (const fg of opts[2]) {
            const partial = read(b, dom, e, fg)
            if (partial.phase === 'unknown') { refused++; continue }
            named++
            // Every way this read could have been completed, bracketed by its
            // two extremes — which are the completions that produce exactly
            // bounds.low and bounds.high.
            const lowest = read(b, dom ?? 'rising', e ?? 'down', fg ?? 'cold')
            const highest = read(b, dom ?? 'falling', e ?? 'up', fg ?? 'hot')
            expect(lowest.measured.of).toBe(100)
            expect(highest.measured.of).toBe(100)
            expect(lowest.score).toBe(band(partial).low)
            expect(highest.score).toBe(band(partial).high)
            expect(rung(partial), `breadth ${b} dom=${dom} eth=${e} fg=${fg}`).toBe(rung(lowest))
            expect(rung(partial), `breadth ${b} dom=${dom} eth=${e} fg=${fg}`).toBe(rung(highest))
          }
        }
      }
    }
    expect(named).toBeGreaterThan(200)     // the guarantee is not vacuous
    expect(refused).toBeGreaterThan(20)    // ...and neither is the refusal
  })

  it('does not refuse a phase the unread points could not have changed', () => {
    // The other half of the same rule: no over-refusal. A read that names
    // nothing must be one whose completions genuinely disagree.
    for (const b of [0, 30, 50, 65, 78, 90]) {
      for (const dom of [null, 'flat']) {
        for (const e of [null, 'split']) {
          for (const fg of [null, 'mid']) {
            const s = read(b, dom, e, fg)
            const lowest = read(b, dom ?? 'rising', e ?? 'down', fg ?? 'cold')
            const highest = read(b, dom ?? 'falling', e ?? 'up', fg ?? 'hot')
            const agree = rung(lowest) === rung(highest)
            const publishable = s.measured.of >= 50
            expect(s.phase !== 'unknown', `breadth ${b} dom=${dom} eth=${e} fg=${fg}`)
              .toBe(agree && publishable)
          }
        }
      }
    }
  })

  it('never names a phase without a number, or prints a number outside the phase it named', () => {
    for (const b of [0, 25, 45, 60, 75, 90]) {
      for (const dom of [null, 'rising', 'falling']) {
        for (const e of [null, 'down', 'up']) {
          for (const fg of [null, 'cold', 'hot']) {
            const s = read(b, dom, e, fg)
            if (s.phase === 'unknown') continue
            expect(s.score).not.toBeNull()
            // Every phase named here is the phase the ladder gives the printed
            // number — window.js's law, which is the reason the card can put a
            // numeral and a label side by side at all.
            expect(rung(s)).toBe(rung(read(b, dom ?? 'rising', e ?? 'down', fg ?? 'cold')))
            expect(s.score).toBeGreaterThanOrEqual(band(s).low)
            expect(s.score).toBeLessThanOrEqual(band(s).high)
          }
        }
      }
    }
  })

  it('names the phase again the moment every gauge answers', () => {
    // The gate must not be a permanent refusal — the normal, fully-fetched pass
    // is the one this app spends most of its life in.
    const s = read(78, 'falling', 'up', 'mid')
    expect(s.coverage).toBe(1)
    expect(s.bounds).toEqual({ low: s.score, high: s.score })
    expect(s.phase).toBe('alt_season')
  })

  it('names it on a partial read too, when the missing points cannot reach a boundary', () => {
    // Fear & greed 404s and nothing else: 10 unread points, 90% breadth. The
    // read is 84 at worst and 94 at best — alt season either way, so it is
    // named, and the fact says so rather than hedging.
    const s = read(90, 'falling', 'up', null)
    expect(s.measured).toEqual({ earned: 84, of: 90 })
    expect(s.bounds).toEqual({ low: 84, high: 94 })
    expect(s.phase).toBe('euphoric')     // ≥72 with breadth over 85 — the overlay
    expect(s.facts.join('\n')).toMatch(/at both ends, so the regime below holds whatever those gauges would have said/)
  })
})

/* ── dominance: the honest 'unknown' ──────────────────────────────────────── */

describe('dominance trend comes only from domHistory', () => {
  it('reports unknown with no history at all, and says how many days exist', () => {
    const s = seasonRead({ universe: makeUniverse({}), btcRow: BTC, domHistory: null })
    expect(s.dominance.trend).toBe('unknown')
    expect(s.dominance.days).toBe(0)
    expect(s.dominance.changePctPts).toBeNull()
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
    // A LEVEL is not a trend, and an unknown trend is not worth points. It used
    // to score 10 of 20 here and call that "no evidence either way" — but the
    // ten points are evidence, they are just evidence of nothing.
    const dom = s.parts.find((p) => p.key === 'dominance')
    expect(dom.points).toBeNull()
    expect(dom.measured).toBe(false)
    expect(dom.label).toMatch(/dominance trend unknown \(0 of 7 stored days needed\) — not scored/)
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
    expect(s.dominance.samples).toBe(30)
    expect(s.dominance.spanDays).toBe(29)   // thirty consecutive daily samples span 29 days
    expect(s.dominance.changePctPts).toBeCloseTo(-4.915, 2)
  })

  // A SAMPLE COUNT AND A LENGTH OF TIME ARE DIFFERENT NUMBERS, and this field
  // used to be one name for both: `windowDays: window.length`, rendered on the
  // card as "-1.20pts / 9d". Nine samples from a cron that has been missing two
  // days in three cover most of a month, and the card claimed the move was nine
  // days old.
  it('separates how many samples were used from how long they span', () => {
    const everyThirdDay = Array.from({ length: 10 }, (_, i) => ({ d: dstr(i * 3), btcDom: 58 - i * 0.2 }))
    const s = seasonRead({ universe: makeUniverse({}), btcRow: BTC, domHistory: everyThirdDay })
    expect(s.dominance.samples).toBe(10)
    expect(s.dominance.spanDays).toBe(27)
    expect(s.dominance.changePctPts).toBeCloseTo(-1.8, 6)
    expect(s.facts.join('\n')).toMatch(/BTC dominance falling: -1\.80 points across 27 days \(10 stored samples\)/)
    expect(s.parts.find((p) => p.key === 'dominance').label)
      .toMatch(/BTC dominance falling \(-1\.80 pts across 27d, 10 samples\)/)
  })

  it('reports a span even for a window too thin to produce a trend', () => {
    const s = seasonRead({ universe: makeUniverse({}), btcRow: BTC, domHistory: domHist(4, 57, 56) })
    expect(s.dominance.trend).toBe('unknown')
    expect(s.dominance.samples).toBe(4)
    expect(s.dominance.spanDays).toBe(3)
  })

  it('sorts the samples by date, so an out-of-order blob does not flip the sign', () => {
    const asc = domHist(30, 57, 54)
    const shuffled = [...asc].reverse()
    const a = seasonRead({ universe: makeUniverse({}), btcRow: BTC, domHistory: asc })
    const b = seasonRead({ universe: makeUniverse({}), btcRow: BTC, domHistory: shuffled })
    expect(b.dominance.trend).toBe('falling')
    expect(b.dominance.changePctPts).toBeCloseTo(a.dominance.changePctPts, 9)
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
    expect(s.dominance.samples).toBe(3)
    expect(s.dominance.trend).toBe('unknown')     // not "falling 7 points"
    expect(s.dominance.changePctPts).toBeNull()
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
    // 5 for the leg that resolved, and the leg that did not is worth nothing out
    // of nothing. It used to take the midpoint 2.5 and print 8 of 10, which is a
    // claim about a month of ETH/BTC that was never fetched.
    expect(s.parts.filter((x) => x.key.startsWith('ethbtc')).map((x) => [x.points, x.max]))
      .toEqual([[5, 5], [null, 5]])
  })

  it('returns null with a stated reason when there is no ETH row', () => {
    const s = seasonRead({ universe: makeUniverse({}), btcRow: BTC, ethRow: null })
    expect(s.ethBtc).toBeNull()
    expect(s.facts.join('\n')).toMatch(/ETH\/BTC unavailable/)
    for (const p of s.parts.filter((x) => x.key.startsWith('ethbtc'))) {
      expect(p.points).toBeNull()
      expect(p.measured).toBe(false)
      // Two rows, two distinct sentences: the card lists these labels verbatim
      // and "ETH/BTC unavailable" twice reads like a rendering bug.
      expect(p.label).toMatch(/^ETH\/BTC over (7d|30d) unavailable/)
    }
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
      expect(s.measured).toEqual({ earned: 0, of: 0 })
      expect(s.coverage).toBe(0)
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
      // Not 5 of 10. A feed that answered with junk measured nothing, and the
      // index is the one input where a fabricated middle is also a fabricated
      // "risk appetite is normal".
      expect(s.parts.find((p) => p.key === 'feargreed').points).toBeNull()
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
    expect(f).toMatch(/BTC dominance falling: -1\.80 points across 29 days \(30 stored samples\) — capital is leaving BTC/)
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
      // btc_leads, fully measured: 18 + 13 + 10 + 0 + 5 = 46
      { universe: makeUniverse({ beat7: 50, beat30: 50 }), btcRow: BTC, ethRow: eth(3, 7), fearGreed: { value: 50 }, domHistory: domHist(30, 56, 56.2) },
      { universe: makeUniverse({ beat7: 60, beat30: 55 }), btcRow: BTC, ethRow: eth(12, 2), fearGreed: { value: 65 }, domHistory: domHist(30, 56, 54) },
      { universe: makeUniverse({ beat7: 78, beat30: 72 }), btcRow: BTC, ethRow: eth(12, 30), fearGreed: { value: 65 }, domHistory: domHist(30, 56, 54) },
      { universe: makeUniverse({ beat7: 90, beat30: 80 }), btcRow: BTC, ethRow: eth(12, 30), fearGreed: { value: 85 }, domHistory: domHist(30, 56, 54) },
      {},   // nothing fetched at all — 'No read'
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

  // 'unknown' arrives two ways and they are different refusals: nothing to
  // count at all, and something counted that is not enough of the picture. Both
  // need a sentence, because both are rendered as the top-of-tab answer.
  it('gives all three flavours of unknown their own sentence', () => {
    const nothing = seasonRead({})                       // nothing to count at all
    const thin = seasonRead({                            // counted, under half the points
      universe: makeUniverse({ beat7: 60, beat30: 60 }).map((r) => ({ ...r, chg30d: null })),
      btcRow: { ...BTC, chg30d: null }, domHistory: null,
    })
    const span = seasonRead({                            // a number, straddling a boundary
      universe: makeUniverse({ beat7: 60, beat30: 60 }), btcRow: BTC, domHistory: null,
    })
    for (const s of [nothing, thin, span]) {
      expect(s.phase).toBe('unknown')
      expect(s.plain.length).toBeGreaterThan(30)
    }
    expect(new Set([nothing.label, thin.label, span.label]).size).toBe(3)
    expect(new Set([nothing.plain, thin.plain, span.plain]).size).toBe(3)
    expect(nothing.score).toBeNull()
    expect(thin.score).toBeNull()
    expect(span.score).toBe(60)
    // The one that still carries a number says what the number does and does not
    // establish, in the sentence printed beside it.
    expect(span.label).toBe('BTC only to Alt season')
    expect(span.plain).toMatch(/60 out of 100 assumes the 40 points we could not read/)
    expect(span.plain).toMatch(/anywhere from 36 to 76/)
  })
})
