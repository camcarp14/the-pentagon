// PRECEDENT — what this coin's own tape did the last few times it looked like
// this. It is the only read on the tab that answers the question as it was
// actually asked ("how have alts performed when they just start popping, and
// what were the early signals?") rather than describing today.
//
// It answers it by COUNTING over candles we fetched, not by asserting a
// remembered statistic. Every number below is a median, a minimum or a hit rate
// over a named, listable set of prior ignitions in ONE coin's history. Nothing
// here generalises to "altcoins" as a class and the copy never claims it does:
// a base rate over SOL's own six ignitions is a statement about SOL.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FINGERPRINT IS TAKEN AT igniteIdx − 1, AND THAT IS THE WHOLE IDEA.
//
// Fingerprinting the ignition bar itself would describe liftoff: a wide-range
// bar on 5× volume closing at a 20-day high. Today, by construction, does not
// look like that — if it did, the move would already be underway and there would
// be nothing left to anticipate. The day BEFORE liftoff is the only day today
// can honestly be compared against, so that is the day the archetype is built
// from. Every dimension in the fingerprint is a pre-move dimension for the same
// reason: compression, a rising volume baseline, distance from the moving
// averages, how long since the last high. None of them require the move.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY EPISODES MUST BE minGapBars APART
//
// A 60% run takes ten to twenty bars, and on most of those bars price closes
// above its own prior 20-day high with 60% of the run still ahead of it. Without
// a gap rule ONE move registers as ten episodes: the sample size on screen reads
// "10 prior ignitions", and the base rates are ten correlated draws from a
// single event wearing the clothes of ten independent ones. The gap is what
// makes `episodes: 4` mean four different moves. The test file demonstrates the
// failure directly — the same fixture returns 4 episodes at the default gap and
// 40 at minGapBars: 1, with base rates that disagree.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE REFUSES TO DO
//
// A base rate computed from two episodes is a lie with a decimal point in it. So
// under 250 candles, under 3 episodes, or close-only candles — where ATR,
// Bollinger bandwidth and volume-against-range are ALL meaningless because every
// bar is a flat line at the close — the read returns ok:false with a reason
// naming the exact shortfall, and the UI shows the refusal instead of a number.
// That is the product working, not the product failing.
//
// SURVIVORSHIP IS THE ENEMY. A median forward return with no drawdown beside it
// is a highlight reel: it is the number you get by forgetting that four of the
// five episodes traded 25% against you first, and that one of them never came
// back. So EVERY horizon carries a worst case — `worstFwd7`, `worstFwd21`,
// `worstFwd60` — plus `medianMaxDDPct`, the facts put the worst case in the SAME
// SENTENCE as the median, and `matched` returns every episode rather than the
// flattering three. A median that ships without its worst case is a median the
// UI has no honest way to render, whichever horizon it belongs to.
//
// AND THE DRAWDOWN IS MEASURED FROM THE ENTRY, NOT FROM THE IGNITION BAR'S HIGH.
// See findEpisodes: the scan is seeded at the ignition CLOSE and starts on the
// following bar, because that is the first bar a position could have been open
// for. Charging an episode the ignition bar's own high-to-low range prints pain
// that predates the trade.
//
// AND THE SELECTION IS CIRCULAR, WHICH THE READ SAYS OUT LOUD. An episode is
// DEFINED as a bar that went on to gain minRunPct within `window` days, so any
// forward return measured inside that window — fwd7 and fwd21 at the defaults —
// is conditioned on the run having happened. Those numbers describe the SHAPE of
// this coin's runs; they are not the odds of getting one. fwd60 is the only
// horizon that extends past the selection window and is therefore the only one
// that can disappoint on its own terms. A fact states this in the read, because
// a reader who does not know it will take "median +34% in 21 days" for a
// forecast, and nothing else on the screen would stop them.
import { ema, sma, atr, swings, highestHigh } from '../ta.js'

const MIN_CANDLES = 250        // contract floor: below this there is no base rate
const MIN_EPISODES = 3         // ...and below this there is no sample
const BREAK_LOOKBACK = 20      // the same 20-bar high signals.js/screen.js break on
const ATR_PERIOD = 14
const BB_PERIOD = 20
const PCTILE_LOOKBACK = 180    // "multi-month" — roughly six months of daily bars
const MIN_PCTILE_SAMPLES = 60  // a percentile over 20 readings is a rank, not a percentile
const FLAT_BAR_SHARE = 0.95    // ≥95% of recent bars with h === l ⇒ close-only, whatever the label says

