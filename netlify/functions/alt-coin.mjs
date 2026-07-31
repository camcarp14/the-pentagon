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
// still alive to reach it. See DEADLINE_MS.
import { sourceHandler, json, checkAuth, unauthorized, store, SOURCE_ERROR } from '../shared/util.mjs'
import { altCandles, altCoinMeta, altDerivs, cacheGet, cachePut, cacheEnvelope, cacheIsFresh } from '../shared/alts.mjs'

// The same patterns the watchlist validates against. `id` is a CoinGecko slug
// and `symbol` a ticker; both are interpolated into upstream URLs and into a
// Blobs key, so nothing outside these character sets ever gets that far.
const ID_RE = /^[a-z0-9-]{1,64}$/i
const SYMBOL_RE = /^[a-zA-Z0-9]{1,20}$/
const TTL_SEC = 300

// Everything upstream must be FINISHED by this many ms after the request
// arrived. Netlify kills a synchronous function at ~10s and a kill runs no
// catch block, so an 11-second worst case (see altCandles) does not degrade to
// the stale cache below — it degrades to the bare platform 502 the contract
// says must never happen. Measured from arrival, because the auth round-trip
// and two Blobs hops come out of the same ten seconds.
const DEADLINE_MS = 7500

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

async function served(id, symbol, deadlineAt) {
  const s = store()
  const cacheKey = coinCacheKey(id, symbol)

  const cached = await cacheGet(s, cacheKey)
  if (cacheIsFresh(cached, TTL_SEC)) return cacheEnvelope(cached, { ttlSec: TTL_SEC })

  try {
    const payload = await readCoin(id, symbol, deadlineAt)
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

  let derivs = null
  if (derivsRes.status === 'fulfilled') {
    derivs = derivsRes.value
    // null here is the normal answer, not a failure: no listed perpetual. It is
    // still worth stating, because the crowding read goes dark without one and
    // the UI has to say why rather than showing a neutral 50.
    //
    // This sentence is a positive claim about the coin, so altDerivs only
    // returns null when Binance's futures API actually SAID the symbol is not
    // listed (HTTP 400 / -1121). A 429, a geo-block or a timeout arrives on the
    // rejected branch below and prints as what it is.
    if (!derivs) degraded.push(`${symbol} has no listed Binance perpetual — funding, open interest and positioning are unavailable`)
    else degraded.push(...(derivs.degraded || []).map((d) => `derivatives ${d}`))
  } else {
    degraded.push(`derivatives: ${reason(derivsRes)}`)
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
  const deadlineAt = Date.now() + DEADLINE_MS
  // checkAuth memoises its verdict per Request, so sourceHandler's own check
  // below reuses this one — auth-before-validation costs one Supabase hop, not
  // two out of a ten-second budget.
  if (!(await checkAuth(req))) return unauthorized()
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
  return sourceHandler('alt_coin', () => served(id, symbol, deadlineAt))(req, context)
}
