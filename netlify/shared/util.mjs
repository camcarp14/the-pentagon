// Shared plumbing for Macro's Netlify functions. Three jobs:
//   1. Auth — verify the caller's Pentagon Supabase session (see checkAuth).
//   2. fetch with a hard timeout so upstream hangs become visible errors.
//   3. Per-source health recording into Netlify Blobs so /api/status
//      reflects reality, not hope.
import { getStore } from '@netlify/blobs'

// Auth: Macro rides The Pentagon's single Supabase login. We verify the caller's
// session token by calling Supabase's /auth/v1/user with the PUBLIC anon key
// (already in the client bundle) — no new secret. Mirrors the other Pentagon
// functions' netlify/functions/_shared/requireAuth.cjs.
const SUPABASE_URL = 'https://nrzpinvyxxorxufadvyc.supabase.co'
const SUPABASE_ANON = 'sb_publishable_zDV3HpSChf0bZJ5nY09s3w_rNI3sZ1m'

// Strong consistency, not the default eventual: journal/settings/position do
// read-modify-write, and an eventually-consistent read can silently drop a
// trade logged 20 seconds earlier — even for one sequential user.
export function store() {
  return getStore({ name: 'torque', consistency: 'strong' })
}

export function unauthorized() {
  return json({ error: 'unauthorized' }, 401)
}

/**
 * THE AUTH CHECK IS SHARED BY NINE HANDLERS AND ITS BLAST RADIUS BELONGS HERE.
 *
 * Every call site of checkAuth / authVerdict, so a change to this file is never
 * again a change whose reach is invisible from the file being changed. The list
 * is pinned by a test (`netlify/shared/__tests__/alts.test.mjs`) that greps the
 * functions directory and fails when it and reality disagree — adding a tenth
 * caller without naming it here is a red suite, not a surprise in production.
 *
 *   journal.mjs · settings.mjs · position.mjs · candles.mjs · status.mjs
 *   watch-snapshot.mjs · alt-coin.mjs · alt-watchlist.mjs
 *   + sourceHandler below, which fronts quote / btc / alt_scan / alt_coin
 *
 * Eight of those predate the Alts work and none of them had a test for this
 * behaviour. They do now.
 */
export const CHECKAUTH_CALLERS = Object.freeze([
  'alt-coin.mjs', 'alt-watchlist.mjs', 'candles.mjs', 'journal.mjs',
  'position.mjs', 'settings.mjs', 'status.mjs', 'watch-snapshot.mjs',
])

/**
 * How long Supabase gets to answer /auth/v1/user before we give up on it.
 *
 * IT WAS 3000ms, AND 3000ms WAS THE WRONG NUMBER IN THE WRONG DIRECTION. The
 * bound itself is right — a raw fetch with no deadline let a Supabase hang hold
 * the whole function until the platform killed it at ~10s, and a platform kill
 * runs no catch block, so every "serve the stale cache instead of 502-ing" path
 * downstream was unreachable in exactly the situation it exists for. But 3s is
 * inside the range a Supabase cold start legitimately takes, and the old code
 * turned that into a bare `false`, which every caller renders as 401
 * "unauthorized" — a working token reported as a bad one, on eight handlers
 * that had never opted into the trade.
 *
 * 6000ms is the pessimistic end of a cold auth round-trip and still leaves ~4s
 * of a ~10s function to build and return the answer. Callers that own a tighter
 * wall clock pass their own budget (see alt-coin.mjs).
 */
export const AUTH_TIMEOUT_MS = 6000

// One verdict per request, not one per call site. alt-coin.mjs authenticates
// before it validates its query params (so a typo cannot make /api/status say
// the upstream is down) and then hands off to sourceHandler, which
// authenticates again — two Supabase round-trips out of a ~10s function budget
// that the stale-cache fallback is counting on. The PROMISE is memoised, not
// the value, so concurrent callers share the one in-flight request too.
//
// Keyed on the Request object in a WeakMap: every invocation gets a fresh
// Request, so a verdict can never outlive the request it was computed for.
const AUTH_VERDICT = new WeakMap()

const refused = (reason) => ({ ok: false, reason, indeterminate: false })
const unreached = (reason) => ({ ok: false, reason, indeterminate: true })
const ALLOWED = Object.freeze({ ok: true, reason: null, indeterminate: false })

/**
 * WAS THIS REQUEST REFUSED, OR WAS IT NEVER ACTUALLY CHECKED?
 *
 * Those are different facts and the old boolean could not tell them apart, so
 * "Supabase was slow" and "your token is forged" produced the same 401. A user
 * cannot act on that and neither can an operator reading a log.
 *
 *   { ok: true }                           — verified
 *   { ok: false, indeterminate: false }    — Supabase ANSWERED and said no, or
 *                                            there was no token to check. 401.
 *   { ok: false, indeterminate: true }     — we never got an answer: timeout,
 *                                            network error, 5xx, unreadable
 *                                            body. Still fails CLOSED, which is
 *                                            the only safe direction for an auth
 *                                            decision — but it is a 503 with the
 *                                            reason on it, not a 401.
 *
 * A valid session proves the caller signed in somewhere on this project; it does
 * not prove they are the operator. These handlers read and REWRITE the trade
 * journal, the position and the risk settings, so the same ALLOWED_EMAIL pin
 * that netlify/functions/lib/auth.mjs applies is applied here. Enforced only
 * when the variable is set, so an unconfigured deploy keeps working — see the
 * matching note in netlify/functions/_shared/requireAuth.cjs.
 */
