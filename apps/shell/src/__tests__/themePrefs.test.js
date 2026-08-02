// Theme preferences, and the one thing about them that is not a preference.
//
// Half of this file pins the same class of rule tabPrefs.test.js pins: a value
// read on the render path out of localStorage must survive every shape storage
// can hold. The other half pins the WIRING, and that half is the point — the
// palette/mode pair was the easy part, and a Light button that flips an
// attribute over an inline stamp that overrules it is a setting that does
// nothing while looking completely finished.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cssVars } from "@cc/design";
import { DEFAULT_PALETTE, PALETTES } from "@cc/design/palettes.js";
import {
  normalizeThemePrefs, resolveMode, resolvePalette, isDefaultTheme, themeVars,
  resetThemePrefs, MATCH_TOOL, MODES, DEFAULT_THEME_PREFS,
} from "../themePrefs.js";

describe("defaults", () => {
  it("is Session over dark", () => {
    expect(normalizeThemePrefs(null)).toEqual({ palette: DEFAULT_PALETTE, mode: "dark" });
    expect(resetThemePrefs()).toEqual({ ...DEFAULT_THEME_PREFS });
  });

  it("offers exactly Light, Dark and System", () => {
    expect([...MODES].sort()).toEqual(["dark", "light", "system"]);
  });
});

describe("normalizeThemePrefs — it is fed whatever is in localStorage", () => {
  it("survives every shape a stored value could take", () => {
    for (const bad of [null, undefined, 0, "", "dark", [], ["zts"], { palette: 7 }, { mode: {} }, { palette: null, mode: null }]) {
      expect(() => normalizeThemePrefs(bad)).not.toThrow();
      const p = normalizeThemePrefs(bad);
      expect(MODES).toContain(p.mode);
      expect(PALETTES.some((x) => x.key === p.palette)).toBe(true);
    }
  });

  it("drops a palette that is no longer one — a retired tool must not brick the picker", () => {
    expect(normalizeThemePrefs({ palette: "atlantis", mode: "light" }).palette).toBe(DEFAULT_PALETTE);
  });

  it("a bad mode does not also throw away a good palette", () => {
    // The axes are independent, so losing half a preference is worse than
    // losing all of it: the operator sees one of their two choices survive and
    // has no way to tell whether the other was rejected or forgotten.
    expect(normalizeThemePrefs({ palette: "runway", mode: "nite" })).toEqual({ palette: "runway", mode: "dark" });
    expect(normalizeThemePrefs({ palette: "nope", mode: "light" })).toEqual({ palette: DEFAULT_PALETTE, mode: "light" });
  });

  it("accepts every palette the generator publishes", () => {
    for (const p of PALETTES) expect(normalizeThemePrefs({ palette: p.key }).palette).toBe(p.key);
    expect(PALETTES.length, "scan sanity — a picker with no palettes would pass everything above").toBeGreaterThanOrEqual(8);
  });
});

describe("resolve — the two attributes the shell stamps", () => {
  it("mode is never 'system'; that is a source, not a ground", () => {
    expect(resolveMode({ mode: "system" }, true)).toBe("dark");
    expect(resolveMode({ mode: "system" }, false)).toBe("light");
    expect(resolveMode({ mode: "light" }, true)).toBe("light");
    expect(resolveMode({ mode: "dark" }, false)).toBe("dark");
  });

  it("Session is the default, and a chosen palette overrules it", () => {
    expect(resolvePalette({ palette: MATCH_TOOL }, "macro")).toBe(DEFAULT_PALETTE);
    expect(resolvePalette({ palette: MATCH_TOOL }, "sync")).toBe(DEFAULT_PALETTE);
    expect(resolvePalette({ palette: "runway" }, "macro")).toBe("runway");
  });

  it("never returns a palette themes.css cannot style", () => {
    // The fallback is the failure mode that matters: data-palette="atlantis"
    // matches no block, so every authored token falls back to the neutral
    // ground and the page renders in a palette nobody chose.
    expect(PALETTES.map((p) => p.key)).toContain(resolvePalette({ palette: MATCH_TOOL }, "atlantis"));
    expect(PALETTES.map((p) => p.key)).toContain(resolvePalette(null, undefined));
  });

  it("always uses the mode-aware Session variable path", () => {
    expect(isDefaultTheme({ palette: MATCH_TOOL, mode: "system" }, true)).toBe(false);
    expect(isDefaultTheme({ palette: MATCH_TOOL, mode: "dark" }, true)).toBe(false);
    expect(isDefaultTheme({ palette: MATCH_TOOL, mode: "system" }, false)).toBe(false);
    expect(isDefaultTheme({ palette: "zts", mode: "dark" }, true)).toBe(false);
  });
});

