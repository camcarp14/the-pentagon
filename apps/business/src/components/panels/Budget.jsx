// ═══════════════════════════════════════════════════════════════════════════
// Panel 3 — Budget. One question: does this pace land under the cap before the
// period ends?
//
// Two sources feed it and they fail independently, which is the whole reason
// this one needs care. Caps without the ledger report a calm $0 spent; the
// ledger without caps has no denominator and no notion of "over". Either half
// missing produces a confident wrong answer, so both states fold through
// worstState() and the panel wears the worse of them. There is no arrangement
// of these two sources that lets this panel look healthy while half its input
// is gone.
//
// The pace verdict is the only line most people will read, and it is allowed
// to say three things, not two: on pace, over, or — early in a period —
// nothing at all. budget.js refuses to project until enough of the period has
// elapsed to divide by, and that refusal gets its own treatment here (dashed,
// uncoloured, "too early to project"). Painting it green would be a claim
// about a number we declined to compute; painting it red on the 1st is how an
// alarm gets ignored by the 20th.
//
// Two alarm vocabularies, deliberately not interchangeable:
//   AlarmBlock (triangle)   the panel's INPUTS are broken — no usable period,
//                           or caps belonging to a period that already ended.
//   coloured verdict strip  the MONEY is the problem. No triangle: the
//                           triangle is B3's and it has to keep meaning
//                           "don't believe this screen".
// ═══════════════════════════════════════════════════════════════════════════
import { useSource } from "../../lib/AgentData.jsx";
import { budgetSummary } from "../../lib/budget.js";
import { worstState, PANEL } from "../../lib/freshness.js";
import { usd, pct, shortAge, dayLabel, toMs } from "../../lib/format.js";
import { Panel, Badge, Meter, AlarmBlock, Row, ScrollList, Stat, TONE } from "../primitives.jsx";
import { AnimatedNumber, SkeletonLine } from "@cc/ui";

const DAY_MS = 86_400_000;

