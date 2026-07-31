// Alt sizing decides how much of a real account goes into something that trades
// $400k a day. The invariants worth pinning, in the order they cost money:
//
//   1. The LIQUIDITY cap is a real cap and it binds before the equity cap on
//      every small coin. This is the whole reason the file exists.
//   2. Risk never exceeds the budget. Fractional rounding is always DOWN.
//   3. A stop is a price, and prices are positive — a 4×ATR stop on a coin whose
//      daily range is a quarter of its price is a negative number, routinely.
//   4. Every failure is a named code with units: 0. Never a throw: these run
//      inside a render.
import { describe, it, expect } from 'vitest'
import { tierDefaults, altStop, altSize } from '../altrisk.js'

const TIERS = ['major', 'mid', 'small', 'micro']

/* ══ tier defaults ═════════════════════════════════════════════════════════ */

describe('tierDefaults', () => {
  it('moves every column in the same direction as the coin gets smaller', () => {
    const d = TIERS.map((t) => tierDefaults(t, 'unknown'))
    for (let i = 1; i < d.length; i++) {
      expect(d[i].atrMult).toBeGreaterThan(d[i - 1].atrMult)          // wider stop
      expect(d[i].maxPositionPct).toBeLessThan(d[i - 1].maxPositionPct) // smaller position
      expect(d[i].maxAdvPct).toBeLessThan(d[i - 1].maxAdvPct)         // smaller share of volume
      expect(d[i].riskFraction).toBeLessThan(d[i - 1].riskFraction)   // smaller risk unit
      expect(d[i].stopFloorPct).toBeGreaterThan(d[i - 1].stopFloorPct) // noisier
    }
  })

  // The asymmetry is the point: a meme gets more room to breathe AND less money
  // behind it, because a wider stop at the same size is simply more at risk.
  it('gives a meme a wider stop and a smaller position than a utility coin of the same size', () => {
    for (const tier of TIERS) {
      const meme = tierDefaults(tier, 'meme')
      const util = tierDefaults(tier, 'utility')
      expect(meme.atrMult).toBeGreaterThan(util.atrMult)
      expect(meme.stopFloorPct).toBeGreaterThan(util.stopFloorPct)
      expect(meme.maxPositionPct).toBeLessThan(util.maxPositionPct)
      expect(meme.riskFraction).toBeLessThanOrEqual(util.riskFraction)
    }
  })

  it('gives an unclassified coin the tier default, not the utility bonus', () => {
    const unknown = tierDefaults('mid', 'unknown')
    const util = tierDefaults('mid', 'utility')
    expect(unknown.maxPositionPct).toBe(5)
    expect(util.maxPositionPct).toBeGreaterThan(unknown.maxPositionPct)
    expect(unknown.kind).toBe('unknown')
  })

  // A market cap we could not read is not evidence of a large one. The failure
  // mode of guessing high here is a full-size position in something unsellable.
  it('resolves an unknown or missing tier to micro, not to a middle value', () => {
    for (const t of [undefined, null, 'unknown', 'huge', 42, {}]) {
      expect(tierDefaults(t, 'unknown')).toEqual(tierDefaults('micro', 'unknown'))
    }
  })

  it('never throws, whatever it is handed', () => {
    for (const t of [undefined, null, NaN, [], {}, 'x']) {
      for (const k of [undefined, null, NaN, [], {}, 'x']) {
        expect(() => tierDefaults(t, k)).not.toThrow()
      }
    }
  })
})

/* ══ altStop ═══════════════════════════════════════════════════════════════ */

