// ═══════════════════════════════════════════════════════════════════════════
// Panel 4 — the card. The one panel written to be read alone, on a phone,
// standing up, in under two minutes.
//
// Everything it shows is DERIVED (see briefing.js) from the same rows the
// panels below render, so it cannot drift from them. What that costs is
// freshness: seven feeds go in, and a card is only as true as its worst one.
// So the panel state is worst-of-seven, not best-of-seven, with exactly one
// correction — see cardState(). The chip in the header therefore answers "how
// much of this do I believe", and §2 prints the snapshot's own age separately,
// because a two-minute-old ledger next to a six-hour-old objective is two
// facts and averaging them into one chip would lose the one that matters.
//
// Section order is the reading order, and it is not the schema's order:
//   1 what it did · 2 what moved · 3 what it learned · 4 what's next/stuck
// The headline sits above all four because most visits end after one line.
// ═══════════════════════════════════════════════════════════════════════════
import { AnimatedNumber, SkeletonLine, SkeletonRows } from "@cc/ui";
import { useSource } from "../../lib/AgentData.jsx";
import { composeBriefing } from "../../lib/briefing.js";
import { PANEL, worstState } from "../../lib/freshness.js";
import { clockTime, pct, shortAge, signed, usd } from "../../lib/format.js";
import { Badge, EmptyBlock, Meter, Panel, Row, ScrollList, Stat, TONE } from "../primitives.jsx";

const METRIC_LABELS = {
  objective: "Objective",
  mrr_usd: "MRR",
  customers: "Customers",
  trials: "Trials",
  conversion: "Conversion",
};

// The failure chip is in this list with `always: true`. A count that appears
// only when it is non-zero teaches you that its absence means nothing — when
// what it should mean is zero. Every other outcome may stay off screen.
const OUTCOMES = [
  { key: "success", label: "clean", tone: "fresh" },
  { key: "failure", label: "failed", tone: "error", always: true },
  { key: "blocked", label: "blocked", tone: "stale" },
  { key: "skipped", label: "skipped", tone: "empty" },
  { key: "dry_run", label: "dry run", tone: "empty" },
];

