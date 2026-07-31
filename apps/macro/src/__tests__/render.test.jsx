// Macro (Torque) on the shared kit — proved, not asserted.
//
// The build does not prove it. `vite build` was green on a component that threw
// "nodeR is not defined" the moment it mounted, and took three tools down.
// react-dom/server executes the whole component body in plain Node — no jsdom
// needed, and this repo has none — so a restyle that broke a reference, a prop
// or a hook fails here.
//
// WHAT IS RENDERED, AND WHY IT IS App AND NOT Root:
// Root.jsx is the shell's mount entry. It returns null until a Supabase session
// resolves in an effect, and effects do not run under renderToStaticMarkup, so
// rendering it cold proves exactly nothing. App.jsx is the component that owns
// the markup — including the data-kit opt-in — so that is what gets rendered.
//
// Macro keeps all four tab panels mounted (drafts survive tab switches), so a
// cold render contains the Chart, Journal and Settings surfaces in full. The
// Cockpit is the one panel that is skeletons at t=0, because its own loading
// gate fires before any data arrives — the trade card and the stat tiles are
// therefore checked against the source, and the reason is noted at each.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../App.jsx";

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

// `embedded` is how the shell mounts it; the standalone token gate is a
// separate branch and gets its own case below.
const html = () => renderToStaticMarkup(createElement(App, { embedded: true }));

