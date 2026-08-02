// ═══════════════════════════════════════════════════════════════════════════
// THE OUTBOUND ENGINE CARD FOLDS — and the closed row still answers.
//
// Every assertion here fails against the source as it stood before the fold
// landed: the card had no disclosure, no stored preference, and no derivation
// that could say what a closed row should read.
//
// WHAT THIS FILE CAN AND CANNOT SEE. It renders markup and exercises pure
// functions. It cannot see a 46px touch target, a grid-template-rows
// transition or a colour that only resolves in a browser — those are measured
// by driving the built app (see the report accompanying this change), and this
// repo has shipped two layout bugs behind a green suite for exactly that
// reason. What IS statically decidable is here, in the shape that would have
// caught the failures worth caring about:
//
//   · a fold whose closed state hides the one fact the card exists to report
//   · a preference that survives a reload by overruling the engine's state
//   · a closed row that borrows a confident sentence from an input nobody read
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PHASE } from "@cc/ops/plays.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");

// The panel reads localStorage during render (the seeded open/closed state), so
// the smallest possible platform, same as render.test.jsx supplies.
let store = {};
beforeAll(() => {
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { store = {}; },
  };
});
afterAll(() => { delete globalThis.localStorage; });

const {
  ENGINE_PANEL_PREFS_KEY, normalizeEnginePanelPrefs, loadEnginePanelPrefs,
  saveEnginePanelPrefs, resolveOpen,
} = await import("../features/mission/enginePanelPrefs.js");
const { collapsedRead } = await import("../features/mission/EnginePanel.jsx");

// The phase objects @cc/ops actually produces, not invented shapes. Each is a
// real return of enginePhase(), trimmed to the fields the row reads.
const P = {
  stopped: { phase: PHASE.DISARMED, ok: false, headline: "Stopped", detail: "stopped from the console" },
  unarmed: { phase: PHASE.DISARMED, ok: false, headline: "Nothing runs until you arm it", detail: "Pointed and ready. One tap starts it." },
  blocked: { phase: PHASE.BLOCKED, ok: false, headline: "Last pass failed", detail: "gmail: invalid_grant" },
  waiting: { phase: PHASE.WAITING, ok: true, headline: "2 waiting on you", detail: "Ready to review." },
  quiet: { phase: PHASE.IDLE, ok: true, headline: "Nothing waiting", detail: "All caught up." },
  barren: { phase: PHASE.IDLE, ok: false, headline: "Running, producing nothing", detail: "The last passes did no work." },
};
const base = { loaded: true, err: "", controlRead: true, watching: true, replies: 0, stopReason: null, lastPassMs: null };

