import { useEffect, useRef } from "react";
import { estimateCost } from "@cc/ai";
import { compileGenome, dnaBus, loadGenome, propagate, seedsForTask } from "./dna.js";
import { supabase } from "../supabaseClient";

// ════════════════════════════════════════════════════════════════════════════
// ZTS DNA WORKER — the hands of the mind. It reads the compiled genome, proposes
// real content-marketing tasks (draft an SEO article, draft a Short, draft a
// creator pitch, scout & rank prospected creators, compile a strategy brief,
// grow the mind), and executes ONE per pass. Every result lands where a human
// review click would have put it.
//
// THE WORKER NEVER PUBLISHES. There is no Supabase import here and no code path
// that sets a Short's stage to "posted", an article's stage to "published", or a
// creator past "contacted". The ONLY external write is onArticleDraft() into
// stage "review" — the SEO approval queue. Everything else lands in the worklog,
// the kb, or the suggestions tray. The genome's LOCKED n_pr_review / n_pr_no_publish
// nodes say the same thing in prompt form, and ZTS_GOVERNANCE leads every compiled
// mind with it. (Re-checked at the bottom of executeTask before every return.)
//
// Ported from Clarify's src/lib/dnaWorker.js — same shape (WORKER_DEFAULTS,
// wk/worklog/suggestions stores, pure inShift, pure proposeTasks,
// workerSpendThisHour, executeTask, the headless 2s-poll DnaWorker component,
// evening-shift-overrides-idle, one-task-per-pass, every-failure-caught) — then
// retargeted to ZTS's creators/Shorts/articles domain and its own seams.
//
// SELF-CONTAINED by design (spec §3, option a): App.jsx keeps sm/obs/callClaude/kb
// and the generate fns module-local (nothing exported), so the worker RE-DECLARES
// the tiny primitives against the SAME `zts_` localStorage namespace and composes
// its own task prompts from the compiled mind — making "the graph IS the prompt"
// literal instead of importing App's generators.
// ════════════════════════════════════════════════════════════════════════════

// ─── re-declared primitives (App.jsx lines 18-70, reproduced EXACTLY) ─────────
// Same `zts_` namespace ⇒ the worker shares obs_log / agent_kb / seo_keywords /
// engine state with the running app. Re-declared, not imported, because App.jsx
// exports none of these — dna.js does the identical thing for the genome store.

// localhost ONLY. Read unconditionally, this baked the key into the public
// bundle the moment VITE_ANTHROPIC_API_KEY was ever set in Netlify — deployed
// traffic rides /.netlify/functions/claude and never needs it. Matches the
// guard Clarify already had (apps/clarify/src/config.js).
// BUILD-TIME gate, not a runtime one. `import.meta.env.DEV` is statically
// replaced by Vite with the literal `false` in a production build, so the
// whole ternary folds to "" and the key is NEVER EMITTED into dist.
//
// A `window.location.hostname === "localhost"` check does NOT do this: the
// minifier cannot evaluate it, so it keeps both branches and the key survives
// as a string literal in the shipped JS — readable by anyone who opens
// devtools, even though the code would never USE it off localhost. Verified
// by building with a canary value and grepping dist.
const IS_LOCAL = typeof window !== "undefined" && window.location.hostname === "localhost";
const ANTHROPIC_API_KEY = import.meta.env.DEV ? (import.meta.env.VITE_ANTHROPIC_API_KEY || "") : "";

// Model pricing ($/1M tokens) — needed so the re-declared callClaude can attribute
// costEstimate to obs exactly as App.jsx does. Sonnet id is the pinned "claude-
// sonnet-4-6"; Haiku is "claude-haiku-4-5-20251001".

// localStorage store, prefix `zts_` — copy of App.jsx lines 34-39, except that
// set() REPORTS failure instead of swallowing it. Every worker guard (the hourly
// task cap, the cost cap, the today-dedup) is read back out of localStorage, so a
// silently-dropped write doesn't degrade one lock — it blinds all three at once
// and the daily-constant paid tasks re-fire every cadence tick. All eight Pentagon
// tools share one origin's 5MB budget, and Safari private mode throws outright, so
// this is a real state, not a theoretical one. Callers that back a guard check it.
const sm = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(`zts_${k}`)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(`zts_${k}`, JSON.stringify(v)); return true; } catch { return false; } },
  del: (k) => { try { localStorage.removeItem(`zts_${k}`); } catch {} },
  keys: (prefix) => { const out = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(`zts_${prefix}`)) out.push(k.replace(`zts_${prefix}`, "")); } return out; },
};

// Observability log — copy of App.jsx lines 42-46. callClaude logs here itself.
const obs = {
  getAll: () => sm.get("obs_log") || [],
  // Returns whether the entry actually landed — the cost cap sums this log, so a
  // dropped write means real spend the cap will never see.
  log: (entry) => { const e = { id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ts: new Date().toISOString(), ...entry }; return sm.set("obs_log", [e, ...(sm.get("obs_log") || [])].slice(0, 500)); },
  clear: () => sm.set("obs_log", []),
};

