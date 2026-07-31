// The deep read for one coin: daily candles, categories/community, and perp
// derivatives if the coin has a futures market at all.
//
// Params are validated BEFORE the sourceHandler wrapper, exactly as candles.mjs
// does it, so a typo'd id comes back as a 400 that names the problem instead of
// a 502 that says the upstream is down. A source-health record is written for
// every trip through sourceHandler, and recording "alt_coin is failing" because
// a client sent `id=Bitcoin!` would be a lie told to /api/status.
//
// Cached per id AND symbol for 5 minutes with the same labelled stale fallback
// alt-scan uses: this endpoint fires on every row tap, and a user comparing four
// coins would otherwise spend eight CoinGecko calls in ten seconds. Both halves
// of that key are load-bearing — see coinCacheKey.
//
// Everything here runs against one deadline rather than a stack of per-attempt
// timeouts, because the stale fallback is only a fallback if the function is
// still alive to reach it. See CHAIN_MS — and note that the deadline is derived
// from THIS endpoint's chain, not shared with alt-scan, whose chain is a
// different shape entirely.
import { sourceHandler, json, authVerdict, authRefusal, store, SOURCE_ERROR, SOURCE_CACHED } from '../shared/util.mjs'
import { altCandles, altCoinMeta, altDerivs, cacheGet, cachePut, cacheEnvelope, cacheIsFresh, requestDeadline } from '../shared/alts.mjs'

// The same patterns the watchlist validates against. `id` is a CoinGecko slug
// and `symbol` a ticker; both are interpolated into upstream URLs and into a
// Blobs key, so nothing outside these character sets ever gets that far.
const ID_RE = /^[a-z0-9-]{1,64}$/i
const SYMBOL_RE = /^[a-zA-Z0-9]{1,20}$/
const TTL_SEC = 300

/**
 * THIS ENDPOINT'S CHAIN IS SERIAL AND LONGER THAN THE FUNCTION'S LIFE: Binance
 * plain 3s → Binance 1000× 3s → CoinGecko market_chart 5s is 11 seconds (see
 * altCandles), against a ~10s platform kill that runs no catch block — so the
 * stale-cache fallback below would never execute in exactly the situation it
 * exists for, and the client would get the bare platform 502 the contract says
 * must not happen.
 *
 * So on this endpoint the WALL is what binds, always, and `requestDeadline`
 * says so in one line instead of leaving it implicit in a single constant that
 * alt-scan then inherited and was wrong for. Measured from arrival, because the
 * auth round-trip and two Blobs hops come out of the same ten seconds.
 */
const CHAIN_MS = 11_000

/**
 * The cache key is every input the payload depends on, not just the one in the
 * Blobs path.
 *
 * Keyed on `id` alone, `?id=pepe&symbol=XX` failed both Binance candidates,
 * fell through to CoinGecko's close-only market_chart, and wrote THAT into
 * `alt_coin_pepe` — where the legitimate `?id=pepe&symbol=PEPE` read it for the
 * next 300 seconds. `close-only` is exactly what precedentRead refuses on, so
 * one malformed request silently stripped precedent, ATR and the swing levels
 * off a real coin with nothing on screen able to say why. Two symbols are two
 * different answers and get two different keys.
 *
 * Both halves are lowercased and both are validated against the patterns above
 * before they arrive here, so the key charset stays `[a-z0-9-_]`.
 */
export function coinCacheKey(id, symbol) {
  return `alt_coin_${String(id).toLowerCase()}_${String(symbol).toLowerCase()}`
}

/**
 * The pre-symbol key this coin's payload used to live under. Keyed on `id`
 * alone, those blobs are now unreadable by anything and unlisted by anything,
 * so they are storage nobody pays attention to and nobody can clear. Deleted
 * on the one pass that can identify them for free: a request for a coin with no
 * entry under the NEW key at all, which happens once per coin per cache
 * lifetime and never again. Best-effort — a failed delete costs a dead blob,
 * and no request may fail over housekeeping.
 */
async function purgeLegacyCoinCache(s, id) {
  try {
    await s.delete?.(`alt_coin_${String(id).toLowerCase()}`)
  } catch {
    /* dead storage is not worth a 502 */
  }
}

async function served(id, symbol, arrivedAt) {
  const s = store()
  const cacheKey = coinCacheKey(id, symbol)

  const cached = await cacheGet(s, cacheKey)
  // Zero upstream calls on this path, so alt_coin's health record is left
  // exactly where the last real fetch left it. See SOURCE_CACHED in util.mjs.
  if (cacheIsFresh(cached, TTL_SEC)) return { ...cacheEnvelope(cached, { ttlSec: TTL_SEC }), [SOURCE_CACHED]: true }
  if (!cached) await purgeLegacyCoinCache(s, id)

  try {
    const payload = await readCoin(id, symbol, requestDeadline({ arrivedAt, chainMs: CHAIN_MS }))
    await cachePut(s, cacheKey, payload, payload.asOf)
    return { ...payload, cached: false, stale: false, cacheAgeSec: 0 }
  } catch (err) {
    if (!cached) throw err
    const refetchError = String(err?.message || err)
    // Serving stale keeps the screen honest and leaves the SOURCE down. See the
    // matching note in alt-scan.mjs and SOURCE_ERROR in util.mjs — without it
    // /api/status reports alt_coin green off a payload nobody could refetch.
    return { ...cacheEnvelope(cached, { ttlSec: TTL_SEC, refetchError }), [SOURCE_ERROR]: refetchError }
  }
}

