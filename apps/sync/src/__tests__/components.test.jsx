// ─── EVERY component in this app, mounted cold ────────────────────────────────
//
// render.test.jsx next door renders the app from its two entry points and
// asserts on the markup that comes out. That is worth having and it is not
// coverage: of the components exported from apps/sync/src, exactly TEN were
// ever executed by the whole suite — App, Root, Onboarding, Sidebar,
// ConsolePage, CommandK, VoiceOrb, VoiceProvider, PortalLayer, Button and
// IconButton. A reviewer put `throw new Error("MUTANT")` at the top of each of
// the others, one at a time, and the suite stayed GREEN for all of them:
// DayPage, QueuePage, BriefPage, MindPage, MemoryPage, VoicePage,
// SettingsSheet, PentagonPanel, Dock, and twenty-one of the kit's own. Weaker
// still: replacing MindPage's body with `return null`, renaming QueuePage's
// export away, and deleting the `<Dock>` and `<SettingsSheet>` elements from
// App.jsx were all green too.
//
// That is the exact shape of the failure that took this repo down in
// production: `vite build` green, `vitest run` green, and a component that
// throws the instant it mounts. A build cannot catch a free variable and a grep
// cannot either. Rendering it once can.
//
// Three properties this file is built around:
//
//   1. THE TABLE IS CHECKED AGAINST THE MODULES, not maintained by hand. Every
//      .jsx under src/ is imported and every exported component is discovered;
//      a component with no case here FAILS the suite. Adding a component and
//      forgetting to mount it is the way this hole reopens, so it is the thing
//      that is made impossible.
//   2. EVERY CASE ASSERTS ON OUTPUT. `expect(...).not.toThrow()` alone is
//      satisfied by `return null`, which is why that mutation was green. Each
//      case names strings only that component emits.
//   3. THE STORE IS REAL. Pages are mounted twice — once against a cold install
//      (the empty states) and once against a full day's data (the loaded
//      states), because most of the body of a page is behind `if (!x.length)`.
//
// createPortal is the one thing that cannot survive contact with
// react-dom/server ("Portals are not currently supported by the server
// renderer"), so it is redirected to render in place. That is a change to WHERE
// the markup lands, not to WHETHER the component body runs — and the body is
// what this file exists to run. Sheet, ToastHost, SettingsSheet and CommandK
// are unreachable otherwise, and all four are on the list above.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal();
  const inPlace = (children) => children;
  return { ...actual, createPortal: inPlace, default: { ...(actual.default || {}), createPortal: inPlace } };
});

import { installBrowserEnv } from "../test/env.js";
installBrowserEnv();
// PortalLayer and Sheet both name document.body as the portal target. The
// redirect above never reads it, but the expression is still evaluated.
if (!globalThis.document.body) globalThis.document.body = { nodeType: 1 };
// VoiceOrb reads getComputedStyle for the orb's three gradient stops. That is
// inside an effect, which the server renderer never fires — the shim exists so
// that a future move of it into render() surfaces as a failed assertion rather
// than as a crash in the harness.
if (!globalThis.getComputedStyle) globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..");
const rel = (p) => relative(SRC, p).split(sep).join("/");
const readSource = (...p) => readFileSync(join(SRC, ...p), "utf8");

const h = createElement;
const render = (node) => renderToStaticMarkup(node);

/* ── the app, imported once ────────────────────────────────────────────────── */
const K = await import("../ui/kit.jsx");
const store = await import("../data/store.js");
const { VoiceProvider } = await import("../voice/VoiceProvider.jsx");
const { default: MarkC } = await import("../chrome/Mark.jsx");
const { default: OnboardingC } = await import("../chrome/Onboarding.jsx");
const { default: CommandKC } = await import("../chrome/CommandK.jsx");
const { default: SettingsSheetC } = await import("../chrome/SettingsSheet.jsx");
const { default: PentagonPanelC } = await import("../chrome/PentagonPanel.jsx");
const { SubNav: SubNavC, Dock: DockC } = await import("../chrome/Shell.jsx");
const { default: VoiceOrbC } = await import("../voice/VoiceOrb.jsx");
const { default: AppC } = await import("../App.jsx");
const { default: RootC } = await import("../Root.jsx");
const P = {
  ConsolePage: (await import("../pages/ConsolePage.jsx")).default,
  DayPage: (await import("../pages/DayPage.jsx")).default,
  QueuePage: (await import("../pages/QueuePage.jsx")).default,
  BriefPage: (await import("../pages/BriefPage.jsx")).default,
  MindPage: (await import("../pages/MindPage.jsx")).default,
  MemoryPage: (await import("../pages/MemoryPage.jsx")).default,
  VoicePage: (await import("../pages/VoicePage.jsx")).default,
};

