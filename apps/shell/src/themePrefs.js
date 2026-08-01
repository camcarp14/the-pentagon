// ═══════════════════════════════════════════════════════════════════════════
// THEME PREFERENCES — which palette the whole Pentagon wears, and whether the
// ground under it is light or dark.
//
// "add in a setting to be able to change the theme across the board, pull
// directly from how boardroom does that." Board Room's model is TWO independent
// axes because they answer two different questions: `[data-palette]` says which
// hue, `[data-theme]` says which ground. packages/design already emits all
// sixteen combinations (themes.css) and already publishes the picker's list with
// swatches (palettes.js, "Labels + swatches for any picker UI"). Nothing here
// invents a colour. This file decides which of the sixteen the shell asks for,
// remembers the answer, and — the part that actually makes it visible — hands
// back the inline variables that must STOP being stamped for the answer to
// reach the page.
//
// ── THE WIRING, because writing this file is the easy half ──────────────────
//
// apps/shell/src/main.jsx says it out loud: "App.jsx still stamps cssVars()
// inline on the wrapper, and an inline custom property beats a stylesheet one."
// So every `[data-palette][data-theme]` block in themes.css was already being
// applied to the wrapper and already being overruled, token for token, by
// `cssVars(active)` — which returns the MIDNIGHT table, one hardcoded dark
// ground, no light half. Flipping `data-theme` to "light" against that inline
// stamp changes nothing you can see: the attribute lands, the CSS matches, and
// the page stays dark. That is exactly the shape of failure this repo keeps
// re-learning — a setting that is written, exported, documented and tested and
// never wired to the thing it claims to control.
//
// themeVars() below is the wiring. It takes cssVars() and DELETES the names
// themes.css authors per palette per mode, so the stylesheet finally wins them,
// and re-expresses the rest of cssVars()'s dark-only vocabulary as references to
// tokens that already have a light half. No hex is copied by hand anywhere in
// this file, which is also why a ninth palette costs nothing here.
//
// ── SAME POSTURE AS tabPrefs.js ────────────────────────────────────────────
//
// Read on the render path with whatever localStorage happens to hold, so
// normalize takes null, a string, or a half-written object from an older build
// and always returns a pair the shell can stamp on an element. It never throws
// and never names a palette or a mode that does not exist — there is no
// sensible error state for "your colours are malformed".
//
// ── TWO DEFAULTS, BOTH DELIBERATE ──────────────────────────────────────────
//
//   • palette "match" (Match the tool). DESIGN.md §4.4: the accent says WHICH
//     TOOL YOU ARE IN, and that is its whole job. Overriding it spends the one
//     signal that still reads at an 8px dot, so it is a choice the operator
//     makes, never one they inherit from an upgrade.
//   • mode "dark", not "system". The Pentagon ships dark. Defaulting to
//     "system" would repaint the entire product for anyone whose laptop is in
//     light mode, on a release where they asked for a setting and not for a new
//     colour scheme. "System" is one tap away and, once chosen, follows
//     prefers-color-scheme live.
//
// Pure except for the two explicit localStorage functions and the two explicit
// matchMedia ones, so every rule above is testable without a DOM.
// ═══════════════════════════════════════════════════════════════════════════
import { cssVars } from "@cc/design";
import { PALETTES } from "@cc/design/palettes.js";

export const THEME_PREFS_KEY = "cc_theme_prefs";

/** The palette value that means "keep today's behaviour: follow the open tool". */
export const MATCH_TOOL = "match";

export const MODES = Object.freeze(["light", "dark", "system"]);
export const DEFAULT_THEME_PREFS = Object.freeze({ palette: MATCH_TOOL, mode: "dark" });

// Derived from the GENERATED list rather than restated. palettes.js is rewritten
// by `npm run themes`; a hardcoded copy here would be the second source of truth
// that DESIGN.md §2 exists to prevent, and it would go stale silently the day a
// ninth tool lands.
const PALETTE_KEYS = PALETTES.map((p) => p.key);
const known = (key) => PALETTE_KEYS.includes(key);

/**
 * Fold whatever is in storage into a palette/mode pair.
 *
 * Anything unrecognised falls back to the default for that AXIS ALONE — a
 * corrupt mode must not also throw away a valid palette, because losing half a
 * preference is more confusing than losing all of it.
 */
export function normalizeThemePrefs(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    palette: typeof src.palette === "string" && known(src.palette) ? src.palette : DEFAULT_THEME_PREFS.palette,
    mode: MODES.includes(src.mode) ? src.mode : DEFAULT_THEME_PREFS.mode,
  };
}

export function loadThemePrefs() {
  try {
    return normalizeThemePrefs(JSON.parse(localStorage.getItem(THEME_PREFS_KEY)));
  } catch {
    return normalizeThemePrefs(null);
  }
}

export function saveThemePrefs(prefs) {
  const next = normalizeThemePrefs(prefs);
  try { localStorage.setItem(THEME_PREFS_KEY, JSON.stringify(next)); } catch { /* private mode; the session still works */ }
  return next;
}

export function resetThemePrefs() {
  return normalizeThemePrefs(DEFAULT_THEME_PREFS);
}

/** The value for `data-theme`. Never "system" — that is a source, not a ground. */
export function resolveMode(prefs, systemPrefersDark) {
  const { mode } = normalizeThemePrefs(prefs);
  if (mode !== "system") return mode;
  return systemPrefersDark ? "dark" : "light";
}

/**
 * The value for `data-palette`.
 *
 * `fallback` is what "Match the tool" means at this moment — the open tool, or
 * "sync" while System is open, which is what the shell has always stamped there.
 */
export function resolvePalette(prefs, fallback) {
  const { palette } = normalizeThemePrefs(prefs);
  if (palette !== MATCH_TOOL) return palette;
  return known(fallback) ? fallback : PALETTE_KEYS[0];
}

