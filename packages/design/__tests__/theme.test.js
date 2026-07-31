// The generated theme layer, pinned.
//
// themes.css and palettes.js are both emitted by gen-themes.mjs from one table
// of eight rows. The whole point of generating both is that hand-maintaining
// ~250 lines of CSS and a parallel JS swatch list guarantees they drift — and a
// drifted swatch means the UI lies about what colour a tool is.
//
// These assertions are cheap. The failure they prevent is not: a missing custom
// property renders as the literal string "undefined" inside a declaration, and
// the browser then drops that declaration whole, silently. This repo has already
// shipped that exact failure once — a box-shadow that never rendered for months.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { APPS } from "../index.js";
import { PALETTES } from "../palettes.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, "..", f), "utf8");
// Comments are stripped before any assertion: these files DOCUMENT the traps
// they avoid ("no @font-face", "Board Room's grocery list did not come across"),
// and a naive scan cannot tell an explanation from a rule.
const decomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const themes = read("themes.css");
const tokens = decomment(read("tokens.css"));
const kit = decomment(readFileSync(join(here, "..", "..", "ui", "components.css"), "utf8"));

describe("every tool has a palette", () => {
  it("covers all eight, in both modes", () => {
    for (const app of APPS) {
      expect(themes, `no dark palette for ${app}`).toContain(`[data-palette="${app}"][data-theme="dark"]`);
      expect(themes, `no light palette for ${app}`).toContain(`[data-palette="${app}"][data-theme="light"]`);
    }
  });

  it("has no dead theme room in tokens.css either", () => {
    // themes.css was guarded against exactly this and tokens.css was not — so
    // its dark block sat under [data-theme="night"], matched nothing, and :root
    // permanently carried the LIGHT ground underneath every dark palette.
    expect(tokens).not.toContain('data-theme="night"');
    expect(tokens).not.toContain('data-theme="day"');
    expect(tokens).toContain('[data-theme="dark"]');
  });

  it("derives the alpha ladder where the palette can reach it", () => {
    // A ladder declared on :root resolves against :root's --ink and only
    // inherits, so it freezes at the neutral ground whatever palette is active.
    // It has to be re-declared on the element that sets --ink.
    const paletteBlock = themes.slice(themes.indexOf("[data-palette] {"), themes.indexOf("}", themes.indexOf("[data-palette] {")));
    for (const t of ["--ink-a05", "--ink-a25", "--accent-a20", "--focus-ring"]) {
      expect(paletteBlock, `${t} must be derived per-palette, not once on :root`).toContain(t);
    }
  });

  it("uses the shell's attribute vocabulary, not Board Room's", () => {
    // apps/shell/src/App.jsx stamps data-theme="dark". Emitting "night" here
    // would leave every palette block unmatched and the whole system inert —
    // and inert is invisible, because tokens.css still supplies a ground.
    expect(themes).not.toContain('data-theme="night"');
    expect(themes).not.toContain('data-theme="day"');
  });

  it("keeps palettes.js in sync with the CSS — value for value", () => {
    // The first version of this test checked that each swatch hex appeared
    // SOMEWHERE in themes.css. An adversarial review corrupted ZTS's light
    // accent, Clarify's day accent and every night background in palettes.js,
    // and all nine tests still passed. "Appears somewhere" is not sync; it is a
    // spell-check. Each swatch is now read out of its own palette's own block.
    expect(PALETTES.map((p) => p.key).sort()).toEqual([...APPS].sort());

    const blockOf = (key, mode) => {
      const head = `[data-palette="${key}"][data-theme="${mode}"] {`;
      const i = themes.indexOf(head);
      expect(i, `no ${mode} block for ${key}`).toBeGreaterThan(-1);
      return themes.slice(i, themes.indexOf("}", i));
    };
    const tokenIn = (block, name) => (block.match(new RegExp(`${name}:\\s*([^;]+);`)) || [])[1]?.trim();

    for (const p of PALETTES) {
      for (const [mode, swatch] of [["light", p.day], ["dark", p.night]]) {
        const block = blockOf(p.key, mode);
        for (const key of ["bg", "surface", "accent", "ink"]) {
          expect(swatch?.[key], `${p.key}.${mode}.${key} missing from palettes.js`).toMatch(/^#[0-9A-F]{6}$/i);
          expect(tokenIn(block, `--${key}`)?.toUpperCase(),
            `${p.key} ${mode} --${key}: palettes.js says ${swatch[key]}, themes.css disagrees`)
            .toBe(swatch[key].toUpperCase());
        }
      }
    }
  });
});

describe("the token layer is complete", () => {
  it("defines every custom property the kit consumes", () => {
    // A var() with no definition is the silent-failure shape: the declaration
    // is dropped whole and the element renders un-styled rather than wrong.
    const defined = new Set([...(tokens + themes).matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
    const OPTIONAL = new Set(["--i", "--slider-color", "--slider-fill"]);   // set inline, with fallbacks
    const missing = [...new Set([...kit.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))]
      .filter((v) => !defined.has(v) && !OPTIONAL.has(v));
    expect(missing, `used in components.css, defined nowhere: ${missing.join(", ")}`).toEqual([]);
  });

  it("carries the motion system rather than re-inventing it per app", () => {
    for (const t of ["--dur-1", "--dur-2", "--dur-3", "--ease-out", "--ease-spring"]) {
      expect(tokens, `${t} missing`).toContain(t);
    }
  });

  it("holds no webfont, so there is no absolute /fonts/ path to resolve", () => {
    // Board Room self-hosts Inter from /fonts/, which nine apps building through
    // one shell cannot resolve. SESSION's own spec says system stack anyway.
    expect(tokens).not.toContain("@font-face");
    expect(tokens).toContain("-apple-system");
  });

  it("keeps another app's product surfaces out of the shared kit", () => {
    // Dot-prefixed only, first time round — which could not see @keyframes
    // bootout / drawring / sealdia / gro-pop, all four of which had survived the
    // port. Matched bare now, so a keyframe cannot hide.
    for (const name of ["gro-", "wire-", "seal-", "boot", "brief-", "side-brand", "head-spend"]) {
      expect(kit, `"${name}" is Board Room's screen, not the Pentagon's kit`).not.toContain(name);
    }
  });

  it("is opt-in — every rule is scoped to [data-kit]", () => {
    // THE ONE THAT MATTERS. .card, .field, .btn, .seg, .sheet and .empty are the
    // obvious names, and eight apps already owned them meaning different things.
    // Unscoped, this sheet silently restyled Macro's 26 form rows and turned
    // Runway's printed resume into a fixed-position modal.
    const rules = [...kit.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2].trim()).filter(Boolean);
    expect(rules.length).toBeGreaterThan(40);
    const unscoped = rules.filter((sel) => sel.split(",").some((one) => {
      const t = one.trim();
      if (!t || /^(from|to|[\d.]+%)$/.test(t)) return false;
      return !t.startsWith("[data-kit]") && !t.startsWith(":root") && !t.startsWith("html") && !t.startsWith("body");
    }));
    expect(unscoped, `these would hit every app that owns the name: ${unscoped.slice(0, 5).join(" | ")}`).toEqual([]);
  });

  it("respects the 10.5px type floor", () => {
    const sizes = [...kit.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(5);
    expect(sizes.filter((n) => n < 10.5)).toEqual([]);
  });

  it("gates its animation behind prefers-reduced-motion", () => {
    expect(kit + tokens).toMatch(/@media\s*\(prefers-reduced-motion/);
  });

  it("reduced motion actually stops motion, not just shortens it", () => {
    // Two holes an adversarial review found after four apps opted in:
    //
    // 1. The block killed DURATIONS, which does nothing to a transform applied
    //    by :active — that is a state, not an animation. Every button in every
    //    opted-in app still scaled on press for someone who had asked for no
    //    motion, and no app could fix it for itself: `[data-kit] button:active`
    //    is specificity (0,3,1) against an app's own (0,3,0) guard, and a media
    //    query adds nothing. One app had already shipped a workaround twin.
    // 2. `animation-duration: 0.01ms` on an INFINITE spinner does not stop it —
    //    it runs it at ~100,000 revolutions a second, a per-frame jitter that is
    //    worse than the motion it replaced.
    const block = kit.slice(kit.indexOf("@media (prefers-reduced-motion"));
    expect(block, "press transforms must be reset, not just shortened").toMatch(/button:active[^{]*\{[^}]*transform:\s*none/);
    expect(block, "an infinite spin must stop, not speed up").toMatch(/\.spinner[^{]*\{[^}]*animation-(iteration-count|name)/);
  });
});
