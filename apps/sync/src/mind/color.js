// ─── Colour reading for the mind canvas ──────────────────────────────────────
// Extracted from MindCanvas.jsx so the thing that crashed can be tested.
//
// The canvas took the whole tool down with "undefined is not an object
// (evaluating 'e.replace')". The parser was one line —
// `hex.replace("#","")` — and the port fed it two shapes it had never seen:
//
//   1. REGIONS[k].color, which does not exist on @cc/mind's regions. They carry
//      `tint`. Reading a missing field gave undefined, and undefined has no
//      .replace, so the tab blanked.
//   2. var(--bg), from the theme shim. This one is worse in kind: a string DOES
//      have .replace, so it parsed to NaN and painted invisible, with no error
//      anywhere to say so.
//
// Both are the same mistake — trusting the shape of a colour — so the fix is a
// reader that cannot be surprised rather than two corrected call sites. The
// canvas takes colour from a theme object, a region table and a palette, and any
// of them can change shape under a later edit. A tolerant reader turns that into
// a slightly wrong colour; a strict one turns it into a blank tool.

export const FALLBACK_HEX = "#8892A4";

/**
 * A hue per region.
 *
 * @cc/mind's REGIONS carry `tint`, which is a six-step grey ramp — correct for a
 * pure data package that must not assume anybody's palette, and useless on a
 * canvas: six shades of one grey makes the graph monochrome and the legend
 * decorative. Clarify's canvas relied on its regions being genuinely different
 * hues, so the port has to supply them.
 *
 * Chosen for a black page, and for meaning over prettiness: identity takes SYNC's
 * own accent because it is the tool describing itself, and the rest land where
 * their names already mean something in this app.
 */
export const REGION_HUE = Object.freeze({
  identity: "#C36BFF",   // orchid — SYNC's accent
  principle: "#6AA8FF",  // blue
  goal: "#35C08A",       // green
  signal: "#E0A030",     // amber
  knowledge: "#7FD1E8",  // cyan
  skill: "#EE6FA8",      // pink
});

export const hueOf = (region) => REGION_HUE[region] || FALLBACK_HEX;

// Resolved `var(--x)` lookups. Safe to cache: the shell hardcodes its theme, and
// SYNC's stylesheet is in the document before the canvas renders at all, because
// Root.jsx gates first paint on it.
const varCache = new Map();

/** Whatever colour string arrives, into something chan() can read. */
export function resolveColor(input) {
  if (typeof input !== "string" || !input.trim()) return FALLBACK_HEX;
  const s = input.trim();
  if (s.startsWith("#") || s.startsWith("rgb")) return s;
  const m = /^var\(\s*(--[\w-]+)/.exec(s);
  if (!m) return s;
  const hit = varCache.get(m[1]);
  if (hit) return hit;
  let v = "";
  try {
    const el = typeof document !== "undefined"
      ? (document.querySelector(".sy-root") || document.documentElement)
      : null;
    if (el) v = getComputedStyle(el).getPropertyValue(m[1]).trim();
  } catch { /* no DOM, or computed style unavailable */ }
  // Only cache a real answer — caching the fallback would freeze a miss that was
  // only a timing accident during boot.
  if (v) varCache.set(m[1], v);
  return v || FALLBACK_HEX;
}

/** [r, g, b], 0–255. Never throws, never returns NaN. */
export function chan(input) {
  const c = resolveColor(input);
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
