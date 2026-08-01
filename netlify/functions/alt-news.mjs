// /api/alt-news — the headlines, and which coins they name.
//
// WHAT THIS ENDPOINT CLAIMS, IN FULL: two publishers wrote these stories, and
// these coins' names or tickers appear in these headlines. That is the entire
// claim. It does not say the news is good, bad, priced in, or worth acting on,
// because it measured none of those and has no input that could. Every match
// carries `why`, which quotes the literal text that matched, so the operator can
// audit any row in one glance — and every coin the matcher REFUSED to look for
// comes back in `skipped` with the reason, so a coin with no headlines never has
// to be read as "nobody wrote about it" when the truth is "we could not match it
// safely". See netlify/shared/news.mjs for the matching rules and their costs.
//
// TWO UPSTREAM CALLS AND ZERO COINGECKO CALLS. The coin list is read out of
// alt-scan's own Blobs cache plus the watchlist blob — local storage, not an
// upstream — for the reason alts.mjs opens with: the keyless CoinGecko tier is
// 10-30 calls/min and alt-scan pins itself at four calls precisely because each
// one is multiplied by every polling client. This panel spends none of it.
//
// The consequence is stated on the wire rather than hidden: if the Alts board
// has not been loaded (cold cache) and the watchlist is empty, there is nothing
// to match against, `coinsConsidered` is 0 and `degraded` says so in a sentence.
// It is never an empty `matches` presented as a quiet news day.
import { sourceHandler, store, SOURCE_ERROR, SOURCE_CACHED } from '../shared/util.mjs'
import { cacheGet, cachePut, cacheEnvelope, cacheIsFresh, requestDeadline } from '../shared/alts.mjs'
import {
  fetchAltNews, matchHeadlines, mergeCoinSources, coinsFromScanCache, coinsFromWatchlist, NEWS_TTL_SEC,
} from '../shared/news.mjs'

const CACHE_KEY = 'alt_news_cache'
// alt-scan writes this one; we only ever read it. See coinsFromScanCache.
const SCAN_CACHE_KEY = 'alt_scan_cache'
const WATCHLIST_KEY = 'alt_watchlist'

export const TTL_SEC = NEWS_TTL_SEC
// How many coins the matcher is allowed to consider. 250 board rows + up to 60
// starred coins, with headroom. See mergeCoinSources for why there is a cap.
const MAX_COINS = 320

/**
 * TWO FEEDS IN PARALLEL, LONGEST HOP 4s. Same reasoning as alt-scan's CHAIN_MS
 * and deliberately not alt-coin's: this chain is not serial, so it does not need
 * a wall built for eleven seconds of sequential hops. `requestDeadline` still
 * takes whichever of the two clocks is tighter, so a slow auth round-trip binds
 * the invocation without coming out of the publishers' budget.
 */
const CHAIN_MS = 5000

export default async (req, context) => {
  // Arrival, not fetch start: the wall half of the budget has to cover the auth
  // hop and the Blobs reads, because the platform kill does.
  const arrivedAt = Date.now()
  return sourceHandler('alt_news', () => served(arrivedAt))(req, context)
}

