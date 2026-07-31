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
import { appMeta, APPS } from "@cc/design";
import { visibleTabs, isHidden, canHide, toggleTab, moveTab, resetTabPrefs, DEFAULT_HIDDEN } from "./tabPrefs.js";
import { AnimatedNumber, EmptyState, useIsMobile } from "@cc/ui";
import { auth, supabase } from "@cc/supabase";
import Ops from "./Ops.jsx";
// Minds was rendered at the bottom of this file WITHOUT being imported, so the
// Minds tab threw "Minds is not defined" and the shell's error boundary ate the
// whole System panel — from the day the consolidated mind screen landed. A free
// variable is legal JavaScript, so the build was green, and no test mounted the
// tab, so the suite was green. Third instance of this exact class (nodeR, data,
// Minds); the browser smoke test now walks every tab for that reason.
import Minds from "./Minds.jsx";

// Which localStorage prefix each tool writes under (they run on one domain now).
const LS = { zts: "zts_", clarify: "sm_", looper: "lp_" };
const USAGE_APPS = ["zts", "clarify", "looper"]; // Runway logs AI server-side; not yet unified
const REGION_LABELS = { identity: "Identity", principle: "Principles", knowledge: "Knowledge", signal: "Signals", skill: "Skills", goal: "Goals" };

// ─── neutral "platform" palette (its own identity, not any one tool's) ───────
const P = {
  bg: "#0A0E15", surface: "#131A24", surface2: "#0F151E", line: "rgba(255,255,255,0.08)",
  ink: "#E9EDF5", muted: "#93A1B5", faint: "#66748A",
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

// ─── OVERVIEW (cross-tool digest) ────────────────────────────────────────────
// The top line: total AI spend, tokens, and calls across every tool, plus a
// per-tool breakdown. ZTS, Clarify and Looper log every call to localStorage;
// Runway runs its AI server-side and Macro is keyless market data, so those two
// read honestly as "not logged here" rather than a fake $0. Looper matters most
// here — it is the only tool that spends unattended, so its running total needs
// to sit next to the others rather than only inside Looper's own log.
function Overview({ isMobile }) {
  const ideas = useIdeasSpend(0); // Overview is all-time; Usage does the windowing
  const per = APPS.map((app) => {
    if (app === "ideas") {
      return ideas.error
        ? { app, tracked: false }
        : { app, tracked: true, cost: ideas.cost, tok: ideas.inTok + ideas.outTok, calls: ideas.calls, server: true };
    }
    if (!USAGE_APPS.includes(app)) return { app, tracked: false };
    const log = readJSON(`${LS[app]}obs_log`, []);
    let cost = 0, tok = 0, calls = 0;
    if (Array.isArray(log)) for (const e of log) { cost += e.costEstimate || 0; tok += (e.inputTokens || 0) + (e.outputTokens || 0); calls += 1; }
    return { app, tracked: true, cost, tok, calls };
  });
  const totals = per.reduce((t, p) => (p.tracked ? { cost: t.cost + p.cost, tok: t.tok + p.tok, calls: t.calls + p.calls } : t), { cost: 0, tok: 0, calls: 0 });
  const maxCost = Math.max(0.0001, ...per.filter((p) => p.tracked).map((p) => p.cost));

  return (
    <div>
      <Header title="Overview" sub="Token spend and usage across every Pentagon tool, at a glance" />
      {/* Three equal columns, not flex-wrap: three tiles fit a 393px phone at
          the kit's size, and an even grid never leaves one stranded on its own
          row. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 14 }}>
        <Stat label="Total spend"><AnimatedNumber value={totals.cost} format={fmt$} /></Stat>
        <Stat label="Tokens"><AnimatedNumber value={totals.tok} format={fmtN} /></Stat>
        <Stat label="AI calls"><AnimatedNumber value={totals.calls} format={fmtN} /></Stat>
      </div>
      <Card>
        <SectionLabel>By tool</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: isMobile ? 10 : 14 }}>
          {per.map((p) => (
            <div key={p.app} style={{ background: P.surface2, border: `1px solid ${P.line}`, borderRadius: 12, padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <Dot app={p.app} size={9} />
                <span style={{ fontSize: 13, fontWeight: 700, color: P.ink, fontFamily: P.display }}>{appMeta(p.app).brand}</span>
                {p.tracked && <span style={{ marginLeft: "auto", fontSize: 15, fontWeight: 800, color: P.ink, fontFamily: P.mono }}>{fmt$(p.cost)}</span>}
              </div>
              {p.tracked ? (
                <>
                  <div style={{ height: 6, borderRadius: 99, background: P.bg, overflow: "hidden", marginBottom: 8 }}>
                    <div style={{ height: "100%", width: `${(p.cost / maxCost) * 100}%`, background: appMeta(p.app).accent, borderRadius: 99, transition: "width .4s cubic-bezier(0.16,1,0.3,1)" }} />
                  </div>
                  <div style={{ fontSize: 11.5, color: P.muted, display: "flex", gap: 14, flexWrap: "wrap" }}>
                    <span>{fmtN(p.tok)} tokens</span><span>{fmtN(p.calls)} calls</span>
                    {/* Worth saying out loud: every other figure on this card
                        came from this browser's own localStorage, so it is per
                        device. This one didn't. */}
                    {p.server && <span style={{ color: P.faint }}>server-logged</span>}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 11.5, color: P.faint, lineHeight: 1.5 }}>
                  {p.app === "runway"
                    ? "Runs its AI server-side — unified logging is the next step."
                    : p.app === "ideas"
                      ? "Run log unreachable — spend is recorded in Postgres, not this browser."
                      : "Keyless market data — no Claude spend to log here."}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>
      {totals.calls === 0 && (
        <div style={{ fontSize: 11.5, color: P.faint, marginTop: 12, lineHeight: 1.5 }}>
          No AI calls logged yet in ZTS, Clarify or Looper — generate a Short, draft outreach, or start a Looper run and spend shows up here. See <strong style={{ color: P.muted }}>Usage</strong> for the call-by-call log.
        </div>
      )}
    </div>
  );
}

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
                  <span style={{ color: c.ok === false ? "#FF6F6F" : P.faint, width: 62, textAlign: "right", fontSize: 10.5 }}>{c.ok === false ? "failed" : `${c.latencyMs || 0}ms`}</span>
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

