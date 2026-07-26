// ═══════════════════════════════════════════════════════════════════════════
// AI Business — the layout.
//
// Designed for the actual usage, which is: every six hours, from a phone, for
// under two minutes. That is not a desk session, and it drives every choice
// here.
//
// B6 — what has to be visible on a 390px screen with no scrolling:
//     agent status · halt button · pending approvals · budget burn vs pace
// Those four live in the command block at the top. Everything else is below it
// or behind a tap. The block is deliberately dense; the panels below are not.
//
// B1 — the halt control is mounted OUTSIDE every error boundary on this page
// and reads through halt.js, which shares no code with the panel stack. The
// <LoaderFault/> markers placed inside the boundaries are what prove it: with
// ?fault=loader the entire shared data layer throws, all of it renders as
// crash blocks, and the halt button keeps working. That is the point of the
// arrangement, not a side effect of it.
// ═══════════════════════════════════════════════════════════════════════════
import { useEffect, useRef, useState } from "react";
import { AgentDataProvider, useNow, useSource, LoaderFault } from "./lib/AgentData.jsx";
import { useConfirmedConfig, StatusAndHalt } from "./components/HaltControl.jsx";
import GoalEditor from "./components/GoalEditor.jsx";
import { Boundary, Btn, Row, TONE } from "./components/primitives.jsx";
import { PANEL } from "./lib/freshness.js";
import { partitionApprovals, readLastVisit, writeLastVisit } from "./lib/approvals.js";
import { budgetSummary } from "./lib/budget.js";
import { countdown, usd } from "./lib/format.js";
import { agentAuth } from "./lib/agentClient.js";

import Approvals from "./components/panels/Approvals.jsx";
import Budget from "./components/panels/Budget.jsx";
import BriefingCard from "./components/panels/BriefingCard.jsx";
import Hypotheses from "./components/panels/Hypotheses.jsx";
import ActionLedger from "./components/panels/ActionLedger.jsx";
import Invariants from "./components/panels/Invariants.jsx";
import Learnings from "./components/panels/Learnings.jsx";
import Metrics from "./components/panels/Metrics.jsx";

/** Only count a visit once the tab has actually been looked at. */
const DWELL_BEFORE_VISIT_COUNTS_MS = 8000;

