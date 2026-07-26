// ═══════════════════════════════════════════════════════════════════════════
// CLARIFY ENGINE PANEL — the outbound engine, and the return signal.
//
// Two things live here, and the second one is the reason the panel exists.
//
//   THE WRITER — drafts one personalised message per pass into the existing
//   outreach pipeline. 38 prospects have sat undrafted since 2026-07-03.
//
//   THE REPLIES — until replies-cron.mjs shipped, reply detection ran ONLY
//   when someone clicked "Check Replies" in the toolbar, because
//   check-replies.js is auth-gated and therefore unschedulable. One email had
//   been sent, 27 days earlier, and nobody had looked. A reply is worth more
//   than a hundred drafts: it is the only event in this pipeline that proves
//   demand. It gets its own line, above everything else, always.
//
// All derivation is in @cc/ops — the phase ladder, plays, arm payloads and
// queue shaping are pure and tested there, so this panel and the ZTS one cannot
// disagree about what "armed" means even though their JSX is separate.
// ═══════════════════════════════════════════════════════════════════════════
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@cc/supabase";
import { T } from "../../theme";
import { enginePhase, enginePlays, humanGap, PHASE } from "@cc/ops/plays.js";
import { armWrites, armState } from "@cc/ops/arm.js";
import { cadenceFor } from "@cc/ops/cadence.js";
import { resolveDirection, ENGINE, DIRECTION_KEY, HARD_MAX } from "@cc/ops/direction.js";
import { buildQueue, KIND, OUTREACH_DRAFT_STATUSES } from "@cc/ops/queue.js";

const SUBSYSTEM = "clarify.outbound";
const REPLIES = "clarify.replies";

const TONE = { go: T.green, warn: T.amber, prompt: T.blue, neutral: T.muted };
const PILL = {
  armed: { c: T.green, t: "Armed" },
  rehearsing: { c: T.amber, t: "Rehearsing" },
  off: { c: T.faint, t: "Off" },
  stopped: { c: T.red, t: "Stopped" },
  unknown: { c: T.red, t: "Unknown" },
};

// Clarify has no mobile hook and does not import @cc/ui, so this measures its
// own breakpoint rather than requiring a prop the app cannot supply.
function useNarrow(bp = 768) {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(`(max-width:${bp}px)`).matches : false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia(`(max-width:${bp}px)`);
    const on = (e) => setNarrow(e.matches);
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
    return () => (mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on));
  }, [bp]);
  return narrow;
}

