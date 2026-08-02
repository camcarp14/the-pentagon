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
// A stopped or unreadable state is shown in the closed header, but never forces
// this dense card open. `open: null` means the operator has not chosen and the
// default remains folded on every device.
//
// Pure except for the two explicit localStorage functions, so every rule above
// is testable without a DOM.
// ═══════════════════════════════════════════════════════════════════════════

export const ENGINE_PANEL_PREFS_KEY = "cc_clarify_engine_panel";

/**
 * Fold whatever is in storage into { open: true | false | null }.
 *
 * Anything that is not an actual boolean becomes null — "no preference" — so a
 * corrupted value falls back to the folded default rather than pinning the card
 * open or shut on garbage.
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
 * The operator's stored answer wins. Without one, the card is closed; its
 * header still carries the live state, including stopped and failed states.
 */
export function resolveOpen(prefs) {
  return normalizeEnginePanelPrefs(prefs).open === true;
}
