// SYNC, executed.
//
// mount.test.js next door reads this app's stylesheet and its entry as TEXT.
// That is the right tool for "is every selector scoped" and the wrong one for
// "does the thing still render": `vite build` was green on a component that
// threw the moment it mounted and took three tools down with it.
//
// react-dom/server runs the whole component body in plain Node — no jsdom
// needed, and none exists here — so a restyle that broke a reference, a prop
// or a hook fails on this file. Two properties it cannot check are pinned in
// mount.test.js instead, and each says why where it stands.
//
// Two things shape what is renderable here:
//   · effects do not run, so SyncRoot's first-paint gate (`if (!styled) return
//     null`) means SyncRoot itself renders to nothing. The tree under it is
//     reached through App, which is what SyncRoot mounts.
//   · react-dom/server refuses createPortal outright ("Portals are not
//     currently supported by the server renderer"), so the sheet, the toast
//     host and the open palette cannot be rendered from here. PortalLayer, the
//     wrapper that carries the tokens and the kit out to <body>, is a plain
//     pair of divs and IS rendered.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

// The app's own shim, the same one every other suite in this app uses. It is
// window/localStorage and nothing else — no component, no store and no data is
// faked, so what renders below is the real thing.
import { installBrowserEnv } from "../test/env.js";
installBrowserEnv();

const { default: SyncRoot } = await import("../Root.jsx");
const { default: App } = await import("../App.jsx");
const { PortalLayer } = await import("../ui/kit.jsx");
const { setSettings } = await import("../data/store.js");

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..");
const src = (...p) => readFileSync(join(SRC, ...p), "utf8");

// ════════════════════════════════════════════════════════════════════════════
// SOURCE SCANNERS
//
// Everything below serves the two language guards at the bottom of this file
// (the 10.5px floor and border-and-shadow). Both used to be one regex each,
// and a fresh-context review proved by mutation that both were guards that
// COULD NOT FAIL for any realistic reintroduction of the defect they name:
//
//   · the floor's JSX half matched `fontSize:` followed by a bare number, so
//     `fontSize: "9px"`, `fontSize: o.sub ? "9px" : "12px"`, `` fontSize:
//     `${9}px` `` and `const TINY = 9; … fontSize: TINY` were all invisible;
//   · its CSS half needed a digit immediately after the colon, so
//     `font-size: clamp(8px, 1vw, 11px)` walked straight through;
//   · the floor scanned five hardcoded files, so a violation in any of the
//     seven pages or PentagonPanel was simply not looked at;
//   · border-and-shadow paired declarations only WITHIN ONE `{ }`, so a
//     sibling rule on the same selector, the same rule inside `@media`, and
//     any inline `style={{ }}` at all were all free.
//
// The correction is the same in every case: parse the value rather than
// pattern-match its shape, look at every file, and FAIL on anything the
// scanner cannot decide. A silent skip is what produced all four holes.
// ════════════════════════════════════════════════════════════════════════════

/** Every .js/.jsx under src/, tests excluded, sorted so a run is repeatable. */
function sourceFiles() {
  const out = [];
  (function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") walk(p); }
      else if (/\.jsx?$/.test(e.name)) out.push(p);
    }
  })(SRC);
  return out.sort();
}
const rel = (p) => relative(SRC, p).split(sep).join("/");

const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── the three things a JS value can hide behind ────────────────────────────
/** Index just past the closing quote of the string starting at i. */
function endQuoted(s, i) {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") { j++; continue; }
    if (s[j] === q) return j + 1;
  }
  return s.length;
}
/** Index just past the `}` closing the brace group starting at i. */
function endBraces(s, i) {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'") { j = endQuoted(s, j) - 1; continue; }
    if (c === "`") { j = endTemplate(s, j) - 1; continue; }
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) return j + 1; }
  }
  return s.length;
}
/** Index just past the closing backtick of the template starting at i. */
function endTemplate(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") { j++; continue; }
    if (s[j] === "`") return j + 1;
    if (s[j] === "$" && s[j + 1] === "{") { j = endBraces(s, j + 1) - 1; continue; }
  }
  return s.length;
}

/** The whole expression starting at i, to the first top-level , ; ) or }. */
function readExpr(s, i) {
  const start = i;
  let d = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { i = endQuoted(s, i); continue; }
    if (c === "`") { i = endTemplate(s, i); continue; }
    if (d === 0 && (c === "," || c === ";" || c === "}" || c === ")" || c === "]")) break;
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") d--;
    i++;
  }
  return { text: s.slice(start, i).trim(), end: i };
}

