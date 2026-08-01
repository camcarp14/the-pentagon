// ═══════════════════════════════════════════════════════════════════════════
// TOOL POWER — which tool owns which background engine, and whether the
// operator has stopped it.
//
// The tool row's power switch promises "pausing ZTS stops what ZTS runs". That
// promise is only as good as the tool→subsystem relation being CORRECT, and a
// relation copied into a React component, an endpoint and three cron files is a
// relation that will be correct in three places and wrong in the fourth. So it
// is written down once, here, and everything else imports it — including the
// sentence the switch shows the operator, because a switch that names the wrong
// engine is the same lie as one that stops the wrong engine.
//
// ─── PAUSE IS `paused_reason`, NOT `enabled` ────────────────────────────────
//
// ops_control has two fields that could carry a pause, and picking the wrong one
// makes RESUME dangerous rather than making PAUSE weak.
//
// `enabled` is the autonomy opt-in. Migration 0001 seeds every row disabled on
// purpose — "opting IN is a deliberate act; nothing here can start acting
// because a default was missed" — and four of the seven engine rows below are
// read by @cc/ops's decide(), which blocks on `enabled !== true`. If the power
// switch wrote `enabled`, then RESUMING a tool would have to write
// `enabled = true`, and an operator who paused ZTS out of curiosity and
// un-paused it thirty seconds later would have armed two autonomous subsystems
// they had never opted into. A pause control that arms autonomy on the way back
// is a worse bug than the decorative switch this whole part exists to remove.
//
// `paused_reason` is already the explicit-stop channel. decide() blocks on it
// independently of `enabled` (guard.js step 3), Ops.jsx already stamps it on the
// global row for STOP, and the Ops console already renders it as a pill. So
// stamping it on a tool's engine rows makes the four guard-gated engines stop
// with no change to them at all, and clearing it restores the operator's prior
// arming state EXACTLY, because that state was never touched.
//
// The other three engines are not guard-gated and never were, so they read this
// same field directly — see enginePause below.
//
// ─── `ops.*` IS NOT A TOOL ──────────────────────────────────────────────────
//
// ops.heartbeat is the containment layer's own pulse. It is not owned by any
// tool, no tool switch may reach it, and the shape of the map is what enforces
// that: it is not in here, so toolOf() returns null for it and the endpoint
// 400s on anything that is not a key of this object. PAUSABLE_KEYS is asserted
// free of `ops.` in the tests rather than left to a reader noticing.
// ═══════════════════════════════════════════════════════════════════════════
import { adminClient } from '../functions/lib/ops-runtime.mjs';

/**
 * Written on `paused_reason` by the tool switch. Ops.jsx renders this string
 * verbatim in the subsystem list, so it reads as a sentence there, and it names
 * the control that did it — the Ops console's own STOP writes "stopped from the
 * Ops console" on the global row for the same reason: two different humans-with-
 * a-button must be tellable apart six weeks later.
 */
export const PAUSE_REASON = 'paused from the tool switch';

/**
 * How an engine is stopped, which is the only thing that differs between the
 * seven rows and the reason this field exists rather than being inferred:
 *
 *   'guard'    the cron already calls decide() through ops-runtime, so a
 *              `paused_reason` blocks it with no change to the cron itself.
 *   'monitor'  the cron predates the containment layer, takes no tier-1+ action
 *              and never opted in, so it reads the pause row directly. Its
 *              `enabled` column is DESCRIPTIVE — nothing consults it — which is
 *              why seedRow below seeds it true for these and leaves the table
 *              default alone for the others. A row saying "disabled" beside a
 *              cron that runs every 30 minutes is a lie in the one console whose
 *              whole job is telling you what is running.
 */
export const GATE = Object.freeze({ GUARD: 'guard', MONITOR: 'monitor' });

/**
 * The map. `key` is the ops_control row; `label` is how the engine is named to
 * the operator; `cron` is the file, so a reader of this table can go and check.
 *
 * `keeps` is the honest footnote: what a PAUSED pass still does. Only one engine
 * has one, and it is not an oversight that the others are null — see alt-watch's
 * entry.
 */
