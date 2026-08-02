// ═══════════════════════════════════════════════════════════════════════════
// LOOPER — point it at a mission, set how long and how hard, and let it run.
//
// WHAT THE LOOP ACTUALLY IS (stated plainly, because it decides everything):
// this is a browser-driven loop. While the tab is open and the run is active, a
// timer fires an iteration, each one a single authed call to the Pentagon's
// /.netlify/functions/claude proxy. There is no server-side worker, so closing
// the tab pauses the run — it does NOT lose it: mission, journal, chat and spend
// all persist to localStorage, so reopening resumes exactly where it stopped.
// The UI says this out loud rather than implying a 24/7 agent.
//
// THE ONE DESIGN IDEA: every iteration must answer in STRUCTURED JSON, not
// prose. That is what makes "what is it working on / is it still aligned" a
// permanent, always-fresh panel instead of something you have to ask for. The
// model returns focus / did / output / next / alignment / blocked / question /
// progress, so the status box is a data binding, never a summary someone has to
// request. "How's it going?" is answered before it is asked.
//
// SAFETY: it spends money on every tick, so a run has three independent stops —
// a duration, a hard cost cap, and consecutive-error backoff — and it will not
// start without a goal.
// ═══════════════════════════════════════════════════════════════════════════
import { useCallback, useEffect, useRef, useState } from "react";
import { auth } from "@cc/supabase";
import { estimateCost } from "@cc/ai";

/* ─── what it can be pointed at ─────────────────────────────────────────── */
const TARGETS = [
  { id: "zts", label: "ZTS", hint: "Zero To Secure — creators, shorts, SEO" },
  { id: "clarify", label: "Clarify", hint: "Outreach, inbound, clients" },
  { id: "runway", label: "Runway", hint: "Job search, targeting, résumé" },
  { id: "macro", label: "Macro", hint: "MSTR/BTC thesis and levels" },
  { id: "other", label: "Other", hint: "Anything — describe it yourself" },
];

/* ─── difficulty: the model/depth/pace dial ──────────────────────────────────
   Prices are NOT repeated here. They used to be (inP/outP per tier), which made
   Looper the only module that knew claude-opus-5's real rate — every other cost
   table in the app would have priced a Max run at Haiku's, off by 15x. The tier
   picks a model; @cc/ai prices it. */
const DIFFICULTY = {
  draft: { label: "Draft", note: "fast + cheap", model: "claude-haiku-4-5-20251001", maxTokens: 1200, cadence: 45 },
  standard: { label: "Standard", note: "balanced", model: "claude-haiku-4-5-20251001", maxTokens: 2500, cadence: 60 },
  deep: { label: "Deep", note: "slower, better", model: "claude-sonnet-4-6", maxTokens: 4000, cadence: 90 },
  max: { label: "Max", note: "most capable", model: "claude-opus-5", maxTokens: 6000, cadence: 120 },
};

/* ─── interrupt policy: when it is allowed to stop and wait for you ──────────
   `pill` is the phrasing used on the Run tab, where the label alone ("Never")
   is ambiguous out of the settings context — "never pauses" is not. */
const INTERRUPT = {
  silent: { label: "Never", note: "logs, keeps going", pill: "never pauses" },
  questions: { label: "On questions", note: "pauses when it asks", pill: "pauses on questions" },
  blockers: { label: "On blockers", note: "pauses when stuck", pill: "pauses when stuck" },
  always: { label: "Every step", note: "approve each one", pill: "pauses every step" },
};

// Anything read out of localStorage can be from an older build, so never index
// DIFFICULTY/INTERRUPT bare — a renamed tier would throw on render, not degrade.
const DIFF = (id) => DIFFICULTY[id] || DIFFICULTY.standard;
const INT = (id) => INTERRUPT[id] || INTERRUPT.questions;

// Six, not five: the picker is a 3-column grid, so five left a lone orphan cell
// on the last row. Six fills two clean rows at every width.
const DURATIONS = [15, 30, 60, 120, 240, 480];
const IDLE_RUN = {
  status: "idle", startedAt: null, endsAt: null, durationMin: 30,
  difficulty: "standard", interrupt: "questions", notify: false,
  iterations: 0, spendUsd: 0, capUsd: 1, errors: 0, stopReason: null, awaiting: null,
};

