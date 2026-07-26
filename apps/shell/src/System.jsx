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
import { useMemo, useState } from "react";
import { appMeta, APPS } from "@cc/design";
import { AnimatedNumber, EmptyState, useIsMobile } from "@cc/ui";
import { auth } from "@cc/supabase";
import Ops from "./Ops.jsx";

// Which localStorage prefix each tool writes under (they run on one domain now).
const LS = { zts: "zts_", clarify: "sm_", looper: "lp_" };
const USAGE_APPS = ["zts", "clarify", "looper"]; // Runway logs AI server-side; not yet unified
const REGION_LABELS = { identity: "Identity", principle: "Principles", knowledge: "Knowledge", signal: "Signals", skill: "Skills", goal: "Goals" };

// ─── neutral "platform" palette (its own identity, not any one tool's) ───────
const P = {
  bg: "#0A0E15", surface: "#131A24", surface2: "#0F151E", line: "rgba(255,255,255,0.08)",
  ink: "#E9EDF5", muted: "#93A1B5", faint: "#66748A",
  display: "'Syne', system-ui", mono: "'DM Mono', monospace",
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

// ─── shared bits ──────────────────────────────────────────────────────────────
const Card = ({ children, style }) => (
  <div style={{ background: P.surface, border: `1px solid ${P.line}`, borderRadius: 16, padding: 18, ...style }}>{children}</div>
);
const Dot = ({ app, size = 8 }) => (
  <span style={{ width: size, height: size, borderRadius: "50%", background: appMeta(app).accent, boxShadow: `0 0 8px ${appMeta(app).accent}66`, display: "inline-block", flexShrink: 0 }} />
);
const Stat = ({ label, children, sub }) => (
  <Card style={{ flex: 1, minWidth: 150 }}>
    <div style={{ fontSize: 10.5, fontWeight: 700, color: P.faint, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8, fontFamily: P.display }}>{label}</div>
    <div style={{ fontSize: 26, fontWeight: 800, color: P.ink, fontFamily: P.display, lineHeight: 1 }}>{children}</div>
    {sub && <div style={{ fontSize: 11.5, color: P.muted, marginTop: 6 }}>{sub}</div>}
  </Card>
);

// ─── OVERVIEW (cross-tool digest) ────────────────────────────────────────────
// The top line: total AI spend, tokens, and calls across every tool, plus a
// per-tool breakdown. ZTS, Clarify and Looper log every call to localStorage;
// Runway runs its AI server-side and Macro is keyless market data, so those two
// read honestly as "not logged here" rather than a fake $0. Looper matters most
// here — it is the only tool that spends unattended, so its running total needs
// to sit next to the others rather than only inside Looper's own log.
function Overview({ isMobile }) {
  const per = APPS.map((app) => {
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
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <Stat label="Total spend"><AnimatedNumber value={totals.cost} format={fmt$} /></Stat>
        <Stat label="Tokens" sub={`${fmtN(totals.tok)} across logged tools`}><AnimatedNumber value={totals.tok} format={fmtN} /></Stat>
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
                  <div style={{ fontSize: 11.5, color: P.muted, display: "flex", gap: 14 }}>
                    <span>{fmtN(p.tok)} tokens</span><span>{fmtN(p.calls)} calls</span>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 11.5, color: P.faint, lineHeight: 1.5 }}>
                  {p.app === "runway" ? "Runs its AI server-side — unified logging is the next step." : "Keyless market data — no Claude spend to log here."}
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

  const maxApp = Math.max(0.0001, ...Object.values(agg.byApp));

  return (
    <div>
      <Header title="Usage" sub="AI tokens, cost & latency across every tool"
        right={<Segment value={win} onChange={setWin} options={[["24h", "24h"], ["7d", "7 days"], ["all", "All time"]]} />} />

      {agg.calls === 0 ? (
        <EmptyState icon="chart" title="No AI calls logged in this window"
          sub="Generate a Short, draft outreach, or tailor a résumé and spend shows up here across all tools." />
      ) : (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <Stat label="Total spend"><AnimatedNumber value={agg.cost} format={fmt$} /></Stat>
            <Stat label="Tokens" sub={`${fmtN(agg.inTok)} in · ${fmtN(agg.outTok)} out`}><AnimatedNumber value={agg.inTok + agg.outTok} format={fmtN} /></Stat>
            <Stat label="Calls"><AnimatedNumber value={agg.calls} format={fmtN} /></Stat>
            <Stat label="Avg latency" sub="per call">{agg.calls ? Math.round(agg.lat / agg.calls) : 0}<span style={{ fontSize: 14, color: P.muted }}>ms</span></Stat>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1.3fr", gap: 12, marginBottom: 14 }}>
            <Card>
              <SectionLabel>Spend by tool</SectionLabel>
              {USAGE_APPS.map((app) => (
                <div key={app} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 5 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: P.ink }}><Dot app={app} />{appMeta(app).brand}</span>
                    <span style={{ color: P.muted, fontFamily: P.mono }}>{fmt$(agg.byApp[app] || 0)}</span>
                  </div>
                  <div style={{ height: 7, borderRadius: 99, background: P.surface2, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${((agg.byApp[app] || 0) / maxApp) * 100}%`, background: appMeta(app).accent, borderRadius: 99, transition: "width .4s cubic-bezier(0.16,1,0.3,1)" }} />
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

function Minds({ onOpenTool, isMobile }) {
  const minds = ["zts", "clarify"].map((app) => ({ app, genome: readJSON(`${LS[app]}dna_genome`, null) }));
  const any = minds.some((m) => m.genome);
  return (
    <div>
      <Header title="Minds" sub="The DNA neural-graphs that compile into each tool's system prompt" />
      {!any ? (
        <EmptyState icon="radar" title="No minds initialized yet" sub="Open ZTS or Clarify → DNA to seed a mind; it'll appear here." />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 }}>
          {minds.map(({ app, genome }) => {
            const s = statsFor(genome);
            const maxR = s ? Math.max(1, ...Object.values(s.byRegion)) : 1;
            return (
              <Card key={app}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                    <Dot app={app} size={10} />
                    <span style={{ fontSize: 14, fontWeight: 800, color: P.ink, fontFamily: P.display }}>{appMeta(app).brand}</span>
                  </span>
                  <button onClick={() => onOpenTool(app)} style={{ background: "none", border: `1px solid ${P.line}`, color: P.muted, borderRadius: 8, padding: "5px 11px", fontSize: 11, cursor: "pointer", fontFamily: P.display, fontWeight: 600 }}>Open to edit →</button>
                </div>
                {!s ? (
                  <div style={{ color: P.faint, fontSize: 12.5 }}>Not initialized.</div>
                ) : (
                  <>
                    <div style={{ display: "flex", gap: 20, marginBottom: 16 }}>
                      <div><div style={{ fontSize: 22, fontWeight: 800, color: P.ink, fontFamily: P.display }}>{s.nodes}</div><div style={{ fontSize: 10.5, color: P.faint, textTransform: "uppercase", letterSpacing: "0.08em" }}>Nodes</div></div>
                      <div><div style={{ fontSize: 22, fontWeight: 800, color: P.ink, fontFamily: P.display }}>{s.edges}</div><div style={{ fontSize: 10.5, color: P.faint, textTransform: "uppercase", letterSpacing: "0.08em" }}>Synapses</div></div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                      {Object.entries(REGION_LABELS).map(([r, label]) => (
                        <div key={r} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5 }}>
                          <span style={{ width: 74, color: P.muted }}>{label}</span>
                          <div style={{ flex: 1, height: 6, borderRadius: 99, background: P.surface2, overflow: "hidden" }}>
                            <div style={{ height: "100%", width: `${(s.byRegion[r] / maxR) * 100}%`, background: appMeta(app).accent, opacity: 0.85, borderRadius: 99 }} />
                          </div>
                          <span style={{ width: 20, textAlign: "right", color: P.faint, fontFamily: P.mono }}>{s.byRegion[r]}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

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
const SectionLabel = ({ children }) => (
  <div style={{ fontSize: 10.5, fontWeight: 700, color: P.faint, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12, fontFamily: P.display }}>{children}</div>
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
const TABS = [["overview", "Overview"], ["ops", "Ops"], ["usage", "Usage"], ["minds", "Minds"], ["agents", "Agents"]];

export default function System({ onExit, onOpenTool }) {
  const [tab, setTab] = useState("overview");
  const isMobile = useIsMobile();
  const btn = { background: "none", border: `1px solid ${P.line}`, color: P.muted, borderRadius: 8, padding: "6px 12px", fontSize: 11.5, cursor: "pointer", fontFamily: P.display, fontWeight: 600, whiteSpace: "nowrap" };
  return (
    <div style={{ minHeight: "calc(100vh - 52px)", background: P.bg, color: P.ink, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: isMobile ? "18px 14px 80px" : "26px 24px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          <div style={{ display: "inline-flex", gap: 2, padding: 3, borderRadius: 11, background: P.surface2, border: `1px solid ${P.line}`, maxWidth: "100%", overflowX: "auto" }}>
            {TABS.map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} style={{ padding: isMobile ? "6px 12px" : "7px 16px", border: "none", borderRadius: 8, cursor: "pointer", background: tab === k ? P.surface : "transparent", color: tab === k ? P.ink : P.faint, fontSize: isMobile ? 11 : 12, fontWeight: 700, fontFamily: P.display, letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{label}</button>
            ))}
          </div>
          <div style={{ display: "inline-flex", gap: 8, marginLeft: "auto" }}>
            <button onClick={() => auth.signOut()} style={btn}>Sign out</button>
            <button onClick={onExit} style={btn}>{isMobile ? "← Back" : "Back to tools →"}</button>
          </div>
        </div>
        {tab === "overview" && <Overview isMobile={isMobile} />}
        {tab === "ops" && <Ops isMobile={isMobile} />}
        {tab === "usage" && <Usage isMobile={isMobile} />}
        {tab === "minds" && <Minds onOpenTool={onOpenTool} isMobile={isMobile} />}
        {tab === "agents" && <Agents isMobile={isMobile} />}
      </div>
    </div>
  );
}
