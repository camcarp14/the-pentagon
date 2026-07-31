// Alt-universe upstream adapters. Same three rules as sources.mjs:
//   - Parsers are PURE functions over raw payloads → fixture-tested.
//   - Each fetcher throws on any failure; chains try the next source.
//   - Every result names its source so the UI can say where a number came from.
//
// The rule this file adds is a quota rule. CoinGecko's keyless tier is roughly
// 10-30 calls/min and answers a rate-limit with a bare 429 and NO body, so a
// 429 is deliberately not special-cased anywhere below: it fails exactly like a
// timeout does. That is what lets the callers degrade — alt-scan serves its
// stale Blobs cache, altCandles falls through to the next source — instead of
// turning a routine quota bump into a 502 with an empty board behind it.
//
// The other thing to know before touching anything here: Binance lists the
// low-priced memecoins (PEPE, SHIB, BONK, FLOKI, …) under a 1000× multiplier
// symbol. 1000PEPEUSDT prints ~0.0072 while a PEPE is worth ~0.0000072. Every
// candle that comes back from a 1000-symbol MUST be divided back to per-coin
// units before anything compares it to a CoinGecko price, or the whole level
// stack — entry, stop, targets — is silently 1000× wrong and still looks
// plausible on its own axis. See applyMultiplier and altCandles.
import { checkAuth } from './util.mjs'
import { parseBinanceKlines } from './sources.mjs'

// Re-exported so alt-* callers have one import for the alt data layer, and so
// nobody is tempted to paste a second copy of the klines parser in here.
export { parseBinanceKlines }

// Minimal user-agent, for the reason documented at length in sources.mjs: from
// a datacenter IP a full fake-Chrome UA without a browser TLS fingerprint is
// what bot detection flags. Impersonate nothing.
const UA = { 'user-agent': 'Mozilla/5.0' }

const CG = 'https://api.coingecko.com/api/v3'
const BINANCE = 'https://api.binance.com'
const BINANCE_FAPI = 'https://fapi.binance.com'

// A local copy of sources.mjs's getJson because that one is module-private.
// Same 3s per-attempt budget and the same reason for it: Netlify kills a
// synchronous function at ~10s, so one slow upstream must not eat the whole
// budget the fallbacks exist to use.
//
// The abort covers the BODY read too, which util.mjs's fetchWithTimeout does not
// — it clears its timer the moment the headers land. That difference matters
// exactly here: the markets payload is 250 rows carrying 168 sparkline points
// each, over a megabyte, and a stream that stalls halfway through it is an
// unbounded wait in the middle of a budget the stale-cache fallback is counting
// on. A timeout that only covers the handshake is not a timeout.
async function getJson(url, opts = {}, timeoutMs = 3000) {
  const host = new URL(url).host
  const ctl = new AbortController()
  // NAMES WHOSE CLOCK RAN OUT. This string is what `degraded` renders and what
  // /api/status stores as `lastError`, and "timeout after 4400ms" reads as the
  // host being down when the 4400 was OUR remaining budget, not their latency.
  // A clipped hop and a genuinely dead upstream are different incidents and the
  // sentence has to say which one happened.
  const t = setTimeout(
    () => ctl.abort(new Error(`${host} did not answer inside the ${timeoutMs}ms this request had left for it`)),
    timeoutMs,
  )
  try {
    const res = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) }, signal: ctl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

/**
 * Number-or-null. Upstream sends numbers, numeric strings and nulls in the same
 * field depending on the coin, and `Number(null)` is 0 — a coin with unknown
 * FDV would otherwise render as "$0 fully diluted", which reads as a fact.
 *
 * THE EMPTY STRING IS THE ONE THAT BITES. `Number('')` and `Number(' ')` are
 * both 0, and every "throw rather than record a bad number" guard in this file
 * is written as `if (fin(x) == null) throw` — so a field that arrived as `""`
 * sailed through all of them as a measured zero. The damage is not symmetric
 * across the parsers: an empty `market_cap_percentage.btc` became a 0% BTC
 * dominance that alt-watch wrote into `alt_dom_history`, where it is
 * indistinguishable from a measurement forever (see parseCoinGeckoGlobal — the
 * free tier has no history endpoint to rebuild that series from), and a 30-day
 * window containing one of them reported a fabricated 57-point collapse.
 * A blank field is an ABSENT measurement, and absent is null.
 */
function fin(v) {
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }
  return Number.isFinite(v) ? v : null
}

