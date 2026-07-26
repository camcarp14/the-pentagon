// ═══════════════════════════════════════════════════════════════════════════
// @cc/design — the ONE token source for The Pentagon.
//
// Six tools live under one shell. They all share ONE dark canvas ("brass on
// midnight", inherited from Clarify) so they read as a single product; the only
// axis that differs per tool is the ACCENT:
//
//   • ZTS       → emerald   #3ECF8E
//   • Clarify   → brass     #C9A557
//   • Runway    → violet    #8B7CFF
//   • Macro     → amber     #FFB224
//   • Looper    → cyan      #38D9F0
//   • Business  → magenta   #F45CA7
//
// Everything is emitted TWO ways so every tool can consume one source:
//   • theme(app)   → a JS token object (for the inline-style apps: ZTS/Clarify)
//   • cssVars(app) → CSS custom properties (for Runway's class-based CSS AND
//                    for the shared @cc/ui primitives, which read var(--accent))
//
// Legacy call sites (`T.gold`, `T.green`) keep working: theme(app) folds the
// app's historical color aliases onto the canonical `accent*` keys, so moving
// an app onto this package is a near-zero-diff import swap, not a reskin.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Base: structural tokens shared by every tool, mode-independent ──────────
export const fonts = {
  fontDisplay: "'Syne', system-ui",
  fontBody: "'Inter', system-ui, sans-serif",
  fontMono: "'DM Mono', monospace",
};

export const radii = { rSm: "8px", rMd: "10px", rLg: "14px", rPill: "999px" };

// Motion vocabulary — identical curves across every tool so they feel like one
// product. Exposed both as JS (M) and CSS vars (--ease-*, --dur-*).
export const M = {
  easeOut: "cubic-bezier(0.16, 1, 0.3, 1)",
  easeSpring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  easeStd: "cubic-bezier(0.4, 0, 0.2, 1)",
  durFast: "0.12s",
  durBase: "0.2s",
  durSlow: "0.32s",
};

// ─── Per-tool palettes ───────────────────────────────────────────────────────
// Each entry is a full palette: base mode + neutrals + an accent ramp + the
// semantic signals + that tool's legacy alias keys. Values were transcribed from
// the live apps as each moved in, so migration is faithful, not approximate.
// Emerald — ZTS. Tuned bright so it reads on the dark canvas; the deep stop is
// the old ZTS green, kept for gradients/hover.
const EMERALD = {
  accent: "#3ECF8E", accentHi: "#5EE0A8", accentDeep: "#0E9F6E",
  accentGrad: "linear-gradient(135deg, #5EE0A8 0%, #0E9F6E 100%)",
  accentSoft: "rgba(62,207,142,0.12)", accentLine: "rgba(62,207,142,0.30)",
  accentInk: "#052B1C", focusRing: "0 0 0 3px rgba(62,207,142,0.34)",
};
// Brass — Clarify. The signature "brass on midnight" accent (unchanged).
const BRASS = {
  accent: "#C9A557", accentHi: "#E3C27E", accentDeep: "#8F7434",
  accentGrad: "linear-gradient(135deg, #E3C27E 0%, #A9853C 100%)",
  accentSoft: "rgba(201,165,87,0.12)", accentLine: "rgba(201,165,87,0.30)",
  accentInk: "#151005", focusRing: "0 0 0 3px rgba(201,165,87,0.34)",
};
// Violet — Runway. A cool jewel tone, deliberately far from emerald and brass
// so no two tools read as the same accent.
const VIOLET = {
  accent: "#8B7CFF", accentHi: "#A99BFF", accentDeep: "#6C5CE7",
  accentGrad: "linear-gradient(135deg, #A99BFF 0%, #6C5CE7 100%)",
  accentSoft: "rgba(139,124,255,0.14)", accentLine: "rgba(139,124,255,0.32)",
  accentInk: "#120A2E", focusRing: "0 0 0 3px rgba(139,124,255,0.34)",
};
// Amber — Macro (the trading cockpit). Reads as "markets", and no longer
// clashes now that Runway moved to violet.
const AMBER = {
  accent: "#FFB224", accentHi: "#FFC155", accentDeep: "#E09000",
  accentGrad: "linear-gradient(135deg, #FFC155 0%, #E09000 100%)",
  accentSoft: "rgba(255,178,36,0.14)", accentLine: "rgba(255,178,36,0.32)",
  accentInk: "#1A1204", focusRing: "0 0 0 3px rgba(255,178,36,0.34)",
};

