// Runway on the shared kit — proved by rendering, not by a green build.
//
// `vite build` was green on a component that threw "nodeR is not defined" the
// moment it mounted and took three tools down. react-dom/server executes the
// whole component body in plain Node — no jsdom needed, and this repo has none
// — so a restyle that broke a reference, a prop or a hook fails here.
//
// WHAT GETS RENDERED, AND WHY IT IS NOT ONE TREE:
// Root.jsx is the shell's mount entry and IS the element that carries data-kit,
// so it is rendered first. What it renders cold is the boot skeleton: Runway's
// session lives in a Supabase call inside a useEffect, and effects do not run
// under renderToStaticMarkup, so `session === undefined` and App.jsx returns
// <BootScreen />. Everything past that gate needs the AppProvider's context
// (useApp() destructures its value, so a bare render throws by design) —
// therefore the surfaces that DO render standalone are rendered standalone:
// Login, JobForm, EmptyState and ErrorState between them cover the field, the
// button, the form row, the chip and both state surfaces. What is left —
// the stat tiles, the segmented control, the stage pills, the printed résumé —
// is asserted against the source, with the reason noted at each.
//
// The Supabase client throws a named error at import when its env vars are
// missing (a deliberate loud guard), so the env is stubbed BEFORE the dynamic
// imports below. Nothing here touches a real network.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

vi.stubEnv("VITE_SUPABASE_URL", "https://stub.supabase.co");
vi.stubEnv("VITE_SUPABASE_ANON_KEY", "stub-anon-key");

const { default: Runway } = await import("../Root.jsx");
const { default: Login } = await import("../pages/Login.jsx");
const { default: JobForm, emptyJobForm } = await import("../ui/JobForm.jsx");
const { EmptyState, ErrorState, ToastProvider } = await import("../ui/primitives.jsx");
const { AppProvider } = await import("../lib/store.jsx");
// Every page and panel that used to be string-matched only. They ARE
// renderable: useApp() needs the provider's value, not its data, and the
// effects that fetch never run under renderToStaticMarkup — so each of these
// stands up cold in its loading/empty state with no network and no mocks.
const { default: Board } = await import("../pages/Board.jsx");
const { default: Capture } = await import("../pages/Capture.jsx");
const { default: JobDetail } = await import("../pages/JobDetail.jsx");
const { default: Market } = await import("../pages/Market.jsx");
const { default: ProfilePage } = await import("../pages/ProfilePage.jsx");
const { default: PrintView } = await import("../pages/PrintView.jsx");
const { default: TailorTab } = await import("../ui/TailorTab.jsx");
const { default: ApplyDesk } = await import("../pages/ApplyDesk.jsx");
const { default: Skills } = await import("../pages/Skills.jsx");
const { BreakdownBars, FlagChips } = await import("../ui/FitPanel.jsx");

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, "..", rel), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

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
beforeEach(() => { warnings.length = 0; });

const html = () => renderToStaticMarkup(createElement(Runway));
// the surfaces past the session gate, each in the router they assume
const routed = (el) => renderToStaticMarkup(createElement(MemoryRouter, null, el));
const loginHtml = () => routed(createElement(Login));
const formHtml = () =>
  routed(createElement(JobForm, { value: emptyJobForm, onChange: () => {}, flags: [], onFlags: () => {} }));

// The pages assume the full mount context: a router, the app store and the
// toast host. None of them needs data — every fetch is in an effect.
const inApp = (el) =>
  routed(createElement(AppProvider, null, createElement(ToastProvider, null, el)));

// Capture builds its bookmarklet from window.location.origin at render time,
// in the component body, so Node's missing `window` is not a migration bug —
// it is the browser global the bookmarklet is made of. Stubbed only for the
// span of that render, and removed again, so nothing else sees a fake browser.
const FAKE_WINDOW = {
  location: { origin: "https://runway.test", href: "https://runway.test/capture" },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  open: () => {},
};
const withWindow = (fn) => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const prev = globalThis.window;
  globalThis.window = FAKE_WINDOW;
  try { return fn(); } finally { if (had) globalThis.window = prev; else delete globalThis.window; }
};