/* ── the similarity metric, stated once, in full ─────────────────────────────
 *
 * matchPct is a DISTANCE mapped to 0-100. It is not a probability, it is not a
 * confidence, and nothing downstream may treat it as one — the facts say so out
 * loud for the same reason.
 *
 * Both today's fingerprint and the archetype are z-scored against the mean and
 * standard deviation of the EPISODE fingerprints, dimension by dimension, so
 * "far" means far relative to how much this coin's own pre-ignition days
 * actually vary. Then:
 *
 *     d_j = (today_j − archetype_j) / sd_j          per dimension, in SDs
 *     D   = sqrt( mean over used j of d_j² )        RMS distance, in SDs
 *     matchPct = clamp(round(100 × (1 − D / 3)), 0, 100)
 *
 * So 0 SD → 100, 1.5 SD → 50, 3 SD or worse → 0. The 3-SD floor is a CHOICE,
 * not a measurement, and it is written here rather than buried so that nobody
 * reads "40%" as "40% of the time this works".
 *
 * The z-scoring is algebraically invisible in the code because the mean cancels
 * in a difference: (a−μ)/σ − (b−μ)/σ = (a−b)/σ. The code divides raw differences
 * by the episode SD, which is the same number with one fewer step.
 *
 * D is a MEAN of squares, not a sum, so a dimension that is missing on one side
 * drops out without making the match look better. Summing instead would reward a
 * coin for having less history — the exact wrong incentive.
 *
 * A dimension is used only when at least MIN_EPISODES episodes carry it and its
 * SD across them is non-zero. A constant dimension carries no information and
 * dividing by its zero SD would produce Infinity, which maps to a match of 0 for
 * an exact agreement.
 *
 * Each per-dimension z is CLAMPED to ±3 before it is squared. With three to six
 * episodes the SD of any single dimension is itself a noisy estimate off a
 * handful of numbers, and unclamped, one dimension that happened to be nearly
 * identical across those episodes produces a z of 12 and drives the whole match
 * to zero on its own. The clamp says the sample cannot support that much
 * precision. It is a bound on confidence, not a fudge toward a nicer number —
 * it can only ever raise a match that a four-sample standard deviation had
 * already crushed.
 */
const MATCH_DIMS = [
  'atrPctile', 'bandwidthPctile',
  'volRatio20', 'volTrend',
  'distEma20Pct', 'distEma50Pct', 'distEma200Pct',
  'daysSinceHigh', 'drawdownPct', 'higherLows',
]
const MATCH_FLOOR_SD = 3

const EMPTY_FINGERPRINT = {
  idx: null, date: null,
  atrPct: null, atrPctile: null, bandwidthPct: null, bandwidthPctile: null,
  volRatio20: null, volTrend: null,
  distEma20Pct: null, distEma50Pct: null, distEma200Pct: null,
  higherLows: null, daysSinceHigh: null, drawdownPct: null,
  ok: false,
}

/* ══ fingerprint ═══════════════════════════════════════════════════════════ */

/**
 * The shape of one day, in the dimensions that exist BEFORE a move.
 *
 * `ok` requires the compression, volume and near-term trend readings — the ones
 * a coil is actually made of. It deliberately does NOT require distEma200Pct or
 * the percentiles: EMA200 needs 200 bars, and on a 250-bar file that would
 * disqualify every ignition in the first eight months of history, which is most
 * of the sample. Those dimensions go null and simply drop out of the similarity
 * vector instead.
 */
export function fingerprint(candles, idx) {
  const bars = cleanCandles(candles)
  return fingerprintAt(bars, derive(bars), idx)
}

