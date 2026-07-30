// ─── The store ───────────────────────────────────────────────────────────────
// One plain object, persisted to localStorage, replaced immutably on every
// change. There is no server in the loop: everything SYNC knows lives here, in
// this browser, and leaves only when you export it.
//
// Two properties this file guarantees, because the rest of the app leans on
// them hard:
//   1. Every mutation goes through `commit`, which captures a before-image of
//      exactly the collections it touched. That is what makes *every* action
//      SYNC takes undoable, without a single hand-written inverse operation.
//   2. Writes are debounced but never lost — a pagehide/visibilitychange flush
//      means closing the tab mid-sentence doesn't drop the last five seconds.

import { id } from "../lib/id.js";
import { dayKey, minsOfDay } from "../lib/time.js";
import { seedMind } from "@cc/mind";

export const KEY = "sync.state.v1";
export const SCHEMA = 1;

/* ── the shape ─────────────────────────────────────────────────────────────── */
export function emptyState() {
  return {
    v: SCHEMA,
    createdAt: Date.now(),
    settings: {
      theme: "auto",
      apiKey: "",
      model: "sonnet",
      speak: true,
      ambient: false,          // wake-word listening
      // Hands-free conversation. Off by default, and never resumed on its own
      // after a reload: it holds the microphone open continuously and streams
      // everything it hears to a third party for as long as it runs. That is a
      // state a person should have to choose each time, not inherit.
      handsFree: false,
      auraVoice: "aura-2-thalia-en",
      // Playback rate for the spoken reply, 0.8–1.4. Separate from `rate`, which
      // belongs to the system voice and means something different to it.
      speakRate: 1,
      // brief | normal | full. Reaches the system prompt, because reply length is
      // a property of what gets written, not of how it is read out.
      replyLength: "normal",
      // How eager interrupting is. A named tier rather than a number: the
      // underlying threshold is a margin over a measured noise floor and is not
      // a quantity anyone can reason about directly.
      bargeSensitivity: "normal",
      // Minutes of silence before a conversation ends itself.
      idleMinutes: 5,
      // Reveal the reply in step with the voice instead of all at once.
      syncReveal: true,
      wakeWord: "sync",
      voiceURI: null,
      rate: 1.03,
      pitch: 1,
      webSearch: true,
      onboarded: false,
    },
    profile: {
      name: "",
      role: "",
      workStart: 8 * 60,
      workEnd: 18 * 60,
      ventures: [],
      directives: [],          // standing rules SYNC must obey every turn
    },
    blocks: [],                // the day plan
    tasks: [],
    followups: [],
    notes: [],
    memory: [],                // durable facts SYNC recalls unprompted
    decisions: [],
    drafts: [],
    focus: null,               // the one running focus session, if any
    ledger: [],                // every action SYNC took, newest last
    turns: [],                 // the transcript the UI renders
    history: [],               // the raw message list the model sees
    briefs: [],
    usage: { calls: 0, in: 0, out: 0, cost: 0 },
    // SYNC's mind — the @cc/mind genome, scoped to the `sync` and `shared`
    // domains. Null until first read, then seeded lazily by getMind() so a fresh
    // install and an existing one converge on the same graph without a migration.
    mind: null,
  };
}

/* ── load / migrate ────────────────────────────────────────────────────────── */
function migrate(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;
  // Field-wise merge rather than a spread of the whole object: a state written
  // by an older build is missing keys this build reads, and a shallow spread
  // would hand `undefined` to code that expects an array.
  const out = { ...base, ...raw, v: SCHEMA };
  out.settings = { ...base.settings, ...(raw.settings || {}) };
  out.profile = { ...base.profile, ...(raw.profile || {}) };
  out.usage = { ...base.usage, ...(raw.usage || {}) };
  for (const k of ["blocks", "tasks", "followups", "notes", "memory", "decisions", "drafts", "ledger", "turns", "history", "briefs"]) {
    out[k] = Array.isArray(raw[k]) ? raw[k] : [];
  }
  if (!Array.isArray(out.profile.ventures)) out.profile.ventures = [];
  if (!Array.isArray(out.profile.directives)) out.profile.directives = [];
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyState();
    return migrate(JSON.parse(raw));
  } catch {
    // Corrupt or blocked storage must not stop the app booting. Start fresh;
    // the old value stays on disk untouched in case it can be recovered.
    return emptyState();
  }
}

