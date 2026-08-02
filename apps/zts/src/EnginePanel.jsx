// ═══════════════════════════════════════════════════════════════════════════
// ZTS ENGINE PANEL — what the writer is doing, and what needs your call.
//
// This replaces the top of the Mission tab, which rendered twelve zeros, eight
// agents permanently labelled "ready" that had never run, and a hardcoded green
// "Live" dot — while nothing in the system had ever been switched on. Every
// number on this panel comes from a live query; none of it is a constant.
//
// ALL DERIVATION IS IN @cc/ops. This file only fetches and renders. The phase
// ladder, the plays, the arm payloads and the queue shaping are pure and tested
// there, so this panel and Clarify's cannot drift about what "armed" or
// "waiting" means, even though their JSX is deliberately separate.
//
// SCHEMA PIN. apps/zts/src/supabaseClient.js creates its client with
// db:{schema:'zts'}, so every table this panel reads — content_drafts,
// ops_control, ops_runs, app_settings — MUST go through .schema('public') or it
// silently 404s and renders empty. An empty panel here is indistinguishable
// from "the engine produced nothing", which would poison the one signal this
// screen exists to give.
// ═══════════════════════════════════════════════════════════════════════════
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { supabase } from "./supabaseClient";
// `syne` is gone from this file: every piece of type here is a kit class now,
// and the kit sets its own family off --font-body.
import { T } from "./theme";
import { enginePhase, enginePlays, humanGap, PHASE } from "@cc/ops/plays.js";
import { armWrites, subsystemWrites, armState } from "@cc/ops/arm.js";
import { cadenceFor } from "@cc/ops/cadence.js";
import { resolveDirection, ENGINE, DIRECTION_KEY, HARD_MAX } from "@cc/ops/direction.js";
import { buildQueue, KIND } from "@cc/ops/queue.js";
import { loadEnginePanelPrefs, saveEnginePanelPrefs, resolveOpen } from "./enginePanelPrefs.js";

const SUBSYSTEM = "zts.content";
const BODY_ID = "zts-engine-body";
const pub = () => supabase.schema("public");

const TONE = { go: T.green, warn: T.amber, prompt: T.blue, neutral: T.sub };
const PILL = {
  armed: { c: T.green, t: "Armed" },
  rehearsing: { c: T.amber, t: "Rehearsing" },
  off: { c: T.faint, t: "Off" },
  stopped: { c: T.red, t: "Stopped" },
  unknown: { c: T.red, t: "Unknown" },
};

const SUMMARY_TONE = { bad: "var(--bad)", warn: "var(--warn)", quiet: "var(--muted)" };

// The closed row has one job: report the writer's actual state without making
// the operator reopen a 700px card to discover a failure. A queue waiting for
// review is successful work, not an alarm, so it does not defeat the fold.
export function collapsedRead({ loaded, err, controlRead, phase, stopReason, lastPassMs }) {
  if (!loaded) return { attention: null, tone: "quiet", line: "Reading state…" };
  if (!controlRead) return { attention: true, tone: "bad", line: "State unreadable — the control table did not load" };

  const bits = [];
  if (err) bits.push("some of this did not load");
  bits.push(phase.headline);
  if (stopReason) bits.push(stopReason);
  else if (phase.phase === PHASE.BLOCKED) bits.push(phase.detail);
  if (Number.isFinite(lastPassMs)) bits.push(`last pass ${humanGap(lastPassMs)} ago`);

  const attention = Boolean(err) || !phase.ok;
  const tone = err || phase.phase === PHASE.DISARMED || phase.phase === PHASE.BLOCKED
    ? "bad" : !phase.ok ? "warn" : "quiet";
  return { attention, tone, line: bits.slice(0, 3).join(" · ") };
}

function Fold({ open, children }) {
  return (
    <div id={BODY_ID} className={`expand${open ? " open" : ""}`} aria-hidden={!open} inert={open ? undefined : ""}>
      <div>{children}</div>
    </div>
  );
}