export default function EnginePanel({ onNavigate }) {
  const isMobile = useNarrow();
  const [dir, setDir] = useState(null);
  const [control, setControl] = useState(null);
  const [runs, setRuns] = useState([]);
  const [rows, setRows] = useState([]);
  const [replies, setReplies] = useState([]);
  const [undrafted, setUndrafted] = useState(0);
  const [err, setErr] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [openId, setOpenId] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    if (!supabase) { setErr("Supabase isn't configured."); setLoaded(true); return; }
    try {
      const [s, c, r, d, rep, und] = await Promise.all([
        supabase.from("app_settings").select("value").eq("key", DIRECTION_KEY[ENGINE.OUTBOUND]).maybeSingle(),
        supabase.from("ops_control").select("*"),
        supabase.from("ops_runs").select("*").in("subsystem", [SUBSYSTEM, REPLIES]).order("started_at", { ascending: false }).limit(16),
        supabase.from("outreach").select("*, contacts(email, name), prospects(business_name, prospect_brief, brief_callouts)")
          .in("status", OUTREACH_DRAFT_STATUSES).order("created_at"),
        supabase.from("outreach").select("id, reply_from, reply_subject, reply_snippet, replied_at, prospects(business_name)")
          .eq("status", "replied").order("replied_at", { ascending: false }).limit(10),
        supabase.from("outreach").select("id", { count: "exact", head: true }).eq("status", "prospected").is("draft_subject", null),
      ]);
      const e = [];
      if (s.error) e.push(`direction: ${s.error.message}`); else setDir(resolveDirection(ENGINE.OUTBOUND, s.data?.value).direction);
      if (c.error) e.push(`control: ${c.error.message}`); else setControl(c.data || []);
      if (r.error) e.push(`runs: ${r.error.message}`); else setRuns(r.data || []);
      if (d.error) e.push(`drafts: ${d.error.message}`); else setRows(d.data || []);
      if (rep.error) e.push(`replies: ${rep.error.message}`); else setReplies(rep.data || []);
      if (!und.error) setUndrafted(und.count || 0);
      setErr(e.join(" · "));
    } catch (ex) { setErr(String(ex.message || ex)); }
    finally { setLoaded(true); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const now = Date.now();
  const global = (control || []).find((c) => c.key === "global") || null;
  const mine = (control || []).find((c) => c.key === SUBSYSTEM) || null;
  const replyCtl = (control || []).find((c) => c.key === REPLIES) || null;
  const outboundRuns = useMemo(() => runs.filter((r) => r.subsystem === SUBSYSTEM), [runs]);
  const replyRuns = useMemo(() => runs.filter((r) => r.subsystem === REPLIES), [runs]);

  const { ready, missing } = dir ? resolveDirection(ENGINE.OUTBOUND, dir) : { ready: false, missing: [] };

  const flat = useMemo(() => rows.map((r) => ({
    ...r,
    contact_email: r.contacts?.email, contact_name: r.contacts?.name,
    business_name: r.prospects?.business_name,
    prospect_brief: r.prospects?.prospect_brief, brief_callouts: r.prospects?.brief_callouts,
  })), [rows]);
  const queue = useMemo(() => buildQueue({ outreachDrafts: flat, now }), [flat, now]);

  const phase = enginePhase({ ready, missing, global, subsystem: mine, lastRuns: outboundRuns, queue, now, cadenceMs: cadenceFor(SUBSYSTEM) });
  const plays = enginePlays({
    phase,
    extras: [{
      id: "undrafted", count: undrafted, weight: 3,
      title: `${undrafted} prospect${undrafted === 1 ? "" : "s"} never drafted`,
      sub: "The engine works through these one per pass.", action: "none", tone: "neutral",
    }],
  });
  const state = loaded ? armState({ global, subsystems: [mine, replyCtl].filter(Boolean) }) : { state: "unknown" };
  const pill = PILL[state.state] || PILL.unknown;

  // Reply watch gets its own honest line: armed, never run, or off.
  const replyPhase = enginePhase({
    ready: true, global, subsystem: replyCtl, lastRuns: replyRuns, queue: [], now, cadenceMs: cadenceFor(REPLIES),
  });

  const act = (id, fn) => async () => {
    setBusy(id); setErr(""); setNote("");
    try { await fn(); await load(); }
    catch (ex) { setErr(String(ex.message || ex)); }
    finally { setBusy(""); }
  };

  const arm = act("arm", async () => {
    const { error } = await supabase.from("ops_control").upsert(armWrites(), { onConflict: "key" });
    if (error) throw new Error(error.message);
    setNote("Armed. Drafting and reply-watching both start on their next pass.");
  });

  const decide = (item, action) => act(item.id, async () => {
    let reason = null;
    if (action === "reject") {
      reason = window.prompt("What was wrong with this one? (fed back into future drafts)", "");
      if (reason === null) { setBusy(""); return; }
    }
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch("/.netlify/functions/queue-execute", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify({ kind: KIND.OUTBOUND, id: item.id, action, reason }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    setOpenId(null);
    setNote(body.to ? `Sent to ${body.to}` : "Rejected.");
  });

  const saveDirection = act("dir", async () => {
    const v = { ...form, avoid: String(form.avoid || "").split("\n").filter((x) => x.trim()), perDay: Number(form.perDay) || undefined };
    const { error } = await supabase.from("app_settings")
      .upsert({ key: DIRECTION_KEY[ENGINE.OUTBOUND], value: v, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw new Error(error.message);
    setEditing(false); setForm(null);
    setNote("Saved. The engine picks it up on its next pass.");
  });

  const openEditor = () => {
    setForm({ ...(dir || {}), avoid: Array.isArray(dir?.avoid) ? dir.avoid.join("\n") : "" });
    setEditing(true);
  };

  const onPlay = (action) => {
    if (action === "direction") return openEditor();
    if (action === "arm") return arm();
    if (action === "queue" && queue[0]) return setOpenId(queue[0].id);
    return undefined;
  };

  return (
    <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 18, padding: isMobile ? 16 : 20, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <span style={{ fontSize: 16, fontWeight: 800, color: T.ink }}>Outbound engine</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, border: `1px solid ${pill.c}55`, borderRadius: 999, padding: "3px 9px" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: pill.c }} />
          <span style={{ fontSize: 10.5, fontWeight: 800, color: pill.c, letterSpacing: "0.05em", textTransform: "uppercase" }}>{pill.t}</span>
        </span>
        {phase.sinceLastRunMs != null && (
          <span style={{ fontSize: 11, color: T.faint, marginLeft: "auto" }}>last pass {humanGap(phase.sinceLastRunMs)} ago</span>
        )}
      </div>

      {err && <Msg tone={T.red}>{err}</Msg>}
      {note && <Msg tone={T.green}>{note}</Msg>}

      {/* ── replies: always first, because a reply outranks everything ───── */}
      {replies.length > 0 && (
        <div style={{ border: `1px solid ${T.green}66`, background: `${T.green}12`, borderRadius: 12, padding: "12px 14px", marginBottom: 12 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: T.green, marginBottom: 6 }}>
            {replies.length} {replies.length === 1 ? "reply" : "replies"} — answer these first
          </div>
          {replies.slice(0, 3).map((r) => (
            <div key={r.id} style={{ fontSize: 12, color: T.ink, lineHeight: 1.5, marginTop: 4 }}>
              <strong>{r.prospects?.business_name || r.reply_from}</strong>
              <span style={{ color: T.muted }}> — {r.reply_snippet || r.reply_subject || "replied"}</span>
            </div>
          ))}
          {onNavigate && (
            <button onClick={() => onNavigate("inbound")} style={{ marginTop: 8, background: "none", border: "none", color: T.green, fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0 }}>
              Open Inbound ›
            </button>
          )}
        </div>
      )}

      {/* reply watch state — visible even when there are no replies, because
          "no replies" and "not watching" are different facts. */}
      <div style={{ fontSize: 11.5, color: replyPhase.ok ? T.faint : T.amber, marginBottom: 12, lineHeight: 1.5 }}>
        Reply watch: {replyPhase.phase === PHASE.IDLE && replyPhase.ok
          ? `checking every 15 min · last ${humanGap(replyPhase.sinceLastRunMs)} ago`
          : `${replyPhase.headline.toLowerCase()} — ${replyPhase.detail}`}
      </div>

      <div style={{ marginBottom: plays.length ? 14 : 0 }}>
        <div style={{ fontSize: 19, fontWeight: 800, color: T.ink, lineHeight: 1.25 }}>{loaded ? phase.headline : "Reading state…"}</div>
        <div style={{ fontSize: 12.5, color: T.muted, marginTop: 4, lineHeight: 1.5 }}>{loaded ? phase.detail : ""}</div>
      </div>

      {plays.map((p, i) => (
        <button key={p.id} onClick={() => onPlay(p.action)} disabled={!!busy || p.action === "none"}
          style={{
            width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 12,
            background: i === 0 ? `${TONE[p.tone] || T.muted}14` : "transparent",
            border: `1px solid ${i === 0 ? `${TONE[p.tone] || T.muted}55` : T.line}`,
            borderRadius: 12, padding: "12px 14px", marginBottom: 8,
            cursor: busy || p.action === "none" ? "default" : "pointer", opacity: busy ? 0.6 : 1, minHeight: 46,
          }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: TONE[p.tone] || T.muted, flex: "none" }} />
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, color: T.ink }}>{busy === "arm" && p.action === "arm" ? "Arming…" : p.title}</span>
            {p.sub && <span style={{ display: "block", fontSize: 11.5, color: T.muted, marginTop: 2, lineHeight: 1.45 }}>{p.sub}</span>}
          </span>
          {p.action !== "none" && <span style={{ color: T.faint, fontSize: 16 }}>›</span>}
        </button>
      ))}

      {queue.map((item) => (
        <div key={item.id} style={{ border: `1px solid ${T.line}`, borderRadius: 12, marginTop: 8, opacity: item.stale ? 0.6 : 1 }}>
          <button onClick={() => setOpenId(openId === item.id ? null : item.id)}
            style={{ width: "100%", textAlign: "left", background: "none", border: "none", padding: "12px 14px", cursor: "pointer" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 3, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: T.faint }}>{item.target}</span>
              {item.repaired && <span style={{ fontSize: 9.5, fontWeight: 800, color: T.amber, border: `1px solid ${T.amber}55`, borderRadius: 4, padding: "1px 5px" }}>REPAIRED</span>}
              {item.stale && <span style={{ fontSize: 9.5, fontWeight: 800, color: T.amber }}>STALE</span>}
            </div>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: T.ink, lineHeight: 1.35 }}>{item.title}</div>
            <div style={{ fontSize: 11.5, color: T.muted, marginTop: 3, lineHeight: 1.5 }}>{item.preview}</div>
          </button>
          {openId === item.id && (
            <div style={{ padding: "0 14px 14px" }}>
              <div style={{ background: T.bg || "#0F1522", border: `1px solid ${T.line}`, borderRadius: 10, padding: 12, maxHeight: 300, overflowY: "auto", fontSize: 12.5, color: T.ink, lineHeight: 1.65, marginBottom: 10, whiteSpace: "pre-wrap" }}>
                {item.body}
              </div>
              {item.stale && <div style={{ fontSize: 11.5, color: T.amber, marginBottom: 9, lineHeight: 1.5 }}>Written {item.ageDays} days ago — sending is refused. Reject it and a fresh one gets written.</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <Btn onClick={decide(item, "approve")} disabled={!!busy || item.stale} tone={T.green}>{busy === item.id ? "…" : "Send"}</Btn>
                <Btn onClick={decide(item, "reject")} disabled={!!busy}>Reject</Btn>
              </div>
            </div>
          )}
        </div>
      ))}

      {editing && form && (
        <div style={{ marginTop: 14, borderTop: `1px solid ${T.line}`, paddingTop: 14 }}>
          <F label="Who do you want to reach?" hint="e.g. dental practices in Chicago spending on Google Ads." v={form.icp} on={(x) => setForm({ ...form, icp: x })} />
          <F label="What are you offering them?" hint="The thing that would make them reply." area v={form.offer} on={(x) => setForm({ ...form, offer: x })} />
          <F label="Where" hint="Optional." v={form.geography} on={(x) => setForm({ ...form, geography: x })} />
          <F label="Voice notes" hint="Optional." area v={form.voice} on={(x) => setForm({ ...form, voice: x })} />
          <F label="Never mention" hint="Optional." area v={form.avoid} on={(x) => setForm({ ...form, avoid: x })} />
          <F label={`Emails per day (max ${HARD_MAX.outboundPerDay})`} type="number" v={form.perDay ?? 10} on={(x) => setForm({ ...form, perDay: x })} />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={saveDirection} disabled={!!busy} tone={T.green}>{busy === "dir" ? "Saving…" : "Save"}</Btn>
            <Btn onClick={() => { setEditing(false); setForm(null); }}>Cancel</Btn>
          </div>
        </div>
      )}
      {!editing && ready && phase.phase !== PHASE.UNPOINTED && (
        <button onClick={openEditor} style={{ marginTop: 12, background: "none", border: "none", color: T.faint, fontSize: 11.5, cursor: "pointer", padding: 0 }}>
          Change who it writes to ›
        </button>
      )}
    </div>
  );
}

