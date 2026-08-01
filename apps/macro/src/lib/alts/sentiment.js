// THE CROWD READ — who is already in this trade, and whether that is a tailwind
// or a headwind for getting in now.
//
// The vibe is not the point. "Community sentiment" as a percentage is a poll of
// whoever bothered to click, and it moves AFTER price, not before it. What is
// tradeable is CROWDING: how much leverage is already stacked on one side, and —
// the one genuinely non-obvious reading in this file — the DIVERGENCE between
// where retail sits and where the biggest accounts sit. Retail 71% long while
// top traders are 46% long is a headwind no chart pattern repairs. The same
// chart with both sides flat and funding negative is the one worth taking.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE SCORE MEANS: HEAT, NOT QUALITY.
//
// 0 = nobody is looking and nobody is levered. 100 = the crowd is all-in. A high
// score is NOT a buy and a low score is NOT a sell — that translation is
// `contrarian`, and it depends on which direction the heat is coming from and on
// what price is doing underneath it. Keeping the two separate is deliberate: a
// single blended "sentiment score" would have to decide, silently, whether 90 is
// good or bad, and the honest answer is "it depends on the chart".
//
// THE 100 POINTS
//
//   ATTENTION ................................................. 55
//     trending rank on CoinGecko's search list                    20
//        #1 →20   ≤3 →16   ≤7 →12   ≤15 →7   on the list →5   not on it →0
//     reddit active-48h ÷ subscribers                             15
//        ≥5% →15  ≥2% →12  ≥1% →9   ≥0.4% →6  ≥0.15% →3  else 0
//     CoinGecko up-vote %                                         10
//        ≥90 →10  ≥75 →8   ≥60 →5   ≥40 →3   else 0
//     watchlist users                                             10
//        ≥500k →10  ≥150k →8  ≥50k →6  ≥15k →4  ≥3k →2  else 0
//
//   CROWDING .................................................. 45
//     funding, annualised at the 8h interval                      20
//        ≥100% →20  ≥50% →16  ≥25% →12  ≥11% →8  ≥0 →4  negative →0
//     open interest, 24h change in BASE UNITS                     10
//        ≥+25% →10  ≥+10% →8  ≥+3% →6  ≥−3% →4  ≥−15% →2  else 0
//     retail long % minus top-trader long %                       15
//        ≥+20pts →15  ≥+10 →12  ≥+3 →8  ≥−3 →5  ≥−10 →2  else 0
//
// EVERY SUB-READ DEGRADES ON ITS OWN, AND AN UNSCORED PART IS NOT A ZERO.
// A part with no input is emitted with `points: null` and dropped from BOTH the
// numerator and the denominator:
//
//     score = round(100 × Σ points of scored parts ÷ Σ max of scored parts)
//
// so a coin with no perp is scored out of 55 and still reads correctly as
// "ignored" or "hot". The alternative — a neutral 50 for the missing half —
// would quietly drag every no-perp coin toward the middle of the state ladder,
// which is exactly the small-cap where the attention read is the whole signal.
// `measured` reports the two sums so the UI can say "out of the 55 we could see".
//
// WHY FEAR & GREED IS AN INPUT BUT NOT A SCORED PART: it is market-wide, and
// season.js already scores it. The Alts tab renders the season card directly
// above this one, so scoring it twice would show the same reading moving two
// numbers on one screen. Here it only informs the `capitulating` overlay and a
// fact.
//
// Pure. No fetch, no DOM, no Date.now() — `now` (ms epoch) is passed in.

/* ── the ladders. First threshold met wins, exactly as screen.js reads. ────── */

const TREND = [[1, 20], [3, 16], [7, 12], [15, 7]]        // BY RANK: lower is hotter
const REDDIT = [[5, 15], [2, 12], [1, 9], [0.4, 6], [0.15, 3]]
const UPVOTE = [[90, 10], [75, 8], [60, 5], [40, 3]]
const WATCH = [[500_000, 10], [150_000, 8], [50_000, 6], [15_000, 4], [3_000, 2]]
const FUNDING = [[100, 20], [50, 16], [25, 12], [11, 8], [0, 4]]
const OI = [[25, 10], [10, 8], [3, 6], [-3, 4], [-15, 2]]
const DIVERGE = [[20, 15], [10, 12], [3, 8], [-3, 5], [-10, 2]]

