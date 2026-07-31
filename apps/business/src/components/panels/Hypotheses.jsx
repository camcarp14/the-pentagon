// ═══════════════════════════════════════════════════════════════════════════
// Panel 5 — the hypothesis queue. What it wants to try next, in the order it
// would try it.
//
// This panel opens collapsed, which is a deliberate risk. It is the least
// urgent thing on the page right up until a hypothesis is BLOCKED — at which
// point it is a stuck agent hiding behind a chevron. Three arrangements answer
// that, and they are why this file is longer than a list:
//
//   · blocked rows are lifted OUT of the scroll region and rendered above it,
//     so they cannot be scrolled past by a thumb reading the top of a ranking;
//   · blocked_reason is always on screen, never behind the tap that opens the
//     rationale — the reason IS the actionable content of a blocked row, and
//     "blocked" without it is just a colour;
//   · the collapsed summary carries the blocked count in the alarm colour, so
//     the panel does not have to be opened to learn the bad news.
//
// Rank comes from the UNFILTERED list. Filtering to "blocked" and seeing a
// tidy #1 #2 #3 would be a renumbering that reads as a ranking; a lone #7 is
// both true and the more useful fact — it says how far down the agent's own
// order this thing sits.
//
// One number is deliberately missing: there is no meter beside score. score is
// unbounded in the schema (numeric(6,3), no ceiling anywhere), and a bar with
// no denominator invents one — the same argument the budget panel makes about
// an uncapped category, and it holds here for the same reason.
// ═══════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useSource } from "../../lib/AgentData.jsx";
import { PANEL } from "../../lib/freshness.js";
import { shortAge, ageOf } from "../../lib/format.js";
import { Panel, Btn, Badge, Row, ScrollList, TONE } from "../primitives.jsx";
import { SkeletonLine } from "@cc/ui";

// Colour is spent only where status changes what you would do: `blocked` wants
// a human, `running` is money in flight. queued/done/rejected are waiting or
// settled and stay neutral — a palette where every status is coloured is a
// palette where no status is a signal.
const STATUS = {
  queued: { label: "queued", tone: "empty" },
  running: { label: "running", tone: "accent" },
  blocked: { label: "blocked", tone: "error" },
  done: { label: "done", tone: "fresh" },
  rejected: { label: "rejected", tone: "empty" },
};

// A status outside the CHECK constraint means the row and this file disagree
// about the schema. Amber, because the honest reading of it is "don't trust
// what this row says about itself", not "nothing to see here".
const statusMeta = (s) => STATUS[s] || { label: String(s || "unknown"), tone: "stale" };

const FILTERS = [
  { key: "all", label: "All" },
  { key: "queued", label: "Queued" },
  { key: "running", label: "Running" },
  { key: "blocked", label: "Blocked" },
  { key: "done", label: "Done" },
  { key: "rejected", label: "Rejected" },
];