async function readCoin(id, symbol, deadlineAt) {
  const [candlesRes, metaRes, derivsRes] = await Promise.allSettled([
    altCandles(symbol, id, { deadlineAt }),
    altCoinMeta(id, { deadlineAt }),
    altDerivs(symbol, { deadlineAt }),
  ])

  // Candles are the hard requirement: precedent, the level stack and every
  // structure read are computed off them, and a detail view without them is a
  // page of dashes. Categories and derivatives are enrichment — the coin's
  // classification falls back to the static symbol map, and most of the board
  // has no listed perp in the first place.
  if (candlesRes.status !== 'fulfilled') throw new Error(`alt candles: ${reason(candlesRes)}`)
  const c = candlesRes.value

  const degraded = []
  if (c.quality === 'close-only') {
    degraded.push('candles are close-only (CoinGecko market_chart) — ATR, bandwidth and swing structure are not measurable on flat bars')
  }

  let coin = null
  if (metaRes.status === 'fulfilled') coin = stripSource(metaRes.value)
  else degraded.push(`coin metadata: ${reason(metaRes)}`)

  // DERIVS HAS THREE ANSWERS AND THE PAYLOAD CARRIES ALL THREE.
  //
  // altDerivs already distinguishes "Binance said this symbol is not listed"
  // (returns null) from "Binance did not answer" (throws) — but this function
  // collapsed both back into `derivs: null`, and `crowdRead` reads only that
  // field. So a 451 geo-block, which is the EXPECTED response from a datacenter
  // IP (see status.mjs's probe list), rendered the crowd card's positive claim
  // that the coin has no futures market, verbatim and indistinguishably from
  // the case where that is true. The reason lived in `degraded`, which is not
  // the sentence a reader believes.
  //
  //   derivsStatus: 'ok'          derivs is an object; funding/OI/positioning present.
  //   derivsStatus: 'not_listed'  derivs is null AND that is a measurement. The
  //                               only status that licenses "this coin has no
  //                               listed perpetual". derivsUnavailable is null.
  //   derivsStatus: 'unavailable' derivs is null and NOTHING is known. Say the
  //                               read failed, never that the market is absent.
  //                               derivsUnavailable carries the reason, already
  //                               prefixed with its source.
  //
  // `derivs` keeps its old shape so nothing that reads it breaks; the status is
  // what a consumer must branch on before it writes a sentence about the coin.
  let derivs = null
  let derivsStatus = 'unavailable'
  let derivsUnavailable = null
  if (derivsRes.status === 'fulfilled') {
    derivs = derivsRes.value
    if (derivs) {
      derivsStatus = 'ok'
      degraded.push(...(derivs.degraded || []).map((d) => `derivatives ${d}`))
    } else {
      derivsStatus = 'not_listed'
      degraded.push(`${symbol} has no listed Binance perpetual — funding, open interest and positioning are unavailable`)
    }
  } else {
    derivsStatus = 'unavailable'
    derivsUnavailable = reason(derivsRes)
    degraded.push(`derivatives: ${derivsUnavailable}`)
  }

  const sources = [c.sourceDetail]
  if (coin) sources.push('coingecko meta')
  if (derivs) sources.push(derivs.sourceDetail)

  return {
    id,
    symbol,
    candles: c.candles,
    candleQuality: c.quality,
    candleSource: c.sourceDetail,
    binanceSymbol: c.binanceSymbol,
    // Carried out to the client so a level printed on screen can be traced back
    // to the units it was computed in. It is already applied to `candles` here;
    // nothing downstream should divide a second time.
    priceMultiplier: c.priceMultiplier,
    coin,
    derivs,
    derivsStatus,
    derivsUnavailable,
    degraded,
    sourceDetail: sources.join(' + '),
    // See the long note in alt-scan.mjs: meta.fetchedAt is when this RESPONSE
    // was built, which on a cache hit is now. `asOf` is when the data was.
    asOf: Date.now(),
  }
}

function stripSource({ sourceDetail, ...rest }) {
  return rest
}

function reason(res) {
  return String(res.reason?.message || res.reason || 'unknown error')
}

export default async (req, context) => {
  // The budget clock starts on arrival, before the auth hop it has to pay for.
  const arrivedAt = Date.now()
  // authVerdict memoises a DEFINITIVE verdict per Request, so sourceHandler's
  // own check below reuses this one — auth-before-validation costs one Supabase
  // hop, not two out of a ten-second budget. A verdict we could not reach is
  // deliberately not memoised (see util.mjs), and it comes back as a 503 naming
  // the outage rather than a 401 telling the operator their login is bad.
  const verdict = await authVerdict(req)
  if (!verdict.ok) return authRefusal(verdict)
  const url = new URL(req.url)
  const raw = url.searchParams.get('id') || ''
  const rawSymbol = url.searchParams.get('symbol') || ''
  // Echo a bounded slice: the message exists to tell a developer which value
  // was rejected, not to mirror an arbitrary-length query string back out.
  if (!ID_RE.test(raw)) return json({ error: `bad or missing id: ${JSON.stringify(raw.slice(0, 40))}` }, 400)
  if (!SYMBOL_RE.test(rawSymbol)) return json({ error: `bad or missing symbol: ${JSON.stringify(rawSymbol.slice(0, 40))}` }, 400)

  // CANONICALISED AT THE BOUNDARY, both halves, for the same reason `symbol` was
  // already uppercased here: one spelling of a coin must mean one cache entry.
  // `?id=PEPE` passed the case-insensitive pattern, was lowercased into the
  // Blobs key and left uppercase in the CoinGecko URL — which 404s a non-slug —
  // so that request could READ `alt_coin_pepe` and serve it back labelled stale
  // while being structurally unable to ever populate it.
  const id = raw.toLowerCase()
  const symbol = rawSymbol.toUpperCase()
  return sourceHandler('alt_coin', () => served(id, symbol, arrivedAt))(req, context)
}
