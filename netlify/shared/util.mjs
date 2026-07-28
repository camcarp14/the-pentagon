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

// A valid session proves the caller signed in somewhere on this project; it does
// not prove they are the operator. These handlers read and REWRITE the trade
// journal, the position and the risk settings, so the same ALLOWED_EMAIL pin
// that netlify/functions/lib/auth.mjs applies is applied here. Enforced only
// when the variable is set, so an unconfigured deploy keeps working — see the
// matching note in netlify/functions/_shared/requireAuth.cjs.
export async function checkAuth(req) {
  const header = req.headers.get('authorization') || req.headers.get('Authorization') || ''
  const token = header.replace(/^Bearer\s+/i, '').trim()
  if (!token) return false
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    })
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
      await recordStatus(name, { ok: true, latencyMs, detail: data?.sourceDetail ?? null })
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
