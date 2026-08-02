// Actually render the thing.
//
// WHY THIS EXISTS. The consolidation shipped with `nodeR` used in the render
// body and missing from the import list. Every tool that draws a mind — ZTS,
// Clarify and SYNC — died on open with "Can't find variable: nodeR". Three tools
// at once, in production.
//
// Nothing caught it, and each miss was reasonable on its own terms:
//   · The build does not care. A free variable is legal JavaScript; esbuild
//     resolves it at runtime, so `vite build` was green.
//   · There is no lint step, so no-undef never ran.
//   · Every test written for this package asserted on SOURCE TEXT or on the pure
//     modules. Not one of them executed the component, because the repo has no
//     jsdom and the assumption was that a React component therefore cannot be
//     tested here.
//
// That assumption was wrong, and this file is the correction. react-dom/server
// runs in plain Node with no DOM at all, and renderToStaticMarkup executes the
// whole component body — every hook call, every prop read, every helper
// reference. It does not run effects, so the rAF loop, the ResizeObserver and
// the stylesheet injection stay untouched; it exercises precisely the part that
// broke. A test that renders once is worth more here than any amount of grepping
// the source, which is what the rest of this package's suite had been doing.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MindCanvas } from "../MindCanvas.jsx";
import { PALETTE_DEFAULTS, REGION_KEYS } from "../palette.js";

const PALETTE = {
  ...PALETTE_DEFAULTS,
  region: Object.fromEntries(REGION_KEYS.map((k, i) => [k, `#${(0x112233 + i * 0x101010).toString(16).padStart(6, "0")}`])),
};

const GENOME = {
  nodes: [
    { id: "a", label: "Tell the truth", region: "principle", weight: 0.9, x: 0, y: 0, locked: true },
    { id: "b", label: "Ship it", region: "skill", weight: 0.4, x: 120, y: 40 },
    { id: "c", label: "Silenced one", region: "goal", weight: 0.6, x: -90, y: 70, enabled: false },
  ],
  edges: [
    { id: "e1", from: "a", to: "b", weight: 0.7, polarity: 1 },
    { id: "e2", from: "b", to: "c", weight: 0.3, polarity: -1 },
  ],
};

const render = (props) => renderToStaticMarkup(createElement(MindCanvas, { genome: GENOME, palette: PALETTE, ...props }));

// React reports invalid markup through console.error, so warnings are captured
// rather than silenced — a warning here is a defect that renders. Only the known,
// unavoidable useLayoutEffect-on-the-server notice is filtered out.
const warnings = [];
let realWarn, realErr;
beforeAll(() => {
  realWarn = console.warn; realErr = console.error;
  const capture = (...a) => {
    const msg = String(a[0] ?? "");
    if (/useLayoutEffect does nothing on the server/.test(msg)) return;
    warnings.push(msg);
  };
  console.warn = capture; console.error = capture;
});
afterAll(() => { console.warn = realWarn; console.error = realErr; });