// ─── MINDS (DNA) ────────────────────────────────────────────────────────────
function statsFor(genome) {
  if (!genome || !Array.isArray(genome.nodes)) return null;
  const byRegion = {};
  Object.keys(REGION_LABELS).forEach((r) => (byRegion[r] = 0));
  for (const n of genome.nodes) byRegion[n.region] = (byRegion[n.region] || 0) + 1;
  return { nodes: genome.nodes.length, edges: Array.isArray(genome.edges) ? genome.edges.length : 0, byRegion };
}

// The Minds panel used to be a read-out: node and edge counts for ZTS and
// Clarify, a link into each tool's own DNA tab, and no SYNC at all. It is the
// editor now — one screen for every mind, in the place a mind belongs, which is
// settings. See Minds.jsx for why it edits three fields and no others.

// ─── AGENTS ────────────────────────────────────────────────────────────────────
// The engine controls for every tool live here now (removed from the tools'
// own tabs to centralize the levers). Both tools share one engine_ctrl shape
// { running, observeOnly, allowSonnet, pauseWhenIdle, cadenceSec, ... } written
// as plain JSON under their prefix; each tool's headless engine re-reads it on
// every heartbeat and on remount, so toggling here drives it directly.
const ENGINE_DEFAULTS = { running: false, observeOnly: true, allowSonnet: false, pauseWhenIdle: true, cadenceSec: 20 };

const Switch = ({ on }) => (
  <span style={{ width: 40, height: 23, borderRadius: 99, background: on ? "#4FD694" : "rgba(255,255,255,0.14)", position: "relative", flexShrink: 0, transition: "background .2s cubic-bezier(0.16,1,0.3,1)" }}>
    <span style={{ position: "absolute", top: 2.5, left: on ? 19.5 : 2.5, width: 18, height: 18, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.4)", transition: "left .2s cubic-bezier(0.16,1,0.3,1)" }} />
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

function Agents({ isMobile }) {
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
      <Header title="Agents" sub="Drive every tool's headless engine from one place — play/pause, token limits, and the DNA worker" />
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12, marginBottom: 14 }}>
        {tools.map(({ app, ctrl, worker }) => (
          <Card key={app}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 4 }}>
              <Dot app={app} size={10} />
              <span style={{ fontSize: 14, fontWeight: 800, color: P.ink, fontFamily: P.display }}>{appMeta(app).brand}</span>
              <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 700, color: ctrl.running ? "#4FD694" : P.faint }}>{ctrl.running ? "● Running" : "Paused"}</span>
            </div>
            <CtrlRow on={!!ctrl.running} onClick={() => patch(app, "engine_ctrl", { running: !ctrl.running })}
              label={ctrl.running ? "Engine running" : "Engine paused"}
              sub={`Free heartbeat every ${ctrl.cadenceSec ?? 20}s${ctrl.hourlyCostCap != null ? ` · cap ${fmt$(ctrl.hourlyCostCap)}/hr` : ""}`}
              tone={ctrl.running ? "#4FD694" : P.ink} />
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
// ─── Tabs — which tools are in the top toggle, and in what order ─────────────
// Lives in System because it is chrome preference, not a tool's own setting:
// putting it inside ZTS would mean opening one tool to control whether another
// is visible.
//
// Reorder is up/down buttons rather than drag-and-drop. Dragging is worse on
// the surface that matters most here — a phone, where a long-press drag fights
// the page scroll — and it is unusable by keyboard. Two buttons are operable by
// touch, mouse and keyboard with no library.
function Tabs({ prefs, onChange, isMobile }) {
  const shownCount = visibleTabs(prefs).length;
  const rowBtn = (enabled) => ({
    width: 34, height: 34, flex: "none", display: "grid", placeItems: "center",
    background: "none", border: `1px solid ${P.line}`, borderRadius: 8,
    color: enabled ? P.muted : P.faint, cursor: enabled ? "pointer" : "default",
    opacity: enabled ? 1 : 0.35, fontSize: 13,
  });

  return (
    <div className="pagefade">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        <div style={{ fontSize: 15, fontWeight: 800, fontFamily: P.display }}>Top bar</div>
        <button
          onClick={() => onChange(resetTabPrefs())}
          style={{ background: "none", border: `1px solid ${P.line}`, color: P.muted, borderRadius: 8, padding: "6px 12px", fontSize: 11.5, cursor: "pointer", fontFamily: P.display, fontWeight: 600 }}
        >Reset to default</button>
      </div>
      <div style={{ fontSize: 12.5, color: P.muted, lineHeight: 1.6, marginBottom: 16, maxWidth: 620 }}>
        Choose which tools appear in the toggle and the order they sit in. Hiding a
        tool only removes it from this bar — nothing it runs on a schedule stops,
        and its data is untouched. <span style={{ color: P.faint }}>⌥1–⌥{Math.min(shownCount, 6)} jump to the visible tools in this order.</span>
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
              display: "flex", alignItems: "center", gap: isMobile ? 8 : 12,
              padding: isMobile ? "10px 12px" : "12px 14px",
              background: P.surface, border: `1px solid ${P.line}`, borderRadius: 12,
              opacity: hidden ? 0.55 : 1,
            }}>
              <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: "50%", flex: "none", background: m.accent, boxShadow: hidden ? "none" : `0 0 8px ${m.accent}` }} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, fontFamily: P.display, color: P.ink }}>{m.label}</span>
                <span style={{ display: "block", fontSize: 11.5, color: P.faint, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {hidden ? "Hidden" : m.brand}
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
                aria-label={`${hidden ? "Show" : "Hide"} ${m.label}`}
                disabled={blockedLast}
                title={blockedLast ? "At least one tool has to stay visible" : hidden ? "Show in the top bar" : "Hide from the top bar"}
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
          );
        })}
      </div>

      <div style={{ fontSize: 11.5, color: P.faint, marginTop: 14, lineHeight: 1.6 }}>
        System is always reachable from the top bar, whatever is hidden.
        {" "}Default: {DEFAULT_HIDDEN.map((a) => appMeta(a).label).join(", ")} start hidden.
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

