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
// THE 100 POINTS — parts[] always sums to `measured.earned`.
//
//   BREADTH 7d ..... 0–35   round(0.35 × % of the eligible top 100 beating BTC)
//   BREADTH 30d .... 0–25   round(0.25 × same over 30d)
//   DOMINANCE ...... 0–20   falling 20 · flat 10 · rising 0
//                           trend from domHistory ALONE, and only when ≥7 of
//                           its samples fall inside the last 30 days
//   ETH/BTC 7d ..... 0–5    5 when ETH gained on BTC over the window
//   ETH/BTC 30d .... 0–5    same, and a SEPARATE part — see below
//   FEAR & GREED ... 0–10   round(value ÷ 10), clamped 0–10
//
// So 63% breadth over 7d is 22 points, and you can check that with a phone
// calculator, which is the whole standard this file is held to.
//
// SIX PARTS WITH FIXED MAXES THAT SUM TO EXACTLY 100, ALWAYS. The two ETH/BTC
// windows are two parts rather than one part whose max shrinks. A shrinking max
// broke the only arithmetic anyone can check by eye: with one leg resolved the
// achievable total was 95, so `coverage` (which divides by 100) topped out at
// 0.95, the card's "every input was measured" line became unreachable, and its
// "the other N are in neither half of the fraction" claimed 30 dropped points
// when the one part it could name was worth 25. Two parts, two names, two fives
// — and `100 − of` is now always exactly the sum of the maxes of the parts that
// had no input, every one of which is named in the fact below.
//
// ─────────────────────────────────────────────────────────────────────────────
// AN UNMEASURED COMPONENT IS DROPPED FROM BOTH SIDES AND THE SCORE IS
// RENORMALISED — the same treatment sentiment.js gives a coin with no perp:
//
//     score = round(100 × Σ points of measured parts ÷ Σ max of measured parts)
//
// `measured: { earned, of }` ships both sums and `coverage` is `of ÷ 100`, so a
// reader can always see how much of the read was real. Every parts[] entry
// carries `measured: boolean`, and the measured ones still sum to `earned` by
// eye — which is the only way anyone ever checks this.
//
// This file used to score the three tilts at their MIDPOINT when their input was
// missing. On day one — no dominance history (the cron has never run), no ETH
// row, a failed fear & greed fetch — that put 20 points on the board that no
// fetched value produced, on a ladder whose boundaries are 22/40/55/72. It was
// defended as "no evidence either way", but a midpoint is not the absence of a
// claim: it is a number, it moves the score, and directive.js gates ENTER on the
// phase that score produces. Zero (screen.js's rule, and the right one there) is
// no better in the other direction — the absence of an ETH row is not evidence
// that alts are weak.
//
// ─────────────────────────────────────────────────────────────────────────────
// RENORMALISING IS AN EXTRAPOLATION, AND IT IS NOT ALLOWED TO NAME A REGIME.
//
// This is the correction the round before got wrong, so it is worth being exact
// about what was wrong with it. Renormalising assumes the gauges we could not
// read look like the ones we could. At the cold end that is harmless — 0%
// breadth renormalises to 0 either way. At the HOT end it manufactures
// confidence out of an absence: with breadth alone measured the arithmetic
// reduces to `100 × (0.35b + 0.25b) ÷ 60 = b`, so the score IS the breadth
// percentage, and 72% breadth read `alt_season` on day one while the same
// market with all five gauges fetched at neutral read `majors_rotating` (58).
// A THINNER read was scoring HOTTER, and directive.js gates ENTER on the phase.
//
// The guard written for it — refuse the phase under 50% coverage — never bound,
// because the day-one state leaves BOTH breadth windows measured: 35 + 25 = 60
// of 100, coverage 0.60, over the line. A phase was named on day one every time.
//
// SO THE READ IS A BAND, AND THE PHASE IS ONLY NAMED WHERE THE BAND CANNOT MOVE:
//
//     low  = earned                         every unread gauge at zero
//     high = earned + (100 − of)            every unread gauge at its max
//
// The fully measured read of the SAME market is inside [low, high] by
// construction — measuring a part can only add somewhere between 0 and its max —
// so when the whole band falls inside one rung of the ladder, the phase named
// here is EXACTLY the phase the complete read would have named, whatever the
// missing gauges turn out to say. When the band straddles a boundary, no phase
// is named: not the hot one (which would be permission we did not earn) and not
// the cold one either (which would be a veto we did not measure — the mirror of
// the same bug, and the reason this is not simply "score the unread parts at
// zero"). Day one is a 40-point band, which cannot fit inside any rung, so day
// one never names a regime — which is what the STARTER downgrade in
// directive.js was built for and never received.
//
// AND UNDER HALF THE POINTS THERE IS NO SCORE AT ALL. `score: null`, the same
// refusal this file already makes when breadth cannot be counted. A renormalised
// number off fewer than 50 of the 100 points is more extrapolation than
// measurement, and the number is the thing a reader sizes off: 7-day breadth
// alone at 100% used to render `100 / 100` with all ten pips lit under the label
// "Not enough measured". Since no single part is worth 50, no single input can
// ever publish a score. The breadth bars are measured and still render, the
// bounds are stated in `plain`, and the arithmetic is in the facts.
//
// FEAR & GREED IS MONOTONE, NOT CONTRARIAN, on purpose. This score measures
// whether risk appetite is present, not whether it is well-founded. The
// contrarian read lives in sentiment.js, and the late-cycle warning lives in the
// `euphoric` phase below — putting it here too would have greed both raise and
// lower the same number.
//
// PHASE IS A PURE FUNCTION OF THE SCORE (plus the euphoria overlay and the band
// gate above), so the label and the number can never disagree — the same rule
// window.js is built on. `score` lands inside [low, high] by construction, so
// where the band pins a rung, the published number is in that rung too. And a
// phase is never named without a number: a regime we would not print a score for
// is not a regime we will put a name on either.
//   risk_off <22 · btc_only <40 · btc_leads <55 · majors_rotating <72 ·
//   alt_season ≥72 · euphoric = alt_season AND the crowd is already all-in.
import { isExcluded } from './screen.js'

