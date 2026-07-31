// Clarify on the shared kit — proved by rendering it, not by a green build.
//
// `vite build` does not prove this. It was green on a component that threw
// "nodeR is not defined" the moment it mounted and took three tools down.
// react-dom/server executes the whole component body in plain Node — no jsdom
// in this repo and none needed — so a restyle that broke a reference, a prop or
// a hook fails here rather than on a phone.
//
// WHAT THIS FILE USED TO CLAIM ABOUT DUPLICATE ATTRIBUTES, AND WHY IT NOW HAS A
// GUARD INSTEAD
// It used to say the render test "already caught" a duplicate `className` on
// the Inbound delete button. It did not, and could not: that button lives in
// the inbound list, which is behind an async `sbFetch`, and a cold #/inbound
// paints the loading skeleton and ZERO InboundView controls. Re-introducing
// `className="icon-btn" className="co-icon-btn"` left the whole repo suite —
// 50 files, 1447 tests — green; the only signal was a vite warning that no
// assertion reads. The claim is replaced by the thing it was pretending to be:
// "declares no JSX attribute twice on one element" below walks every opening
// tag in every migrated file and reads its attribute names. That is a
// guard worth having on its own terms — esbuild silently keeps the LAST
// duplicate and emits only a warning, so `className="icon-btn"
// className="co-icon-btn"` compiles to a button that has lost its 40px mobile
// touch target with nothing red anywhere.
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
// The LAST TWO describes deliberately break that rule, and only there. Most of
// this app's controls live behind data or component state a cold paint never
// produces, so "every button is on the kit" was true of them only by never
// having been looked at. Those blocks feed each surface what it needs (through
// `withStorage`, which restores the store afterwards, or by mounting the
// component directly with fixture props) and walk them with the same rules.
//
// WHY SO MANY COMPONENTS ARE MOUNTED BY HAND
// An unmounted component's body never executes, so NOTHING in this file can
// fail because of it — not the render walk, not the kit-class walk, not the
// button walk. Twenty of this app's components were in exactly that position:
// `throw new Error(...)` as the first statement of ThreadModal,
// ToneMemoryPanel, CopyButton, QuickSendStrip, PreCallBrief, CadenceBar,
// KanbanColumn, UndoToast, ShortcutHelp, ReplyTriageSummary, DailyPlays,
// PipelineFunnel, MetricTile, BarChart, AnalysisComparison, BookingModal,
// ClientDetail, StepEditor, SequenceCard or LeadJourney left the suite green.
// That is the failure mode that took this repo down in production — a build
// cannot catch a free variable and neither can a grep. "mounts every component
// this app ships" below renders all twenty, and each one was proved by
// re-injecting that throw and watching this file go red.
//
// EVERY ASSERTION HERE WAS PROVED ABLE TO FAIL. Each named property was broken
// in the source once and this file was re-run: dropping data-kit off either
// root, un-classing the send-mode pill, un-classing one Settings button,
// putting a 9px back, putting 'Syne' back, re-adding a border next to a shadow,
// re-adding textTransform, replacing a domain hex with var(--accent), blanking
// the Live/Safe words, downgrading the client-error retry, changing the iOS
// 16px rule, renaming a localStorage key at ONE of its four sites, un-classing
// each of the six data-gated buttons, removing the calendar's MonthCalendar
// mount, re-introducing the duplicate `className` on the Inbound delete button,
// dropping {pill.t} off the engine state pill, deleting the '✓ Approved' word,
// putting the dead border-color transition back, adopting the kit's 44px floor
// on the outreach search box, growing selectBase past the toolbar's height, and
// throwing from each of the twenty components above — all went red, and were
// restored.
//
// The kit-class table was proved the way the reviewer broke it: every kit class
// token removed from every className in ONE file, for each of the nineteen .jsx
// files in turn. Seventeen went red on that alone; the two that author no kit
// classes (Root.jsx, features/system/AgentsView.jsx) were proved the other way,
// by ADDING one and watching the coverage assertion trip. The two halves of a
// pair were proved separately as well — the AUTHORED half by that strip, the
// RENDERED half by leaving the className in the file and making the element not
// render (InboundView's `showPreview &&` → `false &&`, an early `return null`
// in AnalyticsView's StatTile, AgentPanel's `messages.length === 0` → `=== -1`).
// Every scan-sanity floor was proved too, by breaking its own scanner's regex.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createElement, Fragment } from "react";
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

