// Clarify on the shared kit — proved by rendering it, not by a green build.
//
// `vite build` does not prove this. It was green on a component that threw
// "nodeR is not defined" the moment it mounted and took three tools down.
// react-dom/server executes the whole component body in plain Node — no jsdom
// in this repo and none needed — so a restyle that broke a reference, a prop or
// a hook fails here rather than on a phone. It already caught one: a duplicate
// `className` attribute this migration introduced on the Inbound delete button,
// which esbuild silently resolves to the LAST one and would have dropped the
// mobile touch-target class in production.
//
// WHY <App embedded /> AND NOT <ClarifyRoot/> FOR THE MARKUP ASSERTIONS
// ClarifyRoot gates its first paint on `ready`, and that flag is only flipped
// by an effect — which renderToStaticMarkup does not run. So ClarifyRoot renders
// "" cold, by design. It is still rendered here to prove it does not throw; the
// surface underneath is rendered through <App embedded /> wrapped in the app's
// own ToastProvider, which is the same pair ClarifyRoot mounts.
//
// WHY THE GLOBALS BLOCK BELOW
// Clarify reads three browser APIs DURING RENDER, not in an effect:
// `window.location.hash` (the route, in a useState initializer), localStorage
// (the mirrored bearer, same), and the per-view stores in lib/store.js. Those
// are not data and they are not mocked here — they are the platform, and this
// file supplies the smallest possible one. The whole first half returns no
// fixture rows: every panel renders in its EMPTY or LOADING state, which is
// exactly the state a cold first paint is in. Setting window.location.hash
// before each render is also what lets one pass execute all eleven routable
// views.
//
// The LAST describe deliberately breaks that rule, and only there. Six controls
// in this app live behind data or component state a cold paint never produces,
// so "every button is on the kit" was true of them only by never having been
// looked at. That block feeds each surface what it needs (through `withStorage`,
// which restores the store afterwards) and walks it with the same rule.
//
// EVERY ASSERTION HERE WAS PROVED ABLE TO FAIL. Each named property was broken
// in the source once and this file was re-run: dropping data-kit off either
// root, un-classing the send-mode pill, un-classing one Settings button,
// putting a 9px back, putting 'Syne' back, re-adding a border next to a shadow,
// re-adding textTransform, replacing a domain hex with var(--accent), blanking
// the Live/Safe words, downgrading the client-error retry, changing the iOS
// 16px rule, renaming a localStorage key at ONE of its four sites, un-classing
// each of the six data-gated buttons, removing the calendar's MonthCalendar
// mount, and stripping each per-(file, class) pair from the file that authors
// it — all went red, and were restored.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Walk from an opening `{` to its matching `}`, honouring strings and template
// literals. Used by the className reader below and by the border/shadow scan.
const findClose = (src, i) => {
  let d = 0, q = null;
  while (i < src.length) {
    const c = src[i];
    if (q) { if (c === "\\") { i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; i++; continue; }
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) return i + 1; }
    i++;
  }
  return -1;
};

// Every class token a FILE puts on a className, whichever of the four shapes
// this app writes them in:
//   className="card"                      className={`card ${extra}`}
//   className={sel ? "btn md" : "btn sm"}  className={cls}
// This is what makes a per-view assertion mean "this view's own file renders
// it" rather than "something in the tree did". Three calendar entries used to
// be satisfied entirely by MonthCalendar, which lives in mission's file and is
// merely imported by CalendarView — renaming every t-label in CalendarView.jsx
// left the suite green.
const classTokens = (src) => {
  const out = new Set();
  let attrs = 0;
  const re = /className\s*=\s*/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let seg;
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      const end = src.indexOf(q, i + 1);
      if (end < 0) continue;
      seg = src.slice(i + 1, end);
      re.lastIndex = end + 1;
    } else if (src[i] === "{") {
      const end = findClose(src, i);
      if (end < 0) continue;
      seg = src.slice(i + 1, end - 1);
      re.lastIndex = end;
    } else continue;
    attrs++;
    let quoted = false;
    for (const s of seg.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
      quoted = true;
      const text = (s[1] ?? s[2] ?? s[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
      for (const t of text.split(/\s+/)) if (t) out.add(t);
    }
    // A bare `className={cls}` carries no literal to read; a plain attribute
    // (`className="card"`) arrives here already unquoted.
    if (!quoted) for (const t of seg.split(/\s+/)) if (t) out.add(t);
  }
  out.attrs = attrs;
  return out;
};

