// The store's contract: every mutation is undoable, persistence survives a
// reload, and a corrupt or partial saved state never stops the app booting.

import { describe, it, expect, beforeAll } from "vitest";
import { installBrowserEnv } from "../../test/env.js";

installBrowserEnv();

const store = await import("../store.js");
const { dayKey } = await import("../../lib/time.js");

// The original runs top-to-bottom, so state accumulates from one check to the
// next. Vitest keeps declaration order within a file, and a nested suite's
// beforeAll fires at the point the suite is declared — so the same sequence is
// preserved by putting each section's setup in its own beforeAll.

/* ── shape ─────────────────────────────────────────────────────────────────── */
describe("shape", () => {
  let s0;
  beforeAll(() => { s0 = store.getState(); });

  it("schema version", () => expect(s0.v).toEqual(1));
  it("starts with an empty plan", () => expect(Array.isArray(s0.blocks) && s0.blocks.length === 0).toBe(true));
  it("starts with an empty ledger", () => expect(s0.ledger.length === 0).toBe(true));
  it("defaults to auto theme", () => expect(s0.settings.theme).toEqual("auto"));
});

/* ── subscribe fires on every commit ───────────────────────────────────────── */
let notified = 0;
let off;

/* ── commit → ledger → undo ────────────────────────────────────────────────── */
describe("commit → ledger → undo", () => {
  let entry;

  beforeAll(() => {
    off = store.subscribe(() => notified++);

    entry = store.commit({
      action: "add_tasks",
      title: "Captured two tasks",
      detail: "a · b",
      touches: ["tasks"],
      apply: (s) => ({ tasks: [...s.tasks, { id: "k1", title: "a", status: "open" }, { id: "k2", title: "b", status: "open" }] }),
    });
  });

  it("commit applied the patch", () => expect(store.getState().tasks.length).toEqual(2));
  it("commit filed a ledger entry", () => expect(store.getState().ledger.length).toEqual(1));
  it("ledger entry carries a before-image", () => expect(!!entry.undo && Array.isArray(entry.undo.tasks)).toBe(true));
  it("before-image is the pre-commit value", () => expect(entry.undo.tasks.length).toEqual(0));
  it("subscribers were notified", () => expect(notified > 0).toBe(true));

  // A second commit on the same collection, so undo has to restore the middle
  // state rather than "empty".
  describe("a second commit on the same collection", () => {
    beforeAll(() => {
      store.commit({
        action: "update_task",
        title: "Closed a",
        touches: ["tasks"],
        apply: (s) => ({ tasks: s.tasks.map((t) => (t.id === "k1" ? { ...t, status: "done" } : t)) }),
      });
    });

    it("second commit landed", () => expect(store.getState().tasks.find((t) => t.id === "k1").status).toEqual("done"));

    it("undo of the second commit", () => expect(store.undo(store.getState().ledger[1].id)).toEqual(true));
    it("undo restored the intermediate state", () => expect(store.getState().tasks.find((t) => t.id === "k1").status).toEqual("open"));
    it("undo left both tasks in place", () => expect(store.getState().tasks.length).toEqual(2));
    it("undoing twice is a no-op", () => expect(store.undo(store.getState().ledger[1].id)).toEqual(false));
    it("undo marked the entry", () => expect(store.getState().ledger[1].undone).toEqual(true));
    it("undo of an unknown id is a no-op", () => expect(store.undo("nope")).toEqual(false));

    it("undo of the first commit", () => expect(store.undo(entry.id)).toEqual(true));
    it("first undo emptied the tasks again", () => expect(store.getState().tasks.length).toEqual(0));
  });
});

/* ── a read-only commit is filed but not undoable ──────────────────────────── */
describe("a read-only commit is filed but not undoable", () => {
  let ro;
  beforeAll(() => {
    ro = store.commit({ action: "write_brief", title: "Filed a brief", touches: [], apply: () => ({}) });
  });

  it("no touches means no undo image", () => expect(ro.undo).toEqual(null));
});

/* ── transcript ────────────────────────────────────────────────────────────── */
describe("transcript", () => {
  let t;
  beforeAll(() => { t = store.addTurn({ role: "user", text: "plan my day" }); });

  it("addTurn returns an id", () => expect(!!t.id).toBe(true));

  it("patchTurn edits in place", () => {
    store.patchTurn(t.id, { text: "edited" });
    expect(store.getState().turns.find((x) => x.id === t.id).text).toEqual("edited");
  });

  it("patchTurn accepts a function", () => {
    store.patchTurn(t.id, (prev) => ({ text: prev.text + "!" }));
    expect(store.getState().turns.find((x) => x.id === t.id).text).toEqual("edited!");
  });
});

/* ── usage accumulates ─────────────────────────────────────────────────────── */
describe("usage accumulates", () => {
  beforeAll(() => {
    store.addUsage({ inTok: 1000, outTok: 500, cost: 0.01 });
    store.addUsage({ inTok: 1000, outTok: 500, cost: 0.01 });
  });

  it("usage calls", () => expect(store.getState().usage.calls).toEqual(2));
  it("usage input tokens", () => expect(store.getState().usage.in).toEqual(2000));
  it("usage cost", () => expect(Math.abs(store.getState().usage.cost - 0.02) < 1e-9).toBe(true));
});

