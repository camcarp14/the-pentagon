// THE ROTATION REGIME — is capital moving into alts at all, and for whom.
//
// Read before the board, because it changes what a good-looking coin is worth.
// A 90-score setup in a `risk_off` regime is a 90-score setup that is going to
// bleed with everything else; the same setup in `majors_rotating` is the trade.
//
// Pure. Imports only the exclusion vocabulary from screen.js, deliberately: the
// breadth count and the board MUST agree on what a coin is. Two copies of the
// stablecoin list drift, and the day they drift the breadth denominator quietly
// includes USDT while the board quietly excludes it, and nothing fails.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY BREADTH CARRIES 60 OF THE 100 POINTS
//
// Because it is the only rotation measure this app can compute from data it
// actually has. "Alt season index" services compare 90-day returns across a
// curated basket and charge for it; dominance HISTORY is not on CoinGecko's
// free tier at all (we accumulate our own, two hours at a time, from the cron).
// What we do have, every single scan, is 100 rows with 7d and 30d returns and
// BTC sitting among them. Counting how many of them beat BTC is the honest
// question — "is the median alt outperforming?" — answered with no estimation
// step anywhere in it.
//
// THE 100 POINTS — parts[] always sums to score.
//
//   BREADTH 7d ..... 0–35   round(0.35 × % of the eligible top 100 beating BTC)
//   BREADTH 30d .... 0–25   round(0.25 × same over 30d)
//   DOMINANCE ...... 0–20   falling 20 · flat 10 · rising 0        (midpoint 10)
//                           trend from domHistory ALONE, and only when ≥7 of
//                           its samples fall inside the last 30 days
//   ETH/BTC ........ 0–10   +5 per window ETH gains on BTC          (midpoint 5)
//   FEAR & GREED ... 0–10   round(value ÷ 10), clamped 0–10         (midpoint 5)
//
// So 63% breadth over 7d is 22 points, and you can check that with a phone
// calculator, which is the whole standard this file is held to.
//
// THE THREE TILTS SIT AT THEIR MIDPOINT WHEN THEIR INPUT IS MISSING, and the
// part label says so out loud. This is not the screener's rule (there, a missing
// input scores zero) and the difference is deliberate: `domHistory` is empty for
// the first seven days this product is ever deployed, and scoring that as
// "dominance is rising" would print `btc_only` at a market that is nothing of
// the kind. A midpoint here is "no evidence either way", which is true; a zero
// would be a claim, which would not be.
//
// FEAR & GREED IS MONOTONE, NOT CONTRARIAN, on purpose. This score measures
// whether risk appetite is present, not whether it is well-founded. The
// contrarian read lives in sentiment.js, and the late-cycle warning lives in the
// `euphoric` phase below — putting it here too would have greed both raise and
// lower the same number.
//
// PHASE IS A PURE FUNCTION OF THE SCORE (plus one euphoria overlay), so the
// label and the number can never disagree — the same rule window.js is built on.
//   risk_off <22 · btc_only <40 · btc_leads <55 · majors_rotating <72 ·
//   alt_season ≥72 · euphoric = alt_season AND the crowd is already all-in.
import { isExcluded } from './screen.js'

const MIN_DOM_SAMPLES = 7      // below this we say 'unknown' and mean it
const DOM_FLAT_PTS = 0.5       // rule of thumb: dominance moves ±0.5pp on noise
const DOM_WINDOW_DAYS = 30

const PHASES = [
  { min: 72, id: 'alt_season', label: 'Alt season', plain: 'Broad alt outperformance. This is the regime alt risk is actually paid in — and it is the shortest one.' },
  { min: 55, id: 'majors_rotating', label: 'Majors rotating', plain: 'Capital is leaving BTC for the large alts. This is where rotation starts; the small caps come later or not at all.' },
  { min: 40, id: 'btc_leads', label: 'BTC leads', plain: 'BTC sets the pace and a minority of alts keep up. Be selective and size small.' },
  { min: 22, id: 'btc_only', label: 'BTC only', plain: 'Money is in BTC and staying there. Alt exposure is a drag until dominance rolls over.' },
  { min: -Infinity, id: 'risk_off', label: 'Risk off', plain: 'Nothing is rotating. Alt risk is the worst-paid risk on the board right now.' },
]

const EUPHORIC = {
  id: 'euphoric', label: 'Euphoric', min: 72,
  plain: 'Everything is up and the crowd is all-in. Late-cycle: tighten stops and take profit — this is not where new positions get opened.',
}

