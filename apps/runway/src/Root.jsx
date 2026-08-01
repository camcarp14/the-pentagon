// Mount entry for the shell.
//   • MemoryRouter: Runway is the one tool built on react-router. A MemoryRouter
//     keeps its routing in memory so it never touches the browser URL the shell
//     lives at — no basename juggling, no stale paths when you switch tools.
//   • Scoped CSS: Runway styles with global class + element selectors (its own
//     dark theme). We inject them via ?inline only while Runway is mounted and
//     remove them on unmount — and since the shell mounts one tool at a time,
//     Runway's `body {}` / `input {}` rules can never bleed onto ZTS/Clarify.
//   • Auth: Runway's supabase-js client reads the same VITE_SUPABASE_URL as the
//     shell (the clarify project), so it shares the one session automatically.
import { useEffect } from "react";
import { MemoryRouter } from "react-router-dom";
import appCss from "./styles/app.css?inline";
import polishCss from "./styles/polish.css?inline";
import App from "./App.jsx";

// Standardize Runway's nav with the other tools: a TOP bar on desktop (matching
// ZTS/Clarify + the shell toggle), a BOTTOM bar on mobile. The desktop
// conversion is scoped to a media query so it never touches Runway's own mobile
// rules (an earlier unconditional `.rail{top:52px}` clobbered the mobile bottom
// nav).
//
// ONE breakpoint, 768px, in FOUR places that must move together:
//   • this EMBED_OVERRIDES query        (min-width: 768px)
//   • styles/app.css mobile block       (max-width: 767.98px)
//   • styles/polish.css mobile block    (max-width: 767.98px)
//   • ui/primitives.jsx useIsMobile()   (max-width: 767.98px)  <- the JS half
// 768px is also the shell's own flip (packages/ui useIsMobile), so tool chrome
// and shell chrome change on the same pixel. Two ways this has already broken:
// at 821px here there was a 768-820px band showing the DESKTOP shell toggle over
// Runway's MOBILE bottom bar; and leaving the JS hook at 820px put the MOBILE
// board (one stacked stage) under the DESKTOP top bar on iPad portrait.
// ── THE SUB-NAV, AND WHY EVERY COLOUR BELOW IS A VARIABLE ────────────────────
//
// This block used to draw the bar out of literals: a `rgba(255,255,255,0.055)`
// hairline, a `rgba(255,255,255,0.045)` group, `#525E74` labels, and an active
// pill of `--surface-2` under `#F7F9FC` text with a `rgba(0,0,0,0.5)` drop
// shadow. On midnight that is the right picture. In the light mode that shipped
// an hour ago it is a near-white label on a near-white pill (measured: #F7F9FC
// on #F4F5F7 — a contrast ratio of 1.02, i.e. invisible), an invisible hairline,
// and a midnight shadow under a white surface. Every one of those names now has
// a light half, so every one of them is read rather than written.
//
// The bar's shape is ZTS's and Clarify's, object for object rather than
// value for value: `.seg` for the group, `.seg-opt` for the tabs, and a
// measured `.seg-thumb` for the fill that slides between them (App.jsx does the
// measuring). The pill that was hand-drawn here is gone — including its
// border-AND-shadow pair, which the language forbids and which the group
// carried for as long as it was hand-drawn.
const EMBED_OVERRIDES = `
@media (min-width: 768px) {
  .shell { display: flex; flex-direction: column; min-height: calc(100vh - var(--shell-bar, 52px)); }
  /* one hairline OR one shadow, never both on the same element — the bar's
     separation is the border-bottom, and the drop shadow that used to sit on
     top of it has gone. --shell-bar, never a literal 52: the bar is not there
     at all on a desktop with the rail up, and the tools that hardcoded the
     number sat 52px down from content that started at 0. */
  [data-kit] .rail {
    position: sticky; top: var(--shell-bar, 52px); height: 52px; width: 100%;
    flex-direction: row; align-items: center; gap: 6px;
    border-right: none; border-bottom: 1px solid var(--line);
    background: var(--glass);
    backdrop-filter: blur(20px) saturate(140%); -webkit-backdrop-filter: blur(20px) saturate(140%);
    padding: 0 24px; z-index: 50;
  }
  [data-kit] .rail .brand { display: none; }   /* the shell's rail says which tool this is */
  /* The kit's segmented control, at the size ZTS and Clarify wear it. --seg-bg
     is the ground and it is authored per mode, so the group is a light well in
     a light room and a dark one in a dark room. No border: the thumb's shadow
     is the depth cue, and a border beside it is the pair the language forbids. */
  [data-kit] .rail .navgroup { flex-direction: row; gap: 2px; padding: 3px; background: var(--seg-bg); border: none; border-radius: 10px; }
  /* system stack, not Syne: the display face was the only decorative font left
     in Runway, and the shell's own chrome dropped it for the same reason.
     Colour and weight come from the kit's .seg-opt — what is set here is the
     geometry a nav needs and a 4-up segmented control does not: tabs sized to
     their labels rather than to equal thirds. */
  [data-kit] .rail .nav-item { flex: 0 0 auto; gap: 7px; padding: 5px 14px; min-height: 32px; border-radius: 8px; color: var(--sub); font-weight: 500; font-size: 13px; letter-spacing: 0; white-space: nowrap; transition: color var(--dur-2) var(--ease-out); }
  [data-kit] .rail .nav-item:hover { background: transparent; color: var(--ink); }
  /* The fill under the active tab is the thumb, not the tab. Runway's generic
     '.seg .seg-opt.active' fill (app.css) exists for the seg groups that have
     no measuring code behind them; this one has a thumb, and both would paint
     the same rectangle twice — the option's copy on top, square-cornered
     against the thumb's inset radius.
     Ink, not accent, on the lit tab — which is what ZTS and Clarify do, and
     what the kit's own .seg-opt.active says. Runway's rail-era rule painted it
     --accent, and violet on the thumb measured 2.79:1 in dark mode: the one
     word in the bar that says where you are was the least legible thing in it. */
  [data-kit] .rail .navgroup .seg-opt.active { background: transparent; box-shadow: none; color: var(--ink); font-weight: 600; }
  /* 11px, not 9px: nothing in this language is allowed under 10.5px. */
  [data-kit] .rail .nav-item .navcount { margin-left: 6px; min-width: auto; height: auto; padding: 1px 6px; border-radius: 999px; font-size: 11px; font-weight: 800; }
  /* The bar's right-hand end. It held the account email until the shell grew a
     rail with the account in its footer; what is left is the ⌘K button. */
  [data-kit] .rail-foot { margin-top: 0; margin-left: auto; flex-direction: row; align-items: center; gap: 8px; padding: 0; font-size: 12.5px; }
  [data-kit] .rail-foot .btn.cmdk-btn { font-family: var(--font-mono); }
  /* Let the inner .pagefade own the width (reading pages cap at 1220, the
     kanban breaks out to 1580) instead of clamping the board to a narrow column. */
  .main { max-width: 1580px; margin: 0 auto; width: 100%; }
}
`;

export default function RunwayRoot() {
  useEffect(() => {
    const el = document.createElement("style");
    el.id = "rw-scoped-styles";
    el.textContent = `${polishCss}\n${appCss}\n${EMBED_OVERRIDES}`;
    document.head.appendChild(el);
    return () => el.remove();
  }, []);
  return (
    // data-kit: Runway opts into the shared kit HERE, on its own outermost
    // element, and nowhere higher. It renders inside the shell's tool slot, so
    // this reaches this app and nothing else — the same rule the shell follows
    // by keeping data-kit off the wrapper that holds every tool.
    <div data-kit>
      <MemoryRouter>
        <App />
      </MemoryRouter>
    </div>
  );
}
