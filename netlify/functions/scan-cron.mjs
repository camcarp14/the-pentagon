// scan-cron — scheduled weekday-morning scan (see netlify.toml). Runs
// headless, so it needs SUPABASE_SERVICE_ROLE_KEY (functions scope only —
// never VITE_-prefixed). Until that key is set this endpoint is a loud no-op
// returning a named error; add the key and the schedule just starts working.
// Writes are pinned to the single allow-listed user; worst case for an
// unauthenticated manual invocation is an extra scan of public feeds.
//
// PAUSABLE. Runway's power switch stops this pass, via `runway.scan`'s
// ops_control row — see netlify/shared/toolPower.mjs for why the pause rides on
// `paused_reason` and not on `enabled`. A paused pass fetches no board, writes
// no posting and does not even look up the allow-listed user; the gate is the
// first thing after the env check for exactly that reason.
//
// WHAT A PAUSE COSTS, stated because a scanner is the one engine here where a
// pause loses something: a posting that appears and is taken down inside the
// paused window is never seen, because the only record of it was the board's
// live feed. Nothing already in seen_postings is affected, the round-robin
// resumes where it left off, and the next unpaused weekday picks up everything
// still listed.
import { serverClient } from './lib/supabase-node.mjs';
import { json, errorResponse, env } from './lib/auth.mjs';
import { scanBoards } from './lib/scan-core.mjs';
import { enginePause } from '../shared/toolPower.mjs';

const SUBSYSTEM = 'runway.scan';

export const handler = async () => {
  try {
    const [url] = env('VITE_SUPABASE_URL');
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const allowedUserId = process.env.ALLOWED_USER_ID;
    if (!serviceKey || !allowedUserId) {
      const missing = [!serviceKey && 'SUPABASE_SERVICE_ROLE_KEY', !allowedUserId && 'ALLOWED_USER_ID'].filter(Boolean);
      return json(500, { error: `RUNWAY_ENV_MISSING: ${missing.join(', ')} — scheduled scans stay off until set` });
    }

    // Before the user lookup and before any board fetch: a paused tool should
    // cost nothing, not "cost slightly less". 200 rather than an error — a pass
    // that correctly did nothing is a healthy pass, and a 500 here would make
    // the Netlify function log read as broken every weekday morning.
    const power = await enginePause(SUBSYSTEM);
    if (power.paused) {
      console.log(`[${SUBSYSTEM}] paused — ${power.reason}; no boards fetched`);
      return json(200, { skipped: 'paused', reason: power.reason });
    }
    if (power.unknown) console.warn(`[${SUBSYSTEM}] pause state unreadable, scanning anyway: ${power.why}`);

    const admin = serverClient(url, serviceKey, { auth: { persistSession: false }, db: { schema: 'runway' } });
    const summary = await scanBoards({ db: admin, userId: allowedUserId });
    console.log('scan-cron summary', JSON.stringify(summary));
    // `pauseUnknown` rides on the body as well as the console line. The
    // scheduler discards this body, but the operator hitting /api/scan-cron by
    // hand is the person asking "I paused Runway, why did it just scan?" and
    // this is the answer.
    return json(200, power.unknown ? { ...summary, pauseUnknown: power.why } : summary);
  } catch (ex) {
    return errorResponse(ex);
  }
};