export default function Hypotheses({ now }) {
  const src = useSource("hypotheses", now);
  const [filter, setFilter] = useState("all");
  const [openIds, setOpenIds] = useState(() => new Set());

  const rows = src.rows;

  const counts = useMemo(() => {
    const c = { all: rows.length, queued: 0, running: 0, blocked: 0, done: 0, rejected: 0 };
    // Keyed off STATUS rather than the raw value so a row whose status is
    // literally "all" can never inflate the total it is counted in.
    for (const r of rows) if (STATUS[r?.status]) c[r.status] += 1;
    return c;
  }, [rows]);

  // The order is the query's (tables.js: score desc), not this component's.
  // Re-sorting here would let the screen quietly disagree with the index the
  // agent itself ranks on, and the disagreement would be invisible.
  const ranked = useMemo(() => rows.map((row, i) => ({ row, rank: i + 1, key: row?.id ?? `r${i}` })), [rows]);

  const visible = filter === "all" ? ranked : ranked.filter((r) => r.row?.status === filter);
  const blocked = visible.filter((r) => r.row?.status === "blocked");
  const rest = visible.filter((r) => r.row?.status !== "blocked");

  const toggle = (key) => setOpenIds((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // Panel renders `summary` OUTSIDE its state switch — it is the one place in
  // this component where a number could escape B3's chrome, so it is built per
  // state rather than from `counts` alone. A collapsed "0 queued · 0 running"
  // while the first read is still in flight is precisely the calm zero this tab
  // exists to prevent. ERROR and STALE force the panel open, so they have no
  // collapsed line to fill.
  const summary = (() => {
    switch (src.state.state) {
      case PANEL.LOADING: return "Checking the queue…";
      case PANEL.EMPTY: return "Nothing queued — the table is reachable and holds no rows.";
      case PANEL.FRESH: return <CountLine counts={counts} />;
      default: return null;
    }
  })();

  return (
    <Panel
      id="hypotheses"
      title="Hypothesis queue"
      state={src.state}
      onRetry={src.refresh}
      skeleton={<QueueSkeleton />}
      collapsible
      defaultOpen={false}
      summary={summary}
      emptyHeadline="Nothing queued to try"
      emptyDetail={`The hypothesis table is reachable and genuinely holds no rows${
        src.state.fetchAgeMs !== null ? ` — checked ${shortAge(src.state.fetchAgeMs)} ago` : ""
      }. An agent with an empty queue has nothing it intends to try next, which is a state worth noticing rather than a quiet one.`}
      // Gated on the calm state on purpose: Panel draws `right` in the error
      // chrome too, and a count from the last good read sitting in the header
      // during an outage is a stale number wearing the header's authority.
      right={
        src.state.state === PANEL.FRESH
          ? counts.blocked > 0
            ? <Badge tone="error">{counts.blocked} blocked</Badge>
            : counts.queued > 0
              ? <Badge tone="accent">{counts.queued} queued</Badge>
              : null
          : null
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {/* ─── filters ──────────────────────────────────────────────────────
            All six chips render always, including the ones counting zero. A
            filter that vanishes at zero makes "none blocked" and "blocked is
            not a thing here" the same pixels, and the first of those is the
            single most reassuring fact on this panel. */}
        <Row gap={6} wrap>
          {FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <Btn
                key={f.key}
                size="sm"
                tone={active ? "accent" : "ghost"}
                aria-pressed={active}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                {/* The red lives on the count, not the button. Every coloured
                    control in this tab is a verb (veto, halt, retry) and this
                    one is not — so the alarm goes on the fact instead. */}
                <span style={{
                  fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
                  fontSize: 11, fontWeight: 800,
                  color: f.key === "blocked" && counts.blocked > 0 ? TONE.error.fg : active ? "inherit" : "var(--faint)",
                }}>{counts[f.key]}</span>
              </Btn>
            );
          })}
        </Row>

        {/* ─── blocked, above the scroll ────────────────────────────────────
            Ranked by score means a blocked hypothesis with a weak score sinks
            to the bottom of a hundred rows — sorted out of sight by the very
            ordering that makes the list useful. These are hoisted, and they
            keep their real rank so the hoist doesn't rewrite the ranking. */}
        {blocked.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              <SectionLabel tone="error">Blocked · {blocked.length}</SectionLabel>
              <div className="t-cap" style={{ color: "var(--muted)", lineHeight: 1.5, marginTop: 3 }}>
                {blocked.length === 1 ? "This one is not" : "These are not"} waiting {blocked.length === 1 ? "its" : "their"} turn
                — {blocked.length === 1 ? "it" : "they"} cannot proceed until something changes.
              </div>
            </div>
            <Group cap={blocked.length > 3} maxHeight={240}>
              {blocked.map((r) => (
                <HypothesisRow
                  key={r.key} rank={r.rank} row={r.row} now={now}
                  open={openIds.has(r.key)} onToggle={() => toggle(r.key)}
                />
              ))}
            </Group>
          </div>
        )}

        {/* ─── the ranked list ──────────────────────────────────────────── */}
        {rest.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {blocked.length > 0 && <SectionLabel>Ranked queue · {rest.length}</SectionLabel>}
            <ScrollList maxHeight={420}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {rest.map((r) => (
                  <HypothesisRow
                    key={r.key} rank={r.rank} row={r.row} now={now}
                    open={openIds.has(r.key)} onToggle={() => toggle(r.key)}
                  />
                ))}
              </div>
            </ScrollList>
          </div>
        )}

        {/* ─── the filter is empty, and the source is not ───────────────────
            Deliberately NOT an EmptyBlock. The dashed, centred, unfilled frame
            is this tab's vocabulary for "we reached the database and it truly
            holds nothing", and borrowing it for a chip that matched nothing
            would make a false claim about the database in the one component
            whose whole job is not making that claim. Solid border, filled,
            left-aligned, and it names the row count it is hiding. */}
        {visible.length === 0 && (
          <div style={{
            borderRadius: 11, border: "1px solid var(--border)",
            background: "var(--subtle)", padding: "12px 12px",
          }}>
            <div className="t-foot" style={{ fontWeight: 700, color: "var(--ink)" }}>
              No {filter} hypotheses
            </div>
            <div className="t-cap" style={{ color: "var(--muted)", lineHeight: 1.55, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
              The queue holds {counts.all} row{counts.all === 1 ? "" : "s"} — none of them with this status. The filter is
              empty, not the source; the database answered {src.state.fetchAgeMs === null ? "this session" : `${shortAge(src.state.fetchAgeMs)} ago`}.
            </div>
            <Btn size="sm" tone="ghost" onClick={() => setFilter("all")} style={{ marginTop: 10, width: "100%" }}>
              Show all {counts.all}
            </Btn>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ─── one hypothesis ──────────────────────────────────────────────────────────
function HypothesisRow({ rank, row, now, open, onToggle }) {
  const meta = statusMeta(row?.status);
  const isBlocked = row?.status === "blocked";

  const rationale = typeof row?.rationale === "string" ? row.rationale.trim() : "";
  const expandable = rationale.length > 0;
  const lift = typeof row?.expected_lift === "string" ? row.expected_lift.trim() : "";
  const reason = typeof row?.blocked_reason === "string" ? row.blocked_reason.trim() : "";

  const score = Number(row?.score);
  const tier = Number(row?.tier);
  const effort = Number(row?.effort_hours);
  const updatedAge = ageOf(row?.updated_at, now);
  const createdAge = ageOf(row?.created_at, now);

  const press = expandable
    ? {
        className: "biz-press",
        role: "button",
        tabIndex: 0,
        "aria-expanded": open,
        onClick: onToggle,
        onKeyDown: (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
        },
      }
    : {};

  return (
    <div
      {...press}
      style={{
        // The blocked treatment is the panel's own alarm, borrowed from
        // AlarmBlock's shape (solid rule on the leading edge, tinted fill) so
        // it reads as the same kind of news one level down.
        padding: "10px 11px", borderRadius: 11, minHeight: 44,
        background: isBlocked ? TONE.error.bg : "var(--subtle)",
        border: `1px solid ${isBlocked ? TONE.error.line : "var(--border)"}`,
        ...(isBlocked ? { borderLeft: `3px solid ${TONE.error.fg}` } : null),
        cursor: expandable ? "pointer" : "default",
        transition: "background var(--dur-2) var(--ease-out)",
      }}
    >
      <Row gap={9} align="flex-start">
        <span style={{
          flexShrink: 0, width: 24, textAlign: "right", paddingTop: 1,
          fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
          fontSize: 11.5, fontWeight: 800, color: "var(--faint)",
        }}>{rank}</span>

        <span
          title={row?.title || undefined}
          className="t-foot"
          style={{
            flex: 1, minWidth: 0, fontWeight: 700, lineHeight: 1.4,
            color: "var(--ink)", overflow: "hidden",
            // Two lines collapsed, all of it once open — a title truncated
            // forever is a hypothesis you can't identify.
            display: "-webkit-box", WebkitBoxOrient: "vertical",
            WebkitLineClamp: open ? undefined : 2,
          }}
        >{row?.title || "Untitled hypothesis"}</span>

        <span style={{ flexShrink: 0, textAlign: "right" }}>
          <span style={{
            display: "block", fontSize: 14, fontWeight: 800, lineHeight: 1.1,
            fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
            color: isBlocked ? TONE.error.fg : "var(--ink)",
          }}>{Number.isFinite(score) ? score.toFixed(2) : "—"}</span>
          {/* .stattile-label is the kit's 10.5px caption-under-a-number. This
              was 8.5px — the smallest text in the tab — and the uppercase went
              with it, since uppercase belongs only to .t-label. */}
          <span className="stattile-label" style={{
            display: "block", color: "var(--faint)", fontFamily: "var(--font-mono)", marginTop: 2,
          }}>score</span>
        </span>
      </Row>

      <Row gap={6} wrap style={{ marginTop: 8 }}>
        <Badge tone={meta.tone}>{meta.label}</Badge>

        {/* Tier is uncoloured on purpose. The schema constrains it to 1–3 and
            says nothing about which end is the ambitious one, so a colour ramp
            here would assert an ordering the data does not carry. */}
        {Number.isFinite(tier) && <Badge title="The band this hypothesis was filed under (1–3).">tier {tier}</Badge>}

        {/* expected_lift is free text, so it is displayed and never divided by
            effort — a lift-per-hour figure would be arithmetic on a string. */}
        {lift && (
          <span title={lift} style={{
            fontSize: 10.5, color: "var(--muted)", fontVariantNumeric: "tabular-nums",
            maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>lift {lift}</span>
        )}

        {Number.isFinite(effort) && effort > 0 && (
          <span style={{ fontSize: 10.5, color: "var(--faint)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            {+effort.toFixed(1)}h
          </span>
        )}

        {/* A row that says "running" and has not been touched in two days is
            the same news as a stale panel, one row down. The age is shown
            without a verdict attached — the threshold for "too long in flight"
            belongs to the agent, not to this screen. */}
        {row?.status === "running" && updatedAge !== null && (
          <span style={{ fontSize: 10.5, color: "var(--muted)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            touched {shortAge(updatedAge)} ago
          </span>
        )}

        {expandable && (
          <span style={{
            marginLeft: "auto", display: "inline-flex", color: "var(--faint)", flexShrink: 0,
            transform: `rotate(${open ? 90 : 0}deg)`, transition: "transform var(--dur-2) var(--ease-out)",
          }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}
      </Row>

      {/* Never behind the tap. Everything else on a blocked row describes a
          plan; this is the only part that describes why the plan stopped. */}
      {isBlocked && (
        <div style={{
          marginTop: 8, padding: "8px 9px", borderRadius: 9,
          background: "color-mix(in srgb, var(--bg) 45%, transparent)",
          border: `1px solid ${TONE.error.line}`,
        }}>
          <div className="t-label" style={{ color: TONE.error.fg, fontFamily: "var(--font-mono)" }}>Why it is stuck</div>
          <div className="t-cap" style={{ color: reason ? "var(--muted)" : TONE.error.fg, lineHeight: 1.55, marginTop: 3 }}>
            {reason || "No reason recorded — the row is blocked and does not say why, which is the least actionable state it can be in."}
          </div>
        </div>
      )}

      {/* The rationale is the argument for the rank. A score with no argument
          behind it is an unfalsifiable number, and this queue is nothing but
          scores until you can read one of them. */}
      {expandable && open && (
        <div style={{ marginTop: 9, paddingTop: 9, borderTop: `1px solid ${isBlocked ? TONE.error.line : "var(--border)"}` }}>
          <SectionLabel>Why it ranks here</SectionLabel>
          <div className="t-cap" style={{ color: "var(--muted)", lineHeight: 1.6, marginTop: 4 }}>{rationale}</div>
          {lift && (
            <div className="t-cap" style={{ color: "var(--ink)", lineHeight: 1.55, marginTop: 7 }}>
              <span style={{ color: "var(--faint)" }}>Expected lift · </span>{lift}
            </div>
          )}
          {/* 11.5px, not 10: Row takes no className, so the kit's .t-cap size
              is written out. 10 was under the floor. */}
          <Row gap={7} wrap style={{
            marginTop: 8, fontSize: 11.5, color: "var(--faint)",
            fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
          }}>
            <span>filed {createdAge === null ? "at an unknown time" : `${shortAge(createdAge)} ago`}</span>
            <span style={{ opacity: 0.45 }}>·</span>
            <span>updated {updatedAge === null ? "never" : `${shortAge(updatedAge)} ago`}</span>
          </Row>
        </div>
      )}
    </div>
  );
}

// ─── bits ────────────────────────────────────────────────────────────────────

/** Hoisted blocked rows still can't be allowed to push the ranking off screen. */
function Group({ cap, maxHeight, children }) {
  const stack = <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>;
  return cap ? <ScrollList maxHeight={maxHeight}>{stack}</ScrollList> : stack;
}

function SectionLabel({ children, tone }) {
  return (
    // .t-label IS this label — 12px, 600, tracked, uppercase. It was hand-set
    // at 9.5px, under the 10.5px floor, and uppercase is only allowed on
    // .t-label anyway.
    <div className="t-label" style={{
      color: tone ? (TONE[tone] || TONE.empty).fg : "var(--faint)", fontFamily: "var(--font-mono)",
    }}>{children}</div>
  );
}

/** The collapsed line. Blocked leads, because it is the one that wants a tap. */
function CountLine({ counts }) {
  const parts = [];
  if (counts.blocked > 0) parts.push({ k: "blocked", text: `${counts.blocked} blocked`, fg: TONE.error.fg });
  parts.push({ k: "queued", text: `${counts.queued} queued` });
  parts.push({ k: "running", text: `${counts.running} running`, fg: counts.running > 0 ? TONE.accent.fg : undefined });
  if (counts.done > 0) parts.push({ k: "done", text: `${counts.done} done` });
  if (counts.rejected > 0) parts.push({ k: "rejected", text: `${counts.rejected} rejected` });

  return (
    <Row gap={6} wrap style={{ fontVariantNumeric: "tabular-nums" }}>
      {parts.map((p, i) => (
        <span key={p.k} style={{ display: "inline-flex", gap: 6 }}>
          {i > 0 && <span style={{ opacity: 0.4 }}>·</span>}
          <span style={{ color: p.fg || "inherit", fontWeight: p.fg ? 700 : 400 }}>{p.text}</span>
        </span>
      ))}
    </Row>
  );
}

// ─── loading ─────────────────────────────────────────────────────────────────
// Shaped like a filter row over a ranking, and containing no digits at all: a
// skeleton with a placeholder count in it is the calm zero wearing a shimmer.
function QueueSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      <Row gap={6} wrap>
        {["46px", "68px", "72px", "70px"].map((w, i) => <SkeletonLine key={i} width={w} height="26px" />)}
      </Row>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{
          borderRadius: 11, border: "1px solid var(--border)", padding: "10px 11px",
          display: "flex", flexDirection: "column", gap: 8, opacity: 1 - i * 0.22,
        }}>
          <SkeletonLine width="84%" height="13px" />
          <SkeletonLine width="44%" height="10px" />
        </div>
      ))}
    </div>
  );
}