const MIN_DOM_SAMPLES = 7      // below this we say 'unknown' and mean it
const DOM_FLAT_PTS = 0.5       // rule of thumb: dominance moves ±0.5pp on noise
const DOM_WINDOW_DAYS = 30

// 35 + 25 + 20 + 5 + 5 + 10. Every part keeps a FIXED max whether or not its
// input arrived, so the six always sum to exactly this — which is what makes
// `coverage`, `100 − of` and the card's "what was dropped" line agree.
const MAX_POINTS = 100
// Under this many measured points the renormalisation is mostly extrapolation
// and no score is published. Half, and it is half of the whole ladder rather
// than of some other denominator: see the header.
const MIN_POINTS_FOR_SCORE = MAX_POINTS / 2

// What each part is called in the fact that names what went missing. The keys
// are the wire names; a user reads "the dominance trend", not "dominance".
const PART_NAMES = {
  breadth7: '7d breadth', breadth30: '30d breadth',
  dominance: 'the dominance trend', ethbtc7: 'ETH/BTC over 7d',
  ethbtc30: 'ETH/BTC over 30d', feargreed: 'fear & greed',
}

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
 * THREE REFUSALS, THREE DIFFERENT SENTENCES. All of them report `phase:
 * 'unknown'`, which directive.js treats as a downgrade rather than a veto, and
 * all of them state their own arithmetic — a refusal that does not say what it
 * refused is indistinguishable from a bug.
 *
 *   NO_READ  breadth could not be counted at all. No score, no bounds.
 *   THIN     fewer than half the points had an input. The bounds are reported
 *            and the number is not — see the header.
 *   SPAN     the number stands, but the unread points straddle a rung boundary,
 *            so naming either side would be a claim we cannot make.
 */
const THIN = (of, low, high) => ({
  id: 'unknown', label: 'Not enough measured',
  plain: `Under half of this read had an input — ${of} of its 100 points. Depending on the ${MAX_POINTS - of} that did not, the same market reads anywhere from ${low} to ${high} out of 100, so no score and no regime are published off it. The breadth bars below are the part that was measured.`,
})

const SPAN = (score, of, low, high, lowRung, highRung) => ({
  id: 'unknown', label: `${lowRung.label} to ${highRung.label}`,
  plain: `${score} out of 100 assumes the ${MAX_POINTS - of} points we could not read look like the ${of} we could. They could land the full read anywhere from ${low} to ${high} — ${lowRung.label} through ${highRung.label} — so the number stands and no regime is named off it.`,
})

