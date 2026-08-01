// ═══════════════════════════════════════════════════════════════════════════
// TOOL POWER — the map, the endpoint, and (the half that matters) PROOF THAT
// THE THREE CRONS ACTUALLY REACH THE GATE.
//
// This repo has shipped a fix that was written, exported, documented and tested
// and never wired: the tool row went out as a vertical ladder while a green test
// asserted the source contained "auto-fit", which it did, in the file that
// rendered a column. A source-text assertion cannot see a call site.
//
// So the cron tests below do not read scan-cron.mjs, watch-snapshot.mjs or
// alt-watch.mjs. They IMPORT THE REAL HANDLERS, run them against a paused
// control row, and assert on the thing the pause is supposed to prevent — that
// scanBoards was not called, that mstrQuote was not called, that altUniverse was
// not called. Every one of those fails against the pre-change source, because
// the pre-change source calls them unconditionally. Each has a matching
// unpaused case, which is what stops the test passing for the wrong reason (a
// broken import, a handler that throws early, a spy that was never wired).
//
// The dominance-sample exception gets the same treatment from the other side: a
// PAUSED alt-watch is asserted to have WRITTEN today's row. That claim is the
// deliberate part of this piece and it would otherwise be a comment nobody
// checked.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── the fake ops_control ────────────────────────────────────────────────────
// A real PostgREST chain, small enough to read: the three shapes this feature
// issues are select/eq/maybeSingle, select/in, and update/in/select. Anything
// else throws rather than quietly answering, so a query I did not intend cannot
// pass unnoticed.
function opsTable(seed = [], behaviour = {}) {
  const rows = new Map();
  for (const r of seed) {
    rows.set(r.key, { key: r.key, enabled: false, dry_run: true, paused_reason: null, paused_at: null, updated_at: null, ...r });
  }
  const log = { reads: 0, upserts: [], updates: [] };

  function builder() {
    const st = { mode: 'select', filter: null, patch: null, single: false, opts: null };
    const api = {
      select() { return api; },
      eq(col, val) { st.filter = (r) => r[col] === val; return api; },
      in(col, vals) { st.filter = (r) => vals.includes(r[col]); return api; },
      update(patch) { st.mode = 'update'; st.patch = patch; return api; },
      upsert(row, opts) { st.mode = 'upsert'; st.patch = row; st.opts = opts; return api; },
      maybeSingle() { st.single = true; return exec(); },
      then(res, rej) { return exec().then(res, rej); },
    };
    async function exec() {
      if (st.mode === 'select') {
        log.reads += 1;
        if (behaviour.readError) return { data: null, error: { message: behaviour.readError } };
        if (behaviour.readThrows) throw new Error(behaviour.readThrows);
        const hits = [...rows.values()].filter(st.filter || (() => true));
        return st.single ? { data: hits[0] ?? null, error: null } : { data: hits, error: null };
      }
      if (st.mode === 'upsert') {
        log.upserts.push(st.patch);
        // ignoreDuplicates: INSERT … ON CONFLICT DO NOTHING. An existing row is
        // never touched, which is the property seedRow depends on.
        if (!(st.opts?.ignoreDuplicates && rows.has(st.patch.key))) {
          rows.set(st.patch.key, { enabled: false, dry_run: true, paused_reason: null, paused_at: null, ...rows.get(st.patch.key), ...st.patch });
        }
        return { data: null, error: null };
      }
      log.updates.push(st.patch);
      if (behaviour.updateError) return { data: null, error: { message: behaviour.updateError } };
      const hits = [...rows.values()].filter(st.filter || (() => false));
      for (const r of hits) Object.assign(r, st.patch);
      // `swallowUpdates` reproduces the failure the endpoint's affected-key
      // check exists for: PostgREST answering 200 with nothing changed.
      return { data: behaviour.swallowUpdates ? [] : hits, error: null };
    }
    return api;
  }

  return {
    rows, log,
    from(table) {
      if (table !== 'ops_control') throw new Error(`unexpected table ${table}`);
      return builder();
    },
    auth: { admin: { listUsers: vi.fn(async () => ({ data: { users: [{ id: 'u1', email: 'op@example.com' }] }, error: null })) } },
  };
}

