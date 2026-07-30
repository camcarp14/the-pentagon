// The colour layer that took the Mind tab down, now shared by three apps.
//
// The original crash was one line — `hex.replace("#","")` on a colour that did
// not exist, because @cc/mind's regions carry `tint` and the canvas asked for
// `.color`. It rendered as "This tool hit an error" on a phone. Clarify and ZTS
// still carried the un-hardened parser when this consolidation started; they now
// share this one, so these tests defend three tools instead of one.

import { describe, it, expect } from "vitest";
import { REGION_ORDER } from "@cc/mind";
import {
  chan, rgba, lighten, resolveVars, normalizePalette,
  PALETTE_KEYS, PALETTE_DEFAULTS, REGION_KEYS, FALLBACK_HEX,
} from "../palette.js";

describe("chan() cannot be surprised", () => {
  it("survives exactly what crashed it", () => {
    expect(() => chan(undefined)).not.toThrow();
    expect(chan(undefined)).toEqual(chan(FALLBACK_HEX));
    for (const bad of [null, "", "   ", 0, {}, [], NaN, true]) {
      expect(() => chan(bad)).not.toThrow();
    }
  });

  it("never yields NaN, which is the silent half of the bug", () => {
    // A string HAS .replace, so `var(--bg)` did not throw — it parsed to NaN and
    // painted invisible with nothing in the console. Harder to find than a crash.
    for (const input of [undefined, "var(--bg)", "#ggg", "#", "nonsense", "rgb(bad)", "color-mix(in srgb, red, blue)"]) {
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

  it("produces valid CSS from invalid input", () => {
    expect(rgba(undefined, 0.5)).toMatch(/^rgba\(\d+,\d+,\d+,0\.5\)$/);
    expect(lighten(undefined, 0.5)).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  });
});

describe("the palette is a declared contract, not a token bag", () => {
  it("fills every key rather than rendering undefined into a CSS string", () => {
    // THE BUG THIS PINS. SYNC's shim had no `shadowPopover`; a call site
    // composed `${undefined}, var(--accent-a20)`, which is an invalid shadow
    // list, so the browser dropped the whole declaration. No error, no warning,
    // just a toast with no depth. Nothing may be undefined after normalising.
    const p = normalizePalette({}, { onWarn: () => {} });
    for (const k of PALETTE_KEYS) {
      expect(p[k], `palette.${k}`).toBeTruthy();
      expect(String(p[k])).not.toContain("undefined");
    }
    for (const k of REGION_KEYS) expect(p.region[k], `region.${k}`).toBeTruthy();
  });

  it("says so when a host leaves a token out", () => {
    const warned = [];
    normalizePalette({ ...PALETTE_DEFAULTS, shadow: undefined }, { onWarn: (m) => warned.push(m) });
    expect(warned.join(" ")).toContain("shadow");
  });

  it("is quiet when a host supplies everything", () => {
    const warned = [];
    const full = { ...PALETTE_DEFAULTS, region: Object.fromEntries(REGION_KEYS.map((k) => [k, "#123456"])) };
    normalizePalette(full, { onWarn: (m) => warned.push(m) });
    expect(warned).toEqual([]);
  });

  it("keeps ENERGY and INTENT as separate keys", () => {
    // The load-bearing part of the API. ZTS uses emerald for synapse energy and
    // amber for selection intent; Clarify and SYNC use one hue for both. A single
    // `accent` key would compile, render, pass everything else here, and quietly
    // turn ZTS's selection ring green.
    expect(PALETTE_KEYS).toContain("synapse");
    expect(PALETTE_KEYS).toContain("synapseHi");
    expect(PALETTE_KEYS).toContain("select");
    expect(PALETTE_KEYS).toContain("selectHi");
    expect(PALETTE_KEYS).not.toContain("accent");

    const split = normalizePalette(
      { ...PALETTE_DEFAULTS, synapse: "#00FF00", select: "#FFAA00" },
      { onWarn: () => {} },
    );
    expect(split.synapse).toBe("#00FF00");
    expect(split.select).toBe("#FFAA00");
  });

  it("covers every region @cc/mind knows about", () => {
    // A region with no hue is a node the operator cannot tell from any other.
    for (const r of REGION_ORDER) expect(REGION_KEYS).toContain(r);
    expect(REGION_KEYS.length).toBe(REGION_ORDER.length);
  });

  it("gives six distinguishable hues, not one ramp", () => {
    // @cc/mind's own REGIONS carry `tint`, six steps of one grey-blue — correct
    // for a pure data package and unreadable on a canvas. That difference is
    // exactly why the hue has to come from the palette.
    const p = normalizePalette({}, { onWarn: () => {} });
    const hues = REGION_KEYS.map((k) => p.region[k]);
    expect(new Set(hues).size).toBe(REGION_KEYS.length);
    const shape = (h) => { const [r, g, b] = chan(h); return [r > g, g > b, r > b].join(","); };
    expect(new Set(hues.map(shape)).size).toBeGreaterThan(1);
  });

  it("rejects a garbage palette instead of propagating it", () => {
    for (const bad of [null, undefined, "nope", 42, []]) {
      expect(() => normalizePalette(bad, { onWarn: () => {} })).not.toThrow();
      expect(normalizePalette(bad, { onWarn: () => {} }).ink).toBeTruthy();
    }
  });
});

describe("resolveVars stays out of the component", () => {
  it("passes literals through untouched", () => {
    const out = resolveVars(null, { a: "#123456", b: "rgba(1,2,3,0.5)" });
    expect(out).toEqual({ a: "#123456", b: "rgba(1,2,3,0.5)" });
  });

  it("honours the host's own declared fallback before ours", () => {
    // `var(--x, #ABCDEF)` says what the host wants when --x is absent. Ignoring
    // that and substituting our grey would silently restyle the canvas.
    expect(resolveVars(null, { a: "var(--nope, #ABCDEF)" }).a).toBe("#ABCDEF");
    expect(resolveVars(null, { a: "var(--nope)" }).a).toBe(FALLBACK_HEX);
  });

  it("resolves one level of nesting, for region maps", () => {
    const out = resolveVars(null, { region: { identity: "var(--x, #111111)", skill: "#222222" } });
    expect(out.region).toEqual({ identity: "#111111", skill: "#222222" });
  });

  it("never throws without a DOM", () => {
    expect(() => resolveVars(null, { a: "var(--x)" })).not.toThrow();
    expect(() => resolveVars({}, { a: "var(--x)" })).not.toThrow();
  });

  it("does not cache across elements", () => {
    // The old implementation kept a module Map keyed by variable NAME alone. It
    // was correct while one app used it and wrong the moment the component was
    // shared: the shell re-stamps its custom properties on every tool switch, so
    // the first reader would have frozen the answer for every app after it.
    const mk = (v) => ({ __v: v });
    const orig = globalThis.getComputedStyle;
    globalThis.getComputedStyle = (el) => ({ getPropertyValue: () => el.__v });
    try {
      expect(resolveVars(mk("#AAAAAA"), { c: "var(--accent)" }).c).toBe("#AAAAAA");
      expect(resolveVars(mk("#BBBBBB"), { c: "var(--accent)" }).c).toBe("#BBBBBB");
    } finally {
      if (orig) globalThis.getComputedStyle = orig; else delete globalThis.getComputedStyle;
    }
  });
});
