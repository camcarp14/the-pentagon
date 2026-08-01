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
      "@cc/design/index.css": r("../../packages/design/index.css"),
      "@cc/ui/components.css": r("../../packages/ui/components.css"),
      // Before the bare "@cc/design" rule, and load-bearing for the same reason
      // the mind-canvas pair below is: these are PREFIX rewrites, so
      // "@cc/design" alone would turn "@cc/design/palettes.js" into
      // ".../index.js/palettes.js" and the theme picker would fail to resolve at
      // build time. palettes.js is a real exports subpath of the package; it is
      // only the alias that needs telling.
      "@cc/design/palettes.js": r("../../packages/design/palettes.js"),
      "@cc/design": r("../../packages/design/index.js"),
      // More specific first: Vite matches aliases in order, and a bare
      // "@cc/mind" prefix rule would otherwise swallow "@cc/mind-canvas".
      "@cc/mind-canvas": r("../../packages/mind-canvas/index.js"),
      "@cc/mind": r("../../packages/mind/index.js"),
      "@cc/ui": r("../../packages/ui/index.jsx"),
      "@cc/supabase": r("../../packages/supabase/index.js"),
      "@app/zts": r("../zts/src/Root.jsx"),
      "@app/clarify": r("../clarify/src/Root.jsx"),
      "@app/runway": r("../runway/src/Root.jsx"),
      "@app/macro": r("../macro/src/Root.jsx"),
      "@app/looper": r("../looper/src/Root.jsx"),
      "@app/business": r("../business/src/Root.jsx"),
      "@app/sync": r("../sync/src/Root.jsx"),
    },
  },
  // .env lives at the REPO ROOT (that is where .env.example sits and what it
  // tells you to copy), but this config's root is apps/shell — npm workspaces
  // run the script with the workspace as cwd, and Vite's envDir defaults to
  // the project root. So the documented local-dev setup was silently loading
  // nothing: every VITE_ var came back undefined, Supabase logged its "not
  // configured" warning, and the only reason this was never noticed is that
  // deploys get their values from Netlify's real environment instead.
  // Caught by building with a filled-in root .env and grepping dist for the
  // values — zero occurrences.
  envDir: r("../../"),
  server: { fs: { allow: [r("../../")] } },
  build: { outDir: "dist", emptyOutDir: true },
});