export default function App() {
  const now = useNow(1000);
  const cfg = useConfirmedConfig();

  // Captured ONCE, before anything is written back — every "since your last
  // visit" comparison on this render depends on the old value surviving the
  // whole session.
  const [lastVisitAt] = useState(() => readLastVisit());

  return (
    <AgentDataProvider>
      <VisitStamp />
      <div style={{
        maxWidth: 760, margin: "0 auto",
        padding: "12px 12px calc(28px + var(--safe-bottom, 0px))",
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        {/* ── ABOVE THE FOLD ───────────────────────────────────────────────
            Four things, in one screen, with no scroll. Nothing else goes here
            — every addition pushes one of the four off a small phone. */}
        <StatusAndHalt cfg={cfg} now={now} />

        <Boundary label="The summary tiles">
          <LoaderFault />
          <FoldTiles now={now} lastVisitAt={lastVisitAt} />
        </Boundary>

        {/* ── the fold is here on a 390×664 viewport ────────────────────── */}

        <Boundary label="The goal editor">
          <GoalEditor cfg={cfg} />
        </Boundary>

        <Boundary label="The panel stack">
          <LoaderFault />
          <div className="biz-stack" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Boundary label="Approvals"><Approvals now={now} lastVisitAt={lastVisitAt} /></Boundary>
            <Boundary label="Budget"><Budget now={now} /></Boundary>
            <Boundary label="The card"><BriefingCard now={now} /></Boundary>
            <Boundary label="Hypotheses"><Hypotheses now={now} /></Boundary>
            <Boundary label="The action ledger"><ActionLedger now={now} /></Boundary>
            <Boundary label="Invariants"><Invariants now={now} /></Boundary>
            <Boundary label="Learnings"><Learnings now={now} /></Boundary>
            <Boundary label="Metrics"><Metrics now={now} /></Boundary>
          </div>
        </Boundary>

        <Footer />
      </div>
    </AgentDataProvider>
  );
}

/**
 * Records "you have now seen what the agent did", which is what every
 * auto-proceeded callout is measured against.
 *
 * Time alone is not the condition, and treating it as the condition was a bug
 * with a clean reproduction: open the tab while the database is down, stare at
 * the error screen for eight seconds, close it. The approvals panel never drew
 * a single row — Panel withholds children in the ERROR state when there are no
 * rows to show — yet the visit was stamped anyway. On the next visit, with the
 * database healthy, `veto_until >= lastVisit` filtered the lapsed approval out
 * of the callout and into a grey collapsed "Show 1 earlier auto-proceeded".
 * The agent acted without you and the tab quietly agreed you had reviewed it.
 *
 * So the stamp now requires evidence that the queue was actually READABLE:
 * a successful read (not loading, not error) plus the dwell. If the approvals
 * source never came back, the visit does not count, and the callout is still
 * waiting next time — which is the direction this has to fail in.
 */
function VisitStamp() {
  const approvals = useSource("approvals");
  const marked = useRef(false);
  const readable = approvals.state.state !== PANEL.LOADING && approvals.state.state !== PANEL.ERROR;

  useEffect(() => {
    if (marked.current || !readable) return;
    const t = setTimeout(() => {
      if (!marked.current && document.visibilityState === "visible") {
        marked.current = true;
        writeLastVisit(Date.now());
      }
    }, DWELL_BEFORE_VISIT_COUNTS_MS);
    return () => clearTimeout(t);
  }, [readable]);

  return null;
}

// ─── the two tiles that complete B6 ──────────────────────────────────────────
function FoldTiles({ now, lastVisitAt }) {
  const approvals = useSource("approvals", now);
  const caps = useSource("budget", now);
  const spend = useSource("spend", now);

  const p = partitionApprovals(approvals.rows, { now, lastVisitAt });
  const b = budgetSummary(caps.rows, spend.rows, now);

  // Both tiles must be able to say "I don't know" — a tile that renders 0
  // pending during an outage is the exact failure this tab exists to prevent,
  // and it is most dangerous here, above the fold, where it is most trusted.
  //
  // STALE counts as not-knowing, not just ERROR. Sources poll at different
  // cadences (config 20s, spend 60s, budget 120s), so during an outage the
  // fast ones report it while the slow ones are still holding a successful
  // read from a minute ago. That is honest for a minute — but once a source
  // crosses into "not refreshing" it has stopped being evidence, and a green
  // "on pace" underwritten by a frozen ledger is precisely the confident wrong
  // answer B3 is about.
  const cannotVouch = (st) => st === PANEL.ERROR || st === PANEL.LOADING || st === PANEL.STALE;
  // The note has to name WHICH kind of not-knowing this is — "can't reach the
  // database" over a frozen-but-reachable poller sends the operator after the
  // wrong fault.
  const vouchNote = (...states) => {
    if (states.some((st) => st === PANEL.LOADING)) return "loading…";
    if (states.some((st) => st === PANEL.ERROR)) return "can't reach the database";
    return "not refreshing — this is not current";
  };
  const approvalsBroken = cannotVouch(approvals.state.state);
  const budgetBroken = cannotVouch(caps.state.state) || cannotVouch(spend.state.state);

  const next = p.urgent[0];
  const c = next ? countdown(next.msRemaining) : null;

  const approvalsTone = approvalsBroken ? "error"
    : p.counts.sinceLastVisit > 0 ? "error"
    : p.counts.urgent > 0 ? "stale"
    : p.counts.pending > 0 ? "accent" : "empty";

  // A ledger that returned NO ROWS cannot support a pace verdict, and the
  // green "on pace" it used to produce was the calm zero this whole tab exists
  // to prevent — sitting above the fold, where it is trusted most. PostgREST
  // answers an RLS denial with `200 []`, identical to a genuinely quiet month,
  // and no client can tell them apart. halt.js refuses to read `200 []` as
  // success on the write path; the read path has to be just as sceptical.
  //
  // It is NOT an error either — the 1st of a month legitimately has no spend.
  // So it reports the truth it has: zero recorded, and no verdict.
  const spendEmpty = spend.state.state === PANEL.EMPTY;
  const budgetTone = budgetBroken ? "error"
    : !b.ok ? "error"
    : spendEmpty ? "empty"
    : b.total.breached ? "error"
    : b.total.onPace === false ? "stale"
    : "fresh";

  return (
    <Row gap={10} align="stretch">
      <Tile
        label="Approvals"
        tone={approvalsTone}
        broken={approvalsBroken}
        brokenNote={vouchNote(approvals.state.state)}
        value={p.counts.pending}
        caption={
          // Both facts, when both are true. B2 requires that a lapsed approval
          // and a closing one are each impossible to miss without scrolling —
          // so this tile cannot pick one and drop the other. They are different
          // news: one is "you have four minutes", the other is "it already
          // happened", and collapsing them would hide whichever came second.
          <>
            {p.counts.sinceLastVisit > 0 && (
              <span className="biz-pulse" style={{ display: "block", color: TONE.error.fg, fontWeight: 800 }}>
                {p.counts.sinceLastVisit} went ahead without you
              </span>
            )}
            {next && (
              <span style={{ display: "block", color: TONE.stale.fg, fontWeight: 700, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                next in {c.expired ? "0:00" : c.text}
              </span>
            )}
            {p.counts.sinceLastVisit === 0 && !next && (
              <span style={{ display: "block" }}>
                {p.counts.pending > 0 ? "none closing within the hour" : "nothing waiting"}
              </span>
            )}
          </>
        }
        href="#approvals"
      />
      <Tile
        label="Budget"
        tone={budgetTone}
        broken={budgetBroken}
        brokenNote={vouchNote(caps.state.state, spend.state.state)}
        value={b.ok ? usd(b.total.spentUsd) : "—"}
        caption={
          !b.ok ? "no caps configured"
            : spendEmpty ? `no spend recorded · no pace to judge · ${b.daysRemaining}d left`
            : !b.projectable ? `too early to project · ${b.daysRemaining}d left`
            : b.total.onPace ? `on pace · ${usd(b.total.projectedUsd)} of ${usd(b.total.capUsd)}`
            : `over by ${usd(b.total.overBy)} · ${b.daysRemaining}d left`
        }
      />
    </Row>
  );
}

function Tile({ label, tone, value, caption, broken, brokenNote, href }) {
  const t = TONE[tone] || TONE.empty;
  const inner = (
    <>
      <div style={{
        fontSize: 9.5, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase",
        color: "var(--faint)", fontFamily: "var(--font-mono)", marginBottom: 4,
      }}>{label}</div>
      <div style={{
        fontSize: 22, fontWeight: 800, lineHeight: 1.05, fontFamily: "var(--font-display)",
        color: broken ? t.fg : tone === "empty" ? "var(--muted)" : t.fg,
        fontVariantNumeric: "tabular-nums",
      }}>
        {/* An unknown value is a dash, never a zero. */}
        {broken ? "—" : value}
      </div>
      <div style={{
        fontSize: 10.5, lineHeight: 1.4, marginTop: 4,
        color: broken ? t.fg : "var(--muted)",
        fontWeight: broken ? 700 : 400,
        overflow: "hidden",
      }}>
        {broken ? brokenNote : caption}
      </div>
    </>
  );

  const style = {
    flex: 1, minWidth: 0, textAlign: "left", display: "block",
    background: "var(--surface)", borderRadius: 14, padding: "11px 12px",
    border: `1px solid ${tone === "empty" ? "var(--border)" : t.line}`,
    ...(tone === "empty" ? null : { boxShadow: `inset 3px 0 0 ${t.fg}` }),
    textDecoration: "none", color: "inherit", minHeight: 76,
  };

  return href
    ? <a className="biz-press" href={href} style={style}>{inner}</a>
    : <div style={style}>{inner}</div>;
}

function Footer() {
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, paddingTop: 6 }}>
      <span style={{ fontSize: 10, color: "var(--faint)", lineHeight: 1.5, flex: 1, minWidth: 0 }}>
        Read-only except halt/resume, approve/veto, and the goal — enforced by column grants
        in the agent's database, not by this page.
      </span>
      <Btn size="sm" tone="ghost" busy={busy} onClick={async () => { setBusy(true); await agentAuth.signOut(); }}>
        Sign out
      </Btn>
    </div>
  );
}

