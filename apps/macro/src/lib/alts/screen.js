// THE SCREENER — rank a few hundred market rows by how likely each one is to be
// at the START of a move, not by how much it has already moved.
//
// That distinction is the entire file. A board sorted by 30-day return is a list
// of things you already missed, and it is the single easiest screener to build
// and the single most expensive one to trade. So the two biggest blocks of the
// score here are ACCELERATION (24h against the week's own pace, the week against
// the month's) and 7-DAY STRUCTURE (where price sits in its own range, and
// whether the last day took out the prior six days' high). Raw 30-day return is
// worth nothing on its own anywhere in this file; it only appears as a
// denominator, or as the thing the parabolic penalty fires on.
//
// Pure. No fetch, no DOM, no Date.now() — `now` is passed in (ms epoch) or
// omitted. Short arrays, nulls and NaN are normal inputs, not errors.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE 100 POINTS, IN FULL — a reader must be able to verify a score by eye.
// parts[] always sums to score. Every ladder is "first threshold met wins".
//
//   RELATIVE STRENGTH vs BTC ....................................... 0–25
//     rs7d = coin 7d% − BTC 7d%, in percentage points        (max 15)
//        ≥+25 →15   ≥+12 →12   ≥+5 →9   ≥0 →6   ≥−10 →3   else 0
//     rs30d = coin 30d% − BTC 30d%                           (max 10)
//        ≥+40 →10   ≥+15 →8    ≥0 →5    ≥−20 →2   else 0
//     A coin merely MATCHING BTC over 30d still takes 5 of 10 here: flat-for-a-
//     month is the base a new move starts from, and punishing it would rank the
//     board by exactly the thing this file refuses to rank by.
//
//   ACCELERATION ................................................... 0–30
//     d24VsWeek = 24h% − (7d% ÷ 7), in points of one-day excess (max 18)
//        ≥+8 →18   ≥+4 →14   ≥+2 →10   ≥+0.5 →6   ≥−1 →3   else 0
//     weekVsMonth = (7d% ÷ 7) − (30d% ÷ 30), points per day     (max 12)
//        ≥+1.5 →12  ≥+0.7 →9   ≥+0.2 →6   ≥0 →3    else 0
//     Both are DIFFERENCES, never ratios. A ratio against a 7d return near zero
//     — which is precisely the coin we are hunting — divides by ~0 and returns
//     an infinity that sorts to the top of the board.
//
//   TURNOVER  vol24h ÷ mcap ........................................ 0–15
//        ≥0.50 →15  ≥0.25 →13  ≥0.12 →11  ≥0.06 →8  ≥0.02 →4  ≥0.005 →1  else 0
//
//   7-DAY STRUCTURE, from sparkline7d .............................. 0–20
//     position in the 7d range, pos = (last−low)÷(high−low)      (max 10)
//        ≥0.90 →10  ≥0.70 →8   ≥0.50 →5   ≥0.30 →2   else 0
//     fresh break: last day's high > prior six days' high        (max 10)
//        yes →10, no →0
//
//   ROOM FROM ATH  (drawdownFromAthPct) ............................ 0–10
//        ≥80 →10   ≥50 →8   ≥25 →5   ≥10 →3   else 0
//     A coin AT its all-time high scores 0 here. That is not a verdict against
//     it — price discovery is fine — it simply has no overhead room to sell into
//     you, so it earns its points in structure and RS instead.
//
//   PENALTIES (negative, applied last) ......................... down to −40
//     parabolic       24h > +40% or 7d > +100%                       −25
//     thin liquidity  vol24h < $250k                                 −15
//
// The penalty is clamped to the points actually earned, so a −25 against a
// 12-point coin lands as −12 and the floor is a true 0. Without that clamp the
// score gets clamped instead and parts[] silently stops summing to it, which is
// the one thing a "verify it by eye" table cannot survive.
//
// WHY A PARABOLIC COIN STILL SCORES WELL ON THE WAY UP AND THEN LOSES: a coin
// up 47% today maxes out d24VsWeek (18) and turnover (15) — the same readings an
// igniting coin gives, because they are the same readings. −25 is what separates
// "this is starting" from "this already went", and it is deliberately large
// enough to drop a blow-off below a clean ignition. Worked example in the tests.
//
// MISSING INPUT SCORES ZERO, NOT A NEUTRAL HALF. A coin whose sparkline never
// arrived cannot reach the top of the board, and that is intended: the board
// ranks evidence, and we do not have the evidence. The part is still emitted,
// with a label naming what is missing, so the row explains its own low score.