// Every JSX opening tag in a file, with the names of the attributes declared on
// it. Used by the duplicate-attribute guard: JSX has no duplicate-prop error —
// esbuild keeps the LAST one and warns, and nothing in this repo reads warnings
// — so `className="icon-btn" className="co-icon-btn"` compiles to a button
// whose 40px mobile touch target is gone.
//
// The walk skips {expressions} with the shared brace walker and skips quoted
// values, so a `>` inside a style object or a title string does not end the tag
// early. A `<` that is not a tag (`i < CADENCE.length`) cannot match: the
// pattern requires an identifier followed immediately by whitespace, `/` or
// `>`.
const jsxTags = (src) => {
  const tags = [];
  const re = /<([A-Za-z][\w.:$]*)(?=[\s/>])/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex;
    const attrs = [];
    let closed = false;
    while (i < src.length) {
      const c = src[i];
      if (c === "{") { const e = findClose(src, i); if (e < 0) break; i = e; continue; }
      if (c === '"' || c === "'") { const e = src.indexOf(c, i + 1); if (e < 0) break; i = e + 1; continue; }
      if (c === ">") { closed = true; i++; break; }
      if (c === "<") break;
      const am = /^([A-Za-z_$][\w$:-]*)(\s*=)?/.exec(src.slice(i));
      if (am && am[1]) { if (am[2]) attrs.push(am[1]); i += am[0].length; continue; }
      i++;
    }
    if (closed) tags.push({ tag: m[1], attrs, text: src.slice(m.index, i) });
  }
  return tags;
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
const {
  KanbanColumn, BulkActionsBar, UndoToast, ShortcutHelp, ReplyTriageSummary, DailyPlays,
  PipelineFunnel, ChainGroup, ChainLocationRow,
} = await import("../features/outreach/OutreachBoard.jsx");
const {
  OutreachCard, ThreadModal, ToneMemoryPanel, CopyButton, QuickSendStrip, PreCallBrief, CadenceBar,
} = await import("../features/outreach/OutreachCard.jsx");
const {
  QuickWinRow, ReasoningTrace, MetricTile, BarChart, AnalysisComparison, UploadCard,
} = await import("../features/analyst/AnalystView.jsx");
const { BookingModal } = await import("../features/calendar/CalendarView.jsx");
const { ClientDetail } = await import("../features/clients/ClientsView.jsx");
const { StepEditor, SequenceCard } = await import("../features/sequences/SequencesView.jsx");
const { LeadJourney } = await import("../components/LeadJourney.jsx");
const { InboundLeadRow } = await import("../features/inbound/InboundView.jsx");
const { AgentPanel } = await import("../features/system/GlobalAgent.jsx");
const { AnalyticsView } = await import("../features/analytics/AnalyticsView.jsx");
const { MissionControl, MonthCalendar } = await import("../features/mission/MissionControl.jsx");

// Anything mounted by hand goes through the app's own ToastProvider, because
// several of these components call useToast() during render and would throw
// without it — the same pair ClarifyRoot mounts.
const paint = (el) => renderToStaticMarkup(createElement(ToastProvider, null, el));

// ── fixtures ────────────────────────────────────────────────────────────────
// Shaped like the rows Supabase actually returns, because several of these
// panels branch on the shape (ads_detected, sent_at, reply_body, meeting_at)
// and a thinner fixture would render the wrong half of the component.
const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const CHAIN_CARD = (id, name) => ({
  id, status: "prospected", created_at: "2026-07-20T10:00:00.000Z",
  prospect: { business_name: name, address: "2100 N Milwaukee Ave, Chicago, IL 60647", category: "dentist", website: "https://example.com", ads_detected: true },
  contact: { name: "Dana Reyes", email: "dana@example.com", email_confidence_score: 80 },
});
const CARD = (over = {}) => ({ ...CHAIN_CARD(over.id || "card-1", "Northside Dental"), ...over });
const SENT_CARD = CARD({ id: "card-sent", status: "sent", sent_at: iso(5), draft_subject: "Your Google Ads are leaking budget", draft_body: "Quick note — I pulled your search terms report and found wasted spend.", gmail_thread_id: "thr-1", gmail_rfc_message_id: "<a@b>" });
const REPLIED_CARD = CARD({
  id: "card-replied", status: "replied", sent_at: iso(6), replied_at: iso(1),
  draft_subject: "Your Google Ads are leaking budget", draft_body: "Quick note — I pulled your search terms report.",
  reply_body: "Happy to chat — can we find a time next week?", reply_from: "Dana Reyes <dana@example.com>",
  reply_draft: "Sure — how does Tuesday at 10 look?", reply_draft_subject: "Re: Your Google Ads are leaking budget",
  gmail_thread_id: "thr-2",
});
// Two hours out, not two days: MonthCalendar's "This month" list only shows
// meetings inside the month currently on screen, so a fixture that could land
// in next month would make this suite pass or fail by calendar date.
const MEETING_CARD = CARD({ id: "card-meeting", status: "meeting", sent_at: iso(9), replied_at: iso(3), meeting_at: new Date(Date.now() + 2 * 3600000).toISOString(), meeting_outcome: "pending", reply_body: "Yes — book it." });
const DRAFT_CARD = CARD({ id: "card-draft", status: "draft", draft_subject: "Wasted spend on brand terms", draft_body: "You are overspending on competitor terms and the CPA is climbing." });
const BOARD_CARDS = [CARD(), DRAFT_CARD, SENT_CARD, REPLIED_CARD, MEETING_CARD];
const INBOUND_LEAD = {
  id: "lead-1", status: "new", created_at: iso(1), email: "dana@example.com",
  business_name: "Northside Dental", contact_name: "Dana Reyes", service: "Google Ads audit",
  budget: "$5k–$10k", message: "We're spending about $8k a month and can't tell what's working.",
  website: "example.com",
};
const CAMPAIGNS = [
  { name: "Brand - Exact", cost: 1100, conversions: 22 },
  { name: "PI - High Intent", cost: 4200, conversions: 28 },
  { name: "PMax - Lead Gen", cost: 2400, conversions: 18 },
];
const ANALYSIS_NOW = { id: null, clientName: "Northside Dental", signal: "needs_attention", csvMetrics: { totalCost: 12400, totalConv: 88, avgCPA: 141, avgCPC: 4.2 } };
const ANALYSIS_PRIOR = { id: 9, clientName: "Northside Dental", signal: "stable", savedAt: iso(9), csvMetrics: { totalCost: 9800, totalConv: 70, avgCPA: 120, avgCPC: 3.9 } };
const CLIENT = { id: "client-1", name: "Chicago PI Law", industry: "Personal Injury Law", monthly_budget: 8500, cpa_target: 120, google_ads_customer_id: "123-456-7890" };
const QUEUE_MSG = {
  id: "msg-1", outreach_id: "out-1", kind: "followup", direction: "outbound", status: "draft",
  subject: "Following up on your Google Ads", body: "Quick note — I pulled your search terms report.",
  created_at: iso(1), meta: { step_name: "Step 2 — nudge", personalized: true },
  outreach: { prospect: { business_name: "Northside Dental" }, contact: { email: "dana@example.com" } },
};
const SEQ_STEP = { id: "step-1", sequence_id: "seq-1", step_order: 1, name: "Bump", wait_days: 3, send_condition: "no_reply", body_template: "Short nudge — make sure the first note didn't get buried.", ai_personalize: true };
const SEQUENCE = { id: "seq-1", name: "Default ladder", description: "Three touches over two weeks", is_active: true, stop_on_reply: true };
const noop = () => {};
const asyncNoop = async () => {};

