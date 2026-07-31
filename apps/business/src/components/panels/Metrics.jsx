// ═══════════════════════════════════════════════════════════════════════════
// Panel 9 — the objective function over time.
//
// Every other panel answers "is the agent still working". This one answers "is
// the number it exists to move actually moving", which makes it the panel most
// able to lie. A chart is the most confident-looking object on a dashboard, and
// a line drawn through absent data is pixel-for-pixel identical to a line drawn
// through measurements.
//
// Three refusals, and they are most of this file:
//
//   a null is not a zero      A snapshot carrying no mrr_usd is a snapshot that
//                             did not measure MRR. Plotting it on the baseline
//                             manufactures a collapse to nothing — the single
//                             most alarming shape available — out of an absence.
//                             Nulls break the line instead.
//   a silence is not a trend  x is scaled by TIME, never by row index, so an
//                             irregular cadence can't be ironed into an even
//                             march of points. A gap wider than twice the
//                             staleness window breaks the line outright:
//                             nothing was measured across it, and a straight
//                             segment there asserts values nobody recorded.
//   one point is not a line   A lone reading draws as a dot and says so out
//                             loud. Two is the smallest honest trend; below
//                             that this panel declines to draw.
//
// The age of the newest snapshot is repeated in the body even though the
// freshness chip in the header already carries it. The chip is what B3 requires;
// this is where the claim is actually being made. A metrics chart that stopped
// receiving points is the quietest failure in the tab — the line keeps its
// shape, keeps its colour, and simply stops having a right-hand edge that means
// "now". Nothing about the drawing itself would ever tell you.
// ═══════════════════════════════════════════════════════════════════════════
import { useId, useMemo, useState } from "react";
import { useSource } from "../../lib/AgentData.jsx";
import { PANEL } from "../../lib/freshness.js";
import { shortAge, usd, pct, signed, toMs, clockTime, dayLabel } from "../../lib/format.js";
import { Panel, Btn, Badge, Row, Stat, TONE } from "../primitives.jsx";
import { AnimatedNumber, SkeletonLine } from "@cc/ui";

const num = (n, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });

// Five columns, five formatters. The formatter travels WITH the series rather
// than being switched on at render, because the current value, the delta, the
// low/high labels and the tooltip all have to agree — "$4,200" against a delta
// of "+0.08" is two different measurements sharing one card.
const SERIES = [
  { key: "objective", label: "Objective", fmt: (n) => num(n, 2), note: "the one number the agent is optimising" },
  { key: "mrr_usd", label: "MRR", fmt: (n) => usd(n), note: "recurring revenue at the snapshot" },
  { key: "customers", label: "Customers", fmt: (n) => num(n, 0), note: "paying customers at the snapshot" },
  { key: "trials", label: "Trials", fmt: (n) => num(n, 0), note: "trials open at the snapshot" },
  { key: "conversion", label: "Conversion", fmt: (n) => pct(n, 1), note: "trial → paid, as a rate" },
];

const DAY_MS = 86_400_000;
const RANGES = [
  { key: "24h", label: "24h", ms: DAY_MS },
  { key: "7d", label: "7d", ms: 7 * DAY_MS },
  { key: "30d", label: "30d", ms: 30 * DAY_MS },
  { key: "all", label: "All", ms: null },
];

// The chart is drawn in a square user space and stretched to whatever width the
// phone gives it, so every number below is a percentage of the box, not a pixel.
const CHART_H = 72;
const PAD_Y = 9; // keeps the extremes off the clipping edge, top and bottom