/**
 * @param universe    AltRow[] from parseCoinGeckoMarkets (top 250; the top 100
 *                    by rank is what breadth is counted over)
 * @param btcRow      the BTC AltRow — the bar every return is measured against
 * @param ethRow      the ETH AltRow (optional)
 * @param global      { btcDominancePct, ethDominancePct, totalMcapUsd, ... }
 * @param fearGreed   { value, label, at } (optional)
 * @param trending    parseTrending() rows (optional — facts only)
 * @param domHistory  [{ d: 'YYYY-MM-DD', btcDom, ethDom, totalMcap }] accumulated
 *                    by the alt-watch cron. The ONLY source of dominance trend.
 * @param now         ms epoch (optional) — used to age the dominance history
 */
export function seasonRead({
  universe = null, btcRow = null, ethRow = null, global = null,
  fearGreed = null, trending = null, domHistory = null, now = null,
} = {}) {
  const facts = []
  const breadth = computeBreadth(universe, btcRow, facts)
  const dominance = computeDominance(domHistory, global, now, facts)
  const ethBtc = computeEthBtc(ethRow, btcRow, facts)
  const fg = normaliseFearGreed(fearGreed, facts)

  // No breadth means no read. Every other input on this page is a tilt around
  // breadth; on their own they describe the weather, not the rotation.
  if (breadth.beatBtc7dPct == null && breadth.beatBtc30dPct == null) {
    return {
      score: null, phase: 'unknown', label: 'No read',
      plain: 'Not enough of the market was fetched to judge whether anything is rotating.',
      breadth, dominance, ethBtc, fearGreed: fg, parts: [], facts,
    }
  }

  const parts = []

  parts.push({
    key: 'breadth7', max: 35,
    points: breadth.beatBtc7dPct == null ? 0 : Math.round(0.35 * breadth.beatBtc7dPct),
    label: breadth.beatBtc7dPct == null ? 'no 7d breadth' : `${Math.round(breadth.beatBtc7dPct)}% of the top 100 beat BTC over 7d`,
  })
  parts.push({
    key: 'breadth30', max: 25,
    points: breadth.beatBtc30dPct == null ? 0 : Math.round(0.25 * breadth.beatBtc30dPct),
    label: breadth.beatBtc30dPct == null ? 'no 30d breadth' : `${Math.round(breadth.beatBtc30dPct)}% beat BTC over 30d`,
  })
  parts.push({
    key: 'dominance', max: 20,
    points: dominance.trend === 'falling' ? 20 : dominance.trend === 'rising' ? 0 : 10,
    label: dominance.trend === 'unknown'
      ? `dominance trend unknown (${dominance.days} of ${MIN_DOM_SAMPLES} days needed) — scored at the midpoint`
      : `BTC dominance ${dominance.trend}${dominance.changePctPts30d == null ? '' : ` (${signed(dominance.changePctPts30d, 2)} pts / ${dominance.windowDays}d)`}`,
  })
  // Per WINDOW, not per read: a market where only the 7d leg resolved gets its
  // 5 points for that leg and the midpoint for the leg it cannot see.
  const ethWindow = (c) => (c == null ? 2.5 : c > 0 ? 5 : 0)
  parts.push({
    key: 'ethbtc', max: 10,
    points: ethBtc == null ? 5 : Math.round(ethWindow(ethBtc.chg7dPct) + ethWindow(ethBtc.chg30dPct)),
    label: ethBtc == null ? 'ETH/BTC unavailable — scored at the midpoint' : `ETH/BTC ${ethBtc.trend} (7d ${signed(ethBtc.chg7dPct)}%, 30d ${signed(ethBtc.chg30dPct)}%)`,
  })
  parts.push({
    key: 'feargreed', max: 10,
    points: fg == null ? 5 : Math.max(0, Math.min(10, Math.round(fg.value / 10))),
    label: fg == null ? 'fear & greed unavailable — scored at the midpoint' : `fear & greed ${fg.value} (${fg.label})`,
  })

  const score = Math.max(0, Math.min(100, parts.reduce((s, p) => s + p.points, 0)))

  // Euphoria is the ONE overlay on the score ladder, and it needs corroboration
  // from outside the score: a high score alone is alt season, which is a good
  // thing. Alt season with the crowd already maxed out is the late innings.
  const crowdMaxed = (fg != null && fg.value >= 80) || (breadth.beatBtc7dPct != null && breadth.beatBtc7dPct >= 85)
  const p = score >= EUPHORIC.min && crowdMaxed ? EUPHORIC : PHASES.find((x) => score >= x.min)

  if (trending?.length) {
    facts.push(`trending right now: ${trending.slice(0, 3).map((t) => String(t?.symbol ?? '').toUpperCase()).filter(Boolean).join(', ')}`)
  }

  return {
    score, phase: p.id, label: p.label, plain: p.plain,
    breadth, dominance, ethBtc, fearGreed: fg, parts, facts,
  }
}

