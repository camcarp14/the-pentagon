// ═══════════════════════════════════════════════════════════════════════════
// The card — the six-hour briefing.
//
// There is no `briefings` table, and there should not be: a stored summary is
// a thing that can go stale independently of the facts it summarises, which is
// exactly the class of lie this tab is built to prevent. The card is DERIVED
// on every render from the same rows the panels below it show, so it cannot
// disagree with them.
//
// It answers, in this order, the four questions worth two minutes:
//   what did it do · what moved · what did it learn · what is it stuck on
// ═══════════════════════════════════════════════════════════════════════════

import { toMs } from "./format.js";

export const WINDOW_HOURS = 6;

export function composeBriefing({
  actions = [],
  metrics = [],
  learnings = [],
  hypotheses = [],
  approvals = [],
  invariants = [],
  config = null,
  windowHours = WINDOW_HOURS,
  now = Date.now(),
} = {}) {
  const windowStartMs = now - windowHours * 3_600_000;
  const inWindow = (row, col) => {
    const t = toMs(row?.[col]);
    return t !== null && t >= windowStartMs;
  };

  // ─── what it did ───────────────────────────────────────────────────────────
  const windowActions = (actions || []).filter((a) => inWindow(a, "occurred_at"));
  const byOutcome = { success: 0, failure: 0, blocked: 0, skipped: 0, dry_run: 0 };
  let costUsd = 0;
  const byTick = new Map();
  for (const a of windowActions) {
    if (a.outcome in byOutcome) byOutcome[a.outcome] += 1;
    const c = Number(a.cost_usd);
    if (Number.isFinite(c)) costUsd += c;
    byTick.set(a.tick_type || "—", (byTick.get(a.tick_type || "—") || 0) + 1);
  }

  // ─── what moved ────────────────────────────────────────────────────────────
  // Baseline = the last snapshot taken at or before the window opened. Using
  // "the oldest snapshot we happen to have loaded" instead would silently
  // change the meaning of the delta with the page size.
  const snaps = [...(metrics || [])]
    .map((m) => ({ ...m, atMs: toMs(m.captured_at) }))
    .filter((m) => m.atMs !== null)
    .sort((a, b) => a.atMs - b.atMs);

  const latest = snaps.length ? snaps[snaps.length - 1] : null;
  const priorCandidates = snaps.filter((m) => m.atMs <= windowStartMs);
  let baseline = priorCandidates.length
    ? priorCandidates[priorCandidates.length - 1]
    // No snapshot old enough: the oldest we have is the best baseline
    // available, but the window it covers is shorter than advertised — flagged
    // so the card can say so rather than implying six hours of coverage.
    : (snaps.length > 1 ? snaps[0] : null);

  // When the metrics writer stops, EVERY snapshot we hold can predate the
  // window — and then "the last one at or before the window start" is the
  // latest row itself. Diffing a row against itself yields a 0 for every
  // metric, and because priorCandidates was non-empty the card also suppressed
  // its "baseline doesn't cover the window" note: a calm "nothing moved" for a
  // window in which nothing was measured. No baseline is the honest answer.
  const allPredateWindow = baseline !== null && baseline === latest;
  if (allPredateWindow) baseline = null;

  const deltas = ["objective", "mrr_usd", "customers", "trials", "conversion"]
    .map((key) => {
      const to = num(latest?.[key]);
      const from = num(baseline?.[key]);
      if (to === null) return null;
      const delta = from === null ? null : to - from;
      return {
        key,
        from,
        to,
        delta,
        pct: from !== null && from !== 0 && delta !== null ? delta / Math.abs(from) : null,
      };
    })
    .filter(Boolean);

  const baselineCoversWindow = baseline !== null && priorCandidates.length > 0;

  // Two different situations end with no baseline and the card has to name the
  // right one — it used to be able to assume "no baseline" meant "one snapshot
  // ever", and saying that over eight snapshots from a writer that stopped ten
  // hours ago is both false and a way of burying the actual news.
  const baselineReason = baseline !== null
    ? null
    : allPredateWindow ? "all_predate_window"
      : snaps.length ? "single_snapshot" : "no_snapshots";

  // ─── what it learned ───────────────────────────────────────────────────────
  const newLearnings = (learnings || [])
    .filter((l) => inWindow(l, "learned_at"))
    .sort((a, b) => (toMs(b.learned_at) ?? 0) - (toMs(a.learned_at) ?? 0));

  // ─── what it wants next ────────────────────────────────────────────────────
  const queued = (hypotheses || [])
    .filter((h) => h.status === "queued" || h.status === "running")
    .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
  const wantsNext = queued.slice(0, 3);

  // ─── what it's blocked on ──────────────────────────────────────────────────
  const blockedOn = [];
  if (config?.halted) {
    blockedOn.push({
      type: "halted",
      label: "You halted it",
      detail: config.halt_reason || "No reason recorded.",
      severity: "critical",
    });
  }
  for (const a of approvals || []) {
    if (a.decision === "pending" && (toMs(a.veto_until) ?? 0) > now) {
      blockedOn.push({ type: "approval", label: a.title, detail: a.summary || "Waiting on your decision.", severity: "warn", id: a.id });
    }
  }
  for (const h of hypotheses || []) {
    if (h.status === "blocked") {
      blockedOn.push({ type: "hypothesis", label: h.title, detail: h.blocked_reason || "Blocked, no reason recorded.", severity: "warn", id: h.id });
    }
  }
  const failingChecks = (invariants || []).filter((i) => i.passed === false);
  for (const i of failingChecks.slice(0, 5)) {
    blockedOn.push({ type: "invariant", label: i.name, detail: i.detail || "Check failing.", severity: i.severity === "critical" ? "critical" : "warn", id: i.id });
  }

  const failedActions = windowActions.filter((a) => a.outcome === "failure");

  return {
    windowHours,
    windowStartMs,
    actionCount: windowActions.length,
    byOutcome,
    byTick: [...byTick.entries()].map(([tick, count]) => ({ tick, count })).sort((a, b) => b.count - a.count),
    costUsd,
    failedActions: failedActions.slice(0, 5),
    deltas,
    latestSnapshotAtMs: latest?.atMs ?? null,
    baselineAtMs: baseline?.atMs ?? null,
    baselineCoversWindow,
    baselineReason,
    newLearnings,
    wantsNext,
    blockedOn,
    // The one-line answer, for the moment there is only time for one line.
    headline: headlineFor({ config, windowActions, failedActions, blockedOn }),
  };
}

function headlineFor({ config, windowActions, failedActions, blockedOn }) {
  if (config?.halted) return "Halted — it is not doing anything.";
  if (windowActions.length === 0) return "No actions in the window. Either it is idle or it stopped.";
  if (failedActions.length > 0) return `${windowActions.length} actions, ${failedActions.length} failed.`;
  const waiting = blockedOn.filter((b) => b.type === "approval").length;
  if (waiting > 0) return `${windowActions.length} actions, ${waiting} waiting on you.`;
  return `${windowActions.length} actions, all clean.`;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
