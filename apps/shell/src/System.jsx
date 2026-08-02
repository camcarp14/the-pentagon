// ═══════════════════════════════════════════════════════════════════════════
// System — the shell-owned, cross-tool management layer.
//
// The three tools each kept their own copy of the same subsystems (AI-usage
// logging, the DNA "mind", the agent workers). Now that all three run on ONE
// domain, they share ONE localStorage — so the shell can read every tool's
// state directly and present it in one place: total spend across tools, both
// minds side by side, and what every agent is doing. Read-first (zero-risk,
// shows your real existing data); Supabase-backed cross-device logging + Runway
// server usage are the fast-follow.
// ═══════════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from "react";
import { appMeta } from "@cc/design";
import { PALETTES } from "@cc/design/palettes.js";
import { visibleTabs, isHidden, canHide, toggleTab, moveTab, resetTabPrefs, DEFAULT_HIDDEN } from "./tabPrefs.js";
import { normalizeThemePrefs, resolveMode, resetThemePrefs } from "./themePrefs.js";
import { powerFor, stopsSentence, stoppedSentence, keepsSentence } from "./toolPower.js";
import { AnimatedNumber, EmptyState, useIsMobile, useToast } from "@cc/ui";
import { auth, supabase } from "@cc/supabase";
import Ops from "./Ops.jsx";

// Which localStorage prefix each tool writes under (they run on one domain now).
const LS = { zts: "zts_", clarify: "sm_", looper: "lp_" };
const USAGE_APPS = ["zts", "clarify", "looper"]; // Runway logs AI server-side; not yet unified

// ─── neutral "platform" palette (its own identity, not any one tool's) ───────
//
// TOKENS, NOT HEXES — and the change is not tidiness. This screen is where the
// theme is chosen, so it was the one surface that could ship a Light button
// which visibly failed on the very page it was pressed from: seven hardcoded
// midnight hexes cannot go light, whatever the setting says. Each name below
// resolves to exactly the value it used to hold on the default dark path
// (App.jsx's PLATFORM_VARS carries those seven verbatim, including --subtle for
// what was `surface2`), so nothing moves until the operator asks it to; when
// they do, themePrefs.js re-points the same names at the generated light half.
const P = {
  bg: "var(--bg)", surface: "var(--surface)", surface2: "var(--subtle)", line: "var(--border)",
  ink: "var(--ink)", muted: "var(--muted)", faint: "var(--faint)",
  // The two semantics this screen speaks: an engine that is running, and one
  // that is stopped. Kept apart from the accent on purpose — §4.4 gives the
  // accent one job, saying which tool you are in, and the switches below sit
  // next to eight different accents.
  good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)",
  // System stack: the Syne/DM Mono webfonts are retired (DESIGN.md §3) and
  // the <link> that loaded them is gone, so naming them here resolved to
  // nothing and mismeasured every heading and number on this screen.
  display: "var(--font-display)", mono: "var(--font-mono)",
};