/* ── export never carries the key ──────────────────────────────────────────── */
describe("export never carries the key", () => {
  let dump;
  beforeAll(() => {
    store.setSettings({ apiKey: "sk-ant-secret-value" });
    dump = store.exportState();
  });

  it("export omits the API key", () => expect(!dump.includes("sk-ant-secret-value")).toBe(true));
  it("export includes the rest of state", () => expect(dump.includes("\"tasks\"")).toBe(true));
});

/* ── import replaces state but keeps the key ───────────────────────────────── */
describe("import replaces state but keeps the key", () => {
  beforeAll(() => {
    store.importState(JSON.stringify({
      v: 1,
      tasks: [{ id: "x", title: "imported", status: "open" }],
      settings: { model: "opus" },
    }));
  });

  it("import replaced tasks", () => expect(store.getState().tasks.length).toEqual(1));
  it("import kept the local key", () => expect(store.getState().settings.apiKey).toEqual("sk-ant-secret-value"));
  it("import merged settings over defaults", () => expect(store.getState().settings.model).toEqual("opus"));
  it("import filled in missing collections", () => expect(Array.isArray(store.getState().followups)).toBe(true));
  it("import filled in missing profile", () => expect(Array.isArray(store.getState().profile.ventures)).toBe(true));
});

/* ── reset ─────────────────────────────────────────────────────────────────── */
describe("reset", () => {
  beforeAll(() => { store.resetAll({ keepKey: true }); });

  it("reset cleared tasks", () => expect(store.getState().tasks.length).toEqual(0));
  it("reset kept the key", () => expect(store.getState().settings.apiKey).toEqual("sk-ant-secret-value"));
  it("reset marks onboarding done", () => expect(store.getState().settings.onboarded).toEqual(true));

  it("reset can drop the key too", () => {
    store.resetAll({ keepKey: false });
    expect(store.getState().settings.apiKey).toEqual("");
  });
});

/* ── derived reads ─────────────────────────────────────────────────────────── */
describe("derived reads", () => {
  const today = dayKey();

  beforeAll(() => {
    store.set({
      blocks: [
        { id: "b2", day: today, start: 600, mins: 60, title: "second", status: "planned" },
        { id: "b1", day: today, start: 540, mins: 30, title: "first", status: "planned" },
        { id: "b3", day: "2000-01-01", start: 540, mins: 30, title: "other day", status: "planned" },
      ],
      tasks: [{ id: "k1", title: "open", status: "open" }, { id: "k2", title: "shut", status: "done" }],
      followups: [
        { id: "f1", who: "A", status: "open", due: "2000-01-01" },
        { id: "f2", who: "B", status: "open", due: null },
      ],
    });
  });

  it("blocksFor filters by day", () => expect(store.blocksFor(store.getState(), today).length).toEqual(2));
  it("blocksFor sorts by start", () => expect(store.blocksFor(store.getState(), today).map((b) => b.id)).toEqual(["b1", "b2"]));
  it("openTasks excludes done", () => expect(store.openTasks(store.getState()).length).toEqual(1));
  it("overdueFollowups finds the stale one", () => expect(store.overdueFollowups(store.getState(), today).map((f) => f.id)).toEqual(["f1"]));
  it("currentBlock at 9:15", () => expect(store.currentBlock(store.getState(), today, 555)?.id).toEqual("b1"));
  it("currentBlock in a gap", () => expect(store.currentBlock(store.getState(), today, 585)).toEqual(null));
  it("nextBlock from a gap", () => expect(store.nextBlock(store.getState(), today, 585)?.id).toEqual("b2"));
  it("nextBlock after everything", () => expect(store.nextBlock(store.getState(), today, 1400)).toEqual(null));
});

/* ── a corrupt saved state must never stop the boot ────────────────────────── */
// The module reads storage once at import, so this is checked by re-importing
// with a poisoned value under a cache-busting query.
describe("a corrupt saved state must never stop the boot", () => {
  let reloaded;

  beforeAll(async () => {
    off();

    globalThis.localStorage.setItem("sync.state.v1", "{ this is not json");
    reloaded = await import("../store.js?corrupt");
  });

  it("corrupt storage still boots", () => expect(reloaded.getState().v === 1).toBe(true));
  it("corrupt storage starts empty", () => expect(reloaded.getState().tasks.length).toEqual(0));

  // A state saved by an older build is missing keys this build reads.
  describe("a state saved by an older build", () => {
    let migrated;

    beforeAll(async () => {
      globalThis.localStorage.setItem("sync.state.v1", JSON.stringify({ v: 1, tasks: [{ id: "old", title: "kept", status: "open" }] }));
      migrated = await import("../store.js?partial");
    });

    it("partial state keeps what it had", () => expect(migrated.getState().tasks.length).toEqual(1));
    it("partial state gains what it lacked", () => expect(Array.isArray(migrated.getState().briefs)).toBe(true));
    it("partial state gains default settings", () => expect(typeof migrated.getState().settings.model === "string").toBe(true));
  });
});