// Claude call — copy of App.jsx lines 49-70 EXACTLY. Signature:
//   callClaude({system, messages, model, maxTokens, fn}) → string | null
// Returns the raw text ("" on an empty completion → treated as failure by callers)
// or null on a transport error, logs its own obs entry, defaults to Haiku, and
// NEVER sends temperature or top_p. Deployed → the Netlify proxy that holds the
// key; localhost → the direct browser-access header.
async function callClaude({ system, messages, model = "claude-haiku-4-5-20251001", maxTokens = 1024, fn = "generate" }) {
  const t0 = Date.now();
  try {
    const isDeployed = window.location.hostname !== "localhost";
    const url = isDeployed ? "/.netlify/functions/claude" : "https://api.anthropic.com/v1/messages";
    let bearer = null;
    if (isDeployed) { try { bearer = (await supabase?.auth.getSession())?.data?.session?.access_token || null; } catch {} }
    const headers = isDeployed
      ? { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }
      : { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
    const body = { model, max_tokens: maxTokens, messages };
    if (system) body.system = system;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const data = await res.json();
    const text = data.content?.map(b => b.type === "text" ? b.text : "").join("") || "";
    const inTok = data.usage?.input_tokens || Math.round(JSON.stringify(messages).length / 4);
    const outTok = data.usage?.output_tokens || Math.round(text.length / 4);
    obs.log({ fn, model, inputTokens: inTok, outputTokens: outTok, costEstimate: estimateCost(model, inTok, outTok), latencyMs: Date.now() - t0, ok: !!text });
    return text;
  } catch (e) {
    obs.log({ fn, model, ok: false, latencyMs: Date.now() - t0 });
    return null;
  }
}

// Knowledge base (agent_kb) — copy of App.jsx lines 445-450 (read side + the
// array-form add the strategy/scout tasks write insights through). kb.add takes
// an ARRAY of entries and returns how many it stamped in.
const kb = {
  all: () => sm.get("agent_kb") || [],
  add: (entries) => { if (!entries || !entries.length) return 0; const ex = sm.get("agent_kb") || []; const stamped = entries.map(e => ({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ts: new Date().toISOString(), ...e })); sm.set("agent_kb", [...stamped, ...ex].slice(0, 400)); return stamped.length; },
};


// ─── ZTS creator-fit value model (App.jsx lines 76-101, reproduced locally) ───
// The scout/pitch/strategy tasks rank creators by value the same way the app's
// Creator Scout agent does: reach weighted by niche relevance to Bitcoin self-
// custody and by engagement. A 50k self-custody channel outranks a 500k general-
// tech one — the doctrine's "niche fit over raw reach", made arithmetic.
const NICHE_FIT = [
  { match: ["self custody", "self-custody", "hardware wallet", "seed phrase", "cold storage", "privacy"], weight: 1.0, label: "Self-Custody" },
  { match: ["bitcoin", "btc", "satoshi", "lightning"], weight: 0.9, label: "Bitcoin" },
  { match: ["crypto", "cryptocurrency", "altcoin", "ethereum", "defi"], weight: 0.6, label: "Crypto" },
  { match: ["finance", "investing", "money", "wealth"], weight: 0.4, label: "Finance" },
  { match: ["tech", "security", "cybersecurity", "privacy tech"], weight: 0.5, label: "Tech/Security" },
];
function nicheFit(creator) {
  const text = `${creator.channel_name || ""} ${creator.niche || ""} ${creator.description || ""}`.toLowerCase();
  const hit = NICHE_FIT.find(n => n.match.some(m => text.includes(m)));
  return hit || { weight: 0.25, label: "General" };
}
function creatorValue(creator) {
  const subs = creator.subscriber_count || 0;
  const fit = nicheFit(creator);
  const engagement = creator.engagement_rate != null ? creator.engagement_rate : 0.04; // default 4%
  const score = Math.round(subs * fit.weight * Math.min(engagement / 0.04, 2.5));
  return { score, fitLabel: fit.label, fitWeight: fit.weight, tier: score >= 40000 ? "Prime" : score >= 12000 ? "Strong" : score >= 3000 ? "Fit" : "Light" };
}
function fmtSubs(n) {
  if (!n) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
}


// ════════════════════════════════════════════════════════════════════════════
// WORKER CONFIG
// ════════════════════════════════════════════════════════════════════════════

export const WORKER_DEFAULTS = {
  running: false,                                          // master switch — $0 until you flip it
  eveningShift: { enabled: false, start: "18:00", end: "23:00" }, // works while you eat dinner
  cadenceSec: 30,                                          // seconds between work passes
  maxTasksPerHour: 6,                                      // serial + calm, never a firehose
  hourlyCostCap: 0.25,                                     // $ ceiling on the worker's hourly spend
  // Which hands are live. article + scout + strategy + grow ship on by default;
  // short + pitch are OFF (they need a specific target and cost tokens) — flip
  // them on in the dock when you want the worker drafting those too.
  taskTypes: { short: false, article: true, pitch: false, scout: true, strategy: true, grow: true },
};

// Kinds that can reach a paid model call. When the cost cap trips these go dark;
// `scout` (pure ranking) and `grow` (pure kb scan) are free and stay available,
// so the mind keeps working — surfacing targets and growing — even when broke.
const PAID_KINDS = ["article", "short", "pitch", "strategy"];

// Which skill node in the genome owns each task kind. This is what makes the
// graph FUNCTIONAL rather than decorative: silence "Draft an SEO article" on the
// canvas and the worker stops proposing articles — no separate setting, the mind
// IS the config. Keys match dna.js's TASK_SKILL and the worker's taskTypes.
const SKILL_FOR_KIND = {
  short: "n_sk_short", article: "n_sk_article", pitch: "n_sk_pitch",
  scout: "n_sk_scout", strategy: "n_sk_strategy", grow: "n_sk_grow",
};

// Per-kind fn names the worker's callClaude logs to obs. Every worker call is
// dna_-prefixed, so workerSpendThisHour() (which matches the dna_ prefix) already
// captures the WHOLE bill for the cost cap — no separate seam-spend accounting is
// needed the way the Clarify reference needed it (its seams logged non-dna_ fns).
// These stay per-kind only for per-task worklog cost attribution via costSince().
const SEAM_FNS = {
  article: ["dna_article"], short: ["dna_short"], pitch: ["dna_pitch"],
  strategy: ["dna_strategy"], scout: [], grow: [],
};


// ─── control + stores (sm-backed, same layer as the app's engine) ────────────
export const wk = {
  // Deep-merge the nested objects so a partial patch (an older build, or a user
  // toggling one task type) never wipes its siblings back to nothing.
  get: () => {
    const c = sm.get("dna_worker_ctrl") || {};
    return {
      ...WORKER_DEFAULTS, ...c,
      eveningShift: { ...WORKER_DEFAULTS.eveningShift, ...(c.eveningShift || {}) },
      taskTypes: { ...WORKER_DEFAULTS.taskTypes, ...(c.taskTypes || {}) },
    };
  },
  set: (patch) => sm.set("dna_worker_ctrl", { ...wk.get(), ...patch }),
  setTask: (key, on) => { const c = wk.get(); wk.set({ taskTypes: { ...c.taskTypes, [key]: on } }); },
};

const stamp = () => ({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ts: new Date().toISOString() });

export const worklog = {
  all: () => sm.get("dna_worklog") || [],
  // entry: {kind, title, status:"done"|"failed"|"skipped", detail, cost, durationMs,
  //         trace:{seeds,levels,...}, dedupKey, keyword?, creatorId?, draft?} —
  //         id/ts stamped here. dedupKey rides on every entry because
  //         proposeTasks' today-dedup reads it back off the log.
  // Returns null when the write did not land. The worklog IS the hourly task cap
  // and the today-dedup — an entry that never persisted means the task counts as
  // never attempted, so the tick has to fail closed rather than trust `stamped`.
  add: (entry) => {
    const stamped = { ...stamp(), ...entry };
    if (!sm.set("dna_worklog", [stamped, ...worklog.all()].slice(0, 300))) return null;
    return stamped;
  },
  clear: () => sm.set("dna_worklog", []),
};

export const suggestions = {
  all: () => sm.get("dna_suggestions") || [],
  // A suggestion is a node the mind wants to grow: {label, region, text, dedupKey}.
  // Dedup by dedupKey — dismissed counts as handled, so the mind doesn't nag twice
  // about the same learning. Returns null on a dupe so callers can tell.
  add: (s) => {
    const all = suggestions.all();
    if (s.dedupKey && all.some(x => x.dedupKey === s.dedupKey)) return null;
    const stamped = { ...stamp(), resolved: false, accepted: null, ...s };
    sm.set("dna_suggestions", [stamped, ...all].slice(0, 60));
    return stamped;
  },
  resolve: (id, accepted) => sm.set("dna_suggestions", suggestions.all().map(x =>
    x.id === id ? { ...x, resolved: true, accepted: !!accepted, resolved_at: new Date().toISOString() } : x
  )),
};


// ─── inShift — pure clock math, overnight-aware ──────────────────────────────
// "HH:MM"→"HH:MM" in the browser's local time. Start inclusive, end exclusive
// (an 18:00→23:00 shift starts working AT 18:00 and stops AT 23:00). start > end
// wraps midnight (22:00→02:00 covers 23:30 and 01:59 but not 12:00). start === end
// is a zero-length window — never in shift (a "24h shift" is what `running` is
// for). Malformed times fail closed.
export function inShift(shift, now = new Date()) {
  const parse = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
    if (!m || +m[1] > 23 || +m[2] > 59) return null;
    return (+m[1]) * 60 + (+m[2]);
  };
  const start = parse(shift?.start), end = parse(shift?.end);
  if (start === null || end === null || start === end) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return start < end ? t >= start && t < end : t >= start || t < end;
}


