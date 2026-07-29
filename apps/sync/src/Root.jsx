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
  return (
    <div className="sy-scope">
      <div className="sy-root">
        <ToastHost>
          <App />
        </ToastHost>
      </div>
    </div>
  );
}
