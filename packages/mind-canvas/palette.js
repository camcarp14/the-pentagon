// ═══════════════════════════════════════════════════════════════════════════
// @cc/mind-canvas/palette — THE ONLY WAY COLOUR ENTERS THE CANVAS.
//
// The canvas used to exist three times, once per tool, and the reason was
// always colour: ZTS read a module-scope token literal, Clarify imported its
// theme.js, SYNC read CSS custom properties through a shim. Everything else —
// physics, gestures, camera, pulses — was already the same code. So the fork
// cost 3,236 lines to express what is really one component and three palettes.
//
// This module is the seam. Two rules keep it from re-forking:
//
//   1. THE CANVAS NEVER LOOKS A COLOUR UP. No getComputedStyle, no
//      document.querySelector, no module-level cache, no CSS var resolution
//      inside the component. Hosts hand it finished colours. The previous
//      attempt cached `var()` lookups in a module Map keyed by variable NAME
//      alone — which was correct for exactly as long as one app used it, and
//      silently wrong the moment the shell started swapping palettes per tool.
//
//   2. THE KEY SET IS DECLARED AND CHECKED. SYNC's shim omitted
//      `shadowPopover`; two call sites read it; one produced the literal string
//      "undefined, var(--accent-a20)", which is an invalid shadow list, so the
//      browser dropped the whole declaration. No error, no warning, just a
//      toast with no depth for however many months. An unenumerated token bag
//      buys that. normalizePalette() enumerates, fills, and complains.
//
// THE TWO-ROLE ACCENT IS LOAD-BEARING. ZTS uses emerald for ENERGY (synapses,
// activation particles, the firing flare) and amber for INTENT (selection halo,
// focus ring, drop target, rubber band, the physics-on HUD state). Clarify and
// SYNC happen to use one accent for both. A palette with a single `accent` key
// would compile, render, pass every test, and quietly turn ZTS's selection ring
// green — a regression nothing would catch and nobody would report. So the two
// roles are separate keys, and an app that wants them identical says so.
//
// Pure: no DOM, no React, no imports. Colour resolution against a live element
// is a separate, opt-in concern (see resolveVars).
// ═══════════════════════════════════════════════════════════════════════════

/** Grey that says "a colour was missing" without looking broken on a dark page. */
export const FALLBACK_HEX = "#8892A4";

/**
 * The six regions, in compile order.
 *
 * Deliberately NOT imported from @cc/mind. That package's REGIONS carry `tint`,
 * a six-step neutral grey ramp, and its header is explicit that a pure data
 * package must not assume anybody's palette. It is right, and it is also why
 * every copy of the canvas had to source hue somewhere else — Clarify from
 * REGIONS[k].color in its own dna.js, ZTS from its own, SYNC from a bespoke
 * table. Reading `.color` off @cc/mind's regions is what blanked SYNC's Mind
 * tab: the field does not exist, and `undefined.replace` is a white screen.
 *
 * The canvas takes labels and ordering from @cc/mind and hue from the palette.
 */
export const REGION_KEYS = Object.freeze([
  "identity", "principle", "goal", "signal", "knowledge", "skill",
]);

/**
 * Every token the canvas reads, with a safe default.
 *
 * A default is not permission to omit a key — it is what stops one missing
 * token blanking a tool. normalizePalette warns in development for anything a
 * host did not supply, so an omission is visible on the first render rather
 * than in a screenshot months later.
 */
export const PALETTE_DEFAULTS = Object.freeze({
  // Surface and text
  bg: "#0B0F1A",              // page behind the mind — only used for the label halo
  surface: "#141B2C",         // link-port fill
  glass: "rgba(20,27,44,0.88)", // HUD / toast panel fill
  glassBorder: "rgba(255,255,255,0.07)",
  ink: "#E9EDF5",             // labels, toast text
  sub: "#94A1B5",             // HUD readouts and buttons
  line: "rgba(255,255,255,0.10)",     // HUD divider
  // (glassBorder covers the panel edge; there is no second hairline token,
  //  because a token nothing reads is how the shadow bug started.)
  nodeStroke: "rgba(255,255,255,0.20)",
  speckInk: "#8FA0B8",        // ambient dust

  // ENERGY — synapses, activation particles, the firing flare.
  synapse: "#3ECF8E",
  synapseHi: "#5EE0A8",

  // INTENT — selection halo, focus ring, drop target, rubber band, physics-on.
  // Same hue as `synapse` in Clarify and SYNC; deliberately different in ZTS.
  select: "#E3B341",
  selectHi: "#E3B341",        // brighter intent — selected-edge halo, drop target
  selectLine: "rgba(227,179,65,0.45)",   // intent hairline — port, padlock, toast border
  focusRing: "rgba(227,179,65,0.34)",

  // Inhibitory synapse — the dashed "outranks" edge.
  inhibit: "#F87171",

  // Depth. The token whose absence produced "undefined, var(--accent-a20)".
  shadow: "0 10px 30px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.45)",
  glow: "0 0 24px rgba(227,179,65,0.20)",

  fontDisplay: "ui-sans-serif, system-ui, sans-serif",
  fontMono: "ui-monospace, SFMono-Regular, monospace",
});

export const PALETTE_KEYS = Object.freeze(Object.keys(PALETTE_DEFAULTS));