/* ── the world a page wakes up in ──────────────────────────────────────────── */
// Not fixtures for their own sake: every collection below is read by at least
// one page, and every one of them is empty on a cold install — which is the
// only branch the suite reached before this file existed.
const D = new Date();
const DAY = `${D.getFullYear()}-${String(D.getMonth() + 1).padStart(2, "0")}-${String(D.getDate()).padStart(2, "0")}`;
const T = Date.now();

const write = (patch) => store.importState(JSON.stringify({ ...store.emptyState(), ...patch }));

function coldInstall() {
  const base = store.emptyState();
  write({ settings: { ...base.settings, onboarded: true } });
}

function loadedInstall() {
  const base = store.emptyState();
  write({
    settings: { ...base.settings, onboarded: true, apiKey: "sk-ant-test", handsFree: true, ambient: true, speak: true },
    profile: {
      ...base.profile,
      name: "Cameron", role: "Operator",
      ventures: [
        { key: "clarify", name: "Clarify Paid Search", tone: "var(--amber)", note: "Agency" },
        { key: "zts", name: "Zero To Secure", tone: "var(--green)", note: "DTC" },
      ],
      directives: ["Pressure-test, don't validate."],
    },
    blocks: [
      { id: "b1", day: DAY, start: 9 * 60, mins: 90, title: "Deep work — proposal", kind: "deep", status: "planned", venture: "clarify" },
      { id: "b2", day: DAY, start: 11 * 60, mins: 30, title: "Standup", kind: "meeting", status: "done", doneAt: T, venture: "zts" },
      { id: "b3", day: DAY, start: 14 * 60, mins: 25, title: "Short block", kind: "admin", status: "planned" },
    ],
    tasks: [
      { id: "t1", title: "Send the retainer proposal", status: "open", priority: "high", venture: "clarify", due: DAY, createdAt: T, notes: "Include the case study." },
      { id: "t2", title: "Order stock", status: "done", priority: "normal", venture: "zts", createdAt: T, doneAt: T },
      { id: "t3", title: "Book the courier", status: "open", priority: "low", createdAt: T },
    ],
    followups: [
      { id: "f1", who: "Supplier", what: "Quote for 500 units", due: DAY, status: "open", createdAt: T },
      { id: "f2", who: "Client", what: "Signed SOW", due: "2020-01-01", status: "open", createdAt: T },
      { id: "f3", who: "Old thread", what: "Closed", status: "done", createdAt: T },
    ],
    notes: [{ id: "n1", text: "The 11am usually runs long.", createdAt: T }],
    memory: [{ id: "m1", fact: "Prefers mornings for deep work.", kind: "fact", createdAt: T }],
    decisions: [{ id: "d1", text: "Dropped the second SKU.", why: "Margin", createdAt: T }],
    drafts: [{ id: "dr1", title: "Outreach — dental", kind: "email", body: "Hi there,\n\nQuick one.", createdAt: T }],
    // endsAt is NOT optional. start_focus (agent/tools.js:735) writes
    // { id, label, mins, startedAt, endsAt, blockId }, and FocusBar counts down
    // from endsAt. Omitting it made leftMs NaN, so this fixture rendered
    // "NaN:NaN left" and strokeDasharray="NaN …" — and the test passed anyway,
    // because it only asserted that the word "focusbar" appeared. A fixture that
    // does not match the shape the app actually stores proves nothing.
    focus: { id: "s1", label: "Proposal", startedAt: T - 12 * 60000, mins: 50, endsAt: T + 38 * 60000, blockId: "b1" },
    ledger: [
      { id: "l1", action: "add_task", title: "Added — Send the retainer proposal", detail: "Queue", at: T, undo: { tasks: [] }, undone: false, remote: null },
      { id: "l2", action: "plan_day", title: "Planned the day", detail: "3 blocks", at: T, undo: null, undone: true, remote: null },
    ],
    turns: [
      { id: "u1", role: "user", text: "Plan my day", at: T - 60000 },
      {
        id: "a1", role: "sync", at: T - 50000,
        text: "Three blocks. **Proposal** first, then `standup`.",
        acts: [
          { id: "x1", title: "Blocked 9:00–10:30", detail: "Deep work", status: "ok", ledgerId: "l1" },
          { id: "x2", verb: "Emailing the supplier", detail: "Pending", status: "pending" },
          { id: "x3", title: "Calendar write", detail: "Refused", status: "failed" },
        ],
      },
    ],
    history: [{ role: "user", content: "Plan my day" }],
    briefs: [
      { id: "br1", day: DAY, kind: "morning", body: "One thing matters today.", createdAt: T },
      { id: "br2", day: DAY, kind: "evening", body: "Two closed, one slipped.", createdAt: T },
      { id: "br3", day: "2020-01-01", kind: "morning", body: "Earlier.", createdAt: T },
    ],
    usage: { calls: 12, in: 40000, out: 9000, cost: 0.42 },
  });
}