// ─── proposeTasks — PURE. What would the mind do right now? ──────────────────
// Reads only its arguments; every impure source (seo_keywords, kb learnings, the
// suggestions store, the clock) arrives via `opts` so the tick feeds it live data
// and tests feed it fixtures. Returns [{kind, title, keyword?, creatorId?,
// dedupKey}] in execution-priority order — the tick takes tasks[0].
//
// Priority is FREE-FIRST cost discipline + the main deliverable high: scout (free
// ranking) → article (the automated SEO draft) → pitch (a specific warm creator)
// → short (cadence draft) → the once-a-day strategy brief → the once-a-day grow
// ritual. Every once-daily kind carries a constant dedupKey so today-dedup gates
// it to a single run.
export function proposeTasks(creators, shorts, articles, genome, log, opts = {}) {
  const {
    taskTypes = WORKER_DEFAULTS.taskTypes,
    now = new Date(),
    seoKeywords = "",     // raw newline string from sm.get("seo_keywords") (passed by the tick)
    learnings = [],       // kb entries of type "learning" (tick passes kb.all() filtered)
    pastSuggestions = [], // suggestions.all() — what the mind already proposed
  } = opts;
  const cs = creators || [], sh = shorts || [], ar = articles || [];

  // Today-dedup: a {kind,dedupKey} pair attempted today — done, failed, or
  // skipped — is not re-proposed. A failing task gets one shot per day, not an
  // infinite retry loop burning the task budget. "Today" is the LOCAL calendar
  // day (the same clock inShift and the dock's "N tasks today" read), so the
  // gates roll at the user's midnight — NOT UTC's, which would reset mid-evening
  // and let every once-per-day ritual run (and pay) twice in one shift.
  const day = (d) => new Date(d).toDateString();
  const today = day(now);
  const doneToday = new Set((log || [])
    .filter(e => e.ts && day(e.ts) === today)
    .map(e => `${e.kind}:${e.dedupKey}`));
  const fresh = (kind, key) => !doneToday.has(`${kind}:${key}`);

  // A kind runs only if its control toggle is on AND its skill node is awake in
  // the genome — the canvas's enable switch is a real off switch for the worker.
  const skillAwake = (kind) => {
    const n = (genome?.nodes || []).find(x => x.id === SKILL_FOR_KIND[kind]);
    return !!n && n.enabled !== false;
  };
  const on = (kind) => taskTypes[kind] === true && skillAwake(kind);

  const tasks = [];

  // scout — FREE heuristic, once/day. Needs prospected creators to rank. Cheapest
  // useful move, so it leads (Haiku-first ⇒ free-first).
  if (on("scout") && fresh("scout", "scout_daily") && cs.some(c => c.status === "prospected")) {
    tasks.push({ kind: "scout", title: "Scout & rank prospected creators", dedupKey: "scout_daily" });
  }

  // article — SEO cadence, at most 1/pass. Pick an uncovered keyword from the
  // seo_keywords list not already targeted by an existing article (matched on
  // target_keyword/keyword) and not already drafted today. dedupKey = the keyword.
  if (on("article")) {
    const kws = String(seoKeywords || "").split("\n").map(k => k.trim()).filter(Boolean);
    const covered = new Set(ar.map(a => String(a.target_keyword || a.keyword || "").toLowerCase()).filter(Boolean));
    const kw = kws.find(k => !covered.has(k.toLowerCase()) && fresh("article", k));
    if (kw) tasks.push({ kind: "article", title: `Draft SEO article — "${kw}"`, keyword: kw, dedupKey: kw });
  }

  // pitch — one specific, highest-value prospected creator (when enabled). A pitch
  // needs a real target, so it ranks prospected creators by value and takes the
  // top one not yet pitched today. NEVER advances the creator's status — draft only.
  if (on("pitch")) {
    const pick = cs.filter(c => c.status === "prospected" && c.channel_name)
      .map(c => ({ c, v: creatorValue(c) }))
      .sort((a, b) => b.v.score - a.v.score)
      .find(({ c }) => fresh("pitch", `pitch_${c.id}`));
    if (pick) tasks.push({ kind: "pitch", title: `Draft pitch — ${pick.c.channel_name}`, creatorId: pick.c.id, dedupKey: `pitch_${pick.c.id}` });
  }

  // short — draft a Short package to feed the posting cadence (when enabled,
  // once/day). Lands in the worklog for review — never a shorts row, never posted.
  if (on("short") && fresh("short", "short_daily")) {
    tasks.push({ kind: "short", title: "Draft a Short package", dedupKey: "short_daily" });
  }

  // strategy — the daily brief, once/day (constant dedupKey + today-dedup = the
  // once-a-day gate). Needs a machine to brief on.
  if (on("strategy") && (cs.length + sh.length + ar.length) > 0 && fresh("strategy", "strategy_daily")) {
    tasks.push({ kind: "strategy", title: "Compile strategy brief", dedupKey: "strategy_daily" });
  }

  // grow — once/day, and only when the kb holds a learning the mind hasn't already
  // turned into a suggestion (matched by the dedupKey stored on the suggestion).
  // No material → no proposal, so the daily slot isn't wasted.
  if (on("grow") && fresh("grow", "grow_scan")) {
    const reflected = new Set((pastSuggestions || []).map(s => s.dedupKey));
    if ((learnings || []).some(e => !reflected.has(`kb_${e.dedupKey || e.id}`))) {
      tasks.push({ kind: "grow", title: "Grow the mind", dedupKey: "grow_scan" });
    }
  }

  return tasks;
}