export default function BriefingCard({ now }) {
  // Order is load-bearing: worstState keeps the FIRST state of the worst rank,
  // so when nothing is wrong the age on the chip resolves to the action ledger
  // — the spine of the card and the strictest window of the seven (45m).
  const actions = useSource("actions", now);
  const metrics = useSource("metrics", now);
  const learnings = useSource("learnings", now);
  const hypotheses = useSource("hypotheses", now);
  const approvals = useSource("approvals", now);
  const invariants = useSource("invariants", now);
  const config = useSource("config", now);

  const sources = [actions, metrics, learnings, hypotheses, approvals, invariants, config];
  const refreshAll = () => sources.forEach((s) => s.refresh());

  const b = composeBriefing({
    actions: actions.rows,
    metrics: metrics.rows,
    learnings: learnings.rows,
    hypotheses: hypotheses.rows,
    approvals: approvals.rows,
    invariants: invariants.rows,
    // agent_config is a singleton by check constraint, not by convention.
    config: config.rows[0] || null,
    now,
  });

  const state = cardState(sources.map((s) => s.state), b);

  return (
    <Panel
      id="briefing"
      title={`Briefing · last ${b.windowHours}h`}
      state={state}
      onRetry={refreshAll}
      skeleton={<BriefingSkeleton />}
      emptyHeadline={`Nothing to brief for the last ${b.windowHours} hours`}
      emptyDetail={`The database answered${state.fetchAgeMs === null ? "" : ` ${shortAge(state.fetchAgeMs)} ago`} and one of the seven feeds behind this card came back with no rows at all. This is a real empty, not a failed read — and an empty ledger is not a quiet agent, it is an agent that wrote nothing.`}
      // Panel paints `right` in every state, LOADING and ERROR included. A
      // count handed to it would be a number on screen while there is nothing
      // truthful to count, so it only goes up once the state machine vouches
      // for the rows.
      right={state.state === PANEL.FRESH && b.byOutcome.failure > 0
        ? <Badge tone="error">{b.byOutcome.failure} failed</Badge>
        : null}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 17 }}>
        <Headline b={b} />

        {/* ─── 1. what it did ───────────────────────────────────────────── */}
        <Section index="1" label="What it did">
          <Row gap={12} align="flex-start">
            <div style={{ flex: 1, minWidth: 0 }}>
              <Stat
                label={`Actions · ${b.windowHours}h`}
                value={<AnimatedNumber value={b.actionCount} />}
                sub={b.byTick.length > 0 ? `${b.byTick.length} kind${b.byTick.length === 1 ? "" : "s"} of tick` : null}
              />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Stat
                label="Cost"
                value={<AnimatedNumber value={b.costUsd} format={(v) => usd(v)} />}
                sub={b.actionCount > 0 ? `${usd(b.costUsd / b.actionCount, { cents: true })} each` : null}
              />
            </div>
          </Row>

          <Row gap={6} wrap>
            {OUTCOMES.filter((o) => o.always || b.byOutcome[o.key] > 0).map((o) => (
              <Badge key={o.key} tone={b.byOutcome[o.key] > 0 ? o.tone : "empty"}>
                {b.byOutcome[o.key]} {o.label}
              </Badge>
            ))}
          </Row>

          {b.byTick.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {/* Share of the window, not raw bars: "half of it was heartbeat"
                  is the shape that tells you whether it actually worked. */}
              {b.byTick.slice(0, 4).map((t) => (
                <div key={t.tick} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <Row gap={8}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.tick}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                      {t.count}
                    </span>
                  </Row>
                  <Meter pct={t.count / Math.max(1, b.actionCount)} height={4} />
                </div>
              ))}
            </div>
          )}

          {/* A failure count with no error text is a number you cannot act on,
              so the ledger's own message comes with it, unabridged. */}
          {b.failedActions.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <Label tone="error">What failed</Label>
              <ScrollList maxHeight={b.failedActions.length > 2 ? 230 : undefined}>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {b.failedActions.map((a) => <FailedRow key={a.id || a.occurred_at} a={a} />)}
                </div>
              </ScrollList>
              {b.byOutcome.failure > b.failedActions.length && (
                <div style={{ fontSize: 10.5, color: "var(--faint)", fontVariantNumeric: "tabular-nums" }}>
                  Showing {b.failedActions.length} of {b.byOutcome.failure} — the rest are in the action ledger.
                </div>
              )}
            </div>
          )}
        </Section>

        {/* ─── 2. what moved ────────────────────────────────────────────── */}
        <Section index="2" label="What moved">
          {b.deltas.length === 0 ? (
            <EmptyBlock
              headline="The objective has not been snapshotted"
              detail="No metrics rows to read, so this card cannot say the number moved — and will not guess at it from the actions above."
            />
          ) : (
            <>
              {/* The comparison window has to be stated before the numbers are
                  read, not after: a +12 over 40 minutes and a +12 over six
                  hours are different news, and the row cannot tell you which. */}
              {b.baselineAtMs === null ? (
                <Note tone="stale" lead="Only one snapshot exists.">
                  These are current values with nothing to compare them against, not changes.
                </Note>
              ) : !b.baselineCoversWindow ? (
                <Note tone="stale" lead="Short comparison window.">
                  The oldest snapshot available is {shortAge(now - b.baselineAtMs)} old, so these are changes over {shortAge(now - b.baselineAtMs)} — not over the full {b.windowHours}h this card is named for.
                </Note>
              ) : null}

              <div>
                {b.deltas.map((d) => <DeltaRow key={d.key} d={d} lead={d.key === "objective"} />)}
              </div>

              <div style={{ fontSize: 10, color: "var(--faint)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", lineHeight: 1.5 }}>
                latest snapshot {b.latestSnapshotAtMs === null ? "unknown" : `${shortAge(now - b.latestSnapshotAtMs)} ago`}
                {b.baselineAtMs !== null && ` · baseline ${shortAge(now - b.baselineAtMs)} ago`}
              </div>
            </>
          )}
        </Section>

        {/* ─── 3. what it learned ───────────────────────────────────────── */}
        <Section index="3" label="What it learned">
          {b.newLearnings.length === 0 ? (
            <EmptyBlock
              headline={`Nothing learned in the last ${b.windowHours} hours`}
              detail="No new rows in learnings. That is not the same as nothing happening — it means it recorded no belief it did not already hold."
            />
          ) : (
            <ScrollList maxHeight={b.newLearnings.length > 3 ? 280 : undefined}>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {b.newLearnings.map((l) => <LearningRow key={l.id || l.learned_at} l={l} />)}
              </div>
            </ScrollList>
          )}
        </Section>

        {/* ─── 4. next / blocked ────────────────────────────────────────── */}
        <Section index="4" label="Next / blocked">
          <Label>Wants to try next</Label>
          {b.wantsNext.length === 0 ? (
            <EmptyBlock
              headline="Nothing queued"
              detail="No hypothesis is queued or running. An agent with an empty queue has either finished thinking or stopped."
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {b.wantsNext.map((h, i) => <NextRow key={h.id || i} h={h} rank={i + 1} />)}
            </div>
          )}

          <Label tone={b.blockedOn.some(isCritical) ? "error" : undefined} style={{ marginTop: 4 }}>
            Blocked on
          </Label>
          {b.blockedOn.length === 0 ? (
            // Deliberately NOT the dashed empty treatment. Dashed means "we
            // looked and there were no rows"; this is an answer computed from
            // four feeds the state machine has already vouched for, so it gets
            // to be an affirmative — and it names what was checked, because an
            // unqualified "all clear" is the calm zero in a friendlier font.
            <Row gap={9} align="flex-start" style={{ padding: "11px 12px", borderRadius: 11, background: TONE.fresh.bg, border: `1px solid ${TONE.fresh.line}` }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: TONE.fresh.fg, flexShrink: 0, marginTop: 5 }} />
              <span style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.55 }}>
                <b style={{ color: TONE.fresh.fg, fontWeight: 800 }}>Nothing blocking.</b>{" "}
                Not halted, no approval waiting on you, no hypothesis stuck, no failing invariant check.
              </span>
            </Row>
          ) : (
            <ScrollList maxHeight={b.blockedOn.length > 3 ? 300 : undefined}>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {/* Critical first. A failing invariant queued behind three
                    routine approvals is a reading position it did not earn. */}
                {[...b.blockedOn]
                  .sort((x, y) => (isCritical(x) ? 0 : 1) - (isCritical(y) ? 0 : 1))
                  .map((item, i) => <BlockedRow key={`${item.type}-${item.id || i}`} item={item} />)}
              </div>
            </ScrollList>
          )}
        </Section>
      </div>
    </Panel>
  );
}

