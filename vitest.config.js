import { defineConfig } from "vitest/config";

// ─── Test config — the reason components were "untestable" here ───────────────
//
// This repo had no vitest config at all, so vitest fell back to esbuild's
// default JSX handling: the CLASSIC transform, which compiles <div/> to
// React.createElement and expects a `React` binding in scope. None of the source
// files have one, because the app build goes through @vitejs/plugin-react and
// the automatic runtime. So any test that imported a .jsx file and rendered it
// died with "React is not defined".
//
// The effect was that nobody tried. The working assumption became "there is no
// jsdom, so a React component cannot be tested in this repo" — and the whole
// mind-canvas suite was written against source TEXT and pure modules instead.
// Then the consolidation shipped `nodeR` used but never imported, and all three
// tools that draw a mind died on open. A build cannot catch a free variable and
// a grep cannot either; rendering it once can.
//
// Aligning the JSX runtime with the app build is the entire change. It does not
// add jsdom and does not need it: react-dom/server renders to a string in plain
// Node and executes the full component body, which is where that class of bug
// lives. See packages/mind-canvas/__tests__/render.test.js.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      // Vitest resolves @cc/* through the workspace symlinks in node_modules, so
      // no aliases are needed for them. Listed here only as a note for anyone
      // wondering why this file is shorter than apps/shell/vite.config.js.
    },
  },
});
