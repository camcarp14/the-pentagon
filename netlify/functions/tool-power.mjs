// ═══════════════════════════════════════════════════════════════════════════
// /api/tool-power — read and set which tools' background engines are stopped.
//
// ─── WHY THIS EXISTS WHEN THE BROWSER COULD DO IT DIRECTLY ──────────────────
//
// It could. Migration 0002 gives `authenticated` an unconditional
// `ops_control_update` policy and 0004 grants it select/insert/update on the
// table, so Ops.jsx's global STOP genuinely writes ops_control from the browser
// today — that path works and is not being replaced. Three things make the tool
// switch a different job:
//
//   1. THE ROW MAY NOT EXIST. registerSubsystem only runs inside a scheduled
//      pass, and `runway.scan` / `macro.watch` / `macro.alts` have never had
//      rows at all. A browser `.update()` against a missing row succeeds with
//      zero rows affected — the switch would flip, the toast would not fire,
//      and nothing would have been paused. That is the exact failure the
//      contract calls out: a control whose write failed rendering as if it
//      succeeded. This endpoint registers first and then VERIFIES the affected
//      keys, so a write that did not land is a 500 with the keys named.
//
//   2. ONE DEFINITION OF THE MAP. A direct write means the shell owns a second
//      copy of tool→engine. Two copies drift, and the drift is silent: the
//      switch keeps stopping the engines it knew about when it was written.
//
//   3. THE CRONS READ WITH THE SERVICE ROLE. The seeding rule that keeps a
//      monitor row from reading "disabled" in the Ops console lives in
//      toolPower.mjs's seedRow, and it has to be the same code on the write
//      path and the cron path or the two disagree about what a fresh row is.
//
// checkAuth on BOTH verbs. GET is not public: it enumerates every background
// subsystem this account runs and when each was stopped.
//
// `ops.*` is unreachable here by construction — the map has no entry for it, so
// there is no `tool` value that resolves to it and an unknown tool is a 400.
// ═══════════════════════════════════════════════════════════════════════════
import { json, authVerdict, authRefusal } from '../shared/util.mjs';
import { adminClient } from './lib/ops-runtime.mjs';
import {
  TOOLS, PAUSABLE_KEYS, enginesFor, engineKeys, isKnownTool, isPausable,
  summariseAll, summariseTool, pauseFields, seedRow,
} from '../shared/toolPower.mjs';

export default async (req) => {
  try {
    const verdict = await authVerdict(req);
    if (!verdict.ok) return authRefusal(verdict);

    const method = String(req?.method || '').toUpperCase();
    if (method !== 'GET' && method !== 'PUT') {
      return json({ error: `tool-power takes GET or PUT, not ${method || 'an unnamed method'}` }, 405);
    }

    // A missing service-role key is a loud 500 and not an empty answer. The
    // browser cannot reach this table (0004 revoked `anon` outright and the
    // operator's own grants are not what this path uses), so degrading to
    // "nothing is paused" would be a confident claim built on no reading at all
    // — and the switch would then render OFF for engines that may be stopped.
    let sb;
    try {
      sb = adminClient();
    } catch (ex) {
      return json({ error: `tool power is unreadable: ${ex.message}` }, 500);
    }

    return method === 'GET' ? await handleGet(sb) : await handlePut(sb, req);
  } catch (ex) {
    // Same rule as the crons: this file cannot throw. A 500 with the message is
    // something the switch can show; an unhandled rejection is a blank failure
    // the operator cannot act on.
    console.error('[tool-power] failed:', ex);
    return json({ error: String(ex?.message || ex) }, 500);
  }
};

async function handleGet(sb) {
  const { data, error } = await sb
    .from('ops_control')
    .select('key, enabled, paused_reason, paused_at')
    .in('key', PAUSABLE_KEYS);
  if (error) return json({ error: `ops_control read failed: ${error.message}` }, 500);

  return json({ tools: summariseAll(rowMap(data)) });
}

async function handlePut(sb, req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'body must be JSON: { tool, paused }' }, 400);
  }

  const tool = body?.tool;
  const paused = body?.paused;
  if (!isKnownTool(tool)) {
    return json({ error: `unknown tool ${JSON.stringify(tool ?? null)} — expected one of ${TOOLS.join(', ')}` }, 400);
  }
  // Not `!!paused`. A client that sent "false" or 0 meant something specific and
  // guessing which way to round it is how a resume becomes a pause.
  if (typeof paused !== 'boolean') {
    return json({ error: `paused must be true or false, not ${JSON.stringify(paused ?? null)}` }, 400);
  }
  if (!isPausable(tool)) {
    // 400, not a 200 no-op. The UI is contracted never to render a switch here,
    // so a PUT arriving is a bug in the caller and it should hear about it.
    return json({ error: `${tool} runs nothing in the background — there is no engine to pause` }, 400);
  }

  const keys = engineKeys(tool);
  const now = Date.now();

  // Register before updating, for the reason in the header: an UPDATE against a
  // row that does not exist is a silent success.
  for (const key of keys) await seedRow(sb, key, now);

  const { data, error } = await sb
    .from('ops_control')
    .update(pauseFields(paused, now))
    .in('key', keys)
    .select('key, enabled, paused_reason, paused_at');
  if (error) return json({ error: `ops_control write failed: ${error.message}` }, 500);

  // THE HONESTY CHECK. Naming the keys that did not take, rather than reporting
  // a count, is what lets the operator (and the switch's rollback) say WHICH
  // engine is still running.
  const wrote = new Set((data || []).map((r) => r.key));
  const missed = keys.filter((k) => !wrote.has(k));
  if (missed.length) {
    return json({
      error: `${paused ? 'pause' : 'resume'} did not take on ${missed.join(', ')} — ${missed.length === keys.length ? 'nothing changed' : 'the rest of ' + tool + ' did change'}`,
      tool,
      missed,
      tools: { [tool]: summariseTool(tool, rowMap(data)) },
    }, 500);
  }

  return json({
    tool,
    paused,
    // The updated rows, read back from the write rather than reconstructed from
    // what we hoped it did, in the same shape GET returns so the caller has one
    // parser and not two.
    tools: { [tool]: summariseTool(tool, rowMap(data)) },
    engines: enginesFor(tool).map((e) => e.key),
  });
}

const rowMap = (rows) => new Map((rows || []).filter((r) => r?.key).map((r) => [r.key, r]));