/* ── the live value ────────────────────────────────────────────────────────── */
let state = load();
const listeners = new Set();

export const getState = () => state;
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

let writeTimer = 0;
let dirty = false;

function persist() {
  dirty = false;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    // Quota is the realistic failure. Shed the two unbounded collections —
    // the transcript and the raw history — and try once more, so the day plan
    // and tasks (the things you can't reconstruct) survive.
    try {
      state = { ...state, turns: state.turns.slice(-40), history: state.history.slice(-24), ledger: state.ledger.slice(-120) };
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch { /* storage is unavailable; the session still works in memory */ }
  }
}

function schedulePersist() {
  dirty = true;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(persist, 400);
}

if (typeof window !== "undefined") {
  const flush = () => { if (dirty) { clearTimeout(writeTimer); persist(); } };
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
}

function emit() {
  schedulePersist();
  for (const fn of listeners) fn();
}

/** Replace state. `patch` is an object or a (state) => object. */
export function set(patch) {
  const next = typeof patch === "function" ? patch(state) : patch;
  if (!next || next === state) return state;
  state = { ...state, ...next };
  emit();
  return state;
}

/* ── undo ──────────────────────────────────────────────────────────────────── */
// `commit` is the only way anything in this app changes a collection. It runs
// the mutation, then files a ledger entry carrying a before-image of exactly
// the collections that were named. Undo restores that image. This is why every
// row in the console's ledger has a working Undo without anyone writing one.
const UNDOABLE = new Set(["blocks", "tasks", "followups", "notes", "memory", "decisions", "drafts", "focus", "profile"]);

// Some actions also created a row in the Pentagon. Those entries carry a
// `remote` descriptor, and undoing them has to reach across the network too.
// The handler is injected (from data/cloud.js) so this file keeps no dependency
// on Supabase and still works with the network unplugged.
let remoteUndoHandler = null;
export function setRemoteUndoHandler(fn) { remoteUndoHandler = fn; }

export function commit({ action, title, detail, touches = [], apply, tone, remote }) {
  const keys = touches.filter((k) => UNDOABLE.has(k));
  const before = {};
  for (const k of keys) before[k] = state[k];

  const patch = apply(state) || {};
  const entryId = id("l");
  const entry = {
    id: entryId,
    action,
    title,
    detail: detail || "",
    tone: tone || null,
    at: Date.now(),
    undo: keys.length ? before : null,
    remote: remote || null,
    undone: false,
  };

  state = { ...state, ...patch, ledger: [...state.ledger, entry].slice(-400) };
  emit();
  return entry;
}

export function undo(entryId) {
  const entry = state.ledger.find((e) => e.id === entryId);
  if (!entry || entry.undone || (!entry.undo && !entry.remote)) return false;

  // Fire the remote half first but never wait on it: the local undo is what the
  // user sees, and a dead network must not block it.
  if (entry.remote && remoteUndoHandler) {
    try { Promise.resolve(remoteUndoHandler(entry.remote)).catch(() => {}); } catch { /* ignore */ }
  }

  state = {
    ...state,
    ...entry.undo,
    ledger: state.ledger.map((e) => (e.id === entryId ? { ...e, undone: true } : e)),
  };
  emit();
  return true;
}

/* ── settings & profile ────────────────────────────────────────────────────── */
export const setSettings = (patch) => set((s) => ({ settings: { ...s.settings, ...patch } }));
export const setProfile = (patch) => set((s) => ({ profile: { ...s.profile, ...patch } }));