function Msg({ tone, children }) {
  return <div style={{ background: `${tone}18`, border: `1px solid ${tone}55`, borderRadius: 10, padding: "9px 12px", fontSize: 12, color: T.ink, marginBottom: 12, lineHeight: 1.5, wordBreak: "break-word" }}>{children}</div>;
}

function Btn({ children, onClick, disabled, tone }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      minHeight: 40, padding: "0 16px", borderRadius: 10, cursor: disabled ? "default" : "pointer",
      border: `1px solid ${tone || T.line}`, background: tone ? `${tone}22` : "transparent",
      color: tone ? T.ink : T.muted, fontSize: 12.5, fontWeight: 700, opacity: disabled ? 0.55 : 1,
    }}>{children}</button>
  );
}

function F({ label, hint, v, on, area, type = "text" }) {
  const s = { width: "100%", background: T.bg || "#0F1522", border: `1px solid ${T.line}`, borderRadius: 9, color: T.ink, fontSize: 12.5, padding: "9px 11px", fontFamily: "inherit", boxSizing: "border-box", lineHeight: 1.5 };
  return (
    <label style={{ display: "block", marginBottom: 11 }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: T.ink, marginBottom: 4 }}>{label}</div>
      {hint && <div style={{ fontSize: 10.5, color: T.faint, marginBottom: 5 }}>{hint}</div>}
      {area
        ? <textarea rows={2} value={v || ""} onChange={(e) => on(e.target.value)} style={{ ...s, minHeight: 56, resize: "vertical" }} />
        : <input type={type} value={v ?? ""} onChange={(e) => on(e.target.value)} style={s} />}
    </label>
  );
}
