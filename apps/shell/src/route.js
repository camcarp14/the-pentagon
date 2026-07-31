// ─── The shell's URL ─────────────────────────────────────────────────────────
//
// The shell held the active tool in plain React state and never touched
// location, so the address bar said nothing about where you were. Three
// consequences, all daily:
//
//   · Reload dumped you on the first visible tool, whatever you were doing.
//   · The back button left the site instead of stepping back a tool.
//   · There was no way to link to a tool — not to send one, not to bookmark one,
//     not to put one on a home screen.
//
// Deliberately minimal: one segment, the tool. Each tool keeps its own internal
// navigation exactly as it is today; this is the shell's level and nothing more.
// Going deeper would mean touching eight apps' routing at once, and Runway's is
// react-router while Clarify's is a private useState — a job of its own.
//
// BARE LOADS ARE UNCHANGED. App.jsx's comment records that a fresh load is meant
// to land on the first visible tool rather than wherever you were last. That
// intent is kept: an empty hash still resolves to tabs[0]. The hash only decides
// anything when it is actually there, which is the case this fixes.
//
// Pure, so the rules are testable without a browser.

/** The system panel is a destination, not a tool, and needs a name of its own. */
export const SYSTEM = "system";

/**
 * Read a location hash into a shell destination.
 *
 * @param {string} hash   e.g. "#/sync" — anything unrecognised is ignored
 * @param {string[]} tabs the tools currently visible in the toggle
 * @returns {{tool: string, system: boolean}}
 */
export function parseRoute(hash, tabs) {
  const visible = Array.isArray(tabs) && tabs.length ? tabs : [];
  const fallback = { tool: visible[0], system: false };
  if (typeof hash !== "string") return fallback;

  const seg = hash.replace(/^#\/?/, "").split(/[/?]/)[0].trim().toLowerCase();
  if (!seg) return fallback;
  if (seg === SYSTEM) return { tool: visible[0], system: true };
  // A hash naming a HIDDEN tool resolves to the fallback rather than forcing it
  // visible: the toggle is the operator's statement about what they want to see,
  // and a stale bookmark should not overrule it.
  if (visible.includes(seg)) return { tool: seg, system: false };
  return fallback;
}

/** The hash for a destination. Always absolute, always one segment. */
export function formatRoute({ tool, system }) {
  return system ? `#/${SYSTEM}` : `#/${tool || ""}`;
}

/** True when the hash already says this, so we never push a redundant entry. */
export function sameRoute(hash, dest) {
  return typeof hash === "string" && hash.replace(/^#\/?/, "").toLowerCase()
    === formatRoute(dest).replace(/^#\/?/, "").toLowerCase();
}