// vi.mock factories are hoisted above every const in this file, so the spies
// they close over have to be hoisted with them. vi.hoisted is the supported way;
// without it the mock factory reads a temporal-dead-zone binding and the whole
// suite fails to collect.
const H = vi.hoisted(() => ({
  db: null,
  // Macro's upstreams, as spies. The whole claim of the watch-snapshot test is
  // that a paused pass does not reach these.
  mstrQuote: null, btcSpot: null, mstrCandles: null,
  // alt-watch keeps its real gate, its real dominance merge and its real row
  // validator — those are what the paused path still exercises. Only the two
  // network reads are replaced.
  altGlobal: null, altUniverse: null,
  scanBoards: null,
  blobs: new Map(),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: () => H.db }));
vi.mock('@netlify/blobs', () => ({
  getStore: () => ({
    get: async (k) => (H.blobs.has(k) ? JSON.parse(JSON.stringify(H.blobs.get(k))) : null),
    setJSON: async (k, v) => { H.blobs.set(k, JSON.parse(JSON.stringify(v))); },
    delete: async (k) => { H.blobs.delete(k); },
  }),
}));
// Partial, not wholesale: alts.mjs re-exports parsers out of this module, so
// replacing it entirely breaks the import graph before a single test runs.
vi.mock('../sources.mjs', async (orig) => ({
  ...(await orig()),
  mstrQuote: (...a) => H.mstrQuote(...a),
  btcSpot: (...a) => H.btcSpot(...a),
  mstrCandles: (...a) => H.mstrCandles(...a),
}));
vi.mock('../alts.mjs', async (orig) => ({
  ...(await orig()),
  altGlobal: (...a) => H.altGlobal(...a),
  altUniverse: (...a) => H.altUniverse(...a),
}));
vi.mock('../../functions/lib/scan-core.mjs', () => ({ scanBoards: (...a) => H.scanBoards(...a) }));

const BLOBS = H.blobs;

import {
  TOOL_ENGINES, TOOLS, PAUSABLE_KEYS, PAUSE_REASON, GATE,
  enginesFor, engineKeys, toolOf, engineOf, isPausable, isKnownTool,
  isPausedRow, pauseFields, summariseTool, summariseAll,
  stopsSentence, keepsSentence, enginePause,
} from '../toolPower.mjs';
import toolPowerHandler from '../../functions/tool-power.mjs';
import { handler as scanCron } from '../../functions/scan-cron.mjs';
import watchSnapshot from '../../functions/watch-snapshot.mjs';
import altWatch from '../../functions/alt-watch.mjs';

const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const paused = (key) => ({ key, paused_reason: PAUSE_REASON, paused_at: '2026-07-31T00:00:00.000Z' });

// One handle for "the control table this pass will read". Assigning DB assigns
// through to the mocked createClient, so a test can swap in a paused table or a
// failing one after the module graph is already loaded.
let DB;
const useDb = (...args) => { DB = H.db = opsTable(...args); return DB; };

beforeEach(() => {
  useDb();
  BLOBS.clear();
  vi.clearAllMocks();
  H.mstrQuote = vi.fn(async () => ({ price: 100 }));
  H.btcSpot = vi.fn(async () => ({ price: 50_000 }));
  H.mstrCandles = vi.fn(async () => ({ candles: [] }));
  H.altGlobal = vi.fn(async () => ({ btcDominancePct: 55.5, ethDominancePct: 13.2, totalMcapUsd: 3.1e12 }));
  H.altUniverse = vi.fn(async () => ({ universe: [] }));
  H.scanBoards = vi.fn(async () => ({ boards_scanned: 1, queued: 0 }));
  process.env.VITE_SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  process.env.ALLOWED_EMAIL = 'op@example.com';
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});
afterEach(() => { vi.unstubAllGlobals(); });

/* ─────────────────────────── the map ─────────────────────────── */