describe("the canvas renders", () => {
  it("renders at all — the assertion that was missing", () => {
    // `nodeR` was used and never imported. This line is the whole point of the file.
    expect(() => render()).not.toThrow();
  });

  it("draws a node and an edge for what it was given", () => {
    const html = render();
    expect(html).toContain('data-dna-node');
    expect(html).toContain('data-dna-edge');
    expect(html).toContain("Tell the truth");
    expect((html.match(/data-dna-node/g) || []).length).toBe(GENOME.nodes.length);
  });

  it("exposes host layout hooks without changing the canvas structure", () => {
    const html = render({ className: "sync-mind-canvas", hudClassName: "sync-mind-canvas-controls" });
    expect(html).toContain('class="sync-mind-canvas"');
    expect(html).toContain('class="sync-mind-canvas-controls"');
  });

  it("never emits NaN into an attribute", () => {
    // A NaN coordinate is discarded silently by SVG: the graph vanishes with
    // nothing in the console. Cheap to assert, invisible otherwise.
    expect(render()).not.toMatch(/NaN/);
  });

  it("never emits the string 'undefined' into an attribute or style", () => {
    // How the missing shadow token failed: `${undefined}, var(--accent-a20)` is
    // an invalid list, so the browser dropped the declaration whole.
    const html = render();
    expect(html).not.toMatch(/(style|fill|stroke|d|transform)="[^"]*undefined/);
  });

  it("survives every genome shape a host can hand it", () => {
    for (const genome of [
      undefined, null, {}, { nodes: [] }, { nodes: [], edges: [] },
      { nodes: null, edges: null },
      { nodes: [{ id: "x" }], edges: [] },                                  // no region, no weight, no label
      { nodes: [{ id: "x", region: "not-a-region", weight: 2, x: NaN, y: NaN }], edges: [] },
      { nodes: [{ id: "x", region: "skill", weight: 0.5 }], edges: [{ id: "e", from: "x", to: "ghost" }] },
    ]) {
      expect(() => render({ genome }), JSON.stringify(genome)).not.toThrow();
    }
  });

  it("survives a missing or broken palette rather than blanking the tool", () => {
    for (const palette of [undefined, null, {}, "nope", { region: null }, { select: undefined }]) {
      expect(() => render({ palette }), String(palette)).not.toThrow();
    }
  });

  it("renders under every look the hosts pass", () => {
    // ZTS is the only caller of the solid treatment; if it ever throws, ZTS is
    // the tool that goes down and the other two look fine.
    for (const look of [
      undefined,
      { nodePaint: "solid", centreLamp: false, containerWash: true, glassBlur: 18 },
      { nodePaint: "orb", centreLamp: true },
    ]) {
      const html = renderToStaticMarkup(createElement(MindCanvas, { genome: GENOME, palette: PALETTE, look }));
      expect(html).not.toMatch(/NaN|undefined/);
    }
  });

  it("accepts the exact props each host passes today", () => {
    // Mirrors the three real call sites, so a prop rename that breaks one of
    // them fails here instead of on a phone.
    expect(() => render({                                   // ZTS / Clarify shape
      selection: { type: "node", id: "a" }, onSelect: () => {}, onNodeMove: () => {},
      onAddNode: () => {}, onAddEdge: () => {}, regionFilter: new Set(["skill"]),
      height: "100%", toastTop: 104, apiRef: { current: null },
      bus: { on: () => () => {}, emit: () => {} }, label: "ZTS DNA — neural map",
    })).not.toThrow();

    expect(() => render({ height: "100%", label: "SYNC — neural map" })).not.toThrow();   // SYNC shape: no bus
  });

  it("gives two instances on one page different gradient ids", () => {
    // Document-global `dnaGrad_skill` meant whichever canvas mounted first
    // supplied the region hues for every canvas after it. useId is only unique
    // WITHIN a tree, so both canvases have to be rendered in one pass — two
    // separate renderToStaticMarkup calls each restart the id counter, which is
    // correct behaviour and would make a naive version of this test pass for
    // the wrong reason.
    const html = renderToStaticMarkup(createElement("div", null,
      createElement(MindCanvas, { key: "a", genome: GENOME, palette: PALETTE }),
      createElement(MindCanvas, { key: "b", genome: GENOME, palette: PALETTE }),
    ));
    const ids = [...html.matchAll(/id="(mg-[^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size, "two canvases on one page share a gradient id").toBe(ids.length);
  });

  it("carries the accessible name the host gave it", () => {
    expect(render({ label: "ZTS DNA — neural map" })).toContain('aria-label="ZTS DNA — neural map"');
  });

  it("puts the palette on the wrapper as custom properties", () => {
    const html = render({ palette: { ...PALETTE, select: "#ABCDEF" } });
    expect(html).toContain("--mind-select:#ABCDEF");
  });

  // Last, so it sees everything the cases above rendered.
  it("renders without a single React warning", () => {
    // The three copies all built the node's <title> from two expressions, which
    // makes React emit an array of children where SVG allows one text node. It
    // warned on every node, on every render, for as long as the component has
    // existed — and nobody ever saw it, because nothing rendered it outside a
    // browser and it is not an error. Warnings are defects that happen to render.
    // Our own palette notices are excluded: they are deliberate, they are what
    // the "broken palette" case above is provoking, and they have their own
    // tests. Everything else is React telling us the markup is wrong.
    const react = warnings.filter((w) => !w.startsWith("[@cc/mind-canvas]"));
    expect(react, `React warned while rendering:\n${react.join("\n")}`).toEqual([]);
  });
});