function fingerprintAt(bars, d, idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= bars.length) return { ...EMPTY_FINGERPRINT }

  const close = bars[idx].c
  const atrPct = d.atrPct[idx]
  const bandwidthPct = d.bwPct[idx]
  const volRatio20 = ratio(bars[idx].v, meanTail(d.vols, idx, 20))
  const volTrend = ratio(meanTail(d.vols, idx, 20), meanTail(d.vols, idx, 60))
  const distEma20Pct = distPct(close, d.e20[idx])
  const distEma50Pct = distPct(close, d.e50[idx])
  const distEma200Pct = distPct(close, d.e200[idx])

  // Confirmed pivots only — swings() cannot confirm a low inside its own
  // strength window, so the last two bars never invent a higher low.
  const { lows } = swings(bars.slice(0, idx + 1), 2)
  const higherLows = lows.length >= 2 ? lows[lows.length - 1].price > lows[lows.length - 2].price : null

  const from = Math.max(0, idx - PCTILE_LOOKBACK + 1)
  let hi = -Infinity
  let hiIdx = idx
  for (let i = from; i <= idx; i++) if (bars[i].h > hi) { hi = bars[i].h; hiIdx = i }
  const daysSinceHigh = Number.isFinite(hi) ? idx - hiIdx : null
  const drawdownPct = Number.isFinite(hi) && hi > 0 ? Math.max(0, (1 - close / hi) * 100) : null

  const ok = [atrPct, bandwidthPct, volRatio20, distEma20Pct, distEma50Pct].every(Number.isFinite)

  return {
    idx,
    date: dayOf(bars[idx].t),
    atrPct,
    atrPctile: pctileRank(d.atrPct, idx),
    bandwidthPct,
    bandwidthPctile: pctileRank(d.bwPct, idx),
    volRatio20,
    volTrend,
    distEma20Pct,
    distEma50Pct,
    distEma200Pct,
    higherLows,
    daysSinceHigh,
    drawdownPct,
    ok,
  }
}

/* ══ episodes ══════════════════════════════════════════════════════════════ */

/**
 * Every prior ignition in this coin's history.
 *
 * IGNITION IS DEFINED ONCE, HERE, and it is screen.js's idea of a break plus a
 * forward outcome:
 *   1. the bar closes above the highest high of the PRIOR 20 bars (the bar
 *      itself excluded — the same comparison signals.js::breakout makes, so the
 *      board and the base rates cannot mean different things by "break");
 *   2. from that bar's CLOSE, the best close in the next `window` bars is at
 *      least `minRunPct` higher;
 *   3. it is the FIRST such bar within `minGapBars` of the previous episode.
 *
 * Rule 2 measures close-to-max-close, not close-to-max-high. An intrabar wick
 * you could not have sold is not a return, and a base rate built out of wicks
 * flatters every episode by the size of the coin's own volatility — which is
 * largest on exactly the small caps this tab exists to be careful about.
 *
 * A candidate needs the full `window` of bars after it to be measurable, so the
 * last `window` bars can never contain an episode. That is not a gap in the data,
 * it is the honest statement that we do not yet know how the current move ends.
 *
 * `igniteIdx`/`peakIdx` index the CLEANED series (bars without a finite close
 * are dropped — see cleanCandles). `igniteDate` is the stable identifier and the
 * one the UI should render.
 */
export function findEpisodes(candles, opts = {}) {
  const { minRunPct = 60, window = 30, minGapBars = 45 } = opts || {}
  const bars = cleanCandles(candles)
  const out = []
  if (bars.length < BREAK_LOOKBACK + window + 2) return out
  if (!Number.isFinite(minRunPct) || !Number.isFinite(window) || window < 1) return out

  const d = derive(bars)
  const gap = Number.isFinite(minGapBars) && minGapBars > 0 ? Math.floor(minGapBars) : 1
  const last = bars.length - 1
  let nextAllowed = BREAK_LOOKBACK

  for (let i = BREAK_LOOKBACK; i + window <= last; i++) {
    if (i < nextAllowed) continue
    const prevHigh = highestHigh(bars, BREAK_LOOKBACK, i - 1)
    if (prevHigh == null || !(bars[i].c > prevHigh)) continue

    let peakIdx = i
    let peakClose = bars[i].c
    for (let j = i + 1; j <= i + window; j++) {
      if (bars[j].c > peakClose) { peakClose = bars[j].c; peakIdx = j }
    }
    const runPct = (peakClose / bars[i].c - 1) * 100
    if (!(runPct >= minRunPct)) continue

    // Max ADVERSE excursion over the same window the run is measured across, so
    // the reward and the pain are on one clock. High-to-low, not close-to-close:
    // the drawdown that takes you out of the position is the one that trades,
    // not the one that closes.
    //
    // THE SCAN IS SEEDED FROM THE IGNITION CLOSE AND STARTS THE BAR AFTER, for
    // the same reason every forward return in this file is measured from that
    // close: it is the price a position would actually have been opened at.
    // Seeding from the ignition bar's own HIGH and measuring against its own LOW
    // charged every episode one bar of intrabar range that happened before the
    // entry existed. On a tape where nothing ever traded below the entry, a +25%
    // ignition bar that had dipped 8% intraday first still printed a 26.4%
    // drawdown — a number for pain nobody could have felt, on the one column
    // that exists to stop a median looking like a free ride.
    const end = Math.min(i + window, last)
    let peakHigh = bars[i].c
    let maxDD = 0
    for (let j = i + 1; j <= end; j++) {
      if (bars[j].h > peakHigh) peakHigh = bars[j].h
      if (peakHigh > 0) maxDD = Math.max(maxDD, ((peakHigh - bars[j].l) / peakHigh) * 100)
    }

    out.push({
      igniteIdx: i,
      igniteDate: dayOf(bars[i].t),
      peakIdx,
      peakDate: dayOf(bars[peakIdx].t),
      runPct,
      daysToPeak: peakIdx - i,
      maxDrawdownDuringPct: maxDD,
      fwd7: fwd(bars, i, 7),
      fwd21: fwd(bars, i, 21),
      fwd60: fwd(bars, i, 60),
      pre: fingerprintAt(bars, d, i - 1),
    })
    nextAllowed = i + gap
  }
  return out
}

