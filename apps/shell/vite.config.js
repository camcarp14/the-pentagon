import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Alias the shared packages AND each tool to their SOURCE (not the symlinked
// node_modules copy) so esbuild transforms their JSX in one graph — this
// sidesteps the "JSX in node_modules won't transform" build failure. React is
// deduped so every tool shares one copy (hooks/context work across the shell).
const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@cc/design": r("../../packages/design/index.js"),
      "@cc/ui": r("../../packages/ui/index.jsx"),
      "@cc/supabase": r("../../packages/supabase/index.js"),
      "@app/zts": r("../zts/src/Root.jsx"),
      "@app/clarify": r("../clarify/src/Root.jsx"),
      "@app/runway": r("../runway/src/Root.jsx"),
      "@app/macro": r("../macro/src/Root.jsx"),
      "@app/looper": r("../looper/src/Root.jsx"),
    },
  },
  server: { fs: { allow: [r("../../")] } },
  build: { outDir: "dist", emptyOutDir: true },
});
