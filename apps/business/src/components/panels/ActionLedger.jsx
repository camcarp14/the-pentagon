// ═══════════════════════════════════════════════════════════════════════════
// Panel 6 — the action ledger. The only feed on this tab that moves while you
// are looking at it (realtime, see AgentData.jsx), and the only one whose
// SILENCE is the headline. 45 minutes is the strictest window in the tab
// because a ticking agent writes here every tick — so an empty ledger and a
// stale ledger both mean "it stopped", never "it had a quiet afternoon". That
// judgement is Panel's; nothing below re-decides it.
//
// Filters are the hazard this panel had to be designed around, and they are a
// new one for this tab: a filter is a way to make a live feed look dead. Pick
// outcome=failure on a perfectly healthy agent and you get an empty list under
// a green freshness chip, which reads as "nothing is wrong" when it actually
// means "you asked a question that has no recent answer". Three things keep
// that honest:
//
//   1. The count line is ALWAYS "n of N", N unfiltered — so the total keeps
//      climbing as rows stream in even when the filtered list sits still. A
//      frozen list beside a moving total is visibly a filter, not an outage.
//   2. With a filter on, the age of the newest MATCHING row is printed
//      separately. The chip in the header measures the whole ledger and would
//      otherwise lend its green to rows that are hours old.
//   3. Filter-empty and source-empty get different words and different chrome.
//      Panel owns source-empty and alarms on it; the filter's own emptiness is
//      calm, names the filter, and hands back the reset.
//
// Failures are what the visit is for, so error text is inline and never behind
// a tap — and a failure with NO error recorded says so out loud, because a
// blank where the reason goes reads as "no problem".
// ═══════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { SkeletonLine } from "@cc/ui";
import { useSource } from "../../lib/AgentData.jsx";
import { OUTCOMES, TICK_TYPES } from "../../lib/tables.js";
import { PANEL } from "../../lib/freshness.js";
import { clockTime, dayLabel, shortAge, toMs, usd } from "../../lib/format.js";
import { Panel, Btn, Badge, EmptyBlock, Row, ScrollList, TONE } from "../primitives.jsx";

const ALL = "all";
const DAY_MS = 86_400_000;

// Colour in this feed is spent on OUTCOME and nothing else. A second palette on
// tick_type would give every row a hue and leave the eye no way to find the
// four red ones in two hundred.
const OUTCOME_TONE = {
  success: "fresh",
  failure: "error",
  blocked: "stale",
  skipped: "empty",
  dry_run: "empty",
};

// Only `dry_run` needs de-snake-casing; the rest read fine as stored, and
// renaming them would break the match between chip and badge.
const label = (v) => (v === "dry_run" ? "dry run" : v);

