// ═══════════════════════════════════════════════════════════════════════════
// Panel 7 — the watchdog's own vital signs.
//
// schema.sql names the trap this panel is built around: a canary that stops
// REPORTING is indistinguishable from a canary that is passing, because both
// of them write nothing. So no line here asks "did it pass" without also
// asking "when did it last say so", and the two answers are kept in different
// colours — failing is red, absent is amber — because they are different jobs.
// A failing check means fix the thing it watches. A silent check means fix the
// watcher, and until that happens every other line on this panel is a claim
// about the past wearing the present tense.
//
// The table is an append-only log: forty runs of one canary are forty rows.
// Rendered literally that buries five checks under the chattiest one, so rows
// are reduced to the LATEST result per name — one line per check, saying what
// it reports now and how long ago it reported it.
//
// The history is kept anyway, because "currently passing" is not "fine": a
// check that failed three times in the window and passes on this read is
// intermittent, and intermittent is worse than broken — it is the fault that
// will have tidied itself away by the time you look. Hence a flap count on the
// line itself, and the last ten failures across every name below the list with
// their timestamps and detail.
//
// The one number this panel is not allowed to invent is its own liveness, so
// the per-check silence threshold is read from tables.js rather than typed
// here: the window a check is judged by and the window the PANEL is judged by
// are the same 45 minutes, and they cannot drift apart into a panel that calls
// itself fresh over checks it calls stale.
// ═══════════════════════════════════════════════════════════════════════════
import { useMemo } from "react";
import { useSource } from "../../lib/AgentData.jsx";
import { PANEL, MAX_AGE_MIN } from "../../lib/freshness.js";
import { shortAge, toMs, clockTime, dayLabel } from "../../lib/format.js";
import { Panel, Badge, Row, ScrollList, TONE } from "../primitives.jsx";
import { SkeletonLine } from "@cc/ui";

// Three states, and the middle one is the reason the file exists.
//   failing  — it ran, and it said no.
//   silent   — it has not run inside the window. Nothing it last said is
//              evidence about now, whatever that was.
//   passing  — it ran inside the window, and it said yes.
const RANK = { failing: 0, silent: 1, passing: 2 };
const TONE_FOR = { failing: TONE.error, silent: TONE.stale, passing: TONE.fresh };
const LABEL_FOR = { failing: "failing", silent: "not reporting", passing: "passing" };

// severity orders the failures against each other and nothing else. A passing
// check's severity describes a hypothetical, and colouring hypotheticals is how
// a palette stops meaning anything.
const SEV = { critical: 0, warn: 1, info: 2 };
const sevRank = (s) => (s in SEV ? SEV[s] : 1.5);