describe('altStop', () => {
  it('places an ATR stop at price − mult×ATR and shows its work', () => {
    const s = altStop({ mode: 'atr', price: 100, atr: 6, atrMult: 3 })
    expect(s.stop).toBe(82)
    expect(s.basis).toBe('atr')
    expect(s.warning).toBeNull()
    expect(s.detail).toMatch(/3×ATR\(\$6\.00\) below \$100\.00/)
  })

  it('places a structure stop under the swing low with an ATR pad', () => {
    const s = altStop({ mode: 'structure', price: 100, atr: 6, swingLow: 88, padAtr: 0.5 })
    expect(s.stop).toBe(85)
    expect(s.detail).toMatch(/swing low \$88\.00 minus 0\.5×ATR pad/)
  })

  it('places a percent stop and needs nothing but a price', () => {
    expect(altStop({ mode: 'percent', price: 2.5, pct: 20 }).stop).toBeCloseTo(2, 10)
  })

  // risk.js earned this guard on MSTR as an edge case. On alts it is routine.
  it('refuses a stop at or below zero instead of returning it as a level', () => {
    const s = altStop({ mode: 'atr', price: 0.004, atr: 0.0012, atrMult: 4 })
    expect(s.stop).toBeNull()
    expect(s.warning).toBe('stop_below_zero')
    expect(s.detail).toMatch(/×ATR/)   // it still says what it tried
  })

  it('refuses a stop that is not below the price', () => {
    expect(altStop({ mode: 'structure', price: 10, atr: 1, swingLow: 14 }).warning).toBe('stop_not_below_price')
  })

  it('returns a named code for every missing input rather than a number', () => {
    expect(altStop({ mode: 'atr', price: 10 }).warning).toBe('no_atr')
    expect(altStop({ mode: 'structure', price: 10, atr: 1 }).warning).toBe('no_structure')
    expect(altStop({ mode: 'percent', price: 10, pct: 0 }).warning).toBe('bad_input')
    expect(altStop({ mode: 'percent', price: 10, pct: 100 }).warning).toBe('bad_input')
    expect(altStop({ mode: 'moon', price: 10 }).warning).toBe('bad_input')
    expect(altStop({ mode: 'atr', price: 0, atr: 1 }).warning).toBe('bad_input')
    expect(altStop().warning).toBe('bad_input')
  })

  describe('the tier noise floor', () => {
    it('is off unless the caller asks for it, so the contract signature is unchanged', () => {
      const s = altStop({ mode: 'percent', price: 100, pct: 5 })
      expect(s.stop).toBe(95)
      expect(s.floored).toBe(false)
    })

    it('widens a stop that sits inside the coin\'s own noise, and says why', () => {
      const s = altStop({ mode: 'percent', price: 100, pct: 5, stopFloorPct: 25 })
      expect(s.stop).toBe(75)
      expect(s.floored).toBe(true)
      expect(s.detail).toMatch(/widened to the 25% tier floor/)
      expect(s.detail).toMatch(/inside this coin's own noise/)
    })

    it('leaves a stop that is already wider than the floor alone', () => {
      const s = altStop({ mode: 'atr', price: 100, atr: 12, atrMult: 3, stopFloorPct: 25 })
      expect(s.stop).toBe(64)
      expect(s.floored).toBe(false)
    })
  })

  it('never throws', () => {
    for (const junk of [undefined, null, NaN, Infinity, '10', {}, [], true]) {
      for (const mode of ['atr', 'structure', 'percent', junk]) {
        expect(() => altStop({ mode, price: junk, atr: junk, atrMult: junk, swingLow: junk, pct: junk, padAtr: junk, stopFloorPct: junk })).not.toThrow()
      }
    }
  })
})

/* ══ altSize — the liquidity cap ═══════════════════════════════════════════ */

describe('altSize', () => {
  // The scenario in the contract, priced out. $100k account, 1% risk, a coin at
  // $1 with a stop at $0.80. The risk budget wants $5,000 of it; 5% of equity
  // allows $5,000; the coin trades $400k a day and 0.1% of that is $400.
  it('caps at a fraction of daily volume, and that cap binds before the equity cap', () => {
    const r = altSize({
      equity: 100_000, riskPct: 1, price: 1, stop: 0.8,
      vol24h: 400_000, maxPositionPct: 5, maxAdvPct: 0.1,
    })
    expect(r.ok).toBe(true)
    expect(r.caps).toEqual({ risk: 5000, position: 5000, liquidity: 400 })
    expect(r.capped).toBe('liquidity')
    expect(r.reduced).toBe(true)
    expect(r.units).toBe(400)
    expect(r.notional).toBe(400)
    expect(r.advPct).toBe(0.1)
    expect(r.positionPct).toBe(0.4)
    // And the honest risk is the risk of the size we can actually hold.
    expect(r.riskUsd).toBe(80)
  })

  it('lets the equity cap bind when the coin is liquid enough not to care', () => {
    const r = altSize({
      equity: 100_000, riskPct: 2, price: 1, stop: 0.8,
      vol24h: 900_000_000, maxPositionPct: 5, maxAdvPct: 0.5,
    })
    expect(r.capped).toBe('position')
    expect(r.notional).toBe(5000)
    expect(r.positionPct).toBe(5)
  })

  it('names the risk budget as the binding constraint when nothing cuts it', () => {
    const r = altSize({
      equity: 100_000, riskPct: 0.5, price: 1, stop: 0.8,
      vol24h: 900_000_000, maxPositionPct: 5, maxAdvPct: 0.5,
    })
    expect(r.capped).toBe('risk')
    expect(r.reduced).toBe(false)      // this is the flag a "CAPPED" badge reads
    expect(r.riskUsd).toBe(500)
  })

  it('never lets the notional exceed any of the three ceilings', () => {
    for (const vol24h of [50_000, 400_000, 12_000_000, 5e9]) {
      for (const riskPct of [0.25, 1, 3]) {
        for (const price of [0.0000072, 0.42, 96_000]) {
          const r = altSize({ equity: 250_000, riskPct, price, stop: price * 0.7, vol24h, maxPositionPct: 3, maxAdvPct: 0.2 })
          if (!r.ok) continue
          // caps are reported to the cent, so the tolerance is a cent.
          expect(r.notional).toBeLessThanOrEqual(r.caps.risk + 0.01)
          expect(r.notional).toBeLessThanOrEqual(r.caps.position + 0.01)
          expect(r.notional).toBeLessThanOrEqual(r.caps.liquidity + 0.01)
          expect(r.riskUsd).toBeLessThanOrEqual(250_000 * riskPct / 100 + 0.01)
        }
      }
    }
  })

  it('sizes without a liquidity check when volume is missing, and SAYS the cap was not applied', () => {
    const r = altSize({ equity: 100_000, riskPct: 1, price: 1, stop: 0.8, vol24h: null, maxPositionPct: 5, maxAdvPct: 0.1 })
    expect(r.ok).toBe(true)
    expect(r.liquidityUnknown).toBe(true)
    expect(r.advPct).toBeNull()
    expect(r.caps.liquidity).toBeNull()
    expect(r.capped).not.toBe('liquidity')
  })

  it('rejects a ticket under the minimum by name, rather than returning dust', () => {
    // 0.1% of a $12k/day coin is $12 — a real cap, and a pointless position.
    const r = altSize({ equity: 100_000, riskPct: 1, price: 0.0004, stop: 0.0003, vol24h: 12_000, maxPositionPct: 3, maxAdvPct: 0.1, minTicketUsd: 25 })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('below_min_ticket')
    expect(r.units).toBe(0)
    expect(r.notional).toBe(12)        // reported, because "$12 against $25" is actionable
    expect(r.minTicketUsd).toBe(25)
    expect(r.capped).toBe('liquidity') // and it says which cap made it that small
  })

  it('rounds fractional units DOWN to six significant digits, so risk is never rounded up', () => {
    const r = altSize({ equity: 100_000, riskPct: 1, price: 3.7, stop: 2.3, vol24h: 5e9, maxPositionPct: 50, maxAdvPct: 5 })
    expect(r.units).toBe(714.285)                 // not 714.2857…, and not rounded up
    expect(r.riskUsd).toBeLessThanOrEqual(1000)
    expect(r.riskUsd).toBeGreaterThan(999)
  })

  it('keeps six significant digits at both ends of the price range', () => {
    const tiny = altSize({ equity: 100_000, riskPct: 1, price: 0.00000723, stop: 0.0000058, vol24h: 5e9, maxPositionPct: 50, maxAdvPct: 5 })
    expect(tiny.ok).toBe(true)
    expect(String(Number(tiny.units.toPrecision(6)))).toBe(String(tiny.units))
    expect(tiny.units).toBeGreaterThan(1e6)

    const big = altSize({ equity: 1_000_000, riskPct: 1, price: 96_000, stop: 88_000, vol24h: 5e10, maxPositionPct: 50, maxAdvPct: 5 })
    expect(big.ok).toBe(true)
    expect(big.units).toBeGreaterThan(0)
    expect(big.units % 1).not.toBe(0)             // fractional units, not whole "shares"
  })

  it('refuses a stop at or above the price instead of returning a negative size', () => {
    for (const stop of [1, 1.4]) {
      const r = altSize({ equity: 100_000, riskPct: 1, price: 1, stop, vol24h: 1e9 })
      expect(r.ok).toBe(false)
      expect(r.error).toBe('stop_not_below_price')
      expect(r.units).toBe(0)
    }
  })

  it('returns bad_input for anything non-finite instead of NaN units', () => {
    const base = { equity: 100_000, riskPct: 1, price: 1, stop: 0.8, vol24h: 1e9, maxPositionPct: 5, maxAdvPct: 0.5 }
    const junk = [NaN, Infinity, -Infinity, null, '100', {}, []]
    // `undefined` is only a failure for the fields with no default. On the three
    // that have one it means "use the default", which is the documented call.
    for (const k of ['equity', 'riskPct', 'price', 'stop']) {
      for (const v of [...junk, undefined]) {
        const r = altSize({ ...base, [k]: v })
        expect(r.ok).toBe(false)
        expect(r.error).toBe('bad_input')
        expect(r.units).toBe(0)
        expect(Number.isNaN(r.units)).toBe(false)
      }
    }
    for (const k of ['maxPositionPct', 'maxAdvPct', 'minTicketUsd']) {
      for (const v of junk) expect(altSize({ ...base, [k]: v }).error).toBe('bad_input')
      expect(altSize({ ...base, [k]: undefined }).ok).toBe(true)
    }
  })

  it('rejects non-positive settings that would otherwise size an infinite position', () => {
    const base = { equity: 100_000, riskPct: 1, price: 1, stop: 0.8, vol24h: 1e9 }
    for (const over of [{ equity: 0 }, { riskPct: 0 }, { price: 0 }, { maxPositionPct: 0 }, { maxAdvPct: 0 }, { equity: -5 }]) {
      expect(altSize({ ...base, ...over }).error).toBe('bad_input')
    }
  })

  it('never throws', () => {
    for (const junk of [undefined, null, NaN, Infinity, '5', {}, [], true, -1]) {
      expect(() => altSize({ equity: junk, riskPct: junk, price: junk, stop: junk, vol24h: junk, maxPositionPct: junk, maxAdvPct: junk, minTicketUsd: junk })).not.toThrow()
    }
    expect(() => altSize()).not.toThrow()
    expect(altSize().ok).toBe(false)
  })
})

/* ══ the two files together ════════════════════════════════════════════════ */

describe('tierDefaults → altStop → altSize, as the UI calls them', () => {
  it('sizes a $400k/day micro-cap meme into something a human can actually exit', () => {
    const d = tierDefaults('micro', 'meme')
    // 4.8×ATR on a quiet day is still only 11% away on a coin whose tier floor
    // is 33.75%, so the floor is what actually sets this stop.
    const stop = altStop({ mode: 'atr', price: 0.0042, atr: 0.0001, atrMult: d.atrMult, stopFloorPct: d.stopFloorPct })
    // riskFraction is applied by the CALLER, which is what this line documents.
    const size = altSize({
      equity: 100_000, riskPct: 1 * d.riskFraction, price: 0.0042, stop: stop.stop,
      vol24h: 400_000, maxPositionPct: d.maxPositionPct, maxAdvPct: d.maxAdvPct,
    })
    expect(stop.floored).toBe(true)                    // 4.8×ATR was still inside the noise
    expect(size.ok).toBe(true)
    expect(size.capped).toBe('liquidity')
    expect(size.advPct).toBeLessThanOrEqual(d.maxAdvPct)
    expect(size.notional).toBeLessThanOrEqual(400)     // 0.1% of a day's volume
    expect(size.positionPct).toBeLessThan(1)
  })

  it('lets a major utility coin take a real position at the same settings', () => {
    const d = tierDefaults('major', 'utility')
    const stop = altStop({ mode: 'atr', price: 3400, atr: 180, atrMult: d.atrMult, stopFloorPct: d.stopFloorPct })
    const size = altSize({
      equity: 100_000, riskPct: 1 * d.riskFraction, price: 3400, stop: stop.stop,
      vol24h: 18e9, maxPositionPct: d.maxPositionPct, maxAdvPct: d.maxAdvPct,
    })
    expect(size.ok).toBe(true)
    expect(size.capped).not.toBe('liquidity')
    expect(size.positionPct).toBeGreaterThan(1)
  })
})