/* ══ classification: the exclusion sets, shared with season.js ═══════════════
 *
 * LOAD-BEARING, not hygiene. Left in, USDT posts a turnover score off the chart
 * (its entire market cap changes hands most days) with a 30-day return of ±0.1%,
 * and stETH reads as a flawless BTC-correlated mover because it is a receipt for
 * ETH. Both would sit in the top of a momentum board while being, respectively,
 * a dollar and a wrapper. */

// Symbols first, because the symbol is the only field guaranteed to be present.
export const STABLECOIN_SYMBOLS = new Set([
  'USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDD', 'FDUSD', 'PYUSD', 'USDE', 'SUSDE',
  'USDS', 'SUSDS', 'FRAX', 'SFRAX', 'LUSD', 'USDP', 'GUSD', 'USDY', 'USD0', 'USD0++',
  'CRVUSD', 'GHO', 'MIM', 'DOLA', 'USDX', 'USDB', 'RLUSD', 'EURC', 'EURS', 'EURT',
  'AEUR', 'XSGD', 'BSC-USD', 'USDT0', 'BUIDL', 'USTC',
  // Metal-pegged tokens belong here for the same reason: their "return" is the
  // peg's return, so every momentum reading in this file is meaningless on them.
  'PAXG', 'XAUT',
])

export const WRAPPER_SYMBOLS = new Set([
  'WBTC', 'WETH', 'STETH', 'WSTETH', 'WBETH', 'WEETH', 'EETH', 'RETH', 'CBBTC', 'CBETH',
  'SETH', 'SETH2', 'OSETH', 'EZETH', 'RSETH', 'PUFETH', 'SWETH', 'METH', 'ANKRETH',
  'SFRXETH', 'FRXETH', 'RSWETH', 'LSETH', 'ETHX', 'OETH', 'WOETH',
  'BTCB', 'TBTC', 'RENBTC', 'HBTC', 'SOLVBTC', 'LBTC', 'BBTC', 'FBTC', 'CLBTC', 'ENZOBTC',
  'WBNB', 'WSOL', 'WAVAX', 'WMATIC', 'WPOL', 'WHYPE', 'WS', 'WCRO', 'WFTM', 'WKAVA',
  'MSOL', 'JITOSOL', 'BNSOL', 'JUPSOL', 'STSOL', 'BSOL', 'INF', 'HSOL', 'EDGESOL',
  'STHYPE', 'WSTHYPE', 'STETH.E', 'RSTETH',
])

// Meme classification is AUTHORED, not inferred. There is no field on a markets
// row that says "this is a joke", and guessing from the name produces nonsense
// (WIF is a dog, WLD is an iris scanner, both start with W).
export const MEME_SYMBOLS = new Set([
  'DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'BABYDOGE', 'MEME', 'BRETT', 'POPCAT',
  'MOG', 'TURBO', 'LADYS', 'TOSHI', 'SPX', 'GIGA', 'PNUT', 'GOAT', 'ACT', 'NEIRO',
  'MOODENG', 'CHILLGUY', 'FARTCOIN', 'BOME', 'MEW', 'SLERF', 'MYRO', 'WEN', 'DEGEN',
  'HIGHER', 'ELON', 'KISHU', 'AKITA', 'HOGE', 'SAMO', 'DOGS', 'CAT', 'MUMU', 'ANDY',
  'WOJAK', 'BAN', 'PONKE', 'RETARDIO', 'MICHI', 'DADDY', 'BILLY', 'HARAMBE', 'SUNDOG',
  'TRUMP', 'MELANIA', 'PEOPLE', 'LEASH', 'BONE', 'AIDOGE', 'SNEK', 'HOSKY', 'AI16Z',
])

