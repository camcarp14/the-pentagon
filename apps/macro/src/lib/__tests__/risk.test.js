// The risk engine sizes real orders and sets the stop those orders live behind,
// and it had no tests. Everything here is arithmetic that is easy to read and
// easy to get subtly wrong — an off-by-one in the share count is a rounding
// error, but a stop computed above the entry is an instant stop-out and a
// division by a non-positive number downstream.
//
// The invariants worth pinning, in the order they cost money:
//   1. Risk never exceeds the budget. Rounding is always DOWN.
//   2. The position cap wins over the risk target, and when it bites the
//      reported riskUsd is the EFFECTIVE risk of the capped size, not the ask.
//   3. Every failure is a named code with shares: 0 — never a partial fill and
//      never a throw, because these run inside a render.
//   4. The trail only ever ratchets up.
import { describe, it, expect } from 'vitest';
import {
  sizePosition, initialStop, anchoredChandelier, effectiveStop, rMultiple, blendLots,
} from '../risk.js';

describe('sizePosition', () => {
  it('sizes so a stop-out loses at most the risk budget', () => {
    // 1% of 100k = $1,000 of risk; $10 per share ⇒ 100 shares exactly.
    const r = sizePosition({ equity: 100_000, riskPct: 1, entry: 100, stop: 90 });
    expect(r.ok).toBe(true);
    expect(r.shares).toBe(100);
    expect(r.riskUsd).toBe(1000);
    expect(r.perShareRisk).toBe(10);
    expect(r.capped).toBe(false);
  });

  it('rounds the share count DOWN, so risk is never rounded up over budget', () => {
    // $1,000 budget / $3 per share = 333.33 ⇒ 333, not 334.
    const r = sizePosition({ equity: 100_000, riskPct: 1, entry: 50, stop: 47 });
    expect(r.shares).toBe(333);
    expect(r.riskUsd).toBeLessThanOrEqual(1000);
  });

  it('caps notional at maxPositionPct and reports the EFFECTIVE risk, not the ask', () => {
    // Risk budget alone would buy 1,000 shares ($100k notional = 100% of
    // equity). The 30% cap allows 300, and the honest risk is then $300.
    const r = sizePosition({ equity: 100_000, riskPct: 1, entry: 100, stop: 99 });
    expect(r.capped).toBe(true);
    expect(r.shares).toBe(300);
    expect(r.riskUsd).toBe(300);
    expect(r.positionPct).toBe(30);
  });

  it('honours a maxPositionPct override in both directions', () => {
    const tight = sizePosition({ equity: 100_000, riskPct: 1, entry: 100, stop: 99, maxPositionPct: 10 });
    expect(tight.shares).toBe(100);
    const loose = sizePosition({ equity: 100_000, riskPct: 1, entry: 100, stop: 99, maxPositionPct: 100 });
    expect(loose.shares).toBe(1000);
    expect(loose.capped).toBe(false);
  });

  // The invariant the whole R framework rests on.
  it('refuses a stop at or above the entry instead of returning a negative size', () => {
    for (const stop of [100, 110]) {
      const r = sizePosition({ equity: 100_000, riskPct: 1, entry: 100, stop });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('stop_not_below_entry');
      expect(r.shares).toBe(0);
    }
  });

  it('reports risk_too_small_for_one_share rather than sizing zero shares as ok', () => {
    const r = sizePosition({ equity: 1000, riskPct: 0.1, entry: 400, stop: 200 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('risk_too_small_for_one_share');
    expect(r.shares).toBe(0);
  });

  it('returns bad_input for anything non-finite instead of producing NaN shares', () => {
    const bases = { equity: 100_000, riskPct: 1, entry: 100, stop: 90 };
    for (const k of ['equity', 'riskPct', 'entry', 'stop']) {
      for (const v of [NaN, Infinity, -Infinity, undefined, null, '100', {}]) {
        const r = sizePosition({ ...bases, [k]: v });
        expect(r.ok).toBe(false);
        expect(r.error).toBe('bad_input');
        expect(r.shares).toBe(0);
      }
    }
  });

  // maxPositionPct is the one parameter with a destructuring default, so an
  // absent value must fall back to 30% rather than fail the finite check.
  it('falls back to the default position cap when maxPositionPct is absent', () => {
    const bases = { equity: 100_000, riskPct: 1, entry: 100, stop: 99 };
    expect(sizePosition(bases).shares).toBe(300);
    expect(sizePosition({ ...bases, maxPositionPct: undefined }).shares).toBe(300);
    for (const v of [NaN, null, '30']) {
      expect(sizePosition({ ...bases, maxPositionPct: v }).ok).toBe(false);
    }
  });

  it('rejects non-positive equity, risk and entry', () => {
    expect(sizePosition({ equity: 0, riskPct: 1, entry: 100, stop: 90 }).error).toBe('bad_input');
    expect(sizePosition({ equity: 100_000, riskPct: 0, entry: 100, stop: 90 }).error).toBe('bad_input');
    expect(sizePosition({ equity: 100_000, riskPct: 1, entry: 0, stop: -1 }).error).toBe('bad_input');
    expect(sizePosition({ equity: 100_000, riskPct: 1, entry: 100, stop: 90, maxPositionPct: 0 }).error).toBe('bad_input');
  });
});

describe('initialStop', () => {
  it('places an ATR stop atrMult below the entry', () => {
    const s = initialStop({ mode: 'atr', entry: 400, atr: 20, atrMult: 2.5 });
    expect(s.stop).toBe(350);
    expect(s.basis).toBe('atr');
    expect(s.warning).toBeNull();
  });

  it('pads a structure stop below the swing low so a wick cannot tag it', () => {
    const s = initialStop({ mode: 'structure', entry: 400, atr: 20, swingLow: 370, padAtr: 0.25 });
    expect(s.stop).toBe(365);
  });

  it('places a percent stop below the entry', () => {
    expect(initialStop({ mode: 'percent', entry: 400, pct: 8 }).stop).toBe(368);
  });

  // Each mode has its own missing input, and each names its own warning so the
  // cockpit can say which one to fix.
  it('names the specific missing input rather than failing generically', () => {
    expect(initialStop({ mode: 'atr', entry: 400, atr: 0 }).warning).toBe('no_atr');
    expect(initialStop({ mode: 'structure', entry: 400, atr: 20 }).warning).toBe('no_structure');
    expect(initialStop({ mode: 'structure', entry: 400, swingLow: 370 }).warning).toBe('no_structure');
    expect(initialStop({ mode: 'percent', entry: 400, pct: 100 }).warning).toBe('bad_input');
    expect(initialStop({ mode: 'trailing', entry: 400 }).warning).toBe('bad_input');
    expect(initialStop({ mode: 'atr', entry: 0, atr: 20 }).warning).toBe('bad_input');
  });

  it('refuses a structure stop that sits at or above the entry', () => {
    const s = initialStop({ mode: 'structure', entry: 100, atr: 5, swingLow: 110, padAtr: 0.25 });
    expect(s.stop).toBeNull();
    expect(s.warning).toBe('stop_not_below_entry');
  });

  // The other end of the same guard. A wide ATR against a low entry pushed the
  // stop through zero and it came back as a good stop with warning: null — a
  // negative price rendered as a level, and a per-share risk larger than the
  // share itself handed to the sizer.
  it('refuses a stop that has gone through zero', () => {
    const s = initialStop({ mode: 'atr', entry: 10, atr: 20, atrMult: 2.5 });
    expect(s.stop).toBeNull();
    expect(s.warning).toBe('stop_below_zero');

    const exact = initialStop({ mode: 'structure', entry: 10, atr: 8, swingLow: 2, padAtr: 0.25 });
    expect(exact.stop).toBeNull();       // 2 − 2 = 0 is not a price either
    expect(exact.warning).toBe('stop_below_zero');
  });

  it('still allows a legitimately small positive stop', () => {
    expect(initialStop({ mode: 'percent', entry: 10, pct: 99 }).stop).toBe(0.1);
  });

  it('hands the sizer a stop it can always use', () => {
    const s = initialStop({ mode: 'atr', entry: 400, atr: 20, atrMult: 2.5 });
    const sized = sizePosition({ equity: 100_000, riskPct: 1, entry: 400, stop: s.stop, maxPositionPct: 100 });
    expect(sized.ok).toBe(true);
    expect(sized.riskUsd).toBeLessThanOrEqual(1000);
  });
});

describe('anchoredChandelier', () => {
  const flat = (n, price) => Array.from({ length: n }, () => ({ o: price, h: price, l: price, c: price }));

  it('carries the initial stop while ATR is unseeded', () => {
    const trail = anchoredChandelier(flat(10, 100), { entryIdx: 0, atrPeriod: 22, mult: 3, initialStop: 90 });
    expect(trail).toHaveLength(10);
    expect(trail.every((v) => v === 90)).toBe(true);
  });

  it('only ever ratchets up — a lower reading never lowers the stop', () => {
    // Rally to 200, then collapse back to 100. The trail must not follow down.
    const candles = [
      ...flat(30, 100),
      ...Array.from({ length: 10 }, (_, i) => { const p = 100 + (i + 1) * 10; return { o: p, h: p, l: p, c: p }; }),
      ...flat(10, 100),
    ];
    const trail = anchoredChandelier(candles, { entryIdx: 0, atrPeriod: 22, mult: 3, initialStop: 80 });
    for (let i = 1; i < trail.length; i++) {
      expect(trail[i]).toBeGreaterThanOrEqual(trail[i - 1]);
    }
    expect(trail[trail.length - 1]).toBeGreaterThan(80);
  });

  it('returns an array aligned to candles.slice(entryIdx)', () => {
    const candles = flat(40, 100);
    expect(anchoredChandelier(candles, { entryIdx: 30, initialStop: 90 })).toHaveLength(10);
  });

  it('returns [] for an entry index outside the tape rather than throwing', () => {
    const candles = flat(10, 100);
    for (const entryIdx of [-1, 10, 99, null, undefined]) {
      expect(anchoredChandelier(candles, { entryIdx, initialStop: 90 })).toEqual([]);
    }
    expect(anchoredChandelier(null, { entryIdx: 0 })).toEqual([]);
  });
});

describe('effectiveStop', () => {
  it('takes the highest of initial, trail and breakeven', () => {
    expect(effectiveStop({ initialStop: 90, trailStop: 95, entry: 100 })).toBe(95);
    expect(effectiveStop({ initialStop: 90, trailStop: 85, entry: 100 })).toBe(90);
  });

  it('arms breakeven exactly at +1R, not before', () => {
    const at = (highestCloseSinceEntry) =>
      effectiveStop({ initialStop: 90, trailStop: 92, entry: 100, beAtR: 1, highestCloseSinceEntry });
    expect(at(109.99)).toBe(92);   // just short of +1R — trail still governs
    expect(at(110)).toBe(100);     // exactly +1R — breakeven arms
    expect(at(120)).toBe(100);
  });

  it('respects a beAtR other than 1', () => {
    const at = (r) => effectiveStop({ initialStop: 90, trailStop: 92, entry: 100, beAtR: 2, highestCloseSinceEntry: r });
    expect(at(115)).toBe(92);
    expect(at(120)).toBe(100);
  });

  it('returns null when there is no stop of any kind, rather than -Infinity', () => {
    expect(effectiveStop({})).toBeNull();
    expect(effectiveStop({ entry: 100, highestCloseSinceEntry: 200 })).toBeNull();
  });

  it('will not arm breakeven off a non-positive initial risk', () => {
    expect(effectiveStop({ initialStop: 100, trailStop: 95, entry: 100, highestCloseSinceEntry: 500 })).toBe(100);
  });
});

describe('rMultiple', () => {
  it('measures against the INITIAL risk, not the current stop', () => {
    expect(rMultiple({ entry: 100, initialStop: 90, price: 110 })).toBe(1);
    expect(rMultiple({ entry: 100, initialStop: 90, price: 130 })).toBe(3);
    expect(rMultiple({ entry: 100, initialStop: 90, price: 95 })).toBe(-0.5);
    expect(rMultiple({ entry: 100, initialStop: 90, price: 90 })).toBe(-1);
  });

  it('is null when risk per share is not positive or an input is missing', () => {
    expect(rMultiple({ entry: 100, initialStop: 100, price: 110 })).toBeNull();
    expect(rMultiple({ entry: 100, initialStop: 110, price: 120 })).toBeNull();
    expect(rMultiple({ entry: 100, initialStop: 90, price: null })).toBeNull();
  });
});

describe('blendLots', () => {
  it('weights the average entry by share count', () => {
    expect(blendLots([{ shares: 100, entry: 100 }, { shares: 300, entry: 200 }]))
      .toEqual({ shares: 400, avgEntry: 175 });
  });

  it('skips malformed lots instead of poisoning the average with NaN', () => {
    const r = blendLots([
      { shares: 100, entry: 100 },
      { shares: 0, entry: 500 },
      { shares: -5, entry: 500 },
      { shares: 'x', entry: 500 },
      { shares: 100, entry: NaN },
      null,
    ]);
    expect(r).toEqual({ shares: 100, avgEntry: 100 });
  });

  it('returns a null average rather than 0 when there is nothing to blend', () => {
    expect(blendLots([])).toEqual({ shares: 0, avgEntry: null });
    expect(blendLots(null)).toEqual({ shares: 0, avgEntry: null });
    expect(blendLots([{ shares: 0, entry: 100 }])).toEqual({ shares: 0, avgEntry: null });
  });
});