/**
 * Is the resolved answer exactly what the shell rendered before this file
 * existed — the tool's own accent over MIDNIGHT?
 *
 * This is the switch between the two variable strategies below, and it is
 * deliberately computed from the RESOLVED result rather than from the stored
 * preference: "system" on a dark laptop and "dark" are the same picture, and the
 * one that has been in production for months is the one that should render it.
 * The default path therefore stays byte-identical to what shipped, and only an
 * operator who actually asked for something else pays for the change.
 */
export function isDefaultTheme(prefs, systemPrefersDark) {
  const p = normalizeThemePrefs(prefs);
  return p.palette === MATCH_TOOL && resolveMode(p, systemPrefersDark) === "dark";
}

// ─── the wiring ───────────────────────────────────────────────────────────────
//
// cssVars() names the whole vocabulary the eight tools read, and hardcodes every
// colour in it to MIDNIGHT. Three groups, three treatments:
//
//   null  — themes.css already authors this name for every palette in every
//           mode. The ONLY reason it was not reaching the page is the inline
//           stamp, so the fix is to stop stamping it.
//   var() — a legacy name with no generated twin, re-pointed at the generated
//           token that means the same thing. `--muted` is `--sub`; `--border` is
//           the `--line` the [data-palette] ladder derives; `--accent-ink` is
//           the generator's contrast-checked `--on-accent`. These are aliases,
//           not new colours.
//   absent from this table — genuinely mode-independent (radii, fonts, motion),
//           so cssVars()'s value is kept as-is.
//
// Ladder rungs are used in preference to ad-hoc color-mix wherever one exists,
// per tokens.css's own instruction ("Use the ladder, never ad-hoc rgba"). Every
// rung named here is declared either by themes.css's `[data-palette]` block or
// by tokens.css's `[data-theme]` blocks, and the wrapper carries both attributes.
const MODE_BOUND = {
  "--bg": null,
  "--surface": null,
  "--surface-2": null,
  "--ink": null,
  "--faint": null,
  "--accent": null,
  "--accent-hi": null,
  "--accent-deep": null,
  // tokens.css authors --shadow-card per mode; a midnight drop-shadow under a
  // white card is the single loudest tell that a "light mode" was never looked at.
  "--shadow-card": null,

  "--text": "var(--ink)",
  "--dim": "var(--sub)",
  "--muted": "var(--sub)",
  "--border": "var(--line)",
  "--border-strong": "var(--line-strong)",
  // A well that is RECESSED in both rooms. Neither generated neutral works
  // alone: --surface-2 sits above --surface in the dark halves and below it in
  // the light ones, so a fixed alias would invert the depth cue in one of them.
  // Halfway to the page ground is darker than the card in dark and lighter than
  // the card in light, which is what "sunken" means in each.
  "--subtle": "color-mix(in srgb, var(--surface) 50%, var(--bg))",
  "--accent-grad": "linear-gradient(135deg, var(--accent-hi) 0%, var(--accent-deep) 100%)",
  "--accent-soft": "var(--accent-a14)",
  "--accent-line": "var(--accent-a30)",
  "--accent-ink": "var(--on-accent)",
  "--good": "var(--green)",
  "--good-soft": "var(--green-a06)",
  "--bad": "var(--red)",
  "--bad-soft": "var(--red-a08)",
  "--warn": "var(--amber)",
  "--info": "var(--blue)",
  "--shadow-tab": "var(--shadow-card)",
  "--shadow-popover": "var(--shadow-float)",
  "--shadow-modal": "var(--shadow-deep)",
  // tokens.css and themes.css disagree about this one's TYPE — tokens emits a
  // box-shadow, the [data-palette] ladder emits a bare colour — so neither can
  // simply be inherited without breaking whichever consumer expects the other.
  // cssVars()'s contract is a shadow, and that is what call sites use, so the
  // shadow is rebuilt here over a ladder rung instead of a hardcoded rgba.
  "--focus-ring": "0 0 0 3px var(--accent-a30)",
};

/**
 * The inline variables for a wrapper that is ALSO carrying `data-palette` and
 * `data-theme` — i.e. the operator has chosen something.
 *
 * Built by subtraction from cssVars() rather than written out, so a name added
 * to the design package appears here automatically instead of silently
 * disappearing in the one code path nobody diffs.
 */
export function themeVars(paletteKey) {
  const vars = { ...cssVars(known(paletteKey) ? paletteKey : PALETTE_KEYS[0]) };
  for (const [name, value] of Object.entries(MODE_BOUND)) {
    if (value === null) delete vars[name];
    else vars[name] = value;
  }
  return vars;
}

// ─── the device's own answer ──────────────────────────────────────────────────

/**
 * Dark by default when the question cannot be asked (no matchMedia, a throw in a
 * locked-down webview). The Pentagon ships dark, so "we do not know" and "dark"
 * are the same picture and the fallback cannot surprise anyone.
 */
export function prefersDark() {
  try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { return true; }
}

/**
 * Subscribe to the device flipping.
 *
 * "System" that only reads prefers-color-scheme at boot is not System — it is
 * "whatever your laptop was doing when you last reloaded", and on iOS the
 * automatic sunset switch happens under a standalone window that is never
 * reloaded. Returns an unsubscribe. `addListener` is the Safari < 14 spelling
 * and iOS standalone is a protected target (DESIGN.md §7).
 */
export function watchSystemTheme(onChange) {
  let mq;
  try { mq = window.matchMedia("(prefers-color-scheme: dark)"); } catch { return () => {}; }
  if (!mq) return () => {};
  const handler = (e) => onChange(!!e.matches);
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }
  if (typeof mq.addListener === "function") {
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }
  return () => {};
}