function str(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/* ================= parsers (pure, fixture-tested) ================= */

/**
 * CoinGecko /coins/markets → AltRow[].
 * One bad row never kills the board: a single coin with a null price is
 * dropped, because a row that cannot be priced cannot be ranked, sized or
 * charted and would occupy a slot in the top-250 that a real coin should have.
 */
export function parseCoinGeckoMarkets(raw) {
  if (!Array.isArray(raw)) throw new Error('coingecko: malformed markets payload')
  const rows = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const price = fin(r.current_price)
    const mcap = fin(r.market_cap)
    if (price == null || mcap == null) continue
    rows.push({
      id: str(r.id),
      symbol: str(r.symbol).toUpperCase(),
      name: str(r.name),
      image: typeof r.image === 'string' ? r.image : null,
      rank: fin(r.market_cap_rank),
      price,
      mcap,
      fdv: fin(r.fully_diluted_valuation),
      vol24h: fin(r.total_volume),
      chg1h: fin(r.price_change_percentage_1h_in_currency),
      // The `_in_currency` fields only exist because the request asks for them
      // via price_change_percentage=…; the bare 24h field is always present.
      // Falling back to it keeps a coin's headline number alive if the param
      // is ever dropped from the URL.
      chg24h: fin(r.price_change_percentage_24h_in_currency) ?? fin(r.price_change_percentage_24h),
      chg7d: fin(r.price_change_percentage_7d_in_currency),
      chg14d: fin(r.price_change_percentage_14d_in_currency),
      chg30d: fin(r.price_change_percentage_30d_in_currency),
      chg1y: fin(r.price_change_percentage_1y_in_currency),
      ath: fin(r.ath),
      athChangePct: fin(r.ath_change_percentage),
      athDate: typeof r.ath_date === 'string' ? r.ath_date : null,
      atl: fin(r.atl),
      circulating: fin(r.circulating_supply),
      totalSupply: fin(r.total_supply),
      maxSupply: fin(r.max_supply),
      sparkline7d: parseSparkline(r.sparkline_in_7d?.price),
    })
  }
  return rows
}

// ~168 hourly closes. A series with a hole in it is dropped WHOLE rather than
// compacted: screen.js reads the 7d structure positionally ("did the last 24
// points break the prior 6 days' high"), so silently removing a null shifts
// every bar left by an hour and the answer stops meaning what it says. No
// sparkline is an honest null; a re-spaced one is a wrong chart.
function parseSparkline(prices) {
  if (!Array.isArray(prices) || prices.length < 2) return null
  return prices.every((p) => Number.isFinite(p)) ? prices.slice() : null
}

/**
 * CoinGecko /global → the market-wide dominance read.
 * Throws when BTC dominance is missing rather than emitting null: dominance is
 * the only reason this endpoint is called, and alt-watch turns the result into
 * a permanent daily history row. A null written into that series can never be
 * backfilled — the free tier has no history endpoint — so it has to fail here.
 */
export function parseCoinGeckoGlobal(raw) {
  const d = raw?.data
  if (!d || typeof d !== 'object') throw new Error('coingecko: malformed global payload')
  const btc = fin(d.market_cap_percentage?.btc)
  if (btc == null) throw new Error('coingecko: global payload carries no BTC dominance')
  return {
    btcDominancePct: btc,
    ethDominancePct: fin(d.market_cap_percentage?.eth),
    totalMcapUsd: fin(d.total_market_cap?.usd),
    totalVol24hUsd: fin(d.total_volume?.usd),
    mcapChange24hPct: fin(d.market_cap_change_percentage_24h_usd),
  }
}

/**
 * alternative.me /fng → { value, label, at }.
 * Every field arrives as a STRING ("39", "1700000000"); coercing here is the
 * whole job. The clamp is not defensive noise: the index is defined 0-100 and
 * the UI draws it on a fixed track, so an out-of-range value would render as a
 * meter needle off the end of its own scale.
 */
export function parseFearGreed(raw) {
  const d = Array.isArray(raw?.data) ? raw.data[0] : null
  if (!d || typeof d !== 'object') throw new Error('alternative.me: malformed fear & greed payload')
  const value = fin(d.value)
  if (value == null) throw new Error('alternative.me: non-numeric fear & greed value')
  return {
    value: Math.max(0, Math.min(100, Math.round(value))),
    label: str(d.value_classification) || null,
    at: fin(d.timestamp),
  }
}

/**
 * CoinGecko /search/trending → the attention list.
 * `rank` is position in the returned array, assigned AFTER malformed entries
 * are skipped, so the ranks stay dense (1,2,3…). A gap would read as "there is
 * a #2 we are not showing you", which is not what happened.
 */
export function parseTrending(raw) {
  const coins = raw?.coins
  if (!Array.isArray(coins)) throw new Error('coingecko: malformed trending payload')
  const out = []
  for (const c of coins) {
    const it = c?.item
    if (!it || !it.id) continue
    out.push({
      id: str(it.id),
      symbol: str(it.symbol).toUpperCase(),
      name: str(it.name),
      rank: out.length + 1,
      mcapRank: fin(it.market_cap_rank),
    })
  }
  return out
}

/**
 * CoinGecko /coins/{id}/market_chart → FLAT bars, and labelled as such.
 * This is the degraded candle source and the label has to survive all the way
 * to the UI: ATR, bandwidth and swing structure are computed from o/h/l, and on
 * a bar where o === h === l === c every one of them is exactly zero. A zero ATR
 * does not look broken — it looks like the quietest coin ever listed, and it
 * would size a position with a stop a fraction of a percent away.
 */
export function parseCoinGeckoMarketChart(raw) {
  const prices = raw?.prices
  if (!Array.isArray(prices)) throw new Error('coingecko: malformed market_chart payload')
  // Keyed by timestamp rather than by index. CoinGecko returns prices and
  // total_volumes as parallel arrays that are USUALLY aligned, but when a range
  // boundary lands mid-day one comes back a point shorter — and zipping by
  // index then attaches every volume to the wrong bar for the rest of the year.
  const volAt = new Map()
  if (Array.isArray(raw.total_volumes)) {
    for (const p of raw.total_volumes) {
      if (Array.isArray(p) && Number.isFinite(p[0])) volAt.set(Math.floor(p[0] / 1000), fin(p[1]))
    }
  }
  const candles = []
  for (const p of prices) {
    if (!Array.isArray(p)) continue
    const t = Number.isFinite(p[0]) ? Math.floor(p[0] / 1000) : null
    const c = fin(p[1])
    if (t == null || c == null) continue
    candles.push({ t, o: c, h: c, l: c, c, v: volAt.get(t) ?? null })
  }
  if (!candles.length) throw new Error('coingecko: market_chart returned no usable points')
  return { candles, quality: 'close-only' }
}

