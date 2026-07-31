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
const EMBED_OVERRIDES = `
@media (min-width: 768px) {
  .shell { display: flex; flex-direction: column; min-height: calc(100vh - 52px); }
  /* one hairline OR one shadow, never both on the same element — the bar's
     separation is the border-bottom, and the drop shadow that used to sit on
     top of it has gone. */
  .rail {
    position: sticky; top: 52px; height: 52px; width: 100%;
    flex-direction: row; align-items: center; gap: 6px;
    border-right: none; border-bottom: 1px solid rgba(255,255,255,0.055);
    background: rgba(11,15,26,0.78);
    backdrop-filter: blur(20px) saturate(140%); -webkit-backdrop-filter: blur(20px) saturate(140%);
    padding: 0 24px; z-index: 50;
  }
  .rail .brand { display: none; }
  /* The ZTS/Clarify pill group, value-for-value: a 4.5%-white container on a
     lineSoft hairline, the active pill raised on --surface-2 with the tight
     two-stop shadow + inset highlight. Runway previously used --surface (a
     DARKER fill than the container), so its active tab read recessed while the
     other tools' read raised — the main reason its menu felt like a different
     product. Bar chrome (height/padding/background/z-index) now matches
     the ZTS and Clarify bars exactly too. */
  .navgroup { flex-direction: row; gap: 2px; padding: 3px; background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.055); border-radius: 10px; }
  /* system stack, not Syne: the display face was the only decorative font left
     in Runway, and the shell's own chrome dropped it for the same reason. */
  .rail .nav-item { flex: 0 0 auto; gap: 7px; padding: 5px 14px; min-height: 32px; border-radius: 7px; color: #525E74; font-weight: 600; font-size: 12.5px; letter-spacing: 0; transition: color 0.2s cubic-bezier(0.4,0,0.2,1); }
  .rail .nav-item:hover { background: transparent; color: #E9EDF5; }
  .rail .nav-item.active { background: var(--surface-2, #1B2438); color: #F7F9FC; box-shadow: 0 1px 2px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06); }
  /* 11px, not 9px: nothing in this language is allowed under 10.5px. */
  .rail .nav-item .navcount { margin-left: 6px; min-width: auto; height: auto; padding: 1px 6px; border-radius: 999px; font-size: 11px; font-weight: 800; }
  .rail-foot { margin-top: 0; margin-left: auto; flex-direction: row; align-items: center; gap: 14px; padding: 0; font-size: 12px; }
  [data-kit] .rail-foot .btn { display: none; }   /* the shell owns sign-out */
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