// ─── cost accounting ─────────────────────────────────────────────────────────
// The worker's whole spend: obs entries whose fn carries the dna_ prefix
// (dna_article/dna_short/dna_pitch/dna_strategy here; dna_pulse from the DNA tab)
// in the last hour. Because EVERY worker call is dna_-prefixed, this single sum is
// a real ceiling on the worker's bill — the tick's cap check reads exactly this.
export function workerSpendThisHour() {
  const hourAgo = Date.now() - 3600000;
  return obs.getAll()
    .filter(l => typeof l.fn === "string" && l.fn.startsWith("dna_") && new Date(l.ts).getTime() > hourAgo)
    .reduce((s, l) => s + (l.costEstimate || 0), 0);
}

// Sum what THIS task cost: obs entries logged since t0 under the kind's known fn.
// Attribution for the work log entry's `cost` field only — the cap uses
// workerSpendThisHour (a single source), so there is no double-booking.
function costSince(t0, kind) {
  const fns = SEAM_FNS[kind] || [];
  if (fns.length === 0) return 0;
  return obs.getAll()
    .filter(l => fns.includes(l.fn) && new Date(l.ts).getTime() >= t0)
    .reduce((s, l) => s + (l.costEstimate || 0), 0);
}

// Squeeze a kb learning into a ≤28-char canvas label, cut on a word boundary.
function learningLabel(text) {
  const t = String(text || "").replace(/^learning:\s*/i, "").trim();
  if (!t) return "New learning";
  if (t.length <= 28) return t;
  const cut = t.slice(0, 28);
  const sp = cut.lastIndexOf(" ");
  return (sp > 12 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, "");
}