describe("the closed row answers 'is it on, and is anything wrong'", () => {
  it("says it is still reading, and does not call that 'nothing is wrong'", () => {
    // The whole point of the three-valued flag. `false` here would mean the
    // card could open on a healthy engine, decide nothing was wrong before a
    // single row had landed, and then never re-check.
    const r = collapsedRead({ ...base, loaded: false, phase: P.quiet });
    expect(r.attention, "an unfetched panel claimed to know nothing was wrong").toBe(null);
    expect(r.line).toBe("Reading state…");
  });

  it("refuses to borrow a phase headline when the control table did not load", () => {
    // enginePhase() sees `global == null` and returns the confident
    // "Nothing runs until you arm it". That sentence is about a row nobody
    // managed to read. This is the exact shape — a missing input rendered as a
    // definite state — that this repo has already shipped once.
    const r = collapsedRead({ ...base, controlRead: false, phase: P.unarmed });
    expect(r.line).toBe("State unreadable — the control table did not load");
    expect(r.line).not.toContain(P.unarmed.headline);
    expect(r.attention).toBe(true);
    expect(r.tone).toBe("bad");
  });

  it("opens itself for a stopped engine, and prints the reason", () => {
    const r = collapsedRead({ ...base, phase: P.stopped, stopReason: "stopped from the console" });
    expect(r.attention, "a stopped engine could stay hidden").toBe(true);
    expect(r.line).toBe("Stopped · stopped from the console");
    expect(r.tone).toBe("bad");
  });

  it("prints the engine's own words for a blocked pass", () => {
    const r = collapsedRead({ ...base, phase: P.blocked });
    expect(r.line).toBe("Last pass failed · gmail: invalid_grant");
    expect(r.attention).toBe(true);
  });

  it("does not mistake a quiet inbox for a broken reply watch", () => {
    // replyPhase.ok goes FALSE on any pass that found no replies, so wiring the
    // fold to it would force the card open on every normal day and the fold
    // would be decoration. `watching` asks whether it is actually running.
    const r = collapsedRead({ ...base, phase: P.quiet, watching: true });
    expect(r.attention).toBe(false);
    expect(r.line).toBe("Nothing waiting");
  });

  it("does say so when reply watch really is not running", () => {
    const r = collapsedRead({ ...base, phase: P.waiting, watching: false });
    expect(r.line).toBe("2 waiting on you · reply watch is not running");
    expect(r.attention).toBe(true);
    expect(r.tone).toBe("warn");
  });

  it("does not repeat the reply-watch bit when the whole system is disarmed", () => {
    // Disarmed means reply watch is down too. Saying it twice spends the row's
    // second slot on a fact its first slot already carried.
    const r = collapsedRead({ ...base, phase: P.stopped, watching: false, stopReason: "stopped from the console" });
    expect(r.line).not.toContain("reply watch");
  });

  it("leads with replies, because a reply outranks everything", () => {
    const r = collapsedRead({ ...base, phase: P.quiet, replies: 3 });
    expect(r.line).toBe("3 replies waiting · Nothing waiting");
    expect(r.attention).toBe(true);
    expect(r.tone).toBe("good");
    expect(collapsedRead({ ...base, phase: P.quiet, replies: 1 }).line).toBe("1 reply waiting · Nothing waiting");
  });

  it("treats drafts waiting for review as work, not as trouble", () => {
    // This is the line between "the fold is useful" and "the fold never
    // closes": the engine drafts on every pass, so if a full queue forced the
    // card open it would be open every day it worked.
    const r = collapsedRead({ ...base, phase: P.waiting });
    expect(r.attention).toBe(false);
    expect(r.line).toBe("2 waiting on you");
  });

  it("still opens for an engine that runs and produces nothing", () => {
    const r = collapsedRead({ ...base, phase: P.barren });
    expect(r.attention).toBe(true);
  });

  it("says a partial read was partial rather than reporting the remains as the whole", () => {
    const r = collapsedRead({ ...base, err: "replies: permission denied", phase: P.quiet });
    expect(r.line.startsWith("some of this did not load")).toBe(true);
    expect(r.attention).toBe(true);
  });

  it("carries the schedule's pulse on the row that says nothing else is happening", () => {
    // "Nothing waiting" alone cannot tell a caught-up engine from one whose
    // cron stopped firing a fortnight ago.
    expect(collapsedRead({ ...base, phase: P.quiet, lastPassMs: 12 * 60_000 }).line)
      .toBe("Nothing waiting · last pass 12m ago");
    // …and it is the first thing the cap drops when something is actually wrong.
    expect(collapsedRead({ ...base, phase: P.stopped, stopReason: "stopped from the console", replies: 1, lastPassMs: 12 * 60_000 }).line)
      .toBe("1 reply waiting · Stopped · stopped from the console");
  });

  it("never renders more than three clauses on one row", () => {
    const r = collapsedRead({ ...base, err: "boom", phase: P.blocked, watching: false, replies: 2 });
    expect(r.line.split(" · ").length).toBeLessThanOrEqual(3);
  });
});

describe("the open/closed choice survives a reload", () => {
  it("normalises anything storage can hold into { open: true|false|null }", () => {
    for (const raw of [null, undefined, 0, "", "open", [], ["open"], { open: "yes" }, { open: 1 }, {}]) {
      expect(normalizeEnginePanelPrefs(raw)).toEqual({ open: null });
    }
    expect(normalizeEnginePanelPrefs({ open: true })).toEqual({ open: true });
    expect(normalizeEnginePanelPrefs({ open: false })).toEqual({ open: false });
  });

  it("never throws on a malformed or unavailable store", () => {
    store = { [ENGINE_PANEL_PREFS_KEY]: "{not json" };
    expect(loadEnginePanelPrefs()).toEqual({ open: null });
    const broken = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("SecurityError"); } };
    const real = globalThis.localStorage;
    globalThis.localStorage = broken;
    expect(loadEnginePanelPrefs()).toEqual({ open: null });
    expect(saveEnginePanelPrefs({ open: true })).toEqual({ open: true }); // reports the intent, swallows the write
    globalThis.localStorage = real;
    store = {};
  });

  it("round-trips the operator's answer", () => {
    store = {};
    saveEnginePanelPrefs({ open: false });
    expect(loadEnginePanelPrefs()).toEqual({ open: false });
    expect(JSON.parse(store[ENGINE_PANEL_PREFS_KEY])).toEqual({ open: false });
    saveEnginePanelPrefs({ open: true });
    expect(loadEnginePanelPrefs()).toEqual({ open: true });
    store = {};
  });

  it("defaults CLOSED, including when the engine needs attention", () => {
    // The closed state line reports the stop; the card itself does not consume
    // the Mission view until the operator chooses to open it.
    expect(resolveOpen({ open: null })).toBe(false);
    expect(resolveOpen({ open: true })).toBe(true);
    expect(resolveOpen({ open: false })).toBe(false);
  });

  it("accepts the absence of a preference as closed", () => {
    expect(resolveOpen(null)).toBe(false);
  });

  it("uses a key of its own, and DESIGN.md §7 pins it at every site", () => {
    expect(ENGINE_PANEL_PREFS_KEY).toBe("cc_clarify_engine_panel");
    const prefs = read("features", "mission", "enginePanelPrefs.js");
    expect(prefs.split('"cc_clarify_engine_panel"').length - 1, "the key is spelled out more than once — a partial rename is how this repo already shipped a patch that landed in 3 of 4 places").toBe(1);
  });
});

