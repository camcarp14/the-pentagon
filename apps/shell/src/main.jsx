import { createRoot } from "react-dom/client";
import { ToastProvider } from "@cc/ui";
// The platform's feel, mounted once for every tool. polish.css was Runway's
// alone (see its header); ambient.css draws the wash behind the whole shell.
// Imported here rather than in App.jsx so they land in the entry chunk and the
// first paint already has them — a tool's lazy chunk must never be what brings
// the motion vocabulary in.
import "@cc/design/polish.css";
import "@cc/design/ambient.css";
import Shell from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <ToastProvider>
    <Shell />
  </ToastProvider>
);
