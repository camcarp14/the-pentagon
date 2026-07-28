// ═══════════════════════════════════════════════════════════════════════════
// @cc/ui/polish — the motion + ergonomics system, injected once for every tool.
//
// WHY THIS IS ONE STYLESHEET AND NOT SIX. Polish is cross-cutting and invisible
// per-feature, which is exactly why building it feature-by-feature never
// converges: each surface adds a fade on mount and hard-cuts everywhere else.
// The system is installed once here and every tool inherits it — press physics,
// skeleton shimmer, page transitions, scrollbars, touch targets — without a
// single per-app import.
//
// EVERY COLOUR IS A DESIGN TOKEN. @cc/design stamps --accent, --ink, --border
// and friends on the shell wrapper per active tool, so one rule renders in
// emerald inside ZTS and magenta inside Business with no forks. Hardcoding a
// hex here would be six wrong colours in five tools.
//
// TABULAR NUMERALS ARE ON BY DEFAULT. This is a data console: every screen is
// counts, money and countdowns, and proportional digits make a number that
// updates in place jiggle its own neighbours. Opt a surface out with .prop-nums
// if it is genuinely prose.
//
// THE REDUCED-MOTION BLOCK AT THE BOTTOM IS NOT OPTIONAL. Everything above is
// optional to the user's nervous system; any animation added later belongs
// inside that gate too.
// ═══════════════════════════════════════════════════════════════════════════