/* ══ the read ══════════════════════════════════════════════════════════════ */

/**
 * @param candles  daily OHLCV, oldest→newest
 * @param quality  'ohlcv' | 'close-only' from the data layer. A missing label is
 *                 not trusted: flat bars are detected here as well.
 * @param now      ms epoch (optional) — only ever used to say how old the tape is
 */
export function precedentRead(candles, opts = {}) {
  const { quality = null, now = null, minRunPct = 60, window = 30, minGapBars = 45 } = opts || {}
  const bars = cleanCandles(candles)
  const dropped = (Array.isArray(candles) ? candles.length : 0) - bars.length
  const facts = []
  const today = bars.length > 0 ? fingerprint(bars, bars.length - 1) : { ...EMPTY_FINGERPRINT }

  const refuse = (reason, episodes = 0) => ({
    ok: false, reason,
    episodes,
    baseRates: null, matchPct: null, matched: [],
    today, archetype: null,
    facts: [reason, ...facts],
  })

  if (bars.length < MIN_CANDLES) {
    return refuse(
      `need ${MIN_CANDLES} daily candles to count base rates, have ${bars.length}` +
      (dropped > 0 ? ` (${dropped} bar${dropped === 1 ? '' : 's'} arrived without a close and were dropped)` : '') +
      ' — no precedent read until the history fills in',
    )
  }

  // The quality gate, belt and braces. `quality` comes from the fetcher, but a
  // caller that forgets to pass it must not get an ATR percentile computed off
  // 730 bars whose high, low and close are the same number: every reading in the
  // fingerprint would be a well-formed, precise, meaningless zero.
  if (quality === 'close-only' || looksCloseOnly(bars)) {
    return refuse(
      quality === 'close-only'
        ? 'candles are close-only (CoinGecko market_chart) — ATR, Bollinger bandwidth and volume-against-range are all meaningless on flat bars, so no precedent is computed. Base rates return when Binance klines are available for this symbol.'
        : `candles carry no high/low range (${Math.round(FLAT_BAR_SHARE * 100)}%+ of recent bars have high = low) — this is a close-only series whatever it was labelled, and every compression reading on it would be a meaningless zero`,
    )
  }

  const episodes = findEpisodes(bars, { minRunPct, window, minGapBars })

  if (episodes.length < MIN_EPISODES) {
    return refuse(
      `only ${episodes.length} prior ignition${episodes.length === 1 ? '' : 's'} in ${bars.length} days of candles ` +
      `(≥${minRunPct}% within ${window} days, episodes ${minGapBars}+ days apart) — ` +
      `${MIN_EPISODES} are needed before a base rate means anything. A median of ${episodes.length} is a number, not evidence.`,
      episodes.length,
    )
  }

  const baseRates = computeBaseRates(episodes)
  const stats = dimStats(episodes)
  const archetype = medianFingerprint(episodes)
  const matchDistance = distanceTo(today, archetype, stats)
  const matchPct = pctFromDistance(matchDistance)

  // Every episode, sorted by similarity — never the closest three. Showing only
  // the flattering subset is how a base rate becomes a highlight reel, and it is
  // the same failure the drawdown columns exist to prevent.
  const matched = episodes
    .map((e) => ({
      date: e.igniteDate,
      runPct: r1(e.runPct),
      daysToPeak: e.daysToPeak,
      similarity: pctFromDistance(distanceTo(today, e.pre, stats)),
      fwd21: r1(e.fwd21),
      maxDrawdownDuringPct: r1(e.maxDrawdownDuringPct),
    }))
    .sort((a, b) => (b.similarity ?? -1) - (a.similarity ?? -1))

  if (dropped > 0) facts.push(`${dropped} candle${dropped === 1 ? '' : 's'} arrived without a close and were dropped before anything was measured`)

  facts.push(
    `${episodes.length} prior ignitions in ${bars.length} days of candles — ` +
    `a close above the prior ${BREAK_LOOKBACK}-day high that went on to gain ${minRunPct}%+ within ${window} days, ` +
    `counted no closer together than ${minGapBars} days`,
  )

  if (baseRates.medianFwd21 != null) {
    facts.push(
      `21 days after those ignitions: median ${signed(baseRates.medianFwd21)}%, ` +
      `worst ${signed(baseRates.worstFwd21)}%, ` +
      `${baseRates.hitRate21 == null ? '—' : Math.round(baseRates.hitRate21)}% of them higher than the ignition close ` +
      `(${baseRates.nFwd21} of ${episodes.length} episodes have 21 days of tape after them)`,
    )
  }
  if (baseRates.medianFwd7 != null) facts.push(`7 days after: median ${signed(baseRates.medianFwd7)}%, worst ${signed(baseRates.worstFwd7)}% (${baseRates.nFwd7} episodes)`)
  if (baseRates.medianFwd60 != null) facts.push(`60 days after: median ${signed(baseRates.medianFwd60)}%, worst ${signed(baseRates.worstFwd60)}% (${baseRates.nFwd60} episodes)`)
  facts.push(
    `these episodes were SELECTED for gaining ${minRunPct}%+ within ${window} days, so the 7- and 21-day numbers ` +
    `are conditioned on the run happening — they describe the shape of this coin's runs, not the odds of getting one. ` +
    `Only the 60-day window reaches past the selection.`,
  )
  if (baseRates.medianMaxDDPct != null) {
    facts.push(
      `the median episode drew down ${r1(baseRates.medianMaxDDPct)}% from its own high during the run — ` +
      'the median return is not the experience of holding it',
    )
  }
  if (baseRates.bestRunPct != null) {
    facts.push(`best run ${signed(baseRates.bestRunPct)}% in ${window} days; median ${median(episodes.map((e) => e.daysToPeak))} days from ignition to the peak`)
  }

  if (matchPct == null) {
    facts.push('today cannot be scored against the archetype — too few of the fingerprint dimensions are measurable on both sides')
  } else {
    facts.push(
      `today matches the day-before-liftoff archetype ${matchPct}% ` +
      `(${stats.used.length} dimensions, RMS distance ${r2(matchDistance)} standard deviations) — ` +
      'this is a similarity score, not a probability',
    )
  }

  facts.push(...fingerprintFacts('today', today))
  if (archetype?.ok) facts.push(...fingerprintFacts('the archetype (median of the days before each ignition)', archetype))

  const ageDays = tapeAgeDays(bars, now)
  if (ageDays != null && ageDays >= 2) {
    facts.push(`the newest candle is ${ageDays} days old — this precedent read is describing stale tape`)
  }

  return {
    ok: true,
    reason: null,
    episodes: episodes.length,
    baseRates,
    matchPct,
    matched,
    today,
    archetype,
    facts,
  }
}