describe("the disclosure is the whole title row, on the kit's motion", () => {
  const src = read("features", "mission", "EnginePanel.jsx");

  it("makes the title row itself the control, not a word beside it", () => {
    // A 12.5px "expand" is a ~70px invisible target on a phone. .cell is the
    // kit's full-width 46px row, which is what makes the target real.
    expect(src).toMatch(/aria-expanded=\{open\}[\s\S]{0,80}className="cell tappable"/);
    expect(src).toMatch(/aria-controls=\{BODY_ID\}/);
  });

  it("uses the kit's expand transition and defines no keyframe of its own", () => {
    // DESIGN.md §6: keyframe names are document-global and the kit owns them.
    // A grid-template-rows transition adds nothing to that namespace at all.
    expect(src).toMatch(/className=\{`expand\$\{open \? " open" : ""\}`\}/);
    expect(src, "an app-level @keyframes would land in the namespace all nine tools share").not.toMatch(/@keyframes/);
    expect(src, "a local animation would need a name, and every name is taken globally").not.toMatch(/animation:/);
  });

  it("keeps the closed body out of the tab order rather than merely invisible", () => {
    // overflow:hidden clips it; it does not stop Tab landing on a draft's Send
    // button inside a card that looks shut.
    expect(src).toMatch(/aria-hidden=\{!open\}/);
    expect(src).toMatch(/inert=\{open \? undefined : ""\}/);
  });

  it("leaves the off switch and both messages OUTSIDE the fold", () => {
    // "Turn off" is pressable while the card is shut, so its error and its
    // confirmation have to be visible while the card is shut. A control whose
    // result you cannot see has not reported.
    const header = src.slice(src.indexOf("THE WHOLE TITLE ROW"), src.indexOf("<Fold open={open}"));
    expect(header, "the off switch moved into the fold — the engine would have a state you cannot reverse without opening a card").toMatch(/mine\.enabled === true \? "Turn off" : "Turn on"/);
    expect(header, "the error message moved into the fold").toMatch(/\{err && <Msg tone=\{T\.red\} top>/);
    expect(header, "the confirmation moved into the fold").toMatch(/\{note && <Msg tone=\{T\.green\} top>/);
  });

  it("colours the closed row with tokens that have a light half", () => {
    // Light mode shipped. A raw #F87171 cannot flip; var(--bad) resolves to the
    // same value in the dark room and to the contrast-checked light one in the
    // other. The card around it is still on T.* — that is the app's standing
    // migration, not something this row reopens.
    const table = /const SUMMARY_TONE = \{([^}]*)\}/.exec(src);
    expect(table, "the closed row's tone table is gone").toBeTruthy();
    expect(table[1]).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
    for (const v of ["--bad", "--warn", "--good", "--muted"]) expect(table[1]).toContain(v);
  });

  it("seeds the open state from storage on the FIRST render", () => {
    // Reading it in an effect instead would paint the card open and then shut
    // it, which is the flash the preference exists to prevent.
    expect(src).toMatch(/useState\(\(\) => resolveOpen\(loadEnginePanelPrefs\(\)\)\)/);
  });

  it("does not let a stopped engine reopen the card after state loads", () => {
    expect(src).not.toContain("forced.current");
    expect(src).not.toContain("if (read.attention) setOpen(true)");
  });
});