// Binance funds perps every 8 hours: 3 payments a day, 1095 a year. The interval
// is ASSUMED, not fetched — premiumIndex carries the next funding time but not
// the last one, so the gap cannot be derived from one snapshot. Every fact that
// prints an annualised number says "at the 8h interval" for that reason.
const FUNDINGS_PER_YEAR = 3 * 365
// Binance's own default/neutral funding rate is 0.01% per 8h — that is where the
// ladder's 11% rung comes from, not from a round number.
const NEUTRAL_FUNDING_ANNUAL_PCT = 0.0001 * FUNDINGS_PER_YEAR * 100

// A subreddit below this is not a base to measure activity against: 8 active
// accounts out of 40 subscribers is 20%, which tops the ladder and means nothing.
const REDDIT_MIN_SUBS = 500
// openInterestHist is a DAILY series, so the newest sample is legitimately up to
// a day old. Three days is the point at which "the 24h change" is not a 24h
// change any more and gets dropped rather than relabelled.
const OI_MAX_AGE_SEC = 3 * 86_400
const FUNDING_MAX_AGE_MS = 8 * 3_600_000

// THE MEASUREMENT FLOOR ON THE TAILWIND CALL. 35 of the attention block's 55
// points — trending plus one substantial community gauge, or the community
// block without trending.
//
// The low-score tailwind rung says "nobody has noticed yet, which is the only
// order that pays". That is a claim about ABSENCE, and absence is the one thing
// a renormalised score cannot evidence on its own: a coin whose only measurable
// input is `trendingRank: null` scores 0 out of 20 and reads as the most ignored
// asset on the board, when all we established is that it is not one of seven
// coins on a search list — which is true of essentially every coin. Six absent
// inputs must not generate risk-INCREASING copy, and this rung is quoted
// verbatim into the directive's STALK and ENTER reasons.
//
// The floor is on the attention block specifically, not on the overall
// denominator, because the claim is about attention. The headwind rungs get no
// such floor and want none: they fire on measured extremes (funding at 100%/yr,
// a 20-point retail skew, #1 trending), and a floor there would suppress a
// warning we did in fact measure.
const TAILWIND_MIN_ATTENTION_POINTS = 35

/* ── state and level bands ─────────────────────────────────────────────────── */

const STATES = [
  { min: 80, id: 'euphoric' },
  { min: 62, id: 'hot' },
  { min: 42, id: 'warming' },
  { min: 22, id: 'noticed' },
  { min: -Infinity, id: 'ignored' },
]

/**
 * @param fearGreed     { value, label, at } — market-wide, from alternative.me
 * @param trendingRank  1-based rank on CoinGecko's trending list, or null when
 *                      the coin is NOT on a list we successfully fetched.
 *                      OMIT THE KEY ENTIRELY when the trending feed failed —
 *                      see the note in the body, it is load-bearing.
 * @param community     parseCoinGeckoCoin().community — every field null-safe
 * @param derivs        altDerivs() result, or null when there is no read
 * @param derivsStatus  WHY `derivs` is null, from the alt-coin payload:
 *                      'ok' | 'not_listed' | 'unavailable'. `derivs: null` on
 *                      its own is AMBIGUOUS and saying "this coin has no perp"
 *                      off it is a false claim — see readCrowding's header.
 *                      Anything unrecognised, including an absent key, is
 *                      treated as 'unavailable': the non-claiming answer.
 * @param derivsUnavailable  the reason, when status is 'unavailable'
 * @param screened      screenCoin() result — used for the price context that
 *                      turns heat into a direction, never for points
 * @param now           ms epoch, for ageing the derivative samples
 */