// The real creator pipeline stages (App.jsx's CREATOR_STAGES — the only values
// CreatorsView's move() ever writes to status). The snapshot used to count a
// "contacted" bucket that nothing sets, so it always read 0 while every creator
// sitting in drafted or sent was counted nowhere — the brief told the model to go
// prospect work that was already done, and the numbers didn't sum to the total.
const CREATOR_STAGE_KEYS = ["prospected", "drafted", "sent", "replied", "collab"];

// A compact, number-dense snapshot of the machine — the strategy brief's facts
// block, so the model cites real state instead of inventing it (n_pr_review and
// "cite the signal behind every claim" would like a word). Kept cheap for Haiku.
function buildSnapshot(creators, shorts, articles) {
  const cs = creators || [], sh = shorts || [], ar = articles || [];
  const cBy = (s) => cs.filter(c => c.status === s).length;
  const topProspect = cs.filter(c => c.status === "prospected" && c.channel_name)
    .map(c => ({ c, v: creatorValue(c) }))
    .sort((a, b) => b.v.score - a.v.score)[0];
  const shBy = (st) => sh.filter(s => s.stage === st).length;
  const posted = sh.filter(s => s.stage === "posted" && s.posted_at)
    .sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at))[0];
  const daysDark = posted ? Math.floor((Date.now() - new Date(posted.posted_at).getTime()) / 86400000) : null;
  const arBy = (st) => ar.filter(a => a.stage === st).length;
  return [
    `CREATORS: ${cs.length} total — ${CREATOR_STAGE_KEYS.map(k => `${cBy(k)} ${k}`).join(", ")}.${topProspect ? ` Top un-contacted: ${topProspect.c.channel_name} (${fmtSubs(topProspect.c.subscriber_count)} subs, ${topProspect.v.fitLabel}, ${topProspect.v.tier}).` : ""}`,
    `SHORTS: ${sh.length} total — ${shBy("idea")} idea, ${shBy("script")} script, ${shBy("assets")} assets, ${shBy("ready")} ready, ${shBy("posted")} posted.${daysDark != null ? ` ${daysDark} day${daysDark !== 1 ? "s" : ""} since last posted.` : " None posted yet."}`,
    `ARTICLES: ${ar.length} total — ${arBy("idea")} idea, ${arBy("review")} in review, ${arBy("approved")} approved, ${arBy("published")} published.`,
  ].join("\n");
}

// Parse a model's JSON reply the same tolerant way App.jsx's generate* fns do —
// strip any markdown fences, then JSON.parse. Returns null on unparseable output.
function parseJson(raw) {
  try { return JSON.parse(String(raw).replace(/```json|```/g, "").trim()); } catch { return null; }
}

// The article contract's fields — the ONLY keys a model reply may contribute to a
// draft row. Spreading the parsed JSON over the trusted fields let a reply
// carrying "stage":"published" land straight in the Published column (where
// blockBack means it can never be stepped back for review) and let it clear
// auto_drafted to hide the "Agent draft" badge; the genome text that shapes the
// system prompt is user- and import-supplied, so that was steerable. Whitelisting
// also keeps a stray model-invented key from failing the Supabase insert.
export const ARTICLE_DRAFT_FIELDS = [
  "target_keyword", "search_intent", "title_tag", "meta_description",
  "slug", "outline", "article_html", "internal_links", "word_count",
];
export function pickArticleFields(pkg) {
  const out = {};
  ARTICLE_DRAFT_FIELDS.forEach(k => { if (pkg && pkg[k] !== undefined) out[k] = pkg[k]; });
  return out;
}

