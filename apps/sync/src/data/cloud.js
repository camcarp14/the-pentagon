// ─── The cloud half of the store ─────────────────────────────────────────────
// Local-first stays literally true: every write still lands in localStorage
// first and the app works with the network on fire. This module is the optional
// second copy — sign in and the same day, queue and memory follow you from the
// phone to the desk.
//
// The whole document travels as one jsonb row, because the store is one plain
// object replaced immutably on every change. Sharding it into per-row tables
// would buy nothing but merge conflicts.
//
// How two devices are kept honest: the server row carries a `rev`. Every push
// says which revision it believed it was editing, and the server refuses a
// stale one instead of clobbering. When that happens SYNC does not guess — it
// says so and offers the two answers that actually exist (take theirs, or keep
// mine), because silently resurrecting deleted items is worse than one question.

import { supabase, CONFIGURED, readableError, sync } from "../lib/supabase.js";
import { auth } from "@cc/supabase";
import { getState, set, subscribe, setRemoteUndoHandler } from "./store.js";

/* ── what travels ──────────────────────────────────────────────────────────── */
const DOC_KEYS = [
  "v", "createdAt", "settings", "profile", "blocks", "tasks", "followups",
  "notes", "memory", "decisions", "drafts", "focus", "ledger", "turns",
  "history", "briefs", "usage",
];

// The transcript and the raw model history grow without bound and are the least
// valuable thing to carry across devices, so they travel trimmed.
const CAPS = { turns: 120, history: 30, ledger: 200 };

// Exported because it is the contract, not an implementation detail: this
// function alone decides what leaves the device, and the API key not being in
// its output is a property worth a test rather than a promise.
export function buildDoc(s) {
  const doc = {};
  for (const k of DOC_KEYS) doc[k] = s[k];
  for (const [k, n] of Object.entries(CAPS)) {
    if (Array.isArray(doc[k])) doc[k] = doc[k].slice(-n);
  }
  // The Anthropic key is the one thing that never leaves this browser — not in
  // an export, not in the cloud row, not anywhere.
  const { apiKey, ...safeSettings } = s.settings || {};
  doc.settings = safeSettings;
  return doc;
}

/** Cheap content signature, so "has anything changed since the last push?" survives a reload. */
export function sig(doc) {
  const json = JSON.stringify(doc);
  let h = 5381;
  for (let i = 0; i < json.length; i++) h = ((h * 33) ^ json.charCodeAt(i)) >>> 0;
  return `${json.length}:${h.toString(36)}`;
}

/* ── device label ──────────────────────────────────────────────────────────── */
function deviceName() {
  const ua = navigator.userAgent || "";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Browser";
}
const DEVICE = typeof navigator === "undefined" ? "node" : deviceName();

/* ── the observable bit ────────────────────────────────────────────────────── */
// status: off | signed-out | signing-in | syncing | synced | conflict | error
let cloud = {
  configured: CONFIGURED,
  ready: false,
  user: null,
  owner: false,
  status: CONFIGURED ? "signed-out" : "off",
  message: "",
  rev: 0,
  syncedAt: 0,
  device: DEVICE,
  conflict: null,
};

const watchers = new Set();
export const getCloud = () => cloud;
export function watchCloud(fn) { watchers.add(fn); return () => watchers.delete(fn); }
function patch(next) {
  cloud = { ...cloud, ...next };
  for (const fn of watchers) fn(cloud);
}

/* ── per-user bookkeeping ──────────────────────────────────────────────────── */
const revKey = (uid) => `sync.cloud.rev.${uid}`;
const sigKey = (uid) => `sync.cloud.sig.${uid}`;

let localRev = 0;
let lastSig = "";
let applying = false;   // guards the store subscription while we write a pulled doc in
let pushTimer = 0;
let pollTimer = 0;
let inFlight = null;

function remember(uid) {
  try {
    localStorage.setItem(revKey(uid), String(localRev));
    localStorage.setItem(sigKey(uid), lastSig);
  } catch { /* private mode — we just re-sync next launch */ }
}