export function crowdRead(raw = {}) {
  // `= {}` only fires on undefined, and this is called straight out of a render
  // with whatever the API returned — including `null`, which destructures into a
  // TypeError and blanks the tab. Normalise before touching a field.
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const {
    fearGreed = null, community = null, derivs = null, screened = null, now = null,
    derivsStatus = null, derivsUnavailable = null,
  } = input

  // `null` and "absent" are DIFFERENT ANSWERS here and collapsing them is a real
  // bug: a null rank means we fetched the trending list and this coin is not on
  // it, which is a measurement worth 0 points. An absent key means the trending
  // feed failed, which is no measurement at all. Score the second as the first
  // and every coin on the board reads "nobody is looking" — the most bullish
  // possible attention reading — on the days CoinGecko rate-limits us.
  const trendingChecked = Object.prototype.hasOwnProperty.call(input, 'trendingRank') && input.trendingRank !== undefined
  const trendingRank = Number.isFinite(input.trendingRank) ? input.trendingRank : null

  const facts = []
  const parts = []
  const sym = String(screened?.symbol ?? '').toUpperCase() || 'this coin'

  const attention = readAttention({ trendingChecked, trendingRank, community, parts, facts, sym })

  // WHAT IS KNOWN ABOUT THE PERP, normalised once and published, so the card's
  // empty state and this file's facts cannot describe the same silence
  // differently. `derivs: null` is ambiguous on its own — see readCrowding —
  // and anything the caller did not establish is 'unavailable', never a claim.
  const perp = {
    status: derivs && typeof derivs === 'object' ? 'ok' : derivsStatus === 'not_listed' ? 'not_listed' : 'unavailable',
    reason: null,
  }
  if (perp.status === 'unavailable' && typeof derivsUnavailable === 'string' && derivsUnavailable.trim()) {
    perp.reason = derivsUnavailable.trim()
  }

  const crowding = readCrowding({ derivs, perp, now, parts, facts, sym })

  // Fear & greed: context and the capitulation overlay only (see the header).
  const fg = normaliseFearGreed(fearGreed)
  if (fg) facts.push(`market-wide fear & greed is ${fg.value} (${fg.label}) — that is the tape everyone here is trading, not this coin`)

  const scored = parts.filter((p) => p.points != null)
  const earned = scored.reduce((s, p) => s + p.points, 0)
  const available = scored.reduce((s, p) => s + p.max, 0)
  const score = available > 0 ? Math.round((100 * earned) / available) : null

  if (score == null) {
    facts.push(`no attention or positioning data for ${sym} — the crowd read is unavailable, not neutral`)
    return {
      score: null, state: 'unknown', contrarian: 'neutral',
      attention, crowding, perp, parts, facts,
      measured: { earned: 0, of: 0 },
      extremes: [],
    }
  }

  const state = stateOf(score, { crowding, fg, screened, facts })
  const { contrarian, extremes } = contrarianOf({ score, state, crowding, attention, trendingRank, screened, facts })

  return {
    score, state, contrarian,
    attention, crowding, perp, parts, facts,
    measured: { earned, of: available },
    extremes,
  }
}

/* ══ attention ══════════════════════════════════════════════════════════════ */

/**
 * How many people are looking. Useful mostly at the ENDS: rising from a low base
 * is the setup, and a top-of-the-list reading is a crowding warning. The middle
 * of this range says almost nothing, which is why it only carries 55 points and
 * why `contrarian` never fires on attention alone.
 */
