// The Pentagon connector, exercised without a network. What matters here is the
// contract around the network call, not the call itself: that the model can only
// name a source that exists, that a signed-out session fails with something a
// person can act on rather than a stack trace, and that a tool which created a
// row upstream files a ledger entry Undo can actually reach.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { installBrowserEnv } from "../../test/env.js";

// Why this mock exists: the original standalone suite ended with process.exit(0)
// because it instantiates a real Supabase client, and a live client holds a
// token-refresh timer open forever — correct in a browser, fatal to a CI run
// that waits for the event loop to drain. Vitest must not call process.exit, so
// the client is replaced instead.
//
// It is mocked at "@cc/supabase" rather than at "../../lib/supabase.js" because
// the monorepo port of lib/supabase.js no longer builds a client of its own —
// it re-exports the shared one (`import { supabase, isConfigured } from
// "@cc/supabase"`) and only adds SYNC's schema helpers and readableError. So
// this is the single place a live client could be constructed, and mocking it
// covers both lib/supabase.js and data/cloud.js (which imports `auth` from
// @cc/supabase directly).
//
// The stub client is deliberately TRUTHY, not null. pentagon.js's guard() reads
// `if (!supabase) return "The Pentagon isn't configured in this build."` before
// it ever looks at the session — a null client would short-circuit there and the
// suite's "and says what to do about it" check (/sign in/i) would be asserting
// against the wrong sentence. A truthy client with no session reproduces exactly
// what the original ran against: configured build, signed out. Every method
// returns the stub or an inert result, so nothing opens a socket or a timer.
vi.mock("@cc/supabase", () => {
  const inert = {
    schema: () => inert,
    from: () => inert,
    select: () => inert,
    insert: () => inert,
    update: () => inert,
    delete: () => inert,
    eq: () => inert,
    gte: () => inert,
    lt: () => inert,
    order: () => inert,
    limit: () => inert,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  };
  return {
    supabase: inert,
    schema: () => inert,
    clarify: () => inert,
    zts: () => inert,
    runway: () => inert,
    auth: {
      getSession: async () => null,
      signIn: async () => {},
      signOut: async () => {},
      onChange: () => () => {},
    },
    isConfigured: () => true,
  };
});

installBrowserEnv();

const store = await import("../../data/store.js");
const { runTool, TOOLS, toolDefs } = await import("../tools.js");
const {
  SOURCES, SOURCE_KEYS, sourceMeta, isPersonal, sourceCatalogue, summarise, daysUntilBirthday,
} = await import("../pentagon-sources.js");

/* ── the registry ──────────────────────────────────────────────────────────── */
describe("the registry", () => {
  it("there are sources", () => expect(SOURCES.length > 0).toBe(true));
  it("keys are unique", () => expect(SOURCE_KEYS.length).toEqual(new Set(SOURCE_KEYS).size));
  it("every source is scoped", () => expect(SOURCES.every((s) => s.scope === "personal" || s.scope === "business")).toBe(true));
  it("every source is described for the model", () => expect(SOURCES.every((s) => s.desc && s.desc.length > 20)).toBe(true));
  it("calendar is personal", () => expect(isPersonal("calendar")).toBe(true));
  it("prospects is not", () => expect(!isPersonal("prospects")).toBe(true));
  it("an unknown source has no metadata", () => expect(sourceMeta("nonsense")).toEqual(null));

  // The catalogue is inlined into the tool description, so a source the model
  // can name but can't read about is a source it will misuse.
  const cat = sourceCatalogue();
  it("the catalogue covers every key", () => expect(SOURCE_KEYS.every((k) => cat.includes(`· ${k} —`))).toBe(true));
});