export default function Invariants({ now }) {
  const src = useSource("invariants", now);
  const windowMin = src.spec?.maxAgeMin ?? MAX_AGE_MIN;
  const windowMs = windowMin * 60_000;

  // Keyed on rows alone: the reduction contains no clock, and rebuilding a Map
  // over a hundred rows every second because a countdown ticked somewhere else
  // on the page is battery spent to produce the identical object.
  const checks = useMemo(() => digest(src.rows), [src.rows]);
  const watchdog = useMemo(() => newestWatchdog(src.rows), [src.rows]);
  const failures = useMemo(() => recentFailures(src.rows), [src.rows]);

  // Classification and sort DO move with the clock — a check crosses from
  // passing into not-reporting without anyone writing a row, which is exactly
  // the transition this panel is here to catch. Cheap enough to redo per tick.
  const lines = checks
    .map((c) => classify(c, now, windowMs))
    .sort(compareLines);

  const counts = { passing: 0, failing: 0, silent: 0 };
  for (const l of lines) counts[l.status] += 1;

  const problems = lines.filter((l) => l.status !== "passing");
  const passing = lines.filter((l) => l.status === "passing");

  // Panel draws `summary` outside its state switch, so it is the one place a
  // number could escape B3's chrome. Built per state for that reason: "0
  // failing" is worth saying out loud, but only once the panel has established
  // that it reached the database — the same digit under a skeleton is the calm
  // zero this tab exists to prevent. ERROR and STALE force the panel open and
  // have no collapsed line to fill.
  const summary = (() => {
    switch (src.state.state) {
      case PANEL.LOADING: return "Checking the checks…";
      case PANEL.EMPTY: return "No check has reported — the table is reachable and holds nothing.";
      case PANEL.FRESH: return <CountLine counts={counts} />;
      default: return null;
    }
  })();

  return (
    <Panel
      id="invariants"
      title="Invariants"
      state={src.state}
      onRetry={src.refresh}
      skeleton={<ChecksSkeleton />}
      collapsible
      defaultOpen={false}
      summary={summary}
      emptyHeadline="Nothing is checking anything"
      emptyDetail={`The invariant table is reachable and genuinely holds no rows${
        src.state.fetchAgeMs !== null ? ` — checked ${shortAge(src.state.fetchAgeMs)} ago` : ""
      }. No canary, no watchdog, no invariant has ever reported here. An empty checks table is not a clean bill of health; it is the absence of anyone taking a temperature.`}
      // Gated on the calm state: Panel draws `right` in the error chrome too,
      // and a count from the last good read sitting in the header during an
      // outage is a stale number borrowing the header's authority.
      right={
        src.state.state === PANEL.FRESH
          ? counts.failing > 0
            ? <Badge tone="error">{counts.failing} failing</Badge>
            : counts.silent > 0
              ? <Badge tone="stale">{counts.silent} silent</Badge>
              : null
          : null
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* ─── is anything even checking? ────────────────────────────────────
            First, above the checks, because it is the question every line below
            depends on. A per-check "passing 3m ago" is only meaningful if the
            machinery that writes those rows is still running at all. */}
        <WatchdogBlock watchdog={watchdog} now={now} windowMs={windowMs} windowMin={windowMin} loaded={src.rows.length} />

        {/* ─── problems, above the scroll ────────────────────────────────────
            Hoisted out of the list for the same reason blocked hypotheses are:
            a panel that opens collapsed must not be able to hide its bad news
            one thumb-flick below the fold. */}
        {problems.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <SectionLabel tone={counts.failing > 0 ? "error" : "stale"}>
              Wants attention · {problems.length}
            </SectionLabel>
            <Group cap={problems.length > 4} maxHeight={320}>
              {problems.map((l) => <CheckRow key={l.name} line={l} />)}
            </Group>
          </div>
        )}

        {/* ─── everything that reported and passed ───────────────────────── */}
        {passing.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <SectionLabel>Passing · {passing.length}</SectionLabel>
            {problems.length === 0 && (
              <div className="t-cap" style={{ color: "var(--muted)", lineHeight: 1.55 }}>
                Every check on record reported inside the last {windowMin} minutes, and every one of them passed. That is a
                statement about {passing.length} named check{passing.length === 1 ? "" : "s"} — not about anything that has
                never written a row here.
              </div>
            )}
            <Group cap={passing.length > 5} maxHeight={300}>
              {passing.map((l) => <CheckRow key={l.name} line={l} />)}
            </Group>
          </div>
        )}

        {/* ─── the history ──────────────────────────────────────────────────
            Below the current state, never merged into it. A line up there says
            what a check reports now; these say what it has been doing, which is
            the only way an intermittent fault is visible at all. */}
        <FailureHistory failures={failures} now={now} loaded={src.rows.length} />
      </div>
    </Panel>
  );
}