/* ── discovery: what actually has to be mounted ────────────────────────────── */
function jsxFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") walk(p); }
      else if (/\.jsx$/.test(e.name)) out.push(p);
    }
  })(SRC);
  return out.sort();
}

/** A React component: a capitalised function, or a forwardRef/memo object. */
function isComponent(v, name) {
  if (typeof v === "function") return /^[A-Z]/.test(name || "");
  if (v && typeof v === "object" && typeof v.$$typeof === "symbol")
    return /forward_ref|memo/.test(String(v.$$typeof));
  return false;
}

const files = jsxFiles();
const discovered = [];
// Dedupe by function IDENTITY across every module, not per module: `export
// default Mark` sits beside `export function Mark`, and ui/kit.jsx re-exports
// three of ui/icons.jsx's glyphs. Those are one component each, and mounting a
// component twice under two names proves nothing the first mount did not.
const seen = new Set();
for (const file of files) {
  const mod = await import(/* @vite-ignore */ file);
  for (const [name, v] of Object.entries(mod)) {
    const label = name === "default" ? (v?.name || v?.render?.name || "default") : name;
    if (!isComponent(v, label)) continue;
    if (seen.has(v)) continue;                       // `export default Mark` beside `export function Mark`
    seen.add(v);
    discovered.push({ key: `${rel(file)}#${label}`, file: rel(file), name: label, fn: v });
  }
}

/* ── the harness ───────────────────────────────────────────────────────────── */
// Pages read the voice loop and the toast host out of context. Both are the
// real components rather than stubs, so a page is exercised against the
// providers it actually ships with.
const inApp = (node) => h(K.ToastHost, null, h(VoiceProvider, null, node));

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

/**
 * One mount per component. `must` is not decoration: `.not.toThrow()` on its
 * own is satisfied by `return null`, which is exactly the mutation that stayed
 * green on MindPage. Each entry names markup only that component emits.
 */
