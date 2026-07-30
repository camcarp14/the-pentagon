// The colour reader that took the Mind tab down.
//
// The tab rendered as "This tool hit an error — undefined is not an object
// (evaluating 'e.replace')". One line caused it: `hex.replace("#","")` on a
// colour that did not exist, because @cc/mind's regions carry `tint` and the
// ported canvas asked for `.color`.
//
// These are cheap tests for an expensive failure. A crash inside a 1000-line
// canvas is invisible to a build, invisible to a type checker, and only shows up
// on a phone as a blank tool — so the parser gets tested directly instead.

import { describe, it, expect } from "vitest";
import { REGION_ORDER } from "@cc/mind";
import { chan, rgba, lighten, hueOf, resolveColor, REGION_HUE, FALLBACK_HEX } from "../color.js";

describe("chan() cannot be surprised", () => {
  it("survives exactly what crashed it", () => {
    // The literal bug: a missing field read off a region.
    expect(() => chan(undefined)).not.toThrow();
    expect(chan(undefined)).toEqual(chan(FALLBACK_HEX));
    for (const bad of [null, "", "   ", 0, {}, [], NaN, true]) {
      expect(() => chan(bad)).not.toThrow();
    }
  });

  it("never yields NaN, which is the silent half of the bug", () => {
    // A string HAS .replace, so `var(--bg)` did not throw — it parsed to NaN and
    // painted invisible with nothing in the console. Harder to find than a crash.
    for (const input of [undefined, "var(--bg)", "#ggg", "#", "nonsense", "rgb(bad)"]) {
      for (const v of chan(input)) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(255);
      }
    }
  });

  it("reads the forms it is actually given", () => {
    expect(chan("#6AA8FF")).toEqual([0x6a, 0xa8, 0xff]);
    expect(chan("6AA8FF")).toEqual([0x6a, 0xa8, 0xff]);      // no hash
    expect(chan("#abc")).toEqual([0xaa, 0xbb, 0xcc]);        // shorthand
    expect(chan("rgb(10, 20, 30)")).toEqual([10, 20, 30]);
    expect(chan("rgba(10, 20, 30, 0.5)")).toEqual([10, 20, 30]);
  });

  it("falls back rather than caching a miss", () => {
    // With no DOM there is nothing to resolve a custom property against, so the
    // answer is the fallback — and it must NOT be cached, or a lookup that failed
    // only because the stylesheet had not landed yet would stay failed for the
    // life of the page.
    expect(resolveColor("var(--nothing-here)")).toBe(FALLBACK_HEX);
    expect(resolveColor("var(--nothing-here)")).toBe(FALLBACK_HEX);
  });

  it("produces valid CSS from invalid input", () => {
    expect(rgba(undefined, 0.5)).toMatch(/^rgba\(\d+,\d+,\d+,0\.5\)$/);
    expect(lighten(undefined, 0.5)).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  });
});

describe("every region has a hue of its own", () => {
  it("covers all of REGION_ORDER", () => {
    // A region with no hue falls back to grey, and a grey node on a grey ramp is
    // a node the operator cannot tell apart from any other.
    for (const r of REGION_ORDER) {
      expect(REGION_HUE[r], `no hue for region "${r}"`).toBeTruthy();
      expect(hueOf(r)).not.toBe(FALLBACK_HEX);
    }
  });

  it("gives six distinguishable hues, not a ramp", () => {
    // The reason a rename was not enough: @cc/mind's `tint` values are six steps
    // of one grey-blue, correct for a data package and unreadable on a canvas.
    const hues = REGION_ORDER.map(hueOf);
    expect(new Set(hues).size).toBe(REGION_ORDER.length);

    // And they have to differ in hue, not just in lightness. A crude check is
    // enough: the ordering of the r/g/b channels must not be identical across
    // every region, which is exactly what a monochrome ramp looks like.
    const shape = (h) => {
      const [r, g, b] = chan(h);
      return [r > g, g > b, r > b].join(",");
    };
    expect(new Set(hues.map(shape)).size).toBeGreaterThan(1);
  });

  it("still answers for an unknown region", () => {
    expect(hueOf("not-a-region")).toBe(FALLBACK_HEX);
    expect(hueOf(undefined)).toBe(FALLBACK_HEX);
  });
});