// ─── the watchdog ────────────────────────────────────────────────────────────
function WatchdogBlock({ watchdog, now, windowMs, windowMin, loaded }) {
  const ageMs = watchdog ? now - watchdog.atMs : null;
  const silent = watchdog === null || ageMs > windowMs;
  const failed = watchdog?.row?.passed === false;
  // Absence outranks failure here. A watchdog that reported a failure at least
  // reported; one that has gone quiet has taken the whole panel's evidence with
  // it, so the amber wins the frame and the red goes on a badge inside it.
  const t = silent ? TONE.stale : failed ? TONE.error : TONE.fresh;

  return (
    <div style={{
      borderRadius: 12, padding: "11px 12px",
      background: silent || failed ? t.bg : "var(--subtle)",
      border: `1px solid ${silent || failed ? t.line : "var(--border)"}`,
      ...(silent || failed ? { borderLeft: `3px solid ${t.fg}` } : null),
    }}>
      <SectionLabel tone={silent ? "stale" : failed ? "error" : undefined}>Last watchdog run</SectionLabel>

      {watchdog === null ? (
        <div className="t-cap" style={{ color: TONE.stale.fg, lineHeight: 1.55, marginTop: 5, fontWeight: 600 }}>
          Not one of the {loaded} loaded result{loaded === 1 ? "" : "s"} has kind “watchdog”. Nothing on record is checking
          the checks, so every state below is self-reported by the things being watched.
        </div>
      ) : (
        <>
          <Row gap={10} align="flex-start" style={{ marginTop: 6 }}>
            <span
              className={silent ? "biz-pulse" : undefined}
              style={{
                fontSize: 22, fontWeight: 800, lineHeight: 1.05, flexShrink: 0,
                fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
                color: silent ? TONE.stale.fg : "var(--ink)",
              }}
            >{shortAge(ageMs)}</span>
            <div style={{ flex: 1, minWidth: 0, paddingTop: 3 }}>
              <div className="t-cap" style={{
                fontWeight: 700, color: "var(--ink)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>{watchdog.row?.name || "(unnamed watchdog)"}</div>
              <div className="stattile-label" style={{
                color: "var(--faint)", marginTop: 2,
                fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
              }}>{dayLabel(watchdog.row?.checked_at)} · {clockTime(watchdog.row?.checked_at)}</div>
            </div>
            {failed && <Badge tone="error">failed</Badge>}
          </Row>

          {/* The age is the headline, so it gets a sentence rather than a
              colour alone — "2h" is only alarming if you already know the
              window it blew through. */}
          <div className="t-cap" style={{ color: silent ? TONE.stale.fg : "var(--muted)", lineHeight: 1.55, marginTop: 8 }}>
            {silent
              ? `Longer than the ${windowMin}-minute window. The watchdog itself has stopped reporting, which makes the checks below unverified rather than clean.`
              : `Inside the ${windowMin}-minute window — something is still running the checks.`}
          </div>

          {failed && watchdog.row?.detail && (
            <div className="t-cap" style={{ color: "var(--muted)", lineHeight: 1.55, marginTop: 6 }}>{watchdog.row.detail}</div>
          )}
        </>
      )}
    </div>
  );
}

// ─── one check, one line ─────────────────────────────────────────────────────
function CheckRow({ line }) {
  const bad = line.status !== "passing";
  const t = TONE_FOR[line.status];
  const row = line.latest || {};

  return (
    <div style={{
      padding: "10px 11px", borderRadius: 11,
      background: bad ? t.bg : "var(--subtle)",
      border: `1px solid ${bad ? t.line : "var(--border)"}`,
      ...(bad ? { borderLeft: `3px solid ${t.fg}` } : null),
    }}>
      <Row gap={9} align="flex-start">
        <span style={{
          width: 7, height: 7, borderRadius: "50%", flexShrink: 0, marginTop: 5,
          background: t.fg,
        }} />

        <span
          title={line.name}
          className="t-foot"
          style={{
            flex: 1, minWidth: 0, fontWeight: 700, lineHeight: 1.4,
            color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
        >{line.name}</span>

        {/* Age is coloured by SILENCE, never by the verdict. A failing check
            that answered ten seconds ago is current information about a broken
            thing; the amber is reserved for the case where the information
            itself has expired. */}
        <span style={{ flexShrink: 0, textAlign: "right" }}>
          <span style={{
            display: "block", fontSize: 13, fontWeight: 800, lineHeight: 1.1,
            fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
            color: line.status === "silent" ? TONE.stale.fg : "var(--muted)",
          }}>{line.ageMs === null ? "—" : shortAge(line.ageMs)}</span>
          {/* .stattile-label — the kit's 10.5px caption under a number. This
              was 8.5px, and the uppercase went with it: uppercase belongs only
              to .t-label, and the words are already lower case in source. */}
          <span className="stattile-label" style={{
            display: "block", color: "var(--faint)", fontFamily: "var(--font-mono)", marginTop: 2,
          }}>{line.ageMs === null ? "undated" : "ago"}</span>
        </span>
      </Row>

      <Row gap={6} wrap style={{ marginTop: 8 }}>
        <Badge tone={line.status === "failing" ? "error" : line.status === "silent" ? "stale" : "fresh"}>
          {LABEL_FOR[line.status]}
        </Badge>

        {row.kind && <Badge>{row.kind}</Badge>}

        {/* Only on the rows where it changes what you'd do first: which failure
            to open, which silence to chase. */}
        {bad && row.severity && (
          <Badge tone={row.severity === "critical" ? "error" : row.severity === "warn" ? "stale" : "empty"}>
            {row.severity}
          </Badge>
        )}

        {/* The whole argument for keeping history. A green line with this badge
            on it is not the same green line without it. */}
        {line.status === "passing" && line.failures > 0 && (
          <Badge tone="stale" title="It passes right now, and it did not pass every time in this window.">
            flapped ×{line.failures}
          </Badge>
        )}

        <span className="t-cap" style={{
          marginLeft: "auto", color: "var(--faint)",
          fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", flexShrink: 0,
        }}>{line.runs} run{line.runs === 1 ? "" : "s"}</span>
      </Row>

      {/* detail is the actionable half of a bad row — the same argument that
          keeps blocked_reason out from behind a tap in the hypothesis queue.
          On a passing row it is commentary, and it is left off. */}
      {bad && (
        <div style={{
          marginTop: 8, padding: "8px 9px", borderRadius: 9,
          background: "color-mix(in srgb, var(--bg) 45%, transparent)",
          border: `1px solid ${t.line}`,
        }}>
          <div className="t-label" style={{ color: t.fg, fontFamily: "var(--font-mono)" }}>
            {line.status === "failing" ? "What it reported" : "Last thing it said, before it went quiet"}
          </div>
          <div className="t-cap" style={{ color: row.detail ? "var(--muted)" : t.fg, lineHeight: 1.55, marginTop: 3 }}>
            {row.detail || (line.status === "failing"
              ? "No detail recorded — the check says it failed and does not say what it saw, which is the least actionable form a failure can take."
              : `Its last result was “${row.passed === false ? "failed" : "passed"}”, and that is the only thing on record. It has not run since.`)}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── the failure history ─────────────────────────────────────────────────────
function FailureHistory({ failures, now, loaded }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionLabel>Recent failures</SectionLabel>

      {failures.length === 0 ? (
        // Deliberately not an EmptyBlock: the dashed frame is this tab's phrase
        // for "the database is reachable and truly holds nothing", and the
        // database plainly holds rows — it holds `loaded` of them. This states
        // its sample size instead, because "no failures" over the last hundred
        // results is a narrower claim than "no failures", and the narrow one is
        // the true one.
        <div className="t-cap" style={{ color: "var(--muted)", lineHeight: 1.55 }}>
          None of the {loaded} most recent result{loaded === 1 ? "" : "s"} failed. Older failures may exist beyond that
          window — this is the loaded history, not the whole log.
        </div>
      ) : (
        <>
          <div className="t-cap" style={{ color: "var(--muted)", lineHeight: 1.55 }}>
            The last {failures.length} failed result{failures.length === 1 ? "" : "s"} across every check, including ones
            that pass right now. A fault that comes and goes is the one you will never be looking at when it happens.
          </div>
          <ScrollList maxHeight={280}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {failures.map((r, i) => <FailureRow key={r.id ?? `f${i}`} row={r} now={now} />)}
            </div>
          </ScrollList>
        </>
      )}
    </div>
  );
}

function FailureRow({ row, now }) {
  const atMs = toMs(row?.checked_at);
  const ageMs = atMs === null ? null : now - atMs;

  return (
    <div style={{
      padding: "9px 10px", borderRadius: 9,
      background: "var(--subtle)", border: "1px solid var(--border)",
      borderLeft: `2px solid ${TONE.error.line}`,
    }}>
      <Row gap={9} align="flex-start">
        <span
          title={row?.name || undefined}
          className="t-cap"
          style={{
            flex: 1, minWidth: 0, fontWeight: 700, color: "var(--ink)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
        >{row?.name || "(unnamed check)"}</span>
        <span style={{ flexShrink: 0, textAlign: "right" }}>
          <span className="stattile-label" style={{
            display: "block", fontWeight: 700, color: "var(--muted)",
            fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
          }}>{ageMs === null ? "undated" : `${shortAge(ageMs)} ago`}</span>
          <span className="stattile-label" style={{
            display: "block", color: "var(--faint)", marginTop: 1,
            fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
          }}>{dayLabel(row?.checked_at)} {clockTime(row?.checked_at)}</span>
        </span>
      </Row>
      {row?.detail && (
        <div className="t-cap" style={{ color: "var(--muted)", lineHeight: 1.5, marginTop: 5 }}>{row.detail}</div>
      )}
      <Row gap={6} wrap style={{ marginTop: 6 }}>
        {row?.kind && <Badge>{row.kind}</Badge>}
        {row?.severity && (
          <Badge tone={row.severity === "critical" ? "error" : row.severity === "warn" ? "stale" : "empty"}>
            {row.severity}
          </Badge>
        )}
      </Row>
    </div>
  );
}

// ─── bits ────────────────────────────────────────────────────────────────────
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

/** The collapsed line. Bad news leads; zeros are kept so "0 failing" is sayable. */
function CountLine({ counts }) {
  const parts = [
    counts.failing > 0 && { k: "f", text: `${counts.failing} failing`, fg: TONE.error.fg },
    counts.silent > 0 && { k: "s", text: `${counts.silent} not reporting`, fg: TONE.stale.fg },
    { k: "p", text: `${counts.passing} passing`, fg: counts.passing > 0 ? TONE.fresh.fg : undefined },
    counts.failing === 0 && { k: "f0", text: "0 failing" },
    counts.silent === 0 && { k: "s0", text: "0 not reporting" },
  ].filter(Boolean);

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

// Shaped like a watchdog block over a check list, and containing no digits at
// all — a skeleton with a placeholder count in it is the calm zero in a shimmer.
function ChecksSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{
        borderRadius: 12, border: "1px solid var(--border)", padding: "11px 12px",
        display: "flex", flexDirection: "column", gap: 8,
      }}>
        <SkeletonLine width="38%" height="9px" />
        <SkeletonLine width="62%" height="20px" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{
          borderRadius: 11, border: "1px solid var(--border)", padding: "10px 11px",
          display: "flex", flexDirection: "column", gap: 8, opacity: 1 - i * 0.22,
        }}>
          <SkeletonLine width="72%" height="13px" />
          <SkeletonLine width="40%" height="10px" />
        </div>
      ))}
    </div>
  );
}

// ─── the reduction ───────────────────────────────────────────────────────────

/**
 * Forty rows of one canary become one entry: its newest result, how many times
 * it ran in the loaded window, and how many of those runs failed.
 *
 * The newest row is found by comparing timestamps rather than trusting the
 * query's ORDER BY. tables.js owns that order and is free to change it; a
 * reduction that quietly assumed it would go on rendering a plausible line with
 * the wrong result in it, which is the failure mode with no symptom.
 */
function digest(rows) {
  const byName = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const raw = typeof r?.name === "string" ? r.name.trim() : "";
    const name = raw || "(unnamed check)";
    const t = toMs(r?.checked_at);

    let e = byName.get(name);
    if (!e) {
      e = { name, runs: 0, failures: 0, latest: null, latestMs: null };
      byName.set(name, e);
    }
    e.runs += 1;
    if (r?.passed === false) e.failures += 1;

    if (t !== null && (e.latestMs === null || t > e.latestMs)) { e.latestMs = t; e.latest = r; }
    // A row with an unreadable timestamp still gets the check onto the screen.
    // Dropping it would delete a check from the list entirely, and a check that
    // is missing from the list is a check nobody is worried about.
    else if (e.latest === null) e.latest = r;
  }
  return [...byName.values()];
}

function classify(entry, now, windowMs) {
  const ageMs = entry.latestMs === null ? null : Math.max(0, now - entry.latestMs);
  // An undatable row is treated as silence, matching freshness.js: we cannot
  // prove it reported recently, so we do not claim it did.
  const silent = ageMs === null || ageMs > windowMs;
  const failed = entry.latest?.passed === false;
  return { ...entry, ageMs, status: failed ? "failing" : silent ? "silent" : "passing" };
}

/**
 * failing → not reporting → passing, and inside each band the order answers a
 * different question. Failures sort by severity then recency, because you open
 * the worst one first. Silences sort longest-first, because the check that went
 * quiet yesterday is likelier dead than the one that missed a tick. Passing
 * sorts by NAME, not by age: a green list that reshuffles itself every second
 * as timestamps tick is a list you cannot keep your place in.
 */
function compareLines(a, b) {
  if (RANK[a.status] !== RANK[b.status]) return RANK[a.status] - RANK[b.status];

  if (a.status === "failing") {
    const s = sevRank(a.latest?.severity) - sevRank(b.latest?.severity);
    if (s !== 0) return s;
    return (b.latestMs ?? -Infinity) - (a.latestMs ?? -Infinity);
  }

  if (a.status === "silent") {
    // Undated first: not knowing when it last spoke is worse than knowing it
    // was a long time ago.
    if (a.latestMs === null || b.latestMs === null) return (a.latestMs === null ? 0 : 1) - (b.latestMs === null ? 0 : 1);
    return a.latestMs - b.latestMs;
  }

  return a.name.localeCompare(b.name);
}

/** The newest watchdog row across every name — "is anything even checking?". */
function newestWatchdog(rows) {
  let row = null;
  let atMs = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.kind !== "watchdog") continue;
    const t = toMs(r?.checked_at);
    if (t === null) continue;
    if (atMs === null || t > atMs) { atMs = t; row = r; }
  }
  return row === null ? null : { row, atMs };
}

/** Every failed result in the loaded window, newest first, capped at ten. */
function recentFailures(rows, limit = 10) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r?.passed === false)
    .sort((a, b) => (toMs(b?.checked_at) ?? -Infinity) - (toMs(a?.checked_at) ?? -Infinity))
    .slice(0, limit);
}
