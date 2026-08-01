// ═══════════════════════════════════════════════════════════════════════════
// ENGINE PANEL PREFERENCE — is the Outbound engine card open, and who decides.
//
// The card is the first thing on Clarify Today and it runs ~700px on a phone,
// which pushed the pipeline, the portfolio and the AI spend below the fold on
// every visit. Collapsing it is the fix; remembering the collapse across a
// reload is what makes it a preference rather than a fidget.
//
// SAME DEFENSIVE POSTURE AS apps/shell/src/tabPrefs.js. This is read on a
// render path with whatever localStorage happens to hold — a null, a string, a
// half-written object from an older build — so `normalize` takes anything and
// always returns a usable shape. It never throws. There is no sensible error
// state for "your card is malformed".
//
// THE ONE RULE THAT IS NOT A PREFERENCE
//
//   A card that hid a STOPPED engine by default would be the tool concealing
//   the single fact it exists to report.
//
// So `resolveOpen` takes the operator's stored answer AND the engine's live
// attention flag, and attention wins. Three states, deliberately, not two:
//
//   open === true   the operator opened it and wants it open
//   open === false  the operator closed it and wants it closed
//   open === null   the operator has never said, so the state decides
//
// A boolean could not tell "closed on purpose" from "never asked", and those
// two want different first paints on a healthy engine.
//
// `attention === null` means NOT KNOWN YET — the first fetch has not landed.
// It is not the same as false, and it must never be collapsed into it: a
// missing input that quietly reads as "nothing is wrong" is exactly the shape
// of failure this repo has already shipped once.
//
// Pure except for the two explicit localStorage functions, so every rule above
// is testable without a DOM.
// ═══════════════════════════════════════════════════════════════════════════

export const ENGINE_PANEL_PREFS_KEY = "cc_clarify_engine_panel";

/**
 * Fold whatever is in storage into { open: true | false | null }.
 *
 * Anything that is not an actual boolean becomes null — "no preference" — so a
 * corrupted value falls back to letting the engine's own state decide rather
 * than pinning the card open or shut on garbage.
 */
export function normalizeEnginePanelPrefs(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return { open: typeof src.open === "boolean" ? src.open : null };
}

export function loadEnginePanelPrefs() {
  try {
    return normalizeEnginePanelPrefs(JSON.parse(localStorage.getItem(ENGINE_PANEL_PREFS_KEY)));
  } catch {
    return normalizeEnginePanelPrefs(null);
  }
}

export function saveEnginePanelPrefs(prefs) {
  const next = normalizeEnginePanelPrefs(prefs);
  try {
    localStorage.setItem(ENGINE_PANEL_PREFS_KEY, JSON.stringify(next));
  } catch { /* private mode; the session still works, it just forgets */ }
  return next;
}

/**
 * Should the card be open right now?
 *
 *   attention === true   → open, whatever is stored. The engine is stopped, or
 *                          blocked, or unreadable, or a prospect has replied.
 *   attention === null   → not known yet: honour the stored answer and wait.
 *   attention === false  → the operator's answer, and closed if they have none.
 *
 * The last line is the whole point of the change: on a healthy engine the
 * default is CLOSED, so the three cards underneath it start above the fold.
 */
export function resolveOpen(prefs, attention) {
  if (attention === true) return true;
  return normalizeEnginePanelPrefs(prefs).open === true;
}