describe('the tool → subsystem map', () => {
  it('carries exactly the seven engine rows, under the four tools that have any', () => {
    expect(PAUSABLE_KEYS).toEqual([
      'zts.content', 'zts.store',
      'clarify.outbound', 'clarify.replies',
      'runway.scan',
      'macro.watch', 'macro.alts',
    ]);
    expect(TOOLS).toEqual(['zts', 'clarify', 'runway', 'macro', 'looper', 'business', 'sync', 'ideas']);
    for (const t of ['looper', 'business', 'sync', 'ideas']) {
      expect(enginesFor(t)).toEqual([]);
      expect(isPausable(t)).toBe(false);
    }
  });

  // ops.heartbeat is the containment layer's own pulse and is not owned by any
  // tool. The switch must have no route to it at all — not "a route that is
  // refused", no route.
  it('cannot reach ops.*', () => {
    expect(PAUSABLE_KEYS.some((k) => k.startsWith('ops.'))).toBe(false);
    expect(toolOf('ops.heartbeat')).toBe(null);
    expect(engineOf('ops.heartbeat')).toBe(null);
    expect(isKnownTool('ops')).toBe(false);
  });

  // The named cron file must actually mention its own subsystem key. This is the
  // cheap half of the wiring proof — it catches a key renamed in the map and
  // nowhere else — and the handler tests below are the half that catches a key
  // present in a file that never consults it.
  it('names, for every engine, a cron file that carries that key', () => {
    for (const key of PAUSABLE_KEYS) {
      const e = engineOf(key);
      const text = src(`../../functions/${e.cron}.mjs`);
      expect(text, `${e.cron}.mjs should name ${key}`).toContain(key);
    }
  });

  // The three that were ungated must each import the gate. A monitor whose file
  // named its key but never called enginePause is precisely the shape of the bug
  // this suite exists to refuse.
  it('has every monitor cron importing enginePause', () => {
    const monitors = PAUSABLE_KEYS.map(engineOf).filter((e) => e.gate === GATE.MONITOR);
    expect(monitors.map((e) => e.key)).toEqual(['runway.scan', 'macro.watch', 'macro.alts']);
    for (const e of monitors) {
      const text = src(`../../functions/${e.cron}.mjs`);
      expect(text, `${e.cron}.mjs should import enginePause`).toMatch(/import\s*\{[^}]*enginePause[^}]*\}\s*from\s*'[^']*toolPower\.mjs'/);
    }
  });

  it('reads a pause off paused_reason and nothing else', () => {
    expect(isPausedRow({ paused_reason: PAUSE_REASON })).toBe(true);
    expect(isPausedRow({ paused_reason: null })).toBe(false);
    // enabled:false alone is "never opted in", not "the operator stopped it".
    expect(isPausedRow({ enabled: false, paused_reason: null })).toBe(false);
    // A blank reason would render as a pause pill with no words in it.
    expect(isPausedRow({ paused_reason: '   ' })).toBe(false);
    expect(isPausedRow(null)).toBe(false);
    expect(isPausedRow(undefined)).toBe(false);
  });

  it('never writes enabled, in either direction', () => {
    expect(Object.keys(pauseFields(true, 0))).toEqual(['paused_reason', 'paused_at', 'updated_at']);
    expect(Object.keys(pauseFields(false, 0))).toEqual(['paused_reason', 'paused_at', 'updated_at']);
    expect(pauseFields(false, 0).paused_reason).toBe(null);
    expect(pauseFields(true, 0).paused_reason).toBe(PAUSE_REASON);
  });

  it('calls a tool paused only when EVERY engine is stopped', () => {
    const half = summariseTool('zts', new Map([['zts.content', paused('zts.content')]]));
    expect(half.paused).toBe(false);
    expect(half.partial).toBe(true);
    expect(half.stopped).toEqual(['zts.content']);

    const all = summariseTool('zts', new Map([
      ['zts.content', paused('zts.content')], ['zts.store', paused('zts.store')],
    ]));
    expect(all.paused).toBe(true);
    expect(all.partial).toBe(false);
    expect(all.stopped).toEqual(['zts.content', 'zts.store']);

    const none = summariseTool('zts', new Map());
    expect(none.paused).toBe(false);
    expect(none.partial).toBe(false);
    expect(none.stopped).toEqual([]);
    expect(none.engines.every((e) => e.registered === false)).toBe(true);
  });

  // The cross-part trap, pinned. The shell reads `enabled` and derives "stopped"
  // from it, which is wrong in BOTH directions: an armed-and-paused engine is
  // `enabled: true`, and a never-armed-and-running one is `enabled: false` —
  // which is the ordinary day-one state of every guard-gated engine, so
  // deriving from it renders a fresh deploy with ZTS and Clarify shown as
  // paused when nothing is. `stopped`/`paused` are served so nothing downstream
  // has to guess.
  it('separates "armed" from "paused" in both directions', () => {
    const armedAndPaused = summariseTool('zts', new Map([
      ['zts.content', { key: 'zts.content', enabled: true, paused_reason: PAUSE_REASON }],
      ['zts.store', { key: 'zts.store', enabled: true, paused_reason: PAUSE_REASON }],
    ]));
    expect(armedAndPaused.engines.map((e) => e.enabled)).toEqual([true, true]);
    expect(armedAndPaused.paused).toBe(true);
    expect(armedAndPaused.stopped).toEqual(['zts.content', 'zts.store']);

    const neverArmedAndRunning = summariseTool('zts', new Map([
      ['zts.content', { key: 'zts.content', enabled: false, paused_reason: null }],
      ['zts.store', { key: 'zts.store', enabled: false, paused_reason: null }],
    ]));
    expect(neverArmedAndRunning.paused).toBe(false);
    expect(neverArmedAndRunning.mixed).toBe(false);
    expect(neverArmedAndRunning.stopped).toEqual([]);
  });

  it('publishes partial under both names, from one expression', () => {
    const half = summariseTool('macro', new Map([['macro.watch', paused('macro.watch')]]));
    expect(half.mixed).toBe(half.partial);
    expect(half.mixed).toBe(true);
    expect(summariseTool('looper', new Map()).mixed).toBe(false);
  });

  it('reports a tool with no engines as unpausable rather than as running', () => {
    const looper = summariseTool('looper', new Map());
    expect(looper).toMatchObject({ pausable: false, paused: false, partial: false, engines: [], stops: null, keeps: null });
  });

  it('generates the switch copy from the map, including what a pause does NOT stop', () => {
    expect(stopsSentence('zts')).toBe('Pauses the content engine and store ingest.');
    expect(stopsSentence('macro')).toBe('Pauses the MSTR stop sentinel and the alt sentinel.');
    expect(stopsSentence('runway')).toBe('Pauses the weekday board scan.');
    expect(stopsSentence('looper')).toBe(null);
    // The counterweight. Macro is the only tool that keeps doing something.
    expect(keepsSentence('macro')).toBe('Still records the daily BTC-dominance sample, which nothing can backfill.');
    expect(keepsSentence('zts')).toBe(null);
    expect(keepsSentence('runway')).toBe(null);
  });

  it('answers for an unknown tool without throwing', () => {
    expect(enginesFor('nope')).toEqual([]);
    expect(engineKeys(undefined)).toEqual([]);
    expect(isPausable('__proto__')).toBe(false);
    expect(isKnownTool('constructor')).toBe(false);
    expect(summariseAll(new Map()).zts.engines).toHaveLength(2);
  });
});