export async function authVerdict(req, { timeoutMs = AUTH_TIMEOUT_MS } = {}) {
  if (!req || typeof req !== 'object' || typeof req.headers?.get !== 'function') {
    return refused('no request to authenticate')
  }
  const memo = AUTH_VERDICT.get(req)
  if (memo) return memo

  const pending = verifySession(req, timeoutMs)
    .catch((e) => unreached(`supabase session check: ${String(e?.message || e)}`))
    .then((v) => {
      // A VERDICT WE NEVER REACHED IS NOT A VERDICT, SO IT IS NOT CACHED.
      // Memoising it made one transient Supabase blip refuse every later call
      // site on the same request: alt-coin checks before it validates its
      // params and sourceHandler checks again, so a single 500 on the first hop
      // 401'd a request whose second hop would have succeeded. Definitive
      // answers — verified, or Supabase saying no — still memoise, which is
      // what keeps the double check at one round-trip.
      if (v.indeterminate && AUTH_VERDICT.get(req) === pending) AUTH_VERDICT.delete(req)
      return v
    })
  AUTH_VERDICT.set(req, pending)
  return pending
}

/** The boolean the eight pre-existing callers use. Unchanged contract: truthy
 *  means verified, falsy means do not serve. `authVerdict` is for callers that
 *  want to tell a refusal from an outage. */
export async function checkAuth(req, opts) {
  return (await authVerdict(req, opts)).ok
}

/** The response a failed verdict deserves. 401 when Supabase refused the token,
 *  503 + the reason when we could not ask. Handlers that only ever want 401 can
 *  keep calling `unauthorized()` directly. */
export function authRefusal(verdict) {
  return verdict?.indeterminate
    ? json({ error: `auth check could not complete: ${verdict.reason}`, retryable: true }, 503)
    : unauthorized()
}

async function verifySession(req, timeoutMs) {
  const header = req.headers.get('authorization') || req.headers.get('Authorization') || ''
  const token = header.replace(/^Bearer\s+/i, '').trim()
  if (!token) return refused('no bearer token on the request')

  // ONE CONTROLLER FOR THE HANDSHAKE AND THE BODY. fetchWithTimeout clears its
  // timer the moment the headers land, so the `res.json()` below used to run
  // completely unbounded — a stalled response stream held the function past the
  // platform kill while the "hard 3s timeout" comment two lines up said it
  // could not. Measured: a 5s body read returned at 5001ms under a 3000ms cap.
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(new Error(`supabase did not answer within ${timeoutMs}ms`)), timeoutMs)
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
      signal: ctl.signal,
    })
    // 401/403 is Supabase ANSWERING: this token is not a session. Definitive.
    // A 5xx, a 429 or anything else is Supabase not answering — the token is
    // still unproven, so it still fails closed, but it fails as an outage.
    if (res.status === 401 || res.status === 403) return refused('supabase rejected the session token')
    if (!res.ok) return unreached(`supabase session check: HTTP ${res.status}`)

    const allowed = process.env.ALLOWED_EMAIL
    if (!allowed) return ALLOWED
    let user
    try {
      user = await res.json()
    } catch (e) {
      return unreached(`supabase session check: unreadable body (${String(e?.message || e)})`)
    }
    const email = String(user?.email || '').toLowerCase()
    // No email is a definitive refusal, not an outage: ALLOWED_EMAIL pins on
    // one, so a session without an email can never satisfy the pin and telling
    // the caller to retry would be a lie that never resolves.
    if (!email) return refused('the session carries no email, and ALLOWED_EMAIL pins access to one')
    return email === String(allowed).toLowerCase()
      ? ALLOWED
      : refused('this session is not the pinned operator')
  } catch (e) {
    return unreached(`supabase session check: ${String(e?.message || e)}`)
  } finally {
    clearTimeout(t)
  }
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  })
}

/**
 * IT BOUNDS THE HANDSHAKE, NOT THE BODY. The timer is cleared as soon as the
 * headers land, so `await fetchWithTimeout(...)` then `await res.json()` is a
 * bounded wait followed by an unbounded one — a response whose stream stalls
 * mid-body is the same hang wearing a 200. That is fine for the callers here
 * (a ping, a Telegram POST, a small JSON body) and it is NOT fine for anything
 * on a deadline: verifySession above and alts.mjs's getJson each keep one
 * controller alive across both halves for exactly this reason.
 */
export async function fetchWithTimeout(url, opts = {}, timeoutMs = 9000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: ctl.signal })
  } finally {
    clearTimeout(t)
  }
}