/** Region hues that at least differ from each other, if a host supplies none. */
const REGION_DEFAULTS = Object.freeze({
  identity: "#2DD4A7",
  principle: "#A78BFA",
  goal: "#F472B6",
  signal: "#E3B341",
  knowledge: "#6EA8FE",
  skill: "#3ECF8E",
});

const isDev = () => {
  try {
    // Vite stamps import.meta.env; guarded so this stays importable from Node.
    return typeof process === "undefined" || process.env?.NODE_ENV !== "production";
  } catch { return false; }
};

/**
 * A host's palette, completed and checked.
 *
 * Returns a frozen object with every key in PALETTE_KEYS plus a full `region`
 * map. Missing keys fall back rather than rendering `undefined` into a CSS
 * string, and are reported once in development so the gap gets closed.
 *
 * @param {object} input     whatever the host passed
 * @param {object} [opts]    { onWarn } — injectable so tests can assert quietly
 */
export function normalizePalette(input, opts) {
  const p = input && typeof input === "object" ? input : {};
  const warn = opts?.onWarn ?? ((msg) => { if (isDev() && typeof console !== "undefined") console.warn(msg); });

  const missing = [];
  const out = {};
  for (const k of PALETTE_KEYS) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
    else { out[k] = PALETTE_DEFAULTS[k]; if (v === undefined) missing.push(k); }
  }

  const regionIn = p.region && typeof p.region === "object" ? p.region : {};
  const region = {};
  const missingRegions = [];
  for (const k of REGION_KEYS) {
    const v = regionIn[k];
    if (typeof v === "string" && v.trim()) region[k] = v.trim();
    else { region[k] = REGION_DEFAULTS[k]; missingRegions.push(k); }
  }
  out.region = Object.freeze(region);

  if (missing.length) warn(`[@cc/mind-canvas] palette is missing: ${missing.join(", ")} — using defaults. A missing token renders as "undefined" inside a CSS string and silently voids the whole declaration.`);
  if (missingRegions.length) warn(`[@cc/mind-canvas] palette.region is missing: ${missingRegions.join(", ")} — using defaults. Regions sharing a hue makes the graph unreadable.`);

  return Object.freeze(out);
}

// ─── Colour maths ────────────────────────────────────────────────────────────
// The tolerant parser, promoted from SYNC's color.js — the only one of the
// three copies that had it. Clarify and ZTS still carry the original one-liner:
//
//   const h = hex.replace("#", "")
//
// which throws on undefined (that is the crash that took the Mind tab down) and
// returns NaN on anything it does not recognise. NaN is the worse half: a
// string HAS .replace, so `var(--bg)` parsed silently to NaN and painted
// invisible with nothing in the console. Both failure modes are the same
// mistake — trusting the shape of a colour — so this cannot be surprised.
//
// What did NOT come across from color.js: the module-level varCache and the
// `.sy-root` lookup. Both are correct in an app and wrong in a shared package.

/** [r, g, b], 0–255. Never throws, never returns NaN. */
export function chan(input) {
  const c = typeof input === "string" && input.trim() ? input.trim() : FALLBACK_HEX;
  if (c.startsWith("rgb")) {
    const n = c.match(/[\d.]+/g) || [];
    return [Number(n[0]) || 0, Number(n[1]) || 0, Number(n[2]) || 0];
  }
  const h = c.replace("#", "");
  const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  const at = (i) => {
    const v = parseInt(full.slice(i, i + 2), 16);
    return Number.isFinite(v) ? v : 136;
  };
  return [at(0), at(2), at(4)];
}

export function lighten(input, amt) {
  const [r, g, b] = chan(input);
  const L = (v) => Math.round(v + (255 - v) * amt);
  return `rgb(${L(r)},${L(g)},${L(b)})`;
}

export function rgba(input, a) {
  const [r, g, b] = chan(input);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Resolve `var(--x)` strings against a live element — for hosts that theme
 * through CSS custom properties.
 *
 * Lives here rather than in the component on purpose. SYNC genuinely renders
 * two different palettes (standalone Obsidian: --bg #000000, --accent #6AA8FF;
 * inside the Pentagon shell: --bg #0B0F1A, --accent #C36BFF), and the shell
 * re-stamps its variables on every tool switch. Resolution therefore has to
 * happen against the element the canvas is actually mounted in, at mount, with
 * no cache that can outlive the answer.
 *
 * Anything that is not a var() reference passes through untouched, so a host
 * can mix literals and variables freely.
 *
 * @param {Element|null} el    element to resolve against — the canvas's own ancestor
 * @param {object} spec        { key: "var(--x)" | "#hex" | ... }, may nest one level for `region`
 */
export function resolveVars(el, spec) {
  const read = (s) => {
    if (typeof s !== "string") return s;
    const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/.exec(s.trim());
    if (!m) return s;
    let v = "";
    try {
      if (el && typeof getComputedStyle === "function") v = getComputedStyle(el).getPropertyValue(m[1]).trim();
    } catch { /* detached node, or no CSSOM */ }
    // The declared fallback inside var(--x, …) beats ours — the host said what
    // it wanted if the variable is absent.
    return v || (m[2] || "").trim() || FALLBACK_HEX;
  };

  const out = {};
  for (const [k, v] of Object.entries(spec || {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sub = {};
      for (const [k2, v2] of Object.entries(v)) sub[k2] = read(v2);
      out[k] = sub;
    } else out[k] = read(v);
  }
  return out;
}