async function served(arrivedAt) {
  const s = store()

  // ── the half that has a quota: the feeds ────────────────────────────────
  const cached = await cacheGet(s, CACHE_KEY)
  let feed
  let fromCacheOnly = false
  let refetchError = null

  if (cacheIsFresh(cached, TTL_SEC)) {
    feed = cacheEnvelope(cached, { ttlSec: TTL_SEC })
    fromCacheOnly = true
  } else {
    try {
      const fresh = await readFeeds(arrivedAt)
      await cachePut(s, CACHE_KEY, fresh, fresh.asOf)
      feed = { ...fresh, cached: false, stale: false, cacheAgeSec: 0 }
    } catch (err) {
      // No cache to fall back on: let it 502 with the reason. An empty headline
      // list rendered as a success is a lie about a quiet news day.
      if (!cached) throw err
      refetchError = String(err?.message || err)
      feed = cacheEnvelope(cached, { ttlSec: TTL_SEC, refetchError })
    }
  }

  // ── the half that has none: the coin list, and the matching ─────────────
  //
  // Matching is re-run on EVERY request even when the feed came from cache.
  // It is a pure function over data already in hand, it costs microseconds, and
  // caching it would mean a coin starred thirty seconds ago showed no headlines
  // for the rest of the TTL — a stale answer with no upstream reason to be
  // stale. Only the thing with a quota is cached.
  const list = await coinList(s)
  const matched = matchHeadlines(feed.items || [], list.coins)

  const degraded = [...(Array.isArray(feed.degraded) ? feed.degraded : []), ...list.degraded]

  const payload = {
    items: Array.isArray(feed.items) ? feed.items : [],
    matches: matched.matches,
    coins: matched.coins,
    skipped: matched.skipped,
    coinsConsidered: list.coins.length,
    coinSource: list.coinSource,
    degraded,
    sourceDetail: feed.sourceDetail ?? null,
    asOf: Number.isFinite(feed.asOf) ? feed.asOf : null,
    ttlSec: TTL_SEC,
    cached: feed.cached === true,
    stale: feed.stale === true,
    cacheAgeSec: Number.isFinite(feed.cacheAgeSec) ? feed.cacheAgeSec : 0,
  }

  // SOURCE_CACHED: zero upstream calls happened, so nothing is recorded against
  // alt_news's health — stamping `lastSuccessAt: now` off a cache hit reports
  // the time a browser polled us as the time we last reached CoinDesk.
  if (fromCacheOnly) return { ...payload, [SOURCE_CACHED]: true }
  // SOURCE_ERROR: serving stale is a success for the SCREEN and a failure for
  // the SOURCE, and /api/status is about the source. See util.mjs.
  if (refetchError) return { ...payload, [SOURCE_ERROR]: refetchError }
  return payload
}

async function readFeeds(arrivedAt) {
  // Computed HERE, at the top of the fetch phase — auth and the cache read are
  // already behind us, so the chain clock starts where the chain does.
  const deadlineAt = requestDeadline({ arrivedAt, chainMs: CHAIN_MS })
  const out = await fetchAltNews({ deadlineAt })
  return {
    ...out,
    // The timestamp of the UPSTREAM fetch, carried INSIDE the payload so it
    // survives caching. sourceHandler stamps meta.fetchedAt with the time of
    // THIS response, which on a cache hit is now — trusting that field would
    // make a 40-minute-old headline list read as live. Freshness is computed
    // from `asOf`. Same rule as alt-scan.
    asOf: Date.now(),
  }
}

/**
 * The coins to match against: the operator's starred list first, then whatever
 * board alt-scan last cached. Both are Blobs reads, so this costs no upstream
 * quota at all.
 *
 * EVERY ABSENCE IS NAMED. A missing board is not "0 coins" quietly; it is a
 * sentence in `degraded` saying the board has not been loaded, so an empty
 * `matches` can never be mistaken for "no coin was in the news".
 */
async function coinList(s) {
  const degraded = []
  const parts = []

  // Both reads are best-effort: a Blobs hiccup costs coverage of the coin list
  // and must never fail a request whose headlines are already in hand.
  // cacheGet is already total; the watchlist read is wrapped to match it.
  const [scan, saved] = await Promise.all([
    cacheGet(s, SCAN_CACHE_KEY),
    (async () => { try { return await s.get(WATCHLIST_KEY, { type: 'json' }) } catch { return null } })(),
  ])

  const watchlist = coinsFromWatchlist(saved)
  if (watchlist.length) parts.push(`watchlist (${watchlist.length} starred)`)

  const universe = coinsFromScanCache(scan?.payload)
  if (universe.length) {
    parts.push(`the Alts board alt-scan cached ${Math.round(scan.ageSec)}s ago (${universe.length} coins)`)
  } else {
    degraded.push(
      'no board to match against — alt-scan has not cached a coin universe yet, so only starred coins were checked against the headlines',
    )
  }

  const coins = mergeCoinSources(watchlist, universe, MAX_COINS)
  if (!coins.length) {
    degraded.push(
      'no coin list at all — the Alts board has not been loaded and nothing is starred, so no headline could be matched to a coin. The headlines below are unmatched, not unmentioned.',
    )
  }
  return { coins, degraded, coinSource: parts.length ? parts.join(' + ') : 'nothing available' }
}
