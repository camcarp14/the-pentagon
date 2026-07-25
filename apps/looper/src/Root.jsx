// Mount entry for the shell. Looper has no standalone build and no auth of its
// own — it rides the ONE Supabase login (App.jsx pulls the bearer per turn) and
// talks to /.netlify/functions/claude like the other tools do.
//
// Its stylesheet is injected scoped-to-mounted rather than imported statically:
// the shell renders one tool at a time, and Looper's sheet carries `:root`-level
// rules (safe-area padding, the bottom-bar geometry) that would otherwise bleed
// onto ZTS/Clarify/Runway/Macro once the chunk had loaded.
import { useEffect, useState } from "react";
import looperCss from "./styles.css?inline";
import App from "./App.jsx";

export default function LooperRoot() {
  // Gate the first paint on the sheet being in the document. Without this the
  // tool flashes unstyled for a frame on a cold chunk load, and Looper's first
  // paint is a full-height layout so the reflow is very visible.
  const [styled, setStyled] = useState(false);

  useEffect(() => {
    const el = document.createElement("style");
    el.id = "lp-scoped-styles";
    el.textContent = looperCss;
    document.head.appendChild(el);
    setStyled(true);
    return () => el.remove();
  }, []);

  if (!styled) return null;
  return <App />;
}
