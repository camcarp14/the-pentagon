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

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
const { EmptyState, ErrorState } = await import("../ui/primitives.jsx");

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

const html = () => renderToStaticMarkup(createElement(Runway));
// the surfaces past the session gate, each in the router they assume
const routed = (el) => renderToStaticMarkup(createElement(MemoryRouter, null, el));
const loginHtml = () => routed(createElement(Login));
const formHtml = () =>
  routed(createElement(JobForm, { value: emptyJobForm, onChange: () => {}, flags: [], onFlags: () => {} }));

describe("Runway renders on the kit", () => {
  it("renders at all", () => {
    expect(() => html()).not.toThrow();
    expect(() => loginHtml()).not.toThrow();
    expect(() => formHtml()).not.toThrow();
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
    const out = loginHtml() + formHtml();
    expect(out, "the wrapper must be .fld").toMatch(/<div class="fld"/);
    expect(out, "the control must be .field").toMatch(/<input class="field"/);
    expect(out).toMatch(/<select class="field"/);
    expect(out).toMatch(/<textarea class="field"/);
    expect(out, "no wrapper may still be called .field").not.toMatch(/<div class="field"/);
  });

  it("gives every error a retry", () => {
    const out = routed(createElement(ErrorState, { msg: "boom", onRetry: () => {} }));
    expect(out).toContain('role="alert"');
    expect(out).toContain("Retry");
  });

  it("emits no NaN and no literal 'undefined' into markup", () => {
    const out = html() + loginHtml() + formHtml();
    expect(out).not.toMatch(/NaN/);
    expect(out).not.toMatch(/(style|class)="[^"]*undefined/);
  });

  it("renders without a React warning", () => {
    html(); loginHtml(); formHtml();
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
    "ui/FitPanel.jsx", "ui/TailorTab.jsx", "pages/Board.jsx", "pages/Capture.jsx",
    "pages/JobDetail.jsx", "pages/Market.jsx", "pages/ProfilePage.jsx", "pages/PrintView.jsx",
    "pages/Login.jsx"]
    .map((f) => stripComments(read(f))).join("\n");

  it("does NOT let the kit's fixed .sheet near the printed résumé", () => {
    // THE ONE THAT WOULD HAVE BROKEN SOMETHING REAL. PrintView renders a
    // 816px letter-paper document that a browser prints to PDF. The kit's
    // .sheet is `position: fixed; bottom: 0` modal chrome at [data-kit]
    // weight — renaming carelessly turns a résumé into a dialog.
    expect(jsx, "no call site may still say sheet").not.toMatch(/className="sheet/);
    expect(allCss, "no rule may still target .sheet").not.toMatch(/(^|[\s,{])\.sheet[\s.,:{-]/m);
    expect(allCss).toMatch(/\.paper \{[^}]*max-width: 816px/);
    expect(allCss).toMatch(/\.paper \{[^}]*position: static|\.paper \{(?![^}]*position:)/);
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
    const board = read("pages/Board.jsx");
    expect(board).toContain('className="stattile on-canvas metric"');
    expect(board).toContain('className="stattile-label"');
    expect(board).toContain('className="stattile-value"');
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

  it("touches no storage key, table, query or function path", () => {
    // A restyle that renames a key is a data-loss bug wearing a stylesheet.
    for (const t of ["'jobs'", "'pipeline_events'", "'follow_ups'", "'target_profile'",
      "'watch_boards'", "'seen_postings'", "'drafts'", "'resume_master'", "'contacts'"]) {
      expect(jsx, `table ${t} must survive`).toContain(t);
    }
    for (const p of ["'/api/scan-boards'", "'/api/check-postings'", "'/api/parse-job'",
      "'/api/find-board'", "'/api/tailor'", "'/api/parse-resume'"]) {
      expect(jsx, `endpoint ${p} must survive`).toContain(p);
    }
    for (const r of ['path="/capture"', 'path="/jobs/:id"', 'path="/print/:id/:kind"',
      'path="/market"', 'path="/profile"']) {
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
});