// ── the platform, minimally ─────────────────────────────────────────────────
const kv = new Map();
globalThis.localStorage = {
  getItem: (k) => (kv.has(k) ? kv.get(k) : null),
  setItem: (k, v) => kv.set(k, String(v)),
  removeItem: (k) => kv.delete(k),
  key: (i) => [...kv.keys()][i] ?? null,
  get length() { return kv.size; },
};
globalThis.sessionStorage = globalThis.localStorage;
// Some panels only ever draw their controls once they hold rows, and a few of
// those rows arrive synchronously out of localStorage in a useState
// initializer. This seeds exactly those keys for one render and puts the store
// back byte for byte, so every other test in this file stays COLD.
const withStorage = (entries, fn) => {
  const prior = new Map(kv);
  for (const [k, v] of Object.entries(entries)) kv.set(k, typeof v === "string" ? v : JSON.stringify(v));
  try { return fn(); } finally { kv.clear(); for (const [k, v] of prior) kv.set(k, v); }
};
globalThis.window = {
  location: { hash: "" },
  localStorage: globalThis.localStorage,
  sessionStorage: globalThis.sessionStorage,
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
};
globalThis.document = {
  hidden: false, addEventListener() {}, removeEventListener() {},
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {}, prepend() {} },
  body: { appendChild() {}, style: {} },
  documentElement: { style: {}, setAttribute() {}, classList: { add() {}, remove() {} } },
};

const { default: ClarifyRoot } = await import("../Root.jsx");
const { default: App } = await import("../App.jsx");
const { ToastProvider } = await import("../ui.jsx");
const { LoginScreen } = await import("../features/auth/LoginScreen.jsx");
const { QueueItem } = await import("../features/queue/QueueView.jsx");
const { ChainGroup, ChainLocationRow } = await import("../features/outreach/OutreachBoard.jsx");
const { QuickWinRow, ReasoningTrace } = await import("../features/analyst/AnalystView.jsx");

// The eleven hash routes App.jsx will accept (ROUTABLE_VIEWS).
const VIEWS = ["mission", "analytics", "inbound", "outreach", "queue", "sequences", "analyst", "clients", "dna", "calendar", "settings"];

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

const view = (v) => {
  globalThis.window.location.hash = `#/${v}`;
  return renderToStaticMarkup(createElement(ToastProvider, null, createElement(App, { embedded: true })));
};
const all = () => VIEWS.map((v) => [v, view(v)]);
const classesIn = (html) => {
  const set = new Set();
  for (const m of html.matchAll(/class="([^"]*)"/g)) m[1].split(/\s+/).forEach((c) => c && set.add(c));
  return set;
};

