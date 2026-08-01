// ═══════════════════════════════════════════════════════════════════════════
// TOOL POWER — the switch that actually stops things.
//
// tabPrefs.js says in its own header that hiding a tool "changes what the
// operator sees and nothing about what runs… Scheduled functions do not read
// this file and must not." That stays true, and this file is why it CAN stay
// true: pausing is a different store. A cron running on Netlify has no
// localStorage to read, so pause lives in `ops_control` — one row per
// `<tool>.<engine>` — and is reached over /api/tool-power, which stamps
// paused_reason / paused_at the way the Ops console's global STOP already does
// (Ops.jsx: an explicit pause and a never-armed system are two different states
// that used to look identical).
//
// Two switches now sit inches apart in System → Tabs and mean opposite kinds of
// thing. The UI's job is to make that unmistakable; this file's job is to make
// sure the pause switch cannot say anything it has not been told.
//
// ── THE HONESTY RULES, enforced here and not in the component ───────────────
//
//   1. THE COPY IS BUILT FROM THE SERVER'S ANSWER. "Pauses the store snapshot
//      and the content engine" is assembled from the engine rows /api/tool-power
//      actually returned, never from a list written next to the switch. A
//      hardcoded list is a promise about someone else's file: the day an engine
//      is renamed, retired or added in netlify/, a sentence over here goes on
//      naming the old one and the switch starts lying about what it stops.
//   2. NO ENGINES, NO SWITCH. A tool with nothing scheduled gets a sentence
//      saying so. A switch that writes nothing and then renders as if it had is
//      worse than no switch, and this is the shape the contract calls out
//      explicitly: `engines: []` reads as "nothing runs in the background".
//   3. A HALF-PAUSED TOOL SAYS SO. If some rows are enabled and some are not,
//      both "running" and "paused" are false. `mixed` exists so the row can name
//      which engines are down instead of rounding to the comfortable answer.
//   4. `enabled` IS NOT THE PAUSE, and reading it as one is the mistake this
//      file was written making. netlify/shared/toolPower.mjs explains it: rows
//      ship `enabled: false` on purpose (autonomy is opt-in), so four engines
//      that run perfectly well read "disabled", and an armed engine still reads
//      "enabled" while paused. The pause is `paused_reason`, which the endpoint
//      serves already reduced to a boolean per engine. UNKNOWN MEANS RUNNING:
//      the two errors are not symmetric — showing a stopped engine as running
//      wastes a click; showing a running engine as stopped tells the operator
//      nothing is happening while it is still spending money and sending mail.
//   5. WHAT A PAUSE DOES *NOT* STOP IS PART OF THE PROMISE. macro.alts keeps
//      taking its daily BTC-dominance sample even when paused, because that
//      series cannot be backfilled at any price and a pause that destroyed it
//      would be irreversible. The endpoint carries that as `keeps`, and this UI
//      prints it: a switch that silently over-promises is the same defect as one
//      that silently under-delivers.
//   6. `ops.*` IS NOT A TOOL. The containment heartbeat is not pausable from a
//      tool switch. That filter lives here — a row survives only if the half of
//      its key before the dot is a real tool — so no call site can reintroduce
//      it by forgetting.
//
// Pure except for the two fetch functions and the hook at the bottom, so the
// rules above are testable without a network or a DOM.
// ═══════════════════════════════════════════════════════════════════════════
import { useCallback, useEffect, useRef, useState } from "react";
import { APPS } from "@cc/design";
import { auth, supabase } from "@cc/supabase";

export const TOOL_POWER_ENDPOINT = "/api/tool-power";

// 15s, chosen against the platform rather than against a feeling: Netlify's
// synchronous function limit is 10s, so a request still open at 15 is not slow,
// it is gone. Without a bound, `fetch` on a stalled socket leaves the switch
// disabled-and-spinning for minutes with no way back.
export const TOOL_POWER_TIMEOUT_MS = 15_000;

/**
 * A LAST-RESORT name for an engine, never the first one.
 *
 * netlify/shared/toolPower.mjs owns the tool→engine map and ships a `label` on
 * every row precisely so the copy and the behaviour cannot drift ("a switch that
 * names the wrong engine is the same lie as one that stops the wrong engine").
 * The endpoint's label therefore wins wherever it arrives, and this table only
 * covers the case where it does not — an older deploy, or a payload assembled
 * somewhere else. An engine that is in neither falls through to its raw key,
 * which is ugly on purpose: `runway.scan` sitting in the sentence is a visible
 * prompt, where a silently dropped name would be a switch under-promising what
 * it stops.
 */
export const ENGINE_LABELS = {
  "zts.content": "the content engine",
  "zts.store": "store ingest",
  "clarify.outbound": "the outbound engine",
  "clarify.replies": "reply detection",
  "runway.scan": "the weekday board scan",
  "macro.watch": "the MSTR stop sentinel",
  "macro.alts": "the alt sentinel",
};