/** [consequent, alternate] for a top-level ternary, else null. */
function splitTernary(e) {
  let d = 0;
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if (c === '"' || c === "'") { i = endQuoted(e, i) - 1; continue; }
    if (c === "`") { i = endTemplate(e, i) - 1; continue; }
    if (c === "(" || c === "[" || c === "{") { d++; continue; }
    if (c === ")" || c === "]" || c === "}") { d--; continue; }
    if (d !== 0 || c !== "?") continue;
    if (e[i + 1] === "?" || e[i + 1] === ".") { i++; continue; } // ?? and ?.
    let dd = 0, nested = 0;
    for (let j = i + 1; j < e.length; j++) {
      const k = e[j];
      if (k === '"' || k === "'") { j = endQuoted(e, j) - 1; continue; }
      if (k === "`") { j = endTemplate(e, j) - 1; continue; }
      if (k === "(" || k === "[" || k === "{") { dd++; continue; }
      if (k === ")" || k === "]" || k === "}") { dd--; continue; }
      if (dd !== 0) continue;
      if (k === "?") { if (e[j + 1] === "?" || e[j + 1] === ".") j++; else nested++; continue; }
      if (k === ":") {
        if (nested) { nested--; continue; }
        return [e.slice(i + 1, j).trim(), e.slice(j + 1).trim()];
      }
    }
    return null; // a `?` we cannot close — undecidable, and the caller says so
  }
  return null;
}

/** A px length as a number: "9px", "9PX", "9" → 9. Anything else → null. */
function pxOf(v) {
  const s = String(v).trim();
  if (/^-?[\d.]+px$/i.test(s)) return Number(s.slice(0, -2));
  if (/^-?[\d.]+$/.test(s)) return Number(s);
  return null;
}

/** The single `const|let|var NAME = …` initialiser in this file, or null. */
function bindingOf(name, source) {
  const re = new RegExp(`(?:^|[^\\w$.])(?:const|let|var)\\s+${name}\\s*=`, "g");
  let m, found = null;
  while ((m = re.exec(source))) {
    const { text } = readExpr(source, m.index + m[0].length);
    if (found !== null && found !== text) return null; // two of them: undecidable
    found = text;
  }
  return found;
}

/**
 * Every px value a fontSize expression can take, or null when this scanner
 * cannot decide — which is a FAILURE at the call site, never a skip.
 * Handles: numbers, quoted strings, template literals with numeric holes,
 * ternaries (both arms), parentheses, and single-binding variable indirection.
 */
function fontSizeValues(expr, source, depth = 0) {
  let e = expr.trim();
  if (!e || depth > 8) return null;
  while (e.startsWith("(") && readExpr(e.slice(1), 0).end === e.length - 2) e = e.slice(1, -1).trim();

  const tern = splitTernary(e);
  if (tern) {
    const a = fontSizeValues(tern[0], source, depth + 1);
    const b = fontSizeValues(tern[1], source, depth + 1);
    return a && b ? [...a, ...b] : null;
  }
  if (/^-?[\d.]+$/.test(e)) return [Number(e)];
  if ((e[0] === '"' || e[0] === "'") && endQuoted(e, 0) === e.length) {
    const n = pxOf(e.slice(1, -1));
    return n === null ? null : [n];
  }
  if (e[0] === "`" && endTemplate(e, 0) === e.length) {
    let out = "";
    for (let j = 1; j < e.length - 1; j++) {
      const c = e[j];
      if (c === "\\") { out += e[j + 1]; j++; continue; }
      if (c === "$" && e[j + 1] === "{") {
        const end = endBraces(e, j + 1);
        const v = fontSizeValues(e.slice(j + 2, end - 1), source, depth + 1);
        if (!v || v.length !== 1) return null;
        out += String(v[0]);
        j = end - 1; continue;
      }
      out += c;
    }
    const n = pxOf(out);
    return n === null ? null : [n];
  }
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    const bound = bindingOf(e, source);
    return bound === null ? null : fontSizeValues(bound, source, depth + 1);
  }
  return null; // props, member reads, calls, arithmetic — not decidable here
}

