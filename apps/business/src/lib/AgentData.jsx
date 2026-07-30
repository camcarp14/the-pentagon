// ═══════════════════════════════════════════════════════════════════════════
// The shared read layer: nine sources, one socket, one clock.
//
// Polling cadence is per-source (see tables.js) because the panels do not age
// alike — the action ledger goes stale in 45 minutes, the month's budget caps
// do not. Realtime is used on exactly two tables. Nine subscriptions would be
// nine sockets of phone battery for data that moves on the scale of hours.
//
// The rule this layer exists to enforce: a failed read NEVER degrades to an
// empty one. On error the previous rows are kept and the source is marked
// `error` with the age of the last good round trip, so the panel above can
// render an alarm over stale data instead of a calm zero over nothing. Losing
// the rows would be the friendlier-looking bug and the more dangerous one.
// ═══════════════════════════════════════════════════════════════════════════
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { agentSb, activeFault } from "./agentClient.js";
import { SOURCES } from "./tables.js";
import { panelState } from "./freshness.js";
import { newestAt } from "./format.js";

const Ctx = createContext(null);

/** Matches halt.js. A read that has not answered in 8s has failed, not "is slow". */
export const READ_TIMEOUT_MS = 8000;

const blank = () => ({ status: "idle", rows: [], error: null, errorKind: null, fetchedAtMs: null, newestAtMs: null });

/**
 * Why a read failed decides what the operator should DO, so the three cases
 * cannot share a sentence. Reporting a rejected session as "can't reach the
 * agent database" sends someone to check a database that is answering fine —
 * and the tab used to compound it by adding "the HALT button still works over
 * its own connection", which is false when the token is the problem: the halt
 * path carries the same token and 401s identically.
 */
export function classifyError(err) {
  const status = err?.status ?? err?.originalError?.status;
  const code = err?.code || "";
  const msg = String(err?.message || err || "");
  if (err?.name === "AbortError" || /abort/i.test(msg)) return "timeout";
  if (status === 401 || status === 403 || code === "PGRST301" || /jwt|token|not authenticated|invalid claim/i.test(msg)) return "auth";
  if (code === "42501" || /permission denied/i.test(msg)) return "denied";
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return "network";
  return "db";
}

export function describeError(err) {
  const kind = classifyError(err);
  const msg = err?.message || String(err);
  if (kind === "timeout") return `The agent database did not answer within ${READ_TIMEOUT_MS / 1000}s.`;
  if (kind === "auth") return `The agent project rejected this session (${msg}). Sign in again.`;
  if (kind === "denied") return `The database refused this read (${msg}).`;
  return msg;
}

const initialState = () => {
  const s = {};
  for (const k of Object.keys(SOURCES)) s[k] = blank();
  return s;
};

/**
 * A ticking clock, shared. Countdowns need a second-resolution `now`, and
 * every panel deriving its own interval would mean nine timers redrawing the
 * page out of step with each other.
 */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer = null;
    const start = () => { stop(); timer = setInterval(() => setNow(Date.now()), intervalMs); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => {
      // A backgrounded tab that keeps ticking is battery spent to redraw
      // nothing. On return, snap to the real time immediately — otherwise the
      // first frame after unlocking the phone shows a countdown from before
      // it was locked, which is a stale number rendered as a live one.
      if (document.visibilityState === "visible") { setNow(Date.now()); start(); } else stop();
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [intervalMs]);
  return now;
}

