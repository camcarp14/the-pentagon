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
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";
import { T, syne } from "./theme";
import { enginePhase, enginePlays, humanGap, PHASE } from "@cc/ops/plays.js";
import { armWrites, armState } from "@cc/ops/arm.js";
import { cadenceFor } from "@cc/ops/cadence.js";
import { resolveDirection, ENGINE, DIRECTION_KEY, HARD_MAX } from "@cc/ops/direction.js";
import { buildQueue, KIND } from "@cc/ops/queue.js";

const SUBSYSTEM = "zts.content";
const pub = () => supabase.schema("public");

const TONE = { go: T.green, warn: T.amber, prompt: T.blue, neutral: T.sub };
const PILL = {
  armed: { c: T.green, t: "Armed" },
  rehearsing: { c: T.amber, t: "Rehearsing" },
  off: { c: T.faint, t: "Off" },
  stopped: { c: T.red, t: "Stopped" },
  unknown: { c: T.red, t: "Unknown" },
};

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
    <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 18, padding: isMobile ? 16 : 20, marginBottom: 16, boxShadow: T.cardShadow }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <span style={{ fontSize: 16, fontWeight: 800, color: T.ink, fontFamily: syne }}>The writer</span>
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

      {/* the one true headline */}
      <div style={{ marginBottom: plays.length ? 14 : 0 }}>
        <div style={{ fontSize: 19, fontWeight: 800, color: T.ink, fontFamily: syne, lineHeight: 1.25 }}>
          {loaded ? phase.headline : "Reading state…"}
        </div>
        <div style={{ fontSize: 12.5, color: T.sub, marginTop: 4, lineHeight: 1.5 }}>{loaded ? phase.detail : ""}</div>
      </div>

      {/* plays — the first is always this phase's own remedy */}
      {plays.map((p, i) => (
        <button key={p.id} onClick={() => onPlay(p.action)} disabled={!!busy}
          style={{
            width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 12,
            background: i === 0 ? `${TONE[p.tone] || T.sub}14` : "transparent",
            border: `1px solid ${i === 0 ? `${TONE[p.tone] || T.sub}55` : T.line}`,
            borderRadius: 12, padding: "12px 14px", marginBottom: 8, cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1, minHeight: 46,
          }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: TONE[p.tone] || T.sub, flex: "none" }} />
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, color: T.ink }}>{busy === "arm" && p.action === "arm" ? "Arming…" : p.title}</span>
            {p.sub && <span style={{ display: "block", fontSize: 11.5, color: T.sub, marginTop: 2, lineHeight: 1.45 }}>{p.sub}</span>}
          </span>
          <span style={{ color: T.faint, fontSize: 16 }}>›</span>
        </button>
      ))}

      {/* the queue */}
      {queue.map((item) => (
        <div key={item.id} style={{ border: `1px solid ${T.line}`, borderRadius: 12, marginTop: 8, opacity: item.stale ? 0.6 : 1 }}>
          <button onClick={() => setOpenId(openId === item.id ? null : item.id)}
            style={{ width: "100%", textAlign: "left", background: "none", border: "none", padding: "12px 14px", cursor: "pointer" }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: T.ink, lineHeight: 1.35 }}>{item.title}</div>
            <div style={{ fontSize: 11.5, color: T.sub, marginTop: 3, lineHeight: 1.5 }}>{item.preview}</div>
            {item.why && <div style={{ fontSize: 11, color: T.faint, marginTop: 5 }}>Why: {item.why}</div>}
          </button>
          {openId === item.id && (
            <div style={{ padding: "0 14px 14px" }}>
              <div style={{ background: T.navy, border: `1px solid ${T.line}`, borderRadius: 10, padding: 12, maxHeight: 320, overflowY: "auto", fontSize: 12.5, color: T.ink, lineHeight: 1.65, marginBottom: 10 }}
                dangerouslySetInnerHTML={{ __html: drafts.find((d) => d.id === item.id)?.body_html || "" }} />
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
        <button onClick={openEditor} style={{ marginTop: 12, background: "none", border: "none", color: T.faint, fontSize: 11.5, cursor: "pointer", padding: 0 }}>
          Change what it writes about ›
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
      color: tone ? T.ink : T.sub, fontSize: 12.5, fontWeight: 700, fontFamily: syne, opacity: disabled ? 0.55 : 1,
    }}>{children}</button>
  );
}

function F({ label, hint, v, on, area, type = "text" }) {
  const s = { width: "100%", background: T.navy, border: `1px solid ${T.line}`, borderRadius: 9, color: T.ink, fontSize: 12.5, padding: "9px 11px", fontFamily: "inherit", boxSizing: "border-box", lineHeight: 1.5 };
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