const NO_READ = {
  id: 'unknown', label: 'No read',
  plain: 'Not enough of the market was fetched to judge whether anything is rotating.',
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
      score: null, phase: NO_READ.id, label: NO_READ.label, plain: NO_READ.plain,
      breadth, dominance, ethBtc, fearGreed: fg, parts: [],
      measured: { earned: 0, of: 0 }, coverage: 0, bounds: { low: null, high: null }, facts,
    }
  }

  const parts = []

  parts.push(part('breadth7', 35,
    breadth.beatBtc7dPct == null ? null : Math.round(0.35 * breadth.beatBtc7dPct),
    breadth.beatBtc7dPct == null ? 'no 7d breadth — not scored' : `${Math.round(breadth.beatBtc7dPct)}% of the top 100 beat BTC over 7d`))

  parts.push(part('breadth30', 25,
    breadth.beatBtc30dPct == null ? null : Math.round(0.25 * breadth.beatBtc30dPct),
    breadth.beatBtc30dPct == null ? 'no 30d breadth — not scored' : `${Math.round(breadth.beatBtc30dPct)}% beat BTC over 30d`))

  parts.push(part('dominance', 20,
    dominance.trend === 'unknown' ? null
      : dominance.trend === 'falling' ? 20 : dominance.trend === 'rising' ? 0 : 10,
    dominance.trend === 'unknown'
      ? `dominance trend unknown (${dominance.days} of ${MIN_DOM_SAMPLES} stored days needed) — not scored`
      : `BTC dominance ${dominance.trend}${dominance.changePctPts == null ? '' : ` (${signed(dominance.changePctPts, 2)} pts across ${dominance.spanDays}d, ${dominance.samples} samples)`}`))

  // ONE PART PER WINDOW. A coin listed last week has a 7d ETH/BTC leg and no 30d
  // one; scoring the leg we cannot see at anything at all — 0, or the 2.5 this
  // once used — is a claim about a month nobody measured. This shipped as one
  // part whose max shrank from 10 to 5, which fixed the claim and broke the
  // arithmetic around it: the achievable total became 95, so the "every input
  // was measured" line could never fire and the "N points dropped" line was
  // over by 5 with nothing to name it. Two parts of 5 keep the maxes summing to
  // 100 and give the missing leg a NAME in the same list as everything else.
  const ethLeg = (key, window, chg) => part(key, 5,
    Number.isFinite(chg) ? (chg > 0 ? 5 : 0) : null,
    Number.isFinite(chg)
      ? `ETH/BTC ${window} ${signed(chg)}%`
      : `ETH/BTC over ${window} unavailable — not scored`)
  parts.push(ethLeg('ethbtc7', '7d', ethBtc?.chg7dPct))
  parts.push(ethLeg('ethbtc30', '30d', ethBtc?.chg30dPct))

  parts.push(part('feargreed', 10,
    fg == null ? null : Math.max(0, Math.min(10, Math.round(fg.value / 10))),
    fg == null ? 'fear & greed unavailable — not scored' : `fear & greed ${fg.value} (${fg.label})`))

  // `of` is at least 25 here: the early return above guarantees that at least
  // one breadth window resolved, so there is never a divide by zero to guard.
  const scored = parts.filter((p) => p.measured)
  const earned = scored.reduce((s, x) => s + x.points, 0)
  const of = scored.reduce((s, x) => s + x.max, 0)
  const unread = MAX_POINTS - of
  const coverage = of / MAX_POINTS

  // THE BAND. `low` is this market with every unread gauge at zero, `high` with
  // every one of them at its max — so the fully measured read of the same market
  // is inside it, always. Both are point totals on the same 0–100 scale the
  // ladder's boundaries are written in, which is the only reason comparing them
  // to a rung means anything.
  const low = earned
  const high = earned + unread

  const publish = of >= MIN_POINTS_FOR_SCORE
  const score = publish ? Math.max(0, Math.min(100, Math.round((100 * earned) / of))) : null

  const missing = parts.filter((x) => !x.measured)
  if (missing.length > 0) {
    facts.push(
      `${earned} of the ${of} points on offer were earned${publish ? `, renormalised to ${score} out of 100` : ''}: ` +
      `${list(missing.map((x) => PART_NAMES[x.key]))} ${missing.length === 1 ? 'was' : 'were'} not measured, ` +
      `so nothing was scored for ${missing.length === 1 ? 'it' : 'them'} in either the numerator or the denominator — ` +
      'an input we could not read is not evidence about the market in either direction',
    )
  }

  // Euphoria is the ONE overlay on the score ladder, and it needs corroboration
  // from outside the score: a high score alone is alt season, which is a good
  // thing. Alt season with the crowd already maxed out is the late innings.
  const crowdMaxed = (fg != null && fg.value >= 80) || (breadth.beatBtc7dPct != null && breadth.beatBtc7dPct >= 85)
  const lowRung = rungAt(low)
  const highRung = rungAt(high)
  // Both ends in the same rung, and a number worth printing. Only then is the
  // phase this file names guaranteed to be the phase the complete read names.
  const pinned = publish && lowRung === highRung
  const ladder = pinned && lowRung.min >= EUPHORIC.min && crowdMaxed ? EUPHORIC : lowRung

  const p = !publish ? THIN(of, low, high)
    : !pinned ? SPAN(score, of, low, high, lowRung, highRung)
      : ladder

  if (unread > 0) {
    facts.push(pinned
      ? `the ${unread} unread point${unread === 1 ? '' : 's'} put the fully measured read of this same market between ${low} and ${high} out of 100 — ${ladder.label} at both ends, so the regime below holds whatever those gauges would have said`
      : `the ${unread} unread points put the fully measured read of this same market between ${low} and ${high} out of 100 — ${lowRung.label} at the bottom and ${highRung.label} at the top — so no regime is named: the hot end would be permission this read did not earn and the cold end a warning it did not measure`)
  }
  if (!publish) {
    facts.push(
      `only ${of} of the ${MAX_POINTS} points had an input (${Math.round(coverage * 100)}% coverage), which is under half — ` +
      'so the renormalised number is more extrapolation than measurement and is not published as the regime score. ' +
      'The breadth bars are measured and stand on their own',
    )
  }

  if (trending?.length) {
    facts.push(`trending right now: ${trending.slice(0, 3).map((t) => String(t?.symbol ?? '').toUpperCase()).filter(Boolean).join(', ')}`)
  }

  return {
    score, phase: p.id, label: p.label, plain: p.plain,
    breadth, dominance, ethBtc, fearGreed: fg, parts,
    measured: { earned, of }, coverage, bounds: { low, high }, facts,
  }
}

