import { useState, useEffect } from "react";
import { T } from "../../theme";
import { AnimatedNumber, SkeletonLine } from "../../ui.jsx";
import { AGENT_META } from "../system/AgentsView.jsx";
import { eng, goalProgress, kb } from "../../lib/engine.js";
import { obs, sm, store } from "../../lib/store.js";
import { fetchPortfolioCounts } from "../../lib/supabase.js";
import EnginePanel from "./EnginePanel.jsx";

// ─── Month calendar — booked meetings at a glance (Mission footer) ────────────
// Meetings live on the outreach rows (meeting_at — the DB, survives any
// browser); the old localStorage array is merged read-only for pre-migration
// history. Callers pass `cards`; without them only legacy entries can show.
export function MonthCalendar({ onNavigate, hideOpenLink, cards = [] }) {
  const [monthOffset, setMonthOffset] = useState(0);
  const legacy = store.get("meetings", []);
  const fromCards = cards
    .filter((c) => c.meeting_at)
    .map((c) => ({ id: `db_${c.id}`, cardId: c.id, business: c.prospect?.business_name, start: c.meeting_at, outcome: c.meeting_outcome || "pending" }));
  const dbCardIds = new Set(fromCards.map((m) => m.cardId));
  const meetings = [...fromCards, ...legacy.filter((m) => !dbCardIds.has(m.cardId))];

  const base = new Date();
  const view = new Date(base.getFullYear(), base.getMonth() + monthOffset, 1);
  const year = view.getFullYear(), month = view.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = new Date().toDateString();

  // Index meetings by day-of-month for this view
  const byDay = {};
  meetings.forEach(m => {
    const d = new Date(m.start);
    if (d.getFullYear() === year && d.getMonth() === month) {
      const day = d.getDate();
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(m);
    }
  });

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const monthLabel = view.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const upcomingThisMonth = meetings.filter(m => { const d = new Date(m.start); return d.getFullYear() === year && d.getMonth() === month && d >= new Date(Date.now() - 86400000); }).sort((a,b) => new Date(a.start) - new Date(b.start));

  return (
    <div style={{ marginTop: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
        <span className="t-label">Calendar · {monthLabel}</span>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <button onClick={() => setMonthOffset(monthOffset - 1)} type="button" aria-label="Previous month" className="btn sm quiet" style={{ padding: "0 12px" }}>‹</button>
          {monthOffset !== 0 && <button onClick={() => setMonthOffset(0)} type="button" className="btn sm quiet">Today</button>}
          <button onClick={() => setMonthOffset(monthOffset + 1)} type="button" aria-label="Next month" className="btn sm quiet" style={{ padding: "0 12px" }}>›</button>
          {!hideOpenLink && <button type="button" onClick={() => onNavigate && onNavigate("calendar")} className="btn sm plain">Open Calendar ›</button>}
        </div>
      </div>

      <div className="co-grid2" style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: "16px", alignItems: "start" }}>
        {/* Month grid */}
        {/* .card — this had a 1px border AND shadowCard on one element. */}
        <div className="card" style={{ padding: "16px 18px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "4px", marginBottom: "6px" }}>
            {["S","M","T","W","T","F","S"].map((d, i) => (
              <div key={i} className="stattile-label" style={{ textAlign: "center" }}>{d}</div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "4px" }}>
            {cells.map((d, i) => {
              if (d === null) return <div key={i} />;
              const isToday = new Date(year, month, d).toDateString() === todayStr;
              const has = byDay[d];
              return (
                <div key={i} style={{ aspectRatio: "1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", borderRadius: "8px", background: isToday ? T.goldSoft : T.subtle, border: isToday ? `1px solid ${T.goldLine}` : "1px solid transparent", position: "relative" }}
                  title={has ? has.map(m => `${fmtTime(m.start)} · ${m.business}`).join("\\n") : ""}>
                  <span style={{ fontSize: "11px", fontWeight: isToday ? 700 : 500, color: isToday ? T.gold : has ? T.ink : T.faint, fontFamily: T.fontMono }}>{d}</span>
                  {has && <span style={{ position: "absolute", bottom: "5px", display: "flex", gap: "2px" }}>
                    {has.slice(0, 3).map((_, j) => <span key={j} style={{ width: "4px", height: "4px", borderRadius: "50%", background: T.green }} />)}
                  </span>}
                </div>
              );
            })}
          </div>
        </div>

        {/* This month's meetings list */}
        <div>
          <div className="t-label" style={{ marginBottom: "10px" }}>This month</div>
          {upcomingThisMonth.length === 0 ? (
            <div className="card" style={{ padding: "24px 18px", textAlign: "center", fontSize: "12px", color: T.faint }}>
              No meetings this month. Book one from the Calendar tab.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {upcomingThisMonth.slice(0, 5).map((m, i) => (
                // .card, with the blue rail as an inset shadow rather than a
                // borderLeft — a card in this language does not draw an outline.
                <div key={i} className="card pad-sm" style={{ boxShadow: `inset 3px 0 0 ${T.blueDeep}, var(--shadow-card)` }}>
                  <div className="cell-title">{m.business}</div>
                  <div className="t-cap" style={{ marginTop: "2px", fontFamily: T.fontMono }}>{new Date(m.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · {fmtTime(m.start)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// ─── Mission Control — the one-stop command center ───────────────────────────
// Everything-at-a-glance: pipeline, portfolio, agent roster, AI spend, activity,
// and what-needs-you-now. Pulls live from Supabase + sessionMemory + obs log.
export function MissionControl({ cards, onNavigate, inboundNew = 0 }) {
  const [counts, setCounts] = useState(null);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(max-width: 760px)").matches);

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 760px)");
    if (!media) return undefined;
    const update = (event) => setIsMobile(event.matches);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // Fetch on mount and whenever tick advances; interval lives in its own effect
  // so it isn't torn down and rebuilt on every refresh.
  useEffect(() => {
    let alive = true;
    (async () => {
      const c = await fetchPortfolioCounts();
      if (alive) { setCounts(c); setLoading(false); }
    })();
    return () => { alive = false; };
  }, [tick]);

  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 30000); // gentle live refresh
    return () => clearInterval(iv);
  }, []);

  // ── Pipeline (from cards prop, already in memory) ──
  const pipeline = {
    prospected: cards.filter(c => c.status === "prospected").length,
    draft: cards.filter(c => ["draft", "draft_ready"].includes(c.status)).length,
    sent: cards.filter(c => c.status === "sent").length,
    replied: cards.filter(c => c.status === "replied").length,
  };
  const meetings = cards.filter(c => c.status === "meeting").length;

  // ── Round 4: daily momentum — compare today vs a stored daily snapshot ──
  const todayKey = new Date().toISOString().slice(0, 10);
  const snapshot = { sent: pipeline.sent, replied: pipeline.replied, meetings, date: todayKey };
  // Roll the snapshot forward once per day so "yesterday" stays stable.
  useEffect(() => {
    const last = sm.get("mission_snapshot");
    if (!last || last.date !== todayKey) {
      sm.set("mission_snapshot_prev", last || null);
      sm.set("mission_snapshot", { ...snapshot });
    }
  // eslint-disable-next-line
  }, [todayKey]);
  const prevSnap = sm.get("mission_snapshot_prev");
  const trend = (cur, key) => {
    if (!prevSnap || prevSnap[key] == null) return null;
    const d = cur - prevSnap[key];
    return d === 0 ? null : d;
  };

  // ── Observability snapshot ──
  const obsLogs = obs.getAll();
  const aiCost = obsLogs.reduce((s, l) => s + (l.costEstimate || 0), 0);
  const budget = sm.get("ai_budget") || 50;
  const budgetPct = Math.min(100, Math.round((aiCost / budget) * 100));

  // Live roster — pulls from the Agent Engine so Mission shows the real agents.
  const engCtrl = eng.get();
  const kbAll = kb.all();
  const agentRoster = AGENT_META.map(m => {
    const notes = kbAll.filter(e => e.agent === m.key);
    const enabled = m.key === "synthesizer" ? !engCtrl.observeOnly : engCtrl.agents[m.key] !== false;
    return { key: m.key, name: m.name, role: m.role, enabled, notes: notes.length, lastTs: notes[0]?.ts || null };
  });

  const ago = (ts) => {
    if (!ts) return null;
    const d = Date.now() - ts;
    const m = Math.floor(d / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  // ── Recent activity feed (last obs events) ──
  const recentActivity = [...obsLogs].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 6);

  // Both of these are the kit's, not local re-implementations: .card (which is
  // where the border-plus-shadow violation lived) and .t-label.
  const Card = ({ children, span, pad }) => (
    <div className="card" style={{ padding: pad || (isMobile ? "14px" : "14px 16px"), gridColumn: span ? `span ${span}` : undefined }}>{children}</div>
  );
  const SectionLabel = ({ children, action }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", marginBottom: "9px" }}>
      <span className="t-label">{children}</span>
      {action}
    </div>
  );
  const jump = (tab) => tab && onNavigate && onNavigate(tab);

  return (
    <div style={{ minHeight: "calc(100vh - 48px)", background: "transparent", padding: isMobile ? "14px" : "18px 22px" }}>
      {inboundNew > 0 && (
        <div onClick={() => onNavigate("inbound")} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px", marginBottom: "12px", padding: "10px 14px", borderRadius: "12px", border: "1px solid rgba(244,114,182,0.3)", background: "rgba(244,114,182,0.08)", cursor: "pointer" }}>
          <span style={{ fontSize: "13px", fontWeight: 600, color: T.pink }}>✦ {inboundNew} new inbound {inboundNew === 1 ? "lead" : "leads"} waiting — warm, prioritize these.</span>
          <span style={{ fontSize: "12px", fontWeight: 700, color: T.pink, whiteSpace: "nowrap" }}>Open Inbound →</span>
        </div>
      )}
      <EnginePanel onNavigate={onNavigate} />

      {/* Header. The <h1>"Mission control"</h1> that used to sit on the left is
          gone: it was a second name for the tab whose pill is already lit above
          it, and it was the only thing in that column. What is on the right is
          not — today's pipeline movement and goal progress are live numbers the
          sub-nav does not carry — so the row survives and only the title
          leaves. The view's accessible name now comes from the region in
          App.jsx, wired to the same label the pill renders. */}
      <div style={{ marginBottom: "12px", display: "flex", justifyContent: "flex-end", alignItems: "flex-end", flexWrap: "wrap", gap: "8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {(() => {
            const sentToday = trend(pipeline.sent, "sent") || 0;
            const repliedToday = trend(pipeline.replied, "replied") || 0;
            const moved = sentToday + repliedToday;
            if (moved <= 0) return null;
            return <span style={{ fontSize: "11px", color: T.muted, fontWeight: 600 }}>📈 {moved} pipeline move{moved !== 1 ? "s" : ""} today</span>;
          })()}
          {(() => {
            // Goal-mode progress, if the engine has an active goal.
            const ec = eng.get();
            if (!ec.goalMode) return null;
            const gp = goalProgress(cards);
            if (!gp) return null;
            return <span style={{ fontSize: "11px", color: gp.done ? T.green : T.gold, fontWeight: 700 }}>🎯 {gp.done ? "Goal reached" : `${gp.current}/${gp.target} ${gp.unit}`}</span>;
          })()}
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: T.green, fontWeight: 600 }}>
            <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: T.green, boxShadow: `0 0 6px ${T.green}80` }} />
            Live · auto-refreshing
          </div>
        </div>
      </div>

      {/* Top stat row */}
      <div className="co-grid3" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px", marginBottom: "12px" }}>
        <Card>
          <SectionLabel>Outreach Pipeline</SectionLabel>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            {[["Prospected", pipeline.prospected, T.muted, null], ["Drafts", pipeline.draft, T.amber, null], ["Sent", pipeline.sent, T.blue, "sent"], ["Replied", pipeline.replied, T.pink, "replied"]].map(([l, v, c, tk], i) => {
              const t = tk ? trend(v, tk) : null;
              return (
              // The kit's stat tile. The caption under each number was 9px
              // uppercase; .stattile-label is the 10.5px sentence-case version
              // of exactly that — the floor, not below it.
              <div key={i} className="stattile" style={{ background: "transparent", alignItems: "center", textAlign: "center", padding: 0 }}>
                <div className="stattile-value" style={{ fontSize: "22px", color: c }}><AnimatedNumber value={v} /></div>
                <div className="stattile-label">{l}</div>
                {t != null && <div className="stattile-delta" style={{ color: t > 0 ? T.green : T.faint }}>{t > 0 ? `+${t}` : t} today</div>}
              </div>
            );})}
          </div>
        </Card>

        <Card>
          <SectionLabel>Client Portfolio</SectionLabel>
          {loading ? (
            <div style={{ display: "flex", justifyContent: "space-between", gap: "10px" }}>
              {[0, 1, 2].map(i => <SkeletonLine key={i} width="30%" height="22px" />)}
            </div>
          ) : (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              {[["Active", counts?.activeClients || 0, T.ink], ["Critical", counts?.criticalFindings || 0, counts?.criticalFindings > 0 ? T.red : T.muted], ["Pending", counts?.pendingActions || 0, counts?.pendingActions > 0 ? T.amber : T.muted]].map(([l, v, c], i) => (
                <div key={i} className="stattile" style={{ background: "transparent", alignItems: "center", textAlign: "center", padding: 0 }}>
                  <div className="stattile-value" style={{ fontSize: "22px", color: c }}><AnimatedNumber value={v} /></div>
                  <div className="stattile-label">{l}</div>
                </div>
              ))}
            </div>
          )}
          <button type="button" onClick={() => jump("clients")} className="btn sm plain full" style={{ marginTop: "12px" }}>Open Clients ›</button>
        </Card>

        <Card>
          <SectionLabel>AI Spend</SectionLabel>
          <div className="stattile-value" style={{ fontSize: "30px", color: T.ink }}><AnimatedNumber value={aiCost} format={(n) => `$${n.toFixed(2)}`} /></div>
          <div style={{ height: "5px", background: T.subtle, borderRadius: "3px", overflow: "hidden", marginTop: "10px" }}>
            <div style={{ width: `${budgetPct}%`, height: "100%", background: budgetPct > 80 ? T.red : T.green, borderRadius: "3px", transition: `width ${T.durSlow} ${T.easeOut}` }} />
          </div>
          <button type="button" onClick={() => jump("ops")} className="btn sm plain" style={{ marginTop: "10px", padding: 0 }}>Open Costs ›</button>
        </Card>
      </div>

      {/* System pulse — one honest line, detail lives in the System tab */}
      {(() => {
        const engOn = engCtrl.running;
        const lastAct = recentActivity[0];
        return (
          <div className="card" style={{ display: "flex", alignItems: "center", gap: "10px", padding: "12px 16px", marginBottom: "16px" }}>
            {/* The kit's status dot — the word "running"/"paused" next to it is
                what actually carries the state; the dot only echoes it. */}
            <span className={engOn ? "dotstatus pulse" : "dotstatus"} style={{ width: "8px", height: "8px", background: engOn ? T.green : T.faint }} />
            <span className="t-foot" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              Agent engine {engOn ? "running" : "paused"} · {agentRoster.filter(a => a.enabled).length}/{agentRoster.length} agents on{lastAct ? ` · last call ${ago(new Date(lastAct.ts).getTime())}` : ""}
            </span>
            <span className="t-cap" style={{ color: T.gold, fontWeight: 600, flexShrink: 0 }}>Open System ›</span>
          </div>
        );
      })()}

      {/* Month calendar — booked meetings at a glance */}
      <MonthCalendar onNavigate={onNavigate} cards={cards} />
    </div>
  );
}
