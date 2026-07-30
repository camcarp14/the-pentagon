// ═══════════════════════════════════════════════════════════════════════════
// OPS — the containment console.
//
// The guard (packages/ops) decides; the audit log records; this is where a human
// sees both and can stop everything. A kill switch with no button is not a kill
// switch, and an audit log with no viewer answers no questions.
//
// Two rules shaped this screen:
//
//   • The STOP control is always reachable and never behind a disclosure. It is
//     the one thing on this page you might need in a hurry, and the one thing
//     whose absence has a cost measured in real money.
//   • A blocked action is displayed as prominently as a taken one. The question
//     this log has to answer is "why did nothing happen last night", and it
//     cannot if refusals are filtered out or greyed into invisibility.
// ═══════════════════════════════════════════════════════════════════════════
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@cc/supabase";

const P = {
  bg: "#0A0E15", surface: "#131A24", surface2: "#0F151E", line: "rgba(255,255,255,0.08)",
  ink: "#E9EDF5", muted: "#93A1B5", faint: "#66748A",
  display: "'Syne', system-ui", mono: "'DM Mono', monospace",
  good: "#12A594", warn: "#D4930B", crit: "#E11D48",
};

// status → how it reads. `blocked` is amber and legible, not hidden: a refusal
// is information, not an absence.
const STATUS = {
  executed: { label: "executed", color: P.good },
  dry_run: { label: "dry run", color: P.muted },
  prepared: { label: "prepared", color: "#6EA8FE" },
  blocked: { label: "blocked", color: P.warn },
  failed: { label: "failed", color: P.crit },
};
const TIER_LABEL = ["T0 read", "T1 reversible", "T2 approval", "T3 never"];