export default function Metrics({ now }) {
  const src = useSource("metrics", now);
  const [seriesKey, setSeriesKey] = useState("objective");
  const [rangeKey, setRangeKey] = useState("7d");

  const s = SERIES.find((x) => x.key === seriesKey) || SERIES[0];
  const range = RANGES.find((x) => x.key === rangeKey) || RANGES[1];

  // The staleness window is read off the source spec, never typed here. The
  // window this panel is JUDGED by and the window it draws gaps against have to
  // be the same six hours, or the chart quietly disagrees with its own chip.
  const windowMin = src.spec?.maxAgeMin ?? 6 * 60;
  const windowMs = windowMin * 60_000;
  const windowLabel = windowMin % 60 === 0 ? `${windowMin / 60}h` : `${windowMin}m`;

  const gid = `sparkfill-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  const { points, undated } = useMemo(() => prepare(src.rows), [src.rows]);

  // Bucketed to the minute. `now` ticks every second for the approval
  // countdowns; rebuilding a two-hundred-point path sixty times a minute to
  // slide a boundary by one second is battery spent on a change nobody can see.
  const cutoff = range.ms === null ? -Infinity : Math.floor(now / 60_000) * 60_000 - range.ms;

  const inRange = useMemo(
    () => points.filter((p) => p.t >= cutoff).map((p) => ({ t: p.t, v: reading(p.row?.[s.key]) })),
    [points, cutoff, s.key]
  );

  // A gap of exactly one missed snapshot still draws through — the line would
  // otherwise shatter into dots on any cadence near the window. Twice the
  // window is the point where "late" has become "not being measured".
  const geo = useMemo(() => geometry(inRange, windowMs * 2), [inRange, windowMs]);

  const read = inRange.filter((p) => p.v !== null);
  const missing = inRange.length - read.length;
  const first = read[0] || null;
  const last = read[read.length - 1] || null;
  const delta = read.length > 1 ? last.v - first.v : null;

  // The newest snapshot in view exists but carries nothing for this series —
  // which means the big number above is older than the panel's own freshness
  // chip implies, and that discrepancy has to be said rather than smoothed.
  const tipIsLatestSnapshot = inRange.length === 0 || inRange[inRange.length - 1].v !== null;

  const dataAgeMs = src.state.dataAgeMs;
  const overdue = dataAgeMs !== null && dataAgeMs > windowMs;

  return (
    <Panel
      id="metrics"
      title="Metrics"
      state={src.state}
      onRetry={src.refresh}
      skeleton={<MetricsSkeleton />}
      emptyHeadline="Nothing has ever been measured"
      emptyDetail={`The snapshot table is reachable and genuinely holds no rows${
        src.state.fetchAgeMs !== null ? ` — checked ${shortAge(src.state.fetchAgeMs)} ago` : ""
      }. The objective function has never been recorded, so there is no series to draw and no way to say whether the agent is winning or losing. An empty metrics table is not a flat line at zero; it is the absence of a measurement.`}
      // Panel renders `right` in the error chrome too, so this count is gated on
      // the calm state. A figure from the last good read sitting in the header
      // during an outage borrows the header's authority for a stale number.
      right={src.state.state === PANEL.FRESH ? <Badge tone="accent">{src.rows.length} snapshots</Badge> : null}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {/* ─── which series ──────────────────────────────────────────────── */}
        <div>
          <Row gap={6} wrap>
            {SERIES.map((x) => (
              <Btn
                key={x.key}
                size="sm"
                tone={x.key === s.key ? "accent" : "ghost"}
                aria-pressed={x.key === s.key}
                onClick={() => setSeriesKey(x.key)}
              >{x.label}</Btn>
            ))}
          </Row>
          <div className="stattile-label" style={{ color: "var(--faint)", marginTop: 7, lineHeight: 1.5, whiteSpace: "normal" }}>{s.note}</div>
        </div>

        {/* ─── where it stands, and how far it has come ──────────────────── */}
        <Row gap={12} align="flex-start">
          <div style={{ flex: 1, minWidth: 0 }}>
            <Stat
              label={s.label}
              // AnimatedNumber coerces anything non-numeric to 0 and then
              // animates INTO it, so a missing reading must never reach it —
              // that is the calm zero with a motion curve on top.
              value={last ? <AnimatedNumber value={last.v} format={s.fmt} /> : "—"}
              sub={
                last
                  ? `${clockTime(last.t)} · ${dayLabel(last.t)}${tipIsLatestSnapshot ? "" : " — the newest snapshot has no reading"}`
                  : "nothing recorded in this range"
              }
              tone={last ? undefined : "stale"}
            />
          </div>
          <div style={{ flexShrink: 0, maxWidth: 148 }}>
            <Stat
              align="right"
              label={`Change · ${range.label}`}
              value={delta === null ? "—" : signed(delta, s.fmt)}
              // Every series here is one the agent is trying to increase, so
              // direction maps cleanly onto good and bad. Colour describes the
              // MEASURE, never the trustworthiness of the data — the triangle
              // and the amber chrome are B3's and keep meaning "don't believe
              // this screen". If a series is ever added where down is better,
              // this is the line that has to change.
              tone={delta === null || delta === 0 ? undefined : delta > 0 ? "fresh" : "error"}
              sub={first && delta !== null ? `from ${s.fmt(first.v)}` : "needs two readings"}
            />
          </div>
        </Row>

        {/* ─── the line, or the refusal to draw one ──────────────────────── */}
        {geo === null ? (
          <NoTrend
            headline={inRange.length === 0 ? `No snapshot in the last ${range.label}` : `No ${s.label.toLowerCase()} reading in this range`}
            detail={
              inRange.length === 0
                ? `${points.length} snapshot${points.length === 1 ? " is" : "s are"} loaded and the newest is ${
                    dataAgeMs === null ? "of unknown age" : `${shortAge(dataAgeMs)} old`
                  } — all of them fall outside this window. Widen the range to see them; the gap is in this view, not necessarily in the data.`
                : `${inRange.length} snapshot${inRange.length === 1 ? "" : "s"} landed in this window and not one of them recorded ${s.key}. That is a hole in what is being measured, and it is not the same as a value of zero — so nothing is drawn.`
            }
          />
        ) : (
          <div>
            <Spark geo={geo} gid={gid} />
            {/* 11.5px, not 10: Row takes no className, so the kit's .t-cap
                size is written out. 10 was under the floor. */}
            <Row gap={8} wrap style={{
              marginTop: 8, fontSize: 11.5, color: "var(--faint)",
              fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
            }}>
              <span>low {s.fmt(geo.lo)}</span>
              <span style={{ opacity: 0.45 }}>·</span>
              <span>high {s.fmt(geo.hi)}</span>
              <span style={{ marginLeft: "auto", flexShrink: 0 }}>
                {dayLabel(geo.t0)} → {dayLabel(geo.t1)}
              </span>
            </Row>

            {/* Everything the drawing cannot say for itself. Each of these lines
                exists because its absence would leave a shape being read as a
                measurement it is not. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 7 }}>
              {read.length === 1 && (
                <Caveat tone="stale">
                  One reading in this range, drawn as a dot. A single point is a value, not a trend — there is nothing here to
                  say which way it is going.
                </Caveat>
              )}
              {geo.flat && read.length > 1 && (
                <Caveat>
                  Unchanged across {read.length} readings, so the line sits centred by convention — mid-height here means "flat",
                  not "mid-range".
                </Caveat>
              )}
              {geo.breaks > 0 && (
                <Caveat tone="stale">
                  The line breaks {geo.breaks} time{geo.breaks === 1 ? "" : "s"} — a missing reading or a silence longer than{" "}
                  {windowLabel === "6h" ? "12h" : `2× ${windowLabel}`}. Nothing was measured across a break, so nothing is drawn
                  across it.
                </Caveat>
              )}
              {missing > 0 && (
                <Caveat>
                  {missing} of {inRange.length} snapshots in this range carry no {s.label.toLowerCase()} value. They were taken;
                  this measure was not recorded.
                </Caveat>
              )}
              {undated > 0 && (
                <Caveat tone="stale">
                  {undated} snapshot{undated === 1 ? " has" : "s have"} no readable capture time and cannot be placed on a time
                  axis — counted here rather than dropped in silence.
                </Caveat>
              )}
            </div>
          </div>
        )}

        {/* ─── which window ──────────────────────────────────────────────── */}
        <Row gap={6} wrap>
          {RANGES.map((r) => (
            <Btn
              key={r.key}
              size="sm"
              tone={r.key === range.key ? "accent" : "ghost"}
              aria-pressed={r.key === range.key}
              onClick={() => setRangeKey(r.key)}
            >{r.label}</Btn>
          ))}
          <span className="t-cap" style={{
            marginLeft: "auto", alignSelf: "center", color: "var(--faint)",
            fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
          }}>
            {read.length} of {inRange.length} plotted
          </span>
        </Row>

        {/* ─── the age, in the body, beside the thing being believed ─────── */}
        <div className="t-cap" style={{
          borderTop: "1px solid var(--border)", paddingTop: 9,
          lineHeight: 1.55, fontVariantNumeric: "tabular-nums",
          color: overdue ? TONE.stale.fg : "var(--muted)",
          fontWeight: overdue ? 700 : 400,
        }}>
          {dataAgeMs === null
            ? `No snapshot on file carries a readable capture time, so the age of this chart cannot be established — and an unverifiable age is not a fresh one.`
            : overdue
              ? `Newest snapshot ${shortAge(dataAgeMs)} old — past the ${windowLabel} window. The objective function has stopped being measured; the line above ends where the measuring stopped, not at now.`
              : `Newest snapshot ${shortAge(dataAgeMs)} ago, inside the ${windowLabel} window. The right-hand edge of the line is current.`}
        </div>
      </div>
    </Panel>
  );
}

// ─── the sparkline ───────────────────────────────────────────────────────────
/**
 * Inline SVG, no library. viewBox + preserveAspectRatio="none" is what makes it
 * fluid on a 390px screen, and it has two consequences worth naming:
 *
 *   - The user space is stretched horizontally, so strokes would fatten with the
 *     viewport and dashes would smear. `vectorEffect="non-scaling-stroke"` pins
 *     both to device pixels.
 *   - A <circle> in a stretched box is an ellipse. The point markers are
 *     therefore HTML, positioned in percentages over the same box, which keeps
 *     them round at every width without measuring anything.
 *
 * Paint goes through `style`, not through presentation attributes: var() is
 * resolved by the CSS cascade, and stroke="var(--accent)" as an attribute is
 * just an unparseable string.
 */
function Spark({ geo, gid }) {
  return (
    <div style={{ position: "relative", height: CHART_H }}>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        width="100%"
        height={CHART_H}
        style={{ display: "block" }}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--accent)", stopOpacity: 0.26 }} />
            <stop offset="100%" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
          </linearGradient>
        </defs>

        {/* The first reading in view, as a dashed rule. The delta above is a
            number you have to trust; this is the same claim as a shape, so the
            two can be checked against each other at a glance. */}
        <line
          x1="0" y1={geo.refY} x2="100" y2={geo.refY}
          strokeDasharray="2 4" vectorEffect="non-scaling-stroke"
          style={{ stroke: "var(--border-strong, var(--border))", strokeWidth: 1 }}
        />

        {geo.lines.map((seg, i) => (
          <g key={`seg${i}`}>
            <path d={areaPath(seg)} style={{ fill: `url(#${gid})`, stroke: "none" }} />
            <path
              d={linePath(seg)}
              vectorEffect="non-scaling-stroke"
              style={{ fill: "none", stroke: "var(--accent)", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }}
            />
          </g>
        ))}
      </svg>

      {geo.dots.map((d) => (
        <Dot key={`dot${d.t}`} x={d.x} y={d.y} />
      ))}
      <Dot x={geo.tip.x} y={geo.tip.y} tip />
    </div>
  );
}