function readAttention({ trendingChecked, trendingRank, community, parts, facts, sym }) {
  const c = community && typeof community === 'object' ? community : null

  // ── trending rank ────────────────────────────────────────────────────────
  if (!trendingChecked) {
    parts.push({ key: 'trending', max: 20, points: null, label: 'trending list unavailable — not scored' })
    facts.push("CoinGecko's trending list did not answer — we cannot say whether anyone is searching this")
  } else if (trendingRank == null) {
    parts.push({ key: 'trending', max: 20, points: 0, label: 'not on the trending list' })
    facts.push(`${sym} is not on CoinGecko's trending list — nobody is searching for it yet`)
  } else {
    parts.push({ key: 'trending', max: 20, points: step(trendingRank, TREND, 'low'), label: `#${trendingRank} on CoinGecko trending` })
    facts.push(`#${trendingRank} on CoinGecko's trending list${trendingRank <= 3 ? ' — this is already the crowd\'s coin today' : ''}`)
  }

  // ── reddit activity against its own subscriber base ──────────────────────
  // The RATIO, never the raw count. 4,000 active accounts is enormous for a
  // 20k-subscriber sub and a graveyard for a 3m-subscriber one, and the raw
  // number would rank every large old coin above every small new one — which is
  // the opposite of what "attention is arriving" means.
  let redditActivePct = null
  if (c && Number.isFinite(c.redditActive48h) && Number.isFinite(c.redditSubs) && c.redditSubs >= REDDIT_MIN_SUBS) {
    redditActivePct = (c.redditActive48h / c.redditSubs) * 100
    parts.push({ key: 'reddit', max: 15, points: step(redditActivePct, REDDIT), label: `${redditActivePct.toFixed(2)}% of the subreddit active in 48h` })
    facts.push(`${num(c.redditActive48h)} reddit accounts active in 48h against ${num(c.redditSubs)} subscribers (${redditActivePct.toFixed(2)}%)`)
  } else {
    const why = !c ? 'no community stats'
      : !Number.isFinite(c.redditSubs) ? 'no subreddit'
        : c.redditSubs < REDDIT_MIN_SUBS ? `subreddit too small to measure (${num(c.redditSubs)} subscribers)`
          : 'no 48h active count'
    parts.push({ key: 'reddit', max: 15, points: null, label: `reddit engagement not scored — ${why}` })
  }

  // ── CoinGecko up-vote % ──────────────────────────────────────────────────
  const upVotePct = c && Number.isFinite(c.sentimentUpPct) ? c.sentimentUpPct : null
  if (upVotePct != null) {
    parts.push({ key: 'upvote', max: 10, points: step(upVotePct, UPVOTE), label: `${Math.round(upVotePct)}% voting "good"` })
    // Said out loud because it is the weakest number on the page: self-selected,
    // unweighted, and with no timestamp on it anywhere in the payload.
    facts.push(`${Math.round(upVotePct)}% of CoinGecko voters call ${sym} good — a self-selected poll, not a measurement of flow`)
  } else {
    parts.push({ key: 'upvote', max: 10, points: null, label: 'no up-vote poll — not scored' })
  }

  // ── watchlist users ──────────────────────────────────────────────────────
  const watchlistUsers = c && Number.isFinite(c.watchlistUsers) ? c.watchlistUsers : null
  if (watchlistUsers != null) {
    parts.push({ key: 'watchlist', max: 10, points: step(watchlistUsers, WATCH), label: `${num(watchlistUsers)} watchlists` })
    // Rule of thumb, in those words: an absolute count is confounded with how
    // long the coin has been listed and how big it is. We have no per-cap
    // normaliser for it, so it is scored on authored tiers and labelled as such.
    facts.push(`on ${num(watchlistUsers)} CoinGecko watchlists (an absolute count — older and larger coins carry more of them by default, so this is a rule of thumb, not a rate)`)
  } else {
    parts.push({ key: 'watchlist', max: 10, points: null, label: 'no watchlist count — not scored' })
  }

  if (!c) facts.push(`no CoinGecko community stats for ${sym} — attention is read from the trending list alone`)

  const attParts = parts.filter((p) => ['trending', 'reddit', 'upvote', 'watchlist'].includes(p.key) && p.points != null)
  if (attParts.length === 0) return null
  const points = attParts.reduce((s, p) => s + p.points, 0)
  const max = attParts.reduce((s, p) => s + p.max, 0)
  const ratio = points / max
  return {
    trendingRank, redditActivePct, redditSubs: c?.redditSubs ?? null, redditActive48h: c?.redditActive48h ?? null,
    redditPosts48h: c?.redditPosts48h ?? null, upVotePct, watchlistUsers,
    twitterFollowers: c?.twitterFollowers ?? null, telegram: c?.telegram ?? null,
    points, max,
    level: ratio >= 0.7 ? 'extreme' : ratio >= 0.45 ? 'high' : ratio >= 0.2 ? 'moderate' : 'low',
  }
}

/* ══ crowding ═══════════════════════════════════════════════════════════════ */

/**
 * How much leverage is already on, and on which side. This is the half of the
 * file that is actually predictive, and it exists only where a perp is listed —
 * which is most majors, some mids and almost no micro caps.
 *
 * A NUMBER THIS FUNCTION REFUSED TO SCORE DOES NOT COME OUT OF IT.
 *
 * The staleness gates below used to suppress the POINTS and publish the value
 * anyway, which is the worst of both: the part said "funding snapshot is stale —
 * not scored" while `crowding.fundingAnnualPct` carried 131.4 straight into
 * `contrarianOf` (→ `contrarian: 'headwind'`, which directive.js reads to
 * downgrade ENTER to STARTER), into a directive guardrail quoting "funding is
 * 131%/yr", and onto the crowd card as a measured KV. Identical inputs with the
 * snapshot merely ABSENT read `neutral`. So a snapshot this file had explicitly
 * declined to score was changing the action, and a page was calling the same
 * number measurable and unmeasurable two sections apart.
 *
 * `scoredOrNull` is the single seam. Every value that reaches the returned
 * object goes through it, so refusing a part and publishing its number cannot
 * drift apart again: they are the same boolean. The reason still reaches the
 * reader — it is in the part's label, which the crowd card renders in "how this
 * scores", and in a fact, which it renders in "show the crowd read".
 */