/* ══ base rates ════════════════════════════════════════════════════════════ */

/**
 * Each window gets its OWN denominator. An episode 10 days from the end of the
 * file has a real fwd7 and no fwd21, and folding both into one `n` would either
 * drop a good 7-day observation or count a missing 21-day one as flat. The
 * counts ship with the medians so the UI can print "5 of 6 episodes" beside
 * every number rather than implying they all rest on the same sample.
 */
function computeBaseRates(episodes) {
  const f7 = episodes.map((e) => e.fwd7).filter(Number.isFinite)
  const f21 = episodes.map((e) => e.fwd21).filter(Number.isFinite)
  const f60 = episodes.map((e) => e.fwd60).filter(Number.isFinite)
  const dds = episodes.map((e) => e.maxDrawdownDuringPct).filter(Number.isFinite)
  const runs = episodes.map((e) => e.runPct).filter(Number.isFinite)
  return {
    medianFwd7: r1(median(f7)),
    medianFwd21: r1(median(f21)),
    medianFwd60: r1(median(f60)),
    bestRunPct: runs.length ? r1(Math.max(...runs)) : null,
    // The worst case is a first-class field, not a footnote, and EVERY horizon
    // carries one. The rule this file states is "worstFwd21 is reported beside
    // the median everywhere the median is shown" — but only the 21-day worst
    // case existed, so the 7- and 60-day tiles shipped a bare median with no
    // drawdown beside it. A median with no worst case next to it is the
    // highlight reel this whole file is written against, and the horizon it
    // happens to be missing on is not a defence.
    worstFwd7: f7.length ? r1(Math.min(...f7)) : null,
    worstFwd21: f21.length ? r1(Math.min(...f21)) : null,
    worstFwd60: f60.length ? r1(Math.min(...f60)) : null,
    hitRate21: f21.length ? r1((f21.filter((x) => x > 0).length / f21.length) * 100) : null,
    medianMaxDDPct: r1(median(dds)),
    n: episodes.length,
    nFwd7: f7.length,
    nFwd21: f21.length,
    nFwd60: f60.length,
  }
}