// ─── executeTask — one task, end to end ──────────────────────────────────────
// Emits the activation trace BEFORE doing the work (the canvas lights up as the
// mind acts, not after), composes the task's user prompt from the COMPILED MIND
// (compileGenome ⇒ system) + a per-task instruction, calls callClaude directly
// (self-contained — App.jsx's generate fns are not exported), and returns the
// worklog entry — the tick adds it. Never throws: every failure comes back as a
// status:"failed" entry with the error in `detail`.
//
// INVARIANT (re-checked here): every output is a DRAFT. article → onArticleDraft
// stage "review" (the SEO approval queue); short/pitch → the worklog only; scout
// → worklog + a kb observation; strategy → worklog + a kb insight; grow →
// suggestions. NOTHING sets a Short to "posted", an article to "published", or a
// creator past "contacted", and there is no Supabase seam in this file to do so.
export async function executeTask(task, ctx) {
  const { creators = [], shorts = [], articles = [], genome, onArticleDraft } = ctx || {};
  const t0 = Date.now();

  // Light the mind up FIRST — the canvas animates the mind acting, not reacting.
  const seeds = seedsForTask(genome, task.kind);
  const full = propagate(genome, seeds);
  dnaBus.emit({ type: "activation", seeds, trace: full, label: task.title });

  // Persist only lit nodes — a 300-entry log of mostly-zero level maps would chew
  // localStorage for nothing. order/edgesFired ride along so the work log's
  // hover-replay animates identically to the live firing.
  const levels = {};
  Object.entries(full.levels).forEach(([id, v]) => { if (v > 0) levels[id] = Math.round(v * 1000) / 1000; });
  const trace = { seeds, levels, order: full.order, edgesFired: full.edgesFired };

  const base = { kind: task.kind, title: task.title, keyword: task.keyword, creatorId: task.creatorId, dedupKey: task.dedupKey };
  const finish = (status, detail, extra = {}) => ({ ...base, status, detail, cost: costSince(t0, task.kind), durationMs: Date.now() - t0, trace, ...extra });

  // The skill node owning this kind carries the {model, maxTokens} defaults the
  // seed genome authored (SONNET+1600 for the long article, Haiku otherwise).
  const skill = (genome?.nodes || []).find(n => n.id === SKILL_FOR_KIND[task.kind]) || {};
  const model = skill.model || "claude-haiku-4-5-20251001";
  const maxTokens = skill.maxTokens || 800;

  try {
    switch (task.kind) {
      case "article": {
        // THE payoff: the compiled genome IS the system prompt. Tune a weight on
        // the canvas and the next article thinks differently. The JSON contract
        // lives in the user turn (the mind supplies voice/principles/knowledge).
        const { systemPrompt } = compileGenome(genome);
        const kw = task.keyword;
        const user = `Draft a full SEO article for Zero To Secure targeting this uncovered self-custody keyword a real beginner would search:\n\n"${kw}"\n\nGenuinely useful first, optimized second — no keyword stuffing. Use the keyword naturally in the title, the first paragraph, and 1-2 H2s. Weave in ZTS product relevance without being an ad; suggest internal links to /products, /pages/breach-index, /pages/academy.\n\nRespond ONLY with valid JSON, no preamble or markdown fences:\n{\n  "target_keyword": "the primary keyword",\n  "search_intent": "informational | commercial | transactional",\n  "title_tag": "under 60 chars, keyword near front",\n  "meta_description": "under 155 chars, includes keyword",\n  "slug": "url-slug-here",\n  "outline": ["H2: ...", "H2: ..."],\n  "article_html": "clean HTML (h2/h3/p/ul/li/strong only), 1000-1400 words",\n  "internal_links": [{ "anchor": "anchor text", "target": "/products" }],\n  "word_count": 1200\n}`;
        const raw = await callClaude({ system: systemPrompt, messages: [{ role: "user", content: user }], model, maxTokens, fn: "dna_article" });
        if (!raw) return finish("failed", "No response from model");
        const pkg = parseJson(raw);
        if (!pkg || (!pkg.article_html && !pkg.title_tag)) return finish("failed", "Model returned an empty or unparseable article");
        // The ONLY external write in this file: a DRAFT into stage "review" — the
        // SEO approval queue. A human approves every publish. Never "published".
        // The trusted fields go LAST so no model-supplied key can overwrite them.
        // Awaited and checked: the save can fail (RLS, offline) and used to be
        // swallowed into a console.warn while this returned "done" — and because
        // today-dedup counts any logged attempt as spent, the keyword then sat out
        // the rest of the day with no draft anywhere. Report the save, not the call.
        if (onArticleDraft) {
          const saved = await onArticleDraft({
            id: `a_${Date.now()}`, created_at: new Date().toISOString(),
            ...pickArticleFields(pkg), stage: "review", auto_drafted: true, keyword: kw,
          });
          if (!saved) return finish("failed", "Draft generated but could not be saved to the review queue");
        }
        return finish("done", `"${pkg.title_tag || kw}" (${kw}) → SEO review queue`);
      }

      case "short": {
        // Draft a Short package into the worklog for review ONLY. No shorts row,
        // no stage, absolutely no "posted" — the draft rides on the worklog entry.
        const { systemPrompt } = compileGenome(genome);
        const user = `Draft a complete YouTube Short package for Zero To Secure — under 60 seconds, ~140-160 words of spoken script, with a hook that lands in the first two seconds.\n\nRespond ONLY with valid JSON, no preamble or markdown fences:\n{\n  "hook": "the first 3 seconds — a scroll-stopping spoken line",\n  "script": "~140-160 words, punchy short sentences, written to be read aloud",\n  "title": "YouTube title under 60 chars, high-CTR, no clickbait lies",\n  "description": "2-3 line description with a soft CTA to ZTS",\n  "tags": ["8-12 relevant tags"],\n  "pinned_comment": "a comment to pin that drives engagement or the ZTS link"\n}`;
        const raw = await callClaude({ system: systemPrompt, messages: [{ role: "user", content: user }], model, maxTokens, fn: "dna_short" });
        if (!raw) return finish("failed", "No response from model");
        const pkg = parseJson(raw);
        if (!pkg || (!pkg.script && !pkg.hook)) return finish("failed", "Model returned an empty or unparseable Short");
        return finish("done", `"${pkg.title || pkg.hook || "Short"}" → drafted for review`, { draft: pkg });
      }

      case "pitch": {
        // Draft a personal outreach pitch to a specific creator, into the worklog
        // for review ONLY. The worker never advances a creator past "contacted" —
        // a human reviews and sends. Grounded in real channel facts (cite the signal).
        const creator = creators.find(c => c.id === task.creatorId);
        if (!creator) return finish("skipped", "Creator left the pipeline before the worker reached it");
        const v = creatorValue(creator);
        const { systemPrompt } = compileGenome(genome);
        const user = `Write a personal outreach pitch to this YouTube creator for a Zero To Secure collab. Ground it in something true about their channel and why ZTS fits their audience. Short, warm, specific, one soft ask — a draft for a human to review and send, never auto-sent.\n\nCreator: ${creator.channel_name} — ${fmtSubs(creator.subscriber_count)} subs · niche ${creator.niche || "n/a"} · fit ${v.fitLabel} (${v.tier}).${creator.description ? `\nChannel description: ${creator.description}` : ""}\n\nRespond ONLY with valid JSON, no preamble or markdown fences:\n{ "subject": "email subject line", "body": "the pitch body, 90-140 words" }`;
        const raw = await callClaude({ system: systemPrompt, messages: [{ role: "user", content: user }], model, maxTokens, fn: "dna_pitch" });
        if (!raw) return finish("failed", "No response from model");
        const pitch = parseJson(raw) || { subject: "", body: String(raw).trim() };
        if (!pitch.body) return finish("failed", "Model returned an empty pitch");
        return finish("done", `Pitch for ${creator.channel_name} drafted → review: "${pitch.subject || "(no subject)"}"`, { draft: pitch, creator: creator.channel_name });
      }

      case "strategy": {
        // The evening brief. Compiled mind ⇒ system; a real facts block ⇒ user, so
        // the recommendation cites actual numbers. Haiku, dna_-prefixed fn, and the
        // insight lands in the kb feed the Agents tab already renders.
        const { systemPrompt, hash } = compileGenome(genome);
        const snapshot = buildSnapshot(creators, shorts, articles);
        const user = `Strategy brief. The content-marketing machine's actual state right now:\n\n${snapshot}\n\nIn 2-4 sentences, name the single highest-leverage move across creators, Shorts, and SEO right now and why — specific, actionable, and citing the numbers above. No preamble, no menu of options.`;
        const raw = await callClaude({ system: systemPrompt, messages: [{ role: "user", content: user }], model, maxTokens, fn: "dna_strategy" });
        if (!raw) return finish("failed", "No response from model");
        kb.add([{ agent: "synthesizer", type: "insight", signal: "info", dedupKey: "dna_strategy", text: raw, mindHash: hash }]);
        return finish("done", raw);
      }

      case "scout": {
        // FREE — pure JS ranking, no paid call. Surfaces the top prospected
        // creators by value into the worklog + a kb observation. Rank and
        // recommend; do NOT spend tokens (a pitch is the paid follow-through).
        const ranked = creators.filter(c => c.status === "prospected" && c.channel_name)
          .map(c => ({ c, v: creatorValue(c) }))
          .sort((a, b) => b.v.score - a.v.score);
        if (ranked.length === 0) return finish("skipped", "No prospected creators to scout");
        const top = ranked.slice(0, 3);
        const line = top.map(({ c, v }) => `${c.channel_name} (${fmtSubs(c.subscriber_count)} subs · ${v.fitLabel} · ${v.tier})`).join("; ");
        kb.add([{ agent: "creatorScout", type: "observation", signal: "info", dedupKey: "dna_scout", text: `Scouted ${ranked.length} prospected creator${ranked.length !== 1 ? "s" : ""}. Highest-value targets: ${line}. Prime and Strong convert best for ZTS — reach out first.` }]);
        return finish("done", `Ranked ${ranked.length} — top: ${line}`, { ranked: top.map(({ c, v }) => ({ id: c.id, name: c.channel_name, score: v.score, tier: v.tier })) });
      }

      case "grow": {
        // Free introspection: kb learnings the mind hasn't reflected yet become
        // knowledge-node SUGGESTIONS for the human to accept or dismiss on the
        // canvas. Keyed kb_<dedupKey||id> so the same learning never nags twice.
        // Capped at 3 per run — growth should feel considered, not spammy.
        const reflected = new Set(suggestions.all().map(s => s.dedupKey));
        const material = kb.all()
          .filter(e => e.type === "learning" && !reflected.has(`kb_${e.dedupKey || e.id}`))
          .slice(0, 3);
        if (material.length === 0) return finish("skipped", "No new learnings to reflect");
        const added = [];
        material.forEach(e => {
          const s = suggestions.add({
            label: learningLabel(e.text), region: "knowledge", text: e.text,
            dedupKey: `kb_${e.dedupKey || e.id}`, from: e.agent || "engine",
          });
          if (s) added.push(s.label);
        });
        if (added.length === 0) return finish("skipped", "No new learnings to reflect");
        return finish("done", `Proposed ${added.length} node${added.length !== 1 ? "s" : ""}: ${added.join(", ")}`);
      }

      default:
        return finish("failed", `Unknown task kind "${task.kind}"`);
    }
  } catch (err) {
    return finish("failed", err?.message || "Unknown error");
  }
}