/* ─── storage (durable across reloads; the run survives a closed tab) ────── */
const K = (k) => `lp_${k}`;
const load = (k, d) => { try { const v = localStorage.getItem(K(k)); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(K(k), JSON.stringify(v)); } catch {} };
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
// Sub-cent spend needs four places to be visible at all, but an untouched run
// should read "$0.00", not "$0.0000".
const money = (n) => (!n ? "$0.00" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
// Why a run stopped, in words that fit a pill.
const STOP_LABEL = { time: "time up", budget: "cap reached", errors: "errors", completed: "complete" };
const clock = (ms) => {
  if (ms == null || ms < 0) return "—";
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
};
const hhmm = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

/* ─── the model call ─────────────────────────────────────────────────────── */
const SYSTEM = `You are Looper: an autonomous worker executing ONE mission in short, repeated iterations inside a web dashboard.

Each iteration you receive the mission, a journal of what you have already done, and any new notes from the operator. Do ONE concrete increment of real work per iteration and never redo finished work. Build on the journal — later iterations should visibly advance past earlier ones. If the mission is genuinely complete, say so with "done": true rather than padding.

Operator notes are instructions and outrank your current plan. If a note changes direction, follow it and say so in "did".

Respond with ONLY a JSON object — no prose, no markdown fences, no backticks:
{
  "focus": "under 9 words: what you are doing THIS iteration",
  "did": "1-2 sentences: the increment you just produced",
  "output": "the substantive work product for this iteration (markdown fine, may be empty for planning steps)",
  "next": "under 9 words: the next increment",
  "alignment": "1 sentence: how this still serves the stated goal",
  "blocked": false,
  "question": "one question for the operator, or an empty string",
  "progressPct": 0,
  "done": false
}
Set "blocked": true only if you genuinely cannot proceed without an answer. Keep "focus" and "next" terse — they render in a status box that must stay glanceable.`;

async function callClaude({ model, maxTokens, messages }) {
  let bearer = null;
  try { bearer = (await auth.getSession())?.access_token || null; } catch {}
  const res = await fetch("/.netlify/functions/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: SYSTEM, messages }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || data?.error || `proxy ${res.status}`);
  const text = (data?.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
  if (!text) throw new Error("empty response from the model");
  return { text, usage: data?.usage || null };
}

// The model is asked for bare JSON, but fences/preamble still happen. Recover
// the outermost object rather than failing the whole iteration.
function parseTurn(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(cleaned.slice(a, b + 1)); } catch {} }
  return null;
}

/* ─── the engine ─────────────────────────────────────────────────────────── */
function useLooper() {
  const [mission, setMission] = useState(() => load("mission", null));
  const [run, setRun] = useState(() => ({ ...IDLE_RUN, ...load("run", {}) }));
  const [journal, setJournal] = useState(() => load("journal", []));
  const [chat, setChat] = useState(() => load("chat", []));

  useEffect(() => save("mission", mission), [mission]);
  useEffect(() => save("run", run), [run]);
  useEffect(() => save("journal", journal.slice(0, 60)), [journal]);
  useEffect(() => save("chat", chat.slice(-80)), [chat]);

  // Everything the tick needs, read through a ref so the interval never closes
  // over stale state (the classic bug: a loop that keeps re-sending iteration 1).
  const live = useRef({ mission, run, journal, chat });
  live.current = { mission, run, journal, chat };
  const busy = useRef(false);

  const finish = useCallback((stopReason) => {
    setRun((r) => ({ ...r, status: "done", stopReason, awaiting: null }));
  }, []);

  const tick = useCallback(async () => {
    const { mission: m, run: r, journal: j, chat: c } = live.current;
    if (!m || r.status !== "running" || busy.current) return;
    if (r.endsAt && Date.now() >= r.endsAt) return finish("time");
    if (r.spendUsd >= r.capUsd) return finish("budget");

    busy.current = true;
    const cfg = DIFF(r.difficulty);
    const iter = r.iterations + 1;
    const t0 = Date.now();
    const pending = c.filter((x) => x.role === "user" && !x.delivered);

    // Newest-first journal, so slice(0,6) is the most recent six.
    const recent = j.slice(0, 6).reverse()
      .map((e) => `#${e.iter} ${e.focus}\n  did: ${e.did}${e.output ? `\n  output: ${String(e.output).slice(0, 700)}` : ""}`)
      .join("\n");

    const parts = [
      `MISSION`,
      `Goal: ${m.goal}`,
      m.target ? `Area: ${m.target === "other" ? m.targetNote || "unrelated to the Pentagon tools" : `the ${TARGETS.find((t) => t.id === m.target)?.label} tool`}` : null,
      m.direction ? `Direction: ${m.direction}` : null,
      m.constraints ? `Constraints: ${m.constraints}` : null,
      ``,
      `ITERATION ${iter} of an open-ended run.`,
      recent ? `\nJOURNAL (oldest to newest)\n${recent}` : `\nThis is the first iteration — start by making the plan concrete, then do the first real increment.`,
      pending.length ? `\nNEW OPERATOR NOTES (these outrank your plan)\n${pending.map((p) => `- ${p.text}`).join("\n")}` : null,
    ].filter(Boolean);

    // One model call, normalised into a journal entry. Errors become a FAILED
    // entry rather than an exception, so a bad iteration is visible in the log
    // and counts toward the error backoff instead of vanishing.
    const attempt = async () => {
      const { text, usage } = await callClaude({ model: cfg.model, maxTokens: cfg.maxTokens, messages: [{ role: "user", content: parts.join("\n") }] });
      const turn = parseTurn(text);
      if (!turn) throw new Error("could not parse the model's JSON");

      const inTok = usage?.input_tokens ?? 0, outTok = usage?.output_tokens ?? 0;
      const cost = estimateCost(cfg.model, inTok, outTok);

      // Mirror into the shared usage log the System hub reads. Key names are
      // that reader's contract (inputTokens/outputTokens/costEstimate/latencyMs),
      // not Looper's own — renaming them here silently zeroes the digest.
      try {
        const log = JSON.parse(localStorage.getItem("lp_obs_log") || "[]");
        log.unshift({ id: uid(), ts: new Date().toISOString(), fn: "looper_iteration", model: cfg.model, inputTokens: inTok, outputTokens: outTok, costEstimate: cost, latencyMs: Date.now() - t0, ok: true });
        localStorage.setItem("lp_obs_log", JSON.stringify(log.slice(0, 300)));
      } catch { /* quota or private mode — the run itself must not fail on logging */ }

      return {
        id: uid(), iter, ts: Date.now(), ok: true,
        focus: String(turn.focus || "—").slice(0, 90),
        did: String(turn.did || "").slice(0, 600),
        output: typeof turn.output === "string" ? turn.output : "",
        next: String(turn.next || "").slice(0, 90),
        alignment: String(turn.alignment || "").slice(0, 300),
        blocked: !!turn.blocked,
        question: String(turn.question || "").slice(0, 400),
        progressPct: Math.max(0, Math.min(100, Number(turn.progressPct) || 0)),
        done: !!turn.done,
        tokens: inTok + outTok, costUsd: cost,
      };
    };

    try {
      let entry;
      try {
        entry = await attempt();
      } catch (e) {
        entry = { id: uid(), iter, ts: Date.now(), ok: false, focus: "iteration failed", did: String(e?.message || e), output: "", next: "", alignment: "", blocked: false, question: "", progressPct: 0, done: false, tokens: 0, costUsd: 0 };
      }

      setJournal((prev) => [entry, ...prev].slice(0, 60));
      if (pending.length) {
        const ids = new Set(pending.map((p) => p.id));
        setChat((prev) => prev.map((x) => (ids.has(x.id) ? { ...x, delivered: true } : x)));
      }
      if (entry.ok && (entry.question || entry.blocked)) {
        setChat((prev) => [...prev, { id: uid(), ts: Date.now(), role: "looper", text: entry.question || "I'm blocked and need a decision.", iter }]);
      }

      setRun((prev) => {
        const errors = entry.ok ? 0 : prev.errors + 1;
        const spendUsd = prev.spendUsd + entry.costUsd;
        const next = { ...prev, iterations: iter, spendUsd, errors };
        if (entry.done) return { ...next, status: "done", stopReason: "completed", awaiting: null };
        if (spendUsd >= prev.capUsd) return { ...next, status: "done", stopReason: "budget", awaiting: null };
        if (errors >= 3) return { ...next, status: "paused", stopReason: "errors", awaiting: "Three iterations failed in a row — check the log before resuming." };
        const asked = entry.question || entry.blocked;
        const p = prev.interrupt;
        const shouldPause = p === "always" || (p === "questions" && asked) || (p === "blockers" && entry.blocked);
        if (shouldPause) return { ...next, status: "paused", stopReason: null, awaiting: asked ? entry.question || "Blocked — needs a decision." : "Waiting for your go-ahead." };
        return next;
      });

      if (entry.ok && r.notify && (entry.question || entry.blocked)) notify(entry.question || "Looper is blocked");
    } finally {
      // MUST clear even if a commit above throws. A stuck guard makes every
      // later tick return early, so the run would look "running" forever while
      // silently doing nothing.
      busy.current = false;
    }
  }, [finish]);

  const tickRef = useRef(tick);
  tickRef.current = tick;

  // One interval per cadence change. Fires immediately on start so the first
  // iteration does not wait a full cadence before anything appears.
  useEffect(() => {
    if (run.status !== "running") return;
    const cad = DIFF(run.difficulty).cadence * 1000;
    tickRef.current();
    const id = setInterval(() => tickRef.current(), cad);
    return () => clearInterval(id);
  }, [run.status, run.difficulty]);

  const start = useCallback((patch = {}) => {
    setRun((r) => {
      const durationMin = patch.durationMin ?? r.durationMin;
      return { ...r, ...patch, durationMin, status: "running", startedAt: Date.now(), endsAt: Date.now() + durationMin * 60000, errors: 0, stopReason: null, awaiting: null };
    });
  }, []);
  const pause = useCallback(() => setRun((r) => ({ ...r, status: "paused", awaiting: null })), []);
  // addUsd raises the spend cap. It is a REQUIRED argument at the one call site
  // that needs it rather than an automatic doubling: a run that stopped on
  // budget and then quietly resumed against 2x the cap is a money surprise, so
  // the button that calls this prints the amount on its face.
  const resume = useCallback((addUsd = 0) => setRun((r) => ({
    ...r, status: "running", errors: 0, awaiting: null, stopReason: null,
    // A resume after the clock ran out needs a fresh window, or it stops again instantly.
    endsAt: r.endsAt && Date.now() < r.endsAt ? r.endsAt : Date.now() + r.durationMin * 60000,
    capUsd: r.capUsd + (Number(addUsd) || 0),
  })), []);
  const reset = useCallback(() => { setRun({ ...IDLE_RUN }); setJournal([]); setChat([]); }, []);

  const say = useCallback((text) => {
    const t = text.trim();
    if (!t) return;
    setChat((prev) => [...prev, { id: uid(), ts: Date.now(), role: "user", text: t, delivered: false }]);
    // Answering is the natural "carry on" — a reply resumes a paused run. It has
    // to reopen the time window too: a run paused past its endsAt would take the
    // note, stop on "time" before delivering it, and leave the reply queued
    // forever, which reads as the reply having been ignored.
    setRun((r) => (r.status !== "paused" ? r : {
      ...r, status: "running", errors: 0, awaiting: null, stopReason: null,
      endsAt: r.endsAt && Date.now() < r.endsAt ? r.endsAt : Date.now() + r.durationMin * 60000,
    }));
  }, []);

  return { mission, setMission, run, setRun, journal, chat, start, pause, resume, reset, say };
}

function notify(body) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    new Notification("Looper needs you", { body: String(body).slice(0, 140) });
  } catch {}
}