export const POLISH_CSS = `
:root {
  --dur-1: 140ms; --dur-2: 240ms; --dur-3: 420ms;
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-spring: cubic-bezier(0.34, 1.4, 0.44, 1);
}

/* ── numbers behave like instruments, headings balance ────────────────────── */
body { font-variant-numeric: tabular-nums; }
.prop-nums, .prop-nums * { font-variant-numeric: normal; }
h1, h2, h3 { text-wrap: balance; }

/* ── details that read as designed ───────────────────────────────────────── */
::selection { background: color-mix(in srgb, var(--accent, #8B7CFF) 28%, transparent); }
* { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--ink, #E9EDF5) 18%, transparent) transparent; }
*::-webkit-scrollbar { width: 9px; height: 9px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--ink, #E9EDF5) 14%, transparent);
  border-radius: 99px;
}
*::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--ink, #E9EDF5) 26%, transparent); }

/* Keyboard users get a real focus ring; mouse users never see it. Tools here
   are inline-styled, so without this a tabbing user has NO idea where they are. */
:focus-visible {
  outline: 2px solid var(--accent, #8B7CFF);
  outline-offset: 2px;
  border-radius: 6px;
}

/* ── press physics: every interactive element acknowledges touch under 100ms ─
   Scoped to real controls and applied by ELEMENT, because these apps are
   inline-styled — a class-only rule would reach almost nothing. Transform only,
   so it can never fight an app's own colour or border styling. */
button, [role="button"], summary, .btn, .seg button, .tabs button, .lp-seg button {
  transition: transform var(--dur-1) var(--ease-out), background-color var(--dur-1) ease,
              border-color var(--dur-1) ease, color var(--dur-1) ease, box-shadow var(--dur-2) var(--ease-out);
}
button:not(:disabled):active, [role="button"]:active, .btn:not(:disabled):active,
.seg button:active, .tabs button:active, .lp-seg button:active { transform: scale(0.97); }
button:disabled { cursor: default; }

/* Cards lift on hover only where the surface is a real target. Never on touch —
   a hover state on a phone is a state that sticks after the tap. */
@media (hover: hover) {
  a.card:hover, .card.tappable:hover, .task:hover { transform: translateY(-1px); }
}

/* ── page + tab transitions: nothing hard-cuts ───────────────────────────── */
.pagefade { animation: ccPageIn var(--dur-3) var(--ease-out) both; }
@keyframes ccPageIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* ── entrance choreography: sections develop top-to-bottom ───────────────── */
.stagger > * { animation: ccRise var(--dur-3) var(--ease-out) both; animation-delay: calc(var(--i, 0) * 45ms); }
@keyframes ccRise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.stagger > *:nth-child(1){--i:0} .stagger > *:nth-child(2){--i:1} .stagger > *:nth-child(3){--i:2}
.stagger > *:nth-child(4){--i:3} .stagger > *:nth-child(5){--i:4} .stagger > *:nth-child(6){--i:5}
.stagger > *:nth-child(7){--i:6} .stagger > *:nth-child(8){--i:7}
/* Past eight the delay would read as lag rather than choreography, so it caps. */
.stagger > *:nth-child(n+9){--i:8}

/* ── skeletons: pages develop instead of arriving ───────────────────────── */
.sk {
  position: relative; overflow: hidden; border-radius: 8px;
  background: color-mix(in srgb, var(--ink, #E9EDF5) 6%, transparent);
}
.sk::after {
  content: ''; position: absolute; inset: 0; transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--ink, #E9EDF5) 6%, transparent), transparent);
  animation: ccShimmer 1.4s infinite;
}
@keyframes ccShimmer { 100% { transform: translateX(100%); } }
.sk-line { height: 13px; margin: 8px 0; }
.sk-line.w40 { width: 40%; } .sk-line.w60 { width: 60%; } .sk-line.w80 { width: 80%; }
.sk-big { height: 30px; width: 55%; margin: 10px 0 6px; }
.sk-ring { border-radius: 50%; }

/* ── height:auto expansion with ZERO measuring: grid-rows 0fr -> 1fr ─────── */
.expand { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--dur-3) var(--ease-out); }
.expand.open { grid-template-rows: 1fr; }
.expand > div { overflow: hidden; min-height: 0; }

/* ── mobile ergonomics ──────────────────────────────────────────────────── */
@media (max-width: 820px) {
  /* iOS zooms a focused input under 16px and never zooms back out. This is the
     single most common "this is a website, not an app" tell on a phone. */
  input, select, textarea { font-size: max(16px, 1em); }
  button, [role="button"], .btn, .tabs button, .seg button { min-height: 42px; }
  /* Wide content scrolls inside its own box rather than scrolling the page
     sideways — a horizontally-scrolling body is never intentional. Scoped to
     the table itself; 'overflow-x: hidden' on html/body would fix the same
     symptom and break every 'position: sticky' descendant, including the
     shell's own top bar. */
  table { display: block; overflow-x: auto; max-width: 100%; }
}

/* Bottom bars clear the home indicator. --safe-bottom is published by the shell
   (it distinguishes a real inset from a letterboxed standalone window); the
   env() fallback covers a tool running standalone. */
.safe-bottom { padding-bottom: var(--safe-bottom, env(safe-area-inset-bottom, 0px)); }

/* ── the mandate ────────────────────────────────────────────────────────── */
@media (prefers-reduced-motion: reduce) {
  .pagefade, .stagger > *, .sk::after { animation: none !important; }
  .expand { transition: none; }
  button, [role="button"], summary, .btn, .seg button, .tabs button, .lp-seg button,
  a.card, .card, .task { transition: none; }
  button:not(:disabled):active, [role="button"]:active, .btn:not(:disabled):active { transform: none; }
  @media (hover: hover) { a.card:hover, .card.tappable:hover, .task:hover { transform: none; } }
}
`;

/**
 * Inject once per document. Idempotent by element id, so importing @cc/ui from
 * six lazily-loaded tools installs one stylesheet, not six.
 */
export function installPolish() {
  if (typeof document === "undefined") return;
  if (document.getElementById("cc-polish")) return;
  const el = document.createElement("style");
  el.id = "cc-polish";
  el.textContent = POLISH_CSS;
  // Prepended so an app's own stylesheet always wins a specificity tie — this
  // is a floor to build on, never a ceiling that overrides a tool's intent.
  document.head.prepend(el);
}