/**
 * The card's B3 state: the worst of its seven feeds — with one correction.
 *
 * Four of these sources are legitimately empty most of the time (an approvals
 * queue nobody has filled, a quiet week for learnings), and EMPTY outranks
 * FRESH. Left alone, an empty approvals queue would replace the entire
 * briefing with "nothing here" while forty real actions sat unread underneath.
 * That is the calm-zero lie pointed the other way, and it is worse here than
 * anywhere else in the tab because this panel is the one people stop at.
 *
 * So a BENIGN empty (expectsRows === false, hence alarm === false) only takes
 * the card when the card genuinely has nothing to report. An ALARMING empty —
 * the action ledger with no rows at all, the watchdog silent — still takes the
 * whole card, because that is the news.
 */
function cardState(states, b) {
  const worst = worstState(states);
  if (!worst || worst.state !== PANEL.EMPTY || worst.alarm) return worst || states[0];
  const hasContent =
    b.actionCount > 0 || b.deltas.length > 0 || b.newLearnings.length > 0 ||
    b.wantsNext.length > 0 || b.blockedOn.length > 0;
  if (!hasContent) return worst;
  return worstState(states.filter((s) => !(s.state === PANEL.EMPTY && !s.alarm))) || worst;
}

/** The one line, for the visit that ends after one line. */
function Headline({ b }) {
  // Coloured by the worst thing the sentence reports, never by data freshness
  // — the chip in the header owns freshness. A red headline over a green chip
  // reads correctly as "we heard from it two minutes ago, and it is halted".
  const color =
    b.blockedOn.some(isCritical) || b.byOutcome.failure > 0 ? TONE.error.fg
    : b.actionCount === 0 || b.blockedOn.length > 0 ? TONE.stale.fg
    : "var(--ink)";
  return (
    <div>
      <div style={{ fontSize: 17, lineHeight: 1.3, fontWeight: 800, letterSpacing: "-0.01em", fontFamily: "var(--font-display)", color, overflowWrap: "anywhere" }}>
        {b.headline}
      </div>
      <div style={{ marginTop: 5, fontSize: 10, color: "var(--faint)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
        since {clockTime(b.windowStartMs)} · {b.windowHours}h window
      </div>
    </div>
  );
}

/** A numbered rule. The four questions have to be separable at a glance. */
function Section({ index, label, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Row gap={8}>
        <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--faint)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
          {index} · {label}
        </span>
        <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
      </Row>
      {children}
    </div>
  );
}

function Label({ children, tone, style }) {
  return (
    <div style={{
      fontSize: 9.5, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase",
      color: tone ? (TONE[tone] || TONE.empty).fg : "var(--faint)", fontFamily: "var(--font-mono)",
      ...style,
    }}>{children}</div>
  );
}

/** A caveat that changes how the numbers beside it should be read. */
function Note({ tone = "stale", lead, children }) {
  const t = TONE[tone] || TONE.stale;
  return (
    <div style={{ padding: "9px 11px", borderRadius: 10, background: t.bg, border: `1px solid ${t.line}`, fontSize: 11, lineHeight: 1.55, color: "var(--muted)" }}>
      {lead && <b style={{ color: t.fg, fontWeight: 800 }}>{lead} </b>}
      {children}
    </div>
  );
}

function FailedRow({ a }) {
  const cost = Number(a.cost_usd);
  return (
    <div style={{
      borderRadius: 11, padding: "10px 11px", background: TONE.error.bg,
      border: `1px solid ${TONE.error.line}`, borderLeft: `3px solid ${TONE.error.fg}`,
    }}>
      <Row gap={8} align="flex-start">
        <div style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: "var(--ink)", lineHeight: 1.45, overflowWrap: "anywhere" }}>
          {a.action}
        </div>
        <span style={{ fontSize: 10, color: "var(--faint)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
          {clockTime(a.occurred_at)}
        </span>
      </Row>
      {/* Wrapped, not truncated. Stack traces and vendor errors are ugly and
          they are also the only part of this row you can act on. */}
      <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.5, color: TONE.error.fg, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
        {a.error || "No error text was recorded — the ledger says it failed and nothing more."}
      </div>
      <Row gap={6} wrap style={{ marginTop: 7 }}>
        {a.tick_type && <Badge>{a.tick_type}</Badge>}
        {Number.isFinite(cost) && cost > 0 && <Badge tone="error">{usd(cost, { cents: true })} spent</Badge>}
      </Row>
    </div>
  );
}

function DeltaRow({ d, lead }) {
  const dir = d.delta === null ? 0 : Math.sign(d.delta);
  const color = dir > 0 ? TONE.fresh.fg : dir < 0 ? TONE.error.fg : "var(--muted)";
  return (
    <Row gap={10} style={{ padding: "9px 0", borderTop: "1px solid var(--border)" }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {METRIC_LABELS[d.key] || d.key}
      </span>
      <span style={{
        fontSize: lead ? 17 : 14, fontWeight: 800, lineHeight: 1.1, color: "var(--ink)",
        fontFamily: "var(--font-display)", fontVariantNumeric: "tabular-nums", flexShrink: 0,
      }}>
        {fmtMetric(d.key, d.to)}
      </span>
      <div style={{ width: 80, textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: d.delta === null ? 10 : 11.5, fontWeight: 700, color: d.delta === null ? "var(--faint)" : color, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
          {d.delta === null ? "no baseline" : signed(d.delta, (x) => fmtMetric(d.key, x))}
        </div>
        {d.pct !== null && (
          <div style={{ fontSize: 10, color: "var(--faint)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", marginTop: 2 }}>
            {signed(d.pct, (x) => pct(x, 1))}
          </div>
        )}
      </div>
    </Row>
  );
}

function LearningRow({ l }) {
  const c = Number(l.confidence);
  const known = Number.isFinite(c);
  return (
    <div style={{ padding: "10px 11px", borderRadius: 11, background: "var(--subtle)", border: "1px solid var(--border)" }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)", lineHeight: 1.45, overflowWrap: "anywhere" }}>
        {l.statement}
      </div>
      {l.detail && (
        // Clamped: this is the card, not the archive. The statement is the
        // belief; the detail is the working, and three lines of working is as
        // much as a two-minute read can spend on one row.
        <div style={{
          marginTop: 4, fontSize: 11, color: "var(--muted)", lineHeight: 1.5, overflowWrap: "anywhere",
          display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden",
        }}>{l.detail}</div>
      )}
      <Row gap={6} wrap style={{ marginTop: 8 }}>
        <Badge tone={!known ? "empty" : c >= 0.7 ? "fresh" : c >= 0.4 ? "accent" : "empty"}>
          {known ? `${pct(c, 0)} confident` : "confidence unrecorded"}
        </Badge>
        {l.source && <Badge>{l.source}</Badge>}
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--faint)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
          {clockTime(l.learned_at)}
        </span>
      </Row>
    </div>
  );
}

function NextRow({ h, rank }) {
  const score = Number(h.score);
  const running = h.status === "running";
  const effort = Number(h.effort_hours);
  return (
    <Row gap={9} align="flex-start" style={{ padding: "10px 11px", borderRadius: 11, background: "var(--subtle)", border: "1px solid var(--border)" }}>
      <span style={{
        width: 18, height: 18, borderRadius: 6, flexShrink: 0, marginTop: 1,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "var(--accent-soft)", border: "1px solid var(--accent-line)", color: "var(--accent)",
        fontSize: 10, fontWeight: 800, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
      }}>{rank}</span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)", lineHeight: 1.45, overflowWrap: "anywhere" }}>{h.title}</div>
        <Row gap={6} wrap style={{ marginTop: 6 }}>
          <Badge tone={running ? "accent" : "empty"}>{running ? "running" : "queued"}</Badge>
          {h.tier >= 2 && <Badge tone={h.tier >= 3 ? "error" : "stale"}>tier {h.tier}</Badge>}
          {h.expected_lift && <Badge tone="fresh">{h.expected_lift}</Badge>}
          {Number.isFinite(effort) && effort > 0 && <Badge>{effort}h</Badge>}
        </Row>
      </div>

      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>
          {Number.isFinite(score) ? score.toFixed(2) : "—"}
        </div>
        <div style={{ fontSize: 9, color: "var(--faint)", fontFamily: "var(--font-mono)", marginTop: 2 }}>score</div>
      </div>
    </Row>
  );
}

function BlockedRow({ item }) {
  const critical = isCritical(item);
  const t = critical ? TONE.error : TONE.stale;
  return (
    <div style={{
      padding: "10px 11px", borderRadius: 11, background: t.bg,
      border: `1px solid ${t.line}`, borderLeft: `3px solid ${t.fg}`,
    }}>
      <Row gap={8} align="flex-start">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)", lineHeight: 1.45, overflowWrap: "anywhere" }}>{item.label}</div>
          <div style={{ marginTop: 3, fontSize: 11, color: "var(--muted)", lineHeight: 1.5, overflowWrap: "anywhere" }}>{item.detail}</div>
        </div>
        {/* The type is the pointer: it says which surface below this card can
            actually clear the block. */}
        <Badge tone={critical ? "error" : "stale"}>{item.type}</Badge>
      </Row>
    </div>
  );
}

/** Shaped like the answer, so the layout does not jump when the rows land. */
function BriefingSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <SkeletonLine width="88%" height="17px" />
        <SkeletonLine width="42%" height="9px" />
      </div>
      <Row gap={12}>
        <SkeletonLine width="46%" height="30px" />
        <SkeletonLine width="46%" height="30px" />
      </Row>
      <SkeletonRows count={2} />
    </div>
  );
}

const isCritical = (x) => x.severity === "critical";

function fmtMetric(key, n) {
  if (!Number.isFinite(n)) return "—";
  if (key === "mrr_usd") return usd(n);
  if (key === "conversion") return pct(n, 1);
  // objective / customers / trials. The objective is numeric(14,4) and may be
  // fractional; the counts never are — so round only what is already integral
  // rather than inventing decimals on a customer.
  return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
