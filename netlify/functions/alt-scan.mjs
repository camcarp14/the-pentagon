// The whole-market alt pass: the ranked universe, the dominance read, fear &
// greed, and what the crowd is looking at. One request, four upstream calls,
// and a 90-second Blobs cache in front of all of it.
//
// The cache is not a performance nicety. CoinGecko's keyless tier is ~10-30
// calls/min; the Alts tab polls this endpoint every 90s, and a second browser
// tab, a phone and the scheduled sentinel all draw from the same quota. Without
// the cache, opening the tab twice is enough to start collecting 429s, and a
// 429 on the universe call empties the board. With it, N clients cost one pass.
//
// The other half of that bargain is the stale fallback: when the cache has
// expired and the refetch then fails, the expired payload is served labelled
// `stale: true` rather than 502-ing. A 502 blanks the board; stale-and-labelled
// lets the freshness ladder age the numbers out on screen, which is the honest
// version of the same information.
import { sourceHandler, store, SOURCE_ERROR, SOURCE_CACHED } from '../shared/util.mjs'
import { altUniverse, altGlobal, fearGreed, trendingCoins, cacheGet, cachePut, cacheEnvelope, cacheIsFresh, isDominanceRow, requestDeadline } from '../shared/alts.mjs'

const CACHE_KEY = 'alt_scan_cache'
const DOM_HISTORY_KEY = 'alt_dom_history'
const TTL_SEC = 90

/**
 * THIS ENDPOINT'S CHAIN IS FOUR CALLS IN PARALLEL AND ITS LONGEST HOP IS 6s.
 * That is the whole chain — see `scan`, and altUniverse in alts.mjs for why the
 * >1MB markets payload gets 6000ms rather than the file's usual 3000ms.
 *
 * It used to carry alt-coin's 7500ms, measured from arrival, with the auth
 * round-trip and the Blobs read inside it — a budget written for a genuinely
 * serial 11-second chain, applied to an endpoint that never had one. What that
 * cost, reproduced against this handler with every upstream healthy: a 2.5s
 * Supabase hop plus a 5.5s CoinGecko response left the universe fetch ~4.4s,
 * aborted it, served a stale board saying "refetch failed: alt universe", and
 * recorded CoinGecko DOWN on /api/status. Cold cache, same inputs: a hard 502.
 * Wall was 7.5s against a ~10s kill either way, so the abort bought nothing.
 *
 * The wall still exists — `requestDeadline` takes whichever of the two clocks
 * is tighter — but it now binds only when the invocation is genuinely running
 * out of life, not because auth was slow. This is the endpoint the whole tab
 * polls; it does not get to inherit another endpoint's problem.
 */
const CHAIN_MS = 6000

export default async (req, context) => {
  // Arrival, not fetch start: the wall half of the budget has to cover the auth
  // hop and the Blobs read, because the platform kill does.
  const arrivedAt = Date.now()
  return sourceHandler('alt_scan', () => served(arrivedAt))(req, context)
}

async function served(arrivedAt) {
  const s = store()
  const cached = await cacheGet(s, CACHE_KEY)
  // SOURCE_CACHED: zero upstream calls happened, so nothing is recorded against
  // alt_scan's health. See util.mjs — stamping `lastSuccessAt: now` off a cache
  // hit reports the time a browser polled us as the time we last reached
  // CoinGecko.
  if (cacheIsFresh(cached, TTL_SEC)) return { ...cacheEnvelope(cached, { ttlSec: TTL_SEC }), [SOURCE_CACHED]: true }

  try {
    const payload = await scan(s, arrivedAt)
    await cachePut(s, CACHE_KEY, payload, payload.asOf)
    return { ...payload, cached: false, stale: false, cacheAgeSec: 0 }
  } catch (err) {
    if (!cached) throw err
    const refetchError = String(err?.message || err)
    // Serving stale is a success for the SCREEN and a failure for the SOURCE,
    // and /api/status is about the source. Without this marker the return
    // records `ok: true, lastSuccessAt: now` and the status page reports
    // alt_scan green — with a detail string copied off the cached payload —
    // while CoinGecko has been down for an hour. See SOURCE_ERROR in util.mjs.
    return { ...cacheEnvelope(cached, { ttlSec: TTL_SEC, refetchError }), [SOURCE_ERROR]: refetchError }
  }
}

/**
 * EXACTLY FOUR UPSTREAM CALLS, and this count is a contract, not an accident.
 * Three of them are CoinGecko, which is the constrained quota, and every call
 * here is multiplied by every polling client that misses the cache. If a new
 * number is wanted on this screen it belongs in alt-coin (per-coin, cached for
 * 5 minutes) or in the sentinel — not in a fifth call here. The Blobs read at
 * the bottom is local storage, not an upstream, and does not count.
 */
async function scan(s, arrivedAt) {
  // Computed HERE, at the top of the fetch phase — auth and the cache read are
  // already behind us, so the chain clock starts where the chain does.
  const deadlineAt = requestDeadline({ arrivedAt, chainMs: CHAIN_MS })
  const [uni, glob, fng, trend] = await Promise.allSettled([
    altUniverse(250, { deadlineAt }),
    altGlobal({ deadlineAt }),
    fearGreed({ deadlineAt }),
    trendingCoins({ deadlineAt }),
  ])

  // The universe is the one hard requirement: without market caps there is no
  // board, no ranking and no screen, and no second keyless source can supply
  // them (see altUniverse). A failed trending list, by contrast, costs one
  // attention input — allSettled is here so it cannot take the board with it.
  if (uni.status !== 'fulfilled') throw new Error(`alt universe: ${reason(uni)}`)

  const degraded = []
  const optional = (res, name) => {
    if (res.status === 'fulfilled') return res.value
    degraded.push(`${name}: ${reason(res)}`)
    return null
  }

  const global = optional(glob, 'global dominance')
  const fear = optional(fng, 'fear & greed')
  const trending = optional(trend, 'trending')

  const sources = ['coingecko']
  if (fear) sources.push('alternative.me')

  return {
    universe: uni.value.universe,
    global,
    fearGreed: fear,
    trending: trending?.trending ?? null,
    domHistory: await readDomHistory(s),
    degraded,
    sourceDetail: sources.join(' + '),
    // The timestamp of the UPSTREAM fetch, carried inside the payload so it
    // survives caching. sourceHandler stamps meta.fetchedAt with the time of
    // THIS response, which on a cache hit is now — trusting that field would
    // make an hour-old stale payload read as live and defeat the whole point of
    // labelling it. Freshness must be computed from `asOf`.
    asOf: Date.now(),
  }
}

/**
 * Dominance history, accumulated one row per calendar day by alt-watch.mjs.
 * Read from Blobs rather than fetched, because CoinGecko's free tier has no
 * history endpoint at all. Legitimately null until the cron has run — season.js
 * then reports an unknown trend instead of inferring one from a single sample.
 */
async function readDomHistory(s) {
  try {
    const rows = await s.get(DOM_HISTORY_KEY, { type: 'json' })
    if (!Array.isArray(rows)) return null
    const clean = rows.filter(isDominanceRow)
    return clean.length ? clean : null
  } catch {
    return null
  }
}

function reason(res) {
  return String(res.reason?.message || res.reason || 'unknown error')
}