/**
 * Binance /fapi/v1/premiumIndex (single-symbol form → an object).
 * `lastFundingRate` is the per-INTERVAL fraction (8h on most pairs), not a
 * percent and not annualised. It is passed through raw and annualised once, in
 * sentiment.js, so there is exactly one place where the 3×365 lives.
 */
export function parseBinancePremiumIndex(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('binance: malformed premiumIndex (expected a single-symbol object)')
  }
  const rate = fin(raw.lastFundingRate)
  if (rate == null) throw new Error('binance: premiumIndex carries no funding rate')
  return {
    symbol: str(raw.symbol),
    markPrice: fin(raw.markPrice),
    lastFundingRate: rate,
    nextFundingTime: fin(raw.nextFundingTime),
  }
}

/**
 * Binance /futures/data/openInterestHist → ascending [{ t, oi, oiValueUsd }].
 * `oi` is in base-asset units and therefore carries the 1000× multiplier when
 * the symbol does; `oiValueUsd` is USD and does not. Crowding reads the 24h
 * CHANGE, where the units cancel — but anything that ever prints a raw `oi`
 * has to say which asset unit it is in.
 */
export function parseBinanceOpenInterestHist(raw) {
  if (!Array.isArray(raw)) throw new Error('binance: malformed openInterestHist')
  return raw
    .map((r) => ({
      t: Number.isFinite(fin(r?.timestamp)) ? Math.floor(fin(r.timestamp) / 1000) : null,
      oi: fin(r?.sumOpenInterest),
      oiValueUsd: fin(r?.sumOpenInterestValue),
    }))
    .filter((r) => r.t != null && r.oi != null)
    .sort((a, b) => a.t - b.t)
}

/**
 * Binance globalLongShortAccountRatio / topLongShortPositionRatio.
 * longAccount/shortAccount arrive as FRACTIONS ("0.64"). Everything downstream
 * — the crowding read, the UI bar, the divergence copy — speaks percent, and
 * 0.64 rendered as "0.64% long" reads as nobody being long at all, which is the
 * exact opposite of what the number says. The ×100 happens here, once, at the
 * boundary, so no consumer has to remember it.
 */
export function parseBinanceLongShort(raw) {
  if (!Array.isArray(raw)) throw new Error('binance: malformed long/short ratio')
  return raw
    .map((r) => {
      const long = fin(r?.longAccount)
      const short = fin(r?.shortAccount)
      const ts = fin(r?.timestamp)
      return {
        t: ts == null ? null : Math.floor(ts / 1000),
        ratio: fin(r?.longShortRatio),
        longPct: long == null ? null : long * 100,
        shortPct: short == null ? null : short * 100,
      }
    })
    .filter((r) => r.t != null && (r.ratio != null || r.longPct != null))
    .sort((a, b) => a.t - b.t)
}

/**
 * CoinGecko /coins/{id} (market_data off, community_data on).
 * Every community field is null-safe on purpose: a coin with no Reddit, no
 * Telegram and no Twitter is a completely normal micro-cap, and a 0 there would
 * be read as "measured, and it is zero" rather than "not published".
 */
export function parseCoinGeckoCoin(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) throw new Error('coingecko: malformed coin payload')
  const cd = raw.community_data && typeof raw.community_data === 'object' ? raw.community_data : {}
  const links = raw.links && typeof raw.links === 'object' ? raw.links : {}
  return {
    id: str(raw.id),
    symbol: str(raw.symbol).toUpperCase(),
    name: str(raw.name),
    // CoinGecko really does emit nulls inside the categories array for coins
    // whose category was deleted; a null in there crashes any .includes() chain
    // that classifies meme vs utility.
    categories: Array.isArray(raw.categories) ? raw.categories.filter((c) => typeof c === 'string' && c) : [],
    community: {
      sentimentUpPct: fin(raw.sentiment_votes_up_percentage),
      redditSubs: fin(cd.reddit_subscribers),
      redditActive48h: fin(cd.reddit_accounts_active_48h),
      redditPosts48h: fin(cd.reddit_average_posts_48h),
      twitterFollowers: fin(cd.twitter_followers),
      telegram: fin(cd.telegram_channel_user_count),
      watchlistUsers: fin(raw.watchlist_portfolio_users),
    },
    links: {
      // homepage is an array whose empty slots are '' rather than absent.
      homepage: (Array.isArray(links.homepage) ? links.homepage : []).find((u) => typeof u === 'string' && u) || null,
      twitter: str(links.twitter_screen_name) || null,
      subreddit: str(links.subreddit_url) || null,
    },
  }
}

/* ================= symbol resolution ================= */

/**
 * The two symbols a coin can be listed under on Binance, in resolution order.
 * The 1000× form exists because a tick size cannot be smaller than 1e-8: PEPE
 * at 0.0000072 has three significant digits of price resolution, so Binance
 * lists 1000PEPE instead. Always try the plain symbol FIRST — some coins have
 * both a plain and a 1000 pair, and the plain one is the one whose prices need
 * no correction.
 */