export default function ActionLedger({ now }) {
  const src = useSource("actions", now);
  const [tick, setTick] = useState(ALL);
  const [outcome, setOutcome] = useState(ALL);

  const f = useMemo(() => facets(src.rows, tick, outcome), [src.rows, tick, outcome]);
  const filtered = tick !== ALL || outcome !== ALL;
  const clear = () => { setTick(ALL); setOutcome(ALL); };

  // The window belongs to tables.js, not to this file — read it back off the
  // resolved state so the "your filter is older than the window" line can never
  // disagree with the alarm Panel would raise on the same age.
  const maxAgeMs = Math.max(0, src.state.maxAgeMin || 0) * 60_000;
  const matchAgeMs = f.newestMatchMs === null ? null : Math.max(0, now - f.newestMatchMs);
  const matchStale = filtered && f.matched.length > 0 && (matchAgeMs === null || matchAgeMs > maxAgeMs);

  const groups = useMemo(() => groupByDay(f.matched), [f.matched]);

  return (
    <Panel
      id="actions"
      title="Action ledger"
      state={src.state}
      onRetry={src.refresh}
      skeleton={<LedgerSkeleton />}
      emptyHeadline="The agent has written nothing"
      emptyDetail={`The ledger is reachable and holds no rows at all${
        src.state.fetchAgeMs !== null ? ` — checked ${shortAge(src.state.fetchAgeMs)} ago` : ""
      }. Every tick appends here, so zero rows is not a quiet period: either nothing has ever run, or the table was emptied under a running agent.`}
      // Panel renders `right` in the error and stale chrome too, where the rows
      // behind this count are the ones already labelled as old. A red badge
      // there would be a stale number borrowing the header's authority, so it
      // is gated to the calm state — the alarm is already saying more than it.
      right={
        src.state.state === PANEL.FRESH && f.failures > 0
          ? <Badge tone="error">{f.failures} failed</Badge>
          : null
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {/* ─── filters ──────────────────────────────────────────────────────
            Counts are FACETED: each row of chips counts against the other
            filter, not against the whole ledger. Without that, "failure 6"
            while tick=execute is on promises six rows and delivers one, and
            you learn to distrust the numbers on the buttons. */}
        <FilterRow
          caption="Tick type"
          values={f.tickValues}
          counts={f.tickCounts}
          total={f.tickTotal}
          active={tick}
          onPick={setTick}
          toneFor={() => "accent"}
        />
        <FilterRow
          caption="Outcome"
          values={f.outcomeValues}
          counts={f.outcomeCounts}
          total={f.outcomeTotal}
          active={outcome}
          onPick={setOutcome}
          // The selected chip wears its own outcome's colour, so the filter you
          // are inside is legible from the same glance that reads the rows.
          toneFor={(v) => (v === "failure" ? "danger" : v === "success" ? "good" : "accent")}
        />

        {/* ─── the count line ───────────────────────────────────────────────
            "of N" is the live half. Rows arrive over the socket while this is
            on screen, so N moves even when the filtered list cannot — which is
            what tells you a still list is a filter and not a dead agent. The
            failure count is printed at zero as well, because a figure that
            only appears when it is non-zero teaches you its absence means
            nothing, when it should mean none. */}
        <Row gap={6} wrap style={{
          fontSize: 10.5, color: "var(--faint)", fontFamily: "var(--font-mono)",
          fontVariantNumeric: "tabular-nums", lineHeight: 1.5,
        }}>
          <span style={{ color: "var(--muted)", fontWeight: 700 }}>
            {f.matched.length} of {src.rows.length} shown
          </span>
          <Dot />
          <span style={{ color: f.failures > 0 ? TONE.error.fg : "var(--faint)", fontWeight: f.failures > 0 ? 700 : 500 }}>
            {f.failures} failed
          </span>
          {filtered && (
            <>
              <Dot />
              <span>newest match {matchAgeMs === null ? "at an unknown time" : `${shortAge(matchAgeMs)} ago`}</span>
            </>
          )}
          {src.rows.length >= (src.spec?.limit || Infinity) && (
            <>
              <Dot />
              <span title="The query stops at this many rows.">newest {src.spec.limit} only</span>
            </>
          )}
        </Row>

        {/* The filter is older than the panel's own window while the panel is
            calm — the exact seam a green chip papers over. Coloured strip, no
            warning triangle: the triangle is B3's and has to keep meaning
            "don't believe this screen". Here the screen is telling the truth;
            the question is just stale. */}
        {matchStale && (
          <div style={{
            borderRadius: 10, padding: "9px 11px",
            background: TONE.stale.bg, border: `1px solid ${TONE.stale.line}`, borderLeft: `3px solid ${TONE.stale.fg}`,
          }}>
            <div style={{ fontSize: 11.5, fontWeight: 800, color: TONE.stale.fg, fontFamily: "var(--font-display)", fontVariantNumeric: "tabular-nums" }}>
              Nothing matching this filter for {matchAgeMs === null ? "an unknown stretch" : shortAge(matchAgeMs)}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.55, marginTop: 3 }}>
              Longer than the {src.state.maxAgeMin}-minute window. The ledger itself is live — the chip above measures every row, not these.
            </div>
          </div>
        )}

        {/* ─── the feed ─────────────────────────────────────────────────────
            Filter-empty is NOT the empty state. Panel's empty treatment means
            "the database is reachable and really has nothing", and it alarms,
            because for this table that is a dead agent. This one means "you
            asked for something that isn't in the last 200 rows" — calm, dashed,
            and it names both the filter and what is actually there. */}
        {f.matched.length === 0 ? (
          <div>
            <EmptyBlock
              headline="No actions match this filter"
              detail={`${src.rows.length} action${src.rows.length === 1 ? "" : "s"} ${src.rows.length === 1 ? "is" : "are"} on file and none ${src.rows.length === 1 ? "is" : "are"} ${describe(tick, outcome)}. The ledger is fine — this is your filter, not an outage.`}
            />
            <Btn size="sm" tone="accent" onClick={clear} style={{ width: "100%", marginTop: 9 }}>
              Clear filter
            </Btn>
          </div>
        ) : (
          <ScrollList maxHeight={420}>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {groups.map((g) => (
                <div key={g.key} style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {/* Only when the feed actually spans days. A date header over
                      a single day's rows is a label that answers a question
                      nobody could have had. */}
                  {groups.length > 1 && <DayHeading ms={g.ms} now={now} count={g.rows.length} />}
                  {g.rows.map((r) => <ActionRow key={r.id} row={r} />)}
                </div>
              ))}
            </div>
          </ScrollList>
        )}
      </div>
    </Panel>
  );
}