export const TOOL_ENGINES = Object.freeze({
  zts: Object.freeze([
    Object.freeze({ key: 'zts.content', label: 'the content engine', cron: 'content-engine', gate: GATE.GUARD, keeps: null }),
    Object.freeze({ key: 'zts.store', label: 'store ingest', cron: 'zts-ingest', gate: GATE.GUARD, keeps: null }),
  ]),
  clarify: Object.freeze([
    Object.freeze({ key: 'clarify.outbound', label: 'the outbound engine', cron: 'outbound-engine', gate: GATE.GUARD, keeps: null }),
    Object.freeze({ key: 'clarify.replies', label: 'reply detection', cron: 'replies-cron', gate: GATE.GUARD, keeps: null }),
  ]),
  runway: Object.freeze([
    Object.freeze({ key: 'runway.scan', label: 'the weekday board scan', cron: 'scan-cron', gate: GATE.MONITOR, keeps: null }),
  ]),
  macro: Object.freeze([
    Object.freeze({ key: 'macro.watch', label: 'the MSTR stop sentinel', cron: 'watch-snapshot', gate: GATE.MONITOR, keeps: null }),
    Object.freeze({
      key: 'macro.alts', label: 'the alt sentinel', cron: 'alt-watch', gate: GATE.MONITOR,
      // THE ONE THING A PAUSE MAY NOT STOP. CoinGecko serves today's BTC
      // dominance and has no history endpoint at any price we pay, so this pass
      // writing one row per calendar day IS the dominance series — read
      // alt-watch.mjs's header. Every other effect of a pause is undone by
      // un-pausing; a day this pass did not sample is gone permanently, which
      // would make PAUSE a destructive, irreversible operation. So a paused alt
      // sentinel still takes the one cheap sample and does nothing else, and
      // this string is what lets the UI say so instead of over-promising.
      keeps: 'the daily BTC-dominance sample, which nothing can backfill',
    }),
  ]),
  looper: Object.freeze([]),
  business: Object.freeze([]),
  sync: Object.freeze([]),
  ideas: Object.freeze([]),
});

/** Every tool the switch knows about, pausable or not. Order is the map's. */
export const TOOLS = Object.freeze(Object.keys(TOOL_ENGINES));

/** Every ops_control row the switch may ever write. The endpoint reads exactly
 *  these in one round trip, and the test asserts none of them is an `ops.*`. */
export const PAUSABLE_KEYS = Object.freeze(
  TOOLS.flatMap((t) => TOOL_ENGINES[t].map((e) => e.key)),
);

/** Engines for a tool. An unknown id answers [] rather than undefined, because
 *  every caller here is either rendering a list or counting one. */
export function enginesFor(tool) {
  return Object.prototype.hasOwnProperty.call(TOOL_ENGINES, tool) ? TOOL_ENGINES[tool] : [];
}

export const engineKeys = (tool) => enginesFor(tool).map((e) => e.key);

export const isKnownTool = (tool) =>
  typeof tool === 'string' && Object.prototype.hasOwnProperty.call(TOOL_ENGINES, tool);

/**
 * May this tool be paused at all?
 *
 * Exported for the same reason tabPrefs exports canHide: the UI must be able to
 * DISABLE the control and explain why, rather than render a switch that accepts
 * a tap and does nothing. Four of the eight tools run nothing in the background
 * and a power switch on them would be a decoration.
 */
export const isPausable = (tool) => enginesFor(tool).length > 0;

/** Which tool owns an engine row, or null. `ops.heartbeat` answers null, which
 *  is what keeps it unreachable from the tool switch. */
export function toolOf(engineKey) {
  for (const t of TOOLS) if (engineKeys(t).includes(engineKey)) return t;
  return null;
}

/** The one engine descriptor for a row key, or null for a key no tool owns. */
export function engineOf(engineKey) {
  for (const t of TOOLS) {
    const hit = enginesFor(t).find((e) => e.key === engineKey);
    if (hit) return hit;
  }
  return null;
}

/**
 * Is this control row a pause?
 *
 * A non-empty `paused_reason` and nothing else. Whitespace does not count: a row
 * whose reason is " " would render as a pause pill with no words in it, and the
 * operator would have no way to learn what stopped their tool.
 */
export function isPausedRow(row) {
  return typeof row?.paused_reason === 'string' && row.paused_reason.trim().length > 0;
}