describe("Clarify renders on the kit", () => {
  it("mounts the tool root without throwing", () => {
    // Renders "" — ClarifyRoot's `ready` gate is an effect. What is proved is
    // that nothing on the way to that gate throws.
    expect(() => renderToStaticMarkup(createElement(ClarifyRoot))).not.toThrow();
  });

  it("renders every one of the eleven routable views cold", () => {
    for (const v of VIEWS) {
      expect(() => view(v), `#/${v} threw`).not.toThrow();
      expect(view(v).length, `#/${v} rendered almost nothing`).toBeGreaterThan(4000);
    }
  });

  it("opts into the kit on this app's own roots", () => {
    // Every rule in packages/ui/components.css is scoped [data-kit], so the kit
    // reaches nothing until the attribute is present. Clarify renders inside the
    // shell's tool slot, so putting it here reaches this app and nothing else.
    for (const [v, html] of all()) expect(html, `#/${v} did not opt in`).toMatch(/<div data-kit/);
    // The sign-in screen is a SEPARATE root — App returns it before the tree
    // above — so it carries its own attribute.
    expect(renderToStaticMarkup(createElement(LoginScreen, { onLogin() {} }))).toMatch(/<div data-kit/);
    // And never on anything that could contain another tool.
    expect(strip(read("App.jsx"))).not.toMatch(/document\.body[^\n]*data-kit/);
  });

  it("puts the kit's chrome primitives on every view", () => {
    // These are the pieces that render on all eleven routes: the tab strip, the
    // send-mode pill and its status light, the header actions, the phone dock.
    for (const [v, html] of all()) {
      const cls = classesIn(html);
      for (const c of ["seg", "seg-opt", "pill", "dotstatus", "btn", "dock-tab", "dock-label"]) {
        expect(cls.has(c), `#/${v} is missing the kit's .${c}`).toBe(true);
      }
    }
  });

  it("builds each panel out of the kit — in the panel's OWN file", () => {
    // Named per view AND per FILE, deliberately, and both halves are load-bearing.
    //
    // A union over all eleven renders would stay green while ten of the eleven
    // panels kept their hand-rolled tiles — that is the "one element out of
    // thirty" failure mode, and naming the view fixes it.
    //
    // Naming the view is not enough on its own, which is what the previous
    // version of this test got wrong. A view's markup includes everything it
    // IMPORTS, so a class contributed by somebody else's component satisfied
    // the entry for free: #/calendar's `stattile-label`, `t-label` and `card`
    // were all answered by MonthCalendar — which lives in
    // features/mission/MissionControl.jsx. Renaming every one of CalendarView's
    // seven `t-label`s, and stripping `card` off its local Card helper (which
    // un-cards all eight call sites), both left this suite green. So each entry
    // must now be AUTHORED in the named file and REACH the named view's markup.
    //
    // analytics / inbound / clients are absent on purpose: with no rows they
    // render an EmptyState or a skeleton, and the kit classes they use ride on
    // data this cold pass does not have.
    const OWN = {
      mission: {
        // Mission Control proper: the stat cards and the month grid.
        "features/mission/MissionControl.jsx": ["card", "stattile", "stattile-label", "stattile-value", "t-label", "t-title1", "t-cap", "t-foot"],
        // The engine panel it mounts underneath them.
        "features/mission/EnginePanel.jsx": ["pad-sm", "pressable", "t-call", "t-title2"],
      },
      // The outreach board is rendered inline by App.jsx; this is its toolbar
      // search box.
      outreach: { "App.jsx": ["field"] },
      queue: { "features/queue/QueueView.jsx": ["t-title2", "t-foot"] },
      sequences: { "features/sequences/SequencesView.jsx": ["t-title2", "t-foot"] },
      // The analyst sidebar: client name / context fields and their labels.
      analyst: { "features/analyst/AnalystView.jsx": ["field", "t-label"] },
      // Booking link card, the "Ready to book" / "Upcoming" headers. NOT
      // stattile-label — see the MonthCalendar test below for why.
      calendar: { "features/calendar/CalendarView.jsx": ["card", "t-label", "t-title2", "t-foot"] },
      settings: { "features/system/SettingsView.jsx": ["card", "field", "t-call", "t-cap", "t-foot", "t-label", "t-title2"] },
      // The DNA overlay's own labels — the canvas itself is left alone.
      dna: { "features/dna/DnaView.jsx": ["t-label"] },
    };
    let pairs = 0;
    for (const [v, byFile] of Object.entries(OWN)) {
      const rendered = classesIn(view(v));
      for (const [file, want] of Object.entries(byFile)) {
        const authored = classTokens(strip(read(...file.split("/"))));
        // Scan sanity: a className reader that quietly stopped matching would
        // make every `authored.has()` below fail rather than pass, but say so
        // in one line instead of eight.
        expect(authored.attrs, `${file}: the className scan read ${authored.attrs} attributes out of it — the scan is broken`).toBeGreaterThan(5);
        for (const c of want) {
          pairs++;
          expect(authored.has(c), `${file} puts nothing on the kit's .${c} — #/${v}'s claim to it would be riding on an imported component`).toBe(true);
          expect(rendered.has(c), `#/${v} renders nothing on the kit's .${c}`).toBe(true);
        }
      }
    }
    // Every pair above was individually mutation-proved: broken in its own file,
    // this test went red. Deleting one silently would undo that, so the count is
    // asserted too.
    expect(pairs, "the (file, class) table lost entries").toBe(31);
  });

  it("mounts mission's MonthCalendar on the calendar route", () => {
    // This is the assertion `calendar: [… "stattile-label" …]` was pretending to
    // be. CalendarView.jsx contains ZERO occurrences of that class — the month
    // grid is mission's component, imported here. What is true of #/calendar is
    // that it MOUNTS MonthCalendar, not that CalendarView builds a stat tile.
    // Stated that way it fails when the mount is removed, which is the only
    // thing the old entry was ever able to detect.
    const cal = strip(read("features", "calendar", "CalendarView.jsx"));
    expect(cal, "CalendarView stopped importing the month grid").toMatch(/import \{ MonthCalendar \} from "\.\.\/mission\/MissionControl\.jsx"/);
    expect(cal, "CalendarView stopped rendering the month grid").toMatch(/<MonthCalendar[^>]*cards=\{cards\}/);
    // …and it really is on screen: MonthCalendar's own stat tiles show up.
    expect(classesIn(view("calendar")).has("stattile-label"), "#/calendar no longer paints the month grid's tiles").toBe(true);
  });

  it("routes every button outside the DNA canvas through a kit surface", () => {
    // .btn is 34/44px, .pill is 34px, .dock-tab is the phone bar, .icon-btn
    // reaches 44pt through its ::after — these are the one-thumb targets this
    // app was writing out inline at five different paddings. The DNA tab is
    // excluded and asserted separately below: it is a full-bleed canvas whose
    // controls float on glass, and its zoom/fit HUD belongs to @cc/mind-canvas,
    // which this migration must not restyle.
    let total = 0;
    const offenders = [];
    for (const [v, html] of all()) {
      if (v === "dna") continue;
      for (const b of html.match(/<button[^>]*>/g) || []) {
        total++;
        if (!/class="[^"]*\b(btn|pill|seg-opt|dock-tab|icon-btn|card|cell)\b/.test(b)) offenders.push(`${v}: ${b.slice(0, 110)}`);
      }
    }
    expect(total, "no buttons were scanned — the walk is broken").toBeGreaterThan(60);
    expect(offenders, `buttons that opted out of the kit:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("leaves the mind canvas alone", () => {
    // The DNA tab renders @cc/mind-canvas, which is already migrated. Its own
    // classes must still be the ones it ships with, and nothing here may add a
    // kit class to them.
    const cls = classesIn(view("dna"));
    for (const c of ["dna-canvas", "dna-world", "dna-hudbtn"]) expect(cls.has(c), `the canvas lost .${c}`).toBe(true);
    expect(strip(read("features", "dna", "DnaView.jsx"))).toMatch(/<MindCanvas[\s\S]{0,600}?\/>/);
    expect(strip(read("features", "dna", "DnaView.jsx"))).not.toMatch(/<MindCanvas[^>]*className=/);
  });

  it("emits no NaN and no literal 'undefined' into markup", () => {
    for (const [v, html] of all()) {
      expect(html, `#/${v} rendered NaN`).not.toMatch(/NaN/);
      expect(html, `#/${v} rendered a literal undefined`).not.toMatch(/(style|class)="[^"]*undefined/);
    }
  });

  it("renders without a React warning", () => {
    all();
    const react = warnings.filter((w) => !w.startsWith("[@cc/"));
    expect(react, `React warned:\n${react.join("\n")}`).toEqual([]);
  });
});

