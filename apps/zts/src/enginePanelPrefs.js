// ═══════════════════════════════════════════════════════════════════════════
// ZTS WRITER PANEL PREFERENCE.
//
// The writer is a dense operational panel. Keeping a healthy one folded lets
// Studio start above the fold, but a stopped, failed, or unreadable writer must
// still surface itself. `null` deliberately means "no preference yet" so the
// fetched state, rather than malformed storage, decides that first paint.
// ═══════════════════════════════════════════════════════════════════════════

export const ENGINE_PANEL_PREFS_KEY = "cc_zts_engine_panel";

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
  } catch { /* private browsing may forget the preference, but cannot break the panel */ }
  return next;
}

export function resolveOpen(prefs, attention) {
  if (attention === true) return true;
  return normalizeEnginePanelPrefs(prefs).open === true;
}