/** A marker in HTML over the SVG — round at any width, unlike a stretched circle. */
function Dot({ x, y, tip }) {
  const size = tip ? 8 : 6;
  return (
    <span
      style={{
        position: "absolute", left: `${x}%`, top: `${y}%`,
        width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2,
        borderRadius: "50%", background: "var(--accent)",
        // A ring in the panel's own surface colour, so a marker sitting on the
        // line is still legible as a distinct point rather than a bulge.
        boxShadow: tip ? "0 0 0 2px var(--surface)" : "none",
        opacity: tip ? 1 : 0.75,
        pointerEvents: "none",
      }}
    />
  );
}

// ─── the parts that are not a chart ──────────────────────────────────────────
/**
 * Where the line would be, when there is not enough to draw one. Deliberately
 * NOT an EmptyBlock: the dashed frame is this tab's phrase for "the database is
 * reachable and truly holds nothing", and the database is holding rows — it just
 * holds none that this view can honestly connect.
 */
function NoTrend({ headline, detail }) {
  return (
    <div style={{
      minHeight: CHART_H, display: "flex", flexDirection: "column", justifyContent: "center",
      padding: "13px 13px", borderRadius: 12,
      border: `1px solid ${TONE.stale.line}`, borderLeft: `3px solid ${TONE.stale.fg}`, background: TONE.stale.bg,
    }}>
      <div className="t-foot" style={{ fontWeight: 800, color: TONE.stale.fg }}>{headline}</div>
      <div className="t-cap" style={{ color: "var(--muted)", lineHeight: 1.55, marginTop: 4 }}>{detail}</div>
    </div>
  );
}