// ─── one row ─────────────────────────────────────────────────────────────────
function ActionRow({ row }) {
  const out = row?.outcome;
  const tone = out === "failure" ? TONE.error : out === "blocked" ? TONE.stale : null;
  const cost = Number(row?.cost_usd);
  const d = dur(row?.duration_ms);
  const failed = out === "failure";
  const why = reasonText(row);

  return (
    <div style={{
      borderRadius: 10, padding: "9px 10px",
      background: tone ? tone.bg : "var(--subtle)",
      border: `1px solid ${tone ? tone.line : "var(--border)"}`,
      ...(tone ? { borderLeft: `3px solid ${tone.fg}` } : null),
    }}>
      <Row gap={7}>
        {/* Fixed width and tabular, so a column of times stays a column as
            rows stream in above them. */}
        <span style={{
          flexShrink: 0, minWidth: 52, fontSize: 10.5, color: "var(--faint)",
          fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
        }}>{clockTime(row?.occurred_at)}</span>
        <Badge>{row?.tick_type || "unknown"}</Badge>
        <span style={{ flex: 1 }} />
        <Badge tone={OUTCOME_TONE[out] || "empty"}>{label(out) || "no outcome"}</Badge>
      </Row>

      <div style={{
        marginTop: 6, fontSize: 12.5, lineHeight: 1.45, color: "var(--ink)", fontWeight: 600,
        // Two lines, then ellipsis. The ledger's own contract is "one line,
        // human-readable" — clamping is the guard against a row that ignored it
        // pushing every other row off a 420px scroll.
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        overflow: "hidden", overflowWrap: "anywhere",
      }}>{row?.action || "—"}</div>

      {(Number.isFinite(cost) && cost > 0) || d ? (
        <Row gap={6} wrap style={{
          marginTop: 5, fontSize: 10, color: "var(--faint)",
          fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
        }}>
          {Number.isFinite(cost) && cost > 0 && (
            <span style={{ color: "var(--muted)", fontWeight: 700 }}>{usd(cost)}</span>
          )}
          {Number.isFinite(cost) && cost > 0 && d && <Dot />}
          {d && <span>{d}</span>}
        </Row>
      ) : null}

      {/* Inline, always, never behind a tap — the whole reason anyone scrolls
          this feed is the rows that broke. And a failure with nothing in
          `error` gets a line of its own: an empty space where the reason
          belongs is indistinguishable from a row that went fine. */}
      {(failed || why) && (
        <div style={{
          marginTop: 7, padding: "7px 9px", borderRadius: 8,
          background: "color-mix(in srgb, var(--bg) 45%, transparent)",
          border: `1px solid ${failed ? TONE.error.line : "var(--border)"}`,
          fontSize: 11, lineHeight: 1.5, overflowWrap: "anywhere",
          color: why ? (failed ? "#FFB4B4" : "var(--muted)") : TONE.error.fg,
          fontStyle: why ? "normal" : "italic",
          fontFamily: why ? "var(--font-mono)" : "var(--font-display)",
        }}>
          {why || "Failed with no error recorded — the row says it broke and not why."}
        </div>
      )}
    </div>
  );
}