// Same policy the other way: a short authored list of the obvious non-jokes, so
// the board's "utility" filter is not empty on a feed that carries no
// categories. Anything on neither list is 'unknown' and says so. We are not
// labelling three hundred coins "utility" on the grounds that they are not dogs.
export const UTILITY_SYMBOLS = new Set([
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'AVAX', 'DOT', 'TRX', 'LINK', 'MATIC', 'POL',
  'TON', 'ICP', 'NEAR', 'APT', 'SUI', 'SEI', 'TIA', 'ARB', 'OP', 'ATOM', 'FIL', 'HBAR',
  'ALGO', 'XLM', 'ETC', 'LTC', 'BCH', 'XMR', 'ZEC', 'DASH', 'EOS', 'XTZ', 'FLOW', 'EGLD',
  'UNI', 'AAVE', 'MKR', 'SKY', 'CRV', 'LDO', 'SNX', 'COMP', 'SUSHI', 'BAL', 'YFI', 'ENA',
  'PENDLE', 'GMX', 'DYDX', 'JUP', 'RAY', 'JTO', 'CAKE', '1INCH', 'RUNE', 'INJ', 'KAVA',
  'GRT', 'RENDER', 'RNDR', 'FET', 'AGIX', 'OCEAN', 'TAO', 'AR', 'STX', 'IMX', 'AXS',
  'SAND', 'MANA', 'GALA', 'ENJ', 'CHZ', 'APE', 'BLUR', 'ENS', 'LPT', 'STRK', 'ZK', 'W',
  'HYPE', 'S', 'FTM', 'KAS', 'ROSE', 'MINA', 'CFX', 'ONE', 'QNT', 'VET', 'THETA', 'IOTA',
])

const STABLE_NAME_RE = /\b(usd|dollar|stable|euro|tether)\b/i
const WRAPPER_NAME_RE = /\b(wrapped|staked|restaked|restaking|bridged|peg|pegged|liquid staking)\b/i
const WRAPPER_ID_RE = /^(wrapped|staked|bridged|binance-peg)[-]/i

/**
 * Is this row a dollar (or a gram of gold) wearing a ticker?
 *
 * Static set first, then a flatness heuristic to catch the stablecoin that
 * launched after this list was written.
 *
 * The heuristic is DELIBERATELY TIGHTER than "|30d| < 2% on a $1B+ cap". That
 * test alone fires on BTC in a quiet month — a real, ordinary market state —
 * and silently deleting Bitcoin from the market is a far worse failure than
 * leaving one unknown stablecoin on the board. So flatness must hold across all
 * three windows at once (a day, a week and a month all inside the noise), and
 * the authored utility list overrides it outright. Real assets are not still for
 * a week AND a month AND a day.
 *
 * The second clause is the belt-and-braces one: priced at a dollar, still on
 * every window, big enough to be real, and NAMED like a dollar.
 */
export function isStablecoin(row) {
  const sym = String(row?.symbol ?? '').toUpperCase()
  if (STABLECOIN_SYMBOLS.has(sym)) return true
  if (UTILITY_SYMBOLS.has(sym)) return false // authored override — see above
  const { mcap, chg24h, chg7d, chg30d, price, name } = row ?? {}
  const flat =
    Number.isFinite(chg24h) && Math.abs(chg24h) < 0.5 &&
    Number.isFinite(chg7d) && Math.abs(chg7d) < 1 &&
    Number.isFinite(chg30d) && Math.abs(chg30d) < 2
  if (flat && Number.isFinite(mcap) && mcap > 1e9) return true
  if (
    flat &&
    Number.isFinite(price) && price > 0.99 && price < 1.01 &&
    Number.isFinite(mcap) && mcap > 2e8 &&
    STABLE_NAME_RE.test(String(name ?? ''))
  ) return true
  return false
}