const readJSON = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};
const fmt$ = (n) => `$${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtN = (n) => (n || 0).toLocaleString();
const ago = (ts) => {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// ─── server-side spend (Ideas) ────────────────────────────────────────────────
// Every other tool logs its calls to localStorage from the browser that made
// them. Ideas cannot: its spend happens in a scheduled GitHub Action with no
// browser attached, and the run log is written straight to Postgres. So it is
// pulled rather than read, and it is the first tool here whose numbers are
// device-independent — the same figures on the phone as on the desktop.
//
// One row per pipeline run, and the pipeline caps its own history, so this is a
// bounded read. A failure resolves to "not tracked" rather than throwing: a
// cross-tool overview that dies because one tool's table is unreachable is
// worse than one that says so.
function useIdeasSpend(cutoff) {
  const [state, setState] = useState({ loading: true, error: null, runs: [] });

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!supabase) { setState({ loading: false, error: "not configured", runs: [] }); return; }
      const { data, error } = await supabase
        .from("ideafeed_runs")
        .select("ran_at,cost_usd,api_calls,input_tokens,output_tokens")
        .order("ran_at", { ascending: false })
        .limit(400);
      if (!alive) return;
      setState({ loading: false, error: error?.message || null, runs: data || [] });
    })();
    return () => { alive = false; };
  }, []);

  return useMemo(() => {
    const runs = state.runs.filter((r) => new Date(r.ran_at).getTime() >= cutoff);
    const t = { cost: 0, inTok: 0, outTok: 0, calls: 0, runs: runs.length, last: state.runs[0]?.ran_at || null };
    for (const r of runs) {
      t.cost += Number(r.cost_usd) || 0;
      t.inTok += Number(r.input_tokens) || 0;
      t.outTok += Number(r.output_tokens) || 0;
      t.calls += Number(r.api_calls) || 0;
    }
    return { ...t, loading: state.loading, error: state.error };
  }, [state, cutoff]);
}

// ─── shared bits ──────────────────────────────────────────────────────────────
// 18px of padding on every card, nested two deep, was most of the dead space on
// this screen. 14 matches the kit's --pad-card and still breathes.
const Card = ({ children, style }) => (
  <div style={{ background: P.surface, border: `1px solid ${P.line}`, borderRadius: 14, padding: 14, ...style }}>{children}</div>
);
const Dot = ({ app, size = 8 }) => (
  <span style={{ width: size, height: size, borderRadius: "50%", background: appMeta(app).accent, boxShadow: `0 0 8px ${appMeta(app).accent}66`, display: "inline-block", flexShrink: 0 }} />
);
// The kit's .stattile, not a hand-rolled card. The old version was a full Card
// (18px padding, 26px/800 value, uppercase 0.1em-tracked label) laid out with
// `flex: 1; min-width: 150` and flex-wrap — which on a phone fitted two per row
// and dropped the third onto a line of its own, so "AI calls" rendered as a
// near-empty full-width slab. That is what "the spacing is huge" was.
const Stat = ({ label, children, sub }) => (
  <div className="stattile on-canvas">
    <span className="stattile-value">{children}</span>
    <span className="stattile-label">{label}</span>
    {sub && <span className="stattile-label" style={{ color: P.faint, whiteSpace: "normal" }}>{sub}</span>}
  </div>
);

// ─── USAGE ─────────────────────────────────────────────────────────────────────
function Usage({ isMobile }) {
  const [win, setWin] = useState("7d");
  const cutoff = win === "24h" ? Date.now() - 864e5 : win === "7d" ? Date.now() - 7 * 864e5 : 0;
  // Ideas has no per-call rows to list — the pipeline reports one aggregate per
  // run — so it contributes to the totals and the by-tool bars but not to the
  // call log below, which stays a browser-local record of individual calls.
  const ideas = useIdeasSpend(cutoff);

  const calls = useMemo(() => {
    const rows = [];
    for (const app of USAGE_APPS) {
      const log = readJSON(`${LS[app]}obs_log`, []);
      if (Array.isArray(log)) for (const e of log) rows.push({ ...e, app });
    }
    return rows
      .filter((e) => new Date(e.ts).getTime() >= cutoff)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts));
  }, [cutoff]);

  const agg = useMemo(() => {
    const t = { cost: 0, inTok: 0, outTok: 0, calls: 0, lat: 0, byApp: {}, byModel: {} };
    for (const c of calls) {
      t.cost += c.costEstimate || 0; t.inTok += c.inputTokens || 0; t.outTok += c.outputTokens || 0;
      t.calls++; t.lat += c.latencyMs || 0;
      t.byApp[c.app] = (t.byApp[c.app] || 0) + (c.costEstimate || 0);
      const m = c.model || "unknown";
      t.byModel[m] = t.byModel[m] || { calls: 0, tok: 0, cost: 0 };
      t.byModel[m].calls++; t.byModel[m].tok += (c.inputTokens || 0) + (c.outputTokens || 0); t.byModel[m].cost += c.costEstimate || 0;
    }
    return t;
  }, [calls]);

  const byApp = { ...agg.byApp };
  if (!ideas.error && ideas.cost > 0) byApp.ideas = (byApp.ideas || 0) + ideas.cost;
  const totalCost = agg.cost + (ideas.error ? 0 : ideas.cost);
  const totalIn = agg.inTok + (ideas.error ? 0 : ideas.inTok);
  const totalOut = agg.outTok + (ideas.error ? 0 : ideas.outTok);
  const totalCalls = agg.calls + (ideas.error ? 0 : ideas.calls);
  const spendApps = [...USAGE_APPS, ...(byApp.ideas ? ["ideas"] : [])];
  const maxApp = Math.max(0.0001, ...Object.values(byApp));

  return (
    <div>
      <Header title="Usage" sub="AI tokens, cost & latency across every tool"
        right={<Segment value={win} onChange={setWin} options={[["24h", "24h"], ["7d", "7 days"], ["all", "All time"]]} />} />

      {totalCalls === 0 ? (
        <EmptyState icon="chart" title="No AI calls logged in this window"
          sub="Generate a Short, draft outreach, or tailor a résumé and spend shows up here across all tools." />
      ) : (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <Stat label="Total spend"><AnimatedNumber value={totalCost} format={fmt$} /></Stat>
            <Stat label="Tokens" sub={`${fmtN(totalIn)} in · ${fmtN(totalOut)} out`}><AnimatedNumber value={totalIn + totalOut} format={fmtN} /></Stat>
            <Stat label="Calls"><AnimatedNumber value={totalCalls} format={fmtN} /></Stat>
            <Stat label="Avg latency" sub="per call">{agg.calls ? Math.round(agg.lat / agg.calls) : 0}<span style={{ fontSize: 14, color: P.muted }}>ms</span></Stat>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1.3fr", gap: 12, marginBottom: 14 }}>
            <Card>
              <SectionLabel>Spend by tool</SectionLabel>
              {spendApps.map((app) => (
                <div key={app} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 5 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: P.ink }}><Dot app={app} />{appMeta(app).brand}</span>
                    <span style={{ color: P.muted, fontFamily: P.mono }}>{fmt$(byApp[app] || 0)}</span>
                  </div>
                  <div style={{ height: 7, borderRadius: 99, background: P.surface2, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${((byApp[app] || 0) / maxApp) * 100}%`, background: appMeta(app).accent, borderRadius: 99, transition: "width .4s cubic-bezier(0.16,1,0.3,1)" }} />
                  </div>
                </div>
              ))}
              <div style={{ fontSize: 11, color: P.faint, marginTop: 4, lineHeight: 1.5 }}>Runway runs its AI server-side — unified logging for it is the next step.</div>
            </Card>

            <Card>
              <SectionLabel>By model</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {Object.entries(agg.byModel).sort((a, b) => b[1].cost - a[1].cost).map(([model, m]) => (
                  <div key={model} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5 }}>
                    <span style={{ color: P.ink, fontFamily: P.mono, fontSize: 11.5 }}>{model}</span>
                    <span style={{ color: P.muted, display: "flex", gap: 14 }}>
                      <span>{fmtN(m.calls)} calls</span><span>{fmtN(m.tok)} tok</span><span style={{ color: P.ink, fontFamily: P.mono }}>{fmt$(m.cost)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <Card>
            <SectionLabel>Recent calls</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {calls.slice(0, 24).map((c, i) => (
                <div key={c.id || i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: i < 23 ? `1px solid ${P.line}` : "none", fontSize: 12 }}>
                  <Dot app={c.app} />
                  <span style={{ color: P.ink, minWidth: 130, fontWeight: 600 }}>{c.fn || "call"}</span>
                  <span style={{ color: P.faint, fontFamily: P.mono, fontSize: 10.5, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.model}</span>
                  <span style={{ color: P.muted, width: 90, textAlign: "right" }}>{fmtN((c.inputTokens || 0) + (c.outputTokens || 0))} tok</span>
                  <span style={{ color: P.muted, width: 60, textAlign: "right", fontFamily: P.mono }}>{fmt$(c.costEstimate)}</span>
                  <span style={{ color: c.ok === false ? P.bad : P.faint, width: 62, textAlign: "right", fontSize: 10.5 }}>{c.ok === false ? "failed" : `${c.latencyMs || 0}ms`}</span>
                  <span style={{ color: P.faint, width: 68, textAlign: "right", fontSize: 10.5 }}>{ago(c.ts)}</span>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

// ─── BROWSER ASSISTANTS ─────────────────────────────────────────────────────
// These controls affect browser-resident assistants only. Production scheduled
// jobs are deliberately elsewhere: their source of truth is Ops / Tools on the
// server, not the localStorage document this panel uses.
// Both tools share one engine_ctrl shape
// { running, observeOnly, allowSonnet, pauseWhenIdle, cadenceSec, ... } written
// as plain JSON under their prefix; each tool's headless engine re-reads it on
// every heartbeat and on remount, so toggling here drives it directly.
const ENGINE_DEFAULTS = { running: false, observeOnly: true, allowSonnet: false, pauseWhenIdle: true, cadenceSec: 20 };

const Switch = ({ on }) => (
  <span style={{ width: 40, height: 23, borderRadius: 99, background: on ? P.good : "color-mix(in srgb, var(--ink) 14%, transparent)", position: "relative", flexShrink: 0, transition: "background .2s cubic-bezier(0.16,1,0.3,1)" }}>
    <span style={{ position: "absolute", top: 2.5, left: on ? 19.5 : 2.5, width: 18, height: 18, borderRadius: "50%", background: "var(--surface)", boxShadow: "0 1px 3px rgba(0,0,0,0.4)", transition: "left .2s cubic-bezier(0.16,1,0.3,1)" }} />
  </span>
);
const CtrlRow = ({ on, onClick, label, sub, tone }) => (
  <button onClick={onClick} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, width: "100%", background: "none", border: "none", borderTop: `1px solid ${P.line}`, cursor: "pointer", padding: "11px 0", textAlign: "left" }}>
    <span style={{ minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: tone || P.ink }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: P.faint, marginTop: 2 }}>{sub}</div>}
    </span>
    <Switch on={on} />
  </button>
);

function BrowserAssistants({ isMobile }) {
  const [, force] = useState(0);
  const patch = (app, key, p) => {
    const cur = readJSON(`${LS[app]}${key}`, {});
    try { localStorage.setItem(`${LS[app]}${key}`, JSON.stringify({ ...cur, ...p })); } catch { /* storage full/blocked — nothing to do */ }
    force((n) => n + 1);
  };

  const tools = ["zts", "clarify"].map((app) => ({
    app,
    ctrl: { ...ENGINE_DEFAULTS, ...readJSON(`${LS[app]}engine_ctrl`, {}) },
    worker: readJSON(`${LS[app]}dna_worker_ctrl`, {}),
    kb: readJSON(`${LS[app]}agent_kb`, []),
  }));
  const feed = tools
    .flatMap((t) => (Array.isArray(t.kb) ? t.kb.map((e) => ({ ...e, app: t.app })) : []))
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    .slice(0, 30);

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12, marginBottom: 14 }}>
        {tools.map(({ app, ctrl, worker }) => (
          <Card key={app}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 4 }}>
              <Dot app={app} size={10} />
              <span style={{ fontSize: 14, fontWeight: 800, color: P.ink, fontFamily: P.display }}>{appMeta(app).brand}</span>
              <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 700, color: ctrl.running ? P.good : P.faint }}>{ctrl.running ? "● Running" : "Paused"}</span>
            </div>
            <CtrlRow on={!!ctrl.running} onClick={() => patch(app, "engine_ctrl", { running: !ctrl.running })}
              label={ctrl.running ? "Engine running" : "Engine paused"}
              sub={`Free heartbeat every ${ctrl.cadenceSec ?? 20}s${ctrl.hourlyCostCap != null ? ` · cap ${fmt$(ctrl.hourlyCostCap)}/hr` : ""}`}
              tone={ctrl.running ? P.good : P.ink} />
            <CtrlRow on={!!ctrl.observeOnly} onClick={() => patch(app, "engine_ctrl", { observeOnly: !ctrl.observeOnly })}
              label="Observe-only" sub="Heuristics only — never spends tokens" />
            <CtrlRow on={!!ctrl.allowSonnet} onClick={() => patch(app, "engine_ctrl", { allowSonnet: !ctrl.allowSonnet })}
              label="Allow Sonnet" sub="Off = synthesis stays on cheap Haiku" />
            <CtrlRow on={!!ctrl.pauseWhenIdle} onClick={() => patch(app, "engine_ctrl", { pauseWhenIdle: !ctrl.pauseWhenIdle })}
              label="Pause when idle" sub="Auto-stop after you've been away" />
            <CtrlRow on={!!worker.running} onClick={() => patch(app, "dna_worker_ctrl", { running: !worker.running })}
              label="DNA worker" sub="Compiles the mind into the prompt on a heartbeat" />
          </Card>
        ))}
      </div>
      <Card>
        <SectionLabel>Recent agent activity</SectionLabel>
        {feed.length === 0 ? (
          <div style={{ color: P.faint, fontSize: 12.5, padding: "10px 0" }}>No agent activity logged yet. Turn on an engine above.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {feed.map((e, i) => (
              <div key={e.id || i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", borderBottom: i < feed.length - 1 ? `1px solid ${P.line}` : "none", fontSize: 12 }}>
                <Dot app={e.app} />
                <span style={{ color: P.muted, minWidth: 96, fontSize: 11, fontWeight: 600 }}>{e.agent || "agent"}</span>
                <span style={{ color: P.ink, flex: 1, lineHeight: 1.5 }}>{e.text || e.signal || "—"}</span>
                <span style={{ color: P.faint, fontSize: 10.5, whiteSpace: "nowrap" }}>{ago(e.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
      <div style={{ fontSize: 11.5, color: P.faint, marginTop: 12, lineHeight: 1.5 }}>
        Changes apply the next time each tool's engine ticks (it re-reads these on every heartbeat). The per-agent roster still shows on each tool's Mission view.
      </div>
    </div>
  );
}

function Intelligence({ isMobile }) {
  return (
    <div className="pagefade">
      <Header
        title="Intelligence"
        sub="Browser-only assistant controls. The shared belief graph lives in SYNC Mind."
        right={<button className="btn sm quiet" type="button" onClick={() => { window.location.hash = "/sync/mind"; }}>Open master Mind</button>}
      />
      <BrowserAssistants isMobile={isMobile} />
    </div>
  );
}

// ─── chrome ────────────────────────────────────────────────────────────────────
// The kit's .t-label is the ONE place uppercase survives (DESIGN.md §4.3), so
// this keeps the caps but drops to the kit's 0.05em tracking from 0.1em, which
// at 10.5px was wide enough to read as a separate typeface.
const SectionLabel = ({ children }) => (
  <div className="t-label" style={{ marginBottom: 10 }}>{children}</div>
);
const Header = ({ title, sub, right }) => (
  <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 18, gap: 16, flexWrap: "wrap" }}>
    <div>
      <div style={{ fontSize: 20, fontWeight: 800, color: P.ink, fontFamily: P.display }}>{title}</div>
      <div style={{ fontSize: 12.5, color: P.muted, marginTop: 3 }}>{sub}</div>
    </div>
    {right}
  </div>
);
// ─── Tools — desktop rail order and scheduled-job power ──────────────────────
// Lives in System because it is chrome preference, not a tool's own setting:
// putting it inside ZTS would mean opening one tool to control whether another
// is visible.
//
// Reorder is up/down buttons rather than drag-and-drop. Dragging is worse on
// the surface that matters most here — a phone, where a long-press drag fights
// the page scroll — and it is unusable by keyboard. Two buttons are operable by
// touch, mouse and keyboard with no library.
// ─── the POWER half of a tab row ─────────────────────────────────────────────
//
// TWO SWITCHES, INCHES APART, WITH OPPOSITE KINDS OF MEANING. That is the whole
// design problem, and the answer is not a better pill — it is that they must not
// look like a pair of anything.
//
//   • The visibility switch sits on the tool's own LINE and wears the tool's
//     ACCENT. It is about this bar.
//   • Power sits on its OWN line under a hairline, wears green/amber rather than
//     any accent, is the only one of the two that carries a WORD ("Running" /
//     "Paused"), and is the only one with a sentence under it naming, by name,
//     the scheduled jobs it stops. It is about a server.
//
// The row card deliberately does NOT dim when a tool is hidden — only its top
// line does. Dimming the whole card would make "hidden" read as "off", which is
// the exact confusion the two controls exist to keep apart.
//
// The sentence comes from the ENGINES THE SERVER REPORTED (toolPower.js rule 1),
// never from a list written here, so it cannot promise to stop something that no
// longer runs.
function PowerRow({ app, label, entry, loading, error, busy, onToggle }) {
  const engines = entry?.engines || [];
  const paused = !!entry?.paused;
  const mixed = !!entry?.mixed;
  const state = error ? "unknown" : loading && engines.length === 0 ? "loading" : !engines.length ? "none" : paused ? "paused" : mixed ? "mixed" : "running";
  const keeps = keepsSentence(entry);
  const tone = { running: P.good, paused: P.warn, mixed: P.warn, none: P.faint, unknown: P.bad, loading: P.faint }[state];
  const word = { running: "Running", paused: "Paused", mixed: "Partly paused", none: "Nothing scheduled", unknown: "Unknown", loading: "Reading…" }[state];

  const copy = state === "unknown"
    // A control whose state could not be READ must not offer to write. Naming
    // the direction it failed in matters: this reads as "we do not know", never
    // as "it is off".
    ? `Couldn't read what ${label} runs in the background — ${error}. Nothing here has been changed.`
    : state === "none"
      // The contract's own wording. A switch here would write to no rows and
      // then sit there looking as though it had done something.
      ? "Nothing runs in the background for this tool — there is nothing to pause."
      : state === "mixed"
        ? `${stoppedSentence(entry)} The rest are still running; the switch stops all of them.`
        : stopsSentence(entry) || "";

  return (
    <div style={{ borderTop: `1px solid ${P.line}`, marginTop: 10, paddingTop: 10, display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="t-label">Background engines</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: tone, fontFamily: P.display }}>{word}</span>
        </span>
        <span style={{ display: "block", fontSize: 11.5, color: P.faint, marginTop: 3, lineHeight: 1.55 }}>{copy}</span>
        {/* The exception, printed rather than glossed over. Macro's alt sentinel
            goes on taking its daily BTC-dominance sample while paused because
            that series cannot be backfilled — so "pauses the alt sentinel" on
            its own would be an over-promise, and an operator who later found a
            row written on a paused day would rightly stop trusting the switch. */}
        {keeps && state !== "unknown" && state !== "none" && (
          <span style={{ display: "block", fontSize: 11.5, color: P.muted, marginTop: 3, lineHeight: 1.55 }}>{keeps}</span>
        )}
      </span>
      {/* THE SWITCH IS ALWAYS DRAWN, and disabled when it cannot honestly act.
          It used to render only when engines.length > 0, which is defensible as
          a rule — a control whose state could not be READ must not offer to
          write — and wrong as an interface. In production SUPABASE_SERVICE_ROLE_KEY
          is unset, so every row reads "unknown", every switch vanished, and the
          paragraph at the top of this page went on promising "Power is the other
          switch" above eight rows that had exactly one. An absent control cannot
          explain itself; a disabled one can, and the reason is already printed
          beside it.

          `actionable` is the whole gate: unknown (could not read) and none
          (nothing scheduled) both refuse the write for different stated
          reasons, and busy refuses it because one is already in flight. */}
      {(() => {
        const actionable = state !== "unknown" && state !== "none";
        const why = state === "unknown"
          ? "Can't pause what we couldn't read — see the reason on the left"
          : state === "none"
            ? "Nothing runs in the background for this tool"
            : paused ? "Start these running again" : "Stop these until you turn them back on";
        return (
        <button
          type="button"
          role="switch"
          aria-checked={actionable ? !paused : false}
          aria-label={`${paused ? "Resume" : "Pause"} ${label}'s background engines`}
          disabled={!!busy || !actionable}
          title={why}
          onClick={() => actionable && onToggle(!paused)}
          style={{
            // A DIFFERENT SHAPE, not just a different colour. ZTS's accent is
            // emerald, so on that row a green pill would sit directly under a
            // green pill and the two most different controls on the screen would
            // be the two that look most alike — and that is the ONE row where
            // the mistake is most expensive, because ZTS runs the most. Square
            // corners survive every accent, every palette and both modes; a
            // colour choice survives none of them.
            width: 46, height: 28, flex: "none", padding: 3, borderRadius: 8,
            border: `1px solid ${!actionable ? P.line : paused ? P.warn : P.good}`,
            background: !actionable ? "transparent" : `color-mix(in srgb, ${paused ? P.warn : P.good} 20%, transparent)`,
            cursor: busy ? "progress" : actionable ? "pointer" : "not-allowed",
            opacity: busy ? 0.5 : actionable ? 1 : 0.45,
            display: "flex", justifyContent: paused ? "flex-start" : "flex-end", alignItems: "center",
            transition: "background var(--dur-2, 240ms) ease, border-color var(--dur-2, 240ms) ease, justify-content var(--dur-2, 240ms) ease",
          }}
        >
          <span aria-hidden="true" style={{
            width: 20, height: 20, borderRadius: 5, display: "block",
            background: !actionable ? P.faint : paused ? P.warn : P.good,
            transition: "background var(--dur-2, 240ms) ease",
          }} />
        </button>
        );
      })()}
    </div>
  );
}

// ─── Tools — desktop rail order and scheduled-job power ──────────────────────
// Lives in System because it is chrome preference, not a tool's own setting:
// putting it inside ZTS would mean opening one tool to control whether another
// is visible.
//
// Reorder is up/down buttons rather than drag-and-drop. Dragging is worse on
// the surface that matters most here — a phone, where a long-press drag fights
// the page scroll — and it is unusable by keyboard. Two buttons are operable by
// touch, mouse and keyboard with no library.
function Tools({ prefs, onChange, isMobile, toolPower }) {
  const shownCount = visibleTabs(prefs).length;
  const toast = useToast();
  const rowBtn = (enabled) => ({
    width: 34, height: 34, flex: "none", display: "grid", placeItems: "center",
    background: "none", border: `1px solid ${P.line}`, borderRadius: 8,
    color: enabled ? P.muted : P.faint, cursor: enabled ? "pointer" : "default",
    opacity: enabled ? 1 : 0.35, fontSize: 13,
  });

  // Optimistic, and the rollback lives in useToolPower — all this has to do is
  // say what failed. A switch that flips back with no explanation is read as a
  // bug in the switch rather than as a refused write.
  const setPaused = async (app, next) => {
    try { await toolPower.setPaused(app, next); }
    catch (e) { toast.push(`Couldn't ${next ? "pause" : "resume"} ${appMeta(app).label} — ${String(e?.message || e)}`, { tone: "error" }); }
  };

  return (
    <div className="pagefade">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        <div style={{ fontSize: 15, fontWeight: 800, fontFamily: P.display }}>Tool access</div>
        <button
          onClick={() => onChange(resetTabPrefs())}
          style={{ background: "none", border: `1px solid ${P.line}`, color: P.muted, borderRadius: 8, padding: "6px 12px", fontSize: 11.5, cursor: "pointer", fontFamily: P.display, fontWeight: 600 }}
        >Reset to default</button>
      </div>
      {/* The first sentence is the one that was already here and has to STAY
          true — hiding really does stop nothing. The second is the new switch's,
          put directly beside it because the two controls are what a reader is
          trying to tell apart, and separating their explanations by half a
          screen is how you guarantee they never do. */}
      <div style={{ fontSize: 12.5, color: P.muted, lineHeight: 1.6, marginBottom: 16, maxWidth: 620 }}>
        Choose the tools shown in navigation and the keyboard shortcuts. Hiding a
        tool removes it from the desktop rail and phone dock, but never stops it
        or changes its data. <strong style={{ color: P.ink, fontWeight: 700 }}>Power is the other switch:</strong>{" "}
        it stops that tool's scheduled jobs on the server, and each one says which
        jobs those are. <span style={{ color: P.faint }}>⌥1–⌥{Math.min(shownCount, 6)} jump to the visible tools in this order.</span>
      </div>

      <div className="stagger" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {prefs.order.map((app, i) => {
          const m = appMeta(app);
          const hidden = isHidden(prefs, app);
          const canUp = i > 0;
          const canDown = i < prefs.order.length - 1;
          // The last visible tool cannot be hidden — the control is disabled and
          // says why, rather than absorbing the tap and doing nothing.
          const blockedLast = !hidden && !canHide(prefs, app);
          return (
            <div key={app} style={{
              padding: isMobile ? "10px 12px" : "12px 14px",
              background: P.surface, border: `1px solid ${P.line}`, borderRadius: 12,
            }}>
              {/* Only this line dims when the tool is hidden. See PowerRow. */}
              <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12, opacity: hidden ? 0.55 : 1 }}>
              <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: "50%", flex: "none", background: m.accent, boxShadow: hidden ? "none" : `0 0 8px ${m.accent}` }} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, fontFamily: P.display, color: P.ink }}>{m.label}</span>
                <span style={{ display: "block", fontSize: 11.5, color: P.faint, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {/* "Hidden from navigation", not "Hidden" — with a power switch
                      one line below, a bare "Hidden" invites the reading that
                      the tool itself is off. */}
                  {hidden ? "Hidden from navigation" : m.brand}
                </span>
              </span>

              <button type="button" onClick={() => canUp && onChange(moveTab(prefs, app, -1))}
                disabled={!canUp} aria-label={`Move ${m.label} earlier`} title="Move earlier"
                style={rowBtn(canUp)}>↑</button>
              <button type="button" onClick={() => canDown && onChange(moveTab(prefs, app, 1))}
                disabled={!canDown} aria-label={`Move ${m.label} later`} title="Move later"
                style={rowBtn(canDown)}>↓</button>

              <button
                type="button"
                role="switch"
                aria-checked={!hidden}
                aria-label={`${hidden ? "Show" : "Hide"} ${m.label} in tool navigation`}
                disabled={blockedLast}
                title={blockedLast ? "At least one tool has to stay visible" : hidden ? "Show in tool navigation" : "Hide from tool navigation"}
                onClick={() => !blockedLast && onChange(toggleTab(prefs, app))}
                style={{
                  width: 46, height: 28, flex: "none", padding: 3, borderRadius: 999,
                  border: `1px solid ${hidden ? P.line : m.accent}`,
                  background: hidden ? P.surface2 : `color-mix(in srgb, ${m.accent} 26%, transparent)`,
                  cursor: blockedLast ? "not-allowed" : "pointer",
                  opacity: blockedLast ? 0.4 : 1,
                  display: "flex", justifyContent: hidden ? "flex-start" : "flex-end", alignItems: "center",
                  transition: "background var(--dur-2, 240ms) ease, border-color var(--dur-2, 240ms) ease, justify-content var(--dur-2, 240ms) ease",
                }}
              >
                <span aria-hidden="true" style={{
                  width: 20, height: 20, borderRadius: "50%", display: "block",
                  background: hidden ? P.faint : m.accent,
                  transition: "background var(--dur-2, 240ms) ease",
                }} />
              </button>
              </div>

              <PowerRow
                app={app}
                label={m.label}
                entry={powerFor(toolPower?.power, app)}
                loading={!!toolPower?.loading}
                error={toolPower?.error || ""}
                busy={toolPower?.busy === app}
                onToggle={(next) => setPaused(app, next)}
              />
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 11.5, color: P.faint, marginTop: 14, lineHeight: 1.6 }}>
        System is always reachable, whatever is hidden. This preference changes
        the desktop rail, phone dock, and ⌥ shortcuts.
        {" "}Default: {DEFAULT_HIDDEN.map((a) => appMeta(a).label).join(", ")} start hidden.
        {" "}Pausing is stored on the server, not in this browser — it is the same
        table the Ops console's global stop writes, which is why a scheduled job
        with no tab open can see it.
      </div>
    </div>
  );
}

function Segment({ value, onChange, options }) {
  return (
    <div style={{ display: "inline-flex", gap: 2, padding: 3, borderRadius: 10, background: P.surface2, border: `1px solid ${P.line}` }}>
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)} style={{ padding: "5px 12px", border: "none", borderRadius: 7, cursor: "pointer", background: v === value ? P.surface : "transparent", color: v === value ? P.ink : P.faint, fontSize: 11.5, fontWeight: 700, fontFamily: P.display }}>{label}</button>
      ))}
    </div>
  );
}