/**
 * Share of the top-100 non-stable, non-BTC rows beating BTC over the same
 * window. Each window gets its own denominator: a coin with a 7d return but no
 * 30d return (a recent listing) is a real row that belongs in one count and not
 * the other, and folding both into one `n` understates 30d breadth by exactly
 * the number of new listings — which spikes in precisely the market where this
 * number matters most.
 */
function computeBreadth(universe, btcRow, facts) {
  const empty = { beatBtc7dPct: null, beatBtc30dPct: null, n: 0, n7: 0, n30: 0, excluded: 0 }
  if (!Array.isArray(universe) || universe.length === 0) {
    facts.push('no universe rows fetched — breadth cannot be counted')
    return empty
  }
  const btc7 = Number.isFinite(btcRow?.chg7d) ? btcRow.chg7d : null
  const btc30 = Number.isFinite(btcRow?.chg30d) ? btcRow.chg30d : null
  if (btc7 == null && btc30 == null) {
    facts.push('no BTC row in the universe — there is no bar to measure breadth against')
    return empty
  }

  // "Top 100" by rank when ranks are present, else the first 100 as delivered
  // (parseCoinGeckoMarkets preserves market_cap_desc order).
  const ranked = universe.filter((r) => r && Number.isFinite(r.rank))
  const top = (ranked.length >= 50 ? ranked.sort((a, b) => a.rank - b.rank) : universe.filter(Boolean)).slice(0, 100)

  let excluded = 0
  const eligible = []
  for (const r of top) {
    const sym = String(r?.symbol ?? '').toUpperCase()
    if (sym === 'BTC') continue
    if (isExcluded(r)) { excluded++; continue }
    eligible.push(r)
  }

  let beat7 = 0; let n7 = 0
  let beat30 = 0; let n30 = 0
  for (const r of eligible) {
    if (btc7 != null && Number.isFinite(r.chg7d)) { n7++; if (r.chg7d > btc7) beat7++ }
    if (btc30 != null && Number.isFinite(r.chg30d)) { n30++; if (r.chg30d > btc30) beat30++ }
  }

  const beatBtc7dPct = n7 > 0 ? (beat7 / n7) * 100 : null
  const beatBtc30dPct = n30 > 0 ? (beat30 / n30) * 100 : null

  if (beatBtc7dPct != null) facts.push(`${beat7} of ${n7} top-100 alts beat BTC over 7d (${Math.round(beatBtc7dPct)}%) — BTC did ${signed(btc7)}%`)
  else facts.push('no 7d breadth: no eligible row carried a 7d return')
  if (beatBtc30dPct != null) facts.push(`${beat30} of ${n30} beat BTC over 30d (${Math.round(beatBtc30dPct)}%) — BTC did ${signed(btc30)}%`)
  else facts.push('no 30d breadth: no eligible row carried a 30d return')
  if (excluded > 0) facts.push(`${excluded} stablecoin/wrapped row${excluded === 1 ? '' : 's'} excluded from the count`)

  return { beatBtc7dPct, beatBtc30dPct, n: eligible.length, n7, n30, excluded }
}

/**
 * Dominance trend, from `domHistory` and NOTHING ELSE.
 *
 * There is no dominance history on CoinGecko's free tier, so this series exists
 * only because the alt-watch cron appends one sample per calendar day. Which
 * means it is empty on day one and thin for a week, and the honest answer during
 * that week is 'unknown'. Inferring the trend from, say, `mcapChange24hPct`
 * versus BTC's 24h return would produce a number that looks identical to a
 * measured one and is not — and it is the kind of number nobody re-checks once
 * it is on screen.
 */