export function AgentDataProvider({ children }) {
  const [sources, setSources] = useState(initialState);
  const mounted = useRef(true);
  const inflight = useRef({});
  const fault = activeFault();

  // Set on the way IN as well as cleared on the way out. A cleanup-only version
  // is a one-way latch: React 18 runs mount → cleanup → mount for every effect
  // under StrictMode, which leaves `mounted` false for the life of the provider
  // and makes fetchSource discard every response it ever receives — ten panels
  // stuck in the loading skeleton with the network tab full of 200s.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const fetchSource = useCallback(async (key) => {
    const spec = SOURCES[key];
    if (!spec) return;
    // One request per source at a time. Realtime bursts plus a poll tick can
    // otherwise stack four identical queries and resolve them out of order,
    // which lands OLDER rows after newer ones.
    if (inflight.current[key]) return;
    inflight.current[key] = true;

    // An in-flight retry must never erase a known failure. A source that has
    // never succeeded still has `fetchedAtMs === null`, so the old form flipped
    // "error" back to "loading" on every poll tick: during a total outage each
    // panel oscillated between the red alarm and a neutral skeleton that is
    // indistinguishable from first paint. freshness.js already treats
    // error-with-no-successful-fetch as ERROR; this kept defeating it.
    setSources((s) => ({
      ...s,
      [key]: { ...s[key], status: s[key].fetchedAtMs || s[key].status === "error" ? s[key].status : "loading" },
    }));

    // A read with no deadline is the worst outage this tab can have, and it is
    // the one it used to ship with. A database that accepts the connection and
    // never answers — the ordinary hung backend, not a refused connection —
    // leaves the promise pending forever. `inflight` then latches true for that
    // source for the life of the page, so every later poll tick returns at the
    // guard and no request is ever attempted again. Measured before this fix:
    // 5 requests total across 45 seconds, 6 of 9 sources never firing once, and
    // every panel sitting behind a calm green freshness chip over its last-good
    // rows. On a cold load the same hang left all ten panels in the LOADING
    // skeleton indefinitely — B3 says an outage must be unmistakable from a
    // skeleton, and it WAS the skeleton.
    //
    // halt.js has had an 8s AbortController since it was written. This is the
    // same discipline, arriving late, on the path that needed it just as much.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), READ_TIMEOUT_MS);

    try {
      if (!agentSb) throw new Error("The agent project is not configured.");
      // ?fault=db — B3's check, from the browser, with no rebuild.
      if (fault === "db") throw new Error("Injected fault: the agent database is unreachable (?fault=db).");

      let q = agentSb.from(spec.table).select(spec.select);
      if (spec.order) q = q.order(spec.order.column, { ascending: !!spec.order.ascending, nullsFirst: false });
      if (spec.limit) q = q.limit(spec.limit);

      const { data, error } = await q.abortSignal(ctrl.signal);
      if (error) throw error;
      if (!mounted.current) return;

      let rows = Array.isArray(data) ? data : data ? [data] : [];
      if (fault === "stale") {
        // Back-date every timestamp by three hours so the stale path can be
        // seen without waiting for it.
        const shift = 3 * 3_600_000;
        rows = rows.map((r) => {
          const t = r?.[spec.timeColumn];
          const ms = t ? Date.parse(t) : NaN;
          return Number.isFinite(ms) ? { ...r, [spec.timeColumn]: new Date(ms - shift).toISOString() } : r;
        });
      }

      setSources((s) => ({
        ...s,
        [key]: {
          status: "ok",
          rows,
          error: null,
          fetchedAtMs: Date.now(),
          newestAtMs: newestAt(rows, spec.timeColumn),
        },
      }));
    } catch (err) {
      if (!mounted.current) return;
      setSources((s) => ({
        ...s,
        [key]: {
          ...s[key],
          status: "error",
          // Rows are deliberately KEPT. See the header: an outage that empties
          // the screen looks like an agent with nothing to do.
          error: describeError(err),
          errorKind: classifyError(err),
        },
      }));
    } finally {
      clearTimeout(timer);
      // Must run on EVERY exit, including the aborted one — this is the latch
      // that stopped all further polling when a request never settled.
      inflight.current[key] = false;
    }
  }, [fault]);

  const refreshAll = useCallback(() => {
    for (const k of Object.keys(SOURCES)) fetchSource(k);
  }, [fetchSource]);

  // ─── polling, per source ───────────────────────────────────────────────────
  useEffect(() => {
    refreshAll();
    const timers = Object.entries(SOURCES).map(([key, spec]) =>
      setInterval(() => {
        if (document.visibilityState === "visible") fetchSource(key);
      }, spec.pollMs || 60_000)
    );
    return () => timers.forEach(clearInterval);
  }, [fetchSource, refreshAll]);

  // ─── back from the lock screen ─────────────────────────────────────────────
  // The whole usage pattern is "open it on a phone after six hours". Without
  // this, the first thing seen on every visit is six-hour-old rows sitting
  // there looking current until the first poll tick lands.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") refreshAll(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refreshAll]);

  // ─── realtime: action_ledger + approvals, and nothing else ─────────────────
  useEffect(() => {
    if (!agentSb || fault === "db") return;
    const realtimeKeys = Object.entries(SOURCES).filter(([, s]) => s.realtime);
    if (realtimeKeys.length === 0) return;

    // Refetch on change rather than splicing the payload into local state:
    // a payload merge has to reimplement the ORDER BY and the LIMIT, and an
    // UPDATE that moves a row out of the query's window is invisible to it.
    // Refetching is one cheap request and cannot drift from what a reload shows.
    const debounce = {};
    const bump = (key) => {
      clearTimeout(debounce[key]);
      debounce[key] = setTimeout(() => fetchSource(key), 350);
    };

    const channel = agentSb.channel("business-tab");
    for (const [key, spec] of realtimeKeys) {
      channel.on("postgres_changes", { event: "*", schema: "public", table: spec.table }, () => bump(key));
    }
    channel.subscribe();

    return () => {
      Object.values(debounce).forEach(clearTimeout);
      agentSb.removeChannel(channel);
    };
  }, [fetchSource, fault]);

  const value = useMemo(() => ({ sources, refresh: fetchSource, refreshAll, fault }), [sources, fetchSource, refreshAll, fault]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * One source, plus its resolved B3 state. Panels never see a raw row array
 * without the state that says whether to believe it.
 */
export function useSource(key, now = Date.now()) {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSource() must be used inside <AgentDataProvider>");
  const spec = SOURCES[key];
  const src = ctx.sources[key] || blank();
  const state = panelState({
    status: src.status,
    rowCount: src.rows.length,
    newestAtMs: src.newestAtMs,
    fetchedAtMs: src.fetchedAtMs,
    error: src.error,
    errorKind: src.errorKind,
    maxAgeMin: spec?.maxAgeMin,
    maxFetchAgeMin: spec?.maxFetchAgeMin,
    expectsRows: spec?.expectsRows !== false,
    now,
  });
  return { ...src, state, refresh: () => ctx.refresh(key), spec };
}

export function useAgentData() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAgentData() must be used inside <AgentDataProvider>");
  return ctx;
}

/**
 * `?fault=loader` — B1's check. Throws where it is rendered, so whatever
 * boundary encloses it goes down. It is deliberately placed inside every
 * region EXCEPT the halt control, which reaches the database over its own
 * path (halt.js) and is expected to keep working while this burns.
 */
export function LoaderFault() {
  if (activeFault() === "loader") {
    throw new Error("Injected fault: the shared data loader threw (?fault=loader).");
  }
  return null;
}
