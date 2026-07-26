// ═══════════════════════════════════════════════════════════════════════════
// B3 — the honesty layer, and the reason this tab exists.
//
// A dashboard that renders a peaceful `0` during an outage is worse than no
// dashboard, because it actively tells you the thing is fine. So there is no
// code path in this tab that produces a bare number: every panel resolves to
// exactly one of these states first, and the state decides the chrome.
//
//   LOADING  — we have not heard back yet. A skeleton shaped like the answer.
//   ERROR    — we could not reach the database. Alarm. Never a zero.
//   EMPTY    — we reached it, and it genuinely has no rows in this window.
//              Says so out loud, with the time of the successful check.
//   STALE    — we reached it, there are rows, and the newest one is too old.
//              Alarm, with the actual age.
//   FRESH    — the only calm state.
//
// EMPTY and ERROR are the pair that matters. "No actions in the last hour" and
// "we couldn't reach the database" are the same pixels in almost every
// dashboard ever generated, and they mean opposite things.
//
// Two ages, not one, because they fail independently:
//   dataAge  — how old the newest ROW is. Catches a stopped agent.
//   fetchAge — how long since we last successfully TALKED to the database.
//              Catches a stopped page: a dead poller leaves fresh-looking data
//              on screen forever, and nothing about the rows themselves says so.
// ═══════════════════════════════════════════════════════════════════════════

export const PANEL = {
  LOADING: "loading",
  ERROR: "error",
  EMPTY: "empty",
  STALE: "stale",
  FRESH: "fresh",
};

/** B3's line in the sand: newest row older than this and the panel alarms. */
export const MAX_AGE_MIN = 45;

/**
 * Resolve one panel's state.
 *
 * @param {object}   o
 * @param {'idle'|'loading'|'ok'|'error'} o.status  the fetch's own status
 * @param {number}   o.rowCount    rows currently held
 * @param {number?}  o.newestAtMs  newest row's timestamp
 * @param {number?}  o.fetchedAtMs last SUCCESSFUL round trip
 * @param {string?}  o.error       message from the last failure
 * @param {number}   o.maxAgeMin   staleness threshold for this panel
 * @param {boolean}  o.expectsRows false for panels where "no rows" is normal
 *                                 (e.g. an approvals queue nobody has filled).
 *                                 An empty panel that expects rows is an ALARM;
 *                                 one that doesn't is merely empty.
 * @param {number}   o.now
 */
export function panelState({
  status = "idle",
  rowCount = 0,
  newestAtMs = null,
  fetchedAtMs = null,
  error = null,
  maxAgeMin = MAX_AGE_MIN,
  expectsRows = true,
  now = Date.now(),
} = {}) {
  const maxAgeMs = Math.max(0, maxAgeMin) * 60_000;
  const dataAgeMs = Number.isFinite(newestAtMs) ? Math.max(0, now - newestAtMs) : null;
  const fetchAgeMs = Number.isFinite(fetchedAtMs) ? Math.max(0, now - fetchedAtMs) : null;

  const base = { dataAgeMs, fetchAgeMs, rowCount, error: error || null, maxAgeMin };

  // Never reached the database. There is nothing truthful to draw but a
  // skeleton — and a skeleton must never be mistaken for "empty", so it is its
  // own state rather than a zero with a spinner on it.
  if ((status === "loading" || status === "idle") && fetchedAtMs === null) {
    return { ...base, state: PANEL.LOADING, alarm: false, headline: "Loading", detail: null };
  }

  // Failed. This holds even when we still have rows from a previous poll: old
  // data during an outage is exactly the situation that produces a confident
  // wrong answer, so the panel alarms and labels what it is showing as stale.
  if (status === "error") {
    return {
      ...base,
      state: PANEL.ERROR,
      alarm: true,
      headline: "Can't reach the agent database",
      detail: fetchAgeMs === null
        ? "No successful connection this session."
        : `Last successful read ${fmtAge(fetchAgeMs)} ago. Anything below is from then, not now.`,
    };
  }

  // A poller that stopped ticking (a throw in the loader, a backgrounded tab
  // that never resumed) leaves data that LOOKS live. If we haven't managed a
  // round trip inside the staleness window, say so — regardless of row age.
  if (fetchAgeMs !== null && fetchAgeMs > maxAgeMs) {
    return {
      ...base,
      state: PANEL.STALE,
      alarm: true,
      headline: "Not refreshing",
      detail: `Last successful read ${fmtAge(fetchAgeMs)} ago — longer than the ${maxAgeMin}-minute window. This panel is not updating.`,
    };
  }

  if (rowCount === 0) {
    return {
      ...base,
      state: PANEL.EMPTY,
      // Empty is an alarm wherever rows are expected to arrive continuously.
      // For an agent that ticks, "no actions at all in the window" is not a
      // calm state — it is the same news as a stale one, arriving differently.
      alarm: !!expectsRows,
      headline: expectsRows ? "No rows in the window" : "Nothing here",
      detail: fetchAgeMs === null
        ? "Database reachable."
        : `Database reachable — checked ${fmtAge(fetchAgeMs)} ago. It really is empty.`,
    };
  }

  if (dataAgeMs === null) {
    // Rows with no usable timestamp. We cannot prove freshness, so we do not
    // claim it.
    return {
      ...base,
      state: PANEL.STALE,
      alarm: true,
      headline: "Age unknown",
      detail: "These rows carry no readable timestamp, so their freshness can't be verified.",
    };
  }

  if (dataAgeMs > maxAgeMs) {
    return {
      ...base,
      state: PANEL.STALE,
      alarm: true,
      headline: `Stale — newest is ${fmtAge(dataAgeMs)} old`,
      detail: `Nothing newer than the ${maxAgeMin}-minute window. The database is reachable, so the agent is what stopped.`,
    };
  }

  return {
    ...base,
    state: PANEL.FRESH,
    alarm: false,
    headline: "Live",
    detail: `Newest ${fmtAge(dataAgeMs)} ago.`,
  };
}

// Local, so this module stays import-free and unit-testable in isolation.
function fmtAge(ms) {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** Roll several panel states into one worst-case for the top-of-page banner. */
export function worstState(states) {
  const rank = { [PANEL.ERROR]: 4, [PANEL.STALE]: 3, [PANEL.EMPTY]: 2, [PANEL.LOADING]: 1, [PANEL.FRESH]: 0 };
  let worst = null;
  for (const s of states || []) {
    if (!s) continue;
    if (!worst || (rank[s.state] ?? 0) > (rank[worst.state] ?? 0)) worst = s;
  }
  return worst;
}
