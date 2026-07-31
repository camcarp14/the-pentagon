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

// A valid session proves the caller signed in somewhere on this project; it does
// not prove they are the operator. These handlers read and REWRITE the trade
// journal, the position and the risk settings, so the same ALLOWED_EMAIL pin
// that netlify/functions/lib/auth.mjs applies is applied here. Enforced only
// when the variable is set, so an unconfigured deploy keeps working — see the
// matching note in netlify/functions/_shared/requireAuth.cjs.
export async function checkAuth(req) {
  if (!req || typeof req !== 'object') return false
  const memo = AUTH_VERDICT.get(req)
  if (memo) return memo
  const verdict = verifySession(req)
  AUTH_VERDICT.set(req, verdict)
  return verdict
}

async function verifySession(req) {
  const header = req.headers.get('authorization') || req.headers.get('Authorization') || ''
  const token = header.replace(/^Bearer\s+/i, '').trim()
  if (!token) return false
  try {
    // Timed out rather than left open-ended. This was a raw fetch with no
    // deadline at all, so a Supabase hang held the whole function until the
    // platform killed it at ~10s — and a platform kill runs no catch block, so
    // every "serve the stale cache instead of 502-ing" path downstream was
    // unreachable in exactly the situation it exists for. An aborted check
    // fails CLOSED (401), which is the safe direction for an auth decision.
    const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    }, 3000)
    if (!res.ok) return false
    const allowed = process.env.ALLOWED_EMAIL
    if (!allowed) return true
    const user = await res.json().catch(() => null)
    return String(user?.email || '').toLowerCase() === String(allowed).toLowerCase()
  } catch {
    return false
  }
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  })
}

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
 * Wrap a source handler: times it, records status, and converts failures
 * into a structured 502 (so the client shows DOWN, never a fake number).
 */
export function sourceHandler(name, fn) {
  return async (req, context) => {
    if (!(await checkAuth(req))) return unauthorized()
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
      await recordStatus(name, degradedError
        ? { ok: false, latencyMs, error: degradedError, detail: null }
        : { ok: true, latencyMs, detail: data?.sourceDetail ?? null })
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