/* ────────────────────── enginePause, the read ────────────────────── */

describe('enginePause', () => {
  it('reports paused with the reason the operator will read', async () => {
    useDb([paused('macro.alts')]);
    await expect(enginePause('macro.alts')).resolves.toMatchObject({ paused: true, unknown: false, reason: PAUSE_REASON });
  });

  it('is not paused when the row exists and carries no pause', async () => {
    useDb([{ key: 'macro.alts', enabled: true }]);
    await expect(enginePause('macro.alts')).resolves.toMatchObject({ paused: false, unknown: false });
  });

  // The bug this would otherwise be: a monitor row seeded with the table's
  // enabled=false, so the Ops console says "disabled" beside a cron that runs
  // every 30 minutes.
  it('seeds a missing monitor row as enabled, and never rewrites an existing one', async () => {
    useDb([]);
    await enginePause('macro.alts');
    expect(DB.log.upserts).toEqual([expect.objectContaining({ key: 'macro.alts', enabled: true })]);
    expect(DB.rows.get('macro.alts').enabled).toBe(true);

    useDb([paused('macro.alts')]);
    const again = await enginePause('macro.alts');
    expect(again.paused).toBe(true);
    expect(DB.log.upserts).toEqual([]); // the row was found; nothing was written
  });

  // A guard-gated engine keeps the table's opt-in default. Seeding it enabled
  // would arm an autonomous subsystem as a side effect of registering it.
  it('never seeds a guard-gated engine as enabled', async () => {
    useDb([]);
    await enginePause('zts.content');
    expect(DB.log.upserts).toEqual([{ key: 'zts.content', updated_at: expect.any(String) }]);
  });

  it('is unknown-not-paused when there are no service-role credentials', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const v = await enginePause('macro.alts');
    expect(v).toMatchObject({ paused: false, unknown: true });
    expect(v.why).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('is unknown-not-paused when the read fails, and does not throw', async () => {
    useDb([], { readError: 'connection reset' });
    await expect(enginePause('macro.alts')).resolves.toMatchObject({ paused: false, unknown: true, why: expect.stringContaining('connection reset') });

    useDb([], { readThrows: 'socket hang up' });
    await expect(enginePause('macro.alts')).resolves.toMatchObject({ paused: false, unknown: true, why: expect.stringContaining('socket hang up') });
  });
});

/* ─────────────── the three crons: proof the gate is REACHED ─────────────── */

describe('scan-cron obeys runway.scan', () => {
  it('scans when nothing is paused', async () => {
    const res = await scanCron();
    expect(res.statusCode).toBe(200);
    expect(H.scanBoards).toHaveBeenCalledTimes(1);
  });

  it('fetches no board and looks up no user when Runway is paused', async () => {
    useDb([paused('runway.scan')]);
    const res = await scanCron();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ skipped: 'paused', reason: PAUSE_REASON });
    expect(H.scanBoards).not.toHaveBeenCalled();
    expect(DB.auth.admin.listUsers).not.toHaveBeenCalled();
  });

  // Preserved, not incidentally: the env guard has to stay AHEAD of the pause
  // read, or a deploy without the key trades a named error for a Supabase
  // failure about a table it was never going to reach.
  it('is still a loud no-op with SUPABASE_SERVICE_ROLE_KEY unset, and reads no control row', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await scanCron();
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toMatch(/RUNWAY_ENV_MISSING: SUPABASE_SERVICE_ROLE_KEY/);
    expect(DB.log.reads).toBe(0);
    expect(H.scanBoards).not.toHaveBeenCalled();
  });

  it('scans, and says why, when the pause row cannot be read', async () => {
    useDb([], { readError: 'PostgREST 503' });
    const res = await scanCron();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).pauseUnknown).toMatch(/PostgREST 503/);
    expect(H.scanBoards).toHaveBeenCalledTimes(1);
  });
});