export function binanceSymbolCandidates(symbol) {
  const s = str(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!s) return []
  return [`${s}USDT`, `1000${s}USDT`]
}

/**
 * Divide 1000-symbol candles back to per-coin units.
 * Price fields divide, volume MULTIPLIES: a 1000PEPEUSDT bar's base volume is
 * counted in 1000-PEPE lots, so the coin count is 1000× the printed one. The
 * invariant that proves this right is that traded notional (price × volume) is
 * unchanged — the test asserts exactly that.
 */
export function applyMultiplier(candles, mult) {
  if (!Array.isArray(candles)) return []
  const m = fin(mult)
  if (m == null || m <= 0 || m === 1) return candles
  return candles.map((c) => ({
    ...c,
    o: c.o / m,
    h: c.h / m,
    l: c.l / m,
    c: c.c / m,
    v: Number.isFinite(c.v) ? c.v * m : c.v,
  }))
}

/* ================= the request's time budget ================= */

// Below this an attempt cannot succeed and can only burn the time the fallback
// needed: a cold TLS handshake out to a CoinGecko or Binance edge is a few
// hundred milliseconds before the first byte of an answer. `null` from
// attemptBudget means "skip this hop and say so", never "try it with 40ms".
export const MIN_ATTEMPT_MS = 750

/**
 * ONE WALL CLOCK FOR A WHOLE CHAIN, not one stopwatch per attempt.
 *
 * Per-attempt timeouts bound each hop and nothing else, so a chain adds up: the
 * candle chain is Binance plain (3s) → Binance 1000× (3s) → CoinGecko (5s), and
 * three hops that each honour their own timeout still take 11 seconds. Netlify
 * kills a synchronous function at ~10s, and a platform kill is not an exception
 * — no catch block runs, so the stale-cache fallback that exists precisely so
 * this endpoint degrades instead of 502-ing never executes. The client gets the
 * bare platform 502 the contract says must not happen, from the one code path
 * written to prevent it.
 *
 * So callers pass `deadlineAt`, an absolute epoch-ms instant measured from when
 * the REQUEST arrived — not from when the first fetch starts, because the auth
 * round-trip and the Blobs read are spent out of the same ten seconds.
 *
 * `deadlineAt: null` means no deadline and every attempt gets its full budget,
 * which is the pre-existing behaviour every other caller still relies on.
 */
export function attemptBudget(perAttemptMs, deadlineAt, minMs = MIN_ATTEMPT_MS, now = Date.now()) {
  const at = fin(deadlineAt)
  if (at == null) return perAttemptMs
  const ms = Math.min(perAttemptMs, Math.floor(at - now))
  return ms >= minMs ? ms : null
}

// Netlify kills a synchronous function at ~10s, and the kill runs no catch
// block. Everything upstream has to be FINISHED before then with enough left
// over to write the cache and serialise the answer — on alt-scan that answer is
// a >1MB payload, so the reserve is not a rounding allowance.
export const PLATFORM_KILL_MS = 10_000
export const RESPONSE_RESERVE_MS = 1200

/**
 * EACH ENDPOINT'S DEADLINE COMES OUT OF ITS OWN CHAIN. Two clocks, and the
 * tighter one wins:
 *
 *   • the WALL — `arrivedAt + wallMs` — how long this invocation may live at
 *     all, measured from arrival because auth and the Blobs read are spent out
 *     of the same ten seconds. This is the one that keeps the stale-cache
 *     fallback reachable.
 *   • the CHAIN — `now + chainMs` — how long this endpoint's own upstream chain
 *     can legitimately need. Called at the top of the fetch phase, so `now` is
 *     already past auth and the cache read.
 *
 * ONE SHARED ARRIVAL-BASED NUMBER WAS THE BUG. alt-coin's chain is genuinely
 * serial — Binance plain 3s → Binance 1000× 3s → CoinGecko 5s is 11 seconds
 * against a 10-second kill — so it needs a hard wall and nothing else will do.
 * alt-scan's chain is four calls in PARALLEL whose longest hop is 6s; it never
 * had that problem. Giving it alt-coin's arrival-based 7500ms handed the >1MB
 * universe fetch whatever was left after auth, which on a 2.9s Supabase
 * round-trip is ~4.4s. Measured, with every upstream healthy: a 5.5s CoinGecko
 * response and a 2.5s auth hop produced a stale board, "refetch failed: alt
 * universe", and /api/status told the operator CoinGecko was down. On a cold
 * cache the same inputs produced a hard 502. The abort bought nothing — the
 * wall was 7.5s against a 10s kill either way.
 *
 * So the chain clock is what normally binds on alt-scan (a slow auth no longer
 * comes out of CoinGecko's budget), the wall still binds when the invocation is
 * genuinely running out of life, and alt-coin — whose chain is longer than the
 * wall — is unchanged in behaviour and now says so in one line.
 */
export function requestDeadline({ arrivedAt, chainMs, wallMs = PLATFORM_KILL_MS - RESPONSE_RESERVE_MS, now = Date.now() }) {
  const at = fin(arrivedAt)
  const chain = fin(chainMs)
  if (at == null || chain == null) return null
  return Math.min(at + (fin(wallMs) ?? 0), now + chain)
}

