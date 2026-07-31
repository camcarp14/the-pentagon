// The starred-coin list. Small, but it is the only alt state the user owns, and
// the scheduled sentinel reads it to decide what to watch overnight — so it
// gets the same treatment settings.mjs gets: auth first, validate everything a
// client can write, reject unknown keys loudly, then read-modify-write.
import { json, checkAuth, unauthorized, store } from '../shared/util.mjs'

const KEY = 'alt_watchlist'

// 60 is the sentinel's budget, not a UI preference. alt-watch screens the whole
// list inside one 30-second scheduled pass; an unbounded list would silently
// start timing out the pass, and a sentinel that stops reporting looks exactly
// like a market with nothing happening in it.
const MAX_ENTRIES = 60

// The same patterns alt-coin.mjs validates its query params against. Both
// values end up interpolated into upstream URLs and Blobs keys.
const ID_RE = /^[a-z0-9-]{1,64}$/i
const SYMBOL_RE = /^[a-zA-Z0-9]{1,20}$/
const NAME_MAX = 100
const NOTE_MAX = 200
const ENTRY_KEYS = ['id', 'symbol', 'name', 'addedAt', 'note']

// The report is bounded even though the list is. MAX_ENTRIES caps how many
// entries a body may carry, not how many KEYS each one carries: 60 legal-looking
// entries of ten thousand junk keys each is a 6MB body that builds 600,000 error
// strings before the 400 goes out, which is the request turning itself into a
// memory spike. The first 20 problems are what a client needs to fix its
// payload; past that it is the same mistake repeated, so the count is reported
// instead of the strings.
const MAX_ERRORS = 20

/**
 * Pure validator for a client-supplied watchlist. Same rules as validate.mjs:
 * no coercion, collect every problem in one pass, and reject unknown keys — a
 * client that spreads a whole AltRow into an entry should be told which field
 * was refused, not have 20 stale price fields quietly persisted next to the
 * three that matter.
 *
 * `addedAt` is deliberately NOT defaulted here: the validator is pure, and the
 * handler stamps the server clock. "When did I star this" is a fact about our
 * clock, and letting a client supply it lets a resend rewrite the sort order.
 */
export function validateWatchlist(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return err(['watchlist body must be an object with an ids array'])
  if (!Array.isArray(body.ids)) return err(['ids must be an array'])
  if (body.ids.length > MAX_ENTRIES) return err([`watchlist is capped at ${MAX_ENTRIES} coins — got ${body.ids.length}`])

  const problems = errorSink()
  const value = []
  const seen = new Set()

  body.ids.forEach((raw, i) => {
    const at = `entry ${i}`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.add(`${at} must be an object`); return }
    for (const k of Object.keys(raw)) {
      if (!ENTRY_KEYS.includes(k)) problems.add(`${at}: unknown key "${k}"`)
    }
    const { id, symbol, name = '', addedAt = null, note = '' } = raw

    let ok = true
    if (typeof id !== 'string' || !ID_RE.test(id)) { problems.add(`${at}: id must be 1-64 chars of a-z, 0-9 or "-"`); ok = false }
    if (typeof symbol !== 'string' || !SYMBOL_RE.test(symbol)) { problems.add(`${at}: symbol must be 1-20 alphanumeric chars`); ok = false }
    if (typeof name !== 'string' || name.length > NAME_MAX) { problems.add(`${at}: name must be a string ≤ ${NAME_MAX} chars`); ok = false }
    if (typeof note !== 'string' || note.length > NOTE_MAX) { problems.add(`${at}: note must be a string ≤ ${NOTE_MAX} chars`); ok = false }
    if (addedAt != null && !Number.isFinite(addedAt)) { problems.add(`${at}: addedAt must be an epoch-ms number or absent`); ok = false }

    // Lowercased for the same reason alt-coin.mjs canonicalises its query param:
    // a CoinGecko id is a lowercase slug, ID_RE is case-insensitive, and an
    // entry stored as "PEPE" would match nothing in the screened universe — the
    // sentinel would count that coin as off-board every pass and the star would
    // silently watch nothing. Canonicalise before the duplicate check so two
    // spellings of one coin are caught as the duplicate they are.
    const canonicalId = ok ? id.toLowerCase() : id

    // Loudly, not silently. A duplicate star is a UI bug — an optimistic toggle
    // that fired twice — and deduping it here would hide the bug while the row
    // rendered once and the sentinel screened the coin twice.
    if (ok) {
      if (seen.has(canonicalId)) { problems.add(`${at}: duplicate id "${canonicalId}"`); return }
      seen.add(canonicalId)
      value.push({ id: canonicalId, symbol: symbol.toUpperCase(), name, addedAt, note })
    }
  })

  const errors = problems.drain()
  return errors.length ? err(errors) : { ok: true, value }
}

/** Collects up to MAX_ERRORS problems and COUNTS the rest, so a pathological
 *  body costs a counter rather than an array proportional to its own size. */
function errorSink() {
  const kept = []
  let total = 0
  return {
    add(message) {
      total++
      if (kept.length < MAX_ERRORS) kept.push(message)
    },
    drain() {
      if (total <= kept.length) return kept
      return [...kept, `…and ${total - kept.length} more problems — fix these first`]
    },
  }
}

function err(errors) { return { ok: false, errors } }

export default async (req) => {
  if (!(await checkAuth(req))) return unauthorized()
  const s = store()

  if (req.method === 'GET') {
    const saved = await s.get(KEY, { type: 'json' })
    return json({ watchlist: normalize(saved) })
  }

  if (req.method === 'PUT') {
    const body = await req.json().catch(() => null)
    const v = validateWatchlist(body)
    if (!v.ok) return json({ error: 'validation failed', errors: v.errors }, 400)

    // Read-modify-write on addedAt only. The client sends the list it wants to
    // exist; it does not get to restate WHEN each coin was starred, because the
    // star toggle re-sends the whole array and an omitted addedAt would reset
    // every date on every toggle — the "added 3 weeks ago" column would read
    // "just now" forever, and the oldest ideas would sort like the newest.
    const prev = normalize(await s.get(KEY, { type: 'json' }))
    const wasAdded = new Map(prev.ids.map((e) => [e.id, e.addedAt]))
    const now = Date.now()
    const ids = v.value.map((e) => ({ ...e, addedAt: wasAdded.get(e.id) ?? e.addedAt ?? now }))

    const watchlist = { ids, updatedAt: now }
    await s.setJSON(KEY, watchlist)
    return json({ watchlist })
  }

  return json({ error: 'method not allowed' }, 405)
}

/** An unset key, a hand-edited blob and a real watchlist all answer the same
 *  shape, so the UI never branches on "has this ever been written". */
function normalize(saved) {
  const ids = Array.isArray(saved?.ids) ? saved.ids.filter((e) => e && typeof e.id === 'string') : []
  return { ids, updatedAt: Number.isFinite(saved?.updatedAt) ? saved.updatedAt : null }
}