/** Every fontSize in every source file: the ones we resolved, and the ones we could not. */
function scanJsxFontSizes(files) {
  const sizes = [], undecided = [];
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"));
    const re = /(^|[^\w$.])fontSize\s*:/g;
    let m;
    while ((m = re.exec(source))) {
      const { text, end } = readExpr(source, m.index + m[0].length);
      re.lastIndex = Math.max(re.lastIndex, end);
      const where = `${rel(file)} → fontSize: ${text.replace(/\s+/g, " ")}`;
      const vals = fontSizeValues(text, source);
      if (!vals || !vals.length || vals.some((n) => !Number.isFinite(n))) undecided.push(where);
      else for (const n of vals) sizes.push({ where, n });
    }
  }
  return { sizes, undecided };
}

/** Every `style={{ … }}` object literal in a file, as raw text. */
function inlineStyleObjects(source) {
  const out = [];
  const re = /style\s*=\s*\{\{/g;
  let m;
  while ((m = re.exec(source))) {
    const open = m.index + m[0].length - 1; // the inner `{`
    const end = endBraces(source, open);
    out.push(source.slice(open, end));
    re.lastIndex = end;
  }
  return out;
}

// ── CSS ────────────────────────────────────────────────────────────────────
/**
 * Every rule in a sheet as [selector, declarations], DESCENDING INTO at-rules
 * (`@media` bodies are rules too — one of the proven blind spots) and skipping
 * `@keyframes`, whose `from`/`to`/`40%` preludes are not selectors.
 */
function cssRules(sheet) {
  const out = [];
  (function walk(text) {
    let i = 0, prelude = "";
    while (i < text.length) {
      const c = text[i];
      if (c !== "{") { prelude += c; i++; continue; }
      const end = endBraces(text, i);
      const body = text.slice(i + 1, end - 1);
      const sel = prelude.trim();
      if (sel.startsWith("@")) {
        if (/^@(media|supports|layer|container|scope)\b/i.test(sel)) walk(body);
      } else if (sel) out.push([sel, body]);
      prelude = ""; i = end;
    }
  })(sheet.replace(/\/\*[\s\S]*?\*\//g, ""));
  return out;
}

/** The declarations that land on each individual selector, merged sheet-wide. */
function declarationsBySelector(sheet) {
  const map = new Map();
  for (const [sel, body] of cssRules(sheet)) {
    for (const one of sel.split(",")) {
      const key = one.trim().replace(/\s+/g, " ");
      if (!key) continue;
      map.set(key, (map.get(key) || "") + ";" + body);
    }
  }
  return map;
}

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

const render = (el) => renderToStaticMarkup(el);

// First run: onboarded is false out of the box, so this is the entrance.
const firstRun = () => {
  setSettings({ onboarded: false });
  return render(createElement(App));
};

// The workspace: sub-nav, console, orb, composer. matchMedia in the shim
// answers false to everything, so this is the desktop layout — the horizontal
// sub-nav rather than the phone's tab bar.
const workspace = () => {
  setSettings({ onboarded: true });
  return render(createElement(App));
};

describe("SYNC renders", () => {
  it("renders its first run without throwing", () => {
    expect(() => firstRun()).not.toThrow();
    expect(firstRun()).toContain("entrance-card");
  });

  it("renders the workspace without throwing", () => {
    expect(() => workspace()).not.toThrow();
    // `sy-nav`, not `console-bar`: the six destinations moved out of a vertical
    // rail and into the horizontal row every other tool has, and the Console's
    // own control row is drawn on a phone only now that the row carries the
    // same three controls from every page.
    expect(workspace()).toContain("sy-nav");
  });

  it("opens the centralized Mind from its nested shell route", () => {
    const previousHash = window.location.hash;
    window.location.hash = "#/sync/mind";
    setSettings({ onboarded: true });
    const out = render(createElement(App));
    window.location.hash = previousHash;
    expect(out).toContain("Pentagon — master Mind");
  });

  it("holds the first paint until its stylesheet is in the document", () => {
    // Not a quirk of the renderer — the gate in Root.jsx is deliberate, and a
    // cold chunk load would otherwise flash a full-height layout unstyled.
    // Effects never run on the server, so this is what that gate looks like.
    expect(render(createElement(SyncRoot))).toBe("");
  });
});

describe("SYNC is on the shared kit", () => {
  // Every class below is asserted against markup this test EXECUTED, not
  // against the stylesheet or the source.

  // Whole class attributes, not substrings: `toContain("field")` would still
  // pass against a renamed Field, because some other element's markup contains
  // those five letters. These are what the browser actually matches on.
  it("draws its first run out of the kit", () => {
    const out = firstRun();
    // The type scale, the button and the field — the entrance is nothing else.
    for (const cls of ['class="t-title1"', 'class="t-body"', 'class="t-label"', 'class="btn primary lg full"']) {
      expect(out, `expected the kit's ${cls} in the entrance`).toContain(cls);
    }
    // Both halves of the field, named separately: Field and TextArea share the
    // class, so one assertion on the string alone would still pass with one of
    // the two renamed.
    expect(out, "the kit's .field on an <input>").toMatch(/<input[^>]*class="field"/);
    expect(out, "the kit's .field on a <textarea>").toMatch(/<textarea[^>]*class="field"/);
  });

  it("draws the workspace out of the kit", () => {
    const out = workspace();
    for (const cls of [
      'class="seg-opt active"', 'class="icon-btn on"', 'class="card pad-lg"',
      'class="t-head"', 'class="t-foot"', 'class="pill"', 'class="btn quiet md"',
      // The phase readout, which is where .t-cap reaches the workspace. It is
      // the rail's own status line, moved into the sub-nav's actions with the
      // kit class it always wore — asserted as the WHOLE attribute, per the
      // note above, so a rename of either half lands here.
      'class="dotstatus"', 'class="t-cap sy-nav-phase"',
    ]) {
      expect(out, `expected the kit's ${cls} in the workspace`).toContain(cls);
    }
  });

  it("carries the kit out to the surfaces it portals to <body>", () => {
    // Sheets, toasts and the palette land outside .sy-root, where neither this
    // app's stylesheet nor the Pentagon's tokens reach. PortalLayer is the
    // bridge; it is a component, so it can be run rather than described.
    // No shell in this renderer — no [data-app] to read back — so this is the
    // standalone fallback path, which is byte-for-byte what this component did
    // before it learned to follow the shell. Inside the Pentagon it copies the
    // wrapper's own data-palette/data-theme and custom properties instead, which
    // is what stopped every SYNC sheet, toast and palette from rendering
    // MIDNIGHT on a light page; that half is asserted in a browser, because a
    // string render has no shell to follow.
    const out = render(createElement(PortalLayer, null, createElement("div", { className: "sheet" })));
    expect(out).toMatch(/<div class="sy-scope"[^>]*data-palette="sync"[^>]*data-theme="dark"/);
    expect(out).toMatch(/<div class="sy-root sy-layer" data-kit=/);
    expect(out).toContain('class="sheet"');
    // The tokens .sy-scope reads have to arrive with it. --muted and --good
    // are emitted by cssVars() and by nothing else in the design layer, and
    // what a portal would inherit from :root instead is the LIGHT palette.
    expect(out, "--muted must reach the portal").toMatch(/--muted:\s*#/);
    expect(out, "--good must reach the portal").toMatch(/--good:\s*#/);
    expect(out, "--accent-ink must reach the portal").toMatch(/--accent-ink:\s*#/);
    // …and it must be SYNC's own ground, not the :root default a portal would
    // otherwise inherit — which is Porcelain, the LIGHT room.
    expect(out).toContain("--bg:#000000");
    expect(out, "Porcelain's paper must never reach a SYNC surface").not.toContain("#F2F1EB");
    // SYNC's accent and no other tool's — every tool shares the midnight
    // ground, so the ground alone would not catch cssVars("zts") here.
    expect(out, "the portal must carry SYNC's accent").toContain("--accent:#C36BFF");
  });

  it("opts in on its own root, and only there", () => {
    // The one claim on this page that execution cannot make: SyncRoot's
    // .sy-root element sits behind the first-paint gate above, so it is never
    // in any server-rendered string. It is read from the entry instead — and
    // the same pair of checks stands in mount.test.js, next to the rest of the
    // mount contract.
    const root = src("Root.jsx");
    expect(root).toMatch(/className="sy-root" data-kit/);
    // Higher than .sy-root and it would reach past this tool; the shell keeps
    // data-kit off the wrapper that holds all eight for exactly this reason.
    expect(root).not.toMatch(/className="sy-scope"[^>]*data-kit/);
  });
});

describe("SYNC obeys the language", () => {
  it("emits no NaN and no literal 'undefined' into markup", () => {
    for (const out of [firstRun(), workspace()]) {
      expect(out).not.toMatch(/NaN/);
      expect(out).not.toMatch(/(style|class)="[^"]*undefined/);
    }
  });

  it("renders without a React warning", () => {
    firstRun();
    workspace();
    const react = warnings.filter((w) => !w.startsWith("[@cc/"));
    expect(react, `React warned:\n${react.join("\n")}`).toEqual([]);
  });

  it("puts no text under the 10.5px floor — the sheet", () => {
    // The tab bar's label was 10px and the mind legend's counter was 10px;
    // both are the kit's 10.5 or better now.
    //
    // The whole declaration is read, not the first token after the colon: the
    // previous regex wanted a bare number there, so `font-size: clamp(8px,
    // 1vw, 11px)` was silently a pass. Every px inside the value is checked,
    // case-insensitively (`9PX` is a violation), and a value this cannot
    // reduce to px — an em, a rem, a vw, a var() — FAILS rather than skips,
    // because a viewport-relative size cannot be proven to clear a floor.
    const css = src("styles.css");
    const decls = [...css.matchAll(/(?:^|[;{\s])(font-size|font)\s*:\s*([^;}]*)/gi)];
    // Scan sanity: 28 font-size declarations on the day this was written. If
    // the property is ever renamed or the regex rots, this fires instead of
    // the suite passing against an empty list.
    expect(decls.length, "the sheet has font declarations to check").toBeGreaterThan(20);

    const sizes = [], undecided = [];
    const KEYWORD = /^(inherit|initial|unset|revert|revert-layer)$/i;
    const OTHER_UNIT = /-?[\d.]+\s*(em|rem|%|pt|pc|in|cm|mm|q|ex|ch|vw|vh|vmin|vmax|cap|ic|lh|rlh)\b/i;
    for (const d of decls) {
      const prop = d[1].toLowerCase();
      const raw = d[2].trim();
      const px = [...raw.matchAll(/(-?[\d.]+)\s*px\b/gi)].map((m) => Number(m[1]));
      // `font:` is a shorthand and its other components are lengths too; only
      // sizes it actually spells in px are ours to judge. `font: inherit`,
      // which is all this sheet uses it for, carries none.
      if (prop === "font") { for (const n of px) sizes.push({ where: `font: ${raw}`, n }); continue; }
      if (px.length) {
        for (const n of px) sizes.push({ where: `font-size: ${raw}`, n });
        if (OTHER_UNIT.test(raw.replace(/-?[\d.]+\s*px\b/gi, ""))) undecided.push(`font-size: ${raw}`);
      } else if (!KEYWORD.test(raw)) {
        undecided.push(`font-size: ${raw}`);
      }
    }
    expect(undecided, `font-size values this scan cannot hold to the floor:\n${undecided.join("\n")}`).toEqual([]);
    expect(sizes.length, "the sheet has px font sizes to check").toBeGreaterThan(20);
    expect(sizes.filter((s) => s.n < 10.5).map((s) => s.where)).toEqual([]);
  });

  it("puts no text under the 10.5px floor — the components", () => {
    // Every .js/.jsx under src/, not the five files this used to name. The
    // reviewer added `style={{ fontSize: 8 }}` to pages/ConsolePage.jsx and
    // the suite stayed green, because ConsolePage was not on the list — and
    // neither were the other six pages or PentagonPanel.
    const files = sourceFiles();
    expect(files.length, "the source glob found files").toBeGreaterThan(25);
    // …and it still reaches the ones we know by name, so a glob that quietly
    // stops matching cannot pass as "no violations found".
    const names = files.map(rel);
    for (const known of [
      "ui/kit.jsx", "chrome/Shell.jsx", "chrome/SettingsSheet.jsx", "chrome/Onboarding.jsx",
      "chrome/PentagonPanel.jsx", "chrome/CommandK.jsx",
      "pages/MindPage.jsx", "pages/ConsolePage.jsx", "pages/DayPage.jsx", "pages/QueuePage.jsx",
      "pages/VoicePage.jsx", "pages/BriefPage.jsx", "pages/MemoryPage.jsx",
      "App.jsx", "Root.jsx", "voice/VoiceOrb.jsx",
    ]) expect(names, `the glob must still reach ${known}`).toContain(known);
    expect(names, "and it must not sweep the tests up with the source").not.toContain("__tests__/render.test.jsx");

    const { sizes, undecided } = scanJsxFontSizes(files);
    // The four forms that were provably invisible here — "9px", a ternary, a
    // template literal and a named constant — all resolve now. Anything that
    // still does not is a failure, not a skip: silent skipping is the whole
    // reason this guard could not fail.
    expect(undecided, `fontSize expressions this scan cannot decide:\n${undecided.join("\n")}`).toEqual([]);
    expect(sizes.length, "the components have font sizes to check").toBeGreaterThan(5);
    expect(sizes.filter((s) => s.n < 10.5).map((s) => s.where)).toEqual([]);
  });

  it("reaches uppercase only through .t-label", () => {
    // The mind inspector's "locked" chip and its weight band each rolled their
    // own text-transform at 9.5px. Nothing in the sheet sets one now; the two
    // that need caps wear the kit's class.
    //
    // This was `expect(css).not.toMatch(/text-transform:\s*uppercase/)` and
    // three realistic reintroductions walked straight through it:
    // `text-transform : uppercase` (a space before the colon, which CSS
    // accepts), `text-transform:UPPERCASE` (no /i), and — worst — an inline
    // `style={{ textTransform: "uppercase" }}` on any page, because it never
    // looked at JSX at all and an inline style beats every rule in the sheet.
    // The border-and-shadow guard below has scanned inline styles all along,
    // so that was an inconsistency as well as a hole.
    //
    // The declaration is parsed rather than pattern-matched in
    // __tests__/cascade.test.js, which resolves this app's sheet AND the kit's;
    // what stays here is the text-level floor and the two call sites.
    const css = src("styles.css");
    expect(css, "a space before the colon is still a declaration")
      .not.toMatch(/text-transform\s*:\s*(?!none|inherit|initial|unset)/i);
    // Scan sanity: the class this language routes caps through must still be
    // reachable, or "no uppercase anywhere" is a statement about a dead sheet.
    const kitCss = readFileSync(join(SRC, "..", "..", "..", "packages", "ui", "components.css"), "utf8");
    expect(kitCss, "the kit still owns the one uppercase in the language")
      .toMatch(/\[data-kit\]\s*\.t-label\s*\{[^}]*text-transform:\s*uppercase/);
    // Both mind chips wear it — the sheet's comment says so of both, and only
    // one of the two call sites had been updated.
    const mind = src("pages", "MindPage.jsx");
    expect(mind).toContain('className="t-label neuron-lock"');
    expect(mind).toContain('className="t-label neuron-band"');
    // …and no inline style reaches caps behind the sheet's back.
    const inline = [];
    for (const file of sourceFiles()) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const text of inlineStyleObjects(source))
        if (/textTransform\s*:\s*[^,}]*uppercase/i.test(text)) inline.push(`${rel(file)} → ${text.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    expect(inline, `inline textTransform: uppercase:\n${inline.join("\n")}`).toEqual([]);
  });

  it("puts no border and shadow on the same element — the sheet", () => {
    // §4.2: one material. This used to pair the two declarations only inside a
    // single `{ }`, and three realistic reintroductions were each proven to
    // stay green: a sibling `.sy-root .mind-stage { box-shadow: … }` next to
    // the bordered .mind-stage block, the same rule nested inside `@media
    // (hover: hover)`, and an inline style, which it never looked at at all.
    // So the declarations are resolved PER SELECTOR across the whole sheet,
    // at-rule bodies included.
    //
    // Keyed on the exact selector, deliberately: `:focus-visible` is its own
    // row and does not merge into the resting element. A focus ring drawn as a
    // box-shadow on a bordered control is the standard `outline: none`
    // replacement, not resting elevation — see the comment above
    // `.sy-root :where(:focus-visible)` in styles.css, which records that this
    // was reviewed and declined twice.
    //
    // This still reads SYNC's sheet ALONE, and that is now only half the
    // guard: since .sy-root grew `data-kit`, half the declarations on these
    // elements come from packages/ui/components.css, and
    // `.sy-root .card { border }` next to `[data-kit] .card { box-shadow }`
    // assembles the anti-pattern one declaration per sheet with this test
    // green. The cross-sheet half lives in __tests__/cascade.test.js, which
    // merges by ELEMENT rather than by selector text — two strings, one
    // element — and both halves have to stay.
    const css = src("styles.css");
    const rules = cssRules(css);
    expect(rules.length, "the sheet has rules to check").toBeGreaterThan(150);
    const merged = declarationsBySelector(css);
    expect(merged.size, "the sheet has selectors to check").toBeGreaterThan(150);
    // Scan sanity with teeth: these two only exist in the parse if the walker
    // actually descends into `@media`. Case (b) above is exactly the rule the
    // old block-local regex never saw.
    expect([...merged.keys()], "rules nested in @media must be reached")
      .toContain(".sy-root .tickbox:hover");
    expect([...merged.keys()], "and so must rules in the reduced-motion block")
      .toContain(".sy-root .cmdk");

    const BORDER = /(^|[;{\s])border(-top|-right|-bottom|-left)?\s*:\s*(?!none)[^;]*\d/;
    const SHADOW = /(^|[;{\s])box-shadow\s*:\s*(?!none)/;
    const both = [...merged].filter(([, d]) => BORDER.test(d) && SHADOW.test(d)).map(([s]) => s);
    expect(both, `border and box-shadow on the same selector:\n${both.join("\n")}`).toEqual([]);
  });

  it("puts no border and shadow on the same element — the inline styles", () => {
    // The third proven reintroduction: `style={{ border: "1px solid red",
    // boxShadow: "0 1px 2px #000" }}` on the mind chip's dot. An inline style
    // beats every rule in the sheet, so a guard that reads only CSS is reading
    // the weaker half.
    const files = sourceFiles();
    expect(files.length, "the source glob found files").toBeGreaterThan(25);
    const objects = [];
    for (const file of files)
      for (const text of inlineStyleObjects(stripComments(readFileSync(file, "utf8"))))
        objects.push({ where: `${rel(file)} → ${text.replace(/\s+/g, " ").slice(0, 160)}`, text });
    // Scan sanity: 239 inline style objects on the day this was written. This
    // app is class-based now, but not inline-free, and a `style={{` matcher
    // that stopped matching would otherwise report a clean sweep of nothing.
    expect(objects.length, "there are inline style objects to check").toBeGreaterThan(100);

    // `borderRadius` / `borderColor` do not match: the colon must follow the
    // side, if any. `border: "none"` and `boxShadow: "none"` are removals.
    const BORDER = /(^|[,{\s])border(Top|Right|Bottom|Left)?\s*:\s*(?!["'`]?none)[^,}]*\d/;
    const SHADOW = /(^|[,{\s])boxShadow\s*:\s*(?!["'`]?none)/;
    const both = objects.filter((o) => BORDER.test(o.text) && SHADOW.test(o.text)).map((o) => o.where);
    expect(both, `border and box-shadow in one inline style:\n${both.join("\n")}`).toEqual([]);
  });

  it("keeps the colours that carry meaning literal", () => {
    // A hue that says WHICH thing this is is data, not theme. Two of them
    // survive the move onto a shared palette untouched: a neuron's region tint,
    // which comes out of @cc/mind and is the same colour on the canvas, in the
    // legend and in the inspector; and a block's venture tone on the day
    // timeline, which is the operator's own and is never re-pointed at the
    // accent — it only changed from a border to an inset rail.
    const mind = src("pages", "MindPage.jsx");
    expect(mind).toContain("style={{ background: REGIONS[node.region].tint }}");
    expect(mind).toContain("style={{ background: REGIONS[r].tint }}");
    // Three states draw the rail — resting, hover and now — and all three take
    // the block's own tone. One of them falling back to the bare accent would
    // make every venture the same colour in that state, which is worse than no
    // rail at all.
    const rail = src("styles.css").match(/inset 3px 0 0 var\(--tone, var\(--accent\)\)/g) || [];
    expect(rail.length, "the tone rail at rest, on hover and on now").toBe(3);
  });

  it("still says what to do next when there is nothing to show", () => {
    // An empty state that only says "no data" is a dead end. The Console's
    // cold open is the one that renders here, and every opener is a real pill
    // that sends a real instruction, not a sentence describing one.
    const out = workspace();
    expect(out).toMatch(/<button class="pill">[\s\S]{0,400}Plan my day<\/button>/);
    expect(out).toMatch(/<button class="pill">[\s\S]{0,400}gone quiet\?<\/button>/);
  });

  it("offers a way forward when something has actually failed", () => {
    // Errors carry a retry; there are no dead-end banners. The shim reports no
    // speech recognition, so the Console renders the real degraded state — and
    // it names the browsers that do work rather than stopping at "unsupported".
    const out = workspace();
    expect(out).toMatch(/class="act"[\s\S]{0,900}no speech recognition/);
    expect(out).toContain("Everything still works by typing");
  });
});
