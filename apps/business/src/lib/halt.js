// ═══════════════════════════════════════════════════════════════════════════
// B1 — the halt button's own path to the database.
//
// THIS MODULE IMPORTS NOTHING. That is not stylistic. The halt button has to
// work on the worst day this tab will ever have — the day the data loader is
// throwing, a panel component is in an error boundary, the query cache is full
// of rejected promises, and the page is half-rendered. Every import is a
// module that could be the one that broke. So this file reaches for
// `import.meta.env` itself, builds its own request with `fetch`, parses its own
// response, and shares no state, no cache, and no error handling with the rest
// of the tab.
//
// It also does not do optimistic UI. `halted: true` on the screen means the
// database returned a row saying `halted = true` — nothing else earns that
// paint. An optimistic halt button is a button that says "stopped" when the
// PATCH is still in flight, or when it failed, and this is the one control
// where being wrong in that direction is unacceptable.
//
// The subtle failure this guards against: PostgREST answers a PATCH that
// matched zero rows with `200 []`. RLS blocking the update, a missing column
// grant on a policy-permitted row, a config row that isn't there — all of them
// look like success to `res.ok`. So a write is only successful here if the
// server hands back a row AND that row carries the value we asked for.
// ═══════════════════════════════════════════════════════════════════════════

const URL_ = String(import.meta.env?.VITE_AGENT_SUPABASE_URL || "").trim().replace(/\/+$/, "");
const KEY_ = String(import.meta.env?.VITE_AGENT_SUPABASE_ANON_KEY || "").trim();

// The config table is a singleton keyed 'singleton' (see schema.sql). The halt
// path addresses it by that literal and never looks up an id first: one
// request, not two, and no dependency on a prior read having succeeded.
const CONFIG_ROW = "id=eq.singleton";
const TIMEOUT_MS = 8000;

// ─── the token ───────────────────────────────────────────────────────────────
// Pushed in by the auth layer on every session change. Kept in a module-local
// so that halting never has to call back into a Supabase client that may be
// the thing that's broken. If it was never primed (or the module that primes
// it threw before it ran), we go and read the persisted session out of
// localStorage ourselves — the same place supabase-js keeps it.
let primed = null;

export function primeHaltToken(accessToken) {
  primed = accessToken || null;
}

export const HALT_STORAGE_KEY = "agent-sb-auth";

function tokenFromStorage() {
  try {
    const raw = localStorage.getItem(HALT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.access_token || parsed?.currentSession?.access_token || null;
  } catch {
    return null;
  }
}

function bearer() {
  return primed || tokenFromStorage() || null;
}

// ─── the request ─────────────────────────────────────────────────────────────
async function request(method, { path, body, headers }) {
  if (!URL_ || !KEY_) {
    return { ok: false, code: "not_configured", message: "The agent project's URL and key are not configured in this build." };
  }
  const token = bearer();
  if (!token) {
    return { ok: false, code: "no_session", message: "No agent session — sign in again before halting." };
  }

  // A halt that hangs forever is a halt that failed, and the operator needs to
  // know that in seconds so they can reach for another lever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${URL_}/rest/v1/${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        apikey: KEY_,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err?.name === "AbortError";
    return {
      ok: false,
      code: aborted ? "timeout" : "network",
      message: aborted
        ? `The agent database did not answer within ${TIMEOUT_MS / 1000}s.`
        : `Could not reach the agent database: ${err?.message || "network error"}`,
    };
  }
  clearTimeout(timer);

  const text = await res.text().catch(() => "");
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }

  if (!res.ok) {
    const message = payload?.message || payload?.error_description || text || `HTTP ${res.status}`;
    return {
      ok: false,
      code: res.status === 401 || res.status === 403 ? "denied" : "http",
      status: res.status,
      // 42501 is Postgres's permission-denied. If it shows up on the halt path
      // the column grant is wrong, and saying so beats "something went wrong".
      pgCode: payload?.code || null,
      message,
    };
  }

  return { ok: true, status: res.status, payload };
}

// ─── the three calls the panel actually makes ────────────────────────────────

/**
 * Read the config row back from the server. Used for the halt control's own
 * state, independent of whatever the main data loader is doing — if the loader
 * is dead, this still tells the truth about halted/running.
 */
export async function readConfirmedConfig() {
  const r = await request("GET", { path: `agent_config?${CONFIG_ROW}&select=*` });
  if (!r.ok) return r;
  const row = Array.isArray(r.payload) ? r.payload[0] : null;
  if (!row) {
    return {
      ok: false,
      code: "no_row",
      message: "The agent_config row is missing. The agent has no control row to halt — check the agent project.",
    };
  }
  return { ok: true, row, at: Date.now() };
}

/**
 * Write `halted` and confirm it. Returns the SERVER's row, never the intent.
 *
 * @param {boolean} halted
 * @param {string}  reason  free text, stamped alongside
 * @param {string}  by      who pulled it
 */
export async function setHalted(halted, reason = "", by = "operator") {
  const want = !!halted;
  const patch = {
    halted: want,
    halt_reason: want ? (reason || "Halted from the panel").slice(0, 500) : null,
    halted_at: want ? new Date().toISOString() : null,
    halted_by: want ? by : null,
    updated_at: new Date().toISOString(),
  };

  const r = await request("PATCH", {
    path: `agent_config?${CONFIG_ROW}`,
    body: patch,
    // Ask for the row back so "it worked" is a server fact, not an assumption.
    headers: { Prefer: "return=representation" },
  });
  if (!r.ok) return r;

  const row = Array.isArray(r.payload) ? r.payload[0] : null;
  if (!row) {
    // 200 with an empty array: the request was valid and changed NOTHING.
    // Every other layer treats this as success. It is the opposite.
    return {
      ok: false,
      code: "no_rows_changed",
      message: "The database accepted the request but changed no rows — the halt did NOT take effect. Check RLS and the column grant on agent_config.",
    };
  }
  if (!!row.halted !== want) {
    return {
      ok: false,
      code: "not_applied",
      row,
      message: `The database wrote the row but halted is still ${row.halted}. The halt did NOT take effect.`,
    };
  }
  return { ok: true, row, at: Date.now() };
}

/** Verb 3 — the goal. Same discipline: confirmed row or it didn't happen. */
export async function setGoal(goal) {
  const r = await request("PATCH", {
    path: `agent_config?${CONFIG_ROW}`,
    body: { goal: String(goal ?? "").slice(0, 4000), updated_at: new Date().toISOString() },
    headers: { Prefer: "return=representation" },
  });
  if (!r.ok) return r;
  const row = Array.isArray(r.payload) ? r.payload[0] : null;
  if (!row) {
    return { ok: false, code: "no_rows_changed", message: "The database changed no rows — the goal was not saved." };
  }
  return { ok: true, row, at: Date.now() };
}