/**
 * Is this row a receipt for another coin? Static set, then the NAME — which is
 * the honest place to look, because these things are named descriptively
 * ("Lido Staked Ether", "Coinbase Wrapped BTC", "Binance-Peg WETH"). Deriving it
 * from the symbol shape instead would eat WIF, WLD and WEN.
 */
export function isWrapper(row) {
  const sym = String(row?.symbol ?? '').toUpperCase()
  if (WRAPPER_SYMBOLS.has(sym)) return true
  if (WRAPPER_NAME_RE.test(String(row?.name ?? ''))) return true
  if (WRAPPER_ID_RE.test(String(row?.id ?? ''))) return true
  return false
}

/** Rows the board must never rank. Exported because season.js counts breadth
 *  over the same population and the two must not drift apart. */
export function isExcluded(row) {
  return isStablecoin(row) || isWrapper(row)
}

/** tier from market cap — the shared vocabulary in the contract. */
export function tierOf(mcap) {
  if (!Number.isFinite(mcap)) return 'unknown'
  if (mcap >= 1e10) return 'major'
  if (mcap >= 1e9) return 'mid'
  if (mcap >= 1e8) return 'small'
  return 'micro'
}

/**
 * kind from CoinGecko categories when the caller has them (only /api/alt-coin
 * carries categories; the markets rows on the board do not), else the authored
 * symbol lists, else 'unknown'.
 */
export function kindOf(row) {
  const sym = String(row?.symbol ?? '').toUpperCase()
  const cats = Array.isArray(row?.categories) ? row.categories.map((c) => String(c).toLowerCase()) : null
  if (cats && cats.some((c) => c.includes('meme'))) return 'meme'
  if (MEME_SYMBOLS.has(sym)) return 'meme'
  if (cats && cats.length > 0) return 'utility'
  if (UTILITY_SYMBOLS.has(sym)) return 'utility'
  return 'unknown'
}

/* ══ the score ══════════════════════════════════════════════════════════════ */

const RS7 = [[25, 15], [12, 12], [5, 9], [0, 6], [-10, 3]]
const RS30 = [[40, 10], [15, 8], [0, 5], [-20, 2]]
const A24 = [[8, 18], [4, 14], [2, 10], [0.5, 6], [-1, 3]]
const A7V30 = [[1.5, 12], [0.7, 9], [0.2, 6], [0, 3]]
const TURN = [[0.5, 15], [0.25, 13], [0.12, 11], [0.06, 8], [0.02, 4], [0.005, 1]]
const POS = [[0.9, 10], [0.7, 8], [0.5, 5], [0.3, 2]]
const ROOM = [[80, 10], [50, 8], [25, 5], [10, 3]]

const PARABOLIC_24H = 40
const PARABOLIC_7D = 100
const THIN_VOL_USD = 250_000

/** First threshold met wins; a non-finite value scores 0 and the caller labels
 *  the part with what was missing. */
function step(value, table) {
  if (!Number.isFinite(value)) return 0
  for (const [min, points] of table) if (value >= min) return points
  return 0
}

/**
 * 7-day structure out of the sparkline.
 *
 * The series is nominally 168 hourly closes, but CoinGecko truncates it for
 * young coins, so "one day" is derived as len/7 rather than hard-coded to 24.
 * Hard-coding it made the fresh-break test compare the last 24 points of a
 * 40-point series against the other 16 and call three days "the prior six".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO PAIRS OF NUMBERS, TWO DIFFERENT JOBS, AND THEY ARE NOT INTERCHANGEABLE.
 *
 *   low / high      the 7-day RANGE, today INCLUDED. A description of where the
 *                   series has been, and the only correct denominator for `pos`
 *                   ("how far up its own week is price now") — a range that
 *                   excluded the newest point could put `pos` above 1.
 *   priorLow /      the 7-day LEVELS, today EXCLUDED. What price has to clear or
 *   priorHigh       lose to have DONE something. Both are taken over the same
 *                   `prior` slice, so they are one window with two ends.
 *
 * `priorLow` exists because directive.js's sparkline fallback used `low` as the
 * invalidation level, and `low` is a minimum over a window that contains the
 * price it was then compared against. So invalidation EQUALLED the current price
 * on every row that was making its own 7-day low, `price <= invalidation` was
 * true by construction, and the scheduled sentinel sent "FOO invalidation hit …
 * lost $50.00" where $50.00 was the live price. Measured over 20,000 random
 * 7-day tapes it fired on 1,276 of them, and on exactly the 1,276 where price was
 * its own minimum — a test of the series against itself, not of price against a
 * level. `priorHigh` never had the bug (it always excluded the last day), which
 * is what made the pair asymmetric and the asymmetry invisible.
 *
 * A level that moves with price is not a level. Both ends are now drawn from the
 * bars that are DONE, which is the same rule directive.js's candle window keeps.
 */