/* ══ the archetype and the match ═══════════════════════════════════════════ */

/** Per-dimension mean/sd across the episode fingerprints; the units the match
 *  is measured in. Only fingerprints that came out ok are used — a half-computed
 *  pre-ignition day would widen the SD and make everything look similar. */
function dimStats(episodes) {
  const usable = episodes.map((e) => e.pre).filter((p) => p?.ok)
  const sd = {}
  const used = []
  for (const key of MATCH_DIMS) {
    const vals = usable.map((p) => dimValue(p, key)).filter(Number.isFinite)
    if (vals.length < MIN_EPISODES) continue
    const mean = vals.reduce((s, x) => s + x, 0) / vals.length
    const variance = vals.reduce((s, x) => s + (x - mean) ** 2, 0) / vals.length
    const s = Math.sqrt(variance)
    if (!(s > 1e-9)) continue // a constant dimension carries no information
    sd[key] = s
    used.push(key)
  }
  return { sd, used, n: usable.length }
}

/**
 * Element-wise median of the pre-ignition fingerprints.
 *
 * This is a COMPOSITE, not a real day: no single episode necessarily had all of
 * these readings at once. That is fine for a reference vector and it is why the
 * UI calls it "the archetype" rather than a date.
 */
function medianFingerprint(episodes) {
  const usable = episodes.map((e) => e.pre).filter((p) => p?.ok)
  if (usable.length === 0) return null
  const out = { ...EMPTY_FINGERPRINT, ok: true, idx: null, date: null }
  for (const key of Object.keys(EMPTY_FINGERPRINT)) {
    if (key === 'ok' || key === 'idx' || key === 'date') continue
    if (key === 'higherLows') {
      const votes = usable.map((p) => p.higherLows).filter((v) => typeof v === 'boolean')
      out.higherLows = votes.length === 0 ? null : votes.filter(Boolean).length * 2 >= votes.length
      continue
    }
    out[key] = median(usable.map((p) => p[key]).filter(Number.isFinite))
  }
  return out
}

/**
 * The metric documented at the top of the file, split in two so the RAW
 * DISTANCE is available to the caller. The facts quote both, because "62% match"
 * and "1.14 standard deviations away" are different claims and only the second
 * one is a measurement.
 *
 * These were one function returning the percentage and stashing the distance on
 * `stats` for the caller to read back. The `matched` loop then called it once
 * per episode, so by the time the fact was built the stashed distance belonged
 * to whichever episode sorted last — a number that looked exactly like the one
 * it was supposed to be and described something else entirely.
 */
function distanceTo(a, b, stats) {
  if (!a || !b || !stats?.used?.length) return null
  let sum = 0
  let k = 0
  for (const key of stats.used) {
    const av = dimValue(a, key)
    const bv = dimValue(b, key)
    if (!Number.isFinite(av) || !Number.isFinite(bv)) continue
    const z = clamp((av - bv) / stats.sd[key], -MATCH_FLOOR_SD, MATCH_FLOOR_SD)
    sum += z * z
    k++
  }
  if (k === 0) return null
  return Math.sqrt(sum / k)
}

function pctFromDistance(distance) {
  if (!Number.isFinite(distance)) return null
  return Math.max(0, Math.min(100, Math.round(100 * (1 - distance / MATCH_FLOOR_SD))))
}

