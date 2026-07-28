// validate.mjs is the ONLY thing standing between a client-supplied JSON body
// and the Blobs store behind settings/position/journal. Its own header says
// "fully unit-tested" — it was not, so this file makes the claim true rather
// than deleting it.
//
// The cases that matter are the ones a passing eyeball misses: prototype keys
// that resolve to rule-shaped objects, NaN/Infinity sliding past a `typeof
// number` check, and the ordering rules (stop below entry, exit on/after
// entry) that are the difference between a stored trade and a stored lie.
import { describe, it, expect } from 'vitest';
import { validateSettings, validatePosition, validateTrade } from '../validate.mjs';

describe('validateSettings', () => {
  it('accepts a well-formed partial patch and returns only known keys', () => {
    const r = validateSettings({ equity: 50_000, riskPct: 1, stopMode: 'atr' });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ equity: 50_000, riskPct: 1, stopMode: 'atr' });
  });

  it('rejects a non-object patch rather than coercing it', () => {
    for (const bad of [null, undefined, 'equity=1', 42, ['equity']]) {
      expect(validateSettings(bad).ok).toBe(false);
    }
  });

  it('rejects unknown keys loudly instead of dropping them', () => {
    const r = validateSettings({ equity: 1000, leverage: 3 });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('unknown setting: leverage');
  });

  // The reason the source uses Object.hasOwn. A bare lookup resolves these off
  // Object.prototype into truthy, non-rule objects, and the branch that follows
  // would read `rule.enum`/`rule.min` off a function.
  it('treats inherited Object.prototype keys as unknown', () => {
    for (const key of ['hasOwnProperty', 'constructor', 'toString', 'valueOf']) {
      const r = validateSettings({ [key]: 1 });
      expect(r.ok).toBe(false);
      expect(r.errors).toEqual([`unknown setting: ${key}`]);
    }
  });

  it('rejects NaN and Infinity, which are typeof "number"', () => {
    expect(validateSettings({ equity: NaN }).ok).toBe(false);
    expect(validateSettings({ equity: Infinity }).ok).toBe(false);
    expect(validateSettings({ equity: -Infinity }).ok).toBe(false);
  });

  it('rejects numeric strings — no silent coercion into the store', () => {
    const r = validateSettings({ equity: '50000' });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('equity must be a number');
  });

  it('enforces range on both edges, inclusive', () => {
    expect(validateSettings({ riskPct: 0.05 }).ok).toBe(true);
    expect(validateSettings({ riskPct: 5 }).ok).toBe(true);
    expect(validateSettings({ riskPct: 0.049 }).ok).toBe(false);
    expect(validateSettings({ riskPct: 5.01 }).ok).toBe(false);
  });

  it('enforces the int rule where one is declared', () => {
    expect(validateSettings({ chandelierPeriod: 22 }).ok).toBe(true);
    const r = validateSettings({ chandelierPeriod: 22.5 });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('chandelierPeriod must be an integer');
  });

  it('enforces the enum on stopMode and names the alternatives', () => {
    expect(validateSettings({ stopMode: 'structure' }).ok).toBe(true);
    const r = validateSettings({ stopMode: 'trailing' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/atr\/structure\/percent/);
  });

  it('reports every bad key, not just the first', () => {
    const r = validateSettings({ equity: -1, riskPct: 99, nope: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(3);
  });

  it('accepts an empty patch as a no-op rather than an error', () => {
    expect(validateSettings({})).toEqual({ ok: true, value: {} });
  });
});

describe('validatePosition', () => {
  const base = {
    shares: 100, avgEntry: 400, entryDate: '2026-01-15', initialStop: 360,
  };

  it('accepts a well-formed position and defaults the optional fields', () => {
    const r = validatePosition(base);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ ...base, stopOverride: null, note: '' });
  });

  it('requires a whole positive share count', () => {
    for (const shares of [0, -5, 10.5, '10', null]) {
      expect(validatePosition({ ...base, shares }).ok).toBe(false);
    }
  });

  // The invariant the risk engine depends on: perShareRisk = entry - stop must
  // be positive, or sizePosition divides by a non-positive number.
  it('refuses a stop at or above the entry', () => {
    expect(validatePosition({ ...base, initialStop: 400 }).ok).toBe(false);
    expect(validatePosition({ ...base, initialStop: 401 }).ok).toBe(false);
    expect(validatePosition({ ...base, initialStop: 399.99 }).ok).toBe(true);
  });

  it('requires entryDate as YYYY-MM-DD', () => {
    expect(validatePosition({ ...base, entryDate: '15/01/2026' }).ok).toBe(false);
    expect(validatePosition({ ...base, entryDate: '2026-1-5' }).ok).toBe(false);
    expect(validatePosition({ ...base, entryDate: '' }).ok).toBe(false);
    expect(validatePosition({ ...base, entryDate: 20260115 }).ok).toBe(false);
  });

  // Date.parse rolls an out-of-range day forward instead of rejecting it, so
  // these all passed the shape check and were stored as a DIFFERENT day than
  // the one submitted — silently, with nothing on any screen saying so.
  it('rejects calendar-impossible days that Date.parse would roll forward', () => {
    expect(validatePosition({ ...base, entryDate: '2026-02-31' }).ok).toBe(false);
    expect(validatePosition({ ...base, entryDate: '2026-04-31' }).ok).toBe(false);
    expect(validatePosition({ ...base, entryDate: '2026-02-29' }).ok).toBe(false);
    // …while a real leap day still goes through.
    expect(validatePosition({ ...base, entryDate: '2024-02-29' }).ok).toBe(true);
  });

  // A stop override may only ever RAISE the stop. Letting it lower one is how a
  // losing position quietly gets more room instead of being closed.
  it('lets stopOverride raise the stop but never lower it', () => {
    expect(validatePosition({ ...base, stopOverride: 370 }).ok).toBe(true);
    expect(validatePosition({ ...base, stopOverride: 360 }).ok).toBe(true);
    const r = validatePosition({ ...base, stopOverride: 359 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/only raise the stop/);
  });

  it('accepts a null stopOverride but not a zero or negative one', () => {
    expect(validatePosition({ ...base, stopOverride: null }).ok).toBe(true);
    expect(validatePosition({ ...base, stopOverride: 0 }).ok).toBe(false);
    expect(validatePosition({ ...base, stopOverride: -1 }).ok).toBe(false);
  });

  it('caps the note at 500 chars and requires a string', () => {
    expect(validatePosition({ ...base, note: 'x'.repeat(500) }).ok).toBe(true);
    expect(validatePosition({ ...base, note: 'x'.repeat(501) }).ok).toBe(false);
    expect(validatePosition({ ...base, note: 12 }).ok).toBe(false);
  });
});