/* ── the tool surface ──────────────────────────────────────────────────────── */
describe("the tool surface", () => {
  const defs = toolDefs({ webSearch: false });
  const readDef = defs.find((d) => d.name === "pentagon_read");

  it("pentagon_read is offered to the model", () => expect(!!readDef).toBe(true));
  it("its source list is exactly the registry", () => expect(readDef.input_schema.properties.source.enum).toEqual(SOURCE_KEYS));
  it("source is required", () => expect(readDef.input_schema.required).toEqual(["source"]));
  it("pentagon_read is marked readonly", () => expect(TOOLS.pentagon_read.readonly === true).toBe(true));
  it("the writes are not", () => expect(!TOOLS.pentagon_add_event.readonly && !TOOLS.pentagon_capture.readonly).toBe(true));

  // Every Pentagon tool crosses a network, so each must hand back a promise —
  // runTool stays synchronous for the local ones and callers await either.
  for (const name of ["pentagon_read", "pentagon_add_event", "pentagon_capture"]) {
    it(`${name} returns a promise`, () => {
      const out = runTool(name, name === "pentagon_read" ? { source: "calendar" } : { title: "x", kind: "note", body: "x" });
      expect(out && typeof out.then === "function").toBe(true);
    });
  }
});

/* ── signed out, every one of them fails legibly ───────────────────────────── */
describe("signed out, every one of them fails legibly", () => {
  let ledgerBefore;
  let reads;
  let bogus;
  let wrote;
  let captured;

  beforeAll(async () => {
    ledgerBefore = store.getState().ledger.length;

    reads = await runTool("pentagon_read", { source: "calendar" });
    bogus = await runTool("pentagon_read", { source: "definitely_not_a_source" });
    wrote = await runTool("pentagon_add_event", { title: "Dentist", start: "2pm" });
    captured = await runTool("pentagon_capture", { kind: "grocery", body: "milk" });
  });

  it("reading while signed out fails", () => expect(reads.ok).toEqual(false));
  it("and says what to do about it", () => expect(/sign in/i.test(reads.summary)).toBe(true));
  it("an unknown source is refused", () => expect(bogus.ok).toEqual(false));
  it("writing while signed out fails", () => expect(wrote.ok).toEqual(false));
  it("capturing while signed out fails", () => expect(captured.ok).toEqual(false));
  it("a failed Pentagon call files nothing in the ledger", () => expect(store.getState().ledger.length).toEqual(ledgerBefore));
});

/* ── remote undo actually reaches across ───────────────────────────────────── */
// commit() carries the descriptor; undo() hands it to whatever cloud.js
// registered. Proven here with a stub, because the wiring is the fragile part.
describe("remote undo actually reaches across", () => {
  const seen = [];
  let entry;

  beforeAll(() => {
    store.setRemoteUndoHandler((remote) => { seen.push(remote); });

    entry = store.commit({
      action: "pentagon_add_event",
      title: "Calendar · Dentist",
      touches: [],
      remote: { schema: "boardroom", table: "personal_events", id: "abc-123", op: "insert" },
      apply: () => ({}),
    });
  });

  it("the ledger entry carries the remote row", () => expect(entry.remote?.id === "abc-123").toBe(true));
  it("undo succeeds even with no local before-image", () => expect(store.undo(entry.id)).toEqual(true));
  it("and the remote half was dispatched", () => expect(seen.length).toEqual(1));
  it("with the row to delete", () => expect(seen[0].id).toEqual("abc-123"));
  it("undoing twice does nothing more", () => expect(store.undo(entry.id)).toEqual(false));
  it("and does not re-dispatch", () => expect(seen.length).toEqual(1));
});

/* ── what actually leaves the device ───────────────────────────────────────── */
// The single most important property in this file. The Anthropic key lives in
// the same settings object as the theme and the wake word, one spread away from
// being uploaded to a shared database. Assert it, don't trust it.
const cloud = await import("../../data/cloud.js");