/** The columns a pause (or a resume) writes. `updated_at` is included because
 *  the table's default only fires on INSERT — Ops.jsx sets it by hand for the
 *  same reason. */
export function pauseFields(paused, now = Date.now()) {
  const at = new Date(now).toISOString();
  return paused
    ? { paused_reason: PAUSE_REASON, paused_at: at, updated_at: at }
    : { paused_reason: null, paused_at: null, updated_at: at };
}

/**
 * Fold the control rows we found onto the map, for one tool.
 *
 * PAUSED MEANS EVERY ENGINE IS STOPPED, NOT ONE OF THEM. A tool with two engines
 * where only one carries a pause is still running half of what it runs, and
 * reporting that as "paused" is precisely the lie the switch exists to avoid —
 * so it reports `paused: false, partial: true` and the UI has the two facts it
 * needs to say "ZTS is partly paused; store ingest is still running". That state
 * is not reachable through the endpoint, which writes every row for a tool at
 * once; it is reachable through a half-failed write or a hand edit, which is
 * exactly when an honest answer matters.
 *
 * A tool with no engines is `paused: false` with an empty list — there is
 * nothing to stop, and the UI says so instead of offering a switch.
 */
export function summariseTool(tool, rowsByKey = new Map()) {
  const engines = enginesFor(tool).map((e) => {
    const row = rowsByKey.get(e.key) || null;
    return {
      key: e.key,
      label: e.label,
      cron: e.cron,
      keeps: e.keeps,
      // `registered: false` is not an error state. A monitor row is created the
      // first time its cron runs or the first time the switch is used, so a
      // fresh deploy legitimately has none — and "no row" means "not paused",
      // which is what the engine itself concludes.
      registered: !!row,
      enabled: row ? row.enabled === true : null,
      paused: isPausedRow(row),
      pausedReason: isPausedRow(row) ? row.paused_reason : null,
      pausedAt: isPausedRow(row) ? (row.paused_at ?? null) : null,
    };
  });
  const stopped = engines.filter((e) => e.paused);
  const partial = stopped.length > 0 && stopped.length < engines.length;
  return {
    label: tool,
    pausable: engines.length > 0,
    paused: engines.length > 0 && stopped.length === engines.length,
    partial,
    // THE SAME FACT UNDER THE NAME THE SHELL'S NORMALIZER USES. One expression,
    // two keys, so they cannot drift — and the boundary survives either side
    // being written first, which is what actually happened. `stopped` is here
    // for the same reason: the shell derives it today from `enabled`, and
    // `enabled` is not the pause (see this file's header) — a subsystem the
    // operator armed still reads `enabled: true` while paused, and one they
    // never armed reads `enabled: false` while running perfectly well. Serving
    // the answer removes the need for anyone downstream to derive it wrongly.
    mixed: partial,
    stopped: stopped.map((e) => e.key),
    stops: stopsSentence(tool),
    keeps: keepsSentence(tool),
    engines,
  };
}

/** The whole map folded at once — the GET body. */
export function summariseAll(rowsByKey = new Map()) {
  const tools = {};
  for (const t of TOOLS) tools[t] = summariseTool(t, rowsByKey);
  return tools;
}

/**
 * "Pauses the content engine and store ingest." — the sentence the switch shows.
 *
 * Generated from the map rather than typed into the component, because the
 * failure being prevented is a real one and cheap to hit: a fifth engine gets
 * added here, the switch stops it, and the copy beside the switch still names
 * four. Then the operator is reading a promise that is quietly incomplete.
 */
export function stopsSentence(tool) {
  const labels = enginesFor(tool).map((e) => e.label);
  if (!labels.length) return null;
  return `Pauses ${andList(labels)}.`;
}

/** The counterweight: what a pause does NOT stop. Null for every tool but Macro,
 *  and the UI must render it whenever it is non-null — an operator told "paused"
 *  who then sees a dominance row appear the next morning has been misled by
 *  omission. */
export function keepsSentence(tool) {
  const keeps = enginesFor(tool).map((e) => e.keeps).filter(Boolean);
  if (!keeps.length) return null;
  return `Still records ${andList(keeps)}.`;
}