// ─── THEME — palette and mode, across the board ──────────────────────────────
//
// ITS OWN TAB, NOT A SECTION UNDER "Tools". Two reasons, one of them the
// operator's. Theirs: "change the theme across the board" is a global setting,
// and Tools is emphatically not global — it is a per-tool list, and it just grew
// a second per-tool control. Mine: that list now carries two switches whose
// difference is the hardest thing on this screen to communicate, and hanging a
// nine-swatch grid off the bottom of it is how both settings end up half-read.
//
// EVERY SWATCH COMES FROM packages/design's GENERATED palettes.js, which exists
// for exactly this ("Labels + swatches for any picker UI"). Not one colour is
// typed here. That is not neatness: the table is regenerated by `npm run
// themes`, so a hand-copied hex would be a picker that lies about the palette it
// applies, and it would lie silently.
//
// The swatch shows the palette in the mode you are ACTUALLY IN — `day` when the
// resolved ground is light, `night` when it is dark — because a preview of the
// other room is a preview of something you will not get.
function Theme({ prefs, onChange, systemPrefersDark, isMobile }) {
  const cur = normalizeThemePrefs(prefs);
  const mode = resolveMode(cur, systemPrefersDark);
  const swatchOf = (p) => (mode === "light" ? p.day : p.night);

  const card = (selected) => ({
    display: "flex", alignItems: "center", gap: 11, width: "100%", textAlign: "left",
    padding: "11px 12px", borderRadius: 12, cursor: "pointer",
    background: selected ? P.surface : P.surface2,
    // Border OR shadow, never both (§4.2). The selected card gets a brighter
    // hairline, not a glow.
    border: `1px solid ${selected ? P.ink : P.line}`,
    fontFamily: P.display,
  });

  return (
    <div className="pagefade">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        <div style={{ fontSize: 15, fontWeight: 800, fontFamily: P.display }}>Theme</div>
        <button
          onClick={() => onChange(resetThemePrefs())}
          style={{ background: "none", border: `1px solid ${P.line}`, color: P.muted, borderRadius: 8, padding: "6px 12px", fontSize: 11.5, cursor: "pointer", fontFamily: P.display, fontWeight: 600 }}
        >Reset to default</button>
      </div>
      <div style={{ fontSize: 12.5, color: P.muted, lineHeight: 1.6, marginBottom: 18, maxWidth: 620 }}>
        Applies to every tool, the top bar and this screen — one setting, not one per tool.
      </div>

      <div style={{ marginBottom: 20 }}>
        <div className="t-label" style={{ marginBottom: 6 }}>Mode</div>
        <Segment value={cur.mode} onChange={(next) => onChange({ ...cur, mode: next })}
          options={[["light", "Light"], ["dark", "Dark"], ["system", "System"]]} />
        <div style={{ fontSize: 11.5, color: P.faint, marginTop: 8, lineHeight: 1.6, maxWidth: 620 }}>
          {cur.mode === "system"
            // Said out loud because "System" is the one option whose result is
            // not visible in the option itself, and it changes under you.
            ? `Following this device, which is currently ${systemPrefersDark ? "dark" : "light"}. It switches the moment the device does — no reload.`
            : "Dark is the default. Choose System to follow the device instead."}
        </div>
      </div>

      <div className="t-label" style={{ marginBottom: 8 }}>Palette</div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 8 }}>
        {PALETTES.map((p) => {
          const s = swatchOf(p);
          const selected = cur.palette === p.key;
          return (
            <button key={p.key} type="button" onClick={() => onChange({ ...cur, palette: p.key })}
              aria-pressed={selected} style={card(selected)}>
              {/* A hairline round the trio, because the light halves all share
                  one near-white ground and one near-white surface — without an
                  edge, two thirds of every light swatch is invisible against the
                  card it sits on and the preview reads as a single stripe. */}
              <span aria-hidden="true" style={{ display: "flex", flex: "none", borderRadius: 6, overflow: "hidden", border: `1px solid ${P.line}` }}>
                <span style={{ width: 14, height: 22, background: s.bg }} />
                <span style={{ width: 14, height: 22, background: s.surface }} />
                <span style={{ width: 14, height: 22, background: s.accent }} />
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: P.ink }}>{p.label}</span>
                <span style={{ display: "block", fontSize: 11, color: P.faint, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.blurb}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ fontSize: 11.5, color: P.faint, marginTop: 14, lineHeight: 1.6, maxWidth: 620 }}>
        Session is the shared Board Room language used across every tool. The
        other palettes are optional product-wide overrides; neither setting
        changes what runs.
      </div>
    </div>
  );
}

