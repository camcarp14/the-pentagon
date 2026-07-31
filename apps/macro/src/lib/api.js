// API plumbing — fetch against the Netlify functions, authorized by the shared
// Pentagon Supabase session. Root.jsx mirrors the shell's access token into
// `torque_token`; we send it as a bearer and the functions verify it (see
// netlify/shared/util.mjs checkAuth).
//
// EVERY REQUEST IS BOUNDED. `fetch` has no timeout of its own: a socket that
// opens and then stalls hangs the promise until the browser gives up, which on
// a flaky mobile connection is minutes. Nothing in this app polls fast enough
// to notice, but anything that disables a control while a write is in flight
// inherits that unbounded wait as a dead UI — which is exactly what the
// watchlist star did. So the timeout lives HERE, once, rather than at each of
// the eleven call sites, and it fails with a named error a toast can print
// instead of a silent hang.
//
// 15s is chosen against the platform, not against a feeling: Netlify's
// synchronous function limit is 10s and `alt-scan` / `alt-coin` budget
// themselves to ~7.5s inside it, so a request still running at 15s is not slow,
// it is gone. `timeoutMs: 0` disables the bound for a caller that genuinely
// wants to wait forever; no caller does today.
//
// An `AbortSignal` passed in by a caller still works — it is chained to the
// internal controller rather than replaced, so a component that aborts on
// unmount and the timeout can both fire. `AbortSignal.any` would say this in
// one line and is too new to rely on here.

export const API_TIMEOUT_MS = 15_000

export function getToken() { return sessionStorage.getItem('torque_token') || '' }

export async function api(path, opts = {}) {
  const { timeoutMs = API_TIMEOUT_MS, signal: outer, ...init } = opts
  const headers = { ...(init.headers || {}) }
  const tok = getToken()
  if (tok) headers['authorization'] = `Bearer ${tok}`
  if (init.body) headers['content-type'] = 'application/json'

  const ctrl = new AbortController()
  const relay = () => ctrl.abort(outer?.reason)
  if (outer) {
    if (outer.aborted) ctrl.abort(outer.reason)
    else outer.addEventListener('abort', relay, { once: true })
  }
  let timedOut = false
  // The timer is cleared AFTER the body is read, not after the headers land: a
  // response whose stream stalls mid-body is the same hang wearing a 200.
  const timer = timeoutMs > 0
    ? setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
    : null

  let res, body
  try {
    res = await fetch(`/api/${path}`, { ...init, headers, signal: ctrl.signal })
    body = await res.json().catch(() => ({}))
  } catch (e) {
    if (timedOut) {
      const err = new Error(`no answer in ${Math.round(timeoutMs / 1000)}s — the request was given up on`)
      err.code = 'timeout'
      throw err
    }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
    outer?.removeEventListener?.('abort', relay)
  }

  if (res.status === 401) { const e = new Error('unauthorized'); e.code = 401; throw e }
  if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.body = body; throw e }
  return body
}