// ── the language, read off the source ───────────────────────────────────────
const FILES = [
  ["theme.js", "theme.js"],
  ["App.jsx", "App.jsx"],
  ["Root.jsx", "Root.jsx"],
  ["components/LeadJourney.jsx", "components/LeadJourney.jsx"],
  ...["auth/LoginScreen", "outreach/OutreachCard", "outreach/OutreachBoard", "inbound/InboundView",
      "analyst/AnalystView", "clients/ClientsView", "system/GlobalAgent", "system/SettingsView",
      "system/AgentsView", "mission/MissionControl", "mission/EnginePanel", "calendar/CalendarView",
      "queue/QueueView", "sequences/SequencesView", "analytics/AnalyticsView", "dna/DnaView"]
    .map((p) => [`features/${p}.jsx`, `features/${p}.jsx`]),
].map(([name, p]) => [name, strip(read(...p.split("/")))]);

describe("Clarify obeys the language", () => {
  it("has no text under the 10.5px floor, ternaries and named sizes included", () => {
    // 194 sites were under it, the smallest at 8px, and several hid inside
    // ternaries where only one branch was in breach. Bare numbers count too:
    // EnginePanel writes `fontSize: 9.5` with no unit.
    let scanned = 0;
    for (const [name, src] of FILES) {
      const sizes = [];
      const refs = new Set();
      for (const m of src.matchAll(/fontSize:\s*([^,\n}]+)/g)) {
        const expr = m[1];
        for (const n of expr.matchAll(/[\d.]+/g)) {
          const v = Number(n[0]);
          if (Number.isFinite(v) && v > 0) sizes.push([`fontSize: ${expr.trim()}`, v]);
        }
        for (const p of expr.matchAll(/\.([A-Za-z_$][\w$]*)/g)) refs.add(p[1]);
        const bare = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(expr);
        if (bare) refs.add(bare[1]);
      }
      // …and the same value reached one indirection away, through a map or a
      // binding declared in the same file.
      for (const ref of refs) {
        const decl = new RegExp(`(^|[{,;(\\s])${ref}\\s*[:=]\\s*(-?[\\d.]+)(?![\\w.])`, "g");
        for (const m of src.matchAll(decl)) {
          const v = Number(m[2]);
          if (Number.isFinite(v) && v > 0) sizes.push([`fontSize → ${ref}: ${v}`, v]);
        }
      }
      // SVG draws its own text with an ATTRIBUTE, which the scan above cannot
      // see: the analyst's bar labels sat at 9 and the trend axis at 8.5.
      for (const m of src.matchAll(/fontSize="([\d.]+)"/g)) sizes.push([`fontSize="${m[1]}"`, Number(m[1])]);
      // And App.jsx ships a stylesheet as a template literal.
      for (const m of src.matchAll(/font-size:\s*([\d.]+)px/g)) sizes.push([`css font-size: ${m[1]}px`, Number(m[1])]);

      scanned += sizes.length;
      const under = sizes.filter(([, v]) => v < 10.5).map(([w]) => w);
      expect(under, `${name} is under the floor:\n${under.join("\n")}`).toEqual([]);
    }
    // Three of the files carry no type at all (Root.jsx is a mount shim); the
    // guard is that the walk as a whole found the hundreds of sizes it should.
    expect(scanned, "the size scan found almost nothing — it is broken").toBeGreaterThan(250);
  });

  it("puts no border and box-shadow on the same element", () => {
    // This walks braces rather than matching attributes, because several style
    // objects here are built as plain objects and spread (DnaView's GLASS
    // recipe was one, and it carried the violation onto every floating panel in
    // that view at once). `findClose` is the shared brace walker at the top.
    const BORDER =/(^|[^-\w])border(Top|Bottom|Left|Right)?:(?!\s*("none"|none\b))/;
    const SHADOW = /boxShadow:(?!\s*("none"|none\b))/;

    let scanned = 0;
    const offenders = [];
    for (const [name, src] of FILES) {
      let i = 0;
      for (;;) {
        const k = src.indexOf("style={{", i);
        if (k < 0) break;
        const end = findClose(src, k + 6);
        if (end < 0) break;
        const obj = src.slice(k, end);
        scanned++;
        if (BORDER.test(obj) && SHADOW.test(obj)) offenders.push(`${name}: ${obj.slice(0, 200).replace(/\s+/g, " ")}`);
        i = end;
      }
      // The spreadable recipes, which no `style={{` walk can see.
      for (const m of src.matchAll(/^const ([A-Z_][\w$]*) = \{([\s\S]*?)^\};/gm)) {
        scanned++;
        if (BORDER.test(m[2]) && SHADOW.test(m[2])) offenders.push(`${name}: const ${m[1]} = { … }`);
      }
    }
    expect(scanned, "no style objects were walked — the scan is broken").toBeGreaterThan(400);
    expect(offenders, `border + box-shadow on one element:\n${offenders.join("\n\n")}`).toEqual([]);

    // A .card already carries a shadow, so it may never also draw an outline.
    let carded = 0;
    for (const [name, src] of FILES) {
      for (const m of src.matchAll(/className\s*=\s*(?:"([^"]*)"|\{([^}]*)\})/g)) {
        const text = (m[1] ?? m[2] ?? "").replace(/[`'"]/g, " ");
        if (!/(^|\s)card($|\s)/.test(text)) continue;
        carded++;
        const lt = src.lastIndexOf("<", m.index);
        const tag = src.slice(lt, src.indexOf(">", m.index) + 1);
        expect(BORDER.test(tag), `${name}: a .card that also draws a border:\n${tag.slice(0, 220)}`).toBe(false);
      }
    }
    expect(carded, "no .card element was found — the scan is broken").toBeGreaterThan(15);
  });

  it("uses no decorative face — the platform stack only", () => {
    // Syne (display) and DM Mono were named at 200 call sites through
    // T.fontDisplay / T.fontMono and at eleven more as string literals.
    for (const [name, src] of FILES) {
      expect(src, `${name} still names a font family directly`).not.toMatch(/'Syne'|'DM Mono'|'Inter'/);
      const fams = [...src.matchAll(/fontFamily:\s*("[^"]+"|T\.font[A-Za-z]+)/g)].map((m) => m[1]);
      const bad = fams.filter((f) => !/^(T\.font(Display|Body|Mono)|"var\(--font-(body|display|mono)\)"|"inherit")$/.test(f));
      expect(bad, `${name}: ${bad.join(", ")}`).toEqual([]);
    }
    // …and the three tokens those call sites resolve through point at the
    // platform variables, which is the whole reason the swap was one edit.
    const theme = FILES.find(([n]) => n === "theme.js")[1];
    expect(theme).toMatch(/fontDisplay:\s*"var\(--font-body\)"/);
    expect(theme).toMatch(/fontBody:\s*"var\(--font-body\)"/);
    expect(theme).toMatch(/fontMono:\s*"var\(--font-mono\)"/);
    // The injected global stylesheet named Inter for html/body too.
    expect(FILES.find(([n]) => n === "App.jsx")[1]).toMatch(/html, body \{ margin: 0; font-family: var\(--font-body\); \}/);
  });

  it("uppercases only through .t-label", () => {
    for (const [name, src] of FILES) {
      expect(src, `${name} still uppercases by hand`).not.toMatch(/textTransform:\s*"uppercase"/);
    }
    // …and .t-label is genuinely doing that work rather than the app having
    // simply dropped every label.
    const users = FILES.filter(([, src]) => /className="t-label"/.test(src)).map(([n]) => n);
    expect(users.length, `only ${users.length} file uses .t-label`).toBeGreaterThan(10);
  });

  it("keeps the domain colours literal", () => {
    // These hexes ARE the data: pink means "replied", green means "meeting",
    // red means "ads live / critical". They are not a palette choice and they
    // do not become var(--accent).
    const theme = FILES.find(([n]) => n === "theme.js")[1];
    for (const hex of ["#F472B6", "#3ECF8E", "#F87171", "#F5B84D", "#6EA8FE", "#A78BFA"]) {
      expect(theme, `theme.js lost ${hex}`).toContain(hex);
    }
    // The Kanban columns and the reply-triage buckets still read them.
    expect(FILES.find(([n]) => n === "App.jsx")[1]).toMatch(/color: T\.pink/);
    expect(FILES.find(([n]) => n.endsWith("OutreachBoard.jsx"))[1]).toMatch(/color: T\.green/);
  });

  it("never signals a state by colour alone", () => {
    // The two states this app is dangerous about: whether sends go to real
    // prospects, and whether the outbound engine is running. Both spell it out.
    const app = FILES.find(([n]) => n === "App.jsx")[1];
    expect(app).toContain('live ? "Live sending" : "Safe mode"');
    const engine = FILES.find(([n]) => n.endsWith("EnginePanel.jsx"))[1];
    expect(engine).toMatch(/armed: \{ c: T\.green, t: "Armed" \}/);
    expect(engine).toMatch(/Agent engine|\{pill\.t\}/);
  });

  it("gives errors a retry and empty states a next step", () => {
    const clients = FILES.find(([n]) => n.endsWith("ClientsView.jsx"))[1];
    expect(clients, "the client load error lost its retry").toMatch(/onClick=\{load\}[^>]*className="btn sm danger"/);
    const app = FILES.find(([n]) => n === "App.jsx")[1];
    expect(app).toContain("Nothing has reached this stage yet — run Find Prospects, or pick another status above.");
    const cal = FILES.find(([n]) => n.endsWith("CalendarView.jsx"))[1];
    expect(cal).toContain("No meetings booked yet — book one from a replied thread on the left.");
  });

  it("preserves every iOS / safe-area / keyboard workaround verbatim", () => {
    const app = read("App.jsx");
    // The bottom bar's own inset, and the note that says why it may not move.
    expect(app).toContain("Canonical bottom-bar geometry — must stay identical to ZTS, Runway and");
    expect(app).toContain('padding: "4px 6px max(10px, calc(6px + var(--safe-bottom, 0px)))"');
    // The 16px input rule that stops iOS Safari zooming the viewport on focus —
    // this is why the kit's 15px .field is overridden on phones, not adopted.
    expect(app).toContain("Every input gets a real 16px+ so iOS Safari doesn't zoom the page on focus");
    expect(app).toContain("input, textarea, select { font-size: 16px !important; }");
    // Standalone PWA notch clearance, the floating layers that clear the bar,
    // and the pull-to-refresh suppression.
    expect(app).toContain("@media (display-mode: standalone)");
    expect(app).toContain("padding-top: env(safe-area-inset-top) !important");
    expect(app).toContain(".co-agent-root { bottom: calc(68px + var(--safe-bottom)) !important;");
    expect(app).toContain("body { overscroll-behavior-y: contain; }");
    // DNA's dvh height math and its lift of the canvas HUD.
    const dna = read("features", "dna", "DnaView.jsx");
    expect(dna).toContain("height: calc(100dvh - 112px - var(--safe-bottom));");
    expect(dna).toContain(".dna-view .dna-canvas ~ div:last-of-type { bottom: 78px !important; }");
    // The one time-picker that must stay wide enough for the meridiem.
    expect(dna).toContain('wide enough for "06:00 PM" — Chromium clips the meridiem otherwise');
  });

  it("touches no storage key, table, route or function path — at any of its sites", () => {
    // DESIGN.md §7 calls these untouchable, and this guard used to check them
    // with toContain(), which only proves ONE site survived. Every key here has
    // several: "clarify_token" is written, read and cleared at four places in
    // App.jsx, and app_settings is queried three times in EnginePanel. Renaming
    // three of four left the old assertion green.
    //
    // That is not a hypothetical failure mode for this repo — it has already
    // shipped a patch that landed in 3 of 4 places. So the guard counts, and
    // says both numbers when it trips.
    const SITES = [
      ["App.jsx", '"clarify_token"', 4],                                  // useState seed, persistSession, session-miss clear, signOut
      ["App.jsx", '"clarify_refresh"', 3],                                // persistSession, session-miss clear, signOut
      ["App.jsx", '"outreach_focus"', 3],                                 // consume, delete, and the palette's set
      ["App.jsx", 'const ROUTABLE_VIEWS = ["mission", "analytics", "inbound", "outreach", "queue", "sequences", "analyst", "clients", "dna", "calendar", "settings"]', 1],
      ["features/mission/EnginePanel.jsx", 'supabase.from("app_settings")', 3],
      ["features/mission/EnginePanel.jsx", '"/.netlify/functions/queue-execute"', 1],
      ["features/inbound/InboundView.jsx", "/inbound_leads?order=created_at.desc&limit=200", 1],
    ];
    for (const [name, needle, want] of SITES) {
      const entry = FILES.find(([n]) => n === name);
      expect(entry, `${name} is not in the FILES table — this guard stopped reading it`).toBeTruthy();
      const got = entry[1].split(needle).length - 1;
      expect(got, `${name}: \`${needle}\` occurs ${got}× — it must occur ${want}×. A partial rename is exactly how this repo shipped a patch that landed in 3 of 4 places.`).toBe(want);
    }
    // Scan sanity: the table itself must not quietly shrink, and no entry may
    // sit at zero expected sites (which would assert nothing at all).
    expect(SITES.length, "the untouchables table lost rows").toBe(7);
    expect(SITES.filter(([, , n]) => n > 0).length, "an untouchable is guarded at zero sites").toBe(SITES.length);
  });
});

// ── the surfaces a cold render cannot reach ─────────────────────────────────
//
// The button walk above proves that every button ON SCREEN carries a kit
// surface — but "on screen" is an empty-state first paint, and six hand-rolled
// buttons were sitting behind data or component state it never produces:
//
//   analyst   the delete-✕ on a saved analysis   (needs rows in localStorage)
//   analyst   the 18px quick-win tick box        (needs a model response)
//   analyst   the reasoning-trace disclosure     (needs a model response)
//   outreach  the chain expand toggle            (needs a multi-location chain)
//   outreach  the reject-location ✕              (needs that group expanded)
//   queue     the draft preview body             (needs a queued draft row)
//
// So the coverage claim was true only by accident. This block feeds each of
// those surfaces what it needs and walks its buttons with the same rule. Three
// of them are component-state-gated rather than data-gated, and their rows are
// now their own exported components so a render can reach them at all.
describe("Clarify's data-gated surfaces are on the kit too", () => {
  const KIT = /class="[^"]*\b(btn|pill|seg-opt|dock-tab|icon-btn|card|cell)\b/;
  const paint = (el) => renderToStaticMarkup(createElement(ToastProvider, null, el));
  const walkButtons = (label, html, atLeast) => {
    const found = html.match(/<button[^>]*>/g) || [];
    expect(found.length, `${label}: no button was scanned — the surface did not render, so this proves nothing`).toBeGreaterThanOrEqual(atLeast);
    const offenders = found.filter((b) => !KIT.test(b));
    expect(offenders, `${label}: buttons that opted out of the kit:\n${offenders.join("\n")}`).toEqual([]);
    return found.length;
  };

  const CHAIN_CARD = (id, name) => ({
    id, status: "prospected", created_at: "2026-07-20T10:00:00.000Z",
    prospect: { business_name: name, address: "2100 N Milwaukee Ave, Chicago, IL 60647", category: "dentist", website: "https://example.com", ads_detected: true },
    contact: { name: "Dana Reyes", email: "dana@example.com", email_confidence_score: 80 },
  });

  it("puts the saved-analysis row's delete on the kit", () => {
    // savedAnalyses comes out of localStorage in a useState initializer, so it
    // is the one of the six that a full-app render can reach — given the rows.
    const saves = [{ id: Date.now() - 7200000, clientName: "Northside Dental", clientContext: "Chicago dentist", signal: "needs_attention", savedAt: "2026-07-30T10:00:00.000Z", analysis: null, csvMetrics: null, messages: [], uploads: {} }];
    const html = withStorage({ sm_analyst_saves: saves }, () => view("analyst"));
    expect(html, "the saved-analysis list did not render").toContain("Northside Dental");
    walkButtons("#/analyst with saved analyses", html, 12);
  });

  it("puts the quick-win tick box on the kit", () => {
    const html = paint(createElement(QuickWinRow, {
      win: { action: "Pause the two campaigns with zero conversions", effortLevel: "low", estimatedImpact: "frees ~$1.2k/mo" },
      done: false, last: true, onToggle() {},
    }));
    expect(html, "the quick win's text did not render").toContain("zero conversions");
    walkButtons("QuickWinRow", html, 1);
    // …and in its checked state, which draws a different border.
    walkButtons("QuickWinRow (done)", paint(createElement(QuickWinRow, { win: "Add sitelinks", done: true, last: true, onToggle() {} })), 1);
  });

  it("puts the reasoning-trace disclosure on the kit", () => {
    const html = paint(createElement(ReasoningTrace, { trace: "Compared spend against last period, then ranked by wasted cost." }));
    walkButtons("ReasoningTrace", html, 1);
  });

  it("puts both of the chain group's controls on the kit", () => {
    const html = paint(createElement(ChainGroup, {
      primary: CHAIN_CARD("chain-1", "Northside Dental — Wicker Park"),
      rest: [CHAIN_CARD("chain-2", "Northside Dental — Logan Square")],
      chainName: "Northside Dental",
      toneMemory: [],
      onStatusChange() {}, onDraftRegenerate() {}, onToneFeedback() {}, onEnrich() {}, onMarkSent() {},
      isSelected: false, onToggleSelect() {},
    }));
    expect(html, "the chain header did not render").toContain("2 locations");
    expect(html, "the expand toggle did not render").toContain("+ 1 more");
    // One: the toggle. A collapsed OutreachCard draws no button of its own.
    walkButtons("ChainGroup (collapsed)", html, 1);
    // The sibling rows only exist while the group is expanded — that is
    // component state, so the row is its own component and is rendered here.
    const row = paint(createElement(ChainLocationRow, { card: CHAIN_CARD("chain-2", "Northside Dental — Logan Square"), onStatusChange() {} }));
    expect(row, "the chain location row did not render").toContain("Logan Square");
    walkButtons("ChainLocationRow", row, 1);
  });

  it("puts the queue item's draft preview on the kit", () => {
    const msg = {
      id: "msg-1", outreach_id: "out-1", kind: "followup", direction: "outbound", status: "draft",
      subject: "Following up on your Google Ads", body: "Quick note — I pulled your search terms report.",
      created_at: "2026-07-30T09:00:00.000Z", meta: { step_name: "Step 2 — nudge", personalized: true },
      outreach: { prospect: { business_name: "Northside Dental" }, contact: { email: "dana@example.com" } },
    };
    const collapsed = paint(createElement(QueueItem, { msg, onDone() {} }));
    expect(collapsed, "the collapsed draft preview did not render").toContain("Following up on your Google Ads");
    // Preview + Approve & Send + Edit first + Reject.
    walkButtons("QueueItem (collapsed)", collapsed, 4);
  });

  it("leaves the cold render cold", () => {
    // withStorage must put the platform back exactly, or every test above it in
    // this file is quietly running against seeded data.
    expect(globalThis.localStorage.getItem("sm_analyst_saves"), "withStorage leaked a seeded key").toBe(null);
  });
});