/**
 * Record a source's latest fetch outcome. Fire-and-forget by contract:
 * a Blobs hiccup must never fail the data request itself.
 */
export async function recordStatus(name, { ok, latencyMs, error = null, detail = null }) {
  try {
    const s = store()
    const map = (await s.get('source_status', { type: 'json' })) || {}
    const prev = map[name] || {}
    map[name] = {
      name,
      ok,
      at: Date.now(),
      latencyMs: Math.round(latencyMs),
      lastError: ok ? prev.lastError ?? null : String(error ?? 'unknown error'),
      lastErrorAt: ok ? prev.lastErrorAt ?? null : Date.now(),
      lastSuccessAt: ok ? Date.now() : prev.lastSuccessAt ?? null,
      detail,
    }
    await s.setJSON('source_status', map)
  } catch {
    /* never let status bookkeeping break data delivery */
  }
}

/**
 * A handler that SERVED data without reaching its upstream — a stale cache in
 * place of a live fetch — attaches the upstream's failure under this key.
 *
 * Without it, degrading looks identical to succeeding: the handler returns
 * normally, so the health record says `ok: true, lastSuccessAt: now`, and
 * /api/status reports the source green with a detail string copied off the
 * cached payload while the upstream has been down for an hour. That is exactly
 * the "reflects reality, not hope" rule this file opens with, broken by the
 * mechanism that exists to keep the screen alive.
 *
 * A Symbol rather than a field, because `JSON.stringify` drops symbol keys: the
 * marker reaches recordStatus and never reaches the wire, so no client has to
 * know about it and no response shape changes.
 */
export const SOURCE_ERROR = Symbol.for('pentagon.sourceError')

/**
 * The other half of the same rule: a handler that served a FRESH cache hit
 * without touching its upstream marks the payload with this, and no health
 * record is written at all.
 *
 * Recording `ok: true, lastSuccessAt: now` off a cache hit is SOURCE_ERROR's
 * lie in a smaller font — /api/status ends up reporting a time we last spoke to
 * CoinGecko that is really the time a browser last polled us. It is bounded by
 * the TTL (90s on alt-scan, 300s on alt-coin) rather than unbounded like the
 * stale case, which is the only reason it was a footnote and not a blocker.
 * Skipping the write leaves the previous record standing, and the previous
 * record is the truth: the last time this source was actually reached.
 *
 * A Symbol for the same reason SOURCE_ERROR is one — `JSON.stringify` drops it,
 * so no response shape changes and no client has to know.
 */
export const SOURCE_CACHED = Symbol.for('pentagon.sourceCached')

/**
 * Wrap a source handler: times it, records status, and converts failures
 * into a structured 502 (so the client shows DOWN, never a fake number).
 */
export function sourceHandler(name, fn) {
  return async (req, context) => {
    // Not `checkAuth`: an upstream this handler could not authenticate is a
    // different fact from a token it refused, and collapsing them meant a
    // Supabase hiccup told the operator their login had expired. See
    // authVerdict. Nothing is recorded against `name` on either path — the
    // source was never asked, so it is neither up nor down.
    const verdict = await authVerdict(req)
    if (!verdict.ok) return authRefusal(verdict)
    const started = Date.now()
    try {
      const data = await fn(req, context)
      const latencyMs = Date.now() - started
      // A degraded serve records the source as DOWN even though the request
      // succeeded, because these two facts are about different things: the
      // client got a usable (labelled-stale) payload, and the upstream did not
      // answer. `detail` is deliberately dropped on that path — it names the
      // sources the CACHED payload came from, and stamping it on a failed
      // fetch is the same lie in a smaller font.
      const degradedError = data?.[SOURCE_ERROR] ?? null
      if (degradedError) await recordStatus(name, { ok: false, latencyMs, error: degradedError, detail: null })
      // A fresh cache hit reached no upstream, so it is evidence of nothing and
      // overwrites a real record with a fake one. See SOURCE_CACHED.
      else if (!data?.[SOURCE_CACHED]) await recordStatus(name, { ok: true, latencyMs, detail: data?.sourceDetail ?? null })
      return json({ ...data, meta: { source: name, fetchedAt: Date.now(), latencyMs } })
    } catch (err) {
      const latencyMs = Date.now() - started
      await recordStatus(name, { ok: false, latencyMs, error: err?.message || err })
      return json({ error: String(err?.message || err), meta: { source: name, fetchedAt: Date.now(), latencyMs, failed: true } }, 502)
    }
  }
}

// ---------------- Telegram alerts (optional) ----------------
// Fire-and-forget descriptive alerts. Silently disabled unless both env
// vars are set. Never throws into the caller's path.
export function telegramConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
}

export async function sendTelegram(text) {
  if (!telegramConfigured()) return { sent: false, reason: 'not configured' }
  try {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      },
      8000
    )
    if (!res.ok) return { sent: false, reason: `HTTP ${res.status}` }
    return { sent: true }
  } catch (e) {
    return { sent: false, reason: String(e?.message || e) }
  }
}