// The line every skipped hop reports. Named rather than inlined so a reader
// grepping a degraded string lands on the budget rule that produced it.
function outOfBudget(what) {
  return `${what}: skipped — the request's time budget was spent before this hop could be tried`
}

/* ================= fetchers with fallback chains ================= */

/**
 * The board's universe. CoinGecko only, and it THROWS when CoinGecko is down —
 * there is deliberately no fallback, because no other keyless source can rank
 * by market cap. Binance can price these coins but cannot value them, and a
 * screener silently ranking by 24h volume while the header still says "market
 * cap" is a different tool wearing this one's label.
 */
export async function altUniverse(limit = 250, { deadlineAt = null } = {}) {
  // CoinGecko caps per_page at 250 and silently truncates above it; clamping
  // here means the caller's `limit` and the row count it gets back agree.
  const perPage = Math.max(1, Math.min(250, Math.floor(fin(limit) ?? 250) || 250))
  const url = `${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=1`
    + '&sparkline=true&price_change_percentage=1h%2C24h%2C7d%2C14d%2C30d%2C1y'
  // 6s rather than the file's 3s: 250 rows each carrying 168 sparkline points is
  // well over a megabyte, and it does not land in 3s from a cold function. The
  // four alt-scan calls run in PARALLEL, so the slowest one sets the wall clock
  // and there is still room inside Netlify's ~10s synchronous budget.
  const ms = attemptBudget(6000, deadlineAt)
  if (ms == null) throw new Error(outOfBudget('coingecko markets'))
  const universe = parseCoinGeckoMarkets(await getJson(url, {}, ms))
  if (!universe.length) throw new Error('coingecko markets: no usable rows')
  return { universe, sourceDetail: 'coingecko' }
}

/** Market-wide dominance + total cap. One call, no fallback (see the parser). */
export async function altGlobal({ deadlineAt = null } = {}) {
  const ms = attemptBudget(3000, deadlineAt)
  if (ms == null) throw new Error(outOfBudget('coingecko global'))
  return { ...parseCoinGeckoGlobal(await getJson(`${CG}/global`, {}, ms)), sourceDetail: 'coingecko' }
}

/** The crypto fear & greed index. A different host, so it survives a CoinGecko 429. */
export async function fearGreed({ deadlineAt = null } = {}) {
  const ms = attemptBudget(3000, deadlineAt)
  if (ms == null) throw new Error(outOfBudget('alternative.me fear & greed'))
  return { ...parseFearGreed(await getJson('https://api.alternative.me/fng/?limit=1', {}, ms)), sourceDetail: 'alternative.me' }
}

/** CoinGecko's trending list — attention, not price. Always optional to callers. */
export async function trendingCoins({ deadlineAt = null } = {}) {
  const ms = attemptBudget(3000, deadlineAt)
  if (ms == null) throw new Error(outOfBudget('coingecko trending'))
  return { trending: parseTrending(await getJson(`${CG}/search/trending`, {}, ms)), sourceDetail: 'coingecko' }
}

/**
 * Daily candles for one alt: Binance klines (plain symbol → 1000× symbol) →
 * CoinGecko market_chart (close-only, degraded).
 *
 * The multiplier is taken from the candidate's POSITION in the list, never by
 * sniffing a '1000' prefix off the resolved symbol. A coin whose own ticker
 * starts with 1000 — 1000SATS is a real listing — would otherwise have its
 * prices divided by 1000 a second time, and the resulting chart is internally
 * consistent, so nothing downstream can notice.
 *
 * This is the chain the deadline was written for: three hops at 3s + 3s + 5s is
 * 11 seconds against a ~10s platform kill. Every hop is now clipped to what is
 * left of the request's budget, and a hop with nothing left is skipped WITH A
 * REASON rather than started and killed — the caller's stale-cache fallback
 * needs to be reachable, and it is only reachable if this returns or throws.
 */
export async function altCandles(symbol, id, { deadlineAt = null } = {}) {
  const errors = []
  const candidates = binanceSymbolCandidates(symbol)
  for (let i = 0; i < candidates.length; i++) {
    const sym = candidates[i]
    const priceMultiplier = i === 0 ? 1 : 1000
    const ms = attemptBudget(3000, deadlineAt)
    if (ms == null) { errors.push(outOfBudget(sym)); continue }
    try {
      const raw = await getJson(`${BINANCE}/api/v3/klines?symbol=${sym}&interval=1d&limit=730`, {}, ms)
      const candles = parseBinanceKlines(raw)
      if (!candles.length) throw new Error(`binance ${sym}: zero candles`)
      return {
        candles: applyMultiplier(candles, priceMultiplier),
        quality: 'ohlcv',
        sourceDetail: priceMultiplier === 1 ? `binance ${sym}` : `binance ${sym} (÷1000 → per-coin units)`,
        binanceSymbol: sym,
        priceMultiplier,
      }
    } catch (e) {
      errors.push(`${sym}: ${e.message}`)
    }
  }
  if (!id) throw new Error(`alt candles: no binance pair for ${str(symbol) || '(blank)'} and no coingecko id to fall back to — ${errors.join(' | ')}`)
  const cgMs = attemptBudget(5000, deadlineAt)
  if (cgMs == null) throw new Error(`alt candles: ${outOfBudget('coingecko market_chart')} — ${errors.join(' | ')}`)
  const { candles, quality } = parseCoinGeckoMarketChart(
    await getJson(`${CG}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=365`, {}, cgMs)
  )
  return {
    candles,
    quality,
    sourceDetail: `coingecko market_chart, close-only (binance: ${errors.join(' | ')})`,
    binanceSymbol: null,
    priceMultiplier: 1,
  }
}