export default function EnginePanel({ isMobile }) {
  const [dir, setDir] = useState(null);
  const [control, setControl] = useState(null);
  const [runs, setRuns] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [err, setErr] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [openId, setOpenId] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(() => resolveOpen(loadEnginePanelPrefs(), null));
  const forced = useRef(false);

  const load = useCallback(async () => {
    if (!supabase) { setErr("Supabase isn't configured."); setLoaded(true); return; }
    try {
      const [s, c, r, d] = await Promise.all([
        pub().from("app_settings").select("value").eq("key", DIRECTION_KEY[ENGINE.CONTENT]).maybeSingle(),
        pub().from("ops_control").select("*"),
        pub().from("ops_runs").select("*").eq("subsystem", SUBSYSTEM).order("started_at", { ascending: false }).limit(8),
        pub().from("content_drafts").select("*").eq("status", "draft_ready").order("created_at"),
      ]);
      // Applied independently: one failed read must not blank the other three
      // and render as "nothing happening".
      const e = [];
      if (s.error) e.push(`direction: ${s.error.message}`); else setDir(resolveDirection(ENGINE.CONTENT, s.data?.value).direction);
      if (c.error) e.push(`control: ${c.error.message}`); else setControl(c.data || []);
      if (r.error) e.push(`runs: ${r.error.message}`); else setRuns(r.data || []);
      if (d.error) e.push(`drafts: ${d.error.message}`); else setDrafts(d.data || []);
      setErr(e.join(" · "));
    } catch (ex) { setErr(String(ex.message || ex)); }
    finally { setLoaded(true); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const now = Date.now();
  const global = (control || []).find((c) => c.key === "global") || null;
  const mine = (control || []).find((c) => c.key === SUBSYSTEM) || null;
  const { ready, missing } = dir ? resolveDirection(ENGINE.CONTENT, dir) : { ready: false, missing: [] };
  const queue = useMemo(() => buildQueue({ contentDrafts: drafts, now }), [drafts, now]);

  const phase = enginePhase({
    ready, missing, global, subsystem: mine, lastRuns: runs, queue, now,
    cadenceMs: cadenceFor(SUBSYSTEM),
  });
  const plays = enginePlays({ phase, extras: [] });
  const state = loaded ? armState({ global, subsystems: mine ? [mine] : [] }) : { state: "unknown" };
  const pill = PILL[state.state] || PILL.unknown;
  const read = collapsedRead({
    loaded, err, controlRead: control !== null, phase,
    stopReason: global?.paused_reason || null, lastPassMs: phase.sinceLastRunMs,
  });

  // Attention only gets to overrule a stored preference once. A successful
  // refresh after the operator has opened the panel must never close it again.
  useEffect(() => {
    if (forced.current || read.attention === null) return;
    forced.current = true;
    if (read.attention) setOpen(true);
  }, [read.attention]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    saveEnginePanelPrefs({ open: next });
  };

  const act = (id, fn) => async () => {
    setBusy(id); setErr(""); setNote("");
    try { await fn(); await load(); }
    catch (ex) { setErr(String(ex.message || ex)); }
    finally { setBusy(""); }
  };

  const arm = act("arm", async () => {
    // Every row, dry_run cleared. Writing only the global row leaves the guard
    // blocking on SUBSYSTEM_OFF and the operator watching nothing happen.
    const { error } = await pub().from("ops_control").upsert(armWrites(), { onConflict: "key" });
    if (error) throw new Error(error.message);
    setNote("Armed. The writer starts on its next pass.");
  });

  // Turn THIS engine off without touching anything else. The panel shipped
  // with an Arm button and no off switch, so the only way to stop the writer
  // was the global STOP — which also stops outbound, reply-watching and manual
  // sends. A one-way control is not a control.
  const toggleMine = act("toggle", async () => {
    const next = !(mine && mine.enabled === true);
    const { error } = await pub().from("ops_control")
      .upsert(subsystemWrites(SUBSYSTEM, next), { onConflict: "key" });
    if (error) throw new Error(error.message);
    setNote(next ? "Back on. Resumes on the next pass." : "Off. It will not run again until you switch it back on.");
  });

  const decide = (item, action) => act(item.id, async () => {
    let reason = null;
    if (action === "reject") {
      reason = window.prompt("Why reject this article? (optional)", "");
      if (reason === null) { setBusy(""); return; }
    }
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch("/.netlify/functions/queue-execute", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify({ kind: KIND.CONTENT, id: item.id, action, reason }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    setOpenId(null);
    setNote(body.url ? `Published — ${body.url}` : "Rejected.");
  });

  const saveDirection = act("dir", async () => {
    const v = {
      ...form,
      topics: String(form.topics || "").split("\n").filter((x) => x.trim()),
      avoid: String(form.avoid || "").split("\n").filter((x) => x.trim()),
      perDay: Number(form.perDay) || undefined,
    };
    const { error } = await pub().from("app_settings")
      .upsert({ key: DIRECTION_KEY[ENGINE.CONTENT], value: v, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw new Error(error.message);
    setEditing(false); setForm(null);
    setNote("Saved. The writer picks it up on its next pass.");
  });

  const openEditor = () => {
    setForm({
      ...(dir || {}),
      topics: Array.isArray(dir?.topics) ? dir.topics.join("\n") : "",
      avoid: Array.isArray(dir?.avoid) ? dir.avoid.join("\n") : "",
    });
    setEditing(true);
  };

  const onPlay = (action) => {
    if (action === "direction") return openEditor();
    if (action === "arm") return arm();
    if (action === "queue" && queue[0]) return setOpenId(queue[0].id);
    return undefined;
  };

  return (
    // The kit's card: one material, a shadow, no outline. This drew a 1px line
    // AND T.cardShadow — the pair the language forbids.
    <div className="card pad-lg" style={{ padding: isMobile ? 16 : 20, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button type="button" onClick={toggle} aria-expanded={open} aria-controls={BODY_ID}
          className="cell tappable" style={{ flex: 1, minWidth: 0, padding: 0, gap: 10, cursor: "pointer" }}>
          <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className="t-head">The writer</span>
              <span className="pill" style={{ background: `${pill.c}1F`, height: 26, padding: "0 11px" }}>
                <span className="dotstatus" style={{ background: pill.c }} />
                <span className="t-label" style={{ color: pill.c }}>{pill.t}</span>
              </span>
              {open && phase.sinceLastRunMs != null && (
                <span className="t-cap">last pass {humanGap(phase.sinceLastRunMs)} ago</span>
              )}
            </span>
            {!open && <span className="t-foot" style={{ color: SUMMARY_TONE[read.tone], lineHeight: 1.4, whiteSpace: "normal" }}>{read.line}</span>}
          </span>
          <span aria-hidden style={{ flex: "none", color: "var(--faint)", fontSize: 15, lineHeight: 1, transition: "transform var(--dur-2) var(--ease-out)", transform: open ? "rotate(180deg)" : "none" }}>▾</span>
        </button>
        {/* The off switch. Always visible once a control row exists, so the
            engine can never be in a state you cannot reverse from this screen. */}
        {loaded && mine && (
          <button type="button" className="btn sm quiet" onClick={toggleMine} disabled={!!busy}
            style={{ flex: "none" }}>
            {busy === "toggle" ? "…" : mine.enabled === true ? "Turn off" : "Turn on"}
          </button>
        )}
      </div>

      {/* An error that a reload might clear gets a retry sitting on it. */}
      {err && <Msg tone={T.red} onRetry={load} busy={!!busy}>{err}</Msg>}
      {note && <Msg tone={T.green}>{note}</Msg>}

      <Fold open={open}>
      <div style={{ paddingTop: 14 }}>

      {/* the one true headline */}
      <div style={{ marginBottom: plays.length ? 14 : 0 }}>
        <div className="t-title2" style={{ lineHeight: 1.25 }}>
          {loaded ? phase.headline : "Reading state…"}
        </div>
        <div className="t-foot" style={{ marginTop: 4, lineHeight: 1.5 }}>{loaded ? phase.detail : ""}</div>
      </div>

      {/* plays — the first is always this phase's own remedy */}
      {/* The kit's cell grammar, one play per row: 46px, a leading dot, a title,
          a sub and a chevron. The first play is this phase's own remedy, so it
          is tinted — and it also sits first, which is the signal that survives
          the tint not being seen. */}
      {/* Each play is wrapped, so the rows are never ADJACENT .cell siblings —
          the kit draws a hairline between those, and these are separated cards
          with their own tint, not a grouped list. */}
      {plays.map((p, i) => (
        <div key={p.id} style={{ marginBottom: 8 }}>
          <button type="button" className="cell tappable" onClick={() => onPlay(p.action)} disabled={!!busy}
            style={{
              background: i === 0 ? `${TONE[p.tone] || T.sub}14` : "transparent",
              borderRadius: 12, opacity: busy ? 0.6 : 1,
            }}>
            <span className="dotstatus" style={{ background: TONE[p.tone] || T.sub }} />
            <span className="cell-body">
              <span className="cell-title" style={{ whiteSpace: "normal", fontWeight: 600 }}>{busy === "arm" && p.action === "arm" ? "Arming…" : p.title}</span>
              {p.sub && <span className="cell-sub" style={{ whiteSpace: "normal", lineHeight: 1.45 }}>{p.sub}</span>}
            </span>
            <span className="cell-chevron">›</span>
          </button>
        </div>
      ))}

      {/* the queue */}
      {queue.map((item) => (
        <div key={item.id} style={{ border: `1px solid ${T.line}`, borderRadius: 12, marginTop: 8, opacity: item.stale ? 0.6 : 1 }}>
          <button type="button" onClick={() => setOpenId(openId === item.id ? null : item.id)}
            style={{ width: "100%", textAlign: "left", background: "none", border: "none", padding: "12px 14px", cursor: "pointer" }}>
            <div className="t-call" style={{ fontWeight: 600, lineHeight: 1.35 }}>{item.title}</div>
            <div className="t-cap" style={{ marginTop: 3, lineHeight: 1.5 }}>{item.preview}</div>
            {item.why && <div className="t-cap" style={{ marginTop: 5 }}>Why: {item.why}</div>}
          </button>
          {openId === item.id && (
            <div style={{ padding: "0 14px 14px" }}>
              <div style={{ background: "var(--surface-2)", borderRadius: 10, padding: 12, maxHeight: 320, overflowY: "auto", fontSize: 12.5, color: "var(--ink)", lineHeight: 1.65, marginBottom: 10 }}
                // SANITISE. body_html is model-written and lands in the table
                // through the content engine, so it is untrusted markup by the
                // time it reaches a browser — a <script> or an onerror= handler
                // in a draft would run against a signed-in operator's session.
                // App.jsx and factory.jsx already pass their HTML through
                // DOMPurify; this render site was the one that did not.
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(drafts.find((d) => d.id === item.id)?.body_html || "") }} />
              <div style={{ display: "flex", gap: 8 }}>
                <Btn onClick={decide(item, "approve")} disabled={!!busy} tone={T.green}>{busy === item.id ? "…" : "Publish"}</Btn>
                <Btn onClick={decide(item, "reject")} disabled={!!busy}>Reject</Btn>
              </div>
            </div>
          )}
        </div>
      ))}

      {/* direction */}
      {editing && form && (
        <div style={{ marginTop: 14, borderTop: `1px solid ${T.line}`, paddingTop: 14 }}>
          <F label="Who is this for?" hint="e.g. people new to self-custody who just bought a hardware wallet." v={form.audience} on={(x) => setForm({ ...form, audience: x })} />
          <F label="What are you selling?" v={form.product} on={(x) => setForm({ ...form, product: x })} />
          <F label="Topics" hint="One per line." area v={form.topics} on={(x) => setForm({ ...form, topics: x })} />
          <F label="Voice notes" hint="Optional." area v={form.voice} on={(x) => setForm({ ...form, voice: x })} />
          <F label="Never mention" hint="Optional." area v={form.avoid} on={(x) => setForm({ ...form, avoid: x })} />
          <F label={`Articles per day (max ${HARD_MAX.contentPerDay})`} type="number" v={form.perDay ?? 1} on={(x) => setForm({ ...form, perDay: x })} />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={saveDirection} disabled={!!busy} tone={T.green}>{busy === "dir" ? "Saving…" : "Save"}</Btn>
            <Btn onClick={() => { setEditing(false); setForm(null); }}>Cancel</Btn>
          </div>
        </div>
      )}
      {!editing && ready && phase.phase !== PHASE.UNPOINTED && (
        <button type="button" className="btn sm plain" onClick={openEditor} style={{ marginTop: 12, paddingLeft: 0 }}>
          Change what it writes about ›
        </button>
      )}
      </div>
      </Fold>
    </div>
  );
}

// A status strip. It states its tone in words as well as colour, and an error
// carries the retry, because "one read failed" is exactly the case a second
// attempt fixes — the panel loads four independent queries and shows whichever
// ones came back.
//
// SAFE TO PRESS TWICE. `onRetry` is the panel's own `load` — a no-argument
// useCallback([]) that only SELECTs and setState()s. It submits nothing, so a
// double tap costs one extra read and cannot double-write; and it clears `err`
// on success (the error list is rebuilt from scratch each pass) so the strip
// disappears rather than sticking. It is still disabled while `busy`, because
// `busy` means a WRITE is in flight and every write already ends in its own
// load() — a concurrent read would race that one for the same four setStates.
//
// EXPORTED for the render test: the strip only mounts when a query fails, and
// effects do not run under renderToStaticMarkup, so there is no cold path to it.
export function Msg({ tone, children, onRetry, busy }) {
  return (
    <div role={onRetry ? "alert" : undefined} style={{ background: `${tone}18`, border: `1px solid ${tone}55`, borderRadius: 10, padding: "9px 12px", fontSize: 12, color: T.ink, marginBottom: 12, lineHeight: 1.5, wordBreak: "break-word", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {onRetry && <button type="button" className="btn sm quiet" onClick={onRetry} disabled={busy}>Try again</button>}
    </div>
  );
}

// The kit's .btn.md — 44px, not the 40px hand-rolled box with a 1px line. `tone`
// tints a semantic action (publish = go) without becoming the tool's accent.
function Btn({ children, onClick, disabled, tone }) {
  return (
    <button type="button" className={`btn md ${tone ? "" : "quiet"}`} onClick={onClick} disabled={disabled}
      style={tone ? { background: `${tone}22`, color: tone } : undefined}>{children}</button>
  );
}

function F({ label, hint, v, on, area, type = "text" }) {
  // The kit's .field: geometry, tone and focus ring. `.on-well` because this
  // form sits inside the panel's own card.
  const s = { fontSize: 12.5, padding: "9px 11px", minHeight: 40, lineHeight: 1.5 };
  return (
    <label style={{ display: "block", marginBottom: 11 }}>
      <div className="t-cap" style={{ color: "var(--ink)", fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {hint && <div className="t-cap" style={{ marginBottom: 5 }}>{hint}</div>}
      {area
        ? <textarea className="field" rows={2} value={v || ""} onChange={(e) => on(e.target.value)} style={{ ...s, minHeight: 56, resize: "vertical" }} />
        : <input className="field" type={type} value={v ?? ""} onChange={(e) => on(e.target.value)} style={s} />}
    </label>
  );
}