// Ops sits first after Overview: it is the containment console, and the one
// tab whose contents you might need in a hurry.
const TABS = [["overview", "Overview"], ["ops", "Ops"], ["usage", "Usage"], ["minds", "Minds"], ["agents", "Agents"], ["tabs", "Tabs"]];

export default function System({ onExit, onOpenTool, tabPrefs, onTabPrefs }) {
  // The Desk used to live here. It was dissolved into ZTS Mission and Clarify
  // Today instead of relocated: a queue you navigate to is a queue you miss,
  // and the work belongs on the screen for the tool that produced it.
  const [tab, setTab] = useState("overview");
  const isMobile = useIsMobile();
  const btn = { background: "none", border: `1px solid ${P.line}`, color: P.muted, borderRadius: 8, padding: "6px 12px", fontSize: 11.5, cursor: "pointer", fontFamily: P.display, fontWeight: 600, whiteSpace: "nowrap" };
  return (
    // data-kit opts this screen into the shared component sheet — without it the
    // .stattile/.card/.t-label classes below match nothing. Font stack comes from
    // the token now; it used to name 'Inter', a webfont that no longer loads.
    <div data-kit style={{ minHeight: "calc(100vh - 52px)", background: P.bg, color: P.ink, fontFamily: "var(--font-body)" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: isMobile ? "14px 12px 80px" : "22px 24px 60px" }}>
        {/* The row used to be tabs + buttons on ONE line with flex-wrap and
            `marginLeft: auto`, which on a phone pushed Sign out / Back onto a
            second line, right-aligned, with a 20px gap under them — and the six
            tabs, uppercase and 0.04em-tracked, overflowed a container that could
            scroll but gave no hint of it, so "Tabs" was simply cut in half at
            the screen edge. Now: tabs get their own full-width scroll-snap row
            (the same pattern as the shell's tool row), and the two buttons sit
            in a quiet line above them. Sentence case, per §4.3 — uppercase is
            reserved for .t-label. */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 10 }}>
          <button className="btn sm quiet" onClick={() => auth.signOut()}>Sign out</button>
          <button className="btn sm quiet" onClick={onExit}>{isMobile ? "← Back" : "Back to tools →"}</button>
        </div>
        <div
          role="tablist"
          style={{
            display: "flex", gap: 2, padding: 3, borderRadius: 11, marginBottom: 16,
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
        {tab === "overview" && <Overview isMobile={isMobile} />}
        {tab === "ops" && <Ops isMobile={isMobile} />}
        {tab === "usage" && <Usage isMobile={isMobile} />}
        {tab === "minds" && <Minds isMobile={isMobile} />}
        {tab === "agents" && <Agents isMobile={isMobile} />}
        {tab === "tabs" && tabPrefs && <Tabs prefs={tabPrefs} onChange={onTabPrefs} isMobile={isMobile} />}
      </div>
    </div>
  );
}
