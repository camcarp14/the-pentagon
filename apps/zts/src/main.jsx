// Standalone dev entry (`npm --workspace @app/zts run dev`). The deployed build
// mounts Root.jsx inside apps/shell, which already imports the design layer and
// stamps the palette on the wrapper it renders every tool into.
//
// This entry has to do both of those jobs itself, or the kit classes App.jsx now
// renders — .card, .btn, .field, .seg, .t-* — would resolve to nothing here and
// the standalone app would come up unstyled. The shell's import order is copied
// exactly: tokens first, then the kit, so [data-kit] rules land after the
// variables they read.
import "@cc/design/index.css";
import "@cc/ui/components.css";

import React from "react";
import { createRoot } from "react-dom/client";
import { cssVars } from "@cc/design";
import App from "./App.jsx";
import { ToastProvider } from "./ui.jsx";

createRoot(document.getElementById("root")).render(
  // data-palette / data-theme select ZTS's row out of the generated themes, and
  // cssVars("zts") writes the same tokens inline — the identical pair the shell
  // puts on its mount wrapper. data-kit is NOT here: it belongs on the app's own
  // root inside App.jsx, which is the element the shell path opts in on too.
  <div data-palette="zts" data-theme="dark" style={{ ...cssVars("zts"), minHeight: "100vh", background: "var(--bg)", color: "var(--ink)" }}>
    <ToastProvider>
      <App />
    </ToastProvider>
  </div>
);
