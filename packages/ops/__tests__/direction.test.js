import { describe, it, expect } from "vitest";
import {
  normalizeContent, normalizeOutbound, readiness, resolveDirection,
  ENGINE, HARD_MAX, DIRECTION_KEY,
} from "../direction.js";

describe("normalizeContent()", () => {
  it("never throws on absent or garbage input", () => {
    for (const bad of [undefined, null, "", 0, [], "nope"]) {
      expect(() => normalizeContent(bad)).not.toThrow();
      expect(normalizeContent(bad).topics).toEqual([]);
    }
  });

  it("accepts topics as an array, a comma string, or newlines", () => {
    expect(normalizeContent({ topics: ["a", "b"] }).topics).toEqual(["a", "b"]);
    expect(normalizeContent({ topics: "a, b" }).topics).toEqual(["a", "b"]);
    expect(normalizeContent({ topics: "a\nb" }).topics).toEqual(["a", "b"]);
  });

  it("dedupes topics case-insensitively", () => {
    // Otherwise the engine writes the same article twice under two casings.
    expect(normalizeContent({ topics: "Seed phrases, seed phrases, SEED PHRASES" }).topics)
      .toEqual(["Seed phrases"]);
  });

  it("drops blanks left by trailing commas", () => {
    expect(normalizeContent({ topics: "a, , b," }).topics).toEqual(["a", "b"]);
  });

  it("clamps perDay to the hard ceiling", () => {
    expect(normalizeContent({ perDay: 999 }).perDay).toBe(HARD_MAX.contentPerDay);
  });

  it("falls back rather than producing NaN or zero", () => {
    // NaN is the dangerous one: NaN >= cap is always false, so an unguarded
    // NaN silently removes every ceiling downstream.
    for (const bad of ["abc", NaN, 0, -3, null, undefined, {}]) {
      const n = normalizeContent({ perDay: bad }).perDay;
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
    }
  });

  it("floors fractional requests", () => {
    expect(normalizeContent({ perDay: 2.9 }).perDay).toBe(2);
  });

  it("trims whitespace off free-text fields", () => {
    expect(normalizeContent({ audience: "  crypto holders  " }).audience).toBe("crypto holders");
  });
});

describe("normalizeOutbound()", () => {
  it("clamps perDay to the outbound ceiling", () => {
    expect(normalizeOutbound({ perDay: 10_000 }).perDay).toBe(HARD_MAX.outboundPerDay);
  });
  it("defaults cleanly from nothing", () => {
    const d = normalizeOutbound(null);
    expect(d.icp).toBe("");
    expect(d.perDay).toBe(10);
  });
});

describe("readiness()", () => {
  it("reports content as not ready with plain-English gaps", () => {
    const r = readiness(ENGINE.CONTENT, normalizeContent({}));
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual([
      "who the writing is for",
      "what is being sold",
      "at least one topic to write about",
    ]);
  });

  it("goes ready once the three content facts exist", () => {
    const d = normalizeContent({ audience: "self-custody beginners", product: "steel seed backup", topics: "seed phrases" });
    expect(readiness(ENGINE.CONTENT, d)).toEqual({ ready: true, missing: [] });
  });

  it("treats an empty topics array as missing, not as satisfied", () => {
    const d = normalizeContent({ audience: "a", product: "b", topics: [] });
    expect(readiness(ENGINE.CONTENT, d).ready).toBe(false);
  });

  it("treats whitespace-only text as missing", () => {
    const d = normalizeContent({ audience: "   ", product: "b", topics: "c" });
    expect(readiness(ENGINE.CONTENT, d).ready).toBe(false);
  });

  it("does not require optional fields", () => {
    const d = normalizeOutbound({ icp: "dentists", offer: "paid search audit" });
    expect(readiness(ENGINE.OUTBOUND, d).ready).toBe(true);
  });

  it("fails closed on an unknown engine", () => {
    expect(readiness("nonsense", {}).ready).toBe(false);
  });
});

describe("resolveDirection()", () => {
  it("normalises and checks in one pass", () => {
    const r = resolveDirection(ENGINE.OUTBOUND, { icp: " dentists ", offer: "audit", perDay: 999 });
    expect(r.ready).toBe(true);
    expect(r.direction.icp).toBe("dentists");
    expect(r.direction.perDay).toBe(HARD_MAX.outboundPerDay);
  });

  it("returns a null direction for an unknown engine instead of throwing", () => {
    const r = resolveDirection("bogus", {});
    expect(r.direction).toBeNull();
    expect(r.ready).toBe(false);
  });
});

describe("DIRECTION_KEY", () => {
  it("maps both engines to distinct settings keys", () => {
    expect(DIRECTION_KEY[ENGINE.CONTENT]).toBe("direction.content");
    expect(DIRECTION_KEY[ENGINE.OUTBOUND]).toBe("direction.outbound");
  });
});