describe('watch-snapshot obeys macro.watch', () => {
  const req = () => new Request('https://x/api/watch-snapshot', { method: 'POST' });

  it('reads the market when nothing is paused', async () => {
    await watchSnapshot(req());
    expect(H.mstrQuote).toHaveBeenCalled();
  });

  it('touches no upstream and writes no Blob when Macro is paused', async () => {
    useDb([paused('macro.watch')]);
    const body = await (await watchSnapshot(req())).json();
    expect(body).toMatchObject({ ok: true, skipped: 'paused', reason: PAUSE_REASON });
    expect(H.mstrQuote).not.toHaveBeenCalled();
    expect(H.btcSpot).not.toHaveBeenCalled();
    expect(H.mstrCandles).not.toHaveBeenCalled();
    expect(BLOBS.size).toBe(0);
  });

  it('runs, and says why, when the pause row cannot be read', async () => {
    useDb([], { readError: 'PostgREST 503' });
    const body = await (await watchSnapshot(req())).json();
    expect(body.pauseUnknown).toMatch(/PostgREST 503/);
    expect(H.mstrQuote).toHaveBeenCalled();
  });
});

describe('alt-watch obeys macro.alts — except for the one thing it must not', () => {
  const req = () => new Request('https://x/api/alt-watch', { method: 'POST' });
  const today = () => new Date().toISOString().slice(0, 10);

  beforeEach(() => { BLOBS.set('alt_watchlist', { ids: [{ id: 'pepe', symbol: 'PEPE' }] }); });

  it('screens the watchlist when nothing is paused', async () => {
    await altWatch(req());
    expect(H.altGlobal).toHaveBeenCalled();
    expect(H.altUniverse).toHaveBeenCalled();
  });

  it('does not screen, does not fetch the universe, when Macro is paused', async () => {
    useDb([paused('macro.alts')]);
    const body = await (await altWatch(req())).json();
    expect(body.paused).toBe(true);
    expect(H.altUniverse).not.toHaveBeenCalled();
    expect(body.watchlist.reason).toMatch(/paused/);
  });

  // THE DELIBERATE EXCEPTION, asserted rather than asserted-in-a-comment. A
  // paused pass still writes today's dominance row, because a day this pass
  // misses cannot be rebuilt by anything and a pause that destroys data is not
  // a pause.
  it('still records today’s dominance sample while paused', async () => {
    useDb([paused('macro.alts')]);
    const body = await (await altWatch(req())).json();
    expect(H.altGlobal).toHaveBeenCalledTimes(1);
    expect(body.dominance).toMatchObject({ appended: true, day: today() });
    expect(BLOBS.get('alt_dom_history')).toEqual([
      expect.objectContaining({ d: today(), btcDom: 55.5, ethDom: 13.2 }),
    ]);
  });

  // `alt_alert_state` is written on EVERY completed screening pass, so its
  // presence is a fact about whether scanWatchlist ran that does not depend on
  // the market fixture producing a transition. A "no Telegram was sent"
  // assertion alone would pass against the pre-change source too — nothing in
  // this fixture fires an alert — and a test that passes for the wrong reason is
  // the failure mode this file opens by naming.
  it('leaves the alert state untouched while paused, and writes it when it is not', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.TELEGRAM_CHAT_ID = 'c';
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    useDb([paused('macro.alts')]);
    await altWatch(req());
    expect(BLOBS.has('alt_alert_state')).toBe(false);
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('api.telegram.org'))).toHaveLength(0);

    useDb();
    await altWatch(req());
    expect(BLOBS.has('alt_alert_state')).toBe(true);
  });

  it('screens, and says why, when the pause row cannot be read', async () => {
    useDb([], { readError: 'PostgREST 503' });
    const body = await (await altWatch(req())).json();
    expect(body.pauseUnknown).toMatch(/PostgREST 503/);
    expect(H.altUniverse).toHaveBeenCalled();
  });
});

