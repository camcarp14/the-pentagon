// ─── SYNC's mind palette ──────────────────────────────────────────────────────
// SYNC is the one host that cannot hand over a constant.
//
// It renders under two different palettes for real: standalone it is Obsidian
// (--bg #000000, --accent #6AA8FF), and mounted inside the Pentagon shell it
// republishes as (--bg #0B0F1A, --accent #C36BFF). The shell also re-stamps its
// custom properties on every tool switch. So the answer depends on where the
// canvas is standing, and it has to be asked at mount rather than at import.
//
// The old code did this inside the canvas, with a module-level Map cache keyed by
// variable NAME — no element, no app, no theme — and a `document.querySelector(
// ".sy-root")` lookup. Both were fine while exactly one app used the file and
// wrong the moment it was shared: the selector finds nothing in ZTS or Clarify,
// and the first reader would have frozen the cache for every app after it.
// Resolution belongs to the host; the component takes finished colours.

import { useEffect, useState } from "react";
import { resolveVars, rgba } from "@cc/mind-canvas";

/**
 * Region hues. SYNC's own table — deliberately six distinguishable hues rather
 * than @cc/mind's `tint`, which is a neutral grey ramp correct for a pure data
 * package and unreadable on a canvas. Reading a `.color` field off @cc/mind's
 * REGIONS is what blanked this tab; the hue lives here instead.
 */
const REGION_HUE = Object.freeze({
  identity: "#C36BFF",   // orchid — SYNC's own accent; it is the tool describing itself
  principle: "#6AA8FF",
  goal: "#35C08A",
  signal: "#E0A030",
  knowledge: "#7FD1E8",
  skill: "#EE6FA8",
});

/**
 * What to resolve, and against what.
 *
 * Only tokens that feed COLOUR MATHS are read from custom properties. The
 * composites (shadow, glow) are literals: `--accent-a20` and friends are
 * color-mix() values, which resolve to an unparsed token stream, and the
 * previous code fed one straight into a box-shadow slot where a bare colour is
 * not a valid shadow at all. That declaration never rendered.
 */
const SPEC = {
  bg: "var(--bg, #0B0F1A)",
  surface: "var(--glass, #141B2C)",
  ink: "var(--ink, #E9EDF5)",
  sub: "var(--sub, #94A1B5)",
  select: "var(--accent, #C36BFF)",
  selectHi: "var(--accent-hi, #D89BFF)",
  synapse: "var(--accent, #C36BFF)",
  synapseHi: "var(--accent-hi, #D89BFF)",
  inhibit: "var(--red, #F87171)",
  speckInk: "var(--ink, #E9EDF5)",
  // Read for its side effects on the four derived values below, and dropped
  // before the palette is handed over — the canvas has no `shadowFloat` key and
  // normalizePalette() warns about anything it does not know.
  shadowFloat: "var(--shadow-float)",
};

/**
 * The eight tokens that are NOT read from a variable, and the one rule they
 * follow now: derive from a resolved token, never from a literal.
 *
 * Every one of these used to be a literal, and every one of them was a
 * dark-room literal — four white hairlines at 5-20%, a black three-part shadow,
 * and the orchid accent written out by hand in three places. That was invisible
 * while the Pentagon was dark-only and is the "half-migrated corner" the moment
 * data-theme reaches light: a 5%-white hairline on paper is nothing at all, a
 * 20%-white node stroke is a halo around every neuron, and 55%-black under the
 * canvas toast is a grey smear rather than depth.
 *
 * They cannot move into SPEC, because the canvas takes finished colours and
 * these need an alpha the token layer does not publish a variable for. Deriving
 * them from `ink` and `select` — which ARE resolved, and which both have a light
 * half — gets the same result in both rooms from one expression.
 *
 * On the FIRST render, before the effect below has resolved anything, `ink` and
 * `select` are still `var(--…)` strings and chan()'s tolerant parser returns its
 * grey sentinel for them. That is one frame, it is what `glass` has always done
 * here, and the package documents the grey as "a colour was missing" rather than
 * as a crash.
 */
function derived(p) {
  const shadow = /\dpx/.test(p.shadowFloat || "")
    ? p.shadowFloat
    // Only if --shadow-float is genuinely absent (a standalone dev entry with
    // no shell). resolveVars hands back its own grey sentinel there, which is
    // not a valid shadow list at all, so a length check is the guard.
    : "0 10px 28px rgba(0,0,0,0.55), 0 2px 10px rgba(0,0,0,0.4)";
  return {
    glassBorder: rgba(p.ink, 0.06),
    line: rgba(p.ink, 0.10),
    lineSoft: rgba(p.ink, 0.05),
    nodeStroke: rgba(p.ink, 0.20),

    selectLine: rgba(p.select, 0.32),
    focusRing: rgba(p.select, 0.34),
    shadow,
    glow: `0 0 24px ${rgba(p.select, 0.2)}`,
  };
}

const STATIC = Object.freeze({
  fontDisplay: "var(--font-body)",
  fontMono: "var(--font-mono)",
  region: REGION_HUE,
});

/**
 * Resolve SYNC's palette against a live element.
 *
 * @param {import("react").RefObject<Element>} ref  an element inside the SYNC subtree
 * @returns the palette, re-resolved once the ref is attached
 */
export function useSyncMindPalette(ref) {
  const [resolved, setResolved] = useState(null);

  useEffect(() => {
    // After mount, so the element is in the document and the shell has stamped
    // its variables. Falls back to SPEC's own declared defaults when a variable
    // is genuinely absent, which is what the var(--x, …) fallbacks are for.
    setResolved(resolveVars(ref?.current || null, SPEC));
  }, [ref]);

  const p = { ...STATIC, ...SPEC, ...(resolved || null) };
  const { shadowFloat, ...rest } = { ...p, ...derived(p) };
  // The HUD panel is the page colour at 80%, the way SYNC's copy always built
  // it — so it follows --bg between a true-black standalone room, the Pentagon's
  // dark ground and the Pentagon's paper one instead of pinning any of them.
  return { ...rest, glass: rgba(p.bg, 0.8) };
}