function readCrowding({ derivs, perp: perpState, now, parts, facts, sym }) {
  if (!derivs || typeof derivs !== 'object') {
    // ── "NO PERP" AND "COULD NOT TELL" ARE DIFFERENT SENTENCES ──────────────
    //
    // Both arrive here as `derivs: null`, and this branch used to print the
    // first one for both. That is a POSITIVE FALSE CLAIM about the market —
    // the one failure mode this file's header says is worse than saying
    // nothing — and it was reachable on the ordinary case: `fapi.binance.com`
    // 451s from a datacentre IP, which status.mjs documents as the EXPECTED
    // result, and the crowd card then stated as a measured fact that SOL has
    // no futures market.
    //
    // alts.mjs already distinguishes them (`altDerivs` returns null only on a
    // 400 from fapi — Binance's "invalid symbol" — and throws on everything
    // else) and alt-coin.mjs publishes which one it was as `derivsStatus`.
    // This is where that distinction has to survive, because this is where the
    // sentence gets written.
    //
    // ANYTHING UNRECOGNISED IS 'unavailable', INCLUDING AN ABSENT KEY. A caller
    // who did not tell us has not established that the coin has no perp, and
    // defaulting to the claim is how the bug got here. The vaguer answer is
    // always true; the specific one is only sometimes true.
    const notListed = perpState?.status === 'not_listed'
    const why = perpState?.reason ?? null

    // The POINTS are identical either way, and deliberately so: unmeasured is
    // unmeasured, and neither case is a neutral 50. What changes is only what
    // the reader is told about WHY — the labels below are quoted verbatim by
    // playbook.js's checklist rows, so the two cards cannot drift apart.
    const label = notListed ? 'no listed perp' : 'no perp read this pass'
    parts.push({ key: 'funding', max: 20, points: null, label: `${label} — funding not scored` })
    parts.push({ key: 'oi', max: 10, points: null, label: `${label} — open interest not scored` })
    parts.push({ key: 'divergence', max: 15, points: null, label: `${label} — positioning not scored` })
    facts.push(notListed
      ? `${sym} has no listed Binance perp — there is no funding, open interest or positioning read for it, and none has been assumed`
      : `the Binance derivatives feed did not answer for ${sym}${why ? ` (${why})` : ''} — so funding, open interest and positioning are unmeasured, and whether ${sym} has a listed perpetual at all was NOT established either. Nothing is assumed from the silence, in either direction`)
    return null
  }

  const perp = String(derivs.symbol ?? '') || null

  // ── funding, annualised ──────────────────────────────────────────────────
  const rate = Number.isFinite(derivs.lastFundingRate) ? derivs.lastFundingRate : null
  const fundingAnnualPct = rate == null ? null : rate * FUNDINGS_PER_YEAR * 100
  const fundingStale = Number.isFinite(now) && Number.isFinite(derivs.nextFundingTime) &&
    now > derivs.nextFundingTime + FUNDING_MAX_AGE_MS
  if (fundingAnnualPct == null) {
    parts.push({ key: 'funding', max: 20, points: null, label: 'no funding rate — not scored' })
  } else if (fundingStale) {
    // A funding snapshot whose next payment is already more than an interval in
    // the past is a cached read of a delisted or halted pair. Scoring it puts a
    // week-old crowding number beside a live price.
    parts.push({ key: 'funding', max: 20, points: null, label: 'funding snapshot is stale — not scored' })
    facts.push(`the funding snapshot for ${perp} is stale (its next payment was due ${ago(now - derivs.nextFundingTime)} ago) — it is not scored, and it is not reported as a rate either: nothing downstream gets to treat it as a measurement`)
  } else {
    parts.push({
      key: 'funding', max: 20, points: step(fundingAnnualPct, FUNDING),
      label: `funding ${signed(fundingAnnualPct, 0)}%/yr`,
    })
    facts.push(fundingAnnualPct >= 0
      ? `funding ${signedPct(rate * 100, 4)} per 8h = ${signed(fundingAnnualPct, 0)}% annualised — longs are paying shorts to hold this${fundingAnnualPct >= NEUTRAL_FUNDING_ANNUAL_PCT * 4 ? ', well above the 11%/yr baseline' : ''}`
      : `funding ${signedPct(rate * 100, 4)} per 8h = ${signed(fundingAnnualPct, 0)}% annualised — SHORTS are paying longs, the crowd is leaning the other way`)
  }

  // ── open interest, 24h change ────────────────────────────────────────────
  //
  // In BASE UNITS, not USD. `oiValueUsd` moves with price: a coin up 20% on
  // completely unchanged positioning shows +20% USD open interest, which reads
  // as a wave of new leverage and is nothing of the kind. Contracts outstanding
  // is the number that answers "did more people just get on". The USD figure is
  // still reported, as the size of the pile.
  const oiSeries = Array.isArray(derivs.openInterest) ? derivs.openInterest.filter((r) => r && Number.isFinite(r.oi)) : []
  const oiLast = oiSeries.length ? oiSeries[oiSeries.length - 1] : null
  const oiPrev = oiSeries.length >= 2 ? oiSeries[oiSeries.length - 2] : null
  const oiStale = oiLast && Number.isFinite(now) && Number.isFinite(oiLast.t) && (now / 1000 - oiLast.t) > OI_MAX_AGE_SEC
  let oiChange24hPct = null
  if (oiLast && oiPrev && oiPrev.oi > 0) oiChange24hPct = ((oiLast.oi - oiPrev.oi) / oiPrev.oi) * 100
  if (oiChange24hPct == null) {
    parts.push({ key: 'oi', max: 10, points: null, label: oiSeries.length ? 'only one open-interest sample — no 24h change' : 'no open-interest history — not scored' })
  } else if (oiStale) {
    parts.push({ key: 'oi', max: 10, points: null, label: 'open-interest series is stale — not scored' })
    // The notional pile goes with it. The change is what the gate is about, but
    // the LEVEL comes off the same sample: printing "$250M outstanding" from a
    // ten-day-old series beside a live price is the same stale measurement one
    // field over.
    facts.push(`the newest open-interest sample for ${perp} is ${ago((now / 1000 - oiLast.t) * 1000)} old — too old to call a 24h change, so neither the change nor the notional outstanding is reported`)
  } else {
    parts.push({ key: 'oi', max: 10, points: step(oiChange24hPct, OI), label: `open interest ${signed(oiChange24hPct)}% in 24h` })
    facts.push(`open interest ${signed(oiChange24hPct)}% in 24h in contract terms${Number.isFinite(oiLast.oiValueUsd) ? ` (${usd(oiLast.oiValueUsd)} of notional outstanding)` : ''}`)
  }

  // ── retail vs top traders: THE read ──────────────────────────────────────
  const retailLongPct = lastLongPct(derivs.globalLongShort)
  const topLongPct = lastLongPct(derivs.topLongShort)
  const divergencePts = retailLongPct != null && topLongPct != null ? retailLongPct - topLongPct : null
  if (divergencePts == null) {
    const why = retailLongPct == null && topLongPct == null ? 'neither positioning series answered'
      : retailLongPct == null ? 'no retail account ratio' : 'no top-trader position ratio'
    parts.push({ key: 'divergence', max: 15, points: null, label: `positioning divergence not scored — ${why}` })
    // Half the pair is still worth saying out loud; it just cannot be a score.
    if (retailLongPct != null) facts.push(`retail accounts are ${retailLongPct.toFixed(0)}% long, but the top-trader series did not answer — no divergence read`)
    if (topLongPct != null) facts.push(`top traders are ${topLongPct.toFixed(0)}% long, but the retail series did not answer — no divergence read`)
  } else {
    parts.push({ key: 'divergence', max: 15, points: step(divergencePts, DIVERGE), label: `retail ${signed(divergencePts, 0)} pts vs top traders` })
    facts.push(divergencePts >= 3
      ? `retail is ${retailLongPct.toFixed(0)}% long while top traders are ${topLongPct.toFixed(0)}% long — a ${divergencePts.toFixed(0)}-point divergence, and the crowd is on the wrong side of it`
      : divergencePts <= -3
        ? `top traders are ${topLongPct.toFixed(0)}% long against retail's ${retailLongPct.toFixed(0)}% — the big accounts are ${Math.abs(divergencePts).toFixed(0)} points MORE long than the crowd`
        : `retail ${retailLongPct.toFixed(0)}% long, top traders ${topLongPct.toFixed(0)}% long — the two agree, no divergence to trade`)
  }

  if (Array.isArray(derivs.degraded) && derivs.degraded.length) {
    facts.push(`part of the ${perp} derivatives feed did not answer: ${derivs.degraded.join('; ')}`)
  }

  const crParts = parts.filter((p) => ['funding', 'oi', 'divergence'].includes(p.key) && p.points != null)
  if (crParts.length === 0) return null
  const points = crParts.reduce((s, p) => s + p.points, 0)
  const max = crParts.reduce((s, p) => s + p.max, 0)
  const ratio = points / max

  /** A value leaves this function only if its own part was scored. One boolean
   *  for the points and the number, so they cannot disagree again. */
  const scoredOrNull = (key, value) => {
    const p = parts.find((x) => x.key === key)
    return p && p.points != null && Number.isFinite(value) ? value : null
  }
  return {
    perp,
    fundingRatePer8h: scoredOrNull('funding', rate),
    fundingAnnualPct: scoredOrNull('funding', fundingAnnualPct),
    oiChange24hPct: scoredOrNull('oi', oiChange24hPct),
    // The notional pile is context rather than a scored part, so it is gated on
    // the one thing that actually makes it false — AGE. A series with a single
    // fresh sample cannot produce a 24h change and its level is still true; a
    // ten-day-old series is stale in both.
    oiLatestUsd: !oiStale && Number.isFinite(oiLast?.oiValueUsd) ? oiLast.oiValueUsd : null,
    // Not a measurement of the market — a count of what the feed returned — so
    // it is reported whatever the gates did with the values inside it.
    oiSamples: oiSeries.length,
    retailLongPct, topLongPct, divergencePts,
    points, max,
    level: ratio >= 0.7 ? 'crowded' : ratio >= 0.45 ? 'building' : ratio >= 0.2 ? 'light' : 'clean',
  }
}