function dimValue(fp, key) {
  if (key === 'higherLows') return typeof fp?.higherLows === 'boolean' ? (fp.higherLows ? 1 : 0) : null
  return Number.isFinite(fp?.[key]) ? fp[key] : null
}

/* ══ derived series ════════════════════════════════════════════════════════ */

/**
 * Bars without a finite close are dropped BEFORE anything indexes into the
 * series. ta.js's sma() carries a running sum, so a single NaN close from a feed
 * hiccup turns every subsequent average — and therefore every bandwidth, every
 * percentile and every EMA distance after it — into NaN. One bad bar would
 * silently void the back half of the file rather than producing an error.
 *
 * The high/low clamp is the same class of defence: some feeds emit a high below
 * the close on a partial bar, which makes the "did it close above the prior
 * 20-bar high" test compare against a level price already traded through.
 */
function cleanCandles(candles) {
  if (!Array.isArray(candles)) return []
  const out = []
  for (const c of candles) {
    if (!c || typeof c !== 'object') continue
    const close = Number(c.c)
    if (!Number.isFinite(close)) continue
    const h = Number.isFinite(c.h) ? Math.max(c.h, close) : close
    const l = Number.isFinite(c.l) ? Math.min(c.l, close) : close
    out.push({
      t: Number.isFinite(c.t) ? c.t : null,
      o: Number.isFinite(c.o) ? c.o : close,
      h, l, c: close,
      v: Number.isFinite(c.v) ? c.v : null,
    })
  }
  return out
}

function derive(bars) {
  const closes = bars.map((b) => b.c)
  const vols = bars.map((b) => b.v)
  const atrArr = atr(bars, ATR_PERIOD)
  const mid = sma(closes, BB_PERIOD)
  const atrPct = new Array(bars.length).fill(null)
  const bwPct = new Array(bars.length).fill(null)
  for (let i = 0; i < bars.length; i++) {
    if (atrArr[i] != null && closes[i] > 0) atrPct[i] = (atrArr[i] / closes[i]) * 100
    if (mid[i] != null && mid[i] > 0) {
      const sd = stdevTail(closes, i, BB_PERIOD)
      // Bollinger bandwidth = (upper − lower) / middle, and the bands are ±2σ,
      // so the width is 4σ over the mean. Expressed in percent of price it is
      // comparable across coins, which is the only reason it is here at all.
      if (sd != null) bwPct[i] = ((4 * sd) / mid[i]) * 100
    }
  }
  return { closes, vols, atrPct, bwPct, e20: ema(closes, 20), e50: ema(closes, 50), e200: ema(closes, 200) }
}

/**
 * Percentile RANK: the share of the lookback's own readings at or below this
 * one. 8 means only 8% of the last 180 days were quieter than today, which is
 * compression. Today counts itself, so the floor is 1/n rather than 0 — with a
 * 180-bar lookback that is 0.6 of a point and it keeps the reading honest about
 * being a rank within a finite sample.
 */
function pctileRank(series, idx) {
  if (!Array.isArray(series) || idx == null || idx < 0 || idx >= series.length) return null
  const v = series[idx]
  if (!Number.isFinite(v)) return null
  const from = Math.max(0, idx - PCTILE_LOOKBACK + 1)
  let n = 0
  let below = 0
  for (let i = from; i <= idx; i++) {
    if (!Number.isFinite(series[i])) continue
    n++
    if (series[i] <= v) below++
  }
  if (n < MIN_PCTILE_SAMPLES) return null
  return (below / n) * 100
}

/** Population stdev of the n values ending at endIdx. Null when the window runs
 *  off the front or carries a non-finite value — a partially-seeded stdev is
 *  worse than no stdev, because it looks like a small one. */
function stdevTail(arr, endIdx, n) {
  const from = endIdx - n + 1
  if (from < 0) return null
  let sum = 0
  for (let i = from; i <= endIdx; i++) {
    if (!Number.isFinite(arr[i])) return null
    sum += arr[i]
  }
  const mean = sum / n
  let acc = 0
  for (let i = from; i <= endIdx; i++) acc += (arr[i] - mean) ** 2
  return Math.sqrt(acc / n)
}

/** Mean of the n values ending at endIdx, tolerating holes down to 80% coverage.
 *  Volume is the field feeds drop most often, and refusing a 20-day average
 *  because one day is missing would delete the accumulation signal exactly when
 *  a thin coin is quietest. Below 80% it is not an average of what it claims. */
