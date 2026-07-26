// ═══════════════════════════════════════════════════════════════════════════
// OPS RUNTIME — the thin I/O half of the containment layer.
//
// All the judgement lives in @cc/ops/guard.js, which is pure and tested. This
// file only: reads control state, counts recent usage, asks the guard, and
// writes the audit row. Keeping it thin is deliberate — an untested I/O shim is
// acceptable; untested decision logic is not.
//
// SERVICE ROLE. Scheduled functions run with no user session, so they use
// SUPABASE_SERVICE_ROLE_KEY and bypass RLS. That is exactly why the guard runs
// before every write: RLS is not protecting anything on this path, so the
// containment has to.
//
// LOUD FAILURE. Every helper here throws a NAMED error rather than returning
// null. A containment layer that silently degrades to "no limits found, carry
// on" is worse than no containment at all — it would report clean while acting
// without a ceiling.
// ═══════════════════════════════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js';
import { decide, usageInWindow, consecutiveFailures, MODE, TIER } from '@cc/ops';

export { MODE, TIER };

const WINDOW_MS = 3600_000;

/** Service-role client, or a named throw. Never a null that reads as "fine". */
export function adminClient() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [!url && 'VITE_SUPABASE_URL', !key && 'SUPABASE_SERVICE_ROLE_KEY'].filter(Boolean);
  if (missing.length) {
    throw new Error(`OPS_ENV_MISSING: ${missing.join(', ')} — autonomous passes stay off until set`);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Everything the guard needs, in one round trip per table.
 * `now` is threaded through rather than read here, so a simulated run can drive
 * the whole stack from an injected clock.
 */
export async function loadGuardState(sb, subsystem, now = Date.now()) {
  const { data: control, error: cErr } = await sb
    .from('ops_control').select('*').in('key', ['global', subsystem]);
  if (cErr) throw new Error(`OPS_CONTROL_READ_FAILED: ${cErr.message}`);

  const rows = control || [];
  const globalRow = rows.find((r) => r.key === 'global');
  // A missing global row means the kill switch has nothing to read. Fail closed
  // and say so, rather than treating "absent" as "permitted".
  if (!globalRow) throw new Error("OPS_CONTROL_MISSING: no 'global' row — kill switch unreadable, refusing to act");

  const { data: recent, error: aErr } = await sb
    .from('ops_audit_log')
    .select('at, cost_usd, status')
    .eq('subsystem', subsystem)
    .gte('at', new Date(now - WINDOW_MS).toISOString())
    .order('at', { ascending: false })
    .limit(1000);
  if (aErr) throw new Error(`OPS_AUDIT_READ_FAILED: ${aErr.message}`);

  // Only actions that actually happened count against the caps. A blocked
  // attempt costs nothing and must not consume the budget that would let a
  // later legitimate action through.
  const spent = (recent || []).filter((r) => r.status === 'executed' || r.status === 'dry_run');
  const usage = usageInWindow(spent.map((r) => ({ at: r.at, costUsd: r.cost_usd })), now, WINDOW_MS);

  const { data: runs, error: rErr } = await sb
    .from('ops_runs').select('ok').eq('subsystem', subsystem)
    .not('ok', 'is', null).order('started_at', { ascending: false }).limit(10);
  if (rErr) throw new Error(`OPS_RUNS_READ_FAILED: ${rErr.message}`);

  return {
    global: camel(globalRow),
    subsystem: camel(rows.find((r) => r.key === subsystem) || {}),
    actionsThisHour: usage.actions,
    spendUsdThisHour: usage.spendUsd,
    consecutiveFailures: consecutiveFailures(runs || []),
  };
}

/**
 * Ask the guard, write the audit row, and hand back the verdict. The caller
 * only acts when `verdict.mode === MODE.EXECUTE`.
 *
 * The audit row is written for EVERY outcome including blocked — "why did
 * nothing happen last night" is the question this table exists to answer, and
 * it cannot if refusals leave no trace.
 */
export async function attempt(sb, {
  subsystem, action, tier, state, now = Date.now(),
  trigger = null, rationale = null,
  targetTable = null, targetId = null,
  before = null, after = null, undo = null,
  costUsd = 0, runId = null,
}) {
  const verdict = decide({
    tier,
    global: state.global,
    subsystem: state.subsystem,
    actionsThisHour: state.actionsThisHour,
    spendUsdThisHour: state.spendUsdThisHour,
    consecutiveFailures: state.consecutiveFailures,
    costUsd,
    hasUndo: undo != null,
    now,
  });

  const status = verdict.mode === MODE.EXECUTE ? 'executed'
    : verdict.mode === MODE.DRY_RUN ? 'dry_run'
    : verdict.mode === MODE.PREPARE ? 'prepared'
    : 'blocked';

  const { error } = await sb.from('ops_audit_log').insert({
    at: new Date(now).toISOString(),
    subsystem, action, tier, status,
    blocked_by: verdict.blockedBy,
    trigger, rationale,
    target_table: targetTable, target_id: targetId,
    before_data: before, after_data: after, undo,
    // A blocked action spent nothing; recording its would-be cost would let
    // refusals eat the budget.
    cost_usd: status === 'blocked' ? 0 : costUsd,
    run_id: runId,
  });
  if (error) throw new Error(`OPS_AUDIT_WRITE_FAILED: ${error.message}`);

  // Optimistically advance the in-memory counters so a single pass taking many
  // actions is capped correctly without re-reading the table each time.
  if (status === 'executed' || status === 'dry_run') {
    state.actionsThisHour += 1;
    state.spendUsdThisHour += Number(costUsd) || 0;
  }
  return verdict;
}

export async function startRun(sb, subsystem, trigger = 'schedule', now = Date.now()) {
  const { data, error } = await sb.from('ops_runs')
    .insert({ subsystem, trigger, started_at: new Date(now).toISOString() })
    .select('id').single();
  if (error) throw new Error(`OPS_RUN_START_FAILED: ${error.message}`);
  return data.id;
}

export async function finishRun(sb, runId, { ok, actions = 0, blocked = 0, errors = 0, costUsd = 0, note = null }, now = Date.now()) {
  const { error } = await sb.from('ops_runs').update({
    finished_at: new Date(now).toISOString(),
    ok, actions, blocked, errors, cost_usd: costUsd, note,
  }).eq('id', runId);
  if (error) throw new Error(`OPS_RUN_FINISH_FAILED: ${error.message}`);
}

/** Postgres snake_case → the camelCase shape the pure guard expects. Numerics
 *  arrive from PostgREST as strings; the guard coerces them, so they pass
 *  through untouched rather than being parsed twice in two places. */
function camel(row = {}) {
  return {
    enabled: row.enabled,
    dryRun: row.dry_run,
    maxActionsPerHour: row.max_actions_per_hour,
    maxSpendUsdPerHour: row.max_spend_usd_per_hour,
    consecutiveFailureLimit: row.consecutive_failure_limit,
    pausedReason: row.paused_reason,
  };
}
