// ═══════════════════════════════════════════════════════════════════════════
// OPS HEARTBEAT — the walking skeleton for server-side autonomy.
//
// This is the first thing in The Pentagon that can do work with no browser tab
// open. It deliberately does almost nothing: it opens a run, asks the guard for
// permission to take one trivial tier-0 action, records the verdict, and closes
// the run. That is the whole point — it proves the pipeline end to end (schedule
// fires → service-role client → control read → guard → audit row → run closed)
// while having no blast radius at all if any part of it is wrong.
//
// Every real subsystem gets built against this exact shape.
//
// WHY `-background`. Netlify caps ordinary functions at ~10s, a limit this repo
// already works around in three places by handing the remainder back to a
// client loop — which is precisely what reintroduces the tab dependency we are
// removing. The `-background` suffix raises the ceiling to 15 minutes, which is
// what makes a genuinely headless pass possible.
//
// It stays a LOUD NO-OP until SUPABASE_SERVICE_ROLE_KEY is set, and even then
// the seeded control row has enabled=false, so this cannot start acting because
// a deploy happened.
// ═══════════════════════════════════════════════════════════════════════════
import { adminClient, loadGuardState, attempt, startRun, finishRun, MODE, TIER } from './lib/ops-runtime.mjs';

const SUBSYSTEM = 'ops.heartbeat';

export const handler = async () => {
  // One clock for the whole pass. Read once and threaded through everything, so
  // a pass cannot straddle a cap window boundary partway through, and so a
  // simulated run can drive it from outside.
  const now = Date.now();
  let sb, runId = null;

  try {
    sb = adminClient();
  } catch (ex) {
    // Named, visible, and NOT a 200. A containment layer that reports success
    // while being unable to run is the failure mode this whole phase exists to
    // prevent.
    console.error('[ops.heartbeat] cannot start:', ex.message);
    return { statusCode: 500, body: JSON.stringify({ error: ex.message }) };
  }

  try {
    runId = await startRun(sb, SUBSYSTEM, 'schedule', now);
    const state = await loadGuardState(sb, SUBSYSTEM, now);

    const verdict = await attempt(sb, {
      subsystem: SUBSYSTEM,
      action: 'heartbeat',
      tier: TIER.READ,
      state, now, runId,
      trigger: 'netlify schedule */15',
      rationale: 'prove the headless pipeline is alive and the guard is reachable',
      costUsd: 0,
    });

    const acted = verdict.mode === MODE.EXECUTE || verdict.mode === MODE.DRY_RUN;
    await finishRun(sb, runId, {
      ok: true,
      actions: acted ? 1 : 0,
      blocked: verdict.allow ? 0 : 1,
      errors: 0,
      note: `${verdict.mode}: ${verdict.reason}`,
    }, Date.now());

    console.log(`[ops.heartbeat] ${verdict.mode} — ${verdict.reason}`);
    return { statusCode: 200, body: JSON.stringify({ mode: verdict.mode, reason: verdict.reason }) };
  } catch (ex) {
    // A failed pass must still CLOSE its run with ok:false, because that is what
    // the circuit breaker counts. A pass that dies without closing looks
    // identical to one still in flight, and the breaker would never trip.
    console.error('[ops.heartbeat] failed:', ex.message);
    if (runId) {
      try { await finishRun(sb, runId, { ok: false, errors: 1, note: ex.message }, Date.now()); }
      catch (e2) { console.error('[ops.heartbeat] could not close run:', e2.message); }
    }
    return { statusCode: 500, body: JSON.stringify({ error: ex.message }) };
  }
};
