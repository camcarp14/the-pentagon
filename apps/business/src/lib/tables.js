// ═══════════════════════════════════════════════════════════════════════════
// How this tab queries the agent project: one entry per source.
//
// schema.sql here was authored, not transcribed — there was no such file to
// read when this tab was built, so the odds that the live agent project
// differs somewhere are not small. Read the next paragraph before relying on
// this file to absorb that difference.
//
// WHAT IS CONTAINED HERE, and it is worth having: every table name, every
// select, the ordering, the limits, the poll cadence, the two realtime flags,
// and the freshness windows. Change `table` or `timeColumn` and the query, the
// sort, the realtime subscription and the panel's staleness chip all follow.
//
// WHAT IS NOT: individual column names in panel and lib logic. This header
// used to claim "no component anywhere in the tab names a table or a timestamp
// column", and that was simply false — there are ~51 hard-coded column
// references across 14 other files (Invariants.jsx, approvals.js, briefing.js
// and Learnings.jsx are the densest). Renaming a column in the agent project
// therefore means grepping, not editing one line. The claim is removed rather
// than the references, because a comment promising containment that does not
// exist is worse than no comment: it is exactly the reassurance someone would
// act on while shipping a broken rename.
//
// `timeColumn` is load-bearing beyond sorting — it is what B3's staleness
// check reads to answer "how old is the newest row", so a wrong value here
// makes a panel claim freshness it can't back up.
//
// ── On maxAgeMin, and why several sit above 45 ─────────────────────────────
// The bar says a panel whose newest row is older than 45 minutes alarms. Taken
// literally and applied to every source, a correctly-configured budget (caps
// written once a month) alarms every day, and an alarm that is always on is an
// alarm nobody reads. So the window is per-source: it is the age at which THIS
// source's data stops being trustworthy, which for the action ledger and the
// watchdog really is 45 minutes.
//
// That substitution is only defensible because it no longer governs SILENCE.
// `maxAgeMin` covers the age of the ROWS; how long the panel may go without
// completing a round trip is `MAX_FETCH_AGE_MIN` in freshness.js — five
// minutes, for every source. Those were once the same number, and sharing them
// meant a hung database could leave the approvals panel calm for 23 hours and
// the budget panel for 45 days. A wide data window must never buy a wide
// silence window.
// ═══════════════════════════════════════════════════════════════════════════

export const SOURCES = {
  config: {
    table: "agent_config",
    select: "*",
    timeColumn: "heartbeat_at",
    single: true,
    maxAgeMin: 45,
    pollMs: 20_000,
  },
  approvals: {
    table: "approvals",
    select: "*",
    timeColumn: "created_at",
    // NEWEST FIRST, and that is a correctness fix rather than a preference.
    // This was `veto_until` ascending — which sorts by EARLIEST deadline, so
    // once the table passed the limit the page held the hundred oldest settled
    // approvals and nothing else. The row expiring in ninety seconds was not in
    // the payload at all: the countdown queue, the "closing within the hour"
    // pin and the fold tile's "next in m:ss" all went silently blank, which is
    // the precise failure B2 exists to prevent. A tier-2 agent filing one
    // approval per action reaches a hundred rows in days.
    //
    // created_at desc is the ordering that always contains what matters: an
    // approval you can still veto, and one that lapsed while you were away,
    // are both by definition recent. Old settled history falls off the end,
    // which costs nothing — partitionApprovals sorts each bucket itself.
    order: { column: "created_at", ascending: false },
    limit: 200,
    // An approvals queue is legitimately empty most of the time — an empty one
    // is good news, not an outage, so it does not alarm on emptiness alone.
    expectsRows: false,
    maxAgeMin: 24 * 60,
    realtime: true,
    pollMs: 30_000,
  },
  budget: {
    table: "budget",
    select: "*",
    timeColumn: "created_at",
    order: { column: "period_start", ascending: false },
    limit: 60,
    // Caps are written once a month. Judging them by a 45-minute window would
    // paint a correctly-configured budget as stale every single day.
    maxAgeMin: 45 * 24 * 60,
    pollMs: 120_000,
  },
  spend: {
    table: "spend_ledger",
    select: "*",
    timeColumn: "spent_at",
    order: { column: "spent_at", ascending: false },
    limit: 500,
    // Spend is bursty; a quiet hour is normal and does not mean the feed died.
    // The heartbeat is what proves the agent is alive, not this.
    expectsRows: false,
    maxAgeMin: 24 * 60,
    pollMs: 60_000,
  },
  actions: {
    table: "action_ledger",
    select: "*",
    timeColumn: "occurred_at",
    order: { column: "occurred_at", ascending: false },
    limit: 200,
    // The strict one. A ticking agent writes here constantly; 45 minutes of
    // silence is the headline symptom of a dead agent.
    maxAgeMin: 45,
    realtime: true,
    pollMs: 30_000,
  },
  hypotheses: {
    table: "hypothesis_queue",
    select: "*",
    timeColumn: "updated_at",
    order: { column: "score", ascending: false },
    limit: 100,
    expectsRows: false,
    maxAgeMin: 24 * 60,
    pollMs: 120_000,
  },
  invariants: {
    table: "invariant_checks",
    select: "*",
    timeColumn: "checked_at",
    order: { column: "checked_at", ascending: false },
    limit: 100,
    // The watchdog's own liveness. A watchdog that stopped reporting is
    // indistinguishable from a passing one unless you watch its clock.
    maxAgeMin: 45,
    pollMs: 60_000,
  },
  learnings: {
    table: "learnings",
    select: "*",
    timeColumn: "learned_at",
    order: { column: "learned_at", ascending: false },
    limit: 100,
    expectsRows: false,
    maxAgeMin: 7 * 24 * 60,
    pollMs: 120_000,
  },
  metrics: {
    table: "metrics_snapshot",
    select: "*",
    timeColumn: "captured_at",
    order: { column: "captured_at", ascending: false },
    limit: 200,
    // Snapshots are expected on a slow cadence; six hours of silence is the
    // point at which the objective function has stopped being observed.
    maxAgeMin: 6 * 60,
    pollMs: 120_000,
  },
};

export const OUTCOMES = ["success", "failure", "blocked", "skipped", "dry_run"];
export const TICK_TYPES = ["heartbeat", "plan", "execute", "observe", "reflect"];

export const AUTONOMY_TIERS = {
  1: { label: "Tier 1 — proposes only", detail: "Every action needs your approval before it happens." },
  2: { label: "Tier 2 — acts with a veto window", detail: "It files an approval and proceeds if you don't stop it in time." },
  3: { label: "Tier 3 — acts freely in budget", detail: "It acts without asking, up to the spend caps." },
};
