// The guards that keep the fork from re-forming.
//
// This repo has no jsdom, so a React component cannot be mounted in a test. It
// does have a house style for exactly this problem — apps/sync/src/__tests__/
// mount.test.js parses SYNC's stylesheet as text and asserts properties of it —
// and these are the same idea applied to the thing that just got merged.
//
// They matter more than usual here. Every defect this consolidation fixed was
// invisible to the build: a duplicated file compiles, a globally-scoped
// stylesheet compiles, a colour token that does not exist compiles and renders
// as the string "undefined" inside a CSS declaration the browser then discards.
// The only thing standing between those and production was somebody noticing.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { MIND_CSS, STYLE_ID, paletteVars, acquireStyle, __resetStyleRefs, __styleRefs } from "../css.js";
import { normalizePalette, PALETTE_KEYS } from "../palette.js";

const here = dirname(fileURLToPath(import.meta.url));
const PKG = join(here, "..");
const REPO = join(PKG, "..", "..");
const read = (p) => readFileSync(join(REPO, p), "utf8");

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

describe("there is exactly one mind canvas", () => {
  const sources = walk(join(REPO, "apps")).concat(walk(join(REPO, "packages")));

  it("no app carries a copy any more", () => {
    // 3,236 lines across three files, all of them the same component with a
    // different palette baked in. Each fix landed in one copy and not the other
    // two; the crash that blanked SYNC's Mind tab was still live in Clarify on
    // the day this merge started.
    const copies = sources.filter((p) => /MindCanvas\.jsx$/.test(p));
    expect(copies.map((p) => relative(REPO, p))).toEqual(["packages/mind-canvas/MindCanvas.jsx"]);
  });

  it("the deleted copies are really gone", () => {
    for (const p of [
      "apps/zts/src/dna/MindCanvas.jsx",
      "apps/clarify/src/features/dna/MindCanvas.jsx",
      "apps/sync/src/mind/MindCanvas.jsx",
      "apps/sync/src/mind/color.js",
    ]) expect(existsSync(join(REPO, p)), `${p} should not exist`).toBe(false);
  });

  it("every host imports the shared one", () => {
    for (const p of [
      "apps/zts/src/dna/DnaView.jsx",
      "apps/clarify/src/features/dna/DnaView.jsx",
      "apps/sync/src/pages/MindPage.jsx",
    ]) {
      expect(read(p), p).toContain('from "@cc/mind-canvas"');
    }
  });

  it("every host passes a palette — it is not optional", () => {
    for (const p of [
      "apps/zts/src/dna/DnaView.jsx",
      "apps/clarify/src/features/dna/DnaView.jsx",
      "apps/sync/src/pages/MindPage.jsx",
    ]) {
      expect(read(p), p).toMatch(/palette=\{/);
    }
  });
});

/** Source with comments removed — the file DISCUSSES the traps it avoids, and a
 *  naive scan cannot tell an explanation from a call site. */
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the component resolves no colour of its own", () => {
  const src = stripJsComments(readFileSync(join(PKG, "MindCanvas.jsx"), "utf8"));

  it("never reaches for the document to find a colour", () => {
    // The old SYNC copy resolved CSS custom properties through
    // `document.querySelector(".sy-root")`, cached in a module-level Map keyed
    // by variable name alone. Correct for one app; in a shared component that
    // selector finds nothing in ZTS or Clarify and the cache freezes the first
    // reader's answer for everyone. Resolution belongs to the host.
    expect(src).not.toMatch(/getComputedStyle/);
    expect(src).not.toMatch(/querySelector/);
    expect(src).not.toMatch(/sy-root/);
  });

  it("holds no module-scope colour state", () => {
    // Two of the three copies evaluated their CSS template at import time, so
    // the canvas could not follow a runtime theme change.
    expect(src).not.toMatch(/^const\s+T\s*=/m);
    expect(src).not.toMatch(/new Map\(\)[\s\S]{0,40}cache/i);
  });

  it("takes region hue from the palette, never from a REGIONS field", () => {
    // `REGIONS[k].color` is what blanked the tab: @cc/mind's regions carry
    // `tint`, and undefined has no .replace. REGIONS may supply labels only.
    expect(src).not.toMatch(/REGIONS\[[^\]]+\]\.color/);
    expect(src).not.toMatch(/\.tint\b/);
  });
});