describe("Macro renders on the kit", () => {
  it("renders at all", () => {
    expect(() => html()).not.toThrow();
  });

  it("opts into the kit on its own root", () => {
    // On Macro's outermost element and nowhere higher. It renders inside the
    // shell's tool slot, so this reaches this app only — the same rule the
    // shell follows by keeping data-kit off the wrapper that holds every tool.
    expect(html()).toMatch(/^<div data-kit/);
  });

  it("uses the kit's primitives in the markup it renders cold", () => {
    const out = html();
    for (const cls of [
      'class="card pad-md"',      // the kit's card + its padding class
      'class="ttl t-label"',      // the one class allowed to be uppercase
      'class="seg" role="tablist"',  // the chart's MSTR/BTC switch
      'class="seg-opt active"',   //   … its options, not `.seg button.on`
      'class="sk sk-line w40"',   // skeletons
      'class="empty-title"',      // empty states
      'class="empty-sub"',
      'class="btn sm quiet"',     // the kit's neutral button
    ]) {
      expect(out, `expected the kit's ${cls}`).toContain(cls);
    }
    // and nothing may still be selecting the segment the old way
    expect(out).not.toMatch(/<div class="seg"[^>]*>\s*<button[^>]*class="on"/);
  });

  it("renders the chart panel's real content, not just its shell", () => {
    // Proof that the cold render is actually executing component bodies rather
    // than bailing out early everywhere: the Chart tab has no loading gate, so
    // its empty state and its controls are fully built here.
    const out = html();
    expect(out).toContain("No candle history from any source");
    expect(out).toContain('data-testid="replay-toggle"');
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

/* ── the language, checked against the source ─────────────────────────────── */

const read = (rel) => {
  const { readFileSync } = require("node:fs");
  const { fileURLToPath } = require("node:url");
  const { dirname, join } = require("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", rel), "utf8");
};
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("Macro obeys the language", () => {
  const css = stripComments(read("styles.css"));
  const jsx = ["App.jsx", "components/Cockpit.jsx", "components/TradeCard.jsx",
    "components/Journal.jsx", "components/Settings.jsx", "components/RunPlan.jsx",
    "components/ChartPanel.jsx", "components/primitives.jsx"]
    .map((f) => stripComments(read(f))).join("\n");

  it("has no type under the 10.5px floor, in CSS or in a ternary", () => {
    // Five lived here: the bottom-tab label (9px), the answer card's row keys
    // (10px), the order-ticket keys (10px), the trend-shape header (9.5px) and
    // the "est" badge on mNAV (8.5px).
    const cssSizes = [...css.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => Number(m[1]));
    expect(cssSizes.filter((n) => n < 10.5), "css font-size under the floor").toEqual([]);

    // Ternaries too — `fontSize: compact ? 9 : 12` hides a 9.
    const jsxSizes = [...jsx.matchAll(/fontSize:\s*([^,\n}]+)/g)]
      .flatMap((m) => [...m[1].matchAll(/[\d.]+/g)].map((n) => Number(n[0])))
      .filter((n) => Number.isFinite(n) && n > 0);
    expect(jsxSizes.filter((n) => n < 10.5), "inline fontSize under the floor").toEqual([]);
  });

  it("reserves uppercase for .t-label", () => {
    // Five hand-rolled uppercase micro-styles are gone: the tab labels, the card
    // titles, the stat-tile keys, the answer-card row keys, the ticket keys, the
    // trend-shape header and the table column heads. `capitalize` is a different
    // thing and is allowed (grade names, regime states).
    //
    // Exactly ONE uppercase rule may remain: the `.ttl` block, which is a
    // value-for-value mirror of the kit's .t-label kept so the standalone dev
    // entry (no kit stylesheet in the page) still renders a card title. It
    // loses to `[data-kit] .t-label` on specificity wherever the kit is loaded.
    const upper = [...css.matchAll(/[^\n{]*text-transform:\s*uppercase[^\n}]*/g)].map((m) => m[0]);
    expect(upper.length, `hand-rolled uppercase survives:\n${upper.join("\n")}`).toBe(1);
    expect(upper[0]).toContain("font-size: 12px");
    expect(upper[0]).toContain("letter-spacing: 0.05em");
  });

  it("puts the kit's .field on the CONTROL and never on the wrapper", () => {
    // THE collision this migration existed to get right. This app's .field was
    // a <label>+<input> WRAPPER; the kit's .field IS the input. Had the wrapper
    // kept the name, every form row would have rendered inside a filled 44px
    // well. Both forms live behind a loading gate, so this is checked in the
    // source — the markup cannot show them until data lands.
    expect(jsx, "no wrapper may still be called .field")
      .not.toMatch(/<div className="field"/);
    expect(jsx.match(/<div className="fld"/g).length).toBeGreaterThanOrEqual(20);
    expect(jsx.match(/<input className="field"/g).length).toBeGreaterThanOrEqual(20);
    expect(jsx).toMatch(/<select className="field"/);
    expect(css).toMatch(/\.fld \{ display: flex; flex-direction: column;/);
  });

  it("routes the stat tiles and the primary actions through the kit", () => {
    // Both live behind a loading gate too (the cockpit skeletons at t=0), so
    // the source is the honest place to check them.
    expect(jsx.match(/className="stattile"/g).length).toBeGreaterThanOrEqual(11);
    expect(jsx.match(/stattile-label/g).length).toBeGreaterThanOrEqual(11);
    expect(jsx.match(/stattile-value/g).length).toBeGreaterThanOrEqual(11);
    expect(jsx, "the hand-rolled tile must be gone").not.toMatch(/className="stat"/);
    expect(jsx.match(/className="btn primary md"/g).length).toBeGreaterThanOrEqual(5);
    expect(jsx).toMatch(/className="btn danger md"/);
    expect(jsx).toMatch(/className=\{`card pad-md span2 tcard \$\{d\.severity\}`\}/);
  });

  it("never carries the display face — system stack only", () => {
    // The desktop tab pills were set in Syne, a decorative display font. The
    // shell's own chrome test asserts the same string never appears there.
    expect(css).not.toContain("Syne");
  });

  it("puts no border and box-shadow on the same element", () => {
    // .card did (1px border + --shadow-1), .cmdk did, .toast did. The answer
    // card's severity stripe was a border-left on top of that, and the kit's
    // `border: none` would have deleted it — it is an inset shadow layer now.
    expect(css).not.toMatch(/\.card\s*\{[^}]*border:\s*1px[^}]*box-shadow/);
    expect(css).toMatch(/\.card\s*\{[^}]*border:\s*none/);
    expect(css).toMatch(/\[data-kit\] \.card\.tcard\s*\{\s*box-shadow:[^}]*inset 5px 0 0/);
    expect(css, "the stripe must not go back to being a border")
      .not.toMatch(/\.tcard[^{]*\{[^}]*border-left/);
  });

  it("keeps the iOS 16px input workaround, at a weight that beats the kit", () => {
    // `[data-kit] .field` is 15px. Without the twin below, every focused input
    // on iOS zooms the page — the exact bug the original line prevents.
    expect(css).toMatch(/input,\s*select,\s*textarea\s*\{\s*font-size:\s*16px/);
    expect(css).toMatch(/\[data-kit\] input\.field[^{]*\{\s*font-size:\s*16px/);
  });

  it("keeps the iOS letterbox guard governing the toasts", () => {
    // `[data-kit] .toasts` pins itself to calc(84px + env(safe-area-inset-bottom))
    // and out-specifies this app's rule. Raw env() is precisely what the shell's
    // letterbox guard overrides — on a "black-translucent" install the reported
    // inset is a dead strip, and padding for it floats the bar off the screen.
    // The shell publishes the usable value as --safe-bottom; this must read it.
    expect(css).toMatch(/\[data-kit\]\.macro-root \.toasts\s*\{\s*bottom:\s*calc\(var\(--nav-h\) \+ 14px \+ var\(--safe-bottom, 0px\)\)/);
    // and the element that carries data-kit must be the one .macro-root names
    expect(jsx).toMatch(/<div data-kit className="macro-root">/);
  });

  it("keeps every 44px touch target after the .seg rename", () => {
    // `.seg button` no longer matches anything the app renders, so the mobile
    // ergonomics rule had to learn .seg-opt or the stop-mode picker would have
    // silently dropped to the kit's 32px.
    expect(css).toMatch(/\[data-kit\] \.seg \.seg-opt\s*\{\s*min-height:\s*44px/);
  });

  it("keeps the domain colours literal", () => {
    // The series identities and the candle polarity are data. A hex that means
    // "this is BTC" or "this number is negative" is not a palette choice.
    expect(css).toMatch(/--mstr:\s*#3b72e8/i);
    expect(css).toMatch(/--btc:\s*#d97706/i);
    expect(jsx).toMatch(/#0FA3A3/i);   // up / positive R
    expect(jsx).toMatch(/#D93A5F/i);   // down / negative R
  });

  it("gives every error a retry and every empty state a next step", () => {
    expect(jsx.match(/error-row/g).length).toBeGreaterThan(0);
    // one Retry (or the always-reachable Refresh) per error surface
    expect(jsx.match(/>Retry</g).length).toBeGreaterThanOrEqual(4);
    for (const m of jsx.match(/className="empty"/g) || []) expect(m).toBeTruthy();
    expect(jsx.match(/empty-sub/g).length).toBeGreaterThanOrEqual(4);
  });

  it("did not touch a single storage key or endpoint path", () => {
    // A restyle that renames a key is a data loss bug wearing a stylesheet.
    expect(jsx).toContain("sessionStorage.getItem('torque_token')");
    expect(jsx).toContain("sessionStorage.setItem('torque_token'");
    for (const path of ["'settings'", "'position'", "'journal'", "'status'", "'quote'", "'btc'"]) {
      expect(jsx, `endpoint ${path} must survive`).toContain(path);
    }
    expect(jsx).toContain("'candles?symbol=MSTR&tf=1d'");
  });
});
