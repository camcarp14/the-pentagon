import { useState, useEffect, useMemo } from "react";
import { T, SEV as SEV_TOKENS } from "../../theme";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../../config.js";
import { sm } from "../../lib/store.js";
import { sbAuth, currentAccessToken } from "../../lib/supabase.js";
import { EmptyState, SkeletonRows } from "../../ui.jsx";

// ─── Clients View ─────────────────────────────────────────────────────────────
// ─── Client Detail — full account intelligence page ──────────────────────────
// Renders when a client is selected. Tables for performance, CPC, auction
// insights, keywords, campaigns, and recommendations. Until a live Google Ads
// feed exists, reads from findings/actions already in Supabase + demo scaffolding
// that mirrors the real data shape, so the UI is fully built and ready to bind.
export function ClientDetail({ client, findings, actions, onBack, onDelete }) {
  const [metricView, setMetricView] = useState("cost");
  const [perfRange, setPerfRange] = useState("30d");

  const SEV = SEV_TOKENS;
  const cF = findings.filter(f => f.client_id === client.id);
  const cA = actions.filter(a => a.client_id === client.id);
  const hasLiveData = cF.length > 0;

  // Subtle hover tint for table rows — spread onto a <tr>; base is the row's
  // resting background (transparent, or a persistent tint like the "You" row).
  const rowHoverProps = (base = "transparent") => ({
    onMouseEnter: (e) => { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; },
    onMouseLeave: (e) => { e.currentTarget.style.background = base; },
  });

  // ── Demo data scaffold — replaced by live Google Ads feed once connected.
  // Shapes match what the edge function / google-ads-script will eventually push.
  const perfSeries = useMemo(() => {
    const days = perfRange === "7d" ? 7 : perfRange === "90d" ? 90 : 30;
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const base = 380 + Math.sin(i / 4) * 60 + (Math.random() - 0.5) * 40;
      out.push({
        date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        cost: Math.round(base),
        clicks: Math.round(base / 4.2 + (Math.random() - 0.5) * 8),
        conversions: Math.round((base / 4.2) * 0.08 + (Math.random() - 0.5) * 1.5),
        cpc: +(4.2 + Math.sin(i / 6) * 0.8 + (Math.random() - 0.5) * 0.4).toFixed(2),
        cpa: Math.round(110 + Math.sin(i / 5) * 25 + (Math.random() - 0.5) * 20),
      });
    }
    return out;
  }, [perfRange, client.id]);

  const metricMeta = {
    cost: { label: "Spend", color: T.gold, prefix: "$", key: "cost" },
    clicks: { label: "Clicks", color: T.blue, prefix: "", key: "clicks" },
    conversions: { label: "Conversions", color: T.green, prefix: "", key: "conversions" },
    cpc: { label: "Avg CPC", color: T.amber, prefix: "$", key: "cpc" },
    cpa: { label: "CPA", color: T.red, prefix: "$", key: "cpa" },
  };
  const mm = metricMeta[metricView];
  const seriesVals = perfSeries.map(p => p[mm.key]);
  const seriesMax = Math.max(...seriesVals, 1);
  const seriesMin = Math.min(...seriesVals);
  const seriesAvg = seriesVals.reduce((a, b) => a + b, 0) / seriesVals.length;
  const totalSpend = perfSeries.reduce((s, p) => s + p.cost, 0);
  const totalConv = perfSeries.reduce((s, p) => s + p.conversions, 0);
  const blendedCpa = totalConv ? Math.round(totalSpend / totalConv) : 0;

  const cpcTiers = [
    { tier: "Brand", cpc: 2.10, trend: -4, share: 18, color: T.green },
    { tier: "High-Intent Generic", cpc: 6.80, trend: +12, share: 44, color: T.red },
    { tier: "Research/Top-Funnel", cpc: 3.95, trend: +3, share: 26, color: T.amber },
    { tier: "Competitor", cpc: 8.20, trend: +6, share: 12, color: T.gold },
  ];

  const auctionInsights = [
    { competitor: "You", impr_share: 42, overlap: null, top_of_page: 68, outranking: null, position_above: null },
    { competitor: "competitor-a.com", impr_share: 58, overlap: 71, top_of_page: 82, outranking: 61, position_above: 39 },
    { competitor: "competitor-b.com", impr_share: 31, overlap: 44, top_of_page: 55, outranking: 33, position_above: 22 },
    { competitor: "competitor-c.com", impr_share: 22, overlap: 29, top_of_page: 41, outranking: 19, position_above: 14 },
  ];

  const topKeywords = [
    { kw: "personal injury lawyer chicago", cost: 1840, clicks: 218, conv: 14, cpa: 131, is: 38, status: "ok" },
    { kw: "car accident attorney", cost: 1420, clicks: 165, conv: 9, cpa: 158, is: 29, status: "warning" },
    { kw: "slip and fall lawyer", cost: 890, clicks: 102, conv: 8, cpa: 111, is: 51, status: "ok" },
    { kw: "workers comp attorney near me", cost: 760, clicks: 88, conv: 4, cpa: 190, is: 24, status: "critical" },
    { kw: "best injury lawyer", cost: 640, clicks: 71, conv: 6, cpa: 107, is: 44, status: "ok" },
  ];

  const campaigns = [
    { name: "Brand - Exact", cost: 1100, conv: 22, cpa: 50, roas: null, status: "performing", pacing: 98 },
    { name: "PI - High Intent", cost: 4200, conv: 28, cpa: 150, roas: null, status: "needs_attention", pacing: 142 },
    { name: "PMax - Lead Gen", cost: 2400, conv: 18, cpa: 133, roas: null, status: "stable", pacing: 89 },
    { name: "Practice Areas", cost: 1850, conv: 14, cpa: 132, roas: null, status: "stable", pacing: 76 },
  ];

  // Recommendations: prefer live findings/actions, fall back to demo opportunities
  const recommendations = hasLiveData
    ? cF.map(f => ({ title: f.title, detail: f.diagnosis || f.recommendation, severity: f.severity }))
    : [
        { title: "PMax campaign overspending target by 42%", detail: "PI - High Intent pacing at 142% with CPA $150 vs $120 target. Cap budget or shift to Brand which converts at $50.", severity: "critical" },
        { title: "Workers comp keyword bleeding budget", detail: "$760 spend, 4 conversions, $190 CPA — 58% above target. Add as negative or move to its own tightly-themed ad group.", severity: "critical" },
        { title: "Impression share gap vs competitor-a.com", detail: "They hold 58% IS to your 42%, outranking you 61% of the time. Budget-limited on high-intent generics — the CPC tier already up 12%.", severity: "warning" },
        { title: "Brand CPC creeping up", detail: "Brand tier CPC at $2.10, down 4% — healthy. Keep an eye on competitor encroachment on branded terms.", severity: "info" },
      ];

  const SectionCard = ({ title, subtitle, children, action }) => (
    <div style={{ background: T.surface, borderRadius: "14px", border: `1px solid ${T.lineInk}`, padding: "18px 20px", boxShadow: T.shadowCard, marginBottom: "14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
        <div>
          <div style={{ fontSize: "13px", fontWeight: 700, color: T.inkDeep, fontFamily: T.fontDisplay, letterSpacing: "-0.01em" }}>{title}</div>
          {subtitle && <div style={{ fontSize: "10px", color: T.faint, marginTop: "2px" }}>{subtitle}</div>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );

  const Pill = ({ children, color, bg }) => (
    <span style={{ fontSize: "9px", fontWeight: 700, color, background: bg, padding: "2px 8px", borderRadius: "20px", letterSpacing: "0.05em", textTransform: "uppercase", fontFamily: T.fontDisplay }}>{children}</span>
  );

  const trendArrow = (n) => n > 0 ? `▲ ${n}%` : n < 0 ? `▼ ${Math.abs(n)}%` : "—";
  const trendColor = (n, inverse) => {
    if (n === 0) return T.faint;
    const good = inverse ? n < 0 : n > 0;
    return good ? T.green : T.red;
  };

  return (
    <div style={{ minHeight: "calc(100vh - 48px)", background: "transparent", padding: "24px 28px" }}>
      {/* Header */}
      <div style={{ marginBottom: "20px" }}>
        <button onClick={onBack}
          style={{ display: "flex", alignItems: "center", gap: "5px", padding: 0, marginBottom: "12px", background: "none", border: "none", color: T.faint, fontSize: "11px", fontWeight: 600, cursor: "pointer", fontFamily: T.fontDisplay }}>
          ← All Clients
        </button>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "22px", fontWeight: 700, color: T.inkDeep, fontFamily: T.fontDisplay, letterSpacing: "-0.02em" }}>{client.name}</div>
            <div style={{ fontSize: "12px", color: T.faint, marginTop: "3px" }}>
              {client.industry || "No industry set"}
              {client.google_ads_customer_id && ` · ${client.google_ads_customer_id}`}
              {client.monthly_budget && ` · $${client.monthly_budget}/mo budget`}
              {client.cpa_target && ` · $${client.cpa_target} CPA target`}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            {onDelete && (
              <button onClick={() => onDelete(client)} style={{ padding: "8px 14px", background: "transparent", border: `1px solid ${T.red}40`, borderRadius: "8px", color: T.red, fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay, whiteSpace: "nowrap" }}>🗑 Delete Client</button>
            )}
            {!hasLiveData && (
              <div style={{ padding: "8px 14px", background: `${T.amber}1F`, border: `1px solid ${T.amber}33`, borderRadius: "10px", maxWidth: "320px" }}>
                <div style={{ fontSize: "11px", fontWeight: 700, color: T.amber, fontFamily: T.fontDisplay }}>Demo data shown</div>
                <div style={{ fontSize: "10px", color: T.muted, marginTop: "2px", lineHeight: 1.5 }}>Connect the Google Ads Script to replace this with live account figures.</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div className="co-grid4" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px", marginBottom: "14px" }}>
        {[
          { label: "Spend (30d)", value: `$${totalSpend.toLocaleString()}` },
          { label: "Conversions", value: totalConv },
          { label: "Blended CPA", value: `$${blendedCpa}`, color: client.cpa_target && blendedCpa > client.cpa_target ? T.red : T.green },
          { label: "Open Findings", value: cF.length || (hasLiveData ? 0 : recommendations.length), color: cF.some(f => f.severity === "critical") ? T.red : undefined },
        ].map((k, i) => (
          <div key={i} style={{ background: T.surface, borderRadius: "10px", border: `1px solid ${T.lineInk}`, padding: "13px 16px", boxShadow: T.shadowCard }}>
            <div style={{ fontSize: "9px", fontWeight: 700, color: T.faint, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: T.fontDisplay, marginBottom: "6px" }}>{k.label}</div>
            <div style={{ fontSize: "22px", fontWeight: 500, color: k.color || T.inkDeep, fontFamily: T.fontMono, lineHeight: 1 }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Performance chart with metric + date toggles */}
      <SectionCard title="Performance" subtitle="Daily trend — toggle metric and range"
        action={
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <div style={{ display: "flex", gap: "2px", background: T.subtle, borderRadius: "7px", padding: "2px" }}>
              {Object.keys(metricMeta).map(k => (
                <button key={k} onClick={() => setMetricView(k)}
                  style={{ padding: "3px 9px", background: metricView === k ? T.raised : "transparent", border: "none", borderRadius: "5px", color: metricView === k ? T.ink : T.faint, fontSize: "10px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay, boxShadow: metricView === k ? T.shadowTab : "none" }}>
                  {metricMeta[k].label}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: "2px", background: T.subtle, borderRadius: "7px", padding: "2px" }}>
              {[["7d","7D"],["30d","30D"],["90d","90D"]].map(([k,l]) => (
                <button key={k} onClick={() => setPerfRange(k)}
                  style={{ padding: "3px 9px", background: perfRange === k ? T.raised : "transparent", border: "none", borderRadius: "5px", color: perfRange === k ? T.ink : T.faint, fontSize: "10px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay, boxShadow: perfRange === k ? T.shadowTab : "none" }}>{l}</button>
              ))}
            </div>
          </div>
        }>
        {/* Bar chart */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: "2px", height: "140px", marginBottom: "10px" }}>
          {perfSeries.map((p, i) => {
            const h = ((p[mm.key] - seriesMin) / (seriesMax - seriesMin || 1)) * 100;
            return (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }} title={`${p.date}: ${mm.prefix}${p[mm.key]}`}>
                <div style={{ height: `${Math.max(h, 3)}%`, background: mm.color, opacity: 0.25 + (h / 100) * 0.75, borderRadius: "2px 2px 0 0", transition: "height 0.2s" }} />
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "9px", color: T.faint, fontFamily: T.fontMono }}>
          <span>{perfSeries[0]?.date}</span>
          <span>avg {mm.prefix}{mm.key === "cpc" ? seriesAvg.toFixed(2) : Math.round(seriesAvg)}</span>
          <span>{perfSeries[perfSeries.length - 1]?.date}</span>
        </div>
      </SectionCard>

      {/* CPC trends + tier — two columns */}
      <div className="co-grid2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "14px" }}>
        <div style={{ background: T.surface, borderRadius: "14px", border: `1px solid ${T.lineInk}`, padding: "18px 20px", boxShadow: T.shadowCard }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: T.inkDeep, fontFamily: T.fontDisplay, marginBottom: "14px" }}>CPC by Tier</div>
          {cpcTiers.map((t, i) => (
            <div key={i} style={{ marginBottom: i < cpcTiers.length - 1 ? "12px" : 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                <span style={{ fontSize: "11px", fontWeight: 600, color: T.ink }}>{t.tier}</span>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <span style={{ fontSize: "12px", fontFamily: T.fontMono, color: T.ink }}>${t.cpc.toFixed(2)}</span>
                  <span style={{ fontSize: "9px", fontWeight: 700, color: trendColor(t.trend, true), minWidth: "34px", textAlign: "right" }}>{trendArrow(t.trend)}</span>
                </div>
              </div>
              <div style={{ height: "5px", background: T.subtle, borderRadius: "3px", overflow: "hidden" }}>
                <div style={{ width: `${t.share}%`, height: "100%", background: t.color, borderRadius: "3px" }} />
              </div>
              <div style={{ fontSize: "9px", color: T.faint, marginTop: "2px" }}>{t.share}% of spend</div>
            </div>
          ))}
        </div>

        <div style={{ background: T.surface, borderRadius: "14px", border: `1px solid ${T.lineInk}`, padding: "18px 20px", boxShadow: T.shadowCard }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: T.inkDeep, fontFamily: T.fontDisplay, marginBottom: "6px" }}>CPC Trend</div>
          <div style={{ fontSize: "10px", color: T.faint, marginBottom: "14px" }}>30-day average cost per click</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: "2px", height: "120px" }}>
            {perfSeries.map((p, i) => {
              const vals = perfSeries.map(x => x.cpc);
              const mx = Math.max(...vals), mn = Math.min(...vals);
              const h = ((p.cpc - mn) / (mx - mn || 1)) * 100;
              return <div key={i} style={{ flex: 1, height: `${Math.max(h, 4)}%`, background: T.amber, opacity: 0.3 + (h / 100) * 0.7, borderRadius: "2px 2px 0 0" }} title={`${p.date}: $${p.cpc}`} />;
            })}
          </div>
        </div>
      </div>

      {/* Auction insights / IS */}
      <SectionCard title="Auction Insights" subtitle="Impression share and competitive overlap">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.line}` }}>
                {["Domain", "Impr. Share", "Overlap Rate", "Top of Page", "Outranking", "Position Above"].map(h => (
                  <th key={h} style={{ textAlign: h === "Domain" ? "left" : "right", padding: "8px 10px", fontSize: "9px", fontWeight: 700, color: T.faint, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: T.fontDisplay }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {auctionInsights.map((r, i) => {
                const isYou = r.competitor === "You";
                const rowBg = isYou ? `${T.gold}0D` : "transparent";
                return (
                  <tr key={i} style={{ borderBottom: `1px solid ${T.lineSoft}`, background: rowBg }} {...rowHoverProps(rowBg)}>
                    <td style={{ padding: "9px 10px", fontWeight: isYou ? 700 : 500, color: isYou ? T.gold : T.ink, fontFamily: isYou ? T.fontDisplay : "inherit" }}>{r.competitor}</td>
                    <td style={{ padding: "9px 10px", textAlign: "right", fontFamily: T.fontMono, color: T.ink }}>{r.impr_share}%</td>
                    <td style={{ padding: "9px 10px", textAlign: "right", fontFamily: T.fontMono, color: T.muted }}>{r.overlap != null ? `${r.overlap}%` : "—"}</td>
                    <td style={{ padding: "9px 10px", textAlign: "right", fontFamily: T.fontMono, color: T.muted }}>{r.top_of_page}%</td>
                    <td style={{ padding: "9px 10px", textAlign: "right", fontFamily: T.fontMono, color: T.muted }}>{r.outranking != null ? `${r.outranking}%` : "—"}</td>
                    <td style={{ padding: "9px 10px", textAlign: "right", fontFamily: T.fontMono, color: T.muted }}>{r.position_above != null ? `${r.position_above}%` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* Top keywords */}
      <SectionCard title="Top Keywords" subtitle="Ranked by spend — IS = impression share">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.line}` }}>
                {["Keyword", "Cost", "Clicks", "Conv", "CPA", "IS", ""].map((h, hi) => (
                  <th key={hi} style={{ textAlign: hi === 0 ? "left" : "right", padding: "8px 10px", fontSize: "9px", fontWeight: 700, color: T.faint, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: T.fontDisplay }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {topKeywords.map((k, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${T.lineSoft}` }} {...rowHoverProps()}>
                  <td style={{ padding: "9px 10px", color: T.ink, fontWeight: 500 }}>{k.kw}</td>
                  <td style={{ padding: "9px 10px", textAlign: "right", fontFamily: T.fontMono }}>${k.cost.toLocaleString()}</td>
                  <td style={{ padding: "9px 10px", textAlign: "right", fontFamily: T.fontMono, color: T.muted }}>{k.clicks}</td>
                  <td style={{ padding: "9px 10px", textAlign: "right", fontFamily: T.fontMono, color: T.muted }}>{k.conv}</td>
                  <td style={{ padding: "9px 10px", textAlign: "right", fontFamily: T.fontMono, color: k.cpa > 150 ? T.red : T.ink }}>${k.cpa}</td>
                  <td style={{ padding: "9px 10px", textAlign: "right", fontFamily: T.fontMono, color: k.is < 30 ? T.red : T.muted }}>{k.is}%</td>
                  <td style={{ padding: "9px 10px", textAlign: "right" }}>
                    {k.status === "critical" && <Pill color={T.red} bg={`${T.red}1A`}>Act</Pill>}
                    {k.status === "warning" && <Pill color={T.amber} bg={`${T.amber}1A`}>Watch</Pill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* Campaign performance */}
      <SectionCard title="Campaign Performance" subtitle="Spend, efficiency, and budget pacing">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.line}` }}>
                {["Campaign", "Cost", "Conv", "CPA", "Pacing", "Status"].map((h, hi) => (
                  <th key={hi} style={{ textAlign: hi === 0 ? "left" : "right", padding: "8px 10px", fontSize: "9px", fontWeight: 700, color: T.faint, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: T.fontDisplay }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c, i) => {
                const sc = c.status === "performing" ? T.green : c.status === "needs_attention" ? T.red : T.muted;
                const sl = c.status === "performing" ? "Performing" : c.status === "needs_attention" ? "Needs Attention" : "Stable";
                return (
                  <tr key={i} style={{ borderBottom: `1px solid ${T.lineSoft}` }} {...rowHoverProps()}>
                    <td style={{ padding: "9px 10px", color: T.ink, fontWeight: 600 }}>{c.name}</td>
                    <td style={{ padding: "9px 10px", textAlign: "right", fontFamily: T.fontMono }}>${c.cost.toLocaleString()}</td>
                    <td style={{ padding: "9px 10px", textAlign: "right", fontFamily: T.fontMono, color: T.muted }}>{c.conv}</td>
                    <td style={{ padding: "9px 10px", textAlign: "right", fontFamily: T.fontMono, color: client.cpa_target && c.cpa > client.cpa_target ? T.red : T.ink }}>${c.cpa}</td>
                    <td style={{ padding: "9px 10px", textAlign: "right", fontFamily: T.fontMono, color: c.pacing > 115 ? T.red : c.pacing < 80 ? T.amber : T.green }}>{c.pacing}%</td>
                    <td style={{ padding: "9px 10px", textAlign: "right" }}><Pill color={sc} bg={sc + "12"}>{sl}</Pill></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* Recommendations */}
      <SectionCard title="Recommendations & Opportunities" subtitle={hasLiveData ? "From live account findings" : "Demo — live findings appear here once connected"}>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {recommendations.map((r, i) => {
            const c = SEV[r.severity] || SEV.info;
            return (
              <div key={i} style={{ display: "flex", gap: "12px", padding: "13px 15px", background: c + "08", borderRadius: "10px", border: `1px solid ${c}22` }}>
                <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: c, flexShrink: 0, marginTop: "5px" }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: "12px", fontWeight: 700, color: T.inkDeep, fontFamily: T.fontDisplay, marginBottom: "3px" }}>{r.title}</div>
                  <div style={{ fontSize: "11px", color: T.muted, lineHeight: 1.55 }}>{r.detail}</div>
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>
    </div>
  );
}


export function ClientsView({ deepClientId = null, onNavigate }) {
  const [clients, setClients] = useState([]);
  const [findings, setFindings] = useState([]);
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedClient, setSelectedClient] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [userId, setUserId] = useState(null);
  const [nc, setNc] = useState({ name: "", industry: "", monthly_budget: "", cpa_target: "", google_ads_customer_id: "" });
  const [saving, setSaving] = useState(false);
  const [dateRange, setDateRange] = useState("30d");
  const [addError, setAddError] = useState("");
  const [loadError, setLoadError] = useState("");

  // Resolved from supabase-js at call time, like every other request path.
  // Reading the localStorage mirror synchronously left these three fetches as
  // the only consumers still depending on that mirror being fresh.
  const hdr = async () => {
    const token = await currentAccessToken();
    return { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };
  };

  const load = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const h = await hdr();
      const [cr, fr, ar] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/clients?status=eq.active&order=created_at.asc`, { headers: h }),
        fetch(`${SUPABASE_URL}/rest/v1/findings?status=eq.active&order=created_at.desc&limit=60`, { headers: h }),
        fetch(`${SUPABASE_URL}/rest/v1/action_queue?status=eq.pending&order=created_at.desc&limit=30`, { headers: h }),
      ]);
      if (!cr.ok) {
        const detail = await cr.text().catch(() => "");
        setLoadError(`Couldn't load clients (${cr.status}). ${detail.includes("does not exist") ? "The clients table doesn't exist in Supabase yet — run schema.sql first." : detail.slice(0, 140)}`);
      }
      setClients(cr.ok ? await cr.json() : []);
      setFindings(fr.ok ? await fr.json() : []);
      setActions(ar.ok ? await ar.json() : []);
    } catch (err) {
      setLoadError(err.message || "Couldn't reach Supabase.");
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // Fetch the authenticated user id once — every client row needs this for
    // the RLS policy (auth.uid() = user_id) defined in schema.sql to pass.
    (async () => {
      const token = await currentAccessToken();
      if (!token) return;
      try {
        const u = await sbAuth.getUser(token);
        if (u?.id) setUserId(u.id);
      } catch { /* non-fatal: the row-level insert will surface it instead */ }
    })();
  }, []);

  // Deep link → selection (and browser Back → list). #/clients/<id> selects
  // that client once the list loads; hash falling back to #/clients clears it.
  useEffect(() => {
    if (deepClientId) {
      const c = clients.find(x => String(x.id) === String(deepClientId));
      if (c && (!selectedClient || String(selectedClient.id) !== String(deepClientId))) setSelectedClient(c);
    } else if (selectedClient) {
      setSelectedClient(null);
    }
    // eslint-disable-next-line
  }, [deepClientId, clients]);
  // Selection → hash: pushes a history entry so Back returns to the client list.
  useEffect(() => {
    if (!window.location.hash.startsWith("#/clients")) return;
    const want = selectedClient ? `#/clients/${encodeURIComponent(selectedClient.id)}` : "#/clients";
    if (window.location.hash !== want) window.location.hash = want;
    // eslint-disable-next-line
  }, [selectedClient]);

  const addClient = async () => {
    if (!nc.name) return;
    setSaving(true);
    setAddError("");
    try {
      if (!userId) throw new Error("Couldn't confirm your account — try refreshing the page before adding a client.");
      const res = await fetch(`${SUPABASE_URL}/rest/v1/clients`, {
        method: "POST", headers: { ...hdr(), "Prefer": "return=minimal" },
        body: JSON.stringify({ ...nc, user_id: userId, status: "active", monthly_budget: parseFloat(nc.monthly_budget) || null, cpa_target: parseFloat(nc.cpa_target) || null }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `Save failed (${res.status})`);
      }
      setShowAdd(false); setNc({ name: "", industry: "", monthly_budget: "", cpa_target: "", google_ads_customer_id: "" });
      await load();
    } catch (err) {
      setAddError(err.message || "Something went wrong saving this client.");
    }
    setSaving(false);
  };

  const approveAction = async (id) => {
    await fetch(`${SUPABASE_URL}/rest/v1/action_queue?id=eq.${id}`, {
      method: "PATCH", headers: { ...hdr(), "Prefer": "return=minimal" },
      body: JSON.stringify({ status: "approved", approved_at: new Date().toISOString() }),
    });
    load();
  };

  const deleteClient = async (c) => {
    if (!window.confirm(`Delete ${c.name}? This removes the client and its findings/action history for good — this can't be undone.`)) return;
    try {
      // Best-effort cleanup of dependent rows first, in case the DB doesn't
      // cascade-delete — harmless no-ops if it already does.
      await fetch(`${SUPABASE_URL}/rest/v1/findings?client_id=eq.${c.id}`, { method: "DELETE", headers: { ...hdr(), "Prefer": "return=minimal" } }).catch(() => {});
      await fetch(`${SUPABASE_URL}/rest/v1/action_queue?client_id=eq.${c.id}`, { method: "DELETE", headers: { ...hdr(), "Prefer": "return=minimal" } }).catch(() => {});
      const res = await fetch(`${SUPABASE_URL}/rest/v1/clients?id=eq.${c.id}`, { method: "DELETE", headers: { ...hdr(), "Prefer": "return=minimal" } });
      if (!res.ok) throw new Error(await res.text().catch(() => `Delete failed (${res.status})`));
      setSelectedClient(null);
      await load();
    } catch (err) {
      setLoadError("Couldn't delete client: " + (err.message || "unknown error"));
    }
  };

  const dismissFinding = async (id) => {
    await fetch(`${SUPABASE_URL}/rest/v1/findings?id=eq.${id}`, {
      method: "PATCH", headers: { ...hdr(), "Prefer": "return=minimal" },
      body: JSON.stringify({ status: "dismissed" }),
    });
    setFindings(p => p.filter(f => f.id !== id));
  };

  const SEV = SEV_TOKENS;
  const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90, "all": null };
  const cutoff = RANGE_DAYS[dateRange] ? Date.now() - RANGE_DAYS[dateRange] * 86400000 : null;
  const inRange = (dateStr) => !cutoff || new Date(dateStr).getTime() >= cutoff;
  const filteredFindings = findings.filter(f => inRange(f.created_at));
  const filteredActions = actions.filter(a => inRange(a.created_at));
  const excludedCount = findings.length - filteredFindings.length;
  const cf = (id) => filteredFindings.filter(f => f.client_id === id);
  const ca = (id) => filteredActions.filter(a => a.client_id === id);
  const criticals = filteredFindings.filter(f => f.severity === "critical").length;

  // A skeleton shaped like the client list it resolves into, not a spinner in
  // the middle of an empty screen. The page then DEVELOPS — the rows are
  // already where they will be, so nothing jumps when the data lands.
  if (loading) return (
    <div className="pagefade" style={{ padding: "16px 0" }}>
      <SkeletonRows count={4} />
    </div>
  );

  // Full detail page when a client is selected
  if (selectedClient) {
    const origin = sm.get(`client_origin_${selectedClient.id}`);
    return (<div>
      {origin && (
        <div style={{ maxWidth: "1240px", margin: "12px auto 0", padding: "0 28px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "9px 14px", borderRadius: T.rSm, background: T.goldSoft, border: `1px solid ${T.goldLine}`, fontSize: "12px", color: T.inkDeep }}>
            <span style={{ fontWeight: 700, fontFamily: T.fontDisplay, fontSize: "10px", letterSpacing: "0.08em", textTransform: "uppercase", color: T.gold }}>Origin</span>
            Came in via {origin.source || "inbound form"}{origin.email ? ` (${origin.email})` : ""}
            <button onClick={() => { if (origin.email) sm.set("inbound_focus", origin.email); onNavigate && onNavigate("inbound"); }} style={{ marginLeft: "auto", background: "none", border: "none", color: T.gold, fontSize: "12px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay }}>View conversation →</button>
          </div>
        </div>
      )}
      <ClientDetail client={selectedClient} findings={findings} actions={actions} onBack={() => setSelectedClient(null)} onDelete={deleteClient} />
    </div>);
  }

  return (
    <div style={{ minHeight: "calc(100vh - 48px)", background: "transparent", padding: "24px 28px" }}>
      {/* Load error banner — surfaces real Supabase failures instead of a silent empty state */}
      {loadError && (
        <div style={{ marginBottom: "16px", padding: "12px 16px", background: `${T.red}1F`, border: `1px solid ${T.red}33`, borderRadius: "10px", display: "flex", gap: "10px", alignItems: "flex-start" }}>
          <span style={{ color: T.red, fontSize: "13px", flexShrink: 0 }}>⚠</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "12px", fontWeight: 700, color: T.red, fontFamily: T.fontDisplay }}>Couldn't load client data</div>
            <div style={{ fontSize: "11px", color: T.ink, marginTop: "2px", lineHeight: 1.5 }}>{loadError}</div>
          </div>
          <button onClick={load} style={{ fontSize: "10px", fontWeight: 700, color: T.red, background: "none", border: `1px solid ${T.red}4D`, borderRadius: "6px", padding: "4px 10px", cursor: "pointer", flexShrink: 0 }}>Retry</button>
        </div>
      )}

      {/* Portfolio bar */}
      <div className="co-portfolio-bar" style={{ display: "flex", gap: "8px", marginBottom: "24px", alignItems: "center", flexWrap: "wrap" }}>
        {[
          { label: "Clients", value: clients.length },
          { label: "Critical", value: criticals, color: criticals > 0 ? T.red : undefined },
          { label: "Pending Actions", value: filteredActions.length, color: filteredActions.length > 0 ? T.amber : undefined },
          { label: "Agent", value: "Active", color: T.green },
        ].map((m, i) => (
          <div key={i} className="co-portfolio-card" style={{ flex: 1, minWidth: "120px", background: T.surface, borderRadius: "10px", border: `1px solid ${T.lineInk}`, padding: "14px 16px", boxShadow: T.shadowCard }}>
            <div style={{ fontSize: "9px", fontWeight: 700, color: T.faint, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay, marginBottom: "6px" }}>{m.label}</div>
            <div style={{ fontSize: "24px", fontWeight: 500, color: m.color || T.inkDeep, fontFamily: T.fontMono, lineHeight: 1 }}>{m.value}</div>
          </div>
        ))}
        <button onClick={() => { setAddError(""); setShowAdd(true); }} style={{ padding: "12px 20px", background: T.goldGrad, border: "none", borderRadius: "9px", color: T.textOnBrand, fontSize: "12px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay, letterSpacing: "0.05em", whiteSpace: "nowrap", boxShadow: T.glowBrass }}>+ Add Client</button>
      </div>

      <div className="co-grid2" style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: "16px", alignItems: "start" }}>
        {/* Clients */}
        <div>
          <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay }}>Active Clients</div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
              <div style={{ display: "flex", gap: "2px", background: T.subtle, borderRadius: "7px", padding: "2px" }}>
                {[["7d","7D"],["30d","30D"],["90d","90D"],["all","All"]].map(([key,label]) => (
                  <button key={key} onClick={() => setDateRange(key)}
                    style={{ padding: "3px 11px", background: dateRange === key ? T.raised : "transparent", border: "none", borderRadius: "5px", color: dateRange === key ? T.ink : T.faint, fontSize: "10px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay, boxShadow: dateRange === key ? T.shadowTab : "none" }}>
                    {label}
                  </button>
                ))}
              </div>
              {excludedCount > 0 && <span style={{ fontSize: "10px", color: T.faint }}>{excludedCount} older finding{excludedCount !== 1 ? "s" : ""} outside this range</span>}
            </div>
          {clients.length === 0 ? (
            <div style={{ background: T.surface, borderRadius: "12px", border: `1px solid ${T.lineInk}`, padding: "48px", textAlign: "center" }}>
              <div style={{ fontSize: "14px", fontWeight: 700, color: T.inkDeep, fontFamily: T.fontDisplay, marginBottom: "8px" }}>No clients yet</div>
              <div style={{ fontSize: "13px", color: T.faint, marginBottom: "20px" }}>Add your first client to start autonomous monitoring</div>
              <button onClick={() => { setAddError(""); setShowAdd(true); }} style={{ padding: "10px 24px", background: T.goldGrad, border: "none", borderRadius: "8px", color: T.textOnBrand, fontSize: "12px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay }}>+ Add Client</button>
            </div>
          ) : clients.map(client => {
            const cF = cf(client.id), cA = ca(client.id);
            const hasCrit = cF.some(f => f.severity === "critical");
            const latest = cF[0];
            const open = selectedClient?.id === client.id;
            return (
              <div key={client.id} onClick={() => setSelectedClient(client)}
                style={{ background: T.surface, borderRadius: "12px", border: `1px solid ${hasCrit ? `${T.red}2E` : T.line}`, padding: "16px 20px", cursor: "pointer", boxShadow: T.shadowCard, marginBottom: "10px", transition: "box-shadow 0.15s" }}
                onMouseEnter={e => e.currentTarget.style.boxShadow = T.shadowHover}
                onMouseLeave={e => e.currentTarget.style.boxShadow = T.shadowCard}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1, minWidth: 0 }}>
                    <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: hasCrit ? T.red : T.muted, flexShrink: 0, boxShadow: hasCrit ? `0 0 6px ${T.red}80` : "none" }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: "14px", fontWeight: 700, color: T.ink, fontFamily: T.fontDisplay }}>{client.name}</div>
                      {client.industry && <div style={{ fontSize: "11px", color: T.faint }}>{client.industry}</div>}
                      {latest && <div style={{ fontSize: "11px", color: T.muted, marginTop: "4px", lineHeight: 1.5 }}>{latest.title}</div>}
                      {!latest && <div style={{ fontSize: "11px", color: T.faint, marginTop: "4px" }}>No findings yet — install Google Ads Script to start</div>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "5px", flexShrink: 0, alignItems: "center" }}>
                    {client.cpa_target && <span style={{ fontSize: "10px", fontFamily: T.fontMono, color: T.muted, background: "rgba(255,255,255,0.04)", padding: "3px 8px", borderRadius: "6px" }}>target ${client.cpa_target}</span>}
                    {cF.length > 0 && <span style={{ fontSize: "10px", fontWeight: 700, color: hasCrit ? T.red : T.amber, background: (hasCrit ? T.red : T.amber) + "12", padding: "3px 8px", borderRadius: "6px" }}>{cF.length}</span>}
                    {cA.length > 0 && <span style={{ fontSize: "10px", fontWeight: 700, color: T.blue, background: `${T.blue}1A`, padding: "3px 8px", borderRadius: "6px" }}>✦ {cA.length}</span>}
                    <button onClick={(e) => { e.stopPropagation(); deleteClient(client); }} title="Delete client" aria-label="Delete client" className="co-icon-btn"
                      style={{ background: "none", border: "none", color: T.faint, fontSize: "13px", cursor: "pointer", padding: "2px 4px", lineHeight: 1 }}>🗑</button>
                  </div>
                </div>
                {/* Click opens full detail page — see ClientDetail */}
              </div>
            );
          })}
        </div>

        {/* Action queue */}
        <div className="co-sticky-side" style={{ position: "sticky", top: "72px" }}>
          <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay, marginBottom: "12px" }}>Action Queue</div>
          <div style={{ background: T.surface, borderRadius: "12px", border: `1px solid ${T.lineInk}`, overflow: "hidden", boxShadow: T.shadowCard }}>
            {filteredActions.length === 0 ? (
              <EmptyState icon="spark" compact title={`No pending actions${dateRange !== "all" ? " in this range" : ""}`} />
            ) : filteredActions.slice(0, 7).map((a, i) => (
              <div key={a.id} style={{ padding: "14px 16px", borderBottom: i < Math.min(filteredActions.length, 7) - 1 ? `1px solid ${T.lineSoft}` : "none" }}>
                <div style={{ fontSize: "9px", fontWeight: 700, color: T.gold, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "4px", fontFamily: T.fontDisplay }}>{(a.action_type || "action").replace(/_/g, " ")}</div>
                <div style={{ fontSize: "12px", color: T.ink, fontWeight: 600, marginBottom: "4px" }}>{a.description}</div>
                <div style={{ fontSize: "11px", color: T.muted, marginBottom: "8px", lineHeight: 1.5 }}>{(a.rationale || "").slice(0, 120)}{(a.rationale || "").length > 120 ? "…" : ""}</div>
                {a.impact_estimate && <div style={{ fontSize: "10px", color: T.green, marginBottom: "8px" }}>→ {a.impact_estimate}</div>}
                <div style={{ display: "flex", gap: "6px" }}>
                  <button onClick={() => approveAction(a.id)} style={{ flex: 1, padding: "6px", background: T.goldGrad, border: "none", borderRadius: "6px", color: T.textOnBrand, fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay }}>Approve</button>
                  <button onClick={() => dismissFinding(a.id)} style={{ padding: "6px 10px", background: "transparent", border: `1px solid ${T.line}`, borderRadius: "6px", color: T.faint, fontSize: "11px", cursor: "pointer" }}>Skip</button>
                </div>
              </div>
            ))}
          </div>
          {clients.length > 0 && filteredFindings.length === 0 && (
            <div style={{ marginTop: "12px", background: `${T.amber}1F`, borderRadius: "10px", border: `1px solid ${T.amber}33`, padding: "16px" }}>
              <div style={{ fontSize: "11px", fontWeight: 700, color: T.amber, fontFamily: T.fontDisplay, marginBottom: "6px" }}>Agent not connected yet</div>
              <div style={{ fontSize: "11px", color: T.muted, lineHeight: 1.6 }}>Install the Google Ads Script in your client's account to start the pipeline.</div>
            </div>
          )}
        </div>
      </div>

      {/* Add modal */}
      {showAdd && (
        <div className="co-modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: "40px" }}
          onClick={e => e.target === e.currentTarget && setShowAdd(false)}>
          <div className="co-modal-sheet" style={{ background: T.surface, borderRadius: "14px", maxWidth: "420px", width: "100%", boxShadow: T.shadowModal }}>
            <div style={{ padding: "20px 24px", borderBottom: `1px solid ${T.line}` }}>
              <div style={{ fontSize: "14px", fontWeight: 700, color: T.inkDeep, fontFamily: T.fontDisplay }}>Add Client</div>
            </div>
            <div style={{ padding: "20px 24px" }}>
              {[{ k: "name", l: "Client Name *", p: "Chicago PI Law" }, { k: "industry", l: "Industry", p: "Personal Injury Law" }, { k: "monthly_budget", l: "Monthly Budget ($)", p: "8500" }, { k: "cpa_target", l: "CPA Target ($)", p: "120" }, { k: "google_ads_customer_id", l: "Google Ads Customer ID", p: "123-456-7890" }].map(f => (
                <div key={f.k} style={{ marginBottom: "12px" }}>
                  <label style={{ fontSize: "10px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: T.fontDisplay, display: "block", marginBottom: "5px" }}>{f.l}</label>
                  <input value={nc[f.k]} onChange={e => setNc(p => ({ ...p, [f.k]: e.target.value }))} placeholder={f.p}
                    style={{ width: "100%", padding: "9px 12px", background: T.subtle, border: `1px solid ${T.line}`, borderRadius: "8px", fontSize: "13px", color: T.ink, outline: "none", boxSizing: "border-box" }} />
                </div>
              ))}
              {addError && (
                <div style={{ marginBottom: "12px", padding: "10px 12px", background: `${T.red}1F`, border: `1px solid ${T.red}33`, borderRadius: "8px" }}>
                  <div style={{ fontSize: "11px", fontWeight: 700, color: T.red, fontFamily: T.fontDisplay, marginBottom: "2px" }}>Save failed</div>
                  <div style={{ fontSize: "10px", color: T.ink, lineHeight: 1.5 }}>{addError}</div>
                </div>
              )}
              <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                <button onClick={addClient} disabled={saving || !nc.name}
                  style={{ flex: 1, padding: "11px", background: !nc.name || saving ? T.subtle : T.goldGrad, border: "none", borderRadius: "9px", color: !nc.name || saving ? T.faint : T.textOnBrand, fontSize: "12px", fontWeight: 700, cursor: !nc.name || saving ? "not-allowed" : "pointer", fontFamily: T.fontDisplay }}>
                  {saving ? "Adding…" : "Add Client"}
                </button>
                <button onClick={() => setShowAdd(false)} style={{ padding: "11px 20px", background: "transparent", border: `1px solid ${T.line}`, borderRadius: "9px", color: T.muted, fontSize: "12px", cursor: "pointer" }}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