/* ── the mind ──────────────────────────────────────────────────────────────── */
/**
 * SYNC's genome, seeded on first read.
 *
 * Lazily rather than in emptyState() for one reason: emptyState() is pure and
 * runs in tests and on the server, and seedMind() would drag a package import
 * into both. Seeding on demand also means an install that predates the mind picks
 * it up on next open with no migration step.
 *
 * Filtered to `sync` + `shared`, because the operator editing this is editing
 * SYNC. The other tools' neurons are real and live in the same seed, but showing
 * them here would invite someone to reweight ZTS's doctrine from a workday app.
 */
export function getMind() {
  if (state.mind) return state.mind;
  const seeded = seedMind({ at: Date.now() });
  const keep = (d) => Array.isArray(d) && d.some((x) => x === "sync" || x === "shared");
  const nodes = seeded.nodes.filter((n) => keep(n.domains));
  const ids = new Set(nodes.map((n) => n.id));
  const mind = {
    ...seeded,
    nodes,
    // Synapses whose other end was filtered out would be dangling, and
    // validateMind() rejects those — so they go with the nodes they described.
    edges: seeded.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
  };
  set({ mind });
  return mind;
}

/** Replace the genome wholesale. The @cc/mind helpers are pure and return a new
 *  graph, so every edit lands here. */
export function setMind(next) {
  if (!next || !Array.isArray(next.nodes)) return getMind();
  set({ mind: next });
  return next;
}

/** Back to the seed. Loses hand-written neurons, which is why the UI confirms. */
export function resetMind() {
  set({ mind: null });
  return getMind();
}

/* ── transcript ────────────────────────────────────────────────────────────── */
export function addTurn(turn) {
  const t = { id: id("t"), at: Date.now(), ...turn };
  set((s) => ({ turns: [...s.turns, t].slice(-200) }));
  return t;
}

export function patchTurn(turnId, patch) {
  set((s) => ({ turns: s.turns.map((t) => (t.id === turnId ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t)) }));
}

export function setHistory(history) {
  // The model's context is capped by message count here and by a token budget
  // in agent/runtime.js. Both matter: this one keeps localStorage small, that
  // one keeps the request affordable.
  set({ history: history.slice(-40) });
}

export function clearConversation() {
  set({ turns: [], history: [] });
}

export function addUsage({ inTok = 0, outTok = 0, cost = 0 }) {
  set((s) => ({ usage: { calls: s.usage.calls + 1, in: s.usage.in + inTok, out: s.usage.out + outTok, cost: s.usage.cost + cost } }));
}

/* ── export / import ───────────────────────────────────────────────────────── */
export function exportState() {
  // The key is the one thing that must never land in a file you might share.
  const { settings, ...rest } = state;
  const { apiKey, ...safeSettings } = settings;
  return JSON.stringify({ ...rest, settings: safeSettings, exportedAt: Date.now() }, null, 2);
}

export function importState(json) {
  const parsed = JSON.parse(json);
  const keptKey = state.settings.apiKey;
  const next = migrate(parsed);
  next.settings.apiKey = parsed?.settings?.apiKey || keptKey;
  state = next;
  emit();
}

export function resetAll({ keepKey = true } = {}) {
  const keptKey = keepKey ? state.settings.apiKey : "";
  const fresh = emptyState();
  fresh.settings.apiKey = keptKey;
  fresh.settings.onboarded = true;
  state = fresh;
  emit();
}

/* ── derived reads the whole app shares ────────────────────────────────────── */
export function blocksFor(s, day = dayKey()) {
  return s.blocks.filter((b) => b.day === day).sort((a, b) => a.start - b.start);
}

export function openTasks(s) {
  return s.tasks.filter((t) => t.status !== "done");
}

export function overdueFollowups(s, day = dayKey()) {
  return s.followups.filter((f) => f.status === "open" && f.due && f.due < day);
}

/** The block happening right now, if any. */
export function currentBlock(s, day = dayKey(), mins = minsOfDay()) {
  return blocksFor(s, day).find((b) => mins >= b.start && mins < b.start + b.mins) || null;
}

/** The next block that hasn't started yet. */
export function nextBlock(s, day = dayKey(), mins = minsOfDay()) {
  return blocksFor(s, day).find((b) => b.start > mins) || null;
}
