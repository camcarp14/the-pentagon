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

// Every .jsx under src/, discovered rather than listed. A hard-coded manifest
// silently stops covering the file someone adds next — the component that gets
// written after this test does is exactly the one nobody re-reads the list for.
const srcFiles = () => {
  const { readdirSync } = require("node:fs");
  const { fileURLToPath } = require("node:url");
  const { dirname, join, relative } = require("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "__tests__" || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsx")) out.push(relative(root, p));
    }
  };
  walk(root);
  return out;
};

// Every JSX element in `src` that names a class, as [tagName, classTokens].
// The tag is read from the nearest preceding "<" — attribute values with
// braces (onClick={() => …}) make a whole-opening-tag regex unreliable, and
// the class list is what these rules are actually about.
const classedElements = (src) => {
  const out = [];
  for (const m of src.matchAll(/className\s*=\s*/g)) {
    let i = m.index + m[0].length;
    let raw;
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      const end = src.indexOf(q, i + 1);
      raw = src.slice(i, end === -1 ? src.length : end + 1);
    } else if (src[i] === "{") {
      let depth = 0, j = i;
      for (; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && --depth === 0) break;
      }
      raw = src.slice(i + 1, j);
    } else continue;
    // every literal chunk inside the expression contributes class tokens; a
    // `${…}` hole is unknowable from source and is simply skipped
    const tokens = [...raw.matchAll(/`([^`]*)`|"([^"]*)"|'([^']*)'/g)]
      .map((s) => (s[1] ?? s[2] ?? s[3]).replace(/\$\{[^}]*\}/g, " "))
      .join(" ")
      .split(/\s+/)
      .filter(Boolean);
    const lt = src.lastIndexOf("<", m.index);
    const tag = /^<\s*([A-Za-z][\w.]*)/.exec(src.slice(lt, lt + 40))?.[1] ?? "?";
    out.push([tag, tokens]);
  }
  return out;
};

// Every `<div className="empty">…</div>` block, matched by depth rather than by
// a fixed window, so what the test reads is the whole empty state.
const emptyStateBlocks = (src) => {
  const blocks = [];
  for (const m of src.matchAll(/<div className="empty">/g)) {
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = m.index;
    let depth = 0, t, end = src.length;
    while ((t = tags.exec(src))) {
      if (t[0] === "</div>") { if (--depth === 0) { end = tags.lastIndex; break; } }
      else depth++;
    }
    blocks.push(src.slice(m.index, end));
  }
  return blocks;
};

// Every px length inside a font-size declaration, clamp()/min()/max() included
// and case-insensitively — `font-size: clamp(9px, 2vw, 14px)` and
// `font-size: 9PX` are both a 9px floor violation.
const cssFontPx = (css) =>
  [...css.matchAll(/font-size\s*:\s*([^;}]+)/gi)]
    .flatMap((m) => [...m[1].matchAll(/([0-9.]+)\s*px/gi)].map((n) => Number(n[1])))
    .filter((n) => Number.isFinite(n) && n > 0);

describe("Macro obeys the language", () => {
  const css = stripComments(read("styles.css"));
  const files = srcFiles();
  const jsx = files.map((f) => stripComments(read(f))).join("\n");

  it("scans every .jsx under src, not a hand-kept list", () => {
    // The manifest above is globbed. This is the assertion that keeps it
    // honest: a new component under src/ must show up in `files`, and the
    // surfaces that exist today must all still be in it.
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const f of ["App.jsx", "Root.jsx", "main.jsx", "components/Cockpit.jsx",
      "components/TradeCard.jsx", "components/Journal.jsx", "components/Settings.jsx",
      "components/RunPlan.jsx", "components/ChartPanel.jsx", "components/primitives.jsx"]) {
      expect(files, `${f} must be scanned`).toContain(f);
    }
  });

  it("has no type under the 10.5px floor, in CSS or in a ternary", () => {
    // Five lived here: the bottom-tab label (9px), the answer card's row keys
    // (10px), the order-ticket keys (10px), the trend-shape header (9.5px) and
    // the "est" badge on mNAV (8.5px).
    //
    // clamp() is this sheet's live idiom for the trade card's numerals, so the
    // scan reads the whole declaration and every px inside it — a 9px lower
    // bound in a clamp() is 9px on a phone. Case-insensitive for the same
    // reason: CSS does not care that it was typed `9PX`.
    const cssSizes = cssFontPx(css);
    expect(cssSizes.length, "the font-size scan found nothing — it is broken").toBeGreaterThan(20);
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
    //
    // Read off the class LIST of every element, not off one literal spelling:
    // `<div className="field">`, `<div className="field row">` and
    // `<div className={`field ${x}`}>` are the same bug, and only the first of
    // the three is a literal a single regex can be written against.
    const CONTROLS = new Set(["input", "select", "textarea"]);
    const wrappers = classedElements(jsx)
      .filter(([tag, cls]) => cls.includes("field") && !CONTROLS.has(tag));
    expect(wrappers.map(([t, c]) => `<${t} class="${c.join(" ")}">`),
      "the kit's .field belongs on the control, never on a wrapper").toEqual([]);
    // …and the scan must actually be seeing the controls that DO carry it
    const carriers = classedElements(jsx).filter(([, cls]) => cls.includes("field"));
    expect(carriers.length, "the .field scan found nothing — it is broken").toBeGreaterThanOrEqual(20);
    expect(carriers.filter(([tag]) => !CONTROLS.has(tag))).toEqual([]);

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
    //
    // EVERY rule in the sheet, not the three that were named: .error-row
    // already has a border, so naming .card and .tcard only means the next
    // shadow to land on an outlined element lands unseen.
    const offenders = [];
    let rules = 0;
    for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
      rules++;
      const border = /(^|;)\s*border(-top|-bottom|-left|-right)?:(?!\s*none\b)/.test(body);
      const shadow = /(^|;)\s*box-shadow:(?!\s*none\b)/.test(body);
      if (border && shadow) offenders.push(`${sel.trim()} { ${body.trim()} }`);
    }
    expect(rules, "the rule walk found nothing — it is broken").toBeGreaterThan(100);
    expect(offenders, `border + shadow on one element:\n${offenders.join("\n\n")}`).toEqual([]);

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

    // Every empty state, counted and then read. `for (const m of …) expect(m)
    // .toBeTruthy()` asserted nothing in either direction: no matches meant no
    // iterations, and a matched literal is always truthy. What the title of
    // this case promises is that each empty state exists AND says what to do
    // next, so that is what is checked.
    const empties = emptyStateBlocks(jsx);
    expect(empties.length, "empty states found — the app has five and may not lose one")
      .toBeGreaterThanOrEqual(5);
    for (const b of empties) {
      expect(b, `an empty state with no title:\n${b}`).toMatch(/className="empty-title"/);
      expect(b, `an empty state with no next step:\n${b}`).toMatch(/className="empty-sub"/);
    }
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