function andList(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// The I/O half — one function, and the crons' only call into this file.
//
// It lives beside the map rather than in its own module because there is exactly
// one of it and it exists to answer one question about one column; splitting it
// out would put the map and the only thing that reads it in different
// directories for no gain.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * WHY AN UNREADABLE PAUSE LETS THE PASS RUN.
 *
 * ops-runtime fails CLOSED on an unreadable control row, and it is right to: it
 * gates actions that spend money and touch customers, so "I don't know" must
 * mean "don't". The three engines that call this are not those. They are
 * monitors — they read public feeds and write our own tables — and the asymmetry
 * runs the other way:
 *
 *   a wrong RUN costs one Telegram message, or one scan of public job boards
 *     into an inbox the operator triages anyway;
 *   a wrong SKIP costs a day of the dominance series that nothing can rebuild,
 *     a missed STOP HIT alert on a live position, or a cancelled weekday scan
 *     with the next one 24 hours away.
 *
 * So an indeterminate read runs the pass and SAYS SO — `unknown` is in the
 * return, on the console line and in the response body, because the way this
 * becomes the decorative switch it is meant to prevent is by failing open
 * quietly. It is also bounded: nothing is cached, so the next pass re-reads.
 *
 * The no-credentials case is not a compromise at all. `/api/tool-power` writes
 * this table with the service role, so a deploy without SUPABASE_SERVICE_ROLE_KEY
 * is a deploy where no pause can have been recorded — running is not a guess
 * there, it is the only correct answer.
 *
 * Never throws, for the reason alt-watch's header gives: a scheduled function
 * that 500s writes no dominance row.
 *
 * @returns {Promise<{paused: boolean, unknown: boolean, reason: string|null, why: string|null}>}
 */
export async function enginePause(key, { now = Date.now() } = {}) {
  const running = { paused: false, unknown: false, reason: null, why: null };
  const unknown = (why) => ({ paused: false, unknown: true, reason: null, why });

  let sb;
  try {
    sb = adminClient();
  } catch (ex) {
    return unknown(`no service-role credentials, so no pause can have been recorded: ${ex.message}`);
  }

  try {
    const { data, error } = await sb
      .from('ops_control')
      .select('key, enabled, paused_reason, paused_at')
      .eq('key', key)
      .maybeSingle();
    if (error) return unknown(`ops_control read failed: ${error.message}`);

    if (!data) {
      // Seeded on the read that found nothing rather than on every pass: the
      // switch needs a row to exist before it can be written, and Ops needs one
      // before it can list the engine at all. Insert-only and best-effort — a
      // failure here costs the operator a switch that reports "not registered
      // yet", never a pass.
      await seedRow(sb, key, now);
      return running;
    }
    return isPausedRow(data)
      ? { paused: true, unknown: false, reason: data.paused_reason, why: null }
      : running;
  } catch (ex) {
    return unknown(`ops_control read threw: ${String(ex?.message || ex)}`);
  }
}

/**
 * Give an engine a control row, using the table's defaults except where the
 * default would be false about a cron that runs.
 *
 * `ignoreDuplicates` is the whole safety property, and it is the same one
 * registerSubsystem relies on: an existing row is never rewritten, so this can
 * never re-enable something the operator turned off, never widen a cap they
 * narrowed, and never clear a pause they set thirty seconds ago.
 */
export async function seedRow(sb, key, now = Date.now()) {
  const row = { key, updated_at: new Date(now).toISOString() };
  // See GATE.MONITOR: `enabled` is descriptive for these three and nothing reads
  // it, so seeding the table's `false` would put "disabled" in the Ops console
  // next to a cron firing every 30 minutes. Guard-gated engines keep the
  // table default, because for them the default IS the meaning: opt in
  // deliberately or do not run.
  if (engineOf(key)?.gate === GATE.MONITOR) row.enabled = true;
  try {
    const { error } = await sb.from('ops_control').upsert(row, { onConflict: 'key', ignoreDuplicates: true });
    // Said out loud rather than swallowed: with no row the switch has nothing to
    // write, so this failing silently is how a power switch ends up reporting
    // "not registered yet" forever with no clue why.
    if (error) console.warn(`[tool-power] could not register ${key}: ${error.message}`);
  } catch (ex) {
    console.warn(`[tool-power] could not register ${key}: ${String(ex?.message || ex)}`);
  }
}