function recall(uid) {
  try {
    localRev = Number(localStorage.getItem(revKey(uid))) || 0;
    lastSig = localStorage.getItem(sigKey(uid)) || "";
  } catch {
    localRev = 0;
    lastSig = "";
  }
}

const isDirty = () => sig(buildDoc(getState())) !== lastSig;

/** Does this copy hold anything worth keeping? A fresh install does not. */
function hasContent(s) {
  return Boolean(
    s.blocks?.length || s.tasks?.length || s.followups?.length ||
    s.notes?.length || s.memory?.length || s.decisions?.length ||
    s.drafts?.length || s.briefs?.length || s.profile?.name
  );
}

export function applyDoc(doc) {
  applying = true;
  try {
    const cur = getState();
    set({
      ...doc,
      // Local key wins, always: it is device-scoped by design.
      settings: { ...cur.settings, ...(doc.settings || {}), apiKey: cur.settings.apiKey },
    });
  } finally {
    applying = false;
  }
}

/* ── pull ──────────────────────────────────────────────────────────────────── */
export async function pull({ force = false } = {}) {
  if (!supabase || !cloud.user) return;
  patch({ status: "syncing", message: "" });

  const { data, error } = await sync()
    .from("state")
    .select("doc, rev, device, updated_at")
    .maybeSingle();

  if (error) {
    patch({ status: "error", message: readableError(error) });
    return;
  }

  const uid = cloud.user.id;

  // No row yet: this account has never synced. Seed it from whatever is here.
  if (!data) {
    localRev = 0;
    if (hasContent(getState())) return pushNow();
    lastSig = sig(buildDoc(getState()));
    remember(uid);
    patch({ status: "synced", rev: 0, syncedAt: Date.now(), conflict: null });
    return;
  }

  if (data.rev === localRev && !force) {
    patch({ status: "synced", rev: data.rev, syncedAt: Date.now(), conflict: null });
    return;
  }

  // The server moved on. If this device has nothing unpushed, that's simply the
  // other device's work arriving — take it. If it does, the two have diverged
  // and only the user can say which is right.
  // hasContent() is what stops a first run on a new origin from being called a
  // conflict. A fresh install has no stored signature, so isDirty() is
  // unconditionally true against the empty string — and without this guard the
  // very first launch inside the Pentagon would ask which copy to keep, with
  // "this device" quietly meaning "erase everything on the server".
  if (data.rev > localRev && isDirty() && hasContent(getState()) && !force) {
    patch({ status: "conflict", conflict: { rev: data.rev, doc: data.doc, device: data.device, updatedAt: data.updated_at } });
    return;
  }

  applyDoc(data.doc || {});
  localRev = data.rev;
  lastSig = sig(buildDoc(getState()));
  remember(uid);
  patch({ status: "synced", rev: data.rev, syncedAt: Date.now(), conflict: null });
}

/* ── push ──────────────────────────────────────────────────────────────────── */
async function pushNow() {
  if (!supabase || !cloud.user) return;
  if (inFlight) return inFlight;

  const doc = buildDoc(getState());
  const mySig = sig(doc);

  patch({ status: "syncing", message: "" });
  inFlight = sync().rpc("push", { p_doc: doc, p_rev: localRev || null, p_device: DEVICE });
  const { data, error } = await inFlight;
  inFlight = null;

  if (error) {
    patch({ status: "error", message: readableError(error) });
    return;
  }

  if (data?.accepted) {
    localRev = data.rev;
    lastSig = mySig;
    remember(cloud.user.id);
    patch({ status: "synced", rev: data.rev, syncedAt: Date.now(), conflict: null });
    return;
  }

  patch({ status: "conflict", conflict: { rev: data?.rev, doc: data?.doc, device: data?.device, updatedAt: data?.updated_at } });
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushNow().catch(() => {}); }, 2500);
}

