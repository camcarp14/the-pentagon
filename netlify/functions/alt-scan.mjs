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
import { sourceHandler, store } from '../shared/util.mjs'
import { altUniverse, altGlobal, fearGreed, trendingCoins, cacheGet, cachePut, cacheEnvelope, isDominanceRow } from '../shared/alts.mjs'

const CACHE_KEY = 'alt_scan_cache'
const DOM_HISTORY_KEY = 'alt_dom_history'
const TTL_SEC = 90

export default sourceHandler('alt_scan', async () => {
  const s = store()
  const cached = await cacheGet(s, CACHE_KEY)
  if (cached && cached.ageSec < TTL_SEC) return cacheEnvelope(cached, { ttlSec: TTL_SEC })

  try {
    const payload = await scan(s)
    await cachePut(s, CACHE_KEY, payload, payload.asOf)
    return { ...payload, cached: false, stale: false, cacheAgeSec: 0 }
  } catch (err) {
    if (!cached) throw err
    return cacheEnvelope(cached, { ttlSec: TTL_SEC, refetchError: String(err?.message || err) })
  }
})

/**
 * EXACTLY FOUR UPSTREAM CALLS, and this count is a contract, not an accident.
 * Three of them are CoinGecko, which is the constrained quota, and every call
 * here is multiplied by every polling client that misses the cache. If a new
 * number is wanted on this screen it belongs in alt-coin (per-coin, cached for
 * 5 minutes) or in the sentinel — not in a fifth call here. The Blobs read at
 * the bottom is local storage, not an upstream, and does not count.
 */
async function scan(s) {
  const [uni, glob, fng, trend] = await Promise.allSettled([
    altUniverse(),
    altGlobal(),
    fearGreed(),
    trendingCoins(),
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