// Cyan — the only hue left that is unmistakable against emerald/brass/violet/amber
// at an 8px dot and a 10px label. Deliberately cool and "machine-like": Looper is
// the tool that runs on its own, so it should not read as one of the four
// hand-driven surfaces.
const CYAN = {
  accent: "#38D9F0", accentHi: "#6FE6F7", accentDeep: "#0FA9C4",
  accentGrad: "linear-gradient(135deg, #6FE6F7 0%, #0FA9C4 100%)",
  accentSoft: "rgba(56,217,240,0.14)", accentLine: "rgba(56,217,240,0.32)",
  accentInk: "#04222A", focusRing: "0 0 0 3px rgba(56,217,240,0.34)",
};

// Magenta — Business (the autonomous agent's command panel). Chosen by
// elimination, and the elimination is the point: that surface renders alarm
// states constantly, so its accent must not be confusable with `bad` (#F87171,
// a salmon red) or `warn` (#F5B84D) at a glance, or a healthy panel reads as a
// failing one. Green/gold/violet/amber/cyan are spoken for; ~325° is the only
// wide gap left on the wheel that clears all five accents AND all four signals.
const MAGENTA = {
  accent: "#F45CA7", accentHi: "#FF85C2", accentDeep: "#C42B7C",
  accentGrad: "linear-gradient(135deg, #FF85C2 0%, #C42B7C 100%)",
  accentSoft: "rgba(244,92,167,0.14)", accentLine: "rgba(244,92,167,0.32)",
  accentInk: "#2A0518", focusRing: "0 0 0 3px rgba(244,92,167,0.34)",
};

// Historical alias keys per app, so existing call sites keep resolving after
// the import swaps to @cc/design. Mapped onto the app's accent ramp.
const aliasFor = (a, ramp) => {
  if (a === "zts") return { green: ramp.accent, greenHi: ramp.accentHi, greenDeep: ramp.accentDeep, greenGrad: ramp.accentGrad };
  if (a === "clarify") return { gold: ramp.accent, goldHi: ramp.accentHi, goldDeep: ramp.accentDeep, goldGrad: ramp.accentGrad, goldSoft: ramp.accentSoft, goldLine: ramp.accentLine };
  return {};
};

// MIDNIGHT — the one shared canvas for every tool (Clarify's original
// "brass on midnight" navy). Only the accent ramp differs per tool now.
const MIDNIGHT = {
  mode: "dark",
  bg: "#0B0F1A", surface: "#141B2C", surface2: "#1B2438", subtle: "#0F1626", raised: "#1B2438",
  ink: "#E9EDF5", inkDeep: "#F7F9FC", muted: "#94A1B5", faint: "#66738A",
  ghost: "#525E74", placeholder: "#5A6780",
  line: "rgba(255,255,255,0.085)", lineSoft: "rgba(255,255,255,0.055)", lineStrong: "rgba(255,255,255,0.16)", lineInk: "rgba(255,255,255,0.07)",
  good: "#3ECF8E", goodHi: "#5EE0A8", info: "#6EA8FE", warn: "#F5B84D", warnHi: "#FFC96B", bad: "#F87171", pink: "#F472B6",
  shadowCard: "0 1px 2px rgba(0,0,0,0.5), 0 8px 30px rgba(0,0,0,0.4)",
  shadowTab: "0 1px 2px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.45)",
  shadowPopover: "0 10px 30px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.45)",
  shadowModal: "0 24px 70px rgba(0,0,0,0.65), 0 8px 24px rgba(0,0,0,0.5)",
};

