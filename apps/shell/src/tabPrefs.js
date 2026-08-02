// ═══════════════════════════════════════════════════════════════════════════
// TAB PREFERENCES — which tools are in the toggle, and in what order.
//
// The shell shipped all six tools, always, in one hardcoded order. Three of
// them are not in daily use, and a toggle carrying six segments on a 390px
// phone gives each of them ~60px — so the tools that ARE used were paying for
// the ones that were not, on the surface where space is scarcest.
//
// This is preference, not configuration: it changes what the operator sees and
// nothing about what runs. Hiding Macro does not stop watch-snapshot; hiding
// Business does not halt the agent. Scheduled functions do not read this file
// and must not — a UI preference that silently disarms a subsystem is the kind
// of coupling that gets someone hurt at 3am.
//
// FOUR INVARIANTS, each enforced here rather than in the UI, because a
// component is not where "the app cannot end up with zero tabs" belongs:
//
//   1. NEVER ZERO VISIBLE. Hiding the last tab would leave the shell with no
//      way back to any tool — a preference that bricks the product.
//   2. NEW TOOLS APPEAR. A tool added to APPS later is appended and visible.
//      Stored prefs are a filter over the live list, never a replacement for
//      it, or shipping a seventh tool would show it to nobody.
//   3. REMOVED TOOLS VANISH. An id no longer in APPS is dropped rather than
//      rendered as a dead segment pointing at a tool that no longer exists.
//   4. ORDER IS ALWAYS A PERMUTATION OF APPS. Duplicates collapse, unknowns
//      drop, missing ones append — so the toggle can render straight from it
//      without defensive checks at every call site.
//
// Pure except for the two explicit localStorage functions, so the rules above
// are testable without a DOM.
// ═══════════════════════════════════════════════════════════════════════════
import { APPS } from "@cc/design";

export const TAB_PREFS_KEY = "cc_tab_prefs";

/**
 * Hidden on a fresh install: Macro, Looper and Business.
 *
 * Not a judgement about the tools — it is the honest default for how this
 * account uses them today, and it keeps the phone dock focused. Every one can
 * be restored from System → Tools.
 */
export const DEFAULT_HIDDEN = Object.freeze(["macro", "looper", "business"]);

const known = (app) => APPS.includes(app);

/**
 * Fold whatever is in storage onto the live APPS list.
 *
 * Takes anything — null, a string, a half-written object from an older build —
 * and returns a usable shape. It never throws and never returns an empty
 * toggle, because the caller is the shell's render path and there is no
 * sensible error state for "your tab bar is malformed".
 */
export function normalizeTabPrefs(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};

  // Order: stored entries that still exist, deduped, then anything new appended
  // in its APPS position. That append is what makes a future seventh tool show
  // up for an operator whose prefs predate it.
  const seen = new Set();
  const order = [];
  for (const app of Array.isArray(src.order) ? src.order : []) {
    if (typeof app === "string" && known(app) && !seen.has(app)) { seen.add(app); order.push(app); }
  }
  for (const app of APPS) if (!seen.has(app)) order.push(app);

  const storedHidden = Array.isArray(src.hidden) ? src.hidden : null;
  const hidden = new Set(
    (storedHidden ?? DEFAULT_HIDDEN).filter((a) => typeof a === "string" && known(a)),
  );

  // Invariant 1. If every tool ended up hidden — by a bad import, or by a
  // future release retiring the only visible one — reveal the first in order
  // rather than rendering an empty bar.
  if (hidden.size >= order.length) hidden.delete(order[0]);

  return { order, hidden: order.filter((a) => hidden.has(a)) };
}

export function loadTabPrefs() {
  try {
    return normalizeTabPrefs(JSON.parse(localStorage.getItem(TAB_PREFS_KEY)));
  } catch {
    return normalizeTabPrefs(null);
  }
}

export function saveTabPrefs(prefs) {
  const next = normalizeTabPrefs(prefs);
  try { localStorage.setItem(TAB_PREFS_KEY, JSON.stringify(next)); } catch { /* private mode; the session still works */ }
  return next;
}

/** The ordered list the toggle actually renders. */
export function visibleTabs(prefs) {
  const { order, hidden } = normalizeTabPrefs(prefs);
  const h = new Set(hidden);
  return order.filter((a) => !h.has(a));
}

export const isHidden = (prefs, app) => normalizeTabPrefs(prefs).hidden.includes(app);

/**
 * May this tool be hidden right now?
 *
 * Exported so the UI can DISABLE the control and explain the rule, instead of
 * accepting a tap and doing nothing — a button that silently no-ops reads as a
 * bug, and there is no way for the operator to learn the rule from it. A
 * tool that is already hidden answers false: there is nothing to hide.
 */
export function canHide(prefs, app) {
  const cur = normalizeTabPrefs(prefs);
  if (!known(app) || cur.hidden.includes(app)) return false;
  return cur.order.length - cur.hidden.length > 1; // invariant 1
}

/**
 * Show or hide one tool.
 *
 * Hiding the last visible tool is refused — see invariant 1. A refusal returns
 * an equal-but-normalized object rather than a distinct sentinel, so callers
 * that need to know BEFORE acting should ask canHide(); it is the predicate the
 * System editor gates its control on.
 */
export function toggleTab(prefs, app) {
  const cur = normalizeTabPrefs(prefs);
  if (!known(app)) return cur;
  const hidden = new Set(cur.hidden);
  if (hidden.has(app)) hidden.delete(app);
  else {
    if (!canHide(cur, app)) return cur; // invariant 1
    hidden.add(app);
  }
  return { order: cur.order, hidden: cur.order.filter((a) => hidden.has(a)) };
}

/**
 * Move a tool one place. `dir` is -1 for earlier, +1 for later.
 *
 * Moves within the FULL order, including hidden neighbours, so a tool does not
 * appear to skip two places because something invisible sat between them — and
 * so re-showing a hidden tool restores it where the operator left it.
 */
export function moveTab(prefs, app, dir) {
  const cur = normalizeTabPrefs(prefs);
  const i = cur.order.indexOf(app);
  const j = i + (dir < 0 ? -1 : 1);
  if (i === -1 || j < 0 || j >= cur.order.length) return cur;
  const order = [...cur.order];
  [order[i], order[j]] = [order[j], order[i]];
  return { order, hidden: order.filter((a) => cur.hidden.includes(a)) };
}

export function resetTabPrefs() {
  return normalizeTabPrefs({ order: [...APPS], hidden: [...DEFAULT_HIDDEN] });
}

/**
 * Which tool should be showing, given a preference change.
 *
 * Hiding the tool you are looking at has to go somewhere. Falling back to the
 * first visible tab is the only answer that cannot strand the operator on a
 * surface the toggle can no longer reach.
 */
export function resolveActive(prefs, active) {
  const vis = visibleTabs(prefs);
  return vis.includes(active) ? active : vis[0];
}