/* ───────────────────────── the endpoint ───────────────────────── */

describe('/api/tool-power', () => {
  const authed = (init = {}) => new Request('https://x/api/tool-power', {
    headers: { authorization: 'Bearer stub' }, ...init,
  });
  const put = (body) => authed({
    method: 'PUT', headers: { authorization: 'Bearer stub', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  beforeEach(() => {
    // ALLOWED_EMAIL unset so verifySession stops at "Supabase accepted the
    // token" — the operator pin is util.mjs's behaviour and has its own tests.
    delete process.env.ALLOWED_EMAIL;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ email: 'op@example.com' }), { status: 200 })));
  });

  it('refuses an unauthenticated caller before reading anything', async () => {
    const res = await toolPowerHandler(new Request('https://x/api/tool-power'));
    expect(res.status).toBe(401);
    expect(DB.log.reads).toBe(0);
  });

  it('GET reports every tool, with the empty ones marked unpausable', async () => {
    useDb([paused('macro.watch'), paused('macro.alts'), { key: 'zts.content', enabled: true }]);
    const { tools } = await (await toolPowerHandler(authed())).json();
    expect(Object.keys(tools)).toEqual(TOOLS);
    expect(tools.macro).toMatchObject({ paused: true, partial: false });
    expect(tools.macro.engines.map((e) => e.key)).toEqual(['macro.watch', 'macro.alts']);
    expect(tools.macro.keeps).toMatch(/dominance/);
    expect(tools.zts).toMatchObject({ paused: false, partial: false });
    expect(tools.sync).toMatchObject({ pausable: false, paused: false, engines: [] });
  });

  it('PUT pauses every engine a tool owns, and leaves enabled exactly as it found it', async () => {
    // zts.content armed, zts.store never opted in — the two states a resume must
    // not flatten into one.
    useDb([{ key: 'zts.content', enabled: true, dry_run: false }, { key: 'zts.store', enabled: false }]);
    const res = await toolPowerHandler(put({ tool: 'zts', paused: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).tools.zts.paused).toBe(true);

    expect(DB.rows.get('zts.content')).toMatchObject({ enabled: true, dry_run: false, paused_reason: PAUSE_REASON });
    expect(DB.rows.get('zts.store')).toMatchObject({ enabled: false, paused_reason: PAUSE_REASON });
    expect(DB.rows.get('zts.content').paused_at).toEqual(expect.any(String));
    // The write touched only the pause columns.
    expect(DB.log.updates).toEqual([{ paused_reason: PAUSE_REASON, paused_at: expect.any(String), updated_at: expect.any(String) }]);
  });

  // The whole reason pause rides on paused_reason: resuming must not arm an
  // autonomous subsystem the operator never opted into.
  it('PUT resume clears the pause and does not arm anything', async () => {
    useDb([paused('zts.content'), paused('zts.store')]);
    const res = await toolPowerHandler(put({ tool: 'zts', paused: false }));
    expect(res.status).toBe(200);
    expect((await res.json()).tools.zts.paused).toBe(false);
    for (const k of ['zts.content', 'zts.store']) {
      expect(DB.rows.get(k)).toMatchObject({ paused_reason: null, paused_at: null });
      expect(DB.rows.get(k).enabled).toBe(false); // still opt-in, still off
    }
  });

  // A cron that has never run leaves no row. `.update()` against nothing is a
  // silent success, which is how a switch flips with nothing behind it.
  it('PUT creates the rows a cron has never registered', async () => {
    useDb([]);
    const res = await toolPowerHandler(put({ tool: 'macro', paused: true }));
    expect(res.status).toBe(200);
    expect(DB.rows.get('macro.watch')).toMatchObject({ enabled: true, paused_reason: PAUSE_REASON });
    expect(DB.rows.get('macro.alts')).toMatchObject({ enabled: true, paused_reason: PAUSE_REASON });
    await expect(enginePause('macro.watch')).resolves.toMatchObject({ paused: true });
  });

  it('PUT that changes nothing is a failure that names the engines still running', async () => {
    useDb([{ key: 'zts.content' }, { key: 'zts.store' }], { swallowUpdates: true });
    const res = await toolPowerHandler(put({ tool: 'zts', paused: true }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.missed).toEqual(['zts.content', 'zts.store']);
    expect(body.error).toMatch(/did not take/);
  });

  it('PUT refuses an unknown tool, a tool with no engines, and a non-boolean', async () => {
    for (const body of [{ tool: 'ops', paused: true }, { tool: 'ops.heartbeat', paused: true }, { tool: null, paused: true }]) {
      expect((await toolPowerHandler(put(body))).status).toBe(400);
    }
    const empty = await toolPowerHandler(put({ tool: 'looper', paused: true }));
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toMatch(/nothing in the background/);

    const bad = await toolPowerHandler(put({ tool: 'zts', paused: 'yes' }));
    expect(bad.status).toBe(400);
    expect(DB.log.updates).toEqual([]);
  });

  it('refuses methods it does not implement', async () => {
    expect((await toolPowerHandler(authed({ method: 'DELETE' }))).status).toBe(405);
  });

  it('says so, loudly, when there is no service-role key to write with', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await toolPowerHandler(authed());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});
