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

const blank = () => ({ status: "idle", rows: [], error: null, fetchedAtMs: null, newestAtMs: null });

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

  useEffect(() => () => { mounted.current = false; }, []);

  const fetchSource = useCallback(async (key) => {
    const spec = SOURCES[key];
    if (!spec) return;
    // One request per source at a time. Realtime bursts plus a poll tick can
    // otherwise stack four identical queries and resolve them out of order,
    // which lands OLDER rows after newer ones.
    if (inflight.current[key]) return;
    inflight.current[key] = true;

    setSources((s) => ({ ...s, [key]: { ...s[key], status: s[key].fetchedAtMs ? s[key].status : "loading" } }));

    try {
      if (!agentSb) throw new Error("The agent project is not configured.");
      // ?fault=db — B3's check, from the browser, with no rebuild.
      if (fault === "db") throw new Error("Injected fault: the agent database is unreachable (?fault=db).");

      let q = agentSb.from(spec.table).select(spec.select);
      if (spec.order) q = q.order(spec.order.column, { ascending: !!spec.order.ascending, nullsFirst: false });
      if (spec.limit) q = q.limit(spec.limit);

      const { data, error } = await q;
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
          error: err?.message || String(err),
        },
      }));
    } finally {
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
    maxAgeMin: spec?.maxAgeMin,
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
