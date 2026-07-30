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
};

const STATIC = Object.freeze({
  glassBorder: "rgba(255,255,255,0.05)",
  line: "rgba(255,255,255,0.08)",
  lineSoft: "rgba(255,255,255,0.05)",
  nodeStroke: "rgba(255,255,255,0.20)",

  selectLine: "rgba(195,107,255,0.32)",
  focusRing: "rgba(195,107,255,0.34)",
  shadow: "0 10px 28px rgba(0,0,0,0.55), 0 2px 10px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.06)",
  glow: "0 0 24px rgba(195,107,255,0.20)",
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
  // The HUD panel is the page colour at 80%, the way SYNC's copy always built
  // it — so it follows --bg between Obsidian (#000000) and the shell (#0B0F1A)
  // instead of pinning one of them.
  return { ...p, glass: rgba(p.bg, 0.8) };
}