/* ══ state and the contrarian call ══════════════════════════════════════════ */

/**
 * The state is a pure function of the score, with ONE overlay — the same shape
 * season.js uses for `euphoric`, and for the same reason: a label that can
 * disagree with its own number is a label nobody trusts twice.
 *
 * `capitulating` is the overlay because it is not a heat LEVEL. It is cold heat
 * with a specific cause: price has been beaten down and the leverage/greed
 * gauges have followed it. Cold-and-quiet and cold-and-bleeding are the same
 * score and completely different trades.
 */
function stateOf(score, { crowding, fg, screened, facts }) {
  const bleeding = Number.isFinite(screened?.chg7d) && screened.chg7d <= -15
  const shortsPaid = Number.isFinite(crowding?.fundingAnnualPct) && crowding.fundingAnnualPct < 0
  const extremeFear = fg != null && fg.value <= 25
  if (score < 35 && bleeding && (shortsPaid || extremeFear)) {
    facts.push(`down ${screened.chg7d.toFixed(1)}% on the week with ${shortsPaid ? 'negative funding' : `fear & greed at ${fg.value}`} — this is capitulation, not accumulation; it is where bases start and also where knives land`)
    return 'capitulating'
  }
  return STATES.find((s) => score >= s.min).id
}

/**
 * The tradeable translation, as a ladder — headwind rungs first, because this
 * is the same safety-outranks-opportunity discipline advice.js runs on. A
 * headwind here does not veto a trade; it is what the directive reads to demand
 * a smaller size or refuse a chase.
 *
 * ON "ATTENTION RISING FROM A LOW BASE": we have no attention TIME SERIES. The
 * community payload is a single snapshot with no timestamp, and CoinGecko
 * publishes no history for it. So the rise is inferred from the only evidence we
 * actually hold — price is already doing something (a quiet/warming/starting
 * band with non-negative relative strength) while the crowd gauges are still
 * cold. That is the tradeable version of the same idea, and it is stated here
 * rather than dressed up as a measured trend.
 */
