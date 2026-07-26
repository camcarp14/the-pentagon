// ═══════════════════════════════════════════════════════════════════════════
// ZTS STORE INGESTION — the first subsystem that reads the outside world.
//
// Built against the ops-heartbeat shape exactly: register → open run → ask the
// guard → act → close run. Nothing new is invented here; that is the point of
// having a walking skeleton.
//
// TWO ACTIONS, TWO TIERS, and they are separated on purpose:
//   store.read      tier 0 — a read of Shopify. Costs an API call, changes
//                            nothing anywhere.
//   store.snapshot  tier 1 — writes one row to our own table. Reversible and
//                            internal, so it carries an undo descriptor; the
//                            guard rejects a tier-1 action without one.
//
// Folding these into a single action would have meant picking one tier for two
// genuinely different risks, and the doctrine's tie-break ("one tier stricter")
// would have made every harmless read carry a write's requirements.
//
// INERT THREE TIMES OVER. It needs SUPABASE_SERVICE_ROLE_KEY to start, it needs
// read_orders/read_products scopes that today's token does not have, and its
// ops_control row ships disabled + dry-run. Deploying this cannot make it act.
//
// WHY THIS SUBSYSTEM AND NOT INVENTORY. The plan called for reorder points and
// stockout runway. The store has one active product, inventory tracking OFF,
// and two lifetime orders that were both self-placed and refunded — a reorder
// engine would have been a control system attached to nothing, with a
// maintenance cost forever. What a storefront in this state can actually lose
// silently is the ability to take an order at all, and a real order arriving
// unnoticed. Those are what this watches.
// ═══════════════════════════════════════════════════════════════════════════
import {
  adminClient, loadGuardState, attempt, recordFailure,
  startRun, finishRun, registerSubsystem, MODE, TIER,
} from './lib/ops-runtime.mjs';
import { fetchStoreTruth } from './lib/shopify-read.mjs';
import { buildSnapshot } from '@cc/ops/store.js';

const SUBSYSTEM = 'zts.store';