const CASES = {
  /* ── the shared kit ────────────────────────────────────────────────────── */
  "ui/kit.jsx#PortalLayer": { el: () => h(K.PortalLayer, null, h("i", { className: "probe" })), must: ['class="sy-scope"', 'class="sy-root sy-layer"', 'class="probe"'] },
  "ui/kit.jsx#Card": { el: () => h(K.Card, { pad: "lg", onClick: () => {} }, "body"), must: ['class="card pad-lg pressable"', 'role="button"'] },
  "ui/kit.jsx#CollapsibleCard": {
    el: () => h(K.CollapsibleCard, { title: "Ledger", leading: h("i", null), trailing: h("b", null, "3"), collapsed: false, onToggle: () => {} }, "rows"),
    must: ['aria-expanded="true"', 'class="t-head"', 'class="expand open"', "Ledger"],
  },
  "ui/kit.jsx#Expand": { el: () => h(K.Expand, { open: true }, "inner"), must: ['class="expand open"', "inner"] },
  "ui/kit.jsx#SectionHeader": { el: () => h(K.SectionHeader, { title: "Today", trailing: "See all", onTrailing: () => {} }), must: ['class="sec-head"', 'class="sec-link"', "See all"] },
  "ui/kit.jsx#CellGroup": { el: () => h(K.CellGroup, { className: "stagger" }, h("i", null)), must: ['class="cellgroup stagger"'] },
  "ui/kit.jsx#Cell": {
    el: () => h(K.Cell, { leading: h("i", null), leadingTone: "var(--green)", title: "Task", sub: "sub", value: "2", trailing: h("b", null), chevron: true, onClick: () => {}, done: true }),
    must: ['class="cell tappable has-leading done"', 'class="cell-leading"', 'class="cell-chevron"', "color-mix(in srgb, var(--green) 14%, transparent)"],
  },
  "ui/kit.jsx#Num": { el: () => h(K.Num, { v: 1234 }), must: ["1,234"] },
  "ui/kit.jsx#StatTile": { el: () => h(K.StatTile, { value: "3", label: "open", delta: "+1", selected: true, onClick: () => {} }), must: ['class="stattile tappable selected"', 'class="stattile-delta"'] },
  "ui/kit.jsx#Dot": { el: () => h(K.Dot, { tone: "var(--green)", pulse: true, size: 9 }), must: ['class="dotstatus pulse"', "width:9px"] },
  "ui/kit.jsx#Status": { el: () => h(K.Status, { state: "live", title: "t" }), must: ["Live", 'class="t-cap"', 'class="dotstatus pulse"'] },
  "ui/kit.jsx#Button": { el: () => h(K.Button, { kind: "primary", size: "lg", full: true }, "Start"), must: ['class="btn primary lg full"', "Start"] },
  "ui/kit.jsx#IconButton": { el: () => h(K.IconButton, { on: true, label: "Mic" }, h("i", null)), must: ['class="icon-btn on"', 'aria-label="Mic"'] },
  "ui/kit.jsx#Pill": { el: () => h(K.Pill, { active: true }, "Open"), must: ['class="pill active"', "Open"] },
  "ui/kit.jsx#PillRow": {
    el: () => h(K.PillRow, { options: [{ key: "a", label: "All", count: 3 }, { key: "b", label: "Open" }], value: "a", onChange: () => {} }),
    must: ['class="pillrow"', 'class="pill active"', 'class="t-num"'],
  },
  "ui/kit.jsx#Segmented": {
    el: () => h(K.Segmented, { options: [{ key: "m", label: "Morning" }, { key: "e", label: "Debrief", sub: "2" }], value: "e", onChange: () => {} }),
    must: ['class="seg"', 'class="seg-thumb"', 'class="seg-opt active"', 'aria-pressed="true"'],
  },
  "ui/kit.jsx#Switch": { el: () => h(K.Switch, { on: true, small: true, label: "Speak", onToggle: () => {} }), must: ['class="switch on small"', 'aria-checked="true"', 'class="switch-knob"'] },
  "ui/kit.jsx#SwitchRow": { el: () => h(K.SwitchRow, { title: "Speak replies", sub: "out loud", on: false, onToggle: () => {} }), must: ['role="switch"', "Speak replies", 'class="cell-sub"'] },
  "ui/kit.jsx#Field": { el: () => h(K.Field, { defaultValue: "x", className: "wide", placeholder: "Name" }), must: ["<input", 'class="field wide"', 'placeholder="Name"'] },
  "ui/kit.jsx#TextArea": { el: () => h(K.TextArea, { defaultValue: "x", rows: 3 }), must: ["<textarea", 'class="field"', 'rows="3"'] },
  "ui/kit.jsx#Spinner": { el: () => h(K.Spinner, { size: 24 }), must: ['class="spinner"', 'role="status"', "width:24px"] },
  "ui/kit.jsx#Thinking": { el: () => h(K.Thinking), must: ['class="think"', 'class="td"', 'aria-label="Working"'] },
  "ui/kit.jsx#SkLine": { el: () => h(K.SkLine, { w: "40" }), must: ['class="sk sk-line w40"'] },
  "ui/kit.jsx#SkCard": { el: () => h(K.SkCard, { lines: 3, pad: "sm" }), must: ['class="card pad-sm"', 'class="sk sk-big"', 'class="sk sk-line w40"'] },
  "ui/kit.jsx#SkPage": { el: () => h(K.SkPage, { cards: 2 }), must: ['aria-busy="true"', 'class="sk sk-big"'] },
  "ui/kit.jsx#EmptyState": {
    el: () => h(K.EmptyState, { icon: h("i", null), title: "Nothing yet", sub: "Ask SYNC", action: h(K.Button, null, "Go") }),
    must: ['class="empty"', 'class="empty-icon"', 'class="empty-title"', 'class="empty-sub"', "Go"],
  },
  "ui/kit.jsx#ErrorState": {
    // §4.7: an error always carries a way forward — there are no dead ends.
    el: () => h(K.ErrorState, { detail: "Network", onRetry: () => {} }),
    must: ["go through", "Network", "Try again", 'class="btn tinted sm"'],
  },
  "ui/kit.jsx#Sheet": {
    el: () => h(K.Sheet, { title: "Settings", onClose: () => {}, headTrailing: h("b", null, "hi"), footer: h(K.Button, null, "Save") }, "body"),
    must: ['class="sheet-scrim"', 'class="sheet"', 'role="dialog"', 'class="sheet-grab"', 'class="sheet-head"', 'class="sheet-body scroll-thin"', 'class="sheet-foot"', "Save"],
  },
  "ui/kit.jsx#ToastHost": { el: () => h(K.ToastHost, null, h("i", { className: "probe" })), must: ['class="toasts"', 'aria-live="polite"', 'class="probe"'] },
  "ui/kit.jsx#PageHead": { el: () => h(K.PageHead, { title: "Queue", sub: "3 open", trailing: h("b", null, "x") }), must: ['class="content-head"', 'class="t-ltitle"', 'class="t-foot"', "Queue"] },
  "ui/kit.jsx#Grid": { el: () => h(K.Grid, { min: 220, gap: 10 }, h("i", { className: "probe" })), must: ["repeat(auto-fill, minmax(min(220px, 100%), 1fr))", 'class="probe"'] },

  /* ── chrome ────────────────────────────────────────────────────────────── */
  "chrome/Mark.jsx#Mark": { el: () => h(MarkC, { size: 30 }), must: ["<svg", 'width="30"', "<circle"] },
  "chrome/Onboarding.jsx#Onboarding": { el: () => h(OnboardingC, { onDone: () => {} }), must: ['class="entrance-card"', 'class="btn primary lg full"'] },
  "chrome/CommandK.jsx#CommandK": {
    // open, so the palette body renders rather than taking the
    // `if (!open) return null` shortcut, which is all any previous run of this
    // component ever executed.
    el: () => h(CommandKC, {
      open: true, onClose: () => {}, setPage: () => {}, onSettings: () => {},
      voice: { phase: "idle", busy: false, stop: () => {}, send: () => {}, toggleAmbient: () => {}, sttSupported: true },
    }),
    must: ['class="cmdk-scrim"', 'class="cmdk"', 'class="cmdk-input"', "cmdk-item"],
  },
  "chrome/PentagonPanel.jsx#PentagonPanel": { el: () => h(PentagonPanelC), must: ["Pentagon", 'class="sec-head"'] },
  "chrome/SettingsSheet.jsx#SettingsSheet": {
    el: () => inApp(h(SettingsSheetC, { onClose: () => {} })),
    must: ['role="dialog"', 'class="sheet-head"', 'class="field"', "Pentagon"],
  },
  // The horizontal sub-nav that replaced the 232px vertical rail. The needles
  // are the four things the move had to keep as well as the six destinations:
  // the kit's segmented control with a lit pill, the phase readout the rail's
  // foot used to carry, the microphone and the gear.
  "chrome/Shell.jsx#SubNav": {
    el: () => inApp(h(SubNavC, { page: "day", setPage: () => {}, onSettings: () => {}, onPalette: () => {} })),
    must: [
      // <nav aria-label="Main"> — the landmark the rail was. A tablist inside
      // a plain <div> would have deleted SYNC's navigation for anyone moving
      // by landmark, which is a silent regression a screenshot cannot show.
      '<nav class="sy-nav" aria-label="Main">', 'role="tablist"',
      'class="seg sy-nav-tabs"', 'class="seg-opt active"', 'role="tab"', 'aria-selected="true"',
      'class="sy-nav-actions"', "Standing by", "⌘K", 'aria-label="Settings"',
    ],
    // The microphone reports which way it is pointing, so its label is the
    // fixture's own state rather than a constant — and the count beside a
    // destination is the rail's `.side-badge`, which only exists once there is
    // something to count.
    cold: ['aria-label="Listen for the wake word"', 'aria-label="Mute SYNC"'],
    loaded: ['aria-label="Stop listening"', 'class="sy-nav-badge t-num"'],
  },
  "chrome/Shell.jsx#Dock": {
    el: () => inApp(h(DockC, { page: "console", setPage: () => {} })),
    must: ['class="dock pentagon-dock"', 'class="dock-tab active"', 'class="dock-icon"', 'class="dock-label"'],
  },

  /* ── voice ─────────────────────────────────────────────────────────────── */
  "voice/VoiceOrb.jsx#VoiceOrb": { el: () => h(VoiceOrbC, { size: 140, state: "listening", level: 0.4, onClick: () => {} }), must: ['class="orb-wrap"', 'data-state="listening"', "<canvas", 'class="orb-ring"'] },
  "voice/VoiceProvider.jsx#VoiceProvider": { el: () => h(VoiceProvider, null, h("i", { className: "probe" })), must: ['class="probe"'] },

  /* ── pages ─────────────────────────────────────────────────────────────── */
  // `console-bar` is deliberately NOT a needle here. It is the phone-only copy
  // of three controls the sub-nav carries on every wider screen, and this table
  // renders at the desktop breakpoint (see the matchMedia shim). The pair of
  // breakpoints is asserted where it belongs — "the app still composes the
  // surfaces it mounts", below, which drives matchMedia both ways.
  "pages/ConsolePage.jsx#ConsolePage": { el: () => inApp(h(P.ConsolePage, { onSettings: () => {} })), must: ['class="console"', 'class="composer"', 'class="orb-wrap"'] },
  "pages/DayPage.jsx#DayPage": { el: () => inApp(h(P.DayPage)), must: ['class="content-head"', 'class="content-scroll"'], cold: ['class="empty"'], loaded: ['class="tl"', 'class="tl-hour-label"', 'class="tl-now"'] },
  "pages/QueuePage.jsx#QueuePage": { el: () => inApp(h(P.QueuePage)), must: ['class="content-head"', 'class="seg"', "Waiting on"], cold: ['class="empty"'], loaded: ['class="pillrow"', 'class="pill active"', "tickbox"] },
  // The needle was "Brief" — the <h1> at the top, which is gone: the dock and
  // the rail already have Brief lit when you are here. "Morning" is the first
  // option of the segment this page owns, so the mount is still proved by this
  // page's own content, and `class="content-head"` still proves the head itself
  // survived with its date-and-drafts line.
  "pages/BriefPage.jsx#BriefPage": { el: () => inApp(h(P.BriefPage)), must: ['class="content-head"', 'class="seg"', "Morning"], cold: ['class="empty"'] },
  "pages/MindPage.jsx#MindPage": { el: () => inApp(h(P.MindPage, { setPage: () => {} })), must: ['class="mind-stage"', 'class="mind-hud"', 'class="mind-legend"', "stattile"] },
  "pages/MemoryPage.jsx#MemoryPage": { el: () => inApp(h(P.MemoryPage)), must: ['class="content-head"', 'class="seg"', "Standing directives"], cold: ['class="empty"'], loaded: ['class="cellgroup"', "Clarify Paid Search"] },
  // content-head + content-scroll are new needles, and they are the bug: with
  // no scroll container this page's last 104px (desktop) / 394px (phone) were
  // clipped inside an overflow:hidden column and could not be scrolled to.
  "pages/VoicePage.jsx#VoicePage": { el: () => inApp(h(P.VoicePage)), must: ['class="content-head"', 'class="content-scroll"', 'class="v-row"', 'class="seg"', 'class="sec-head"'] },

  /* ── entries ───────────────────────────────────────────────────────────── */
  "App.jsx#SyncApp": { el: () => h(AppC), must: ['class="app"', 'class="app-main"', 'class="app-page"'] },
  // SyncRoot holds the first paint until its <style> lands, and effects never
  // run on the server — so "" is the correct and only output. The body still
  // executes, which is what the throw-injection is checking for.
  "Root.jsx#SyncRoot": { el: () => h(RootC), must: [], empty: true },
};