// The System hub has five distinct jobs. Usage absorbed the former all-time
// overview; Intelligence owns browser assistants and points to the one shared
// Mind in SYNC; and the old Tabs label became Tools because it contains access
// and server-power controls, not merely a row of tabs.
const TABS = [["usage", "Usage"], ["ops", "Ops"], ["tools", "Tools"], ["intelligence", "Intelligence"], ["theme", "Theme"]];

export default function System({ onExit, tabPrefs, onTabPrefs, themePrefs, onThemePrefs, systemPrefersDark, toolPower, initialTab, onTabConsumed }) {
  // The Desk used to live here. It was dissolved into ZTS Mission and Clarify
  // Today instead of relocated: a queue you navigate to is a queue you miss,
  // and the work belongs on the screen for the tool that produced it.
  // `initialTab` is a DEEP LINK, not a controlled value: the rail's theme icon
  // opens System already standing on Theme, and after that the operator's own
  // clicks own the tab. Seeding useState with it would be wrong in the other
  // direction — the component stays mounted, so a second deep link from the
  // rail would be ignored. Consumed on arrival, then cleared by the caller so
  // it cannot re-fire on an unrelated re-render.
  const [tab, setTab] = useState(() => (initialTab && TABS.some(([k]) => k === initialTab) ? initialTab : "usage"));
  useEffect(() => {
    if (!initialTab) return;
    if (TABS.some(([k]) => k === initialTab)) setTab(initialTab);
    onTabConsumed?.();
  }, [initialTab, onTabConsumed]);
  const isMobile = useIsMobile();
  const btn = { background: "none", border: `1px solid ${P.line}`, color: P.muted, borderRadius: 8, padding: "6px 12px", fontSize: 11.5, cursor: "pointer", fontFamily: P.display, fontWeight: 600, whiteSpace: "nowrap" };
  return (
    // data-kit opts this screen into the shared component sheet — without it the
    // .stattile/.card/.t-label classes below match nothing. Font stack comes from
    // the token now; it used to name 'Inter', a webfont that no longer loads.
    <div data-kit style={{ minHeight: "calc(100vh - var(--shell-bar, 52px))", background: P.bg, color: P.ink, fontFamily: "var(--font-body)" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: isMobile ? "14px 12px 80px" : "22px 24px 60px" }}>
        {/* Segments and global actions share one compact row. The segments keep
            their horizontal scroll on phones; the actions never claim an empty
            row of their own. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <div
            role="tablist"
            style={{
              flex: "1 1 auto", minWidth: 0, display: "flex", gap: 2, padding: 3, borderRadius: 11,
              background: P.surface2, border: `1px solid ${P.line}`,
              overflowX: "auto", scrollSnapType: "x proximity", scrollbarWidth: "none", WebkitOverflowScrolling: "touch",
            }}
          >
            {TABS.map(([k, label]) => (
              <button
                key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                style={{
                  flex: isMobile ? "none" : 1, scrollSnapAlign: isMobile ? "center" : undefined,
                  minHeight: isMobile ? 40 : 34, padding: isMobile ? "0 15px" : "0 16px",
                  border: "none", borderRadius: 8, cursor: "pointer", whiteSpace: "nowrap",
                  background: tab === k ? P.surface : "transparent",
                  color: tab === k ? P.ink : P.faint,
                  fontSize: 13, fontWeight: tab === k ? 600 : 500, fontFamily: P.display,
                }}
              >{label}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, flex: "none" }}>
            <button className="btn sm quiet" type="button" onClick={() => auth.signOut()} title="Sign out" aria-label="Sign out">{isMobile ? "↪" : "Sign out"}</button>
            <button className="btn sm quiet" type="button" onClick={onExit} title="Back to tools" aria-label="Back to tools">{isMobile ? "←" : "Back to tools →"}</button>
          </div>
        </div>
        {tab === "ops" && <Ops isMobile={isMobile} />}
        {tab === "tools" && tabPrefs && <Tools prefs={tabPrefs} onChange={onTabPrefs} isMobile={isMobile} toolPower={toolPower} />}
        {tab === "usage" && <Usage isMobile={isMobile} />}
        {tab === "intelligence" && <Intelligence isMobile={isMobile} />}
        {tab === "theme" && <Theme prefs={themePrefs} onChange={onThemePrefs} systemPrefersDark={!!systemPrefersDark} isMobile={isMobile} />}
      </div>
    </div>
  );
}
