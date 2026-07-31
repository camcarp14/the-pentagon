// The deep read for one coin: daily candles, categories/community, and perp
// derivatives if the coin has a futures market at all.
//
// Params are validated BEFORE the sourceHandler wrapper, exactly as candles.mjs
// does it, so a typo'd id comes back as a 400 that names the problem instead of
// a 502 that says the upstream is down. A source-health record is written for
// every trip through sourceHandler, and recording "alt_coin is failing" because
// a client sent `id=Bitcoin!` would be a lie told to /api/status.
//
// Cached per-id for 5 minutes with the same labelled stale fallback alt-scan
// uses: this endpoint fires on every row tap, and a user comparing four coins
// would otherwise spend eight CoinGecko calls in ten seconds.
import { sourceHandler, json, checkAuth, unauthorized, store } from '../shared/util.mjs'
import { altCandles, altCoinMeta, altDerivs, cacheGet, cachePut, cacheEnvelope } from '../shared/alts.mjs'

// The same patterns the watchlist validates against. `id` is a CoinGecko slug
// and `symbol` a ticker; both are interpolated into upstream URLs and into a
// Blobs key, so nothing outside these character sets ever gets that far.
const ID_RE = /^[a-z0-9-]{1,64}$/i
const SYMBOL_RE = /^[a-zA-Z0-9]{1,20}$/
const TTL_SEC = 300

const handler = sourceHandler('alt_coin', async (req) => {
  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  const symbol = (url.searchParams.get('symbol') || '').toUpperCase()
  const s = store()
  const cacheKey = `alt_coin_${id.toLowerCase()}`

  const cached = await cacheGet(s, cacheKey)
  if (cached && cached.ageSec < TTL_SEC) return cacheEnvelope(cached, { ttlSec: TTL_SEC })

  try {
    const payload = await readCoin(id, symbol)
    await cachePut(s, cacheKey, payload, payload.asOf)
    return { ...payload, cached: false, stale: false, cacheAgeSec: 0 }
  } catch (err) {
    if (!cached) throw err
    return cacheEnvelope(cached, { ttlSec: TTL_SEC, refetchError: String(err?.message || err) })
  }
})

async function readCoin(id, symbol) {
  const [candlesRes, metaRes, derivsRes] = await Promise.allSettled([
    altCandles(symbol, id),
    altCoinMeta(id),
    altDerivs(symbol),
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
  if (!(await checkAuth(req))) return unauthorized()
  const url = new URL(req.url)
  const id = url.searchParams.get('id') || ''
  const symbol = url.searchParams.get('symbol') || ''
  // Echo a bounded slice: the message exists to tell a developer which value
  // was rejected, not to mirror an arbitrary-length query string back out.
  if (!ID_RE.test(id)) return json({ error: `bad or missing id: ${JSON.stringify(id.slice(0, 40))}` }, 400)
  if (!SYMBOL_RE.test(symbol)) return json({ error: `bad or missing symbol: ${JSON.stringify(symbol.slice(0, 40))}` }, 400)
  return handler(req, context)
}