function Caveat({ tone, children }) {
  return (
    <div className="t-cap" style={{
      lineHeight: 1.5,
      color: tone ? (TONE[tone] || TONE.empty).fg : "var(--muted)",
      fontVariantNumeric: "tabular-nums",
    }}>{children}</div>
  );
}

// Shaped like a picker over a chart, and containing no digits at all — a
// skeleton with a placeholder number in it is the calm zero wearing a shimmer.
function MetricsSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      <Row gap={6} wrap>
        {["58px", "44px", "72px", "48px"].map((w, i) => <SkeletonLine key={i} width={w} height="34px" style={{ borderRadius: 10 }} />)}
      </Row>
      <SkeletonLine width="46%" height="20px" />
      <SkeletonLine width="100%" height={`${CHART_H}px`} style={{ borderRadius: 12 }} />
      <SkeletonLine width="62%" height="10px" />
    </div>
  );
}

// ─── the maths ───────────────────────────────────────────────────────────────

/**
 * One cell → one reading, or nothing.
 *
 * PostgREST hands `numeric` back as a JSON number on some builds and a quoted
 * string on others, so every value goes through Number(). Number("") is 0 and
 * Number(null) is 0 — the exact fabricated collapse this panel refuses to draw —
 * so those are caught before they can be coerced into a datapoint.
 */