describe('validateTrade', () => {
  const base = {
    entryDate: '2026-01-05', exitDate: '2026-02-10',
    entry: 300, exit: 420, shares: 50, initialStop: 270,
  };

  it('accepts a well-formed closed trade with defaults filled in', () => {
    const r = validateTrade(base);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ ...base, kind: 'manual', note: '' });
  });

  it('allows a same-day round trip but not an exit before the entry', () => {
    expect(validateTrade({ ...base, exitDate: base.entryDate }).ok).toBe(true);
    const r = validateTrade({ ...base, exitDate: '2026-01-04' });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('exitDate must be on/after entryDate');
  });

  it('accepts a losing trade — exit below entry is not an error', () => {
    expect(validateTrade({ ...base, exit: 210 }).ok).toBe(true);
  });

  it('constrains kind to the three the journal renders', () => {
    for (const kind of ['pullback', 'breakout', 'manual']) {
      expect(validateTrade({ ...base, kind }).ok).toBe(true);
    }
    expect(validateTrade({ ...base, kind: 'swing' }).ok).toBe(false);
  });

  it('applies the same calendar check to both trade dates', () => {
    expect(validateTrade({ ...base, entryDate: '2026-06-31' }).ok).toBe(false);
    expect(validateTrade({ ...base, exitDate: '2026-11-31' }).ok).toBe(false);
  });

  it('rejects a non-object body rather than reading fields off it', () => {
    for (const bad of [null, undefined, 'trade', 7]) {
      expect(validateTrade(bad).ok).toBe(false);
    }
  });

  it('collects every problem in one pass so the client fixes them together', () => {
    const r = validateTrade({ entryDate: 'nope', entry: 0, shares: 1.5 });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(3);
  });
});