/** Orders placed by the operator are tests, not revenue. Comma-separated. */
function staffEmails() {
  return (process.env.ZTS_STAFF_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** UTC day key. The store's own timezone is America/Chicago, but a snapshot
 *  keyed on shifting local days makes "yesterday" ambiguous twice a year; the
 *  captured_at timestamp keeps the exact moment either way. */
function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

export const handler = async () => {
  const now = Date.now();
  let sb, runId = null;

  try {
    sb = adminClient();
  } catch (ex) {
    console.error('[zts.store] cannot start:', ex.message);
    return { statusCode: 500, body: JSON.stringify({ error: ex.message }) };
  }

  try {
    await registerSubsystem(sb, SUBSYSTEM);
    runId = await startRun(sb, SUBSYSTEM, 'schedule', now);
    const state = await loadGuardState(sb, SUBSYSTEM, now);

    // ── 1. May we read Shopify at all? ──────────────────────────────────────
    const readVerdict = await attempt(sb, {
      subsystem: SUBSYSTEM,
      action: 'store.read',
      tier: TIER.READ,
      state, now, runId,
      trigger: 'netlify schedule 0 */6',
      rationale: 'pull active products and recent orders to check the store can still take money',
      costUsd: 0,
    });

    if (!readVerdict.allow) {
      await finishRun(sb, runId, {
        ok: true, actions: 0, blocked: 1, errors: 0,
        note: `read blocked: ${readVerdict.reason}`,
      }, Date.now());
      console.log(`[zts.store] blocked — ${readVerdict.reason}`);
      return { statusCode: 200, body: JSON.stringify({ mode: readVerdict.mode, reason: readVerdict.reason }) };
    }

    // ── 2. Read. ────────────────────────────────────────────────────────────
    // A dry run still reads: the read is the harmless half, and letting it
    // happen is what makes dry-run mode a real rehearsal instead of a no-op
    // that proves nothing about whether the credentials work.
    let truth;
    try {
      truth = await fetchStoreTruth({ orderCount: 50, productCount: 50 });
    } catch (ex) {
      // Correct the 'executed' row written a moment ago, so the log does not
      // claim a read that never returned.
      await recordFailure(sb, {
        subsystem: SUBSYSTEM, action: 'store.read', tier: TIER.READ,
        error: ex, runId, trigger: 'netlify schedule 0 */6', now: Date.now(),
      });
      throw ex;
    }

    const snapshot = buildSnapshot({
      products: truth.products,
      orders: truth.orders,
      now,
      staffEmails: staffEmails(),
    });

    // ── 3. May we persist it? ───────────────────────────────────────────────
    const day = dayKey(now);
    const writeVerdict = await attempt(sb, {
      subsystem: SUBSYSTEM,
      action: 'store.snapshot',
      tier: TIER.REVERSIBLE,
      state, now, runId,
      trigger: 'netlify schedule 0 */6',
      rationale: `persist the ${day} store snapshot: ${snapshot.activeProducts} active product(s), ${snapshot.blockedProducts} blocked, ${snapshot.orders.real} real order(s)`,
      targetTable: 'zts_store_daily',
      targetId: day,
      after: snapshot,
      // Tier 1 requires an undo descriptor, and this is a genuine one: the row
      // is keyed by day and derived entirely from Shopify, so deleting it
      // restores the prior state exactly and the next pass rebuilds it.
      undo: { op: 'delete', table: 'zts_store_daily', match: { day } },
      costUsd: 0,
    });

    let wrote = false;
    if (writeVerdict.mode === MODE.EXECUTE) {
      const { error } = await sb.from('zts_store_daily').upsert({
        day,
        captured_at: snapshot.capturedAt,
        active_products: snapshot.activeProducts,
        blocked_products: snapshot.blockedProducts,
        orders_total: snapshot.orders.total,
        orders_real: snapshot.orders.real,
        orders_test: snapshot.orders.test,
        orders_unfulfilled: snapshot.orders.unfulfilled,
        real_revenue_usd: snapshot.orders.realRevenueUsd,
        gross_usd: snapshot.orders.grossUsd,
        findings: snapshot.findings,
      }, { onConflict: 'day' });

      if (error) {
        await recordFailure(sb, {
          subsystem: SUBSYSTEM, action: 'store.snapshot', tier: TIER.REVERSIBLE,
          error, runId, trigger: 'netlify schedule 0 */6', now: Date.now(),
        });
        throw new Error(`ZTS_SNAPSHOT_WRITE_FAILED: ${error.message}`);
      }
      wrote = true;
    }

    // The one thing worth shouting about. A blocked storefront is revenue lost
    // per hour, and it is invisible from the admin — the product still shows
    // ACTIVE while refusing every sale.
    if (snapshot.blockedProducts > 0) {
      console.error(`[zts.store] STOREFRONT BLOCKED — ${snapshot.blockedProducts} active product(s) cannot be purchased:`,
        JSON.stringify(snapshot.findings.storefrontBlocked));
    }
    if (snapshot.findings.unfulfilled.length) {
      console.warn(`[zts.store] ${snapshot.findings.unfulfilled.length} real order(s) unfulfilled:`,
        JSON.stringify(snapshot.findings.unfulfilled.map((o) => `${o.name} ${o.ageDays}d`)));
    }

    await finishRun(sb, runId, {
      ok: true,
      actions: wrote ? 2 : 1,
      blocked: writeVerdict.allow ? 0 : 1,
      errors: 0,
      note: `read ok; snapshot ${writeVerdict.mode}${wrote ? ' (written)' : ''}; ` +
            `${snapshot.blockedProducts} blocked, ${snapshot.orders.real} real orders`,
    }, Date.now());

    console.log(`[zts.store] ${writeVerdict.mode} — ${snapshot.activeProducts} active, ${snapshot.blockedProducts} blocked, ${snapshot.orders.real} real orders`);
    return { statusCode: 200, body: JSON.stringify({ mode: writeVerdict.mode, wrote, snapshot }) };
  } catch (ex) {
    console.error('[zts.store] failed:', ex.message);
    if (runId) {
      try { await finishRun(sb, runId, { ok: false, errors: 1, note: ex.message }, Date.now()); }
      catch (e2) { console.error('[zts.store] could not close run:', e2.message); }
    }
    return { statusCode: 500, body: JSON.stringify({ error: ex.message }) };
  }
};