function contrarianOf({ score, state, crowding, attention, trendingRank, screened, facts }) {
  const extremes = []
  if (Number.isFinite(crowding?.fundingAnnualPct) && crowding.fundingAnnualPct >= 100) {
    extremes.push(`funding at ${Math.round(crowding.fundingAnnualPct)}%/yr`)
  }
  if (Number.isFinite(crowding?.divergencePts) && crowding.divergencePts >= 20) {
    extremes.push(`retail ${Math.round(crowding.divergencePts)} points longer than the top traders`)
  }
  if (trendingRank === 1) extremes.push('#1 on the trending list')
  if (state === 'euphoric') extremes.push(`crowd score ${score}/100`)

  // Two extremes is a headwind on its own; one is a headwind once the overall
  // heat is already hot. A single extreme on a cold coin is a curiosity — a
  // funding spike on something nobody is watching mean-reverts by itself.
  if (extremes.length >= 2 || (extremes.length === 1 && score >= 62)) {
    facts.push(`HEADWIND: ${extremes.join(' + ')} — the crowd is already positioned, so you would be buying their exit liquidity no matter how the chart looks`)
    return { contrarian: 'headwind', extremes }
  }

  const band = screened?.band ?? null
  const earlyBand = band === 'quiet' || band === 'warming' || band === 'starting'
  const rsOk = !Number.isFinite(screened?.rsVsBtc7d) || screened.rsVsBtc7d >= 0

  if (score <= 35 && earlyBand && rsOk) {
    // The floor documented at the top of the file. A cold score off one gauge is
    // not evidence that the crowd has not arrived; it is evidence that we only
    // asked one question.
    const attentionMeasured = Number.isFinite(attention?.max) ? attention.max : 0
    if (attentionMeasured < TAILWIND_MIN_ATTENTION_POINTS) {
      facts.push(
        `crowd score ${score} rests on ${attentionMeasured} of the ${TAILWIND_MIN_ATTENTION_POINTS} attention points this call needs — ` +
        'a low score off that little is "we barely looked", not "nobody is looking", so no tailwind is called from it',
      )
      return { contrarian: 'neutral', extremes }
    }
    facts.push(`TAILWIND: crowd score ${score}/100 measured across ${attentionMeasured} points of attention while the chart is ${band} — price is moving before the attention is, which is the only order that pays`)
    return { contrarian: 'tailwind', extremes }
  }
  if (Number.isFinite(crowding?.fundingAnnualPct) && crowding.fundingAnnualPct < 0 && band === 'quiet') {
    facts.push(`TAILWIND: shorts are paying ${Math.abs(Math.round(crowding.fundingAnnualPct))}%/yr while price bases — the leverage is leaning the wrong way into a flat chart`)
    return { contrarian: 'tailwind', extremes }
  }

  return { contrarian: 'neutral', extremes }
}