function reading(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Rows → time-ordered points, plus a count of what could not be placed.
 *
 * tables.js owns the ORDER BY and is free to change it, so the chart sorts for
 * itself instead of inheriting an assumption it has no way to check — a
 * silently reversed series still draws a perfectly plausible line.
 */
function prepare(rows) {
  const points = [];
  let undated = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const t = toMs(r?.captured_at);
    if (t === null) { undated += 1; continue; }
    points.push({ t, row: r });
  }
  points.sort((a, b) => a.t - b.t);
  return { points, undated };
}

/**
 * Points → everything the SVG needs, in 0..100 user space on both axes.
 *
 * The degenerate cases are the whole point of the function:
 *   no readings   → null, and the caller draws prose instead of a line
 *   one reading   → x and y both centre; it renders as a dot, never a segment
 *   all equal     → the range is zero, so the line is centred by fiat rather
 *                   than by dividing by it
 *   nulls / gaps  → the series is cut into segments; a one-point segment
 *                   becomes a dot, so an isolated reading between two silences
 *                   is still visible without being connected to anything
 */
function geometry(points, gapMs) {
  const read = points.filter((p) => p.v !== null);
  if (read.length === 0) return null;

  // The x axis spans the requested window's actual contents, timestamp to
  // timestamp. Index spacing would render a three-day silence and a one-hour
  // step as the same width of line, which is the lie this is avoiding.
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = t1 - t0;

  let lo = Infinity;
  let hi = -Infinity;
  for (const p of read) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
  const extent = hi - lo;
  const flat = !(extent > 0);

  const X = (t) => (span > 0 ? ((t - t0) / span) * 100 : 50);
  const Y = (v) => (flat ? 50 : PAD_Y + (1 - (v - lo) / extent) * (100 - 2 * PAD_Y));

  const segs = [];
  let cur = null;
  let prevT = null;
  for (const p of points) {
    if (p.v === null) { cur = null; continue; }
    const silence = prevT !== null && p.t - prevT > gapMs;
    if (cur === null || silence) { cur = []; segs.push(cur); }
    cur.push({ x: X(p.t), y: Y(p.v), t: p.t, v: p.v });
    prevT = p.t;
  }

  const latest = read[read.length - 1];
  return {
    lines: segs.filter((sg) => sg.length > 1),
    dots: segs.filter((sg) => sg.length === 1).map((sg) => sg[0]),
    tip: { x: X(latest.t), y: Y(latest.v), t: latest.t, v: latest.v },
    refY: Y(read[0].v),
    lo, hi, flat,
    breaks: Math.max(0, segs.length - 1),
    t0, t1,
  };
}

const linePath = (seg) => seg.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");

// Closed down to the floor of the box rather than to the value zero: the fill is
// a reading aid for the line's shape, and anchoring it to a zero that may sit
// far off-scale would turn a 2% wobble into a filled slab.
const areaPath = (seg) =>
  `${linePath(seg)} L${seg[seg.length - 1].x.toFixed(2)} 100 L${seg[0].x.toFixed(2)} 100 Z`;