// Every surface this app has, keyed by name so a failure says which one.
const SURFACES = {
  Root: () => html(),
  Login: () => loginHtml(),
  JobForm: () => formHtml(),
  Board: () => inApp(createElement(Board)),
  Capture: () => withWindow(() => inApp(createElement(Capture))),
  JobDetail: () => inApp(createElement(JobDetail)),
  Market: () => inApp(createElement(Market)),
  ProfilePage: () => inApp(createElement(ProfilePage)),
  PrintView: () => inApp(createElement(PrintView)),
  TailorTab: () => inApp(createElement(TailorTab, { job: { id: "j1", company: "C", title: "T" } })),
  ApplyDesk: () => inApp(createElement(ApplyDesk)),
  Skills: () => inApp(createElement(Skills)),
  FitPanel: () => inApp(createElement("div", null,
    createElement(BreakdownBars, { breakdown: [{ k: "comp", label: "Comp", pts: 4, max: 5, why: "at floor" }] }),
    createElement(FlagChips, { flags: ["low_comp"] }),
  )),
};
const everySurface = () => Object.values(SURFACES).map((f) => f()).join("\n");

// Opening tags of rendered HTML, as [tagName, classTokens]. Quoted attribute
// values are consumed as units, so a ">" inside one cannot end the tag early.
const OPEN_TAG = /<([a-zA-Z][\w-]*)((?:\s+[a-zA-Z-][\w:-]*(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
const classedElements = (out) =>
  [...out.matchAll(OPEN_TAG)].map((m) => {
    const cls = /\bclass="([^"]*)"/.exec(m[2])?.[1] ?? "";
    return [m[1], cls.split(/\s+/).filter(Boolean)];
  });

describe("Runway renders on the kit", () => {
  it("renders at all", () => {
    expect(() => html()).not.toThrow();
    expect(() => loginHtml()).not.toThrow();
    expect(() => formHtml()).not.toThrow();
  });

  it("renders EVERY page and panel, not just the three that mount trivially", () => {
    // Board, Capture, JobDetail, Market, ProfilePage, PrintView, TailorTab and
    // FitPanel used to be string-matched only, on the belief that useApp()
    // made them unrenderable. It does not: the provider supplies a value, the
    // fetches live in effects the server renderer never runs, and each page
    // therefore stands up in its own loading/empty state with no data at all.
    // A restyle that breaks a reference in any of them now fails here.
    for (const [name, render] of Object.entries(SURFACES)) {
      let out;
      expect(() => { out = render(); }, `${name} threw while rendering`).not.toThrow();
      expect(out, `${name} rendered nothing`).toMatch(/<[a-z]/);
    }
  });

  it("opts into the kit on its own root", () => {
    // On Runway's outermost element and nowhere higher. It renders inside the
    // shell's tool slot, so this reaches this app only — the same rule the
    // shell follows by keeping data-kit off the wrapper that holds every tool.
    expect(html()).toMatch(/^<div data-kit/);
  });

  it("uses the kit's primitives in the markup it renders cold", () => {
    const out = html() + loginHtml() + formHtml() + routed(
      createElement(EmptyState, { title: "Nothing yet", hint: "Do this next.", cta: "Go", ctaTo: "/" }),
    );
    for (const cls of [
      "card pad-md",   // the kit's card + its padding class
      "card pad-lg",   // …and the roomier one, on the login card
      "sk sk-line",    // skeletons
      "empty-title",   // empty states
      "empty-sub",
      "btn primary",
      "t-head",
    ]) {
      expect(out, `expected the kit's "${cls}"`).toContain(cls);
    }
  });

  it("puts the kit's .field on the CONTROL, never on the wrapper", () => {
    // The collision this migration existed to get right. Runway's .field was a
    // <label>+<input> ROW wrapper (margin-bottom: 14px); the kit's .field IS
    // the control — a filled 44px well. Had the wrapper kept the name, every
    // form row in the app would have rendered inside one.
    //
    // Read off the class LIST rather than off `class="field"` as a literal:
    // `<div class="field section">` is the same 44px well and the closing
    // quote is nowhere near the word. And EVERY control is checked, over every
    // form in the app — "at least one input has .field" is green through a
    // migration that reached one row out of thirty.
    const CONTROLS = new Set(["input", "select", "textarea"]);
    const out = everySurface();
    const els = classedElements(out);

    const wrappers = els.filter(([tag, cls]) => cls.includes("field") && !CONTROLS.has(tag));
    expect(wrappers.map(([t, c]) => `<${t} class="${c.join(" ")}">`),
      "the kit's .field belongs on the control, never on a wrapper").toEqual([]);

    // every control the app renders carries it — not merely one of them
    const controls = els.filter(([tag]) => CONTROLS.has(tag));
    expect(controls.length, "the control scan found nothing — it is broken").toBeGreaterThanOrEqual(30);
    const bare = controls.filter(([, cls]) => !cls.includes("field"));
    expect(bare.map(([t, c]) => `<${t} class="${c.join(" ")}">`),
      "a control that never adopted the kit's .field").toEqual([]);

    // and all three control elements are represented, so the sweep is real
    for (const tag of CONTROLS) {
      expect(controls.filter(([t]) => t === tag).length, `no <${tag}> was rendered`).toBeGreaterThan(0);
    }

    expect(out, "the wrapper must be .fld").toMatch(/<div class="fld"/);
  });

  it("gives every error a retry", () => {
    const out = routed(createElement(ErrorState, { msg: "boom", onRetry: () => {} }));
    expect(out).toContain('role="alert"');
    expect(out).toContain("Retry");
  });

  it("emits no NaN and no literal 'undefined' into markup", () => {
    for (const [name, render] of Object.entries(SURFACES)) {
      const out = render();
      expect(out, `${name} emitted NaN`).not.toMatch(/NaN/);
      expect(out, `${name} emitted undefined`).not.toMatch(/(style|class)="[^"]*undefined/);
    }
  });

  it("renders without a React warning", () => {
    everySurface();
    const react = warnings.filter((w) => !w.startsWith("[@cc/"));
    expect(react, `React warned:\n${react.join("\n")}`).toEqual([]);
  });
});