const APP_DEF = {
  zts: { base: MIDNIGHT, ramp: EMERALD, label: "ZTS", brand: "Zero To Secure" },
  clarify: { base: MIDNIGHT, ramp: BRASS, label: "Clarify", brand: "Clarify Outreach" },
  runway: { base: MIDNIGHT, ramp: VIOLET, label: "Runway", brand: "Runway" },
  macro: { base: MIDNIGHT, ramp: AMBER, label: "Macro", brand: "Macro Command Center" },
  looper: { base: MIDNIGHT, ramp: CYAN, label: "Looper", brand: "Looper" },
  // `short` is the compact-mode label. Six segments do not fit six full words
  // on a 375px phone — "Business" measures ~48px in the toggle's 9.5px Syne
  // against ~45px of available segment, so it would ellipsise to "Busines…".
  // A deliberate three-letter form beats a truncated eight-letter one.
  business: { base: MIDNIGHT, ramp: MAGENTA, label: "Business", short: "Biz", brand: "AI Business" },
};

export const APPS = ["zts", "clarify", "runway", "macro", "looper", "business"];
export const appMeta = (app) => {
  const d = APP_DEF[app] || APP_DEF.zts;
  return { app, label: d.label, short: d.short || d.label, brand: d.brand, mode: d.base.mode, accent: d.ramp.accent };
};

// ─── theme(app) — the JS token object for inline-style apps ──────────────────
// Shape matches the apps' existing `T` object, so `import { T } from "./theme"`
// becomes `const T = theme("zts")` with the same keys available downstream.
export function theme(app = "zts") {
  const d = APP_DEF[app] || APP_DEF.zts;
  return { ...fonts, ...radii, ...d.base, ...d.ramp, ...aliasFor(app, d.ramp), app, M };
}

// ─── cssVars(app) — CSS custom properties for class-based CSS + @cc/ui ───────
// Names cover the canonical `--accent*` set AND the exact var names Runway's
// app.css already reads, so Runway themes off this source unmodified. Apply the
// returned object as an inline `style` on each tool's mount container (the shell
// does this on app switch), or serialize with cssVarsText() for a stylesheet.
export function cssVars(app = "zts") {
  const t = theme(app);
  return {
    "--bg": t.bg,
    "--surface": t.surface,
    "--surface-2": t.surface2,
    "--subtle": t.subtle,
    "--text": t.ink,
    "--ink": t.ink,
    "--dim": t.muted,
    "--muted": t.muted,
    "--faint": t.faint,
    "--border": t.line,
    "--border-strong": t.lineStrong || t.line,
    "--accent": t.accent,
    "--accent-hi": t.accentHi,
    "--accent-deep": t.accentDeep,
    "--accent-grad": t.accentGrad,
    "--accent-soft": t.accentSoft,
    "--accent-line": t.accentLine,
    "--accent-ink": t.accentInk,
    "--good": t.good,
    "--good-soft": t.mode === "dark" ? "rgba(79,214,148,0.13)" : "rgba(5,150,105,0.10)",
    "--bad": t.bad,
    "--bad-soft": t.mode === "dark" ? "rgba(255,111,111,0.12)" : "rgba(220,38,38,0.08)",
    "--warn": t.warn,
    "--info": t.info,
    "--shadow-card": t.shadowCard,
    "--shadow-tab": t.shadowTab,
    "--shadow-popover": t.shadowPopover,
    "--shadow-modal": t.shadowModal,
    "--radius": radii.rMd,
    "--radius-lg": radii.rLg,
    "--font-display": fonts.fontDisplay,
    "--font-body": fonts.fontBody,
    "--font-mono": fonts.fontMono,
    "--dur-1": M.durFast,
    "--dur-2": M.durBase,
    "--dur-3": M.durSlow,
    "--ease-out": M.easeOut,
    "--ease-spring": M.easeSpring,
    "--focus-ring": t.focusRing,
  };
}