/** The rung a point total on the 0–100 scale falls in. Used on `low` and `high`
 *  as well as on the published score, so the three can never be read off three
 *  different ladders. */
function rungAt(points) {
  return PHASES.find((x) => points >= x.min)
}

/**
 * One row of the arithmetic. `measured` is derived from `points` rather than
 * passed in, so the flag the renormalisation turns on and the number it sums
 * can never disagree — the failure mode would be a part that says it was
 * measured and contributes nothing, which reads on screen as a real zero.
 *
 * An unmeasured part keeps its FULL nominal max (what it would have been worth)
 * for the "how this scores" table, and contributes nothing to either side of
 * the renormalisation.
 */
function part(key, max, points, label) {
  return { key, label, points, max, measured: points != null }
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
  // labels the result a 30-day move.
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
    return { pct, changePctPts: null, trend: 'unknown', days, samples: window.length, spanDays: spanDaysOf(window) }
  }

  const change = window[window.length - 1].btcDom - window[0].btcDom
  const trend = change < -DOM_FLAT_PTS ? 'falling' : change > DOM_FLAT_PTS ? 'rising' : 'flat'
  const spanDays = spanDaysOf(window)
  facts.push(
    `BTC dominance ${trend}: ${signed(change, 2)} points across ${spanDays == null ? `${window.length} stored samples` : `${spanDays} day${spanDays === 1 ? '' : 's'} (${window.length} stored sample${window.length === 1 ? '' : 's'})`}` +
    `${trend === 'falling' ? ' — capital is leaving BTC' : ''}`,
  )

  if (Number.isFinite(now) && Number.isFinite(newestMs)) {
    const ageDays = Math.floor((now - newestMs) / 86_400_000)
    if (ageDays >= 2) facts.push(`dominance history has not been written for ${ageDays} days — the cron may be down`)
  }

  // THREE DIFFERENT NUMBERS, THREE NAMES. `days` is how many days of history
  // exist in the file at all; `samples` is how many of them fall inside the
  // window; `spanDays` is the calendar distance the change was actually measured
  // across. This shipped as `windowDays: window.length` — a SAMPLE COUNT that
  // the card rendered as "-1.20pts / 9d". After a cron gap those nine samples
  // can be spread over twenty-seven days, so the card understated the age of the
  // move by two thirds; and the field was called `changePctPts30d` while
  // measuring whatever span the samples happened to cover. A count of readings
  // and a length of time are not interchangeable just because the cron usually
  // writes one a day.
  return { pct, changePctPts: change, trend, days, samples: window.length, spanDays }
}

/**
 * Calendar days between the first and last sample of the window — the span the
 * change was measured across. Null when either date is unparseable, because a
 * span nobody can compute must not silently become a sample count again.
 */
function spanDaysOf(window) {
  if (!Array.isArray(window) || window.length === 0) return null
  const first = Date.parse(`${window[0]?.d}T00:00:00Z`)
  const last = Date.parse(`${window[window.length - 1]?.d}T00:00:00Z`)
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null
  return Math.round((last - first) / 86_400_000)
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

/** "a, b and c" — the facts are read as sentences, and "a, b, c were not
 *  measured" reads as a list that has been truncated rather than one that ended. */
function list(xs) {
  if (xs.length <= 1) return xs.join('')
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}
