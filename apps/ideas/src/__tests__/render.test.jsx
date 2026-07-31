// Ideas is the first app surface on the shared kit, so it is also the first
// place a migration can be proved rather than asserted.
//
// The build does not prove it. `vite build` was green on a component that threw
// "nodeR is not defined" the moment it mounted, and took three tools down.
// react-dom/server executes the whole component body in plain Node — no jsdom
// needed — so a restyle that broke a reference, a prop, or a hook fails here.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Ideas from "../Root.jsx";

const warnings = [];
let realWarn, realErr;
beforeAll(() => {
  realWarn = console.warn; realErr = console.error;
  const cap = (...a) => {
    const m = String(a[0] ?? "");
    if (/useLayoutEffect does nothing on the server/.test(m)) return;
    warnings.push(m);
  };
  console.warn = cap; console.error = cap;
});
afterAll(() => { console.warn = realWarn; console.error = realErr; });

const html = () => renderToStaticMarkup(createElement(Ideas));

describe("Ideas renders on the kit", () => {
  it("renders at all", () => {
    expect(() => html()).not.toThrow();
  });

  it("opts into the kit on its own root", () => {
    // Ideas renders inside the shell's tool slot, so data-kit here reaches this
    // app and nothing else — the same rule the shell follows by keeping it off
    // the wrapper that holds every tool.
    expect(html()).toMatch(/<div[^>]*data-kit/);
  });

  it("uses the kit's primitives in the markup it renders cold", () => {
    // renderToStaticMarkup does not run effects, so nothing that waits on
    // fetched repos is in this output. What IS here is the page furniture, and
    // all of it should be the kit's.
    const out = html();
    for (const cls of ["seg", "seg-opt", "stattile", "stattile-label", "stattile-value"]) {
      expect(out, `expected the kit's .${cls}`).toContain(cls);
    }
  });

  it("takes the page title from the scale", () => {
    expect(html()).toContain("t-ltitle");
  });

  it("emits no NaN and no literal 'undefined' into markup", () => {
    const out = html();
    expect(out).not.toMatch(/NaN/);
    expect(out).not.toMatch(/(style|class)="[^"]*undefined/);
  });

  it("renders without a React warning", () => {
    html();
    const react = warnings.filter((w) => !w.startsWith("[@cc/"));
    expect(react, `React warned:\n${react.join("\n")}`).toEqual([]);
  });
});

describe("Ideas obeys the language", () => {
  const src = readSrc();
  function readSrc() {
    const { readFileSync } = require("node:fs");
    const { fileURLToPath } = require("node:url");
    const { dirname, join } = require("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "..", "Root.jsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  it("has no text under the 10.5px floor", () => {
    // The stat label was 10px uppercase tracked at 0.1em — under the floor, and
    // hand-doing what .t-label does at 12px.
    const sizes = [...src.matchAll(/fontSize:\s*([^,\n}]+)/g)]
      .flatMap((m) => [...m[1].matchAll(/[\d.]+/g)].map((n) => Number(n[0])))
      .filter((n) => Number.isFinite(n) && n > 0);
    expect(sizes.filter((n) => n < 10.5)).toEqual([]);
  });

  it("puts no border and shadow on the same element", () => {
    // The local Card had `border: 1px solid` AND was meant to read as elevated.
    // The kit's card separates by tone and shadow, with no outline.
    expect(src).not.toMatch(/border:\s*`1px solid \$\{T\.line\}`[\s\S]{0,80}boxShadow/);
    expect(src).not.toContain("const Card = ({ children, style }) => (\n  <div style={{ background: T.surface, border:");
  });

  it("routes the repo card through the kit too", () => {
    // The card only renders once repos have loaded, so it cannot be asserted
    // from cold markup — the source is the honest place to check it.
    expect(src).toMatch(/className=\{`card pad-\$\{pad\}`\}/);
  });

  it("keeps GitHub's language colours, which are data and not theme", () => {
    // The hexes in here are GitHub's own per-language colours. They are the
    // meaning of the swatch, not a palette choice, so they stay literal.
    expect(src).toMatch(/#f1e05a/i);   // JavaScript
  });
});