/**
 * Perp derivatives for one alt, or null.
 *
 * ALL of this is optional and null is the normal answer: most of the board has
 * no listed perpetual, and treating "no futures market" as an error would make
 * every micro-cap detail view look broken. The premiumIndex probe doubles as
 * the existence check — if neither candidate symbol answers, there is no perp
 * and we stop, rather than firing three more requests that cannot succeed.
 *
 * BUT `null` IS A CLAIM, NOT AN ABSENCE OF ONE. alt-coin.mjs renders it as
 * "SOL has no listed Binance perpetual — funding, open interest and positioning
 * are unavailable" and sentiment.js as "…and none has been assumed"; both are
 * sentences a reader will believe. A 429, a timeout or a datacenter-IP geo-block
 * is not evidence that a coin has no futures market, so only a DEFINITIVE
 * refusal from Binance may become that sentence. Anything else throws, and the
 * caller's allSettled turns it into "derivatives: <reason>" in `degraded` —
 * which is what the other two failure paths in this file already do.
 */
export async function altDerivs(symbol, { deadlineAt = null } = {}) {
  const candidates = binanceSymbolCandidates(symbol)
  if (!candidates.length) throw new Error('binance futures: no symbol to probe for a listed perpetual')
  let perp = null
  let funding = null
  const errors = []
  for (let i = 0; i < candidates.length; i++) {
    const ms = attemptBudget(3000, deadlineAt)
    if (ms == null) { errors.push(outOfBudget(candidates[i])); continue }
    try {
      funding = parseBinancePremiumIndex(await getJson(`${BINANCE_FAPI}/fapi/v1/premiumIndex?symbol=${candidates[i]}`, {}, ms))
      perp = { symbol: candidates[i], priceMultiplier: i === 0 ? 1 : 1000 }
      break
    } catch (e) {
      errors.push(`${candidates[i]}: ${e.message}`)
    }
  }
  if (!perp) {
    if (errors.every(notListed)) return null
    throw new Error(`binance futures: could not establish whether ${str(symbol).toUpperCase()} has a listed perpetual — ${errors.join(' | ')}`)
  }

  // allSettled, not all: open interest and the two long/short series are three
  // independent nice-to-haves, and one of them 429-ing must not delete the
  // funding rate we already have in hand.
  const extrasMs = attemptBudget(3000, deadlineAt)
  const [oi, retail, top] = extrasMs == null
    // Out of budget after the funding probe. Shaped as rejections so they take
    // the same `settled` path and land in `degraded` saying why — a null series
    // with no reason attached is the bug at the top of this function, one level
    // down.
    ? [0, 1, 2].map(() => ({ status: 'rejected', reason: new Error(outOfBudget('the remaining futures series')) }))
    : await Promise.allSettled([
      getJson(`${BINANCE_FAPI}/futures/data/openInterestHist?symbol=${perp.symbol}&period=1d&limit=30`, {}, extrasMs).then(parseBinanceOpenInterestHist),
      getJson(`${BINANCE_FAPI}/futures/data/globalLongShortAccountRatio?symbol=${perp.symbol}&period=1d&limit=30`, {}, extrasMs).then(parseBinanceLongShort),
      getJson(`${BINANCE_FAPI}/futures/data/topLongShortPositionRatio?symbol=${perp.symbol}&period=1d&limit=30`, {}, extrasMs).then(parseBinanceLongShort),
    ])
  const degraded = []
  const settled = (res, name) => {
    if (res.status === 'fulfilled' && res.value?.length) return res.value
    degraded.push(`${name}: ${res.status === 'fulfilled' ? 'empty series' : res.reason?.message || res.reason}`)
    return null
  }

  return {
    symbol: perp.symbol,
    priceMultiplier: perp.priceMultiplier,
    // Divided for the same reason candles are: this mark price is compared to a
    // CoinGecko spot price by the crowding read, and 1000× apart is not a basis.
    markPrice: funding.markPrice == null ? null : funding.markPrice / perp.priceMultiplier,
    lastFundingRate: funding.lastFundingRate,
    nextFundingTime: funding.nextFundingTime,
    openInterest: settled(oi, 'open interest'),
    globalLongShort: settled(retail, 'retail long/short'),
    topLongShort: settled(top, 'top-trader long/short'),
    degraded,
    sourceDetail: `binance futures ${perp.symbol}`,
  }
}

/**
 * Is this failure Binance ANSWERING "that symbol is not listed", or is it
 * Binance not answering?
 *
 * The futures API replies 400 (`code -1121, "Invalid symbol."`) for a pair it
 * does not list, and that is the only response that licenses the sentence "this
 * coin has no perp". A 429 is a quota bump, a 451 is the geo-block a datacenter
 * IP collects, a 5xx is theirs and a timeout is nobody's — none of them are
 * evidence about the coin. Matched against the message getJson throws so the
 * status classification lives in exactly one place.
 *
 * 404 USED TO BE ON THIS LIST AND IT IS A DIFFERENT ANSWER. Binance says 400
 * for an unlisted SYMBOL; a 404 from fapi.binance.com is about the PATH. If
 * `/fapi/v1/premiumIndex` ever moves, every probe 404s, every coin returns
 * null, and the whole board renders "has no listed Binance perpetual" — the
 * exact positive false claim this function was written to prevent, told about
 * 250 coins at once. The host is pinned for the same reason: only the futures
 * API's own 400 is evidence about a futures listing.
 */