/* ── conflict resolution — the only two honest answers ─────────────────────── */
export async function takeRemote() {
  const c = cloud.conflict;
  if (!c) return;
  applyDoc(c.doc || {});
  localRev = c.rev;
  lastSig = sig(buildDoc(getState()));
  remember(cloud.user.id);
  patch({ status: "synced", rev: c.rev, syncedAt: Date.now(), conflict: null });
}

export async function keepLocal() {
  const c = cloud.conflict;
  if (!c) return;
  // Adopt the server's revision number without its content, so the next push is
  // accepted and this device's copy becomes the truth.
  localRev = c.rev;
  patch({ conflict: null });
  await pushNow();
}

/* ── auth ──────────────────────────────────────────────────────────────────── */
async function checkOwner() {
  if (!supabase) return false;
  const { data, error } = await sync().rpc("is_owner");
  if (error) return false;
  return data === true;
}

async function onSession(session) {
  const user = session?.user || null;

  if (!user) {
    clearTimeout(pushTimer);
    clearInterval(pollTimer);
    localRev = 0;
    lastSig = "";
    patch({ ready: true, user: null, owner: false, status: "signed-out", rev: 0, conflict: null, message: "" });
    return;
  }

  recall(user.id);
  patch({ ready: true, user: { id: user.id, email: user.email }, status: "syncing" });
  patch({ owner: await checkOwner() });
  await pull();

  // Another device's write is only noticed when we look, so look when the
  // window comes back and occasionally while it is up. Cheap: one row.
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.visibilityState === "visible" && cloud.status !== "conflict") pull().catch(() => {});
  }, 60000);
}

// Sign-in, magic links and sign-out are all gone: the shell gates every tool
// behind one login (apps/shell/src/App.jsx renders LoginScreen before any tool
// mounts), so by the time this module has a user there is nothing to ask for.
// What is left is reacting to that session arriving or ending.

/* ── remote undo ───────────────────────────────────────────────────────────── */
// A ledger entry that created a row in the Pentagon carries `remote`, so Undo
// reaches across the network as well as back through local state. The handler
// lives here rather than in store.js so the store keeps no Supabase dependency.
async function undoRemote(remote) {
  if (!supabase || !remote?.table || !remote?.id) return;
  if (remote.op !== "insert") return;
  try {
    await supabase.schema(remote.schema || "boardroom").from(remote.table).delete().eq("id", remote.id);
  } catch { /* the local half of the undo already happened; nothing more to do */ }
}

/* ── start ─────────────────────────────────────────────────────────────────── */
let started = false;

export function startCloud() {
  if (started || !supabase) {
    if (!supabase) patch({ ready: true, status: "off" });
    return;
  }
  started = true;

  setRemoteUndoHandler(undoRemote);

  // The shell has already established the session before this tool mounts, and
  // it owns sign-out too — so we only listen, never authenticate.
  auth.getSession().then((session) => onSession(session)).catch(() => patch({ ready: true }));
  auth.onChange((session) => { onSession(session).catch(() => {}); });

  subscribe(() => {
    if (applying || !cloud.user || cloud.status === "conflict") return;
    schedulePush();
  });

  // Another device's write is only noticed when we look, so look when the
  // window comes back — and flush anything pending when it goes away, which on
  // iOS is the last event a backgrounded tab reliably gets.
  document.addEventListener("visibilitychange", () => {
    if (!cloud.user || cloud.status === "conflict") return;
    if (document.visibilityState === "visible") { pull().catch(() => {}); return; }
    if (isDirty()) { clearTimeout(pushTimer); pushNow().catch(() => {}); }
  });

  // No keepalive beacon any more. Hand-rolling one meant hand-rolling the URL,
  // the apikey and the bearer token — three things @cc/supabase now owns and
  // this module has no business duplicating. The visibilitychange flush above
  // fires before unload on every browser that matters.
  window.addEventListener("pagehide", () => {
    if (!cloud.user || !isDirty() || cloud.status === "conflict") return;
    clearTimeout(pushTimer);
    pushNow().catch(() => {});
  });
}