// ─── DnaWorker — the headless component, mounted once at App root ─────────────
// Same loop shape as App.jsx's AgentEngine (lines 1141-1201): a free 2s poll for
// responsive pause, real work only every cadenceSec. It runs when the master
// switch is on OR the evening shift window is open — the shift deliberately has
// NO idle gate (working the evening while nobody's at the keyboard is its whole
// point; the tab just has to stay open — localStorage-and-JS has no server half).
// Guard locks, in order: run gate → cadence gate → hourly task cap → cost cap
// (paid kinds off, free ones through) → propose → execute ONE → worklog.add.
export function DnaWorker({ creators, shorts, articles, onArticleDraft }) {
  const creatorsRef = useRef(creators);
  const shortsRef = useRef(shorts);
  const articlesRef = useRef(articles);
  const onDraftRef = useRef(onArticleDraft);
  useEffect(() => { creatorsRef.current = creators; }, [creators]);
  useEffect(() => { shortsRef.current = shorts; }, [shorts]);
  useEffect(() => { articlesRef.current = articles; }, [articles]);
  useEffect(() => { onDraftRef.current = onArticleDraft; }, [onArticleDraft]);

  useEffect(() => {
    let lastWork = 0;
    let busy = false; // re-entrancy latch — a slow task must not overlap the next pass
    // Fail-closed latch. Every lock below is read back out of localStorage, so
    // once writes start failing the caps freeze at their pre-failure values and
    // the daily-constant kinds re-propose (and re-pay) on every tick. A guard
    // whose write failed has to stop the worker, not wave it through.
    let halted = false;

    const poll = setInterval(async () => {
      if (busy || halted) return;
      const ctrl = wk.get();
      const shiftOn = ctrl.eveningShift.enabled && inShift(ctrl.eveningShift);
      if (!ctrl.running && !shiftOn) return;               // fully off — truly $0
      const now = Date.now();
      if (now - lastWork < ctrl.cadenceSec * 1000) return; // not time for a pass yet
      lastWork = now;
      busy = true;

      try {
        // Lock: hourly task cap — every attempt counts (done, failed, skipped),
        // so a run of failures can't turn into a run of retries.
        const hourAgo = now - 3600000;
        const log = worklog.all();
        const executed = log.filter(e => new Date(e.ts).getTime() > hourAgo).length;
        if (executed >= ctrl.maxTasksPerHour) return;

        // Lock: cost cap — paid kinds go dark, free ones (scout, grow) still run.
        // Every worker call is dna_-prefixed, so workerSpendThisHour() is the whole
        // bill. The dock reads dna_cost_capped to say why the mind went quiet.
        const capped = workerSpendThisHour() >= ctrl.hourlyCostCap;
        sm.set("dna_cost_capped", capped);
        const types = { ...ctrl.taskTypes };
        if (capped) PAID_KINDS.forEach(k => { types[k] = false; });

        // Propose against the live genome + the freshest prop snapshot. Impure
        // sources (keywords, learnings, past suggestions) are read here and passed
        // in so proposeTasks stays pure.
        const genome = loadGenome();
        const tasks = proposeTasks(
          creatorsRef.current || [], shortsRef.current || [], articlesRef.current || [],
          genome, log,
          {
            taskTypes: types, now: new Date(now),
            seoKeywords: sm.get("seo_keywords") || "",
            learnings: kb.all().filter(e => e.type === "learning"),
            pastSuggestions: suggestions.all(),
          }
        );
        if (tasks.length === 0) return;

        // Execute exactly ONE task — serial, calm, watchable on the canvas.
        const task = tasks[0];
        sm.set("dna_current_task", task.title); // the dock's "● Working — …" line
        let entry;
        try {
          entry = await executeTask(task, {
            creators: creatorsRef.current || [], shorts: shortsRef.current || [],
            articles: articlesRef.current || [], genome, onArticleDraft: onDraftRef.current,
          });
        } catch (err) {
          // executeTask fails safe internally; this catches a synchronous surprise
          // so one broken pass never kills the interval.
          entry = { ...task, status: "failed", detail: err?.message || "Unknown error", cost: 0, durationMs: 0, trace: { seeds: [], levels: {} } };
        }
        if (!worklog.add(entry)) {
          // Shed the tail and try once more — the worklog is the biggest thing
          // ZTS holds in localStorage, so trimming usually gets the write in.
          sm.set("dna_worklog", worklog.all().slice(0, 40));
          if (!worklog.add(entry)) {
            halted = true;
            sm.set("dna_worker_halted", "Local storage is full — the worker stopped rather than repeat paid work it cannot record.");
          }
        }
      } catch {} finally {
        sm.del("dna_current_task");
        sm.set("dna_last_tick", now); // the worker's activity heartbeat (the dock reads it)
        busy = false;
      }
    }, 2000);

    return () => clearInterval(poll);
  }, []);

  return null; // headless — the DNA tab is a window onto what this does
}
