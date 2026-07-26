// ═══════════════════════════════════════════════════════════════════════════
// B2 — approvals cannot expire silently.
//
// Reading order is the whole design, and it is not chronological:
//
//   1. AUTO-PROCEEDED WITHOUT YOU — things whose window lapsed unreviewed
//      since the last visit. The agent already did these. They sit above
//      everything, in the alarm treatment, and they are never merged into
//      history: history is decisions you made, and these are the ones you
//      didn't get to make.
//   2. The countdown queue — pending, deadline inside the hour, soonest
//      first, ticking every second. These are the ones still stoppable.
//   3. Later, then decided history behind a tap.
//
// The countdown is live rather than a rendered timestamp because "veto by
// 09:14" requires arithmetic against a clock you are not looking at, and the
// answer that matters is "you have four minutes".
// ═══════════════════════════════════════════════════════════════════════════
import { useState } from "react";
import { useSource } from "../../lib/AgentData.jsx";
import { partitionApprovals, isDecidable } from "../../lib/approvals.js";
import { decideApproval } from "../../lib/decide.js";
import { countdown, shortAge, usd, clockTime, dayLabel } from "../../lib/format.js";
import { Panel, Btn, Badge, AlarmBlock, Row, ScrollList, TONE } from "../primitives.jsx";