describe("themeVars — THE WIRING, not the preference", () => {
  // ── read this before changing anything below ──────────────────────────────
  // main.jsx: "App.jsx still stamps cssVars() inline on the wrapper, and an
  // inline custom property beats a stylesheet one." That is why themes.css has
  // shipped a contrast-checked light half for all eight palettes since the token
  // layer landed and none of it has ever been visible. Flipping data-theme
  // without removing these names is a Light button that changes an attribute and
  // repaints nothing — written, exported, documented, tested, unwired.
  const AUTHORED = ["--bg", "--surface", "--surface-2", "--ink", "--faint", "--accent", "--accent-hi", "--accent-deep"];

  it("stops stamping every token themes.css authors per palette per mode", () => {
    const v = themeVars("zts");
    for (const name of AUTHORED) {
      expect(v, `${name} is authored by [data-palette][data-theme]; stamping it inline is what made light mode invisible`).not.toHaveProperty(name);
      expect(cssVars("zts"), "scan sanity — if cssVars stops emitting these, this test is asserting nothing").toHaveProperty(name);
    }
  });

  it("hands back no colour of its own — every value is a token reference", () => {
    // "Render swatches from PALETTES, never a hand-copied hex" applies here
    // twice over: a literal colour in this map is a value that cannot follow the
    // mode, which is the entire defect being fixed.
    const v = themeVars("clarify");
    const hexed = Object.entries(v).filter(([k, val]) =>
      typeof val === "string" && /#[0-9a-fA-F]{3,8}\b/.test(val) && !k.startsWith("--font") && !k.startsWith("--radius"));
    expect(hexed.map(([k]) => k), "a hardcoded colour cannot go light").toEqual([]);
  });

  it("still names everything cssVars names, so nothing silently loses its value", () => {
    // The tools read these names; a name that simply disappears on the themed
    // path resolves to nothing, and an unresolved var() invalidates the whole
    // declaration rather than falling back — the same failure PLATFORM_VARS's
    // comment in App.jsx already records.
    const base = Object.keys(cssVars("zts"));
    const themed = Object.keys(themeVars("zts"));
    const lost = base.filter((k) => !themed.includes(k) && !AUTHORED.includes(k) && k !== "--shadow-card");
    expect(lost, "names dropped with no stylesheet owner").toEqual([]);
  });

  it("keeps the mode-independent half exactly as cssVars had it", () => {
    const base = cssVars("macro");
    const themed = themeVars("macro");
    for (const k of ["--radius", "--radius-lg", "--font-body", "--font-mono", "--dur-2", "--ease-out"]) {
      expect(themed[k]).toBe(base[k]);
    }
  });

  it("survives a palette key that is not one", () => {
    expect(() => themeVars("atlantis")).not.toThrow();
    expect(themeVars(undefined)["--radius"]).toBe(cssVars("zts")["--radius"]);
  });

  it("every token it points at is one packages/design actually declares", () => {
    // THE CROSS-PACKAGE EDGE, and the reason it needs a test rather than care:
    // themes.css and palettes.js are GENERATED (`npm run themes`), so the ladder
    // rungs this file aliases onto — --accent-a14, --accent-a30, --green-a06,
    // --red-a08, --on-accent, --sub — can be renamed or dropped by a change to
    // the generator table in another package, in another agent's diff. An
    // unresolved var() does not fall back: it invalidates the WHOLE declaration,
    // so the failure is a token silently rendering as nothing on exactly one
    // code path. This turns that into a red test in the file that depends on it.
    const here = dirname(fileURLToPath(import.meta.url));
    const design = join(here, "..", "..", "..", "..", "packages", "design");
    const css = ["tokens.css", "themes.css"].map((f) => readFileSync(join(design, f), "utf8")).join("\n");
    const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
    expect(declared.size, "scan sanity — the token sheets should declare a lot of names").toBeGreaterThan(60);

    const referenced = new Set();
    for (const value of Object.values(themeVars("zts"))) {
      if (typeof value !== "string") continue;
      for (const m of value.matchAll(/var\((--[a-z0-9-]+)/gi)) referenced.add(m[1]);
    }
    // The font stack is cssVars()'s own self-referential fallback chain, not
    // something the sheets have to own.
    const missing = [...referenced].filter((n) => !declared.has(n) && !n.startsWith("--font"));
    expect(missing, "themeVars aliases a token nothing declares — it will resolve to nothing").toEqual([]);
    expect(referenced.size, "scan sanity — themeVars is supposed to be almost entirely var() references").toBeGreaterThan(10);
  });
});
