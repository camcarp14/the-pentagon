// ═══════════════════════════════════════════════════════════════════════════
// The ONE place the agent project's column names appear.
//
// schema.sql in this repo was authored, not transcribed — there was no such
// file to read when this tab was built. So the odds that the live agent
// project differs somewhere are not small, and the cost of that difference has
// been contained to this file: no component anywhere in the tab names a table
// or a timestamp column. Change a name here and the panel, its freshness
// chip, its realtime subscription and its sort order all follow.
//
// `timeColumn` is load-bearing beyond sorting — it is what B3's staleness
// check reads to answer "how old is the newest row", so a wrong value here
// makes a panel claim freshness it can't back up.
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
    order: { column: "veto_until", ascending: true },
    limit: 100,
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

/** Column names that appear in write paths, kept beside the read schema. */
export const COLUMNS = {
  config: { halted: "halted", reason: "halt_reason", goal: "goal", tier: "autonomy_tier", heartbeat: "heartbeat_at" },
  approvals: { decision: "decision", decidedAt: "decided_at", decidedBy: "decided_by", deadline: "veto_until" },
};

export const OUTCOMES = ["success", "failure", "blocked", "skipped", "dry_run"];
export const TICK_TYPES = ["heartbeat", "plan", "execute", "observe", "reflect"];

export const AUTONOMY_TIERS = {
  1: { label: "Tier 1 — proposes only", detail: "Every action needs your approval before it happens." },
  2: { label: "Tier 2 — acts with a veto window", detail: "It files an approval and proceeds if you don't stop it in time." },
  3: { label: "Tier 3 — acts freely in budget", detail: "It acts without asking, up to the spend caps." },
};