export default function Approvals({ now, lastVisitAt }) {
  const src = useSource("approvals", now);
  const [busyId, setBusyId] = useState(null);
  const [errors, setErrors] = useState({});
  const [showEarlier, setShowEarlier] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const p = partitionApprovals(src.rows, { now, lastVisitAt });

  const decide = async (row, decision) => {
    setBusyId(row.id);
    setErrors((e) => ({ ...e, [row.id]: null }));
    const r = await decideApproval(row.id, decision);
    setBusyId(null);
    if (r.ok) src.refresh();
    else {
      setErrors((e) => ({ ...e, [row.id]: r.message }));
      // An expired race has changed what the queue means — repull so the row
      // moves into the auto-proceeded list where it now belongs.
      if (r.expired) src.refresh();
    }
  };

  const pendingCount = p.counts.pending;

  return (
    <Panel
      id="approvals"
      title="Approvals"
      state={src.state}
      onRetry={src.refresh}
      emptyHeadline="Nothing waiting on you"
      emptyDetail={`No approvals in the queue. The agent files one here when it needs a decision${src.state.fetchAgeMs !== null ? ` — checked ${shortAge(src.state.fetchAgeMs)} ago` : ""}.`}
      right={
        pendingCount > 0 ? (
          <Badge tone={p.counts.urgent > 0 ? "stale" : "accent"}>{pendingCount} pending</Badge>
        ) : null
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* ─── 1. auto-proceeded without you ─────────────────────────────── */}
        {p.sinceLastVisit.length > 0 && (
          <div style={{
            borderRadius: 12, border: `1px solid ${TONE.error.line}`, borderLeft: `3px solid ${TONE.error.fg}`,
            background: TONE.error.bg, padding: "12px 13px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
              <span className="biz-pulse" style={{ width: 7, height: 7, borderRadius: "50%", background: TONE.error.fg, flexShrink: 0 }} />
              <span style={{ fontSize: 12.5, fontWeight: 800, color: TONE.error.fg, fontFamily: "var(--font-display)", letterSpacing: "0.03em" }}>
                AUTO-PROCEEDED WITHOUT YOU · {p.sinceLastVisit.length}
              </span>
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.55, marginBottom: 10 }}>
              {p.sinceLastVisit.length === 1 ? "This decision's" : "These decisions'"} veto window closed while you were away.
              The agent went ahead. You cannot undo {p.sinceLastVisit.length === 1 ? "it" : "them"} here — this is a record, not a queue.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {p.sinceLastVisit.map((row) => <ExpiredRow key={row.id} row={row} now={now} />)}
            </div>
          </div>
        )}

        {p.earlierExpired.length > 0 && (
          <div>
            <Btn size="sm" tone="ghost" onClick={() => setShowEarlier((s) => !s)} style={{ width: "100%" }}>
              {showEarlier ? "Hide" : "Show"} {p.earlierExpired.length} earlier auto-proceeded
            </Btn>
            {showEarlier && (
              <ScrollList maxHeight={260}>
                <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 9 }}>
                  {p.earlierExpired.map((row) => <ExpiredRow key={row.id} row={row} now={now} muted />)}
                </div>
              </ScrollList>
            )}
          </div>
        )}

        {/* ─── 2. the countdown queue ────────────────────────────────────── */}
        {p.urgent.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <SectionLabel tone="stale">Closing within the hour</SectionLabel>
            {p.urgent.map((row) => (
              <PendingRow
                key={row.id} row={row} now={now} urgent
                busy={busyId === row.id} error={errors[row.id]}
                onDecide={decide}
              />
            ))}
          </div>
        )}

        {p.pendingLater.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <SectionLabel>Later</SectionLabel>
            {p.pendingLater.map((row) => (
              <PendingRow
                key={row.id} row={row} now={now}
                busy={busyId === row.id} error={errors[row.id]}
                onDecide={decide}
              />
            ))}
          </div>
        )}

        {/* Nothing pending and nothing expired, but rows exist — say which. */}
        {p.pending.length === 0 && p.sinceLastVisit.length === 0 && p.earlierExpired.length === 0 && (
          <div style={{
            padding: "16px 14px", borderRadius: 12, border: "1px dashed var(--border)", textAlign: "center",
          }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--muted)", fontFamily: "var(--font-display)" }}>Nothing waiting on you</div>
            <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 4 }}>
              {p.decided.length} decided · database reachable, checked {shortAge(src.state.fetchAgeMs)} ago
            </div>
          </div>
        )}

        {/* ─── 3. history, behind a tap ──────────────────────────────────── */}
        {p.decided.length > 0 && (
          <div>
            <Btn size="sm" tone="ghost" onClick={() => setShowHistory((s) => !s)} style={{ width: "100%" }}>
              {showHistory ? "Hide" : "Show"} {p.decided.length} decided
            </Btn>
            {showHistory && (
              <ScrollList maxHeight={300}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 9 }}>
                  {p.decided.map((row) => (
                    <div key={row.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", borderRadius: 9, background: "var(--subtle)", border: "1px solid var(--border)" }}>
                      <Badge tone={row.decision === "approved" ? "fresh" : "empty"}>{row.decision}</Badge>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.title}</span>
                      <span style={{ fontSize: 10, color: "var(--faint)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
                        {dayLabel(row.decided_at || row.created_at)}
                      </span>
                    </div>
                  ))}
                </div>
              </ScrollList>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function SectionLabel({ children, tone }) {
  return (
    <div style={{
      fontSize: 9.5, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase",
      color: tone ? (TONE[tone] || TONE.empty).fg : "var(--faint)", fontFamily: "var(--font-mono)",
    }}>{children}</div>
  );
}

function PendingRow({ row, now, urgent, busy, error, onDecide }) {
  const c = countdown(row.msRemaining);
  const decidable = isDecidable(row, now);
  const tone = urgent ? TONE.stale : TONE.accent;

  return (
    <div style={{
      borderRadius: 12, padding: "11px 12px",
      background: urgent ? tone.bg : "var(--subtle)",
      border: `1px solid ${urgent ? tone.line : "var(--border)"}`,
      ...(urgent ? { borderLeft: `3px solid ${tone.fg}` } : null),
    }}>
      <Row gap={9} align="flex-start">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", lineHeight: 1.4, marginBottom: 3 }}>{row.title}</div>
          {row.summary && (
            <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5, marginBottom: 6 }}>{row.summary}</div>
          )}
          <Row gap={6} wrap>
            {row.kind && <Badge>{row.kind}</Badge>}
            {row.risk_tier >= 2 && <Badge tone={row.risk_tier >= 3 ? "error" : "stale"}>risk {row.risk_tier}</Badge>}
            {Number.isFinite(Number(row.cost_usd)) && Number(row.cost_usd) > 0 && <Badge tone="accent">{usd(Number(row.cost_usd))}</Badge>}
          </Row>
        </div>

        {/* The countdown. Monospaced and tabular so it ticks in place instead
            of nudging the layout every second. */}
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div
            className={urgent && !c.expired ? "biz-pulse" : undefined}
            style={{
              fontSize: urgent ? 20 : 14, fontWeight: 800, lineHeight: 1.1,
              fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
              color: c.expired ? TONE.error.fg : urgent ? tone.fg : "var(--muted)",
            }}
          >{c.text}</div>
          <div style={{ fontSize: 9.5, color: "var(--faint)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
            {row.deadlineUnknown ? "no deadline set" : c.expired ? "went ahead" : `until ${clockTime(row.veto_until)}`}
          </div>
        </div>
      </Row>

      <Row gap={7} style={{ marginTop: 10 }}>
        <Btn size="sm" tone="danger" busy={busy} disabled={!decidable} onClick={() => onDecide(row, "vetoed")} style={{ flex: 1 }}>Veto</Btn>
        <Btn size="sm" tone="good" busy={busy} disabled={!decidable} onClick={() => onDecide(row, "approved")} style={{ flex: 1 }}>Approve</Btn>
      </Row>

      {/* Two different reasons the buttons are dead, and they must not share a
          sentence. A lapsed deadline is a fact — the agent went ahead. An
          unreadable deadline is an absence of fact, and saying "it already
          proceeded" there would invent the very certainty this tab exists to
          refuse. The row is still pinned to the top either way, because a
          deadline we cannot read is one we cannot prove is safe. */}
      {!decidable && !error && (
        <div style={{ fontSize: 10.5, color: TONE.error.fg, marginTop: 7, fontWeight: 600, lineHeight: 1.5 }}>
          {row.deadlineUnknown
            ? "This approval has no readable veto_until, so there is no way to tell whether the agent has acted on it. It cannot be decided from here."
            : "The window has closed — the agent has already proceeded."}
        </div>
      )}
      {error && (
        <div style={{ marginTop: 9 }}>
          <AlarmBlock tone="error" headline="Not recorded" detail={error} />
        </div>
      )}
    </div>
  );
}

function ExpiredRow({ row, now, muted }) {
  const ageMs = row.vetoAtMs === null ? null : now - row.vetoAtMs;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 9, padding: "9px 10px", borderRadius: 9,
      background: muted ? "var(--subtle)" : "color-mix(in srgb, var(--bg) 55%, transparent)",
      border: "1px solid var(--border)",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.title}</div>
        <div style={{ fontSize: 10, color: "var(--faint)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
          proceeded {ageMs === null ? "at an unknown time" : `${shortAge(ageMs)} ago`}
          {Number.isFinite(Number(row.cost_usd)) && Number(row.cost_usd) > 0 ? ` · ${usd(Number(row.cost_usd))}` : ""}
        </div>
      </div>
      {row.kind && <Badge>{row.kind}</Badge>}
    </div>
  );
}