// Icons: fifty one-line components with no props of their own. Generated rather
// than listed, because a hand-written list of fifty is a list that will drift —
// but they are still MOUNTED, so a throw in any of them is red.
for (const d of discovered) {
  if (d.file !== "ui/icons.jsx" || CASES[d.key]) continue;
  CASES[d.key] = { el: () => h(d.fn, { size: 20 }), must: ["<svg", 'width="20"'] };
}

/* ════════════════════════════════════════════════════════════════════════════
   THE TABLE IS COMPLETE
   ════════════════════════════════════════════════════════════════════════════ */
describe("the mount table covers every component this app exports", () => {
  it("found the modules and the components in them", () => {
    // Scan sanity. Both numbers move when the app does; what they guard is that
    // the discovery below is looking at something at all.
    expect(files.length, `.jsx files under src/: ${files.map(rel).join(", ")}`).toBeGreaterThan(15);
    expect(discovered.length, "exported components discovered").toBeGreaterThan(70);
    const keys = discovered.map((d) => d.key);
    for (const known of [
      "ui/kit.jsx#Sheet", "ui/kit.jsx#ToastHost", "ui/kit.jsx#Segmented", "ui/kit.jsx#Grid",
      "ui/kit.jsx#Field", "ui/kit.jsx#TextArea",
      "pages/MindPage.jsx#MindPage", "pages/QueuePage.jsx#QueuePage", "pages/MemoryPage.jsx#MemoryPage",
      "pages/DayPage.jsx#DayPage", "pages/BriefPage.jsx#BriefPage", "pages/VoicePage.jsx#VoicePage",
      "chrome/Shell.jsx#Dock", "chrome/Shell.jsx#SubNav", "chrome/SettingsSheet.jsx#SettingsSheet",
      "chrome/PentagonPanel.jsx#PentagonPanel", "App.jsx#SyncApp", "Root.jsx#SyncRoot",
    ]) expect(keys, `discovery must reach ${known}`).toContain(known);
  });

  it("mounts every one of them — a new component with no case fails here", () => {
    // This is the assertion that keeps the hole shut. Renaming QueuePage's
    // export, or adding a page and not mounting it, lands here rather than
    // sailing through green.
    const uncovered = discovered.filter((d) => !CASES[d.key]).map((d) => d.key);
    expect(uncovered, `components with no mount case:\n${uncovered.join("\n")}`).toEqual([]);
    const orphans = Object.keys(CASES).filter((k) => !discovered.some((d) => d.key === k));
    expect(orphans, `mount cases naming a component that no longer exists:\n${orphans.join("\n")}`).toEqual([]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   EVERY COMPONENT, COLD AND LOADED
   ════════════════════════════════════════════════════════════════════════════ */
describe("every component mounts on a cold install", () => {
  for (const [key, spec] of Object.entries(CASES)) {
    it(`mounts ${key}`, () => {
      coldInstall();
      let out;
      expect(() => { out = render(spec.el()); }, `${key} threw on mount`).not.toThrow();
      if (spec.empty) { expect(out, `${key} must render nothing before its stylesheet lands`).toBe(""); return; }
      expect(out.length, `${key} rendered nothing at all — a body replaced with \`return null\` looks exactly like this`).toBeGreaterThan(0);
      for (const s of [...spec.must, ...(spec.cold || [])]) expect(out, `${key} no longer emits ${s}`).toContain(s);
    });
  }
});

describe("every component mounts against a full day's data", () => {
  // The pass above renders the empty states. Most of the body of a page is on
  // the other side of `if (!x.length)`, and that is where a broken reference to
  // a field, a prop or a hook actually lives.
  for (const [key, spec] of Object.entries(CASES)) {
    it(`mounts ${key} loaded`, () => {
      loadedInstall();
      let out;
      expect(() => { out = render(spec.el()); }, `${key} threw with data in the store`).not.toThrow();
      if (spec.empty) { expect(out).toBe(""); return; }
      expect(out.length, `${key} rendered nothing`).toBeGreaterThan(0);
      for (const s of [...spec.must, ...(spec.loaded || [])]) expect(out, `${key} no longer emits ${s}`).toContain(s);
    });
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   AND THEY DRAW THE DATA, NOT JUST THE FRAME
   ════════════════════════════════════════════════════════════════════════════ */
describe("the loaded pages draw the data rather than the empty state", () => {
  const page = (C, props) => { loadedInstall(); return render(inApp(h(C, props))); };

  it("the Day timeline draws its blocks, its states and the focus session", () => {
    const out = page(P.DayPage);
    expect(out).toContain("Deep work — proposal");
    // Match the class as a TOKEN, not as an adjacent pair. DayPage.jsx:298
    // composes `tl-block[ done][ now][ short]`, and `now` is decided against the
    // WALL CLOCK — so "tl-block short" as a substring is true only while the
    // fixture's 2:00–2:25pm block is not the current one. This suite failed for
    // 25 minutes a day, and passed the other 1,415.
    expect(out, "a done block is drawn as done").toMatch(/class="tl-block[^"]*\bdone\b/);
    expect(out, "a 25-minute block drops to one centred line").toMatch(/class="tl-block[^"]*\bshort\b/);
    expect(out, "the venture tone reaches the rail as data, not theme").toContain("--tone");
    expect(out, "a running focus session has its own bar").toContain("focusbar");
    // The bar has to COUNT DOWN, not merely exist. Asserting only on the class
    // let it render "NaN:NaN left" against a fixture missing endsAt.
    expect(out, "the focus bar shows real time remaining").toMatch(/\d+:\d\d left/);
    expect(out, "nothing in the day view renders NaN").not.toContain("NaN");
  });

  it("the Queue draws open tasks, overdue follow-ups and the tick", () => {
    const out = page(P.QueuePage);
    expect(out).toContain("Send the retainer proposal");
    expect(out, "an open item shows an empty box, never a grey check").toContain("tickbox");
    expect(out, "the follow-ups are one tab away and counted from here").toContain("Waiting on");
  });

  it("the Brief draws today's brief and the drafts on hand", () => {
    const out = page(P.BriefPage);
    expect(out).toMatch(/One thing matters today|Two closed, one slipped/);
    expect(out).toContain("draft");
  });

  it("the Mind draws its neurons, its legend and the way through to Memory", () => {
    const out = page(P.MindPage, { setPage: () => {} });
    expect(out).toContain('class="mind-legend"');
    expect(out).toContain('class="mind-chip-n"');
    expect(out, "the region swatch is the kit's dot").toContain('class="dotstatus"');
    expect(out, "Memory lost its dock slot, not its entrance").toContain("Knows");
  });

  it("Memory draws the ventures and what SYNC knows", () => {
    const out = page(P.MemoryPage);
    expect(out).toContain("Clarify Paid Search");
    expect(out).toContain("Prefers mornings for deep work.");
  });

  it("the Console draws the transcript and the execution ledger", () => {
    const out = page(P.ConsolePage, { onSettings: () => {} });
    expect(out).toContain("Plan my day");
    expect(out, "inline formatting is rendered, not printed").toContain("<strong>Proposal</strong>");
    expect(out, "the ledger draws all three of its states").toContain('class="act pending"');
    expect(out).toContain('class="act failed"');
    expect(out, "an undoable action carries its Undo").toContain('class="act-undo"');
  });

  it("Voice draws every control it owns", () => {
    const out = page(P.VoicePage);
    expect(out).toContain('class="v-row"');
    expect(out, "the voice picker").toContain("Thalia");
    expect(out, "the switches").toContain('role="switch"');
  });

  it("Settings draws the key field, the switches and the Pentagon panel", () => {
    loadedInstall();
    const out = render(inApp(h(SettingsSheetC, { onClose: () => {} })));
    expect(out).toContain("Pentagon");
    expect(out).toMatch(/<input[^>]*class="field"/);
    expect(out, "every control that existed before the kit still exists").toContain('role="switch"');
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   WIRING — a component that mounts but is no longer rendered is still gone
   ════════════════════════════════════════════════════════════════════════════ */
describe("the app still composes the surfaces it mounts", () => {
  const phone = (on) => {
    globalThis.window.matchMedia = (q) => ({ matches: on && /max-width:\s*760px/.test(q), addEventListener() {}, removeEventListener() {} });
  };
  afterAll(() => phone(false));

  it("renders the sub-nav on a desktop and the tab bar on a phone", () => {
    // Deleting `<Dock>` from App.jsx was GREEN, because the whole suite renders
    // at the desktop breakpoint where the dock is not drawn at all. matchMedia
    // is the app's own switch, so flipping it is the honest way to reach the
    // other layout — nothing about the components is faked.
    loadedInstall();
    phone(false);
    const desktop = render(h(AppC));
    expect(desktop, "the sub-nav is the desktop navigation").toContain('class="sy-nav"');
    expect(desktop, "and the tab bar is not drawn there").not.toContain('class="dock"');
    // THE RAIL IS GONE AND STAYS GONE. It was the only vertical nav inside a
    // content column in the estate, and with the shell's own rail up it read as
    // two stacked vertical navs. Reintroducing it lands here.
    expect(desktop, "no second vertical rail inside the tool").not.toContain('class="sidebar"');
    // Every destination reaches the row, by the label the map publishes.
    for (const label of ["Console", "Day", "Queue", "Brief", "Mind", "Voice"])
      expect(desktop, `the ${label} pill`).toContain(`>${label}<`);
    // The rail's foot carried live state and controls as well as destinations.
    // Losing any of the four in the move would have been a functional
    // regression, so each is pinned by the thing that names it.
    expect(desktop, "the phase readout").toContain("Standing by");
    expect(desktop, "the palette affordance").toContain("⌘K");
    expect(desktop, "the wake-word microphone").toMatch(/aria-label="(Listen for the wake word|Stop listening)"/);
    expect(desktop, "the settings gear").toContain('aria-label="Settings"');
    expect(desktop, "the speak toggle").toMatch(/aria-label="(Mute SYNC|Let SYNC speak)"/);
    // …and the Console's own copy of three of them is not drawn beside it.
    expect(desktop, "the Console's phone control row is not drawn twice").not.toContain('class="console-bar"');

    phone(true);
    const mobile = render(h(AppC));
    expect(mobile, "the tab bar is the phone navigation — deleting <Dock> lands here").toContain('class="dock pentagon-dock"');
    expect(mobile).toContain('class="dock-tab active"');
    // Every destination in nav.js reaches the bar. A tab silently dropped is a
    // page that becomes unreachable on the device this app is mostly used on.
    for (const label of ["Console", "Day", "Queue", "Brief", "Mind", "Voice"])
      expect(mobile, `the ${label} tab`).toContain(`>${label}</span>`);
    expect(mobile, "and the rail is not drawn there").not.toContain('class="sidebar"');
    // A phone has no sub-nav — six pills and a tab bar for the same six
    // destinations is the doubled navigation this whole change removes.
    expect(mobile, "and no sub-nav either").not.toContain('class="sy-nav"');
    // So the Console's own control row is the ONLY way to Settings there, and
    // it is drawn. This is the regression the Dock's comment describes: an
    // unreachable gear is how the API key came to be unset on the one device
    // that gets used.
    expect(mobile, "the phone keeps the Console's control row").toContain('class="console-bar"');
    expect(mobile, "…including the gear").toContain('aria-label="Settings"');
  });

  it("keeps every destination routable", () => {
    // PAGES in App.jsx is the router. An entry pointing at nothing is a
    // destination that silently falls back to the Console.
    const app = readSource("App.jsx");
    for (const key of ["console", "day", "queue", "brief", "mind", "memory", "voice"])
      expect(app, `${key} must stay routable`).toMatch(new RegExp(`\\b${key}:\\s*\\w*Page\\b`));
  });

  it("keeps the palette and the settings sheet wired into the workspace", () => {
    // Both sit behind state a server render cannot set, so the MOUNT is proven
    // in the table above and the WIRING is proven here. Deleting either element
    // from App.jsx was green; it is not now.
    const app = readSource("App.jsx");
    expect(app, "the command palette").toMatch(/<CommandK\b/);
    expect(app, "the settings sheet").toMatch(/\{settings && <SettingsSheet\b/);
    expect(app, "the tab bar").toMatch(/<Dock\b/);
    expect(app, "the sub-nav").toMatch(/<SubNav\b/);
    expect(app, "the entrance").toMatch(/<Onboarding\b/);
  });

  it("renders the entrance before onboarding and the workspace after", () => {
    coldInstall();
    store.setSettings({ onboarded: false });
    const first = render(h(AppC));
    expect(first).toContain('class="entrance"');
    expect(first).toContain('class="entrance-card"');
    store.setSettings({ onboarded: true });
    expect(render(h(AppC))).toContain('class="app"');
  });

  it("renders all of it without a React warning", () => {
    const react = warnings.filter((w) => !w.startsWith("[@cc/"));
    expect(react, `React warned while mounting:\n${react.join("\n")}`).toEqual([]);
  });
});
