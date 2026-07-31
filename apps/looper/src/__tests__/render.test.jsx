// Looper on the shared kit — proved by rendering, not by a green build.
//
// `vite build` was green on a component that threw the moment it mounted and
// took three tools down. react-dom/server executes the whole component body in
// plain Node — no jsdom needed — so a restyle that broke a reference, a prop or
// a hook fails here instead of in the browser.
//
// This imports App.jsx, not Root.jsx. Root's only job is to inject Looper's
// stylesheet into document.head and gate the first paint on it (`if (!styled)
// return null`), and that gate opens in a useEffect — which the server renderer
// never runs. Root cold-renders to nothing by design; App.jsx is Looper's real
// root element and the element that carries data-kit.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Looper from "../App.jsx";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, "..", f), "utf8");

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
afterAll(() => { console.warn = realWarn; console.error = realErr; delete globalThis.localStorage; });
beforeEach(() => { warnings.length = 0; });

// Looper boots entirely out of localStorage — mission, run, journal and chat are
// all useState initialisers over lp_* keys. Node has no localStorage, so a cold
// render lands on the "nothing set up yet" empty state; seeding a fake one is
// what puts the actual status panel (cards, stat tiles, the state pill, the
// journal rows) into the markup this file asserts on. The keys are the app's
// own, untouched by the migration.
const seed = (over = {}) => {
  const store = {
    lp_mission: JSON.stringify({ target: "zts", goal: "Draft 20 ZTS short scripts", direction: "Punchy, no fear-mongering", constraints: "No price predictions" }),
    lp_run: JSON.stringify({ status: "running", startedAt: 1, endsAt: Date.now() + 900000, durationMin: 30, difficulty: "deep", interrupt: "questions", iterations: 3, spendUsd: 0.0123, capUsd: 1, errors: 0, awaiting: "Which angle should script 4 take?" }),
    lp_journal: JSON.stringify([
      { id: "a", iter: 3, ts: 1700000000000, ok: true, focus: "Writing script 3", did: "Wrote the cold open.", output: "# Script 3", next: "Script 4", alignment: "Still one script per iteration.", blocked: false, question: "", progressPct: 40, done: false, tokens: 912, costUsd: 0.004 },
      { id: "b", iter: 2, ts: 1700000000000, ok: false, focus: "iteration failed", did: "proxy 500", output: "", next: "", alignment: "", progressPct: 0, tokens: 0, costUsd: 0 },
    ]),
    lp_chat: JSON.stringify([]),
    ...over,
  };
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: () => {},
    removeItem: () => {},
  };
};

const html = () => renderToStaticMarkup(createElement(Looper));