const FAPI_HOST = new URL(BINANCE_FAPI).host
function notListed(message) {
  return String(message || '').includes(`HTTP 400 from ${FAPI_HOST}`)
}

/** Categories + community stats for one coin. Optional to every caller. */
export async function altCoinMeta(id, { deadlineAt = null } = {}) {
  const url = `${CG}/coins/${encodeURIComponent(id)}`
    + '?localization=false&tickers=false&market_data=false&community_data=true&developer_data=false&sparkline=false'
  const ms = attemptBudget(4000, deadlineAt)
  if (ms == null) throw new Error(outOfBudget('coingecko coin metadata'))
  return { ...parseCoinGeckoCoin(await getJson(url, {}, ms)), sourceDetail: 'coingecko' }
}

/* ================= dominance history (accumulated, not fetched) ================= */

// ~13 months: long enough to carry a cycle's worth of dominance for the 30-day
// trend and a year of context, short enough that the blob stays tens of KB.
export const DOM_HISTORY_CAP = 400

/** A row is only history if it has a date and a dominance. Used to sanitise the
 *  blob on both the read and the write side, so a half-written or hand-edited
 *  entry cannot poison the sort or be counted as a day of history. */
export function isDominanceRow(r) {
  return !!r && typeof r.d === 'string' && Number.isFinite(r.btcDom)
}

/**
 * Merge today's dominance sample into the accumulated series. Pure, because
 * this is the highest-stakes bookkeeping in the alt tool: CoinGecko's free tier
 * has no dominance history endpoint, so this array IS the history, and a bug
 * here is not a wrong render — it is a permanently wrong dataset that no later
 * fix can rebuild.
 *
 * ONE ROW PER CALENDAR DAY, last write wins. Today's row keeps updating as the
 * day goes on, so the newest point tracks live dominance; every completed day
 * settles at its final pass of the day. Which hour that is does not matter —
 * that it is the SAME hour for every completed row is what makes "dominance
 * fell 2.1 points in 30 days" a comparison rather than a coincidence.
 */
export function mergeDominanceSample(rows, sample, cap = DOM_HISTORY_CAP) {
  if (!isDominanceRow(sample)) {
    throw new Error('dominance: refusing to record a sample with no date or no BTC dominance')
  }
  const out = (Array.isArray(rows) ? rows : []).filter((r) => isDominanceRow(r) && r.d !== sample.d)
  out.push(sample)
  // Sorted BEFORE the cap, so slice drops the oldest rows rather than whatever
  // happened to sit at the front of an out-of-order blob.
  out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
  const n = Math.max(1, Math.floor(fin(cap) ?? DOM_HISTORY_CAP))
  return out.slice(-n)
}

/* ================= Blobs cache with a labelled stale fallback ================= */

// alt-scan and alt-coin both need the same three-state behaviour — fresh hit,
// refetch, expired-but-better-than-nothing — and they live in different files.
// The semantics are subtle enough (a stale payload MUST arrive labelled, or the
// freshness ladder reads a two-hour-old board as live) that two copies would
// drift, and the copy that drifted would be the one serving a wrong number
// without a warning on it. One implementation, two callers.

/** Never throws: a Blobs failure is a cache miss, not an error. */
export async function cacheGet(s, key) {
  try {
    const raw = await s.get(key, { type: 'json' })
    if (!raw?.payload || !Number.isFinite(raw.at)) return null
    // Floored at 0 so a backwards clock jump costs one extra refetch rather
    // than pinning a payload under the TTL forever.
    return { payload: raw.payload, at: raw.at, ageSec: Math.max(0, (Date.now() - raw.at) / 1000) }
  } catch {
    return null
  }
}

/** Best-effort write. A failed cache write costs the next caller a refetch; it
 *  must never fail a request whose data is already in hand. */
export async function cachePut(s, key, payload, at = Date.now()) {
  try {
    await s.setJSON(key, { at, payload })
    return true
  } catch {
    return false
  }
}

/**
 * THE ONE FRESHNESS COMPARISON. Both callers gate their refetch on it and
 * cacheEnvelope labels from it, so the two answers cannot disagree.
 *
 * They used to. The envelope rounded the age before comparing it to the TTL
 * while the callers compared the raw float, so for the half-second at the top of
 * every window — a measured 89.5s against a 90s TTL — alt-scan took the
 * no-refetch path and then labelled the result `stale: true` with
 * "refetch failed: unknown error" appended to `degraded`. Nothing had failed;
 * nothing had even been attempted. SeasonCard renders that string.
 */
export function cacheIsFresh(cached, ttlSec) {
  const ageSec = fin(cached?.ageSec)
  if (ageSec == null) return false
  return ageSec < (fin(ttlSec) ?? 0)
}

/**
 * Wrap a cached payload for delivery. Pure, so the labelling is fixture-tested.
 * A payload past its TTL is still served — an expired board beats a 502 that
 * blanks the screen — but it is served with `stale: true`, an age, and a line
 * appended to `degraded` so the reason shows up on the screen and not just in
 * a field nobody rendered.
 *
 * The age is rounded for DISPLAY only, after the staleness decision has already
 * been made on the raw value — see cacheIsFresh for what rounding first cost.
 */