/* ══ local helpers — kept here so the lib stays pure and import-free ════════ */

/**
 * First threshold met wins. `dir` is 'high' by default (bigger value → bigger
 * points); 'low' inverts it for rank-style inputs where #1 is the hot end.
 */
function step(value, table, dir = 'high') {
  if (!Number.isFinite(value)) return 0
  for (const [threshold, points] of table) {
    if (dir === 'low' ? value <= threshold : value >= threshold) return points
  }
  // The rank ladder has a floor of 5 for "on the list at all" — every listed
  // rank is attention, even a long one.
  return dir === 'low' ? 5 : 0
}

/** Newest long % from a Binance long/short series, or null. */
function lastLongPct(series) {
  if (!Array.isArray(series)) return null
  for (let i = series.length - 1; i >= 0; i--) {
    if (Number.isFinite(series[i]?.longPct)) return series[i].longPct
  }
  return null
}

function normaliseFearGreed(fg) {
  // Same trap season.js documents: alternative.me sends "39" as a string, and
  // Number(null) is 0 — which is Extreme Fear, the loudest reading on the dial.
  const raw = fg?.value
  if (raw == null || raw === '') return null
  const v = Number(raw)
  if (!Number.isFinite(v)) return null
  const value = Math.max(0, Math.min(100, v))
  return { value, label: fg?.label ?? (value >= 75 ? 'Extreme Greed' : value >= 55 ? 'Greed' : value >= 45 ? 'Neutral' : value >= 25 ? 'Fear' : 'Extreme Fear') }
}

function signed(x, d = 1) {
  if (!Number.isFinite(x)) return '—'
  return `${x >= 0 ? '+' : ''}${x.toFixed(d)}`
}
function signedPct(x, d = 1) {
  if (!Number.isFinite(x)) return '—'
  return `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`
}
function num(x) {
  return Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—'
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
function ago(ms) {
  if (!Number.isFinite(ms)) return '—'
  const h = ms / 3_600_000
  if (h < 48) return `${Math.round(h)}h`
  return `${Math.round(h / 24)}d`
}