/* ── the language, checked against the source ─────────────────────────────── */

describe("Runway obeys the language", () => {
  const css = stripComments(read("styles/app.css") + "\n" + read("styles/polish.css"));
  const embed = stripComments(
    /const EMBED_OVERRIDES = `([\s\S]*?)`;/.exec(read("Root.jsx"))[1],
  );
  const allCss = css + "\n" + embed;
  const jsx = ["Root.jsx", "App.jsx", "lib/store.jsx", "ui/primitives.jsx", "ui/JobForm.jsx",
    "ui/FitPanel.jsx", "ui/TailorTab.jsx", "ui/TagInput.jsx", "ui/Markdown.jsx",
    "pages/Board.jsx", "pages/Capture.jsx",
    "pages/JobDetail.jsx", "pages/Market.jsx", "pages/ProfilePage.jsx", "pages/PrintView.jsx",
    "pages/Login.jsx", "pages/ApplyDesk.jsx", "pages/Skills.jsx"]
    .map((f) => stripComments(read(f))).join("\n");

  it("does NOT let the kit's fixed .sheet near the printed résumé", () => {
    // THE ONE THAT WOULD HAVE BROKEN SOMETHING REAL. PrintView renders a
    // 816px letter-paper document that a browser prints to PDF. The kit's
    // .sheet is `position: fixed; bottom: 0` modal chrome at [data-kit]
    // weight — renaming carelessly turns a résumé into a dialog.
    expect(jsx, "no call site may still say sheet").not.toMatch(/className="sheet/);
    expect(allCss, "no rule may still target .sheet").not.toMatch(/(^|[\s,{])\.sheet[\s.,:{-]/m);
    expect(allCss).toMatch(/\.paper \{[^}]*max-width: 816px/);
    // The old form of this line was `position: static` OR the mere ABSENCE of
    // a position declaration — and the print block's own `.paper {` rule has
    // no position, so the second alternative made it green whatever the first
    // rule said. What matters is the positive property: NO rule anywhere may
    // take .paper out of flow.
    const paperRules = [...allCss.matchAll(/(^|[\s,}])\.paper\s*\{([^}]*)\}/g)].map((m) => m[2]);
    expect(paperRules.length, "no .paper rule found — the scan is broken").toBeGreaterThanOrEqual(2);
    const outOfFlow = paperRules.filter((b) => /position:\s*(fixed|absolute|sticky)/.test(b));
    expect(outOfFlow, `.paper must stay in flow — it is a printed page, not chrome:\n${outOfFlow.join("\n")}`).toEqual([]);
    expect(read("pages/PrintView.jsx")).toContain('className="paper"');
    expect(read("pages/PrintView.jsx")).toContain('className="paper-body"');
    // and the print stylesheet still strips the shadow/margins off the paper
    expect(allCss).toMatch(/@media print \{[\s\S]*?\.paper \{ box-shadow: none;/);
  });

  it("has no type under the 10.5px floor, in CSS or in a ternary", () => {
    // Four sat under it: the metric caption (10px), the phone tab label (9px),
    // the phone metric label (9.5px) and the desktop nav count badge (9px).
    const cssSizes = [...allCss.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => Number(m[1]));
    expect(cssSizes.filter((n) => n < 10.5), "css font-size under the floor").toEqual([]);
    // Ternaries too — `fontSize: compact ? 9 : 12` hides a 9.
    const jsxSizes = [...jsx.matchAll(/fontSize[:=]\s*([^,\n}]+)/g)]
      .flatMap((m) => [...m[1].matchAll(/[\d.]+/g)].map((n) => Number(n[0])))
      .filter((n) => Number.isFinite(n) && n > 0);
    expect(jsxSizes.filter((n) => n < 10.5), "inline fontSize under the floor").toEqual([]);
  });

  it("puts no border and box-shadow on the same element", () => {
    // .card had a 1px border and was meant to read as elevated (the kit's card
    // separates by tone and shadow, with no outline). .kcard, .cmdk, the
    // desktop nav bar and the phone tab bar all carried both too.
    const offenders = [];
    for (const [, sel, body] of allCss.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
      const border = /(^|;)\s*border(-top|-bottom|-left|-right)?:(?!\s*none\b)/.test(body);
      const shadow = /(^|;)\s*box-shadow:(?!\s*none\b)/.test(body);
      if (border && shadow) offenders.push(sel.trim());
    }
    expect(offenders, `border + shadow together:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("shouts only through .t-label, and on paper", () => {
    // Five selectors set text-transform: uppercase by hand (h2, the metric
    // label, the kanban column head, table heads, the phone tab label) plus one
    // inline style on an SVG chart heading. The ONE survivor is the printed
    // résumé's section rule, which is a convention of the paper document a
    // recruiter receives, not this app's interface language.
    const upper = allCss.split("\n").filter((l) => /text-transform:\s*uppercase/.test(l));
    expect(upper.length, `unexpected uppercase:\n${upper.join("\n")}`).toBe(1);
    expect(upper[0]).toContain(".paper-body h2");
    expect(jsx).not.toMatch(/textTransform/);
    expect(jsx).toContain("t-label");
  });

  it("carries no decorative font — the shared stack only", () => {
    // The metric label and the desktop nav pills were set in Syne, a display
    // face. The shell's own chrome test asserts the same string never appears
    // there, for the same reason.
    expect(allCss).not.toMatch(/Syne/);
    expect(allCss).not.toMatch(/DM Mono/);
    expect(allCss).toContain("var(--font-body");
    // Georgia is not decoration here — it is the printed résumé's body face.
    expect(allCss).toMatch(/\.paper \{[^}]*Georgia/);
  });

  it("keeps the iOS 16px input workaround, at a weight that beats the kit", () => {
    // `[data-kit] .field` is 15px. Without the twin, every focused control that
    // adopted the kit's field zooms the page on iOS — the exact bug the
    // original line prevents.
    expect(allCss).toMatch(/input, select, textarea \{ font-size: 16px; \}/);
    expect(allCss).toMatch(/\[data-kit\] input\.field, \[data-kit\] select\.field, \[data-kit\] textarea\.field \{ font-size: 16px; \}/);
  });

  it("keeps the safe-area workarounds verbatim", () => {
    // The phone tab bar's clearance, and the toast position that has to beat
    // the kit's own (84px + env()) — --safe-bottom is the shell's CORRECTED
    // inset, deliberately 0 in the letterboxed iOS standalone window.
    expect(allCss).toContain("padding: 4px max(6px, env(safe-area-inset-right)) max(10px, calc(6px + var(--safe-bottom, 0px))) max(6px, env(safe-area-inset-left));");
    expect(allCss).toMatch(/\[data-kit\] \.toasts \{ bottom: calc\(88px \+ max\(22px, var\(--safe-bottom\)\)\); \}/);
  });

  it("keeps every 44px touch target after the .seg rename", () => {
    // `.seg button` no longer matches anything Runway renders, so the mobile
    // ergonomics rule had to learn .seg-opt or the remote-preference and
    // draft-type pickers would have silently dropped to the kit's 32px.
    expect(allCss).toMatch(/\[data-kit\] \.seg \.seg-opt \{ min-height: 44px; \}/);
    expect(jsx).not.toMatch(/\.seg button/);
  });

  it("marks the segmented control's selection with .active, not .on", () => {
    // Two call sites: the remote-preference picker and the Tailor draft type.
    expect(jsx).toContain("'seg-opt active'");
    expect(jsx).not.toMatch(/className=\{kind === id \? 'on' : ''\}/);
    // and selection is never colour alone — the active option carries a fill
    expect(allCss).toMatch(/\[data-kit\] \.seg \.seg-opt\.active \{ background: var\(--seg-thumb\)/);
  });

  it("routes the dashboard metrics through the kit's stat tiles", () => {
    // The metric strip is only reachable behind the session gate, so the
    // source is the honest place to check it.
    // Counted, not merely present: the strip is four tiles (Active, Applied
    // this week, Response rate, Needs follow-up) and a single toContain stays
    // green through three of the four reverting to hand-rolled markup.
    const board = stripComments(read("pages/Board.jsx"));
    const count = (re) => (board.match(re) || []).length;
    expect(count(/className="stattile on-canvas metric"/g), "the metric strip is four kit tiles").toBe(4);
    expect(count(/className="stattile-label"/g), "one kit label per tile").toBe(4);
    expect(count(/className="stattile-value"/g), "one kit value per tile").toBe(4);
    expect(board, "the hand-rolled .lab/.big/.note markup is gone").not.toMatch(/className="(lab|big)"/);
    // and the phone stage strip is the kit's monochrome filter pill
    expect(board).toMatch(/`pill\$\{s\.id === stage \? ' active' : ''\}`/);
  });

  it("leaves no hand-rolled primitive behind in the stylesheet", () => {
    // .btn's own border/radius/variants, .seg's whole implementation, .empty's
    // dashed box and .t/.h, the skeleton block, .expand, .pagefade, .stagger,
    // the toast pill and kbd were all second copies of the kit.
    for (const gone of [".seg button", ".empty .t", ".empty .h", ".sk-line", ".sk-big",
      "@keyframes shimmer", "@keyframes pagein", "@keyframes rise ", ".expand.open",
      ".btn.primary {", ".btn.danger {", ".btn.sm {", ".stagepill"]) {
      expect(allCss, `"${gone}" is the kit's job now`).not.toContain(gone);
    }
    // and the private keyframes that survive are prefixed, because this sheet
    // is injected into the SHARED document head while Runway is mounted
    expect(allCss).toContain("@keyframes rw-pulse");
    expect(allCss).toContain("@keyframes rw-fadein");
  });

  it("keeps the domain colours literal", () => {
    // Runway's violet ramp and the semantic signal colours are the values
    // @cc/design's cssVars("runway") stamps on the mount wrapper; they are
    // mirrored here so the sheet reads standalone, and they are data.
    expect(allCss).toMatch(/--accent: #8B7CFF;/);
    expect(allCss).toMatch(/--good: #3ECF8E;/);
    expect(allCss).toMatch(/--bad: #F87171;/);
    // The résumé is printed on paper: black ink on white, in every palette.
    expect(allCss).toMatch(/\.paper \{[^}]*background: #ffffff; color: #111418;/);
  });

  it("paints no SURFACE out of a literal — light mode is somebody's job", () => {
    // THE ONE THAT SHIPPED. Runway drew its sub-nav out of hardcoded white and
    // black: a rgba(255,255,255,0.055) hairline, a 4.5%-white group, #525E74
    // labels, #F7F9FC on a --surface-2 pill under a rgba(0,0,0,0.5) shadow.
    // That is a correct picture of a midnight room and only of a midnight room.
    // Measured in a browser with the light theme selected, the lit tab was
    // #F7F9FC on #F4F5F7 — 1.03:1, i.e. the word telling you where you are was
    // the least legible thing in the bar — and the hairline was white on white.
    //
    // Three places a literal is still legitimate, and the scan skips exactly
    // those: as the FALLBACK inside var(--token, …) (a value that only lands
    // where no token layer exists), inside the printed résumé and the @media
    // print block (paper is paper in every palette), and in the `:where(:root)`
    // token mirror, which is data — the test above pins three of its values.
    const withoutFallbacks = allCss.replace(/var\(\s*--[\w-]+\s*,[^()]*(?:\([^()]*\)[^()]*)*\)/g, "var(--token)");
    const offenders = [];
    let inPaper = false, inPrint = false, depth = 0;
    for (const raw of withoutFallbacks.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (/^@media print/.test(line)) { inPrint = true; depth = 0; }
      if (inPrint) {
        depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
        if (depth <= 0 && line.includes("}")) inPrint = false;
        continue;
      }
      if (/^\.paper/.test(line)) inPaper = true;
      if (inPaper) { if (line.includes("}")) inPaper = false; continue; }
      if (/^--[\w-]+\s*:/.test(line)) continue;          // the token mirror
      if (/mask-image/.test(line)) continue;             // a mask stop is not a colour
      if (/rgba?\(\s*(255,\s*255,\s*255|0,\s*0,\s*0)/.test(line) || /#[0-9a-fA-F]{3,8}\b/.test(line)) offenders.push(line);
    }
    expect(offenders, `a literal where a token belongs:\n${offenders.join("\n")}`).toEqual([]);

    // …and the same in the markup. A chart gridline was stroke="rgba(255,255,
    // 255,0.07)" — invisible on a light page, on the one surface in Runway
    // whose structure IS its gridlines — and a nested résumé card was filled
    // 2% white, which is 2% DARKER than the card it sits in, in one room only.
    const jsxNoEmbed = jsx.replace(/const EMBED_OVERRIDES = `[\s\S]*?`;/, "");
    const inMarkup = jsxNoEmbed.split("\n").map((l) => l.trim())
      .filter((l) => /rgba?\(\s*(255,\s*255,\s*255|0,\s*0,\s*0)/.test(l) || /['"]#[0-9a-fA-F]{3,8}['"]/.test(l));
    expect(inMarkup, `a literal colour in the markup:\n${inMarkup.join("\n")}`).toEqual([]);
  });

  it("builds the sub-nav from the kit's segmented control, like ZTS and Clarify", () => {
    const app = stripComments(read("App.jsx"));
    // The group IS `.seg`, the tabs ARE `.seg-opt`, and the fill behind the
    // active one is the kit's measured `.seg-thumb` — the same three objects
    // ZTS's bar and Clarify's `.co-nav` are made of. Runway used to hand-draw
    // the pill, which is why it read as a different product.
    expect(app, "the tab group is the kit's .seg").toContain('className="navgroup seg"');
    expect(app, "the tabs are the kit's .seg-opt").toMatch(/nav-item seg-opt/);
    expect(app, "the active fill is the kit's sliding thumb").toContain('className="seg-thumb"');
    // …measured, not guessed, and read off the DOM so it cannot disagree with
    // the NavLink that decided which tab is lit.
    expect(app).toMatch(/querySelector\('\.nav-item\.active'\)/);
    // Rendered from the hoisted table, which is also what names <main>.
    expect(app).toMatch(/RAIL\.map/);
    expect(app).toMatch(/export const railLabel/);
    // Sticky off the MEASURED bar. A literal 52 here is the bug that put ZTS's
    // nav 52px below content that started at 0 the day the bar went away.
    expect(embed).toContain("top: var(--shell-bar, 52px)");
    expect(embed).not.toMatch(/top:\s*52px/);
    // Same ground and same separation as the other two bars: glass, blur, and
    // ONE hairline (no shadow beside it).
    expect(embed).toMatch(/background: var\(--glass\)/);
    expect(embed).toMatch(/border-bottom: 1px solid var\(--line\)/);
    expect(embed).toMatch(/backdrop-filter: blur\(20px\) saturate\(140%\)/);
  });

  it("shows the account nowhere — the shell's rail owns it", () => {
    // The bar carried the signed-in address on its right until the shell grew a
    // left rail whose footer shows it. Two of them on one screen is one too many.
    const app = stripComments(read("App.jsx"));
    expect(app, "the sub-nav must not render the account again").not.toMatch(/user\?\.email/);
    expect(allCss, "and the rule that styled it is gone with it").not.toContain(".rail-foot .who");
  });

  it("makes ⌘K a control rather than a caption", () => {
    // It used to be the words "⌘K jump anywhere": an advertisement for a
    // shortcut, which did nothing when clicked and nothing at all on a device
    // with no ⌘. It is the same `.btn sm quiet` button ZTS and Clarify carry.
    const app = stripComments(read("App.jsx"));
    expect(app).toMatch(/className="btn sm quiet cmdk-btn"/);
    expect(app).toMatch(/onClick=\{onCommand\}/);
    expect(app).not.toContain("jump anywhere");
    // and the palette accepts being opened from outside while still owning close
    expect(stripComments(read("ui/primitives.jsx"))).toMatch(/openSignal/);
  });

  it("touches no storage key, table, query or function path", () => {
    // A restyle that renames a key is a data-loss bug wearing a stylesheet.
    for (const t of ["'jobs'", "'pipeline_events'", "'follow_ups'", "'target_profile'",
      "'watch_boards'", "'seen_postings'", "'drafts'", "'resume_master'", "'contacts'",
      "'hunts'", "'app_kits'"]) {
      expect(jsx, `table ${t} must survive`).toContain(t);
    }
    for (const p of ["'/api/scan-boards'", "'/api/check-postings'", "'/api/parse-job'",
      "'/api/find-board'", "'/api/tailor'", "'/api/parse-resume'",
      "'/api/app-questions'", "'/api/app-kit'", "'/api/discover-companies'"]) {
      expect(jsx, `endpoint ${p} must survive`).toContain(p);
    }
    for (const r of ['path="/capture"', 'path="/jobs/:id"', 'path="/print/:id/:kind"',
      'path="/market"', 'path="/profile"', 'path="/apply/:id"', 'path="/skills"']) {
      expect(jsx, `route ${r} must survive`).toContain(r);
    }
  });

  it("keeps every control that existed before the restyle", () => {
    for (const label of ["Check postings", "+ Capture a job", "Scan now", "Browse packs",
      "Parse with AI", "Save to board", "Copy code instead", "Set keywords", "Re-score",
      "Re-extract with AI", "Edit details", "Delete job", "Add contact", "Schedule follow-up",
      "Print / Save as PDF", "Download .md", "Start blank", "Save resume", "Change password"]) {
      expect(jsx, `lost the "${label}" control`).toContain(label);
    }
  });

  // The four things this build added, pinned where a refactor would quietly
  // drop them. Each one is the entry point to a whole capability, and each is
  // one deleted line away from being unreachable while every test stays green.
  it("keeps the way into every new capability", () => {
    for (const label of ["+ New hunt", "Find companies", "Fetch the form",
      "Generate the application", "Accept &amp; apply", "Copy every answer",
      "Rescan with these", "Paste questions"]) {
      expect(jsx, `lost the "${label}" control`).toContain(label);
    }
    // and the rail actually reaches Skills — a route with no way to it is dead
    expect(stripComments(read("App.jsx"))).toMatch(/to: '\/skills'/);
  });

  // The promise the apply desk makes is that it does not answer demographic
  // self-identification questions and does not invent contact details. Both
  // are enforced server-side (functions/lib/appform.mjs); this asserts the UI
  // still SAYS so, because a silent guarantee is one nobody can rely on.
  it("says out loud what the apply desk will not do", () => {
    const desk = stripComments(read("pages/ApplyDesk.jsx"));
    expect(desk).toMatch(/never answers these/i);
    expect(desk).toMatch(/nothing generated/i);
  });
});