export function structure7d(sparkline) {
  const s = Array.isArray(sparkline) ? sparkline.filter(Number.isFinite) : []
  const out = { low: null, high: null, last: null, pos: null, freshBreak: false, priorHigh: null, priorLow: null, points: s.length }
  if (s.length < 8) return out
  const low = Math.min(...s)
  const high = Math.max(...s)
  const last = s[s.length - 1]
  out.low = low
  out.high = high
  out.last = last
  // A dead-flat series is a real input (a delisted or pegged row). Dividing by
  // the zero range would put NaN into the score and NaN sorts nowhere.
  out.pos = high > low ? (last - low) / (high - low) : null

  const day = Math.max(2, Math.round(s.length / 7))
  if (s.length >= day * 2) {
    // ONE slice, read by both levels — the same shape directive.js's candle
    // window has, for the same reason. Two slices is how the two ends came
    // apart, and nothing failed when they did.
    const prior = s.slice(0, s.length - day)
    const lastDay = s.slice(s.length - day)
    const priorHigh = Math.max(...prior)
    out.priorHigh = priorHigh
    out.priorLow = Math.min(...prior)
    out.freshBreak = Math.max(...lastDay) > priorHigh
  }
  return out
}

/**
 * Score one market row.
 *
 * @param row  AltRow from parseCoinGeckoMarkets (may carry `categories` when it
 *             came through /api/alt-coin)
 * @param ctx  { btcRow, ethRow, season, now }
 *
 * `season` contributes a FACT and never a point. Folding the regime into the
 * score would mean the same chart ranks 12th in one market and 3rd in another,
 * so the board would stop being a ranking of setups and start being a ranking
 * of setups times a constant — which is the same ranking, scaled, except at the
 * band boundaries where it silently is not. The regime belongs in the directive
 * (which can refuse to act on a good setup) and in the fact below (which tells
 * the reader the row is fighting the tape). `ethRow` is accepted for signature
 * symmetry with the rest of the alts libs and is not read here.
 */