// The kit class tokens this app applies, and exactly the family a fresh-context
// reviewer stripped out of all eighteen migrated files without turning this
// suite red. `.btn`, `.pill`, `.icon-btn` and `.dock-tab` are deliberately NOT
// in here — the button walk above already fails when one of those goes missing.
const KIT_TOKEN = /^(card|field|cell|tappable|pressable|seg|seg-opt|empty|pad-sm|t-[\w-]+|stattile[\w-]*|sk[\w-]*)$/;

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
    // Named per SURFACE and per FILE, deliberately, and both halves are
    // load-bearing.
    //
    // A union over all eleven renders would stay green while ten of the eleven
    // panels kept their hand-rolled tiles — that is the "one element out of
    // thirty" failure mode, and naming the surface fixes it.
    //
    // Naming the surface is not enough on its own, which is what an earlier
    // version of this test got wrong. A view's markup includes everything it
    // IMPORTS, so a class contributed by somebody else's component satisfied
    // the entry for free: #/calendar's `stattile-label`, `t-label` and `card`
    // were all answered by MonthCalendar — which lives in
    // features/mission/MissionControl.jsx. Renaming every one of CalendarView's
    // seven `t-label`s, and stripping `card` off its local Card helper (which
    // un-cards all eight call sites), both left this suite green. So each entry
    // must be AUTHORED in the named file and REACH the named surface's markup.
    //
    // WHY THERE ARE FED SURFACES HERE AND NOT ONLY HASH ROUTES
    // The previous version had rows for nine files only, and excused
    // analytics / inbound / clients with "with no rows they render an
    // EmptyState or a skeleton". True, and it left EIGHT of the eighteen
    // migrated files with no guard whatsoever: a reviewer stripped every kit
    // class token from every className in ClientsView (55), OutreachCard (49),
    // InboundView (17), OutreachBoard (12), AnalyticsView (9), LoginScreen (9),
    // GlobalAgent (3) and LeadJourney (1) — 155 applications — and this suite
    // stayed 25/25 each time. A skeleton is not a reason to have no assertion;
    // it is a reason to render the surface with rows in it. So a surface here
    // is "whatever mount paints this file's markup": a hash route where a cold
    // paint reaches it, and a direct mount fed fixture rows where it does not.
    const OWN = [
      // ── cold hash routes ──────────────────────────────────────────────────
      {
        at: "#/mission", paint: () => view("mission"), files: {
          // Mission Control proper: the stat cards and the month grid.
          "features/mission/MissionControl.jsx": ["card", "stattile", "stattile-label", "stattile-value", "t-label", "t-title1", "t-cap", "t-foot"],
          // The engine panel it mounts underneath them.
          "features/mission/EnginePanel.jsx": ["card", "pad-sm", "pressable", "t-call", "t-cap", "t-foot", "t-head", "t-label", "t-title2"],
        },
      },
      // The outreach board is rendered inline by App.jsx: its toolbar search
      // box and the tab strip / sub-nav segmented controls. What the `field`
      // entry proves is narrow and worth stating: App.jsx puts .field on that
      // input and #/outreach renders it. It does NOT prove the input has the
      // kit's 44px floor or 15px type — four inline overrides deliberately win
      // over both. "says out loud where a kit class is taken for material only"
      // below is the guard for that half.
      { at: "#/outreach", paint: () => view("outreach"), files: { "App.jsx": ["field", "seg", "seg-opt"] } },
      { at: "#/queue", paint: () => view("queue"), files: { "features/queue/QueueView.jsx": ["t-title2", "t-foot"] } },
      { at: "#/sequences", paint: () => view("sequences"), files: { "features/sequences/SequencesView.jsx": ["t-title2", "t-foot"] } },
      // The analyst sidebar: client name / context fields and their labels.
      { at: "#/analyst", paint: () => view("analyst"), files: { "features/analyst/AnalystView.jsx": ["field", "t-label"] } },
      // Booking link card, the "Ready to book" / "Upcoming" headers. NOT
      // stattile-label — see the MonthCalendar test below for why.
      { at: "#/calendar", paint: () => view("calendar"), files: { "features/calendar/CalendarView.jsx": ["card", "t-label", "t-title2", "t-foot"] } },
      { at: "#/settings", paint: () => view("settings"), files: { "features/system/SettingsView.jsx": ["card", "field", "t-call", "t-cap", "t-foot", "t-label", "t-title2"] } },
      // The DNA overlay's own labels and inputs — the canvas is left alone.
      { at: "#/dna", paint: () => view("dna"), files: { "features/dna/DnaView.jsx": ["t-label"] } },

      // ── surfaces fed the rows a cold paint never has ──────────────────────
      {
        at: "the sign-in root", paint: () => paint(createElement(LoginScreen, { onLogin: noop })),
        files: { "features/auth/LoginScreen.jsx": ["card", "field", "t-cap", "t-foot", "t-head", "t-label", "t-title2"] },
      },
      {
        // Mission again, this time with a pipeline and a booked meeting, which
        // is what lights up the day-over-day delta and the month grid's
        // upcoming list.
        at: "Mission Control fed a pipeline and yesterday's snapshot",
        paint: () => withStorage({ sm_mission_snapshot_prev: { sent: 0, replied: 0, prospected: 0, draft: 0 } },
          () => paint(createElement(MissionControl, { cards: BOARD_CARDS, onNavigate: noop, inboundNew: 2 }))),
        files: { "features/mission/MissionControl.jsx": ["pad-sm", "stattile-delta"] },
      },
      {
        at: "the outreach board fed a pipeline",
        paint: () => paint(createElement(Fragment, null,
          createElement(KanbanColumn, { title: "Prospected", count: 3, color: "#94A1B5", onBatchGenerate: noop, batchLabel: "Generate All", emptyNote: "No replies yet — 2 emails sent." }),
          createElement(DailyPlays, { cards: BOARD_CARDS, onFilter: noop }),
          createElement(PipelineFunnel, { cards: BOARD_CARDS }),
          createElement(ReplyTriageSummary, { cards: BOARD_CARDS }),
          createElement(UndoToast, { message: "3 snoozed", onUndo: noop, onDismiss: noop }),
          createElement(ShortcutHelp, { onClose: noop }),
        )),
        files: { "features/outreach/OutreachBoard.jsx": ["card", "stattile", "stattile-delta", "stattile-label", "stattile-value", "t-cap", "t-foot", "t-head", "t-label", "t-num"] },
      },
      {
        at: "an outreach card and the tone panel",
        paint: () => paint(createElement(Fragment, null,
          createElement(OutreachCard, { card: DRAFT_CARD, toneMemory: [], onStatusChange: noop, onDraftRegenerate: asyncNoop, onToneFeedback: asyncNoop, onEnrich: asyncNoop, onMarkSent: asyncNoop }),
          createElement(ToneMemoryPanel, { toneMemory: [], onAdd: asyncNoop, onDelete: noop }),
        )),
        files: { "features/outreach/OutreachCard.jsx": ["card", "field", "t-call", "t-cap", "t-foot", "t-label"] },
      },
      {
        at: "an inbound lead row",
        paint: () => paint(createElement(InboundLeadRow, { lead: INBOUND_LEAD, selected: false, showPreview: true, onSelect: noop, onDelete: noop })),
        files: { "features/inbound/InboundView.jsx": ["card", "pressable", "t-cap", "t-foot", "t-head", "t-label"] },
      },
      {
        at: "the analyst's model-gated panels",
        paint: () => paint(createElement(Fragment, null,
          createElement(MetricTile, { label: "Total Spend", value: "$12,400", sub: "across all campaigns" }),
          createElement(BarChart, { data: CAMPAIGNS, valueKey: "cost", labelKey: "name", color: "#6EA8FE", formatValue: (v) => `$${v}`, title: "Spend by Campaign", targetValue: 2000, targetLabel: "$2k target" }),
          createElement(AnalysisComparison, { current: ANALYSIS_NOW, savedAnalyses: [ANALYSIS_PRIOR] }),
          createElement(ReasoningTrace, { trace: "Compared spend against last period, then ranked by wasted cost." }),
        )),
        files: { "features/analyst/AnalystView.jsx": ["card", "cell", "tappable"] },
      },
      {
        at: "a client's account page",
        paint: () => paint(createElement(ClientDetail, { client: CLIENT, findings: [], actions: [], onBack: noop, onDelete: noop })),
        files: { "features/clients/ClientsView.jsx": ["card", "seg", "seg-opt", "stattile", "stattile-label", "stattile-value", "t-call", "t-cap", "t-foot", "t-label", "t-title1"] },
      },
      {
        at: "the assistant panel",
        paint: () => paint(createElement(AgentPanel, { messages: [], input: "", sending: false, endRef: { current: null }, onInput: noop, onSend: noop, onClear: noop, onClose: noop })),
        files: { "features/system/GlobalAgent.jsx": ["field", "t-call", "t-foot"] },
      },
      {
        at: "#/analytics fed a pipeline",
        paint: () => paint(createElement(AnalyticsView, { cards: BOARD_CARDS })),
        files: { "features/analytics/AnalyticsView.jsx": ["card", "stattile", "stattile-label", "stattile-value", "t-cap", "t-foot", "t-label", "t-title2"] },
      },
      {
        at: "a queued draft",
        paint: () => paint(createElement(QueueItem, { msg: QUEUE_MSG, onDone: noop })),
        files: { "features/queue/QueueView.jsx": ["card", "cell", "tappable", "t-cap", "t-label"] },
      },
      {
        at: "a sequence and its step editor",
        paint: () => paint(createElement(SequenceCard, { seq: SEQUENCE, steps: [SEQ_STEP], enrolledCount: 4, onSave: asyncNoop, onDelete: noop })),
        files: { "features/sequences/SequencesView.jsx": ["card", "field"] },
      },
      {
        at: "the booking modal",
        paint: () => paint(createElement(BookingModal, { card: REPLIED_CARD, onClose: noop, onBooked: noop })),
        files: { "features/calendar/CalendarView.jsx": ["field", "t-cap", "t-head"] },
      },
      {
        at: "a lead's journey strip",
        paint: () => paint(createElement(LeadJourney, { card: REPLIED_CARD, hasInbound: true })),
        files: { "components/LeadJourney.jsx": ["t-cap"] },
      },
    ];

    // Kit classes a file authors that NO surface above can reach, each with the
    // reason. Every entry is a real coverage gap — written down rather than
    // silently absent, which is what the whole of eight files used to be.
    const UNREACHED = {
      // t-head is the wordmark, dropped when embedded (which is how the shell
      // and this file mount it); t-num is on the quick-filter chips, which
      // need a loaded board and App's cards arrive from an async db call.
      "App.jsx": ["t-head", "t-num"],
      // The page header and the conversation panel: both sit behind the async
      // sbFetch of /inbound_leads, which no static render can resolve.
      "features/inbound/InboundView.jsx": ["field", "t-body", "t-title1", "t-title2"],
      // The analysed-client heading — needs a parsed model response.
      "features/analyst/AnalystView.jsx": ["t-title2"],
      // The client list rows and the Add-client modal: behind the async
      // clients fetch. ClientDetail (the surface above) is the rest of the tab.
      "features/clients/ClientsView.jsx": ["field", "pressable", "t-head"],
      // The action-queue editor fields and the observation disclosure: both
      // need engine state that arrives from Supabase.
      "features/mission/EnginePanel.jsx": ["cell", "field", "tappable"],
      // The booking-link value, printed only once a real scheduling URL has
      // replaced config.js's placeholder.
      "features/calendar/CalendarView.jsx": ["t-call"],
      // The queue editor's subject/body, which replace the preview only after
      // a click.
      "features/queue/QueueView.jsx": ["field"],
      // The step body/subject templates render inside SequenceCard; t-foot and
      // t-title2 are the tab header, already guarded on the cold route.
      "features/sequences/SequencesView.jsx": [],
      // The node inspector's label/text inputs and the pulse box, all behind a
      // node selection or an open floating panel. DESIGN.md §5 already records
      // this tab as a partly-migrated surface awaiting the shell's Minds screen.
      "features/dna/DnaView.jsx": ["field"],
    };

    let pairs = 0;
    let scannedAttrs = 0;
    const guarded = {};
    for (const s of OWN) {
      const rendered = classesIn(s.paint());
      for (const [file, want] of Object.entries(s.files)) {
        const authored = classTokens(strip(read(...file.split("/"))));
        // Scan sanity: a className reader that quietly stopped matching would
        // make every `authored.has()` below fail rather than pass, but say so
        // in one line instead of eight. Per file the floor is only 2 —
        // components/LeadJourney.jsx is 41 lines and has exactly two — so the
        // real floor is the total, asserted after the loop.
        expect(authored.attrs, `${file}: the className scan read ${authored.attrs} attributes out of it — the scan is broken`).toBeGreaterThanOrEqual(2);
        scannedAttrs += authored.attrs;
        guarded[file] = guarded[file] || new Set();
        for (const c of want) {
          pairs++;
          expect(authored.has(c), `${file} puts nothing on the kit's .${c} — ${s.at}'s claim to it would be riding on an imported component`).toBe(true);
          expect(rendered.has(c), `${s.at} renders nothing on the kit's .${c}`).toBe(true);
          guarded[file].add(c);
        }
      }
    }
    // Every pair above was individually mutation-proved: broken in its own file,
    // this test went red. Deleting one silently would undo that, so the counts
    // are asserted too.
    expect(OWN.length, "the surface table lost entries").toBe(21);
    expect(pairs, "the (surface, file, class) table lost entries").toBe(105);
    expect(scannedAttrs, "the className scan read almost nothing across the table — it is broken").toBeGreaterThan(400);

    // …and the half that makes stripping a file's kit classes WHOLESALE go red.
    // The per-pair assertions above only cover the classes some surface happens
    // to reach; this one says every kit class every migrated file authors is
    // either guarded above or written down in UNREACHED with a reason. Strip
    // the kit tokens out of any className in any of the eighteen and the two
    // sides stop matching.
    // Nineteen .jsx files, not the eighteen the migration note counts: Root.jsx
    // is a mount shim and features/system/AgentsView.jsx is a metadata module
    // whose two components were deleted, so both author ZERO kit classes and
    // both are covered here by the empty-set case — which is itself the guard
    // that says "put a row in this table before you style either of them".
    const JSX = FILES.map(([n]) => n).filter((n) => n.endsWith(".jsx"));
    expect(JSX.length, "the FILES table lost one of the migrated files").toBe(19);
    for (const file of JSX) {
      const authoredKit = [...classTokens(strip(read(...file.split("/"))))].filter((t) => KIT_TOKEN.test(t)).sort();
      const accounted = [...new Set([...(guarded[file] || []), ...(UNREACHED[file] || [])])].sort();
      expect(authoredKit, `${file}: the kit classes it authors and this table have drifted apart. Every kit class a migrated file puts on a className must be either guarded by a surface above or listed in UNREACHED with the reason it cannot be reached.`).toEqual(accounted);
    }
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
  it("declares no JSX attribute twice on one element", () => {
    // JSX has no duplicate-prop ERROR. esbuild keeps the LAST occurrence and
    // emits a warning, vite prints it into a wall of build output, and no
    // assertion in this repo reads warnings — so a duplicate is a silent
    // behaviour change. The one this migration shipped was
    // `className="icon-btn" className="co-icon-btn"` on the Inbound delete
    // button: `icon-btn` lost, and with it the 40px minimum the `.co-icon-btn`
    // media rule only widens — the glyph's own box on a phone.
    //
    // Scoped to attribute NAMES, which is the whole failure mode: two spellings
    // of the same prop where the author believed both applied. It reads every
    // opening tag in every file this app ships rather than just className, because
    // `style` twice or `onClick` twice fails exactly the same way.
    let tags = 0, attrs = 0;
    const offenders = [];
    for (const [name, src] of FILES) {
      for (const t of jsxTags(src)) {
        tags++;
        attrs += t.attrs.length;
        const seen = new Set(), dup = new Set();
        for (const a of t.attrs) { if (seen.has(a)) dup.add(a); seen.add(a); }
        if (dup.size) offenders.push(`${name}: <${t.tag}> declares ${[...dup].join(", ")} twice — esbuild keeps the LAST one\n    ${t.text.slice(0, 220).replace(/\s+/g, " ")}`);
      }
    }
    // Scan sanity: a tag walk that quietly stopped matching would find no
    // duplicates for the best possible reason and the worst possible one.
    expect(tags, "no JSX tag was walked — the scan is broken").toBeGreaterThan(1200);
    expect(attrs, "no JSX attribute was read — the scan is broken").toBeGreaterThan(2500);
    expect(offenders, `a JSX attribute is declared twice on one element:\n${offenders.join("\n")}`).toEqual([]);
  });

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
    // The PILL table above holds the WORD for each engine state, and this is
    // the one place it is printed. `/Agent engine|\{pill\.t\}/` used to stand
    // here; the first alternative was dead — 'Agent engine' occurs nowhere in
    // EnginePanel.jsx — so only the second could ever match and the assertion
    // claimed twice what it checked.
    expect(engine, "the engine pill stopped printing its state word — colour would be the only signal left").toMatch(/\{pill\.t\}/);
    // The third state this app is dangerous about: an approved action in the
    // analyst's queue. It says '✓ Approved' in words, beside an impact chip
    // that also carries its label. That row's `border-color` transition was
    // dropped when it became a kit .card — there is no border left to ease —
    // and it is the WORDS, not the easing, that carry the state.
    const analyst = FILES.find(([n]) => n.endsWith("AnalystView.jsx"))[1];
    expect(analyst, "the approved-action row lost the word that says it is approved").toContain("✓ Approved");
    expect(analyst, "a border-color transition came back on an element that draws no border").not.toMatch(/transition:\s*"opacity 0\.2s, border-color/);
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

  it("says out loud where a kit class is taken for material only", () => {
    // The outreach toolbar's search box carries className="field" and then
    // overrides minHeight, padding and fontSize inline, so of the kit's .field
    // only the background and the radius actually survive — NOT the 44px floor
    // and NOT the 15px type. That reads like an accident and is not one: the
    // box sits in a row that becomes a one-line horizontal scroller on a phone
    // (`.co-toolbar`) beside two `selectBase` dropdowns at 7px/11px/12px, and
    // theme.js's selectBase comment reasons about exactly this ("`.field`'s
    // 44px floor would double the height of the outreach toolbar").
    //
    // So the OWN table above proves what it can prove — App.jsx authors .field
    // and #/outreach renders it — and THIS is the honest statement of the rest:
    // the override is deliberate, it is written down next to the code, and the
    // two footprints move together. Anyone who deletes the reasoning, or lets
    // the input and the selects drift apart, gets a red test instead of a
    // silent 44px jump on a phone.
    const app = read("App.jsx");
    const theme = read("theme.js");
    expect(app, "the toolbar search box lost the note saying its kit override is deliberate").toContain("The kit's .field for the MATERIAL only");
    expect(app, "the note stopped naming the four overrides it is excusing").toMatch(/minHeight 36, 7px\/12px padding, 13px/);
    expect(app, "the toolbar search box no longer overrides the kit's footprint — either it adopted .field's 44px floor (then delete the note) or the numbers moved (then update it)")
      .toContain('style={{ flex: 1, minWidth: "180px", width: "auto", minHeight: 36, padding: "7px 12px", fontSize: "13px" }}');
    // The selects it must match. If someone re-sizes these, the note above is
    // stale and the row is no longer one height.
    expect(theme, "selectBase lost the footprint the search box is matched to").toMatch(/padding: "7px 11px",\s*\n\s*fontSize: "12px",/);
    expect(theme, "selectBase lost the reason it exists").toContain("would double\n// the height of the outreach toolbar");
    // …and the phone rule that puts the iOS zoom floor back on every input,
    // which is why 13px here is not a mobile accessibility regression.
    expect(app, "the 16px phone floor that makes the 13px desktop size safe is gone").toContain("input, textarea, select { font-size: 16px !important; }");
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
  const walkButtons = (label, html, atLeast) => {
    const found = html.match(/<button[^>]*>/g) || [];
    expect(found.length, `${label}: no button was scanned — the surface did not render, so this proves nothing`).toBeGreaterThanOrEqual(atLeast);
    const offenders = found.filter((b) => !KIT.test(b));
    expect(offenders, `${label}: buttons that opted out of the kit:\n${offenders.join("\n")}`).toEqual([]);
    return found.length;
  };

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

// ── every component this app ships is executed by something here ────────────
//
// This is the coverage floor the rest of the file rests on. `renderToStaticMarkup`
// runs the whole component body in plain Node — which is exactly why it catches
// the free variable a build and a grep both miss — but ONLY for components
// something actually mounts. A component nothing mounts is invisible to every
// assertion above: the eleven-route walk, the button walk, the kit-class walk,
// the NaN walk, the React-warning walk. All of them.
//
// A fresh-context reviewer proved that by putting `throw new Error("MUT_<name>")`
// as the FIRST statement of each component body and re-running the whole repo
// suite. Twenty went green: ThreadModal, ToneMemoryPanel, CopyButton,
// QuickSendStrip, PreCallBrief, CadenceBar, KanbanColumn, UndoToast,
// ShortcutHelp, ReplyTriageSummary, DailyPlays, PipelineFunnel, MetricTile,
// BarChart, AnalysisComparison, BookingModal, ClientDetail, StepEditor,
// SequenceCard, LeadJourney. The same mutation on every other component went
// red, so the technique was sound and the gap was real — and this app's whole
// reason for having a render test is that an unmounted-and-therefore-unchecked
// component is what took three tools down in production.
//
// Each entry names a string the component must put on screen, so "it mounted"
// means "it rendered its own content", not "it returned null". Several of these
// return null on the wrong props (CadenceBar without sent_at, ReplyTriageSummary
// without a classified reply, AnalysisComparison without a prior save), and a
// null render would execute the body but prove nothing about the rest of it.
describe("Clarify mounts every component it ships", () => {
  const MOUNTS = [
    // ── outreach/OutreachCard.jsx ──
    ["OutreachCard", () => createElement(OutreachCard, { card: DRAFT_CARD, toneMemory: [], onStatusChange: noop, onDraftRegenerate: asyncNoop, onToneFeedback: asyncNoop, onEnrich: asyncNoop, onMarkSent: asyncNoop }), "Northside Dental"],
    ["ThreadModal", () => createElement(ThreadModal, { card: REPLIED_CARD, toneMemory: [], onClose: noop, onSendReply: asyncNoop }), "Your reply draft"],
    ["ToneMemoryPanel", () => createElement(ToneMemoryPanel, { toneMemory: [{ id: 1, feedback_text: "Never open with 'I'" }], onAdd: asyncNoop, onDelete: noop }), "Tone memory"],
    ["CopyButton", () => createElement(CopyButton, { text: "Subject: hello\n\nbody" }), "Copy"],
    ["QuickSendStrip", () => createElement(QuickSendStrip, { subject: DRAFT_CARD.draft_subject, body: DRAFT_CARD.draft_body, contact: DRAFT_CARD.contact, card: DRAFT_CARD, onQuickSend: asyncNoop }), "Send"],
    ["PreCallBrief", () => createElement(PreCallBrief, { card: REPLIED_CARD, prospect: REPLIED_CARD.prospect }), "Pre-call brief"],
    // 5 days since send, so the 3-day Bump is due and the draft button draws.
    ["CadenceBar", () => createElement(CadenceBar, { card: SENT_CARD, onGenerateFollowUp: noop }), "Bump"],
    ["StatusBadge (via OutreachCard)", () => createElement(OutreachCard, { card: REPLIED_CARD, toneMemory: [], onStatusChange: noop, onDraftRegenerate: asyncNoop, onToneFeedback: asyncNoop, onEnrich: asyncNoop, onMarkSent: asyncNoop }), "Replied"],

    // ── outreach/OutreachBoard.jsx ──
    ["KanbanColumn", () => createElement(KanbanColumn, { title: "Prospected", count: 3, color: "#94A1B5", onBatchGenerate: noop, batchLabel: "Generate All" }), "Prospected"],
    ["BulkActionsBar", () => createElement(BulkActionsBar, { count: 2, onSnooze: noop, onReject: noop, onGenerate: noop, onClear: noop, generating: false }), "2 selected"],
    ["UndoToast", () => createElement(UndoToast, { message: "3 snoozed", onUndo: noop, onDismiss: noop }), "Undo"],
    ["ShortcutHelp", () => createElement(ShortcutHelp, { onClose: noop }), "Keyboard shortcuts"],
    ["ReplyTriageSummary", () => createElement(ReplyTriageSummary, { cards: BOARD_CARDS, onJumpToCard: noop }), "Reply triage"],
    ["DailyPlays", () => createElement(DailyPlays, { cards: BOARD_CARDS, onFilter: noop, onJumpToCard: noop }), "plays"],
    ["PipelineFunnel", () => createElement(PipelineFunnel, { cards: BOARD_CARDS }), "Pipeline value"],
    ["ChainGroup", () => createElement(ChainGroup, { primary: CHAIN_CARD("c1", "Northside Dental — Wicker Park"), rest: [CHAIN_CARD("c2", "Northside Dental — Logan Square")], chainName: "Northside Dental", toneMemory: [], onStatusChange: noop, onDraftRegenerate: asyncNoop, onToneFeedback: asyncNoop, onEnrich: asyncNoop, onMarkSent: asyncNoop, isSelected: false, onToggleSelect: noop }), "2 locations"],
    ["ChainLocationRow", () => createElement(ChainLocationRow, { card: CHAIN_CARD("c2", "Northside Dental — Logan Square"), onStatusChange: noop }), "Logan Square"],

    // ── analyst/AnalystView.jsx ──
    ["MetricTile", () => createElement(MetricTile, { label: "Total Spend", value: "$12,400", sub: "across all campaigns" }), "Total Spend"],
    ["BarChart", () => createElement(BarChart, { data: CAMPAIGNS, valueKey: "cost", labelKey: "name", color: "#6EA8FE", formatValue: (v) => `$${v}`, title: "Spend by Campaign", targetValue: 2000, targetLabel: "$2k target" }), "Spend by Campaign"],
    ["AnalysisComparison", () => createElement(AnalysisComparison, { current: ANALYSIS_NOW, savedAnalyses: [ANALYSIS_PRIOR] }), "Since Last Analysis"],
    ["UploadCard", () => createElement(UploadCard, { type: { key: "campaign", label: "Campaign / Keyword Report", hint: "Campaign, Keyword, Cost" }, upload: null, onUpload: noop, onRemove: noop }), "Campaign / Keyword Report"],
    ["QuickWinRow", () => createElement(QuickWinRow, { win: { action: "Pause the two campaigns with zero conversions", effortLevel: "low", estimatedImpact: "frees ~$1.2k/mo" }, done: false, last: true, onToggle: noop }), "zero conversions"],
    ["ReasoningTrace", () => createElement(ReasoningTrace, { trace: "Compared spend against last period." }), "How the Agent Reasoned"],

    // ── the remaining feature files ──
    ["BookingModal", () => createElement(BookingModal, { card: REPLIED_CARD, onClose: noop, onBooked: noop }), "Book a meeting"],
    ["ClientDetail", () => createElement(ClientDetail, { client: CLIENT, findings: [], actions: [], onBack: noop, onDelete: noop }), "Auction Insights"],
    ["StepEditor", () => createElement(StepEditor, { step: SEQ_STEP, index: 0, count: 2, onChange: noop, onDelete: noop, onMove: noop }), "after previous send"],
    ["SequenceCard", () => createElement(SequenceCard, { seq: SEQUENCE, steps: [SEQ_STEP], enrolledCount: 4, onSave: asyncNoop, onDelete: noop }), "4 enrolled"],
    ["LeadJourney", () => createElement(LeadJourney, { card: REPLIED_CARD, hasInbound: true }), "Contacted"],
    ["InboundLeadRow", () => createElement(InboundLeadRow, { lead: INBOUND_LEAD, selected: false, showPreview: true, onSelect: noop, onDelete: noop }), "Northside Dental"],
    ["AgentPanel", () => createElement(AgentPanel, { messages: [], input: "", sending: false, endRef: { current: null }, onInput: noop, onSend: noop, onClear: noop, onClose: noop }), "Clarify Assistant"],
    ["QueueItem", () => createElement(QueueItem, { msg: QUEUE_MSG, onDone: noop }), "Following up on your Google Ads"],
    ["MissionControl", () => createElement(MissionControl, { cards: BOARD_CARDS, onNavigate: noop, inboundNew: 2 }), "Mission control"],
    ["MonthCalendar", () => createElement(MonthCalendar, { cards: BOARD_CARDS, hideOpenLink: true }), "This month"],
    ["AnalyticsView (with rows)", () => createElement(AnalyticsView, { cards: BOARD_CARDS }), "Pipeline analytics"],
    ["LoginScreen", () => createElement(LoginScreen, { onLogin: noop }), "Sign in"],
  ];

  it("mounts every component this app ships, and each one draws its own content", () => {
    for (const [name, el, needle] of MOUNTS) {
      let html = "";
      expect(() => { html = paint(el()); }, `${name} threw when mounted`).not.toThrow();
      expect(html, `${name} mounted but rendered nothing recognisable — the mount proves nothing`).toContain(needle);
    }
    // Scan sanity: dropping a row here is how twenty components became
    // unwatched in the first place.
    expect(MOUNTS.length, "the mount table lost entries").toBe(35);
    // …and the twenty the reviewer proved unwatched are all named in it, by the
    // exact name the mutation used.
    const named = new Set(MOUNTS.map(([n]) => n.replace(/ .*$/, "")));
    for (const c of [
      "ThreadModal", "ToneMemoryPanel", "CopyButton", "QuickSendStrip", "PreCallBrief", "CadenceBar",
      "KanbanColumn", "UndoToast", "ShortcutHelp", "ReplyTriageSummary", "DailyPlays", "PipelineFunnel",
      "MetricTile", "BarChart", "AnalysisComparison", "BookingModal", "ClientDetail", "StepEditor",
      "SequenceCard", "LeadJourney",
    ]) {
      expect(named.has(c), `${c} is no longer mounted by this file — it is back to being invisible to every assertion in it`).toBe(true);
    }
  });

  it("leaves the platform as it found it", () => {
    // MissionControl above runs inside withStorage-free code that writes its
    // snapshot from an effect (never run here), but several of these components
    // read the store during render. If any of them WROTE during render, the
    // cold tests earlier in this file would silently start running warm.
    expect(globalThis.localStorage.getItem("sm_mission_snapshot"), "a component wrote to the store during render").toBe(null);
    expect(globalThis.localStorage.getItem("sm_mission_snapshot_prev"), "withStorage leaked the seeded snapshot").toBe(null);
  });
});
