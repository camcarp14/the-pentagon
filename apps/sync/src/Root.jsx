// Mount entry for the shell.
//
// SYNC arrived here as a standalone PWA that owned the whole page: its own
// createRoot, its own login, its own boot animation, and a position:fixed frame
// sized from visualViewport because an installed iOS window lies about its
// height. All of that is gone — the shell owns the window, the session and the
// chrome. What is left is a tool.
//
// Two jobs only, both of which are the house contract for a tab:
//   1. inject the scoped stylesheet and hold the first paint until it lands
//   2. wrap the tool in its own toast host
//
// The stylesheet is injected rather than statically imported because the shell
// renders one tool at a time and a sheet that outlives its tool bleeds onto the
// other six. Every selector inside is prefixed `.sy-root`, which also settles
// the seven class names SYNC shares with @cc/ui's globally-installed polish
// sheet — see the header of styles.css.

import { useEffect, useState } from "react";
import syncCss from "./styles.css?inline";
import { ToastHost } from "./ui/kit.jsx";
import { startCloud } from "./data/cloud.js";
import App from "./App.jsx";

export default function SyncRoot() {
  const [styled, setStyled] = useState(false);

  // Was main.jsx's job in the standalone app. It is idempotent, so mounting
  // and unmounting the tab repeatedly does not stack listeners.
  useEffect(() => { startCloud(); }, []);

  // SYNC is a fixed frame — the orb sits still, the transcript scrolls inside
  // itself, and the tab bar is pinned. The document underneath must not move.
  //
  // It does by default, and not because of anything in this tool: the shell's
  // wrapper is minHeight:100vh, and on an installed iOS app 100vh reports the
  // screen (852pt) while the window under a `black` status bar is 793 — so the
  // document is ~59pt taller than the glass and the whole app rubber-bands.
  //
  // Done in JS rather than CSS on purpose. This is the one rule that has to
  // reach outside .sy-root, and a stylesheet rule for html/body would keep
  // applying to whichever tool mounted next until SYNC's sheet was removed.
  // Saving and restoring the exact previous values means the lock lasts exactly
  // as long as this tab is on screen.
  useEffect(() => {
    const root = document.documentElement;
    const { body } = document;
    const prev = {
      rootOverflow: root.style.overflow,
      bodyOverflow: body.style.overflow,
      overscroll: body.style.overscrollBehavior,
    };
    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    return () => {
      root.style.overflow = prev.rootOverflow;
      body.style.overflow = prev.bodyOverflow;
      body.style.overscrollBehavior = prev.overscroll;
    };
  }, []);

  useEffect(() => {
    const el = document.createElement("style");
    el.id = "sy-scoped-styles";
    el.textContent = syncCss;
    document.head.appendChild(el);
    setStyled(true);
    return () => el.remove();
  }, []);

  // A cold chunk load would otherwise flash the whole console unstyled for a
  // frame, and SYNC's first paint is a full-height layout, so the reflow is
  // very visible.
  if (!styled) return null;

  // .sy-scope captures the Pentagon's custom properties under private names so
  // .sy-root can republish them as SYNC's own without a self-referential cycle.
  // It has to be a separate element for that to work — see styles.css.
  //
  // data-kit goes on .sy-root, which is THIS APP'S own root element and the
  // only thing the shell hands SYNC. Every rule in packages/ui/components.css
  // is scoped [data-kit], so from here the shared card, cell, stat tile,
  // button, pill, segmented control, field, switch, sheet, toast, skeleton and
  // type scale reach this tool and nothing else on the page — the same rule
  // the shell follows by keeping data-kit off the wrapper that holds every
  // tool. SYNC already spoke the kit's vocabulary (it was ported from the same
  // SESSION language); what changes is that the definitions now come from one
  // place instead of a private 1,100-line copy.
  return (
    <div className="sy-scope">
      <div className="sy-root" data-kit>
        <ToastHost>
          <App />
        </ToastHost>
      </div>
    </div>
  );
}
