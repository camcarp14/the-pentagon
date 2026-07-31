// ─── Pipeline Analytics — the real dashboard ─────────────────────────────────
// Thin renderer over lib/analytics.js (all aggregation is pure + tested).
// Chart rules follow the dataviz method: form first, one axis, thin marks with
// rounded data-ends and 2px surface gaps, recessive grid, text in text tokens
// (never series color), hover tooltips on every plot, legend for 2+ series,
// series palette validated for this dark surface (see CHART_SERIES).
import { useEffect, useMemo, useRef, useState } from "react";
import { T } from "../../theme.js";
import { AnimatedNumber, EmptyState, SkeletonRows } from "../../ui.jsx";
import {
  CHART_SERIES, funnelStages, stepPerformance, segmentRates, weeklyTrend,
  replyMix, timeToReply, headlineStats,
} from "../../lib/analytics.js";
import { CLASSIFICATIONS } from "../../lib/classify.js";
import { seqDb } from "../../lib/sequenceDb.js";

const BRASS = CHART_SERIES[0], BLUE = CHART_SERIES[1];
const TRACK = "rgba(255,255,255,0.06)";
const pct = (v) => `${Math.round(v * 100)}%`;

// ── Shared tooltip ───────────────────────────────────────────────────────────
function Tip({ tip }) {
  if (!tip) return null;
  return (
    // Border removed: shadowPopover already separates this from the plot, and a
    // border plus a shadow on one element is what the language forbids.
    <div style={{ position: "absolute", left: tip.x, top: tip.y, transform: "translate(-50%, calc(-100% - 10px))", pointerEvents: "none", zIndex: 5, background: T.raised, borderRadius: T.rSm, boxShadow: T.shadowPopover, padding: "7px 10px", whiteSpace: "nowrap" }}>
      <div style={{ fontSize: "10.5px", color: T.faint, fontFamily: T.fontMono, marginBottom: "2px" }}>{tip.label}</div>
      {tip.rows.map((r, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11.5px", color: T.ink }}>
          {r.color && <span style={{ width: "7px", height: "7px", borderRadius: "2px", background: r.color, flexShrink: 0 }} />}
          <span style={{ color: T.muted }}>{r.name}</span>
          <span style={{ fontFamily: T.fontMono, fontWeight: 600 }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function Legend({ items }) {
  return (
    <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
      {items.map((it) => (
        <span key={it.name} style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "10.5px", color: T.muted }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: it.color }} />{it.name}
        </span>
      ))}
    </div>
  );
}

function Panel({ title, sub, right, children }) {
  return (
    // minWidth: 0 stops grid blowout — without it the trend chart's min-width
    // SVG propagates min-content through the shared column track and every
    // panel inflates past the viewport on phones.
    // The kit's .card — it carried a border AND shadowCard before.
    <div className="card" style={{ padding: "18px 20px", position: "relative", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: sub ? "2px" : "14px", flexWrap: "wrap" }}>
        <div className="t-label">{title}</div>
        <div style={{ flex: 1 }} />
        {right}
      </div>
      {sub && <div className="t-cap" style={{ color: T.faint, marginBottom: "14px" }}>{sub}</div>}
      {children}
    </div>
  );
}

function StatTile({ label, value, sub, format }) {
  return (
    // The kit's stat tile, on the canvas: surface, card shadow, no outline.
    <div className="stattile on-canvas" style={{ padding: "16px 18px" }}>
      <div className="stattile-label">{label}</div>
      <div className="stattile-value" style={{ fontSize: "26px" }}>
        <AnimatedNumber value={value} format={format} />
      </div>
      {sub && <div className="t-cap" style={{ marginTop: "5px" }}>{sub}</div>}
    </div>
  );
}

// ── Horizontal bars (single hue, direct labels) ──────────────────────────────
function HBars({ rows, color = BLUE, valueLabel }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const [tip, setTip] = useState(null);
  const wrapRef = useRef(null);
  return (
    <div ref={wrapRef} style={{ position: "relative", display: "flex", flexDirection: "column", gap: "8px" }}>
      <Tip tip={tip} />
      {rows.map((r) => (
        <div key={r.label}
          onMouseMove={(e) => {
            const b = wrapRef.current.getBoundingClientRect();
            setTip({ x: e.clientX - b.left, y: e.clientY - b.top, label: r.label, rows: [{ name: valueLabel || "value", value: r.tipValue ?? r.value, color }] });
          }}
          onMouseLeave={() => setTip(null)}
          style={{ display: "grid", gridTemplateColumns: "minmax(72px, 130px) 1fr auto", alignItems: "center", gap: "10px", cursor: "default" }}>
          <span style={{ fontSize: "11px", color: T.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
          <div style={{ height: "14px", background: TRACK, borderRadius: "4px", overflow: "hidden" }}>
            <div style={{ width: `${(r.value / max) * 100}%`, height: "100%", background: r.color || color, borderRadius: "0 4px 4px 0", transition: `width 0.5s ${T.easeOut}` }} />
          </div>
          <span style={{ fontSize: "11px", color: T.ink, fontFamily: T.fontMono, minWidth: "58px", textAlign: "right" }}>{r.display ?? r.value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Two-series line chart with crosshair tooltip ─────────────────────────────
function TrendChart({ buckets }) {
  const W = 560, H = 150, PAD = { l: 26, r: 8, t: 10, b: 20 };
  const [tip, setTip] = useState(null);
  const [hoverI, setHoverI] = useState(null);
  const wrapRef = useRef(null);
  const max = Math.max(2, ...buckets.map((b) => Math.max(b.sent, b.replies)));
  const x = (i) => PAD.l + (i / Math.max(1, buckets.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
  const path = (key) => buckets.map((b, i) => `${i ? "L" : "M"}${x(i)},${y(b[key])}`).join(" ");
  const gridVals = [0, Math.ceil(max / 2), max];
  return (
    <div ref={wrapRef} style={{ position: "relative", minWidth: 0 }}>
      <Tip tip={tip} />
      <div style={{ overflowX: "auto", minWidth: 0 }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: "420px", display: "block" }}
          onMouseLeave={() => { setTip(null); setHoverI(null); }}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - rect.left) / rect.width) * W;
            const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (buckets.length - 1));
            if (i < 0 || i >= buckets.length) return;
            setHoverI(i);
            const wrap = wrapRef.current.getBoundingClientRect();
            setTip({
              x: e.clientX - wrap.left, y: e.clientY - wrap.top, label: `week of ${buckets[i].label}`,
              rows: [
                { name: "Sent", value: buckets[i].sent, color: BRASS },
                { name: "Replies", value: buckets[i].replies, color: BLUE },
              ],
            });
          }}>
          {gridVals.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.055)" strokeWidth="1" />
              <text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" fontSize="10.5" fill={T.faint} fontFamily={T.fontMono}>{v}</text>
            </g>
          ))}
          {hoverI != null && <line x1={x(hoverI)} x2={x(hoverI)} y1={PAD.t} y2={H - PAD.b} stroke="rgba(255,255,255,0.14)" strokeWidth="1" />}
          <path d={path("sent")} fill="none" stroke={BRASS} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          <path d={path("replies")} fill="none" stroke={BLUE} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {buckets.map((b, i) => (
            <g key={i}>
              {(hoverI === i || b.sent > 0) && <circle cx={x(i)} cy={y(b.sent)} r={hoverI === i ? 4 : 2.5} fill={BRASS} stroke="#141B2C" strokeWidth="2" />}
              {(hoverI === i || b.replies > 0) && <circle cx={x(i)} cy={y(b.replies)} r={hoverI === i ? 4 : 2.5} fill={BLUE} stroke="#141B2C" strokeWidth="2" />}
              <text x={x(i)} y={H - 6} textAnchor="middle" fontSize="10.5" fill={T.faint} fontFamily={T.fontMono}>{b.label}</text>
            </g>
          ))}
        </svg>
      </div>
      <div style={{ marginTop: "8px" }}><Legend items={[{ name: "Sent", color: BRASS }, { name: "Replies", color: BLUE }]} /></div>
    </div>
  );
}

// ── Grouped bars: sent vs replies per sequence step ──────────────────────────
function StepBars({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.sent));
  const [tip, setTip] = useState(null);
  const wrapRef = useRef(null);
  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <Tip tip={tip} />
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {rows.map((r) => (
          <div key={r.step_order}
            onMouseMove={(e) => {
              const b = wrapRef.current.getBoundingClientRect();
              setTip({
                x: e.clientX - b.left, y: e.clientY - b.top, label: r.name,
                rows: [
                  { name: "Sent", value: r.sent, color: BRASS },
                  { name: "Replies", value: r.replies, color: BLUE },
                  { name: "Rate", value: pct(r.rate) },
                ],
              });
            }}
            onMouseLeave={() => setTip(null)} style={{ cursor: "default" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
              <span style={{ fontSize: "11px", color: T.muted }}>
                <span style={{ fontFamily: T.fontMono, color: T.faint }}>{r.step_order === 0 ? "•" : r.step_order}</span> {r.name}
              </span>
              <span style={{ fontSize: "10.5px", color: T.ink, fontFamily: T.fontMono }}>{pct(r.rate)} reply rate</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <div style={{ height: "10px", background: TRACK, borderRadius: "4px", overflow: "hidden" }}>
                <div style={{ width: `${(r.sent / max) * 100}%`, height: "100%", background: BRASS, borderRadius: "0 4px 4px 0" }} />
              </div>
              <div style={{ height: "10px", background: TRACK, borderRadius: "4px", overflow: "hidden" }}>
                <div style={{ width: `${(r.replies / max) * 100}%`, height: "100%", background: BLUE, borderRadius: "0 4px 4px 0" }} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: "10px" }}><Legend items={[{ name: "Sent", color: BRASS }, { name: "Replies", color: BLUE }]} /></div>
    </div>
  );
}

const SEGMENT_DIMENSIONS = [
  { key: "category", label: "Category" },
  { key: "city", label: "City" },
  { key: "value", label: "Value band" },
  { key: "ads", label: "Ads status" },
];

export function AnalyticsView({ cards }) {
  const [seqData, setSeqData] = useState(null); // { steps, enrollments, messages }
  const [dimension, setDimension] = useState("category");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // Only threads with send activity can have ledger rows — skipping
        // untouched prospects keeps the id list (and the chunked queries) small.
        const activeIds = (cards || [])
          .filter((c) => c.sent_at || !["prospected", "draft", "draft_ready"].includes(c.status))
          .map((c) => c.id);
        const [steps, enrollments, messages] = await Promise.all([
          seqDb.getSteps().catch(() => []),
          seqDb.getAllEnrollments().catch(() => []),
          seqDb.getMessagesFor(activeIds).catch(() => []),
        ]);
        if (alive) setSeqData({ steps: steps || [], enrollments: enrollments || [], messages: messages || [] });
      } catch {
        if (alive) setSeqData({ steps: [], enrollments: [], messages: [] });
      }
    })();
    return () => { alive = false; };
  }, [cards]);

  const stats = useMemo(() => headlineStats(cards || [], seqData?.enrollments || []), [cards, seqData]);
  const funnel = useMemo(() => funnelStages(cards || []), [cards]);
  const trend = useMemo(() => weeklyTrend(cards || []), [cards]);
  const segments = useMemo(() => segmentRates(cards || [], dimension).slice(0, 8), [cards, dimension]);
  const mix = useMemo(() => replyMix(cards || []), [cards]);
  const ttr = useMemo(() => timeToReply(cards || []), [cards]);
  const stepRows = useMemo(
    () => (seqData ? stepPerformance({ messages: seqData.messages, steps: seqData.steps, cards: cards || [] }) : []),
    [seqData, cards]
  );

  const funnelMax = Math.max(1, funnel[0]?.value || 1);
  const hasData = (cards || []).length > 0;

  if (!hasData) {
    return (
      <div style={{ padding: "24px 28px", maxWidth: "1060px", margin: "0 auto" }}>
        <EmptyState icon="chart" title="No pipeline data yet" sub="Analytics light up as soon as prospects enter the pipeline and sends go out." />
      </div>
    );
  }

  return (
    <div style={{ padding: "24px 28px", maxWidth: "1060px", margin: "0 auto" }}>
      <h2 className="t-title2" style={{ margin: "0 0 4px" }}>Pipeline analytics</h2>
      <div className="t-foot" style={{ marginBottom: "18px" }}>Conversion, response, and sequence performance — computed live from the pipeline.</div>

      {/* Headline stats */}
      <div className="co-grid4" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "14px", marginBottom: "14px" }}>
        <StatTile label="Response rate" value={stats.responseRate * 100} format={(v) => `${v.toFixed(0)}%`} sub={`${stats.replied} replied / ${stats.sent} sent`} />
        <StatTile label="Positive replies" value={stats.positiveRate * 100} format={(v) => `${v.toFixed(0)}%`} sub="interested or booking, of replies" />
        <StatTile label="Meetings" value={stats.meetings} sub="booked from outreach" />
        <StatTile label="In sequence" value={stats.activeEnrollments} sub="threads on an active cadence" />
      </div>

      <div className="co-grid2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "14px" }}>
        {/* Funnel — single measure, single (brass) hue */}
        <Panel title="Funnel" sub="how far every live thread has traveled">
          <HBars valueLabel="threads" color={BRASS}
            rows={funnel.map((s, i) => ({
              label: s.label, value: s.value,
              display: `${s.value}${i > 0 && funnel[i - 1].value > 0 ? ` · ${pct(s.value / funnel[i - 1].value)}` : ""}`,
              tipValue: s.value,
            }))} />
        </Panel>

        {/* Weekly trend — 2 series, legend, crosshair */}
        <Panel title="Activity · 8 weeks" sub="sends and replies per week">
          <TrendChart buckets={trend} />
        </Panel>

        {/* Sequence step performance */}
        <Panel title="Sequence performance" sub="replies attributed to the last touch before them">
          {stepRows.length === 0 ? (
            <EmptyState compact icon="spark" title="No sequence sends yet" sub="Enroll threads in a sequence and step performance shows up here." />
          ) : (
            <StepBars rows={stepRows} />
          )}
        </Panel>

        {/* Segments with dimension filter */}
        <Panel title="Response by segment"
          right={
            <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
              {SEGMENT_DIMENSIONS.map((d) => (
                <button key={d.key} type="button" aria-pressed={dimension === d.key} onClick={() => setDimension(d.key)}
                  className={dimension === d.key ? "pill active" : "pill"} style={{ height: 28, padding: "0 12px", fontSize: "12px" }}>
                  {d.label}
                </button>
              ))}
            </div>
          }>
          {segments.length === 0 ? (
            <EmptyState compact icon="chart" title="No sends yet" sub="Send outreach and segment response rates appear here." />
          ) : (
            <HBars valueLabel="reply rate" color={BLUE}
              rows={segments.map((s) => ({ label: s.segment, value: s.rate, display: `${pct(s.rate)} · ${s.replied}/${s.sent}`, tipValue: `${pct(s.rate)} (${s.replied}/${s.sent})` }))} />
          )}
        </Panel>

        {/* Reply mix — status-semantic colors with labels (never color alone) */}
        <Panel title="Reply mix" sub="what replies actually say">
          {mix.length === 0 ? (
            <EmptyState compact icon="inbox" title="No replies yet" />
          ) : (
            <HBars valueLabel="replies"
              rows={mix.map((m) => ({
                label: CLASSIFICATIONS[m.key]?.label || m.key, value: m.value,
                color: CLASSIFICATIONS[m.key]?.color || T.muted, display: m.value,
              }))} />
          )}
        </Panel>

        {/* Time to reply */}
        <Panel title="Time to reply" sub={ttr.median != null ? `median ${ttr.median < 24 ? `${Math.round(ttr.median)}h` : `${(ttr.median / 24).toFixed(1)}d`}` : "no replies yet"}>
          {ttr.buckets.length === 0 ? (
            <EmptyState compact icon="calendar" title="No replies yet" />
          ) : (
            <HBars valueLabel="replies" color={BRASS}
              rows={ttr.buckets.map((b) => ({ label: b.label, value: b.value, display: b.value }))} />
          )}
        </Panel>
      </div>
    </div>
  );
}