describe("what actually leaves the device", () => {
  let doc;

  beforeAll(() => {
    store.setSettings({ apiKey: "sk-ant-secret", model: "opus", wakeWord: "atlas" });
    store.commit({ action: "t", title: "t", touches: ["notes"], apply: (s) => ({ notes: [...s.notes, { id: "n1", text: "hi" }] }) });

    doc = cloud.buildDoc(store.getState());
  });

  it("the API key never travels", () => expect(!("apiKey" in doc.settings)).toBe(true));
  it("and is nowhere in the payload at all", () => expect(!JSON.stringify(doc).includes("sk-ant-secret")).toBe(true));
  it("the rest of settings does travel", () => expect(doc.settings.model).toEqual("opus"));
  it("so does the wake word", () => expect(doc.settings.wakeWord).toEqual("atlas"));
  it("and the collections", () => expect(doc.notes.length === 1).toBe(true));

  for (const k of ["profile", "blocks", "tasks", "followups", "notes", "memory", "decisions", "drafts", "ledger", "briefs", "usage"]) {
    it(`${k} is carried`, () => expect(doc[k] !== undefined).toBe(true));
  }

  // The unbounded collections travel trimmed, or a long-running install
  // eventually pushes a document too big to store.
  describe("the unbounded collections travel trimmed", () => {
    beforeAll(() => {
      store.set({ turns: Array.from({ length: 400 }, (_, i) => ({ id: `t${i}` })) });
    });

    it("the transcript is capped", () => expect(cloud.buildDoc(store.getState()).turns.length).toEqual(120));
    it("and keeps the newest", () => expect(cloud.buildDoc(store.getState()).turns.at(-1).id).toEqual("t399"));
  });

  // The signature is what decides whether there is anything to push.
  describe("the signature", () => {
    let snap;

    beforeAll(() => { snap = store.getState(); });

    it("the same state signs the same twice", () => expect(cloud.sig(cloud.buildDoc(snap))).toEqual(cloud.sig(cloud.buildDoc(snap))));
    it("different content signs differently", () => expect(cloud.sig({ a: 1 }) !== cloud.sig({ a: 2 })).toBe(true));
    it("a real edit changes the signature", () => {
      store.set({ notes: [{ id: "n2", text: "changed" }] });
      expect(cloud.sig(cloud.buildDoc(store.getState())) !== cloud.sig(cloud.buildDoc(snap))).toBe(true);
    });
  });

  // A pulled document must not bring someone else's absent key with it and wipe
  // the one on this device.
  describe("a pulled document", () => {
    beforeAll(() => {
      cloud.applyDoc({ settings: { model: "haiku" }, notes: [], tasks: [] });
    });

    it("a pulled doc keeps the local key", () => expect(store.getState().settings.apiKey).toEqual("sk-ant-secret"));
    it("and adopts the remote settings", () => expect(store.getState().settings.model).toEqual("haiku"));
    it("and the remote collections", () => expect(store.getState().notes.length).toEqual(0));
  });
});

/* ── summaries are for the ear ─────────────────────────────────────────────── */
describe("summaries are for the ear", () => {
  it("an empty calendar", () => expect(summarise("calendar", [])).toEqual("Nothing on the calendar"));
  it("one event names it", () => expect(summarise("calendar", [{ title: "Dentist" }])).toEqual("1 event — Dentist"));
  it("notes pluralise", () => expect(summarise("notes", [{}, {}])).toEqual("2 notes"));
  it("one note does not", () => expect(summarise("notes", [{}])).toEqual("1 note"));
  it("upkeep counts what's due", () => expect(summarise("upkeep", [{ due: true }, { due: false }])).toEqual("1 upkeep item due"));
  it("a clear grocery list says so", () => expect(summarise("groceries", [])).toEqual("Grocery list is clear"));
  it("the pipeline reads as a sentence", () => expect(summarise("pipeline", { prospects: 27, new_leads: 2, replies_7d: 3 }).includes("27 prospects")).toBe(true));
  it("findings flag the serious ones", () => expect(summarise("findings", [{ severity: "high" }, { severity: "low" }])).toEqual("2 findings, 1 serious"));
});

/* ── birthdays wrap the year ───────────────────────────────────────────────── */
describe("birthdays wrap the year", () => {
  const jun15 = new Date(2026, 5, 15);
  it("today is zero days away", () => expect(daysUntilBirthday(6, 15, jun15)).toEqual(0));
  it("later this year counts forward", () => expect(daysUntilBirthday(6, 25, jun15)).toEqual(10));
  it("already past rolls to next year", () => expect(daysUntilBirthday(1, 1, jun15) > 180).toBe(true));
});