const ago = (ts) => {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export default function Ops({ isMobile }) {
  const [control, setControl] = useState(null);
  const [log, setLog] = useState([]);
  const [runs, setRuns] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!supabase) { setErr("Supabase isn't configured — the containment state can't be read."); setLoaded(true); return; }
    setErr("");
    try {
      const [c, l, r] = await Promise.all([
        supabase.from("ops_control").select("*").order("key"),
        supabase.from("ops_audit_log").select("*").order("at", { ascending: false }).limit(50),
        supabase.from("ops_runs").select("*").order("started_at", { ascending: false }).limit(10),
      ]);
      // Each read is applied INDEPENDENTLY. Throwing on the first error before
      // any setState meant a failed audit-log read also discarded a perfectly
      // good control read — leaving `control` null, which rendered the confident
      // and unverified claim "Autonomy is OFF" while autonomy might be armed and
      // running, AND disabled the stop button in exactly that state.
      //
      // Now: whatever loaded, shows. Whatever failed, says so. `control` staying
      // null means "unknown", which the card renders as unknown.
      const errs = [];
      if (c.error) errs.push(`control: ${c.error.message}`); else setControl(c.data || []);
      if (l.error) errs.push(`audit log: ${l.error.message}`); else setLog(l.data || []);
      if (r.error) errs.push(`runs: ${r.error.message}`); else setRuns(r.data || []);
      if (errs.length) setErr(errs.join(" · "));
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const global = (control || []).find((c) => c.key === "global");
  const subsystems = (control || []).filter((c) => c.key !== "global");
  // Three states, not two. `unknown` exists because "we could not read the
  // control table" must never render as "autonomy is off" — that is a confident
  // claim in the dangerous direction, and it is the claim you would act on.
  const state = !loaded ? "loading" : !global ? "unknown" : global.enabled ? "armed" : "off";
  const armed = state === "armed";

  const setGlobal = async (enabled) => {
    setBusy(true);
    try {
      // STOP records an explicit pause, not just enabled=false. Those are two
      // different states that looked identical before: a system that has never
      // been armed, and one a human deliberately stopped. The Desk's approve
      // path refuses while `paused_reason` is set — so STOP genuinely stops
      // everything including a manual send — while leaving day-one manual
      // approval working before autonomy is ever switched on.
      const { error } = await supabase.from("ops_control")
        .update({
          enabled,
          paused_reason: enabled ? null : "stopped from the Ops console",
          paused_at: enabled ? null : new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("key", "global");
      if (error) throw new Error(error.message);
      await load();
    } catch (e) { setErr(`couldn't change the kill switch: ${e.message}`); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ fontSize: 20, fontWeight: 800, color: P.ink, fontFamily: P.display, margin: 0 }}>Ops</h2>
        <p style={{ fontSize: 12.5, color: P.muted, margin: "5px 0 0", lineHeight: 1.5 }}>
          Every autonomous action passes one guard and lands in one log. This is that guard, and that log.
        </p>
      </div>

      {err && (
        <div role="alert" style={{ background: "rgba(225,29,72,0.12)", border: `1px solid ${P.crit}55`, color: "#FF8DA6", borderRadius: 12, padding: "11px 13px", fontSize: 12.5, marginBottom: 14, lineHeight: 1.5 }}>
          {err}
        </div>
      )}

      {/* ── the stop control ─────────────────────────────────────────────── */}
      <div style={{
        background: armed ? "rgba(212,147,11,0.10)" : state === "unknown" ? "rgba(225,29,72,0.08)" : P.surface,
        border: `1px solid ${armed ? "rgba(212,147,11,0.45)" : state === "unknown" ? `${P.crit}55` : P.line}`,
        borderRadius: 16, padding: 18, marginBottom: 14,
        display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
      }}>
        <div style={{ minWidth: 0, flex: "1 1 260px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 5 }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: armed ? P.warn : state === "unknown" ? P.crit : P.faint, boxShadow: armed ? `0 0 9px ${P.warn}` : "none" }} />
            <span style={{ fontSize: 15.5, fontWeight: 800, color: P.ink, fontFamily: P.display }}>
              {{ loading: "Reading state…", unknown: "Autonomy state UNKNOWN", armed: "Autonomy is ARMED", off: "Autonomy is OFF" }[state]}
            </span>
          </div>
          <div style={{ fontSize: 12, color: P.muted, lineHeight: 1.5 }}>
            {state === "unknown"
              ? "The control table could not be read, so this screen cannot tell you whether autonomy is running. Assume it may be. Stopping is still safe to attempt."
              : armed
                ? "Subsystems may act — each still gated by its own enable flag, dry-run flag, caps and breaker, and by the stricter of the global and per-subsystem caps."
                : "The global switch is off. Nothing autonomous can execute, at any tier, regardless of per-subsystem settings."}
          </div>
        </div>
        {/* Deliberately NOT disabled when the state is unknown. Stopping is the
            safe direction, and the state where you least know what is running is
            exactly the state where you most want the option.

            `armed` is false in BOTH the "off" and "unknown" states, so a plain
            `!armed` made the button labelled "Force STOP" call setGlobal(true)
            and ARM autonomy — the exact opposite of the sentence above, from the
            one state where the operator least knows what is running. Resolve
            against `state`, not the boolean: unknown always stops. */}
        <button
          onClick={() => setGlobal(state === "unknown" ? false : !armed)}
          disabled={busy || !loaded}
          style={{
            flex: "none", minHeight: 44, padding: "0 20px", borderRadius: 11, cursor: busy ? "default" : "pointer",
            border: `1px solid ${armed ? P.crit : P.line}`,
            background: armed ? "rgba(225,29,72,0.16)" : "transparent",
            color: armed ? "#FF8DA6" : P.ink,
            fontSize: 13, fontWeight: 800, fontFamily: P.display, letterSpacing: "0.04em",
            opacity: busy ? 0.55 : 1,
          }}>
          {busy ? "…" : armed ? "STOP EVERYTHING" : state === "unknown" ? "Force STOP" : "Arm autonomy"}
        </button>
      </div>

      {/* ── per-subsystem ────────────────────────────────────────────────── */}
      <Card>
        <Label>Subsystems</Label>
        {subsystems.length === 0 ? (
          <Empty>
            No subsystem has registered yet. Each one inserts its own row on its first
            scheduled pass, disabled and in dry-run, so you opt it in deliberately.
            Until a subsystem has a row here it cannot act at all.
          </Empty>
        ) : (
          <div style={{ display: "grid", gap: 1, background: P.line, borderRadius: 12, overflow: "hidden" }}>
            {subsystems.map((s) => (
              <div key={s.key} style={{ background: P.surface2, padding: "11px 13px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontFamily: P.mono, fontSize: 12.5, color: P.ink, minWidth: 0, flex: "1 1 150px" }}>{s.key}</span>
                <Pill on={s.enabled} onLabel="enabled" offLabel="disabled" />
                {s.dry_run && <Pill on tone={P.muted} onLabel="dry run" />}
                {s.paused_reason && <Pill on tone={P.warn} onLabel={`paused: ${s.paused_reason}`} />}
                <span style={{ fontFamily: P.mono, fontSize: 11, color: P.faint, whiteSpace: "nowrap" }}>
                  {s.max_actions_per_hour}/h · ${Number(s.max_spend_usd_per_hour).toFixed(2)}/h
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── recent passes ────────────────────────────────────────────────── */}
      {runs.length > 0 && (
        <Card>
          <Label>Recent passes</Label>
          <div style={{ display: "grid", gap: 1, background: P.line, borderRadius: 12, overflow: "hidden" }}>
            {runs.map((r) => (
              <div key={r.id} style={{ background: P.surface2, padding: "10px 13px", display: "flex", alignItems: "baseline", gap: 10, fontSize: 12 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", flex: "none", background: r.ok === false ? P.crit : r.ok ? P.good : P.faint }} />
                <span style={{ fontFamily: P.mono, color: P.ink, minWidth: 0, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.subsystem}</span>
                <span style={{ color: P.muted, whiteSpace: "nowrap" }}>{r.actions} acted · {r.blocked} blocked</span>
                <span style={{ color: P.faint, fontFamily: P.mono, fontSize: 10.5, whiteSpace: "nowrap" }}>{ago(r.started_at)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── the audit log ────────────────────────────────────────────────── */}
      <Card>
        <Label>Audit log — every action, taken or refused</Label>
        {log.length === 0 ? (
          <Empty>
            Nothing has been attempted yet. When it has, every action appears here with what
            triggered it, why it ran, what it changed, and how to undo it — including the ones
            a guard refused.
          </Empty>
        ) : (
          <div style={{ display: "grid", gap: 1, background: P.line, borderRadius: 12, overflow: "hidden" }}>
            {log.map((e) => {
              const st = STATUS[e.status] || { label: e.status, color: P.faint };
              return (
                <div key={e.id} style={{ background: P.surface2, padding: "11px 13px" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em", color: st.color, fontFamily: P.display }}>{st.label}</span>
                    <span style={{ fontFamily: P.mono, fontSize: 12.5, color: P.ink }}>{e.subsystem} · {e.action}</span>
                    <span style={{ fontSize: 10.5, color: P.faint }}>{TIER_LABEL[e.tier] ?? `T${e.tier}`}</span>
                    <span style={{ marginLeft: "auto", fontSize: 10.5, color: P.faint, fontFamily: P.mono, whiteSpace: "nowrap" }}>{ago(e.at)}</span>
                  </div>
                  {/* The reason a guard refused is the most useful line in the
                      row, so it is never truncated or tucked behind a toggle. */}
                  {e.blocked_by && (
                    <div style={{ fontSize: 11.5, color: P.warn, marginTop: 4, lineHeight: 1.45 }}>blocked by {e.blocked_by}</div>
                  )}
                  {e.rationale && (
                    <div style={{ fontSize: 11.5, color: P.muted, marginTop: 3, lineHeight: 1.45 }}>{e.rationale}</div>
                  )}
                  {e.error && (
                    <div style={{ fontSize: 11.5, color: "#FF8DA6", marginTop: 3, lineHeight: 1.45 }}>{e.error}</div>
                  )}
                  {(Number(e.cost_usd) > 0 || e.undo) && (
                    <div style={{ display: "flex", gap: 12, marginTop: 5, fontSize: 10.5, color: P.faint, fontFamily: P.mono }}>
                      {Number(e.cost_usd) > 0 && <span>${Number(e.cost_usd).toFixed(4)}</span>}
                      {e.undo && <span style={{ color: e.undone_at ? P.good : P.muted }}>{e.undone_at ? "undone" : "undoable"}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <button onClick={load} disabled={busy}
        style={{ marginTop: 12, minHeight: 40, padding: "0 16px", borderRadius: 9, border: `1px solid ${P.line}`, background: "none", color: P.muted, fontSize: 12, fontWeight: 600, fontFamily: P.display, cursor: "pointer" }}>
        Refresh
      </button>
    </div>
  );
}

const Card = ({ children }) => (
  <div style={{ background: P.surface, border: `1px solid ${P.line}`, borderRadius: 16, padding: 18, marginBottom: 14 }}>{children}</div>
);
const Label = ({ children }) => (
  <div style={{ fontSize: 10.5, fontWeight: 700, color: P.faint, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 11, fontFamily: P.display }}>{children}</div>
);
const Empty = ({ children }) => (
  <div style={{ fontSize: 12, color: P.faint, lineHeight: 1.6 }}>{children}</div>
);
const Pill = ({ on, tone, onLabel, offLabel }) => (
  <span style={{
    flex: "none", fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 99,
    fontFamily: P.display, letterSpacing: "0.04em", textTransform: "uppercase",
    color: tone || (on ? P.good : P.faint),
    border: `1px solid ${(tone || (on ? P.good : P.faint))}44`,
    background: `${tone || (on ? P.good : P.faint)}14`,
  }}>{on ? onLabel : offLabel}</span>
);