export function cacheEnvelope(cached, { ttlSec = 0, refetchError = null } = {}) {
  const stale = !cacheIsFresh(cached, ttlSec)
  const ageSec = Math.max(0, Math.round(fin(cached?.ageSec) ?? 0))
  const payload = { ...(cached?.payload || {}) }
  if (stale) {
    payload.degraded = [
      ...(Array.isArray(payload.degraded) ? payload.degraded : []),
      `serving a ${ageSec}s-old cached payload — refetch failed: ${refetchError || 'unknown error'}`,
    ]
  }
  return { ...payload, cached: true, stale, cacheAgeSec: ageSec }
}

/* ================= who may spend the sentinel's quota ================= */

/**
 * MAY THIS REQUEST RUN THE SENTINEL PASS?
 *
 * THE ANSWER IS ALMOST ALWAYS YES, AND THAT IS THE FIX, NOT A CONCESSION.
 *
 * The previous version admitted one unauthenticated POST per 2-hour slot and
 * claimed the slot in Blobs before doing any work. It had three failures, all
 * reproduced:
 *
 *   • FORGEABLE. A bare `curl -X POST` — no headers, no body — was admitted
 *     with `scheduled: true`, identical to the cron. The header claimed "a
 *     forged POST can only ever consume a slot the scheduler has already used";
 *     it could not, because nothing distinguished the two.
 *   • THE FORGERY DENIED THE SCHEDULER. The slot was claimed before the work,
 *     so a forged POST that then hit a CoinGecko 429 — which this file calls a
 *     routine event on the keyless tier — burned the slot and wrote nothing.
 *     The real cron then skipped, returned HTTP 200, and Netlify recorded a
 *     successful invocation. A day of dominance history gone, reported green.
 *   • IT COULD NOT SURVIVE CLOCK SKEW. Slots are `floor(now / 2h)` and the cron
 *     fires on the same boundary, so a fire landing one second early computed
 *     the PREVIOUS slot, which the previous fire had already claimed. Measured:
 *     on-time slot 247989 admitted, 1s early slot 247989 refused. A persistent
 *     skew skips every other pass, 200 OK each time.
 *
 * AND THE THREAT IS NOT REACHABLE ON THIS PLATFORM. Netlify's own docs, on
 * scheduled functions: "scheduled functions that are published as part of a
 * deploy cannot be invoked directly with a URL" — they only run on published
 * deploys, and the manual escape hatch is the Run now button in the UI, not an
 * HTTP request. `alt-watch` is declared scheduled in netlify.toml, so the
 * `/api/*` rewrite does not expose it. The quota this gate was rationing cannot
 * be spent by a stranger, and the operator escape hatch it documented (`authed
 * → unlimited`) did not exist either, because the operator cannot reach the
 * endpoint by URL any more than an attacker can.
 *   https://docs.netlify.com/build/functions/scheduled-functions/
 *   https://github.com/netlify/labs/blob/main/features/scheduled-functions/documentation/README.md
 *
 * So the lockout was certain and the attack was not. The invariant this file
 * has asserted since it was written — a day the sentinel does not run is a day
 * nothing can backfill, which is "a far worse outcome than the quota it was
 * protecting" — decides it: NOTHING HERE MAY CAUSE THE SCHEDULER TO SKIP A
 * DOMINANCE SAMPLE. So there is no slot, no claim, no Blobs read, no clock
 * arithmetic and no state of any kind. There is nothing left that can fail
 * closed.
 *
 * What survives is the one refusal that cannot possibly be the scheduler: a
 * GET or a HEAD with no operator token. Netlify invokes a scheduled function
 * with a POST; a browser, a crawler and a bare `curl` send GET. That refusal
 * costs an unauthenticated reader nothing they were entitled to and is the
 * cheapest possible answer to a crawler — and it is deliberately narrow. Every
 * other shape, including a method this code does not recognise or a request
 * that carries none at all, is ADMITTED, because "I did not recognise the
 * invocation shape" must never be the reason a dominance row is missing. The
 * old gate's own header worried about exactly this for the `next_run` body and
 * then took the risk one field over.
 *
 * `s` is still accepted so alt-watch.mjs's call site does not have to change
 * shape, and is deliberately unused: a gate that reads a blob is a gate that
 * can be broken by a blob.
 */
export async function altWatchGate(req, _s, _now = Date.now()) {
  const admit = (over) => ({ allowed: true, authed: false, scheduled: true, slot: null, reason: null, ...over })
  if (await checkAuth(req)) return admit({ authed: true, scheduled: false })

  // `scheduled` stays true on this path for the reason alt-watch.mjs reads it:
  // it gates the "an off-schedule run does not restamp a day that already has a
  // row" rule, and an unauthenticated invocation of a scheduled-only function
  // IS the schedule.
  const method = str(req?.method).toUpperCase()
  if (method === 'GET' || method === 'HEAD') {
    return {
      allowed: false,
      authed: false,
      scheduled: false,
      slot: null,
      reason: `alt-watch runs on its schedule or for a signed-in operator; a bare ${method} spends CoinGecko quota the Alts tab needs`,
    }
  }
  return admit()
}