describe("the stylesheet is shared, palette-free and namespaced", () => {
  it("contains no baked-in colour", () => {
    // Three copies injected globally-scoped selectors with their own accent
    // interpolated in. Same document in the shell, later mount wins — so which
    // accent Clarify's drop target wore depended on tab order.
    const stripped = MIND_CSS.replace(/rgba\(255,255,255,[\d.]+\)/g, "");   // neutral scrims are fine
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(stripped).not.toMatch(/\$\{/);                                   // no interpolation at all
  });

  it("routes every colour through a --mind-* custom property", () => {
    const vars = [...MIND_CSS.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
    expect(vars.length).toBeGreaterThan(3);
    for (const v of vars) expect(v.startsWith("--mind-"), `${v} is not namespaced`).toBe(true);
  });

  it("supplies every variable the sheet asks for", () => {
    // A var() with no value is the silent-failure shape all over again.
    const supplied = new Set(Object.keys(paletteVars(normalizePalette({}, { onWarn: () => {} }))));
    for (const v of new Set([...MIND_CSS.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))) {
      expect(supplied.has(v), `${v} is used in MIND_CSS but never set by paletteVars`).toBe(true);
    }
  });

  it("owns its keyframe instead of borrowing the host's", () => {
    // `fadein` was defined in ZTS's canvas, again in ZTS's App.jsx with a
    // DIFFERENT animation, again in macro's stylesheet — and not at all in the
    // Clarify and SYNC copies, which used it anyway.
    expect(MIND_CSS).toContain("@keyframes ccMindFadein");
    expect(MIND_CSS).not.toMatch(/@keyframes fadein\b/);
    const comp = stripJsComments(readFileSync(join(PKG, "MindCanvas.jsx"), "utf8"));
    expect(comp).not.toMatch(/animation:[^;"`]*[^A-Za-z]fadein\b/);
  });

  it("keeps the HUD focus ring that only ZTS had", () => {
    // Taking any other copy as the base would have deleted keyboard focus
    // feedback from the HUD in all three apps.
    expect(MIND_CSS).toMatch(/\.dna-hudbtn:focus-visible/);
  });

  it("meets the 44px touch floor on phones", () => {
    expect(MIND_CSS).toMatch(/min-width:\s*44px/);
    expect(MIND_CSS).toMatch(/min-height:\s*44px/);
  });

  it("styles nothing outside its own component", () => {
    // Comments are stripped first: the sheet explains itself, and a `/* … */`
    // block sitting before a rule reads as part of that rule's prelude.
    const sheet = MIND_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...sheet.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2].trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(5);
    for (const sel of selectors) {
      for (const one of sel.split(",")) {
        const t = one.trim();
        if (!t || /^(from|to|[\d.]+%)$/.test(t)) continue;
        expect(t.startsWith(".dna-"), `"${t}" escapes the component`).toBe(true);
      }
    }
  });
});

describe("the sheet is injected once and reference-counted", () => {
  // A fake document, because there is no jsdom here.
  const mkDoc = () => {
    const byId = new Map();
    return {
      head: { appendChild: (el) => byId.set(el.id, el) },
      createElement: () => ({ id: "", textContent: "", get parentNode() { return { removeChild: (e) => byId.delete(e.id) }; } }),
      getElementById: (id) => byId.get(id) || null,
      __count: () => byId.size,
    };
  };

  it("adds one tag for many canvases and removes it only when the last leaves", () => {
    // The old code appended a tag per instance and removed its own on unmount.
    // With a singleton that would strip the styling from any canvas still on
    // screen, so the count has to be held.
    __resetStyleRefs();
    const doc = mkDoc();
    const a = acquireStyle(doc);
    const b = acquireStyle(doc);
    expect(doc.__count()).toBe(1);
    expect(doc.getElementById(STYLE_ID).textContent).toBe(MIND_CSS);
    a();
    expect(doc.__count(), "the second canvas still needs the sheet").toBe(1);
    b();
    expect(doc.__count()).toBe(0);
  });

  it("survives an effect cleanup running twice", () => {
    // React 18 StrictMode mounts, unmounts and remounts in development.
    __resetStyleRefs();
    const doc = mkDoc();
    const a = acquireStyle(doc);
    const b = acquireStyle(doc);
    a(); a(); a();
    expect(__styleRefs()).toBe(1);
    expect(doc.__count()).toBe(1);
    b();
    expect(doc.__count()).toBe(0);
  });

  it("no-ops without a document instead of throwing", () => {
    __resetStyleRefs();
    expect(() => acquireStyle(null)()).not.toThrow();
  });
});

describe("the activation bus survives the move", () => {
  it("is passed by every host that has one", () => {
    // Nearly shipped as a silent regression. ZTS and Clarify both run an
    // activation worker that emits through their own dnaBus, and the old copies
    // imported it directly. Making the bus a prop with a no-op default meant a
    // host that forgot to pass it would render a mind that simply never fires —
    // no error, no warning, just a graph that stopped being alive.
    for (const p of ["apps/zts/src/dna/DnaView.jsx", "apps/clarify/src/features/dna/DnaView.jsx"]) {
      const src = read(p);
      expect(src, `${p} emits activations but never hands the canvas its bus`).toMatch(/bus=\{dnaBus\}/);
      expect(src).toMatch(/dnaBus\.emit\(\{\s*type:\s*"activation"/);
    }
  });

  it("SYNC deliberately has none, and the component tolerates that", () => {
    // SYNC has no activation worker; its mind is edited, not fired.
    expect(read("apps/sync/src/pages/MindPage.jsx")).not.toMatch(/bus=/);
    const comp = stripJsComments(readFileSync(join(PKG, "MindCanvas.jsx"), "utf8"));
    expect(comp).toMatch(/bus \|\| NULL_BUS/);
  });
});

describe("every declared knob is actually wired", () => {
  // The failure this prevents is the one that motivated the whole palette
  // contract: a key that is declared, passed by a host, read by nobody. ZTS
  // passed nodePaint:"solid" and containerWash:true for a while before the
  // component honoured either, so its nodes would have silently changed from a
  // flat disc to a gradient orb on merge day — the exact regression the `look`
  // prop exists to prevent, hiding inside the mechanism meant to prevent it.
  const comp = stripJsComments(readFileSync(join(PKG, "MindCanvas.jsx"), "utf8"));
  const declared = [...readFileSync(join(PKG, "MindCanvas.jsx"), "utf8")
    .match(/LOOK_DEFAULTS = Object\.freeze\(\{([\s\S]*?)\}\)/)[1]
    .matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);

  it("declares a look the merge actually needs", () => {
    expect(declared.length).toBeGreaterThan(4);
  });

  it("reads every key it declares", () => {
    for (const k of declared) {
      expect(comp.includes(`LOOK.${k}`), `look.${k} is declared but never read`).toBe(true);
    }
  });

  it("reads every palette key it declares", () => {
    const src = stripJsComments(readFileSync(join(PKG, "palette.js"), "utf8"))
      + stripJsComments(readFileSync(join(PKG, "css.js"), "utf8")) + comp;
    for (const k of PALETTE_KEYS) {
      expect(src.includes(`T.${k}`) || src.includes(`p.${k}`), `palette.${k} is declared but never read`).toBe(true);
    }
  });
});

describe("each host's palette is a faithful transcription", () => {
  it("ZTS keeps energy and intent as different hues", () => {
    // The whole reason the accent is two roles. If these ever collapse, ZTS's
    // selection ring turns green and no other test in this repo would notice.
    const src = read("apps/zts/src/dna/palette.js");
    const get = (k) => (src.match(new RegExp(`\\b${k}:\\s*"([^"]+)"`)) || [])[1];
    expect(get("synapse")).toBe("#3ECF8E");
    expect(get("select")).toBe("#E3B341");
    expect(get("synapse")).not.toBe(get("select"));
  });

  it("ZTS keeps its own look, so the merge was invisible to it", () => {
    const src = read("apps/zts/src/dna/palette.js");
    expect(src).toMatch(/nodePaint:\s*"solid"/);
    expect(src).toMatch(/centreLamp:\s*false/);
  });

  it("SYNC resolves its palette against a live element, not at import", () => {
    // SYNC genuinely renders two palettes — Obsidian standalone, Pentagon
    // in-shell — and the shell re-stamps its variables on every tool switch.
    const src = read("apps/sync/src/mind/palette.js");
    expect(src).toContain("resolveVars");
    expect(src).toMatch(/useEffect/);
  });
});
