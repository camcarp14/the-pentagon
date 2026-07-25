import { describe, it, expect } from "vitest";
import { MODEL_PRICING, estimateCost, priceFor, isKnownModel, modelLabel } from "../pricing.js";

describe("MODEL_PRICING", () => {
  it("covers every model the app actually calls", () => {
    // These four ids appear in apps/ and netlify/. A model that can be called
    // but not priced is exactly the 15x bug this package was created to end.
    for (const id of [
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-6",
      "claude-opus-4-8",
      "claude-opus-5",
    ]) {
      expect(isKnownModel(id), `${id} must be priced`).toBe(true);
    }
  });

  it("is frozen, so no caller can mutate shared pricing", () => {
    expect(Object.isFrozen(MODEL_PRICING)).toBe(true);
  });
});

describe("estimateCost", () => {
  it("prices a known model off its own rate", () => {
    // 1M in @ $1 + 1M out @ $5
    expect(estimateCost("claude-haiku-4-5-20251001", 1e6, 1e6)).toBeCloseTo(6, 10);
    expect(estimateCost("claude-sonnet-4-6", 1e6, 1e6)).toBeCloseTo(18, 10);
    expect(estimateCost("claude-opus-5", 1e6, 1e6)).toBeCloseTo(90, 10);
  });

  it("is linear in token count", () => {
    const one = estimateCost("claude-sonnet-4-6", 1000, 2000);
    const ten = estimateCost("claude-sonnet-4-6", 10000, 20000);
    expect(ten).toBeCloseTo(one * 10, 10);
  });

  // ── the regression this package exists for ──────────────────────────────
  it("prices an UNKNOWN model at the most expensive known rate, never the cheapest", () => {
    const unknown = estimateCost("claude-something-unreleased", 1e6, 1e6);
    const cheapest = estimateCost("claude-haiku-4-5-20251001", 1e6, 1e6);
    const priciest = estimateCost("claude-opus-5", 1e6, 1e6);
    expect(unknown).toBe(priciest);
    expect(unknown).toBeGreaterThan(cheapest);
  });

  it("never under-reports for any unknown id — the property that protects the cap", () => {
    const priciest = estimateCost("claude-opus-5", 5e5, 5e5);
    for (const bogus of ["", "gpt-4", "claude-haiku-9", "CLAUDE-OPUS-5", null, undefined]) {
      expect(estimateCost(bogus, 5e5, 5e5)).toBeGreaterThanOrEqual(priciest);
    }
  });

  it("returns 0, never NaN, for missing or nonsense token counts", () => {
    // A NaN here poisons every downstream sum, and `NaN >= cap` is always
    // false — which silently disables the spend cap it is compared against.
    for (const args of [
      [undefined, undefined],
      [NaN, NaN],
      [null, null],
      [-100, -100],
      ["abc", "def"],
      [Infinity, Infinity],
    ]) {
      const v = estimateCost("claude-sonnet-4-6", args[0], args[1]);
      expect(Number.isFinite(v), `${args} produced ${v}`).toBe(true);
      expect(v).toBe(0);
    }
  });

  it("counts a valid side even when the other side is garbage", () => {
    expect(estimateCost("claude-haiku-4-5-20251001", 1e6, NaN)).toBeCloseTo(1, 10);
    expect(estimateCost("claude-haiku-4-5-20251001", NaN, 1e6)).toBeCloseTo(5, 10);
  });
});

describe("priceFor / modelLabel", () => {
  it("priceFor is null for unknown, so callers can WARN rather than guess", () => {
    expect(priceFor("claude-nope")).toBeNull();
    expect(priceFor("claude-sonnet-4-6")).toMatchObject({ in: 3, out: 15 });
  });

  it("modelLabel degrades to the raw id rather than throwing", () => {
    expect(modelLabel("claude-opus-5")).toBe("Opus 5");
    expect(modelLabel("claude-nope")).toBe("claude-nope");
    expect(modelLabel(undefined)).toBe("unknown");
  });
});