/* ─── icons ──────────────────────────────────────────────────────────────── */
// Multi-subpath `d` strings — one <path> each, so a whole glyph is one string.
// Run is a closed loop with an arrowhead rather than a play triangle: the tool
// is named for the loop, and "play" already means "resume" on this screen.
const ICONS = {
  run: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5",
  mission: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 12.9a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z",
  chat: "M4 5.5h16v10H9l-5 4z",
  log: "M4 6h16M4 12h16M4 18h10",
};
const Ico = ({ d }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

/* ─── app ────────────────────────────────────────────────────────────────── */
const TABS = [
  { id: "run", label: "Run", icon: ICONS.run },
  { id: "mission", label: "Mission", icon: ICONS.mission },
  { id: "chat", label: "Chat", icon: ICONS.chat },
  { id: "log", label: "Log", icon: ICONS.log },
];

export default function LooperApp() {
  const L = useLooper();
  // Always Run, even with no mission set: its empty state explains what Looper
  // is and links to setup, which orients a first-time visitor better than
  // dropping them straight into a form. Every later visit is a check-in, and a
  // check-in belongs on Run.
  const [tab, setTab] = useState("run");
  const unread = L.chat.filter((m) => m.role === "looper").length && L.run.awaiting ? 1 : 0;

  return (
    // data-kit: Looper opts into the shared kit, on its OWN root. It renders
    // inside the shell's tool slot, so this reaches Looper and nothing else —
    // the same rule the shell follows by keeping data-kit off the wrapper that
    // holds every tool.
    <div className="lp-root" data-kit>
      <div className="lp-navbar">
        <nav className="lp-nav" aria-label="Looper">
          {TABS.map((t) => (
            <button type="button" key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)} aria-current={tab === t.id ? "page" : undefined}>
              <Ico d={t.icon} />
              <span>{t.label}</span>
              {t.id === "chat" && unread > 0 && <span className="lp-badge" />}
            </button>
          ))}
        </nav>
      </div>
      <div className="lp-shell">
        {tab === "run" && <RunView L={L} onSetup={() => setTab("mission")} onChat={() => setTab("chat")} />}
        {tab === "mission" && <MissionView L={L} onStarted={() => setTab("run")} />}
        {tab === "chat" && <ChatView L={L} />}
        {tab === "log" && <LogView L={L} />}
      </div>
    </div>
  );
}