function meanTail(arr, endIdx, n) {
  const from = endIdx - n + 1
  if (from < 0) return null
  let sum = 0
  let k = 0
  for (let i = from; i <= endIdx; i++) {
    if (Number.isFinite(arr[i])) { sum += arr[i]; k++ }
  }
  if (k < Math.ceil(n * 0.8)) return null
  return sum / k
}

/** ≥95% of the recent bars with high === low is a close-only series, whatever
 *  the fetcher labelled it. */
function looksCloseOnly(bars) {
  const n = Math.min(120, bars.length)
  if (n < 20) return false
  let flat = 0
  for (let i = bars.length - n; i < bars.length; i++) if (bars[i].h === bars[i].l) flat++
  return flat / n >= FLAT_BAR_SHARE
}

/* ══ small helpers ═════════════════════════════════════════════════════════ */

/** Forward return from the ignition CLOSE. Every forward number in this file is
 *  measured from that one price, so fwd7/fwd21/fwd60 are comparable to each
 *  other and to runPct. */
function fwd(bars, i, n) {
  const j = i + n
  if (j >= bars.length) return null
  const base = bars[i].c
  if (!(base > 0)) return null
  return (bars[j].c / base - 1) * 100
}

function ratio(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !(b > 0)) return null
  return a / b
}

function distPct(close, ref) {
  if (!Number.isFinite(close) || !Number.isFinite(ref) || !(ref > 0)) return null
  return (close / ref - 1) * 100
}

function median(values) {
  const v = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

function dayOf(t) {
  if (!Number.isFinite(t)) return null
  const d = new Date(t * 1000)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

function tapeAgeDays(bars, now) {
  if (!Number.isFinite(now) || bars.length === 0) return null
  const t = bars[bars.length - 1].t
  if (!Number.isFinite(t)) return null
  const days = Math.floor((now - t * 1000) / 86_400_000)
  return days >= 0 ? days : null
}

function fingerprintFacts(who, fp) {
  if (!fp?.ok) return [`${who}: not enough history to fingerprint`]
  const out = []
  out.push(
    `${who}: ATR ${r1(fp.atrPct)}% of price` +
    (fp.atrPctile == null ? '' : ` (${ord(fp.atrPctile)} percentile of the last ${PCTILE_LOOKBACK} days)`) +
    `, Bollinger width ${r1(fp.bandwidthPct)}%` +
    (fp.bandwidthPctile == null ? '' : ` (${ord(fp.bandwidthPctile)} percentile)`),
  )
  if (fp.volRatio20 != null) {
    out.push(
      `${who}: volume ${r2(fp.volRatio20)}× its own 20-day average` +
      (fp.volTrend == null ? '' : `, and the 20-day average is ${r2(fp.volTrend)}× the 60-day`),
    )
  }
  out.push(
    `${who}: ${signed(fp.distEma20Pct)}% from the EMA20, ${signed(fp.distEma50Pct)}% from the EMA50` +
    (fp.distEma200Pct == null ? ' (no EMA200 — under 200 bars of history at that point)' : `, ${signed(fp.distEma200Pct)}% from the EMA200`),
  )
  if (fp.drawdownPct != null) {
    const age = fp.daysSinceHigh === 0 ? 'set today' : `set ${fp.daysSinceHigh} day${fp.daysSinceHigh === 1 ? '' : 's'} earlier`
    out.push(`${who}: ${r1(fp.drawdownPct)}% below the ${PCTILE_LOOKBACK}-day high, ${age}${fp.higherLows === true ? ', on ascending swing lows' : fp.higherLows === false ? ', on descending swing lows' : ''}`)
  }
  return out
}

/** "1st percentile", not "1th percentile". The facts are read aloud off a phone
 *  screen; a number that reads wrong makes the whole line look generated. */
function ord(x) {
  const n = Math.round(x)
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)) }
function r1(x) { return Number.isFinite(x) ? Math.round(x * 10) / 10 : null }
function r2(x) { return Number.isFinite(x) ? Math.round(x * 100) / 100 : null }
/** The sign is taken from the ROUNDED value. Signing the raw one prints "-0.0%"
 *  for a difference of a millionth of a percent, which reads as a fall. */
function signed(x, d = 1) {
  if (!Number.isFinite(x)) return '—'
  const v = Number(x.toFixed(d))
  return `${v >= 0 ? '+' : ''}${v.toFixed(d)}`
}