export function screenCoin(row, ctx = {}) {
  const { btcRow = null, season = null, now = null } = ctx
  const base = { ...(row || {}) }
  const sym = String(row?.symbol ?? '').toUpperCase()

  const stablecoin = isStablecoin(row)
  const wrapper = isWrapper(row)
  const tier = tierOf(row?.mcap)
  const kind = kindOf(row)

  const turnover = Number.isFinite(row?.vol24h) && Number.isFinite(row?.mcap) && row.mcap > 0
    ? row.vol24h / row.mcap
    : null

  // Excluded rows get score null and leave here. They are never ranked, never
  // banded, and screenUniverse drops them entirely.
  if (stablecoin || wrapper) {
    const why = stablecoin ? 'a stablecoin' : 'a wrapped/staked derivative of another asset'
    return {
      ...base,
      score: null, band: 'dead', tier, kind,
      parts: [],
      facts: [`${sym || 'this row'} is ${why} — excluded from the board, not ranked`],
      flags: { stablecoin, wrapper, parabolic: false, thinLiquidity: false, freshBreak: false, newListing: false },
      turnover, rsVsBtc7d: null, rsVsBtc30d: null,
      accel: { d24VsWeek: null, weekVsMonth: null, daily7d: null, daily30d: null },
      drawdownFromAthPct: null,
      range7d: { low: null, high: null, last: null, pos: null, freshBreak: false, priorHigh: null, priorLow: null, points: 0 },
    }
  }

  const chg24h = num(row?.chg24h)
  const chg7d = num(row?.chg7d)
  const chg30d = num(row?.chg30d)
  const btc7d = num(btcRow?.chg7d)
  const btc30d = num(btcRow?.chg30d)

  const rsVsBtc7d = chg7d != null && btc7d != null ? chg7d - btc7d : null
  const rsVsBtc30d = chg30d != null && btc30d != null ? chg30d - btc30d : null

  const daily7d = chg7d != null ? chg7d / 7 : null
  const daily30d = chg30d != null ? chg30d / 30 : null
  const d24VsWeek = chg24h != null && daily7d != null ? chg24h - daily7d : null
  const weekVsMonth = daily7d != null && daily30d != null ? daily7d - daily30d : null
  const accel = { d24VsWeek, weekVsMonth, daily7d, daily30d }

  const range7d = structure7d(row?.sparkline7d)

  // ath_change_percentage arrives negative (−85 = 85% below the high). The board
  // shows a magnitude, so it is flipped here once, at the boundary, rather than
  // by whichever component happens to render it.
  let drawdownFromAthPct = null
  if (Number.isFinite(row?.athChangePct)) drawdownFromAthPct = Math.max(0, -row.athChangePct)
  else if (Number.isFinite(row?.ath) && Number.isFinite(row?.price) && row.ath > 0) {
    drawdownFromAthPct = Math.max(0, (1 - row.price / row.ath) * 100)
  }

  const parts = []
  const facts = []

  // ── relative strength vs BTC (0–25) ──────────────────────────────────────
  parts.push({
    key: 'rs7', max: 15, points: step(rsVsBtc7d, RS7),
    label: rsVsBtc7d == null ? 'no 7d RS (BTC or coin 7d missing)' : `7d RS vs BTC ${pts(rsVsBtc7d)}`,
  })
  parts.push({
    key: 'rs30', max: 10, points: step(rsVsBtc30d, RS30),
    label: rsVsBtc30d == null ? 'no 30d RS (BTC or coin 30d missing)' : `30d RS vs BTC ${pts(rsVsBtc30d)}`,
  })
  if (rsVsBtc7d != null) facts.push(`7d ${pct(chg7d)} vs BTC ${pct(btc7d)} — ${pts(rsVsBtc7d)} of relative strength`)
  if (rsVsBtc30d != null) facts.push(`30d ${pct(chg30d)} vs BTC ${pct(btc30d)} — ${pts(rsVsBtc30d)}`)

  // ── acceleration (0–30) — the "starting, not started" block ──────────────
  parts.push({
    key: 'accel24', max: 18, points: step(d24VsWeek, A24),
    label: d24VsWeek == null ? 'no 24h acceleration (24h or 7d missing)' : `24h vs the week's pace ${pts(d24VsWeek)}`,
  })
  parts.push({
    key: 'accel7v30', max: 12, points: step(weekVsMonth, A7V30),
    label: weekVsMonth == null ? 'no week/month acceleration (7d or 30d missing)' : `week vs month pace ${pts(weekVsMonth)}/day`,
  })
  if (d24VsWeek != null) {
    facts.push(`24h ${pct(chg24h)} against a 7-day pace of ${pct(daily7d, 2)}/day — ${pts(d24VsWeek)} of one-day excess`)
  }
  if (weekVsMonth != null) {
    facts.push(`the week is running ${pct(daily7d, 2)}/day vs the month's ${pct(daily30d, 2)}/day`)
  }

  // ── turnover (0–15) ──────────────────────────────────────────────────────
  parts.push({
    key: 'turnover', max: 15, points: step(turnover, TURN),
    label: turnover == null ? 'no turnover (volume or market cap missing)' : `turnover ${(turnover * 100).toFixed(1)}% of cap`,
  })
  if (turnover != null) {
    facts.push(`${usd(row.vol24h)} traded on a ${usd(row.mcap)} cap — ${(turnover * 100).toFixed(1)}% of the float in a day`)
  }

  // ── 7-day structure (0–20) ───────────────────────────────────────────────
  parts.push({
    key: 'range', max: 10, points: step(range7d.pos, POS),
    label: range7d.pos == null ? 'no 7d range (sparkline missing or flat)' : `${Math.round(range7d.pos * 100)}% up its own 7d range`,
  })
  parts.push({
    key: 'break', max: 10, points: range7d.freshBreak ? 10 : 0,
    label: range7d.priorHigh == null ? 'no break read (sparkline too short)'
      : range7d.freshBreak ? 'last 24h broke the prior 6d high' : 'no break of the prior 6d high',
  })
  if (range7d.pos != null) {
    facts.push(`price sits ${Math.round(range7d.pos * 100)}% up its 7-day range (${px(range7d.low)}–${px(range7d.high)})`)
  }
  if (range7d.freshBreak) facts.push(`the last 24h took out the prior 6-day high ${px(range7d.priorHigh)}`)

  // ── room from ATH (0–10) ─────────────────────────────────────────────────
  parts.push({
    key: 'room', max: 10, points: step(drawdownFromAthPct, ROOM),
    label: drawdownFromAthPct == null ? 'no ATH reference' : `${Math.round(drawdownFromAthPct)}% below the all-time high`,
  })
  if (drawdownFromAthPct != null) {
    const age = athAgeDays(row?.athDate, now)
    facts.push(`${Math.round(drawdownFromAthPct)}% below the all-time high ${px(row?.ath)}${age == null ? '' : ` set ${age} days ago`}`)
  }

  // ── penalties ────────────────────────────────────────────────────────────
  const parabolic = (chg24h != null && chg24h > PARABOLIC_24H) || (chg7d != null && chg7d > PARABOLIC_7D)
  const thinLiquidity = Number.isFinite(row?.vol24h) && row.vol24h < THIN_VOL_USD

  // The penalty can only ever take back points that exist, which is what keeps
  // parts[] summing to score without a clamp at the end.
  let budget = parts.reduce((s, p) => s + p.points, 0)

  if (parabolic) {
    const applied = -Math.min(budget, 25)
    budget += applied
    parts.push({ key: 'parabolic', max: 0, points: applied, label: 'parabolic — already gone' })
    facts.push(chg24h != null && chg24h > PARABOLIC_24H
      ? `PARABOLIC: ${pct(chg24h)} in 24h — this is a chase, not an entry`
      : `PARABOLIC: ${pct(chg7d)} in 7d — this is a chase, not an entry`)
  }
  if (thinLiquidity) {
    const applied = -Math.min(budget, 15)
    budget += applied
    parts.push({ key: 'thin', max: 0, points: applied, label: 'too thin to trade' })
    facts.push(`only ${usd(row.vol24h)} of 24h volume — you can get in but not out`)
  }

  const score = parts.reduce((s, p) => s + p.points, 0)

  // CoinGecko emits null for any window that predates the listing, so a missing
  // 30d return is the only honest "this has no history" tell a markets row
  // carries. It matters because every base-rate and structure read downstream
  // silently assumes a month of tape exists.
  const newListing = chg30d == null && chg7d != null

  const flags = { stablecoin: false, wrapper: false, parabolic, thinLiquidity, freshBreak: range7d.freshBreak, newListing }
  if (newListing) facts.push('no 30-day history — listed recently, treat every longer-window read as absent')

  const band = bandOf({ chg7d, chg30d, rsVsBtc7d, d24VsWeek, turnover, pos: range7d.pos, flags })
  if ((band === 'igniting' || band === 'waking') && (season?.phase === 'risk_off' || season?.phase === 'btc_only')) {
    facts.push(`this is lifting into a ${season.label} regime (${season.score}/100) — the setup is real, the tape is not helping it`)
  }

  return {
    ...base,
    score, band,
    tier, kind, parts, facts, flags,
    turnover, rsVsBtc7d, rsVsBtc30d, accel, drawdownFromAthPct, range7d,
  }
}