// ─── filters ─────────────────────────────────────────────────────────────────
function FilterRow({ caption, values, counts, total, active, onPick, toneFor }) {
  return (
    <div>
      <div style={{
        fontSize: 9.5, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase",
        color: "var(--faint)", fontFamily: "var(--font-mono)", marginBottom: 6,
      }}>{caption}</div>
      <Row gap={6} wrap>
        <Chip label="all" count={total} active={active === ALL} tone="accent" onClick={() => onPick(ALL)} />
        {values.map((v) => (
          <Chip
            key={v}
            label={label(v)}
            count={counts[v] || 0}
            active={active === v}
            tone={toneFor(v)}
            onClick={() => onPick(active === v ? ALL : v)}
          />
        ))}
      </Row>
    </div>
  );
}

function Chip({ label: text, count, active, tone, onClick }) {
  return (
    <Btn
      size="sm"
      tone={active ? tone : "ghost"}
      aria-pressed={active}
      onClick={onClick}
      // Dimmed at zero rather than hidden. A chip that disappears when its
      // count is nil takes the fact "there are none of these" away with it,
      // and leaves a row of buttons that silently changes shape as rows land.
      style={{ gap: 5, opacity: !active && count === 0 ? 0.45 : 1 }}
    >
      {text}
      <span style={{
        fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
        fontSize: 10.5, fontWeight: 700, opacity: active ? 0.9 : 0.62,
      }}>{count}</span>
    </Btn>
  );
}

// ─── day grouping ────────────────────────────────────────────────────────────
function DayHeading({ ms, now, count }) {
  return (
    <div style={{
      // Sticky inside the scroller: 420px of feed can hold two days, and the
      // day a row belongs to is not recoverable from a clock time alone.
      position: "sticky", top: 0, zIndex: 1,
      background: "var(--surface)", padding: "5px 0 4px", marginTop: 2,
      fontSize: 9.5, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase",
      color: "var(--faint)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
      borderBottom: "1px solid var(--border)",
    }}>
      {dayHeading(ms, now)} <span style={{ opacity: 0.6 }}>· {count}</span>
    </div>
  );
}

function dayHeading(ms, now) {
  if (ms === null) return "time unknown";
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return dayLabel(ms);
}

const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * Runs of consecutive same-day rows, in the order they arrived. Deliberately
 * NOT a keyed bucket: the query is ordered occurred_at desc, and if that order
 * ever breaks the same day appears twice — which is the honest rendering of
 * rows that are out of sequence, where a re-bucketing would hide it.
 */
function groupByDay(rows) {
  const groups = [];
  let cur = null;
  for (const r of rows) {
    const t = toMs(r?.occurred_at);
    const key = t === null ? "unknown" : String(startOfDay(t));
    if (!cur || cur.key !== key) {
      cur = { key, ms: t === null ? null : startOfDay(t), rows: [] };
      groups.push(cur);
    }
    cur.rows.push(r);
  }
  return groups;
}