export default function Budget({ now }) {
  const caps = useSource("budget", now);
  const spend = useSource("spend", now);

  // The two ages are not merged into an average or a "mostly fine" — the worse
  // one wins outright, so a dead ledger poll can never hide behind caps that
  // legitimately haven't changed in three weeks.
  const state = worstState([caps.state, spend.state]);
  const retry = () => { caps.refresh(); spend.refresh(); };

  const s = budgetSummary(caps.rows, spend.rows, now);

  // Charges dated past the end of the period being displayed. They are excluded
  // from every figure below by design, and that exclusion is invisible unless
  // it is counted — which is exactly the shape of an expired-caps outage: real
  // money leaving, totals sitting still. The column name lives in tables.js, so
  // read it off the spec instead of hard-coding it here.
  const afterPeriod = s.ok
    ? spend.rows.filter((r) => {
        const t = toMs(r?.[spend.spec?.timeColumn]);
        return t !== null && t >= s.periodEndExclusiveMs;
      }).length
    : 0;

  const v = s.ok ? paceVerdict(s) : null;

  // Which source is empty changes what emptiness MEANS, and Panel can't know:
  // no caps is the dangerous one (nothing can ever be judged over), no ledger
  // rows is the calm one (proven, because the read succeeded). Same state, two
  // different pieces of news, so the copy has to separate them.
  const capsEmpty = caps.state.state === PANEL.EMPTY;

  return (
    <Panel
      id="budget"
      title="Budget"
      state={state}
      onRetry={retry}
      skeleton={<BudgetSkeleton />}
      emptyHeadline={capsEmpty ? "No caps are set" : "Nothing spent yet"}
      emptyDetail={
        capsEmpty
          ? "The budget table is reachable and holds no rows. With no cap there is nothing for spend to be measured against — every dollar this period is unbounded, and no overspend can ever be detected here."
          // Was "genuinely holds nothing", which is more than the wire can
          // support: PostgREST answers an RLS denial with `200 []`, exactly as
          // it answers a quiet month. "Returned no rows" is the whole of what
          // is known, and the second sentence names the other reading rather
          // than letting the reassuring one stand alone.
          : `The spend ledger returned no rows${spend.state.fetchAgeMs !== null ? ` — read ${shortAge(spend.state.fetchAgeMs)} ago` : ""}. Caps are set and intact. Either nothing has been charged this period, or this read is being refused and answering empty; the two are indistinguishable from here, so treat a persistent $0 against a working agent as the second.`
      }
      // Panel renders `right` in every state, including the error chrome — so
      // this figure is gated on the calm one. A verdict badge surviving into an
      // outage is a stale number wearing the header's authority.
      right={state.state === PANEL.FRESH && v ? <Badge tone={v.badge.tone}>{v.badge.text}</Badge> : null}
    >
      {!s.ok ? (
        // Reachable rows that don't resolve to a period: every cap is missing or
        // unparseable in `period_start`. Panel's empty treatment covers the
        // zero-row case above; this covers the worse one, where rows exist and
        // still buy you nothing. Either way it is an alarm and not a shrug — a
        // budget panel with no caps cannot tell you about overspend at all, and
        // saying "nothing here" would read as "nothing wrong".
        <AlarmBlock
          tone="error"
          headline="No usable budget period"
          detail={`${s.message || "The budget rows do not resolve to a period."} ${caps.state.rowCount} cap row${caps.state.rowCount === 1 ? "" : "s"} were read, so the table is reachable — nothing below can be judged against a cap until one covers today.`}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          {s.periodExpired && (
            <AlarmBlock
              tone="stale"
              headline="These caps expired"
              detail={`The newest budget period ran to ${dayLabel(s.periodEndExclusiveMs - DAY_MS)} and nothing has replaced it. Everything below describes that closed period, not today${
                afterPeriod > 0
                  ? ` — and ${afterPeriod} charge${afterPeriod === 1 ? "" : "s"} dated after it ${afterPeriod === 1 ? "is" : "are"} counted nowhere on this panel.`
                  : "."
              }`}
            />
          )}

          <Headline s={s} v={v} />

          {s.categories.length > 0 ? (
            <CategoryList lines={s.categories} projectable={s.projectable} />
          ) : (
            <div className="t-cap" style={{
              padding: "13px 12px", borderRadius: 10, border: "1px dashed var(--border)",
              color: "var(--faint)", lineHeight: 1.55, textAlign: "center",
            }}>
              One umbrella cap, no per-category rows and no categorised spend — the total above is the only thing there is to watch.
            </div>
          )}

          {/* One chip on the header can only report the worse source. With two
              feeds behind one panel, which one aged is the actionable half. */}
          {/* 11.5px, not 10: Row takes no className, so the kit's .t-cap size
              is written out. 10 was under the floor. */}
          <Row gap={7} wrap style={{ fontSize: 11.5, color: "var(--faint)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            <span>caps {readAge(caps.state.fetchAgeMs)}</span>
            <span style={{ opacity: 0.45 }}>·</span>
            <span>ledger {readAge(spend.state.fetchAgeMs)}</span>
            <span style={{ opacity: 0.45 }}>·</span>
            <span>
              {s.spendRowCount} charge{s.spendRowCount === 1 ? "" : "s"} in period
              {s.spendRowCount === 0 && spend.rows.length > 0 ? ` (${spend.rows.length} older on file)` : ""}
            </span>
          </Row>
        </div>
      )}
    </Panel>
  );
}

// ─── the headline: spent, cap, pace ──────────────────────────────────────────
function Headline({ s, v }) {
  const t = s.total;
  const T = v.tone ? TONE[v.tone] : null;

  return (
    <div style={{ borderRadius: 12, border: "1px solid var(--border)", background: "var(--subtle)", padding: "12px 13px" }}>
      <Row gap={12} align="flex-start">
        <div style={{ flex: 1, minWidth: 0 }}>
          <Stat
            label={s.periodExpired ? "Spent that period" : "Spent this period"}
            value={<AnimatedNumber value={t.spentUsd} format={(n) => usd(n)} />}
            sub={t.capUsd === null ? "no cap to measure against" : `of ${usd(t.capUsd)}${t.pctUsed !== null ? ` · ${pct(t.pctUsed)}` : ""}`}
            tone={t.breached ? "error" : undefined}
          />
        </div>
        <div style={{ flexShrink: 0 }}>
          <Stat
            align="right"
            label={s.periodExpired ? "Ended" : "Days left"}
            value={s.periodExpired ? dayLabel(s.periodEndExclusiveMs - DAY_MS) : s.daysRemaining}
            sub={`${dayLabel(s.periodStartMs)} – ${dayLabel(s.periodEndExclusiveMs - DAY_MS)}`}
            tone={!s.periodExpired && s.daysRemaining <= 1 ? "stale" : undefined}
          />
        </div>
      </Row>

      <div style={{ marginTop: 11 }}>
        {t.capUsd === null ? <NoCeilingBar height={8} /> : <Meter pct={t.pctUsed} height={8} />}
      </div>

      {/* The verdict. Colour and border carry it, never the warning triangle —
          that glyph means "the data itself is not to be trusted", and spending
          too fast is a fact we trust completely. */}
      <div style={{
        marginTop: 11, borderRadius: 10, padding: "9px 11px",
        background: T ? T.bg : "transparent",
        border: T ? `1px solid ${T.line}` : "1px dashed var(--border)",
        ...(T ? { borderLeft: `3px solid ${T.fg}` } : null),
      }}>
        <div className="t-foot" style={{
          fontWeight: 800, lineHeight: 1.35,
          color: T ? T.fg : "var(--muted)", fontVariantNumeric: "tabular-nums",
        }}>{v.headline}</div>
        <div className="t-cap" style={{ color: "var(--muted)", lineHeight: 1.55, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
          {v.detail}
        </div>
      </div>
    </div>
  );
}

/**
 * The ladder is ordered by what would change your next move, not by severity:
 * an uncapped period and a cap already breached are both decided facts, so they
 * outrank any forecast. `tone: null` is the deliberate third answer — no colour
 * at all, because a projection was refused rather than computed.
 */
function paceVerdict(s) {
  const t = s.total;
  const rate = t.perDayUsd !== null ? `${usd(t.perDayUsd)}/day` : "the current rate";
  const left = daysText(s.daysRemaining);

  if (t.capUsd === null) {
    return {
      tone: "error",
      badge: { tone: "error", text: "no cap" },
      headline: "Nothing caps this period",
      detail: `${usd(t.spentUsd)} has left with no ceiling above it. There is no threshold to breach, which means no overspend can ever raise an alarm here — the calm is an absence of caps, not an absence of risk.`,
    };
  }

  if (s.periodExpired) {
    const delta = t.spentUsd - t.capUsd;
    return delta > 0
      ? {
          tone: "error",
          badge: { tone: "error", text: "closed over" },
          headline: `Closed ${usd(delta)} over cap`,
          detail: `${usd(t.spentUsd)} against a ${usd(t.capUsd)} cap. The period is finished, so this is a settled figure and not a forecast.`,
        }
      : {
          tone: "fresh",
          badge: { tone: "fresh", text: "closed under" },
          headline: `Closed ${usd(-delta)} under cap`,
          detail: `${usd(t.spentUsd)} of ${usd(t.capUsd)}. Settled, not a forecast — but the caps still need rolling before the next period can be judged.`,
        };
  }

  if (t.breached) {
    return {
      tone: "error",
      badge: { tone: "error", text: "over cap" },
      headline: `Over cap by ${usd(t.spentUsd - t.capUsd)}`,
      detail: `${usd(t.spentUsd)} spent against ${usd(t.capUsd)} with ${left} still to run.${t.hardStop ? " This cap is a hard stop — breaching it halts the agent." : " This cap is soft — breaching it files an approval rather than stopping anything."}`,
    };
  }

  // The honest refusal. No number, no colour, and the word "pace" does not
  // appear — anything else here would be read as a verdict.
  if (!s.projectable) {
    return {
      tone: null,
      badge: { tone: "empty", text: "no verdict" },
      headline: "Too early to project",
      detail: `Only ${elapsedText(s.daysElapsed)} into the period. Dividing ${usd(t.spentUsd)} by that little elapsed time turns one charge into a month-sized number, so no verdict is offered yet — not "on pace", not "over". ${usd(t.capUsd)} is the cap; ${left} remain.`,
    };
  }

  if (t.onPace) {
    return {
      tone: "fresh",
      badge: { tone: "fresh", text: "on pace" },
      headline: `On pace — projects to ${usd(t.projectedUsd)}`,
      detail: `${usd(Math.max(0, t.capUsd - t.projectedUsd))} of headroom against the ${usd(t.capUsd)} cap, running at ${rate} with ${left} left.`,
    };
  }

  return {
    tone: "error",
    badge: { tone: "error", text: "over pace" },
    headline: `Projects to ${usd(t.projectedUsd)} — over by ${usd(t.overBy)}`,
    detail: `At ${rate} across ${left}. ${
      t.allowancePerDayUsd !== null
        ? `${usd(t.allowancePerDayUsd)}/day from here lands exactly on the ${usd(t.capUsd)} cap.`
        : `Nothing further can be spent without breaching the ${usd(t.capUsd)} cap.`
    }${t.hardStop ? " Hard stop: a breach halts the agent." : ""}`,
  };
}

// ─── per-category breakdown ──────────────────────────────────────────────────
function CategoryList({ lines, projectable }) {
  const rows = (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {lines.map((line) => <CategoryRow key={line.category} line={line} projectable={projectable} />)}
    </div>
  );
  // Past about five, the page stops fitting a thumb's scroll and the verdict
  // above scrolls out of reach. Contain the list rather than the page.
  return lines.length > 5 ? <ScrollList maxHeight={300}>{rows}</ScrollList> : rows;
}

function CategoryRow({ line, projectable }) {
  // Uncapped is flagged as loudly as over-pace on purpose: a category nobody
  // budgeted cannot be over its cap, so without a flag it renders as the
  // quietest row on screen while being the only one with no ceiling at all.
  const tone = line.breached ? TONE.error : line.uncapped || line.onPace === false ? TONE.stale : null;

  return (
    <div style={{
      padding: "9px 10px", borderRadius: 10,
      background: tone ? tone.bg : "var(--subtle)",
      border: `1px solid ${tone ? tone.line : "var(--border)"}`,
      ...(tone ? { borderLeft: `3px solid ${tone.fg}` } : null),
    }}>
      <Row gap={8}>
        <span className="t-foot" style={{
          flex: 1, minWidth: 0, fontWeight: 700, color: "var(--ink)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{line.category}</span>
        <span style={{
          flexShrink: 0, fontSize: 12, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
          color: line.breached ? TONE.error.fg : "var(--ink)", fontWeight: 700,
        }}>
          {usd(line.spentUsd)}
          {line.capUsd !== null && <span style={{ color: "var(--faint)", fontWeight: 500 }}> / {usd(line.capUsd)}</span>}
        </span>
      </Row>

      <div style={{ marginTop: 7 }}>
        {line.capUsd === null ? <NoCeilingBar /> : <Meter pct={line.pctUsed} height={5} />}
      </div>

      <Row gap={6} wrap style={{ marginTop: 7 }}>
        {line.uncapped && <Badge tone="stale">no cap</Badge>}
        {line.breached && <Badge tone="error">over cap</Badge>}
        {line.hardStop && <Badge tone="error" title="Breaching this cap halts the agent.">hard stop</Badge>}
        <span className="stattile-label" style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums", lineHeight: 1.45, whiteSpace: "normal" }}>
          {categoryNote(line, projectable)}
        </span>
      </Row>
    </div>
  );
}

function categoryNote(line, projectable) {
  if (line.uncapped) return "spend with no budget row — nothing bounds it";
  if (line.capUsd === null) return "no cap on this row";
  if (!projectable) return "too early to project";
  if (line.onPace === false) return `projects to ${usd(line.projectedUsd)} · over by ${usd(line.overBy)}`;
  return `projects to ${usd(line.projectedUsd)} of ${usd(line.capUsd)}`;
}

/**
 * Where a meter would go on a category with no cap. A bar needs a denominator;
 * drawing an empty one would read as "0% used — plenty of room", which is the
 * precise opposite of what no cap means.
 */
function NoCeilingBar({ height = 5 }) {
  return (
    <div
      title="No cap set for this spend."
      style={{
        height, borderRadius: 999, boxSizing: "border-box",
        border: `1px solid ${TONE.stale.line}`,
        backgroundImage: `repeating-linear-gradient(45deg, ${TONE.stale.fg} 0 3px, transparent 3px 7px)`,
        opacity: 0.8,
      }}
    />
  );
}

// ─── loading ─────────────────────────────────────────────────────────────────
// Shaped like the answer, and containing no digits at all. A skeleton with a
// placeholder "0" in it is the calm-zero bug wearing a shimmer.
function BudgetSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      <div style={{ borderRadius: 12, border: "1px solid var(--border)", background: "var(--subtle)", padding: "12px 13px", display: "flex", flexDirection: "column", gap: 10 }}>
        <SkeletonLine width="46%" height="20px" />
        <SkeletonLine width="100%" height="8px" />
        <SkeletonLine width="78%" height="13px" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ borderRadius: 10, border: "1px solid var(--border)", padding: "9px 10px", display: "flex", flexDirection: "column", gap: 7, opacity: 1 - i * 0.2 }}>
          <SkeletonLine width="40%" height="12px" />
          <SkeletonLine width="100%" height="5px" />
        </div>
      ))}
    </div>
  );
}

// ─── copy helpers ────────────────────────────────────────────────────────────
const daysText = (d) => (d <= 0 ? "less than a day" : d === 1 ? "1 day" : `${d} days`);

/** Under a day, hours — "0.4 days in" reads as a rounding error, not a reason. */
const elapsedText = (days) => (days < 1 ? `${Math.max(1, Math.round(days * 24))}h` : `${days.toFixed(1)} days`);

const readAge = (ms) => (ms === null ? "never read" : `${shortAge(ms)} ago`);