/**
 * The band is a STATE, not a score bucket — first match wins, in the order a
 * move actually happens, so it can be read without the number. It cannot
 * disagree with the score because the score's biggest blocks reward exactly the
 * configuration `igniting` describes and the penalty fires on exactly the
 * configuration `extended` describes.
 */
function bandOf({ chg7d, chg30d, rsVsBtc7d, d24VsWeek, turnover, pos, flags }) {
  if (flags.parabolic || (chg30d != null && chg30d > 150 && pos != null && pos >= 0.75)) return 'extended'
  // `chg7d <= 40` is the ceiling on ignition: a coin already up 60% this week
  // breaking to new highs is running, not lighting.
  if (flags.freshBreak && d24VsWeek != null && d24VsWeek >= 2 && rsVsBtc7d != null && rsVsBtc7d > 0 &&
      chg7d != null && chg7d <= 40) return 'igniting'
  if (chg7d != null && chg7d >= 15 && rsVsBtc7d != null && rsVsBtc7d > 0 && pos != null && pos >= 0.5) return 'running'
  if (d24VsWeek != null && d24VsWeek >= 0.5 && rsVsBtc7d != null && rsVsBtc7d >= 0 && (pos == null || pos >= 0.4)) return 'waking'
  if (chg7d != null && Math.abs(chg7d) <= 12 && turnover != null && turnover >= 0.005 && !flags.thinLiquidity) return 'basing'
  return 'dead'
}