// ─── faceting ────────────────────────────────────────────────────────────────
/**
 * Both filters, both facet counts, and the newest matching timestamp in one
 * pass over the rows.
 *
 * The chip lists start from tables.js and then absorb any value actually
 * present in the data. `outcome` has a check constraint behind it so that union
 * is a no-op; `tick_type` does not, and a sixth kind the agent started writing
 * would otherwise be reachable only through "all" — a filter row that silently
 * cannot express part of its own column.
 */
function facets(rows, tick, outcome) {
  const list = Array.isArray(rows) ? rows : [];
  const byTick = tick === ALL ? list : list.filter((r) => r?.tick_type === tick);
  const byOutcome = outcome === ALL ? list : list.filter((r) => r?.outcome === outcome);
  const matched = tick === ALL ? byOutcome : outcome === ALL ? byTick : byTick.filter((r) => r?.outcome === outcome);

  let newestMatchMs = null;
  for (const r of matched) {
    const t = toMs(r?.occurred_at);
    if (t !== null && (newestMatchMs === null || t > newestMatchMs)) newestMatchMs = t;
  }

  return {
    matched,
    newestMatchMs,
    failures: list.reduce((n, r) => n + (r?.outcome === "failure" ? 1 : 0), 0),
    tickValues: union(TICK_TYPES, list, "tick_type"),
    outcomeValues: union(OUTCOMES, list, "outcome"),
    tickCounts: tally(byOutcome, "tick_type"),
    outcomeCounts: tally(byTick, "outcome"),
    tickTotal: byOutcome.length,
    outcomeTotal: byTick.length,
  };
}

function union(known, rows, col) {
  const seen = new Set(known);
  const extra = [];
  for (const r of rows) {
    const v = r?.[col];
    if (typeof v === "string" && v && !seen.has(v)) { seen.add(v); extra.push(v); }
  }
  return known.concat(extra);
}

function tally(rows, col) {
  const out = {};
  for (const r of rows) {
    const v = r?.[col];
    if (typeof v === "string" && v) out[v] = (out[v] || 0) + 1;
  }
  return out;
}

/** The filter, in words, for the copy that has to name what excluded everything. */
function describe(tick, outcome) {
  if (tick !== ALL && outcome !== ALL) return `a ${tick} tick that ended in ${label(outcome)}`;
  if (tick !== ALL) return `a ${tick} tick`;
  return `${label(outcome)}`;
}

/**
 * The reason a row broke. `error` is where it belongs, but the agent writes a
 * free-form jsonb `detail` too, and a failure whose message landed in there
 * would otherwise render as a blank — the one blank on this panel that must
 * never happen quietly.
 */
function reasonText(row) {
  const e = typeof row?.error === "string" ? row.error.trim() : "";
  if (e) return e;
  const d = row?.detail;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    for (const k of ["error", "message", "reason", "detail"]) {
      const v = d[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

/**
 * Durations, honestly. shortAge() rounds to whole seconds, which prints every
 * sub-second tick as "0s" and erases the difference between fast and
 * instantaneous — and "instantaneous" is what a no-op that never ran looks like.
 */
function dur(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(n / 60_000);
  const s = Math.round((n % 60_000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
}

const Dot = () => <span style={{ opacity: 0.4 }}>·</span>;

// ─── loading ─────────────────────────────────────────────────────────────────
// Shaped like the answer and containing no digits at all — chips, then a feed.
// A skeleton with a placeholder count in it is the calm-zero bug wearing a
// shimmer.
function LedgerSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      {["58%", "68%"].map((w, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <SkeletonLine width="22%" height="9px" />
          <SkeletonLine width={w} height="30px" />
        </div>
      ))}
      {[0, 1, 2, 3].map((i) => (
        <div key={i} style={{
          borderRadius: 10, border: "1px solid var(--border)", padding: "9px 10px",
          display: "flex", flexDirection: "column", gap: 6, opacity: 1 - i * 0.18,
        }}>
          <SkeletonLine width="52%" height="11px" />
          <SkeletonLine width="88%" height="12px" />
        </div>
      ))}
    </div>
  );
}