function computeDominance(domHistory, global, now, facts) {
  const live = Number.isFinite(global?.btcDominancePct) ? global.btcDominancePct : null
  const samples = Array.isArray(domHistory)
    ? domHistory.filter((s) => s && Number.isFinite(s.btcDom)).sort((a, b) => String(a.d).localeCompare(String(b.d)))
    : []
  const days = samples.length

  const pct = live != null ? live
    : days > 0 ? samples[days - 1].btcDom
    : null
  if (live != null) facts.push(`BTC dominance ${live.toFixed(1)}%`)
  else if (pct != null) facts.push(`BTC dominance ${pct.toFixed(1)}% (from stored history — the live global feed did not answer)`)
  else facts.push('BTC dominance unavailable')

  // The window is bounded by DATES, not by a sample count. Taking "the last 30
  // samples" is the same thing only while the cron has never missed a day: one
  // outage and `slice(-30)` reaches back to a sample from two months ago and
  // labels the result a 30-day move. The field is called changePctPts30d, so it
  // has to actually be thirty days.
  const newestMs = Date.parse(`${samples[days - 1]?.d}T00:00:00Z`)
  const window = Number.isFinite(newestMs)
    ? samples.filter((s) => {
      const t = Date.parse(`${s.d}T00:00:00Z`)
      return !Number.isFinite(t) || t > newestMs - DOM_WINDOW_DAYS * 86_400_000
    })
    : samples.slice(Math.max(0, days - DOM_WINDOW_DAYS))

  // The sample floor applies to the WINDOW, not the file. A history with 90
  // stored days and one sample in the last month is not a trend, and reading
  // two points a month apart as "flat" would be the worst of both.
  if (window.length < MIN_DOM_SAMPLES) {
    facts.push(days === window.length
      ? `${days} day${days === 1 ? '' : 's'} of dominance history stored — the trend needs ${MIN_DOM_SAMPLES} and stays unknown until then`
      : `only ${window.length} of ${days} stored dominance samples fall inside the last ${DOM_WINDOW_DAYS} days — the trend needs ${MIN_DOM_SAMPLES} recent ones and stays unknown`)
    return { pct, changePctPts30d: null, trend: 'unknown', days, windowDays: window.length }
  }

  const change = window[window.length - 1].btcDom - window[0].btcDom
  const trend = change < -DOM_FLAT_PTS ? 'falling' : change > DOM_FLAT_PTS ? 'rising' : 'flat'
  facts.push(`BTC dominance ${trend}: ${signed(change, 2)} points across ${window.length} stored day${window.length === 1 ? '' : 's'}${trend === 'falling' ? ' — capital is leaving BTC' : ''}`)

  if (Number.isFinite(now) && Number.isFinite(newestMs)) {
    const ageDays = Math.floor((now - newestMs) / 86_400_000)
    if (ageDays >= 2) facts.push(`dominance history has not been written for ${ageDays} days — the cron may be down`)
  }

  // `days` always means "how many days of history exist"; `windowDays` is how
  // many of them the change was measured across. Collapsing the two made the
  // part label claim a 30-day move on a 9-day file.
  return { pct, changePctPts30d: change, trend, days, windowDays: window.length }
}

/**
 * ETH/BTC as the PAIR's return, not the difference of two percentages.
 *
 * ETH +120% against BTC +60% is not "+60% on the pair" — it is +37.5%. The
 * subtraction is close enough to right at small numbers and badly wrong at
 * exactly the numbers that would make someone act on it.
 */
function computeEthBtc(ethRow, btcRow, facts) {
  const pair = (e, b) => {
    if (!Number.isFinite(e) || !Number.isFinite(b) || 1 + b / 100 <= 0) return null
    return ((1 + e / 100) / (1 + b / 100) - 1) * 100
  }
  const c7 = pair(ethRow?.chg7d, btcRow?.chg7d)
  const c30 = pair(ethRow?.chg30d, btcRow?.chg30d)
  if (c7 == null && c30 == null) {
    facts.push('ETH/BTC unavailable — no ETH row, or no comparable BTC return')
    return null
  }
  const lead = c7 ?? c30
  const trend = lead > 1 ? 'rising' : lead < -1 ? 'falling' : 'flat'
  if (c7 != null) facts.push(`ETH/BTC ${signed(c7)}% over 7d (ETH ${signed(ethRow.chg7d)}% vs BTC ${signed(btcRow.chg7d)}%)`)
  if (c30 != null) facts.push(`ETH/BTC ${signed(c30)}% over 30d`)
  // Nulls stay null. A missing leg reported as 0 would read as "ETH tracked BTC
  // exactly", which is a measurement, and this is the absence of one.
  return { chg7dPct: c7, chg30dPct: c30, trend }
}

function normaliseFearGreed(fearGreed, facts) {
  // alternative.me sends the index as a STRING ("39"), so this has to coerce —
  // but Number(null) is 0 and Number('') is 0, and a 0 here is "Extreme Fear",
  // the single most alarming reading on the scale. A feed that answered with a
  // null field would have printed maximum panic and taken 5 points off the
  // regime score for it. Reject the empty cases before coercing.
  const raw = fearGreed?.value
  if (raw == null || raw === '') {
    facts.push('fear & greed unavailable')
    return null
  }
  const v = Number(raw)
  if (!Number.isFinite(v)) {
    facts.push('fear & greed unavailable')
    return null
  }
  const value = Math.max(0, Math.min(100, v))
  const label = fearGreed?.label ?? bandLabel(value)
  facts.push(`fear & greed ${value} (${label})`)
  return { value, label, at: Number.isFinite(fearGreed?.at) ? fearGreed.at : null }
}

function bandLabel(v) {
  return v >= 75 ? 'Extreme Greed' : v >= 55 ? 'Greed' : v >= 45 ? 'Neutral' : v >= 25 ? 'Fear' : 'Extreme Fear'
}

function signed(x, d = 1) {
  if (!Number.isFinite(x)) return '—'
  return `${x >= 0 ? '+' : ''}${x.toFixed(d)}`
}