/**
 * Screen the whole universe. Excluded rows (score null) are dropped, not sorted
 * to the bottom — the contract is that they never appear on the board at all.
 *
 * Ties break on turnover then market cap then symbol. Without a total order the
 * board reshuffles between two renders of identical data, which reads as live
 * movement and is the reason anyone stops trusting a screen.
 */
export function screenUniverse(universe, ctx = {}) {
  if (!Array.isArray(universe)) return []
  const out = []
  for (const row of universe) {
    if (!row || typeof row !== 'object') continue
    const s = screenCoin(row, ctx)
    if (s.score == null) continue
    out.push(s)
  }
  out.sort((a, b) =>
    b.score - a.score ||
    (b.turnover ?? -1) - (a.turnover ?? -1) ||
    (b.mcap ?? -1) - (a.mcap ?? -1) ||
    String(a.symbol).localeCompare(String(b.symbol)))
  return out
}

/* ══ local formatting — kept here so the lib stays pure and import-free ═════ */

function num(x) { return Number.isFinite(x) ? x : null }

function athAgeDays(athDate, now) {
  if (!Number.isFinite(now) || !athDate) return null
  const t = Date.parse(athDate)
  if (!Number.isFinite(t)) return null
  const days = Math.round((now - t) / 86_400_000)
  return days >= 0 ? days : null
}

function pct(x, d = 1) {
  if (!Number.isFinite(x)) return '—'
  return `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`
}

/** Percentage POINTS — a difference of two percentages is not a percentage. */
function pts(x, d = 1) {
  if (!Number.isFinite(x)) return '—'
  return `${x >= 0 ? '+' : ''}${x.toFixed(d)} pts`
}

function usd(x) {
  if (!Number.isFinite(x)) return '—'
  const a = Math.abs(x)
  if (a >= 1e12) return `$${(x / 1e12).toFixed(1)}T`
  if (a >= 1e9) return `$${(x / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `$${(x / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `$${Math.round(x / 1e3)}k`
  return `$${Math.round(x)}`
}

/**
 * Sub-dollar prices get significant digits, not two decimals. "$0.00" is not a
 * price, and the levels a user works from are read off exactly these strings.
 */
function px(x) {
  if (!Number.isFinite(x)) return '—'
  const a = Math.abs(x)
  if (a >= 1000) return `$${Math.round(x).toLocaleString('en-US')}`
  if (a >= 1) return `$${(Math.round(x * 100) / 100).toFixed(2)}`
  if (a === 0) return '$0'
  return `$${x.toPrecision(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`
}