export const engineLabel = (engine) =>
  (typeof engine === "string" ? ENGINE_LABELS[engine] || engine : engine?.label || ENGINE_LABELS[engine?.key] || engine?.key || "");

const isTool = (name) => APPS.includes(name);

/** "a", "a and b", "a, b and c" — the copy reads as a sentence, not as a list. */
export function joinPhrase(parts) {
  const xs = parts.filter(Boolean);
  if (xs.length === 0) return "";
  if (xs.length === 1) return xs[0];
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/**
 * Fold whatever /api/tool-power returned onto the live APPS list.
 *
 * Same contract as normalizeTabPrefs: it takes anything — null, a string, a
 * 404's HTML, a payload from a build that named the fields differently — and
 * returns an entry for every tool. A tool the server said nothing about reads as
 * "no engines", which rule 2 renders as "nothing runs in the background" rather
 * than as a switch.
 */
export function normalizeToolPower(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const tools = src.tools && typeof src.tools === "object" && !Array.isArray(src.tools) ? src.tools : {};
  const out = {};

  for (const app of APPS) {
    const entry = tools[app] && typeof tools[app] === "object" && !Array.isArray(tools[app]) ? tools[app] : {};
    const engines = (Array.isArray(entry.engines) ? entry.engines : [])
      .filter((e) => e && typeof e === "object" && typeof e.key === "string")
      // Rule 6, and rule 1's other half: a row is this tool's only if its key
      // says so. A stray `ops.heartbeat` under `zts` would otherwise put the
      // containment heartbeat behind a tool switch.
      .filter((e) => e.key.split(".")[0] === app)
      .map((e) => ({
        key: e.key,
        label: typeof e.label === "string" && e.label ? e.label : engineLabel(e.key),
        // Rule 4. `paused` when the endpoint gave one; the reason string when it
        // did not (that IS the pause in ops_control); running otherwise.
        // `enabled` is deliberately never consulted.
        paused: typeof e.paused === "boolean"
          ? e.paused
          : typeof e.pausedReason === "string" && e.pausedReason.trim().length > 0,
        pausedReason: typeof e.pausedReason === "string" && e.pausedReason.trim() ? e.pausedReason : null,
        pausedAt: typeof e.pausedAt === "string" && e.pausedAt ? e.pausedAt : null,
        keeps: typeof e.keeps === "string" && e.keeps.trim() ? e.keeps : null, // rule 5
      }));

    const stopped = engines.filter((e) => e.paused);
    out[app] = {
      engines,
      // The endpoint's own verdict when it gave one; derived otherwise. Derived
      // means EVERY engine down — one of three stopped is not a paused tool.
      paused: typeof entry.paused === "boolean"
        ? entry.paused
        : engines.length > 0 && stopped.length === engines.length,
      mixed: typeof entry.mixed === "boolean" || typeof entry.partial === "boolean"
        ? !!(entry.mixed ?? entry.partial)
        : engines.length > 0 && stopped.length > 0 && stopped.length < engines.length, // rule 3
      stopped: Array.isArray(entry.stopped) && entry.stopped.every((k) => typeof k === "string")
        ? entry.stopped.filter((k) => engines.some((e) => e.key === k))
        : stopped.map((e) => e.key),
      // The two sentences, server-first for the same reason the labels are —
      // one definition of what a pause does, in the file that also does it.
      stops: typeof entry.stops === "string" && entry.stops.trim() ? entry.stops : null,
      keeps: typeof entry.keeps === "string" && entry.keeps.trim() ? entry.keeps : null,
    };
  }
  return { tools: out };
}

export const EMPTY_POWER = normalizeToolPower(null);

export const powerFor = (power, app) => (power?.tools?.[app]) || EMPTY_POWER.tools[app] || { engines: [], paused: false, mixed: false, stopped: [], stops: null, keeps: null };

export const hasEngines = (entry) => (entry?.engines?.length || 0) > 0;

/** The set the tool row dims. Empty when the endpoint could not be read — an
 *  unknown pause state must not paint half the bar as stopped. */
export function pausedTools(power) {
  const out = new Set();
  for (const app of APPS) if (powerFor(power, app).paused) out.add(app);
  return out;
}

/** "Pauses the content engine and store ingest." — rule 1, server sentence first. */
export function stopsSentence(entry) {
  if (!hasEngines(entry)) return null;
  return entry.stops || `Pauses ${joinPhrase(entry.engines.map(engineLabel))}.`;
}

/**
 * What a pause does NOT stop — rule 5.
 *
 * Null for every tool but Macro today, and the null is not an oversight: only
 * one engine keeps doing anything while paused, and only because the sample it
 * takes cannot be backfilled.
 *
 * A WHOLE SENTENCE, both ways. The endpoint's tool-level `keeps` already is one
 * ("Still records the daily BTC-dominance sample…"), so it is passed through
 * untouched; the per-engine `keeps` are FRAGMENTS and get the same frame built
 * around them. Getting that wrong is how copy ends up reading "Still keeps Still
 * records…", which is the sort of thing that makes an operator stop reading the
 * warning that matters.
 */
export function keepsSentence(entry) {
  if (!hasEngines(entry)) return null;
  if (entry.keeps) return entry.keeps;
  const keeps = entry.engines.map((e) => e.keeps).filter(Boolean);
  return keeps.length ? `Still records ${joinPhrase(keeps)}.` : null;
}

/** What is down RIGHT NOW, for the banner over a paused tool's own screen. */
export function stoppedSentence(entry) {
  const byKey = new Map((entry?.engines || []).map((e) => [e.key, e]));
  const names = (entry?.stopped || []).map((k) => engineLabel(byKey.get(k) || k));
  if (names.length === 0) return null;
  return `${joinPhrase(names)} ${names.length === 1 ? "is" : "are"} stopped.`;
}

/**
 * Fold a ONE-TOOL answer into the whole map.
 *
 * PUT does not answer with the map. netlify/functions/tool-power.mjs returns
 * `tools: { [tool]: … }` — just the rows it wrote, read back from the write —
 * and running that through normalizeToolPower produces a complete map in which
 * every OTHER tool has no engines. Applied straight, pausing ZTS silently
 * un-dimmed a paused Macro in the tool row and turned three live switches into
 * "nothing runs in the background". The response is a patch; this is what makes
 * it one.
 */
export function mergeToolPower(power, payload) {
  const cur = normalizeToolPower(power);
  const patch = normalizeToolPower(payload);
  const touched = Object.keys((payload && payload.tools) || {}).filter(isTool);
  const tools = { ...cur.tools };
  for (const app of touched) tools[app] = patch.tools[app];
  return { tools };
}

/** Optimistic local edit, so the switch answers the tap before the network does. */
export function withPaused(power, app, paused) {
  const cur = normalizeToolPower(power);
  if (!isTool(app)) return cur;
  const entry = cur.tools[app];
  const engines = entry.engines.map((e) => ({ ...e, paused }));
  return {
    tools: {
      ...cur.tools,
      [app]: { ...entry, engines, paused: hasEngines(entry) ? paused : false, mixed: false, stopped: paused ? engines.map((e) => e.key) : [] },
    },
  };
}

// ─── the network half ─────────────────────────────────────────────────────────

async function bearer() {
  try { return (await auth.getSession())?.access_token || ""; } catch { return ""; }
}

async function call(method, body) {
  const token = await bearer();
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, TOOL_POWER_TIMEOUT_MS);
  let res, payload;
  try {
    res = await fetch(TOOL_POWER_ENDPOINT, {
      method,
      signal: ctrl.signal,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // A 404 from the SPA fallback answers with index.html, not JSON, so the
    // parse has to be allowed to fail without becoming the error the operator
    // reads. The status is the real signal.
    payload = await res.json().catch(() => null);
  } catch (e) {
    clearTimeout(timer);
    throw new Error(timedOut ? `no answer in ${Math.round(TOOL_POWER_TIMEOUT_MS / 1000)}s` : String(e?.message || e));
  }
  clearTimeout(timer);
  if (res.status === 401 || res.status === 403) throw new Error("this session is not allowed to change it");
  if (!res.ok) throw new Error(payload?.error || `the server answered ${res.status}`);
  return payload;
}

// ─── the direct half, and why it exists ───────────────────────────────────────
//
// /api/tool-power reaches ops_control with the SERVICE-ROLE client, which is
// correct for a scheduled job and unnecessary here — and it is why every row on
// the Tabs page read "Unknown: OPS_ENV_MISSING: SUPABASE_SERVICE_ROLE_KEY" on
// the live deploy. The switch was built, wired, tested and dead, because it
// asked for a key the deploy does not have.
//
// It never needed one. Migration 0002 grants `authenticated` SELECT and UPDATE
// on ops_control (ops_control_read / ops_control_update, both `using (true)`),
// which is exactly how apps/shell/src/Ops.jsx's global stop has always worked
// from the browser. The operator IS an authenticated session; the key buys
// nothing the policy has not already given.
//
// So the endpoint stays the first choice — it is the only path a future
// non-browser caller could use, and it stamps paused_reason/paused_at in one
// place — and this is the fallback when it cannot answer. The crons still need
// the service key to READ the same table server-side, which is a different
// problem and is not fixed here; what is fixed is that the operator's own
// switch no longer depends on it.
//
// Engine rows are derived from ENGINE_LABELS rather than from the table, so a
// tool whose row has never been registered still reports its engines instead of
// looking like a tool with none.
const ENGINES_BY_TOOL = Object.keys(ENGINE_LABELS).reduce((acc, key) => {
  const tool = key.split(".")[0];
  (acc[tool] ||= []).push(key);
  return acc;
}, {});

function toolsFromControlRows(rows) {
  const byKey = new Map((rows || []).map((r) => [r.key, r]));
  const tools = {};
  for (const [tool, keys] of Object.entries(ENGINES_BY_TOOL)) {
    if (!isTool(tool)) continue;
    tools[tool] = {
      engines: keys.map((key) => {
        const row = byKey.get(key);
        return {
          key,
          // A row that has never been written is not "running": the table ships
          // every subsystem disabled, and registerSubsystem only inserts on the
          // first pass. Absent means not yet registered, and the honest read of
          // that is paused.
          enabled: row ? !!row.enabled : false,
          pausedReason: row?.paused_reason ?? null,
          pausedAt: row?.paused_at ?? null,
        };
      }),
    };
  }
  return tools;
}

async function directFetch() {
  if (!supabase) throw new Error("no Supabase client in this build");
  const { data, error } = await supabase.from("ops_control").select("key, enabled, paused_reason, paused_at");
  if (error) throw new Error(error.message || "ops_control is unreadable from this session");
  return { tools: toolsFromControlRows(data) };
}

async function directPut(tool, paused) {
  if (!supabase) throw new Error("no Supabase client in this build");
  const keys = ENGINES_BY_TOOL[tool] || [];
  if (!keys.length) throw new Error(`${tool} has no background engines`);
  // Same shape Ops.jsx writes for the global stop: an explicit pause is
  // RECORDED, not merely `enabled: false`, so a later reader can tell a
  // deliberate stop from a subsystem that was never switched on.
  const { error } = await supabase.from("ops_control").update({
    enabled: !paused,
    paused_reason: paused ? "paused from System → Tabs" : null,
    paused_at: paused ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }).in("key", keys);
  if (error) throw new Error(error.message || "this session is not allowed to change it");
  return directFetch();
}

/** Endpoint first, the operator's own session second. Both are the same table. */
async function viaEndpointThen(directly, method, body) {
  try {
    return await call(method, body);
  } catch (endpointErr) {
    try {
      return await directly();
    } catch (directErr) {
      // The ENDPOINT's message is the one worth showing: it names the missing
      // env var, which is the thing an operator can act on. The fallback's
      // failure is reported second so a genuine RLS refusal is not hidden
      // behind an env complaint.
      throw new Error(`${endpointErr.message} (and directly: ${directErr.message})`);
    }
  }
}

export const fetchToolPower = () => viaEndpointThen(directFetch, "GET");
export const putToolPower = (tool, paused) => viaEndpointThen(() => directPut(tool, paused), "PUT", { tool, paused });

/**
 * One reader for the whole shell.
 *
 * Owned by App.jsx and handed down, rather than called from both the tool row
 * and the System panel: two independent readers would drift the moment one of
 * them wrote, and the bar would go on showing a tool as running seconds after
 * the switch that stopped it.
 */
export function useToolPower() {
  const [power, setPower] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchToolPower();
      if (!alive.current) return;
      setPower(normalizeToolPower(data));
      setError("");
    } catch (e) {
      if (!alive.current) return;
      // `power` is deliberately left as it was. Losing a refresh should not
      // blank the switches; the error line says the state is stale.
      setError(String(e?.message || e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  /**
   * Optimistic, with a real rollback.
   *
   * The failure this guards is the one the contract names: a write that did not
   * happen leaving a switch that says it did. On a throw the previous state is
   * restored from the closure — not re-derived, not re-fetched — so the switch
   * is back where it was before the caller's toast has finished appearing. The
   * error is re-thrown so the caller can say what went wrong.
   */
  const setPaused = useCallback(async (app, paused) => {
    let previous;
    setPower((cur) => { previous = cur; return withPaused(cur, app, paused); });
    setBusy(app);
    try {
      const data = await putToolPower(app, paused);
      if (!alive.current) return;
      // Prefer the server's own answer over the optimistic guess — it is the
      // only thing that knows what the rows actually say now. MERGED, not
      // assigned: the answer covers one tool. See mergeToolPower.
      if (data && data.tools) setPower((cur) => mergeToolPower(cur, data));
      else await reload();
      setError("");
    } catch (e) {
      if (alive.current) setPower(previous);
      throw e;
    } finally {
      if (alive.current) setBusy("");
    }
  }, [reload]);

  return { power, loading, error, busy, reload, setPaused };
}