/* ─── RUN — the check-in surface ─────────────────────────────────────────── */
function RunView({ L, onSetup, onChat }) {
  const { mission, run, journal } = L;
  const last = journal.find((e) => e.ok) || null;
  const [, force] = useState(0);
  // A ticking clock only while running; no timer burning cycles when idle.
  useEffect(() => {
    if (run.status !== "running") return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [run.status]);

  if (!mission) {
    return (
      <div className="empty">
        <div className="empty-icon lp-eico"><Ico d={ICONS.mission} /></div>
        <div className="empty-title">Nothing set up yet</div>
        <p className="empty-sub">Give Looper a goal and a direction, then set how long and how hard it should run.</p>
        <button type="button" className="btn md primary" style={{ marginTop: 8 }} onClick={onSetup}>Set up a mission</button>
      </div>
    );
  }

  const remaining = run.status === "running" && run.endsAt ? run.endsAt - Date.now() : null;
  const pct = last?.progressPct ?? 0;
  const onBudget = run.spendUsd >= run.capUsd;

  return (
    <div className="lp-grid two">
      <div style={{ display: "grid", gap: 12 }}>
        <section className="card pad-md lp-status">
          <div className="t-label lp-ttl">
            Now
            <span className="sp" />
            {/* The kit's pill and status dot. The word carries the state; the
                colour and the pulse only agree with it. */}
            <span className={`pill lp-state ${run.status}`}>
              <span className={`dotstatus${run.status === "running" ? " pulse" : ""}`} />
              {run.status === "running" ? "running" : run.status === "paused" ? "paused" : run.status === "done" ? (STOP_LABEL[run.stopReason] || "done") : "idle"}
            </span>
          </div>

          <p className="t-head lp-focus">{run.status === "idle" ? "Not started" : last ? last.focus : "Starting the first iteration…"}</p>
          {last?.did && <p className="t-foot lp-goalline">{last.did}</p>}

          {run.awaiting && (
            <div className="lp-note warn" role="status">
              {run.awaiting} <button type="button" className="btn sm plain" onClick={onChat}>Answer →</button>
            </div>
          )}

          {/* Goal and Next are prose, so they get rows that WRAP. They were cells
              in the numeric strip below and both ellipsised at phone widths —
              "Draft 20 ZTS s…" is the one thing on this screen that must never
              be cut, since the whole panel exists to prove it is still on it. */}
          <dl className="lp-aim">
            <dt className="t-label">Goal</dt><dd>{mission.goal}</dd>
            <dt className="t-label">Next</dt><dd>{last?.next || "—"}</dd>
          </dl>

          <div className="lp-strip two">
            <div className="stattile"><div className="stattile-label">Iteration</div><div className="stattile-value">{run.iterations}</div></div>
            <div className="stattile"><div className="stattile-label">Time left</div><div className="stattile-value">{run.status === "running" ? clock(remaining) : "—"}</div></div>
          </div>

          <div className="lp-bar" role="img" aria-label={`self-reported progress ${pct}%`}><div style={{ width: `${pct}%` }} /></div>
          <div className="lp-meta">
            <span className="t-cap">{pct}% — its own estimate</span>
            <span className="t-cap t-num">{money(run.spendUsd)} / {money(run.capUsd)}</span>
          </div>

          {last?.alignment && (
            <p className="t-foot lp-goalline"><strong>Still aligned:</strong> {last.alignment}</p>
          )}

          <div className="lp-actions" style={{ marginTop: 14 }}>
            {run.status === "running" && <button type="button" className="btn md quiet" onClick={L.pause}>Pause</button>}
            {(run.status === "paused" || run.status === "done") && (
              // A budget stop is the one resume that costs more than it looks
              // like, so the button says the number instead of hiding it.
              <button type="button" className="btn md primary" onClick={() => L.resume(onBudget ? run.capUsd : 0)}>
                {onBudget ? `Add ${money(run.capUsd)} & resume` : run.status === "done" ? "Run again" : "Resume"}
              </button>
            )}
            {run.status === "idle" && <button type="button" className="btn md primary" onClick={() => L.start()}>Start</button>}
            <button type="button" className="btn md plain" onClick={onSetup}>Settings</button>
          </div>

          <div className="lp-note">
            Runs while this tab is open. Closing it pauses the run — nothing is lost, and reopening picks up from the last iteration.
          </div>
        </section>
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        <section className="card pad-md">
          {/* Both tags in one group: as siblings of the auto-margin spacer the
              first was pinned to the right edge and the second wrapped alone
              onto its own line. */}
          <div className="t-label lp-ttl">
            Direction<span className="sp" />
            <span className="lp-tags">
              <span className="pill">{DIFF(run.difficulty).label}</span>
              <span className="pill" title="When Looper is allowed to stop and wait for you">{INT(run.interrupt).pill}</span>
            </span>
          </div>
          <p className="t-foot" style={{ margin: 0 }}>{mission.direction || <span className="t-cap">No direction set — it will use its own judgement.</span>}</p>
          {mission.constraints && <p className="t-cap" style={{ marginTop: 9 }}><strong style={{ color: "var(--ink)" }}>Constraints:</strong> {mission.constraints}</p>}
        </section>
        <section className="card pad-md">
          <div className="t-label lp-ttl">Last few iterations</div>
          {/* The interval effect fires a tick immediately on start, so nothing
              waits a cadence before it begins — and the cadence is 45/60/90/120s
              by difficulty, never a flat minute. Both halves of the old
              sentence ("about a minute after you start") were untrue. */}
          {journal.length === 0 ? <p className="t-cap" style={{ margin: 0 }}>Nothing yet — the first iteration starts the moment the run does, then one every {DIFF(run.difficulty).cadence}s.</p> : (
            <ul className="lp-journal">
              {journal.slice(0, 4).map((e) => (
                <li key={e.id}>
                  <div className="cell lp-jhead">
                    <span className="lp-jiter">#{e.iter}</span>
                    <span className={`lp-jfocus ${e.ok ? "" : "lp-jerr"}`}>{e.focus}</span>
                    <span className="lp-jtime">{hhmm(e.ts)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/* ─── MISSION — setup + the dials ────────────────────────────────────────── */
function MissionView({ L, onStarted }) {
  const { mission, run } = L;
  const [target, setTarget] = useState(mission?.target || "zts");
  const [targetNote, setTargetNote] = useState(mission?.targetNote || "");
  const [goal, setGoal] = useState(mission?.goal || "");
  const [direction, setDirection] = useState(mission?.direction || "");
  const [constraints, setConstraints] = useState(mission?.constraints || "");
  const [difficulty, setDifficulty] = useState(run.difficulty);
  const [durationMin, setDurationMin] = useState(run.durationMin);
  const [interrupt, setInterrupt] = useState(run.interrupt);
  const [capUsd, setCapUsd] = useState(run.capUsd);
  const [notify_, setNotify] = useState(run.notify);

  const cfg = DIFF(difficulty);
  const estIters = Math.max(1, Math.floor((durationMin * 60) / cfg.cadence));
  const canStart = goal.trim().length > 3;

  const commit = (startIt) => {
    L.setMission({ target, targetNote: targetNote.trim(), goal: goal.trim(), direction: direction.trim(), constraints: constraints.trim() });
    const patch = { difficulty, durationMin, interrupt, capUsd: Number(capUsd) || 1, notify: notify_ };
    if (startIt) L.start(patch); else L.setRun((r) => ({ ...r, ...patch }));
    if (startIt) onStarted();
  };

  const askNotify = async (v) => {
    setNotify(v);
    if (v && typeof Notification !== "undefined" && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch {}
    }
  };

  return (
    <div className="lp-grid two">
      <section className="card pad-md">
        <div className="t-label lp-ttl">The mission</div>

        <div className="lp-field">
          <label className="t-label lp-label">What is it working on</label>
          <div className="seg lp-seg c3" style={{ marginBottom: target === "other" ? 8 : 0 }}>
            {TARGETS.slice(0, 3).map((t) => (
              <button type="button" key={t.id} className={`seg-opt lp-opt${target === t.id ? " active" : ""}`} aria-pressed={target === t.id} onClick={() => setTarget(t.id)}><span className="k">{t.label}</span></button>
            ))}
          </div>
          <div className="seg lp-seg c2" style={{ marginTop: 4 }}>
            {TARGETS.slice(3).map((t) => (
              <button type="button" key={t.id} className={`seg-opt lp-opt${target === t.id ? " active" : ""}`} aria-pressed={target === t.id} onClick={() => setTarget(t.id)}><span className="k">{t.label}</span></button>
            ))}
          </div>
          {target === "other" && (
            <input className="field lp-input" style={{ marginTop: 8 }} placeholder="e.g. a book outline, a move plan, a course…" value={targetNote} onChange={(e) => setTargetNote(e.target.value)} />
          )}
        </div>

        <div className="lp-field">
          <label className="t-label lp-label" htmlFor="lp-goal">Goal — the one thing to achieve</label>
          <textarea id="lp-goal" className="field lp-area" placeholder="Draft 20 ZTS short scripts that each open with a self-custody failure story." value={goal} onChange={(e) => setGoal(e.target.value)} />
        </div>

        <div className="lp-field">
          <label className="t-label lp-label" htmlFor="lp-dir">Direction — how to approach it</label>
          <textarea id="lp-dir" className="field lp-area" placeholder="Punchy, conviction-driven, no fear-mongering. One script per iteration, newest first." value={direction} onChange={(e) => setDirection(e.target.value)} />
        </div>

        <div className="lp-field">
          <label className="t-label lp-label" htmlFor="lp-con">Constraints — what not to do</label>
          <input id="lp-con" className="field lp-input" placeholder="No price predictions. Never claim ZTS prevents all loss." value={constraints} onChange={(e) => setConstraints(e.target.value)} />
        </div>
      </section>

      <div style={{ display: "grid", gap: 12 }}>
        <section className="card pad-md">
          <div className="t-label lp-ttl">Difficulty</div>
          <div className="seg lp-seg c4">
            {Object.entries(DIFFICULTY).map(([id, d]) => (
              <button type="button" key={id} className={`seg-opt lp-opt${difficulty === id ? " active" : ""}`} aria-pressed={difficulty === id} onClick={() => setDifficulty(id)}>
                <span className="k">{d.label}</span><span className="d">{d.note}</span>
              </button>
            ))}
          </div>
          <p className="t-cap" style={{ marginTop: 9 }}>
            One iteration every {cfg.cadence}s, up to {cfg.maxTokens.toLocaleString("en-US")} tokens. About {estIters} iterations in {durationMin} minutes.
          </p>
        </section>

        <section className="card pad-md">
          <div className="t-label lp-ttl">How long</div>
          <div className="seg lp-seg c3">
            {DURATIONS.map((d) => (
              <button type="button" key={d} className={`seg-opt lp-opt${durationMin === d ? " active" : ""}`} aria-pressed={durationMin === d} onClick={() => setDurationMin(d)}>
                <span className="k">{d < 60 ? `${d}m` : `${d / 60}h`}</span>
              </button>
            ))}
          </div>
          <div style={{ marginTop: 12 }}>
            <label className="t-label lp-label" htmlFor="lp-cap">Hard spend cap (estimate)</label>
            <div className="seg lp-seg c4">
              {[0.25, 1, 3, 10].map((v) => (
                <button type="button" key={v} className={`seg-opt lp-opt${Number(capUsd) === v ? " active" : ""}`} aria-pressed={Number(capUsd) === v} onClick={() => setCapUsd(v)}><span className="k">${v}</span></button>
              ))}
            </div>
            <p className="t-cap" style={{ marginTop: 8 }}>It stops itself at the cap, whichever comes first. The cap counts the whole run, not each start, and token prices are estimates — treat it as a guardrail rather than a bill.</p>
            {/* Without this the trap is silent: pick a cap under what the run has
                already spent, hit Start, and it stops on the first tick. */}
            {run.spendUsd >= (Number(capUsd) || 0) && run.spendUsd > 0 && (
              <div className="lp-note warn">This run has already spent {money(run.spendUsd)}. Pick a higher cap or clear the run history below, or it will stop on its first iteration.</div>
            )}
          </div>
        </section>

        <section className="card pad-md">
          <div className="t-label lp-ttl">Interrupting you</div>
          <div className="seg lp-seg c2">
            {Object.entries(INTERRUPT).map(([id, o]) => (
              <button type="button" key={id} className={`seg-opt lp-opt${interrupt === id ? " active" : ""}`} aria-pressed={interrupt === id} onClick={() => setInterrupt(id)}>
                <span className="k">{o.label}</span><span className="d">{o.note}</span>
              </button>
            ))}
          </div>
          {/* The kit's switch, in place of a text button that said its state with
              a leading "✓". The knob moves, so the state is not the tint alone. */}
          <div className="lp-toggle">
            <span className="t-call">Browser notification when it pauses</span>
            <button
              type="button" className={`switch${notify_ ? " on" : ""}`} onClick={() => askNotify(!notify_)}
              aria-pressed={notify_} aria-label="Browser notification when it pauses"
            >
              <span className="switch-knob" />
            </button>
          </div>
        </section>

        <div className="lp-actions">
          {/* Not "Restart": start() keeps the journal, iteration count and spend
              and only reopens the clock, so calling it a restart would promise a
              clean slate the button does not give. Clear run history does that. */}
          <button type="button" className="btn md primary full" disabled={!canStart} onClick={() => commit(true)}>
            {run.status === "running" ? "Apply & reset the clock" : "Start the run"}
          </button>
          <button type="button" className="btn md quiet full" onClick={() => commit(false)}>Save without starting</button>
          {(L.journal.length > 0 || run.iterations > 0) && (
            <button type="button" className="btn md danger full" onClick={() => { if (confirm("Clear the mission's journal, chat and spend? The goal and settings stay.")) L.reset(); }}>Clear run history</button>
          )}
        </div>
        {!canStart && <p className="t-cap">A goal is required — it is the only thing every iteration is measured against.</p>}
      </div>
    </div>
  );
}

/* ─── CHAT — talk to it mid-run ──────────────────────────────────────────── */
function ChatView({ L }) {
  const [text, setText] = useState("");
  // Scroll the transcript, not the page: scrollIntoView() walks up to the
  // window and yanks the whole tool when the thread is short.
  const box = useRef(null);
  useEffect(() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; }, [L.chat.length]);

  const send = () => { if (!text.trim()) return; L.say(text); setText(""); };

  return (
    <section className="card pad-md">
      {/* This card IS the Chat tab, so its label was the tab's name a second
          time — the one place in Looper where a .lp-ttl was a page title rather
          than one of several card labels. The pill is not a repeat: it says when
          what you type will actually be read, which the nav cannot. It loses the
          `.sp` spacer with the word, because a right-pinned pill with nothing on
          its left reads as a stray. No height comes back here — the row still
          carries the status — but the tab is no longer named twice. */}
      <div className="t-label lp-ttl">
        <span className="pill">{L.run.status === "running" ? "read next iteration" : L.run.status === "paused" ? "a reply resumes it" : "queued"}</span>
      </div>

      {L.chat.length === 0 ? (
        <div className="empty">
          <div className="empty-icon lp-eico"><Ico d={ICONS.chat} /></div>
          <p className="empty-sub">Anything you send is handed to the next iteration as an instruction, and outranks its current plan.</p>
        </div>
      ) : (
        <div className="lp-chat" ref={box}>
          {L.chat.map((m) => (
            <div key={m.id} className={`lp-msg ${m.role === "user" ? "me" : "it"} ${m.role === "user" && !m.delivered ? "queued" : ""}`}>
              <div className="t-cap who">{m.role === "user" ? (m.delivered ? "You" : "You · queued") : `Looper · #${m.iter ?? "—"}`}</div>
              {m.text}
            </div>
          ))}
        </div>
      )}

      {/* Two rows, and a placeholder short enough to sit on one line: at one row
          the 16px iOS-safe font clipped a wrapped placeholder mid-word. */}
      <div className="lp-composer">
        <textarea
          className="field lp-area" rows={2} value={text} placeholder="Reply, redirect, or add a constraint…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
        />
        <button type="button" className="btn md primary" onClick={send} disabled={!text.trim()}>Send</button>
      </div>
      <p className="t-cap" style={{ marginTop: 7 }}>⌘/Ctrl + Enter sends. It reads your notes at the start of its next iteration.</p>
    </section>
  );
}

/* ─── LOG — the full journal, with the actual work ───────────────────────── */
function LogView({ L }) {
  const [open, setOpen] = useState(null);
  if (L.journal.length === 0) {
    return (
      <div className="empty">
        <div className="empty-icon lp-eico"><Ico d={ICONS.log} /></div>
        <div className="empty-title">No iterations yet</div>
        <p className="empty-sub">Start the run on the Run tab — every iteration lands here with what it did and the work it produced.</p>
      </div>
    );
  }
  const spend = L.journal.reduce((n, e) => n + (e.costUsd || 0), 0);
  const tokens = L.journal.reduce((n, e) => n + (e.tokens || 0), 0);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <section className="card pad-md">
        <div className="t-label lp-ttl">Run totals</div>
        <div className="lp-strip">
          <div className="stattile"><div className="stattile-label">Iterations</div><div className="stattile-value">{L.run.iterations}</div></div>
          <div className="stattile"><div className="stattile-label">Tokens</div><div className="stattile-value">{tokens.toLocaleString("en-US")}</div></div>
          <div className="stattile"><div className="stattile-label">Spend</div><div className="stattile-value">{money(spend)}</div></div>
          <div className="stattile"><div className="stattile-label">Failed</div><div className="stattile-value">{L.journal.filter((e) => !e.ok).length}</div></div>
        </div>
      </section>
      <section className="card pad-md">
        <div className="t-label lp-ttl">Journal — newest first</div>
        <ul className="lp-journal">
          {L.journal.map((e) => (
            <li key={e.id}>
              {/* A chevron, because nothing else said these rows open. Rotating
                  it is the only cue that the work product is one tap away. */}
              <button type="button" className="cell tappable lp-jhead" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                <span className="lp-jiter">#{e.iter}</span>
                <span className={`lp-jfocus ${e.ok ? "" : "lp-jerr"}`}>{e.focus}</span>
                <span className="lp-jtime">{hhmm(e.ts)}</span>
                <svg className={`cell-chevron lp-jchev ${open === e.id ? "open" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
              </button>
              {open === e.id && (
                <div className="lp-jbody">
                  {e.did && <div className="lp-jdid">{e.did}</div>}
                  {e.alignment && <div className="lp-jdid"><strong style={{ color: "var(--ink)" }}>Aligned:</strong> {e.alignment}</div>}
                  {e.output && <div className="lp-jout">{e.output}</div>}
                  <div className="lp-meta">
                    <span className="t-cap t-num">{e.tokens.toLocaleString("en-US")} tok</span>
                    <span className="t-cap t-num">{money(e.costUsd || 0)}</span>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