describe("Looper renders on the kit", () => {
  it("renders cold, with no storage at all", () => {
    delete globalThis.localStorage;
    expect(() => html()).not.toThrow();
  });

  it("renders with a mission in progress", () => {
    seed();
    expect(() => html()).not.toThrow();
  });

  it("opts into the kit on its own root", () => {
    // Looper renders inside the shell's tool slot, so data-kit here reaches this
    // app and nothing else — the same rule the shell follows by keeping it off
    // the wrapper that holds every tool.
    seed();
    expect(html()).toMatch(/<div[^>]*class="lp-root"[^>]*data-kit|<div[^>]*data-kit[^>]*class="lp-root"/);
  });

  it("uses the kit's primitives on the run surface", () => {
    seed();
    const out = html();
    for (const cls of ["card pad-md", "t-label", "t-head", "t-foot", "t-cap", "pill", "dotstatus", "stattile", "stattile-label", "stattile-value", "cell", "btn md"]) {
      expect(out, `expected the kit's .${cls}`).toContain(cls);
    }
  });

  it("uses the kit's empty state when there is nothing set up", () => {
    delete globalThis.localStorage;
    const out = html();
    // An empty state that says what to do next, and a control that does it.
    expect(out).toContain("empty-title");
    expect(out).toContain("empty-sub");
    expect(out).toContain("Set up a mission");
  });

  it("keeps every control that existed before the restyle", () => {
    // toContain() over the whole document is not a control check: the prose
    // "Runs while this tab is open…" contains "Run", so deleting the Run tab
    // outright left this green. Each label has to be the accessible name of an
    // actual <button>/<a>, so only a real control can satisfy it.
    seed();
    const out = html();
    const controls = [...out.matchAll(/<(button|a)\b[^>]*>([\s\S]*?)<\/\1>/g)]
      .map((m) => m[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(controls.length, "no controls were found at all — the scan is broken").toBeGreaterThanOrEqual(3);
    const missing = ["Pause", "Settings", "Answer", "Run", "Mission", "Chat", "Log"]
      .filter((label) => !controls.some((t) => t === label || t.startsWith(`${label} `)));
    expect(missing, `lost these controls: ${missing.join(", ")} — controls on screen: ${controls.join(" | ")}`)
      .toEqual([]);
  });

  it("emits no NaN and no literal 'undefined' into markup", () => {
    seed();
    const out = html();
    expect(out).not.toMatch(/NaN/);
    expect(out).not.toMatch(/(style|class)="[^"]*undefined/);
  });

  it("renders without a React warning", () => {
    seed();
    html();
    const react = warnings.filter((w) => !w.startsWith("[@cc/"));
    expect(react, `React warned:\n${react.join("\n")}`).toEqual([]);
  });
});

describe("Looper obeys the language", () => {
  const css = read("styles.css");
  const jsx = read("App.jsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("has no text under the 10.5px floor", () => {
    // Four labels sat under it: the tab bar at 9px, the difficulty note at 10px,
    // and the aim/strip/chat keys at 9.5px.
    const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(sizes.filter((n) => n < 10.5)).toEqual([]);
    const inline = [...jsx.matchAll(/fontSize:\s*([^,\n}]+)/g)]
      .flatMap((m) => [...m[1].matchAll(/[\d.]+/g)].map((n) => Number(n[0])))
      .filter((n) => Number.isFinite(n) && n > 0);
    expect(inline.filter((n) => n < 10.5)).toEqual([]);
  });

  it("puts no border and shadow on the same element", () => {
    // The card, the bottom bar and the desktop nav bar all had both. The status
    // panel's accent rule is an inset shadow now, not a border.
    const offenders = [];
    for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
      const border = /(^|;)\s*border(-top|-bottom|-left|-right)?:\s*(?!none)/.test(body);
      const shadow = /(^|;)\s*box-shadow:\s*(?!none)/.test(body);
      if (border && shadow) offenders.push(sel.trim());
    }
    expect(offenders).toEqual([]);
  });

  it("uses no decorative font", () => {
    // --lp-display was Syne and --lp-mono was DM Mono; neither ships in this
    // build, so both were webfont names resolving to a silent fallback anyway.
    expect(css).not.toMatch(/Syne|DM Mono/);
    expect(css).toContain("var(--font-mono)");
  });

  it("shouts only through .t-label", () => {
    // Six selectors set text-transform: uppercase by hand. The kit has exactly
    // one class that is allowed to, and the markup uses it.
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
    expect(jsx).not.toMatch(/textTransform/);
    expect(jsx).toContain("t-label");
  });

  it("keeps the iOS zoom workaround on the fields it adopted", () => {
    // The kit's .field is 15px, which iOS zooms into on focus. Compound
    // selectors, so this wins over [data-kit] .field whatever the sheet order.
    expect(css).toMatch(/\[data-kit\] \.field\.lp-input, \[data-kit\] \.field\.lp-area \{ font-size: 16px; \}/);
    expect(css).toContain("16px: iOS zooms smaller inputs");
  });

  it("keeps the canonical bottom-bar geometry verbatim", () => {
    expect(css).toContain("/* CANONICAL bottom-bar geometry — identical to ZTS/Clarify/Runway/Macro. */");
    expect(css).toContain("padding: 4px 6px max(10px, calc(6px + var(--safe-bottom, 0px)));");
  });

  it("leaves no hand-rolled primitive behind", () => {
    // .lp-btn / .lp-card / .lp-tag / .lp-empty / .lp-strip cells are the kit's
    // now; anything still referencing them is a half-migrated call site.
    expect(jsx).not.toMatch(/lp-(btn|card|tag|empty|tiny|sub|num|jbtn)\b/);
    expect(css).not.toMatch(/\.lp-(btn|card|tag|tiny|sub|num|jbtn)\b/);
  });

  it("reads its colours from the shared tokens, not a private copy", () => {
    // Every --lp-* colour var duplicated cssVars("looper") by hand. (The header
    // comment still names them, so this looks for declarations and uses.)
    expect(css).not.toMatch(/var\(--lp-/);
    expect(css).not.toMatch(/--lp-[a-z0-9-]+\s*:/);
    expect(jsx).not.toMatch(/--lp-/);
  });

  it("touches no storage key, table or function path", () => {
    expect(jsx).toContain('const K = (k) => `lp_${k}`');
    expect(jsx).toContain('localStorage.getItem("lp_obs_log")');
    expect(jsx).toContain('"/.netlify/functions/claude"');
  });
});
