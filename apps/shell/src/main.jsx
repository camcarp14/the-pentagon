// The shared design layer. Imported once, at the shell, because every tool
// renders inside it — an app-level import would load nine copies and let the
// last one mounted decide the cascade order.
//
// Nothing changes visually the day this lands: App.jsx still stamps cssVars()
// inline on the wrapper, and an inline custom property beats a stylesheet one.
// That is deliberate. It means the token layer and the kit classes are
// AVAILABLE to every app immediately, and each surface can move onto them one
// at a time instead of nine apps having to change on the same commit.
import "@cc/design/index.css";
import "@cc/ui/components.css";

import { createRoot } from "react-dom/client";
import { ToastProvider } from "@cc/ui";
import Shell from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <ToastProvider>
    <Shell />
  </ToastProvider>
);
