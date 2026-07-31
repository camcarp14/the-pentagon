// ─── ZTS palette — one source of truth, derived from @cc/design ──────────────
// ZTS now runs on the shared "midnight" canvas (the same dark base as Clarify
// and Runway); its only distinguishing mark is the emerald accent. These keys
// keep ZTS's historical names (card, sub, navy, amber, cardShadow…) so every
// inline style across the app resolves unchanged — it just renders dark now.
import { theme } from "@cc/design";

const t = theme("zts"); // midnight base + emerald ramp (+ green* legacy aliases)

export const T = {
  ...t,
  bg: "transparent", // the body background is painted in useGlobalStyles
  // legacy ZTS key names → canonical midnight tokens
  sub: t.muted,
  faint: t.faint,
  card: t.surface,
  line: t.line,
  cardShadow: t.shadowCard,
  navy: t.surface2, // a raised dark panel (was a deep navy on the old light theme)
  navyGrad: "linear-gradient(135deg, #1B2438 0%, #0F1626 100%)",
  amber: t.warn, // secondary warm accent (stage labels, insights)
  amberDeep: "#E0A94A",
  blue: t.info,
  red: t.bad,
  purple: "#A78BFA",
  // t already carries: ink, green, greenDeep, greenGrad, accent, accentInk, accentSoft…
};

// Display / mono fonts as standalone consts (App.jsx references them directly).
//
// SYSTEM STACK ONLY. These used to name 'Syne' and 'DM Mono' — two decorative
// Google faces that App.jsx pulled in with a <link> at runtime. The design
// language allows no decorative face, so both consts now resolve the shared
// tokens (@cc/design/tokens.css: --font-display is the system stack, --font-mono
// is ui-monospace). The NAMES stay, so all ~200 `fontFamily: syne` call sites
// across App/EnginePanel/factory resolve unchanged — they just render in SF /
// Segoe / Roboto now. The literal fallbacks matter for the standalone dev entry,
// which loads no stylesheet of its own before the first paint.
export const syne = 'var(--font-display, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)';
export const mono = 'var(--font-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace)';
