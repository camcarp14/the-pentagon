// THE PLAYBOOK — the phases of an alt run, and the early signals, each one
// MEASURED rather than asserted.
//
// This is the file that carries domain knowledge instead of arithmetic, which
// makes it the easiest file in the build to fill with confident nonsense. Three
// rules keep it honest:
//
//   1. EVERY signal in EARLY_SIGNALS is computed by signalChecklist() against
//      real candles. If it cannot be measured it does not belong here, however
//      true it sounds. That is why "the narrative improves" and "the dev is
//      active on Discord" are not on the list.
//   2. NO INVENTED STATISTICS. There is not one "runs like this work 68% of the
//      time" anywhere in this file. Where a number is a rule of thumb rather
//      than something measured, the copy says "rule of thumb, not a measured
//      threshold" in those words. The only real base rates on this tab come out
//      of precedent.js, counted over the coin's own history, with the sample
//      size and the worst case attached.
//   3. THE LATE SIGNALS ARE LABELLED LATE. Attention, funding turning positive
//      and open-interest expansion are on the list because knowing where you are
//      in the sequence is worth as much as knowing the sequence — but an
//      attention spike is the exit half of a move, not an entry, and every piece
//      of copy attached to those three says so out loud.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT `level` MEANS ON A CHECKLIST ROW
//
// 'strong' | 'moderate' | 'weak' | 'none' | 'unknown' — how strongly the signal
// is PRESENT, never how good it is. A 'strong' reading on `attention` is a
// strong warning. This is the one place the vocabulary could be misread as a
// recommendation, so every late row's note states what the reading means in
// words rather than leaving the badge to say it.
//
// `pass` is true/false/null, and null is not false: null means the input was not
// there, and the note names what was missing. A missing feed reported as a
// failed signal is a lie that looks like diligence.
import { ema, sma, swings, highestHigh, lowestLow } from '../ta.js'
import { fingerprint } from './precedent.js'

/* ══ the phases ════════════════════════════════════════════════════════════ */

/**
 * dormant → accumulation → ignition → markup → euphoria → distribution → bust,
 * and most coins never leave the first one. `typicalNext` is a list of phase ids
 * and the FIRST entry is not the likely one — it is the one the phase is named
 * for. Every phase's realistic next state is "the same phase, for longer".
 */
export const PHASES = [
  {
    id: 'dormant',
    label: 'Dormant',
    looksLike: 'Nothing is happening. Flat-to-down price on shrinking volume, well below the 200-day, months since the last time anyone cared. Turnover is a fraction of a percent of market cap a day.',
    whatToDo: 'Nothing that costs money. This is a watchlist row, not a position. The only real work is deciding which dormant coins deserve a slot at all.',
    failureMode: 'Buying it because it is down 90% and therefore "cheap". Dormant is the resting state of an altcoin and most of them stay in it until they delist. The cost is not the drawdown, it is the months of capital and attention parked in something asleep.',
    typicalNext: ['dormant', 'accumulation'],
  },
  {
    id: 'accumulation',
    label: 'Accumulation',
    looksLike: 'Price stops going down. Daily ranges contract and the ATR percentile falls into the teens, the 20-day volume baseline creeps above the 60-day while the chart still looks like nothing, and higher lows start printing off the base.',
    whatToDo: 'This is where the work belongs: pick the trigger level, the invalidation and the size BEFORE anything moves. A starter position is defensible here if the invalidation is close and the coin is liquid enough to actually exit. Everything else is waiting.',
    failureMode: 'It never ignites and you were early for six months — which is indistinguishable from wrong while it is happening. The second failure is sizing it like conviction because it is quiet: a tight stop is not the same thing as a safe coin.',
    typicalNext: ['accumulation', 'ignition', 'dormant'],
  },
  {
    id: 'ignition',
    label: 'Ignition',
    looksLike: 'One to three days that do not look like the last sixty. A close through the prior 20-day high, range expansion, volume several times its own average, and the coin outrunning BTC on the day.',
    whatToDo: 'Execute the plan you already wrote, at the size you already chose. This is the one phase where paying up is defensible, and only for a position whose stop is already defined. An add after the break uses the same stop, not a wider one.',
    failureMode: 'The failed break — common, and expensive. Price closes back inside the range within a few days and the move was a liquidity grab. That is what the invalidation level is for, and why the size was chosen before the excitement.',
    typicalNext: ['markup', 'dormant', 'accumulation'],
  },
  {
    id: 'markup',
    label: 'Markup',
    looksLike: 'Higher highs and higher lows on the daily, pullbacks holding the EMA20, relative strength against BTC positive on the week and the month. Funding turns positive; open interest builds.',
    whatToDo: 'Hold and trail. Adds go on pullbacks into structure, never into green candles. The stop only ever moves up.',
    failureMode: 'Round-tripping it. The markup phase pays for the whole exercise, and it gets handed back by holding through distribution because the story is still good. The story is always still good at the top.',
    typicalNext: ['markup', 'euphoria', 'distribution'],
  },
  {
    id: 'euphoria',
    label: 'Euphoria',
    looksLike: 'Vertical. Multiple +20% days, the coin on every trending list, funding at extremes, price further from the EMA50 than at any point in the run, and the reasons to own it now arrive from people who have never mentioned it before.',
    whatToDo: 'Sell into it, in pieces, on the way up. Liquidity is the best it will ever be in this phase, which is exactly the argument for using it. A new position here is a chase.',
    failureMode: 'Treating a parabola as a trend and trailing it like one. Parabolas do not roll over, they break, and the distance from the top to the first real bid is routinely half the move.',
    typicalNext: ['distribution', 'bust'],
  },
  {
    id: 'distribution',
    label: 'Distribution',
    looksLike: 'The highs stop being higher while volume stays large. Failed breakouts, long upper wicks, the EMA20 lost and then only weakly reclaimed. Attention is still at its peak — trending lists and socials lag price by days to weeks.',
    whatToDo: 'Reduce into strength. There is no need to catch the exact top and no reason to be full size into a tape that has stopped making highs.',
    failureMode: 'Reading the attention as demand. The crowd arriving is the mechanism by which somebody exits this position. The only question is whether it is you.',
    typicalNext: ['bust', 'distribution', 'markup'],
  },
  {
    id: 'bust',
    label: 'Bust',
    looksLike: 'Down 50-80% from the high, below the 200-day, volume collapsing, no bid on the bounces. The narrative is entirely intact and the price is not.',
    whatToDo: 'Nothing. Not averaging down, not "it is cheap now". If the coin matters it will re-base for months and re-appear in accumulation, where it can be bought against a defined invalidation instead of an opinion.',
    failureMode: 'Averaging down into a float that is being distributed to you. A 70% drawdown needs a 233% gain just to get level, and the coin has to want to.',
    typicalNext: ['bust', 'dormant', 'accumulation'],
  },
]

const PHASE_BY_ID = Object.fromEntries(PHASES.map((p) => [p.id, p]))

/* ══ the early signals ═════════════════════════════════════════════════════ */

/**
 * ORDERED BY HOW EARLY THEY FIRE, earliest first. The first six are genuinely
 * anticipatory: each one can be true while the chart still looks like nothing.
 * The last three are coincident-to-late confirmation and are marked `stage:
 * 'late'`; they are here to locate you in the sequence, not to get you in.
 *
 * `leadTime` is qualitative on purpose. A numeric lead time ("fires 11 days
 * before ignition") would be exactly the kind of invented statistic this file
 * refuses to carry. If you want a measured answer for one coin, precedent.js
 * counts it from that coin's own history.
 */
export const EARLY_SIGNALS = [
  {
    id: 'compression',
    stage: 'early',
    label: 'Volatility compressed to a multi-month low',
    why: 'Big moves start from quiet. A contracted range means the float has stopped changing hands across a spread of prices — buyers and sellers have agreed — and it then takes very little new demand to break the agreement. Compression says nothing about direction. It says that when direction arrives it will arrive quickly.',
    howMeasured: 'ATR(14) as a percent of price, and Bollinger(20, 2) bandwidth, each ranked against its own previous 180 days. The row is judged on the HIGHER of the two percentiles, so a coin that is quiet on one measure and loud on the other does not pass: low ATR with wide bands is a smooth drift, not a coil. Under the 20th percentile is a rule of thumb, not a measured threshold.',
    leadTime: 'The earliest of the set. It is visible while nothing is happening, and it can stay true for weeks without resolving — which is the cost of using it.',
  },
  {
    id: 'volume_baseline',
    stage: 'early',
    label: 'Volume baseline rising while price goes nowhere',
    why: 'The closest thing on this list to evidence of an actual buyer rather than a chart pattern. Flat price on a rising volume baseline means someone is absorbing supply without paying up for it. It is also the signal most easily manufactured by wash volume on a thin venue, which is why it is measured against the coin\'s own 60-day baseline and never against a dollar threshold.',
    howMeasured: '20-day mean volume divided by 60-day mean volume, with the 20-day price change inside ±12% so "price went nowhere" is a measurement and not an impression. Above 1.15× is the rule of thumb this row uses; it is a rule of thumb, not a measured threshold.',
    leadTime: 'Weeks. It builds through the base and is usually already true by the time compression is at its tightest.',
  },
  {
    id: 'rs_inflection',
    stage: 'early',
    label: 'Relative strength vs BTC turning up after a long stretch behind it',
    why: 'An altcoin is a leveraged bet on BTC until it stops being one, and the inflection is what that looks like on a single chart: the coin stops losing ground over the week while it is still behind over the month. Waiting for it to lead on both windows is waiting for the move to be over — the 30-day only turns positive after the run has happened.',
    howMeasured: '7-day return minus BTC\'s 7-day return, positive, while the same difference over 30 days is still negative. Both numbers come from screen.js, so the board and this row cannot mean different things by "relative strength".',
    leadTime: 'Days to a couple of weeks. It typically fires after compression and before the break.',
  },
  {
    id: 'reclaim_200d',
    stage: 'early',
    label: 'Reclaim of the 200-day after a long stretch below it',
    why: 'The 200-day is not magic, it is watched — and being watched is the whole mechanism. It is the line where trend-following money is allowed back in and where "this one is dead" stops being the consensus. The reclaim matters far more than the level, and the length of the stretch below it is what makes the reclaim mean something.',
    howMeasured: 'Close above the 200-day SIMPLE moving average, having been below it inside the last 30 days, with the days spent below reported. The simple average, deliberately: the line the market watches is the SMA, and the fingerprint\'s distEma200Pct is a different measure that is not this one.',
    leadTime: 'Days. As often coincident with the first leg of the markup as ahead of it, which is why it sits fourth and not first.',
  },
  {
    id: 'higher_lows',
    stage: 'early',
    label: 'A higher-low sequence off the base',
    why: 'The base\'s first evidence of demand with a price attached: each higher low is a buyer who would not wait for the old price. It is also the only signal on this list that hands you an invalidation for free — the sequence is wrong the moment a low undercuts the one before it, and that is a level, not a feeling.',
    howMeasured: 'The last two CONFIRMED swing lows ascending (ta.js swings at strength 2: a pivot needs two bars either side, so the most recent two bars can never confirm one and the read never invents a low that has not held). The rise between them is reported.',
    leadTime: 'Days to weeks. It is the structure the trigger level gets drawn from.',
  },
  {
    id: 'trigger_level',
    stage: 'early',
    label: 'A defined horizontal trigger with range contracting into it',
    why: 'The point where a setup becomes a trade with a price on it. A level nobody can name is not a plan, it is an intention. Contraction INTO the level is what separates a coil from a grind — the same level approached on widening ranges is usually a coin being distributed into it.',
    howMeasured: 'The highest high of the prior 20 bars — the same level signals.js::breakout and screen.js use, so the board, the trigger and the base rates all mean one thing by "break". The row passes when price is below that level and within 8% of it, and the last 10 bars\' high-low range is under 0.8× the 30 bars before them. Both of those numbers are rules of thumb, not measured thresholds.',
    leadTime: 'The last of the early signals — hours to days ahead of the break, or never.',
  },
  {
    id: 'attention',
    stage: 'late',
    label: 'Attention arrives — trending lists, socials, the randoms',
    why: 'CONFIRMATION, NOT AN ENTRY. Attention is demand of last resort. By the time a coin is on a trending list the buyers who move price quietly are already positioned, and the people arriving are the liquidity the move gets sold into. It earns a place on this list because knowing you are late is worth knowing — not because it is a reason to buy.',
    howMeasured: 'Trending rank from CoinGecko /search/trending (1 = most searched right now), plus whatever sentiment.js resolved for the coin. A rank inside the top 5 is treated as a loud reading; that cut-off is a rule of thumb, not a measured threshold.',
    leadTime: 'Coincident to late. Usually the second half of the move, and it peaks after price does.',
  },
  {
    id: 'funding_flip',
    stage: 'late',
    label: 'Perpetual funding turns positive',
    why: 'CONFIRMATION, NOT AN ENTRY. Positive funding means longs are paying shorts to keep the position — leverage has arrived. That confirms a real move is underway, and past a certain level it becomes the thing that ends it, because a crowded long book eventually unwinds into itself. There is no reading of this that is an early signal.',
    howMeasured: 'lastFundingRate from Binance premiumIndex, annualised as rate × 3 settlements a day × 365. That annualisation lives in exactly one place — sentiment.js — and this row reads the number it produced rather than recomputing it, so the crowd card and this row can never print two different funding rates for one coin. Positive is the flip; beyond roughly +30% annualised is crowded. That +30% is a rule of thumb, not a measured threshold.',
    leadTime: 'Late by definition — funding cannot turn positive before there is a move to be long of.',
  },
  {
    id: 'oi_expansion',
    stage: 'late',
    label: 'Open interest expanding with price',
    why: 'CONFIRMATION, NOT AN ENTRY. New open interest alongside a rising price is new money rather than short covering, which is the healthier of the two ways a move can look — but it still describes something that has already happened. The same reading with price stalling is the warning version: positions building into a market that has stopped paying them.',
    howMeasured: 'The last two daily samples of sumOpenInterest from Binance openInterestHist, reported as a 24-hour percent change — measured by sentiment.js, including its staleness gate: a series whose newest sample is more than three days old is not a 24-hour change and is reported as unmeasured rather than relabelled. This row reads that verdict, so it cannot call a number measurable that the crowd card on the same page refused. Above +5% in a day counts as expansion here — a rule of thumb, not a measured threshold.',
    leadTime: 'Late. Coincident with the markup at the very earliest.',
  },
]

const SIGNAL_BY_ID = Object.fromEntries(EARLY_SIGNALS.map((s) => [s.id, s]))

// Rules of thumb, all of them, gathered here so the copy above and the code
// below cannot drift apart. None of these were fitted to anything.
const COMPRESSION_PCTILE = 20
const VOL_TREND_MIN = 1.15
const VOL_FLAT_PRICE_PCT = 12
const RECLAIM_LOOKBACK = 30
const TRIGGER_NEAR_PCT = 8
const CONTRACTION_MAX = 0.8
const FUNDING_CROWDED_ANNUAL_PCT = 30
const OI_EXPANSION_PCT = 5
const TRENDING_LOUD_RANK = 5

/* ══ the checklist ═════════════════════════════════════════════════════════ */

/**
 * Measure every signal in EARLY_SIGNALS, in the same order.
 *
 * @param candles  daily OHLCV, oldest→newest (may be null)
 * @param screened one screen.js row for this coin (may be null)
 * @param ctx      { quality, trendingRank, crowd, now }
 *                 `quality` is 'ohlcv' | 'close-only' from the data layer;
 *                 `crowd` is a sentiment.js crowdRead(). Callers may still pass
 *                 an `altDerivs()` payload as `derivs` — CoinDetail does — and
 *                 it is deliberately NOT read here: the funding and open-
 *                 interest rows take crowdRead's verdict on the same payload
 *                 instead. See fromCrowdRead() at the bottom of this file for
 *                 the failure that rule prevents.
 * @returns [{ id, label, pass, value, level, note, stage }]
 *
 * Rows always come back in full, in order, one per signal. A row whose input is
 * absent reports pass:null / level:'unknown' and names the missing input — the
 * checklist is a list of what we know and what we do not, and a silently short
 * list would read as "the rest passed".
 */
export function signalChecklist(candles, screened, ctx = {}) {
  const c = ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx : {}
  const { quality = null, crowd = null } = c

  // ABSENT ≠ NULL for the trending rank — the same distinction sentiment.js's
  // crowdRead makes, for the same reason, and it has to be made here too or the
  // two disagree on the same pass. `trendingRank: null` means we fetched the
  // list and this coin is not on it: a measurement, and the GOOD version of this
  // row for an early setup. An absent key means the list never answered, which
  // is no measurement at all. Collapsing them prints "not on the trending list"
  // — the most bullish attention reading there is — on every coin on the board
  // on exactly the days CoinGecko rate-limits us.
  const trendingChecked = Object.prototype.hasOwnProperty.call(c, 'trendingRank') && c.trendingRank !== undefined
  const trendingRank = c.trendingRank
  const bars = usableBars(candles)
  const last = bars.length - 1
  const closes = bars.map((b) => b.c)

  // Close-only candles (CoinGecko market_chart) are flat lines: high = low =
  // close on every bar. ATR is zero, Bollinger bandwidth is a pure close-to-
  // close number and the intraday range that the trigger row measures does not
  // exist. Those rows report 'unknown' rather than a precise zero, because a
  // precise zero here reads as "maximum compression" — the strongest possible
  // buy signal, generated entirely by the data source.
  const closeOnly = quality === 'close-only' || looksCloseOnly(bars)
  const fp = bars.length > 0 ? fingerprint(bars, last) : null

  const out = []
  const add = (id, fields) => {
    const s = SIGNAL_BY_ID[id]
    out.push({ id, label: s.label, stage: s.stage, pass: null, value: null, level: 'unknown', note: '', ...fields })
  }

  /* 1 — compression */
  if (closeOnly) {
    add('compression', { note: 'candles are close-only — every bar is flat, so ATR and Bollinger width are meaningless here. Not measured.' })
  } else if (fp?.atrPctile == null || fp?.bandwidthPctile == null) {
    add('compression', { note: `not enough history to rank volatility against its own past (${bars.length} candles; the percentile needs at least 60 readings inside a 180-day lookback)` })
  } else {
    const worst = Math.max(fp.atrPctile, fp.bandwidthPctile)
    add('compression', {
      pass: worst <= COMPRESSION_PCTILE,
      value: r1(worst),
      level: worst <= 10 ? 'strong' : worst <= COMPRESSION_PCTILE ? 'moderate' : worst <= 35 ? 'weak' : 'none',
      note: `ATR ${r1(fp.atrPct)}% of price (${ord(fp.atrPctile)} percentile of 180 days), Bollinger width ${r1(fp.bandwidthPct)}% (${ord(fp.bandwidthPctile)}) — judged on the higher of the two, ${Math.round(worst)}`,
    })
  }

  /* 2 — volume baseline rising while price is flat */
  const chg20 = last >= 20 && closes[last - 20] > 0 ? (closes[last] / closes[last - 20] - 1) * 100 : null
  if (fp?.volTrend == null) {
    add('volume_baseline', { note: bars.length < 60 ? `need 60 candles of volume to compare a 20-day baseline against a 60-day, have ${bars.length}` : 'no volume on these candles — the accumulation read needs it and will not guess' })
  } else if (chg20 == null) {
    add('volume_baseline', { value: r2(fp.volTrend), note: `20-day volume baseline is ${r2(fp.volTrend)}× the 60-day, but there is no 20-day price change to check it against — rising volume on a rising price is not accumulation` })
  } else {
    const flat = Math.abs(chg20) <= VOL_FLAT_PRICE_PCT
    add('volume_baseline', {
      pass: flat && fp.volTrend >= VOL_TREND_MIN,
      value: r2(fp.volTrend),
      level: !flat ? 'none' : fp.volTrend >= 1.4 ? 'strong' : fp.volTrend >= VOL_TREND_MIN ? 'moderate' : fp.volTrend >= 1.05 ? 'weak' : 'none',
      note: `20-day volume baseline ${r2(fp.volTrend)}× the 60-day, price ${signed(chg20)}% over the same 20 days` +
        (flat ? '' : ' — price is not flat, so this is participation in a move rather than accumulation under one'),
    })
  }

  /* 3 — RS vs BTC inflection */
  const rs7 = num(screened?.rsVsBtc7d)
  const rs30 = num(screened?.rsVsBtc30d)
  if (rs7 == null || rs30 == null) {
    add('rs_inflection', { note: 'no relative-strength read — the board row is missing a 7d or 30d return, or BTC is missing from the universe' })
  } else {
    const inflecting = rs7 > 0 && rs30 < 0
    add('rs_inflection', {
      pass: inflecting,
      value: r1(rs7),
      level: !inflecting ? (rs7 > 0 ? 'weak' : 'none') : rs7 >= 5 && rs30 <= -10 ? 'strong' : 'moderate',
      note: `${signed(rs7)} points vs BTC over 7 days against ${signed(rs30)} over 30` +
        (inflecting ? ' — ahead on the week, still behind on the month, which is what a turn looks like'
          : rs7 > 0 && rs30 > 0 ? ' — ahead on both windows, so the inflection has already happened and this is momentum, not an early signal'
            : ' — still behind BTC on the week'),
    })
  }

  /* 4 — reclaim of the 200-day */
  const s200 = sma(closes, 200)
  if (bars.length < 200 || s200[last] == null) {
    add('reclaim_200d', { note: `need 200 candles for a 200-day average, have ${bars.length}` })
  } else {
    const distPct = (closes[last] / s200[last] - 1) * 100
    let belowRecently = 0
    for (let i = Math.max(200 - 1, last - RECLAIM_LOOKBACK); i <= last; i++) {
      if (s200[i] != null && closes[i] < s200[i]) belowRecently++
    }
    // How long it had been below BEFORE the reclaim — the number that makes the
    // reclaim mean something. Counted backwards from the last close under it.
    let streak = 0
    for (let i = last; i >= 200 - 1; i--) {
      if (s200[i] == null) break
      if (closes[i] < s200[i]) streak++
      else if (streak > 0) break
    }
    const above = distPct > 0
    const fresh = above && belowRecently > 0
    add('reclaim_200d', {
      pass: fresh,
      value: r1(distPct),
      level: !above ? 'none' : !fresh ? 'weak' : streak >= 60 ? 'strong' : 'moderate',
      note: above
        ? `close is ${signed(distPct)}% above the 200-day` +
          (fresh ? `, reclaimed after ${streak} day${streak === 1 ? '' : 's'} below it (${belowRecently} of the last ${RECLAIM_LOOKBACK} days were under)`
            : ` and has held it for more than ${RECLAIM_LOOKBACK} days — the reclaim is old news, not an early signal`)
        : `close is ${signed(distPct)}% below the 200-day — no reclaim`,
    })
  }

  /* 5 — higher lows off the base */
  if (bars.length < 20) {
    add('higher_lows', { note: `need 20 candles to confirm two swing lows, have ${bars.length}` })
  } else {
    const { lows } = swings(bars, 2)
    if (lows.length < 2) {
      add('higher_lows', { pass: false, level: 'none', note: 'fewer than two confirmed swing lows in the history — no sequence to read' })
    } else {
      const [a, b] = lows.slice(-2)
      const rise = a.price > 0 ? (b.price / a.price - 1) * 100 : null
      const higher = b.price > a.price
      add('higher_lows', {
        pass: higher,
        value: r1(rise),
        level: !higher ? 'none' : rise >= 10 ? 'strong' : rise >= 3 ? 'moderate' : 'weak',
        note: `last two confirmed swing lows ${px(a.price)} → ${px(b.price)} (${signed(rise)}%, ${b.i - a.i} days apart)` +
          (higher ? ` — the sequence breaks if price closes under ${px(b.price)}` : ' — not ascending, so there is no base yet'),
      })
    }
  }

  /* 6 — a defined trigger with contraction into it */
  const trigger = bars.length >= 21 ? highestHigh(bars, 20, last - 1) : null
  if (trigger == null || !(closes[last] > 0)) {
    add('trigger_level', { note: `need 21 candles to name a 20-day trigger level, have ${bars.length}` })
  } else if (closeOnly) {
    add('trigger_level', {
      value: r1((trigger / closes[last] - 1) * 100),
      note: `trigger ${px(trigger)} (${signed((trigger / closes[last] - 1) * 100)}% away), but the range contraction cannot be measured on close-only candles`,
    })
  } else {
    const distPct = (trigger / closes[last] - 1) * 100
    const r10 = rangePct(bars, last, 10)
    const r30 = rangePct(bars, last - 10, 30)
    const contraction = r10 != null && r30 != null && r30 > 0 ? r10 / r30 : null
    const near = distPct > 0 && distPct <= TRIGGER_NEAR_PCT
    const coiling = contraction != null && contraction <= CONTRACTION_MAX
    add('trigger_level', {
      pass: near && coiling,
      value: r1(distPct),
      level: distPct <= 0 ? 'none' : near && coiling ? 'strong' : near || coiling ? 'moderate' : 'weak',
      note: distPct <= 0
        ? `price is already through the 20-day high ${px(trigger)} — this one has fired, so it is a break to manage rather than a setup to wait for`
        : `trigger ${px(trigger)}, ${r1(distPct)}% above price` +
          (contraction == null ? '; not enough bars to measure the contraction into it'
            : `; last 10 bars' range is ${r2(contraction)}× the 30 before them${coiling ? ' — contracting' : ' — not contracting, which is a grind rather than a coil'}`),
    })
  }

  /* 7 — attention (LATE) */
  const rank = num(trendingRank) ?? num(crowd?.attention?.trendingRank)
  if (rank == null && !trendingChecked) {
    // Unmeasured, and it says so — the same shape and the same posture as the
    // funding row below when a coin has no perp. `pass: null` / `level:
    // 'unknown'` come from `add`'s defaults; the UI renders that as "?", not a
    // tick and not a miss.
    add('attention', {
      note: "CoinGecko's trending list did not answer on this pass, so whether anyone is searching for this coin was not measured. Not counted as \"nobody is looking\" — that is the most bullish reading of this row and it would be coming from a failed request.",
    })
  } else if (rank == null) {
    const state = crowd?.state
    add('attention', {
      pass: false,
      level: 'none',
      note: state && state !== 'unknown'
        ? `not on the trending list; sentiment.js reads the crowd as "${state}". For an early setup this is the good version of this row — attention is the exit half of a move, not the entry.`
        : 'not on the trending list, and no attention read available. For an early setup that is the good version of this row.',
    })
  } else {
    add('attention', {
      pass: true,
      value: rank,
      level: rank <= TRENDING_LOUD_RANK ? 'strong' : rank <= 15 ? 'moderate' : 'weak',
      note: `#${rank} on CoinGecko trending. This is confirmation that the crowd has arrived, NOT an entry signal — attention peaks after price does, so a loud reading here argues for taking profit rather than opening risk.`,
    })
  }

  /* 8 — funding (LATE) */
  const fundingRead = fromCrowdRead(crowd, 'funding', crowd?.crowding?.fundingAnnualPct, 'the annualised funding rate')
  const funding = fundingRead.value
  if (funding == null) {
    add('funding_flip', { note: fundingRead.why })
  } else {
    add('funding_flip', {
      pass: funding > 0,
      value: r1(funding),
      level: funding <= 0 ? 'none' : funding >= FUNDING_CROWDED_ANNUAL_PCT ? 'strong' : funding >= 10 ? 'moderate' : 'weak',
      note: funding > 0
        ? `funding ${signed(funding)}% annualised — longs are paying shorts. Confirmation of a move already underway` +
          (funding >= FUNDING_CROWDED_ANNUAL_PCT ? `, and past roughly +${FUNDING_CROWDED_ANNUAL_PCT}% it is a crowding warning: the long book is what unwinds first.` : '.')
        : `funding ${signed(funding)}% annualised — shorts are paying longs, so leverage has not arrived yet. That is the earlier and cheaper side of this reading.`,
    })
  }

  /* 9 — open interest (LATE) */
  const oiRead = fromCrowdRead(crowd, 'oi', crowd?.crowding?.oiChange24hPct, 'the 24h open-interest change')
  const oi = oiRead.value
  if (oi == null) {
    add('oi_expansion', { note: oiRead.why })
  } else {
    add('oi_expansion', {
      pass: oi >= OI_EXPANSION_PCT,
      value: r1(oi),
      level: oi >= 15 ? 'strong' : oi >= OI_EXPANSION_PCT ? 'moderate' : oi > 0 ? 'weak' : 'none',
      note: `open interest ${signed(oi)}% over 24h — ` +
        (oi >= OI_EXPANSION_PCT
          ? 'positions are being opened into the move. Confirmation, not an entry; the same reading with price stalling is a warning.'
          : oi > 0 ? 'barely changed.' : 'positions are being closed, which is short covering or profit-taking rather than new money.'),
    })
  }

  return out
}

/* ══ the phase call ════════════════════════════════════════════════════════ */

/**
 * Which phase is this coin in, right now.
 *
 * A PRIORITY LADDER, first match wins, in the shape advice.js uses — and in the
 * same spirit: the rungs that say "be careful" sit ABOVE the rungs that say
 * "this is interesting", so a coin that is both parabolic and breaking out is
 * called euphoria and never ignition. The ladder runs backwards through the
 * cycle (bust → distribution → euphoria → markup → ignition → accumulation)
 * because every late phase also satisfies the tests for the early ones: a coin
 * in distribution has a rising 20-day volume baseline and a flat price too.
 *
 * `id` may be 'unknown', which is deliberately NOT one of PHASES. Unknown is a
 * phase of our data, not of the market, and putting it in the list would let a
 * UI render "the market is in the unknown phase" with a straight face.
 *
 * `confidence` counts how many independent inputs were available — board row,
 * candle tape, precedent, crowd — and nothing else. Two sources agreeing is a
 * stronger call than one source being emphatic, and this file has no way to
 * measure emphasis honestly.
 */
export function phaseOf({ screened = null, precedent = null, crowd = null, candles = null } = {}) {
  const bars = usableBars(candles)
  const closes = bars.map((b) => b.c)
  const last = bars.length - 1
  const e20 = ema(closes, 20)
  const e50 = ema(closes, 50)
  const s200 = sma(closes, 200)

  const close = last >= 0 ? closes[last] : null
  const hi60 = bars.length >= 60 ? highestHigh(bars, 60, last) : null
  const ddFrom60 = hi60 != null && hi60 > 0 && close != null ? (1 - close / hi60) * 100 : null
  const chg7d = num(screened?.chg7d) ?? chgOver(closes, 7)
  const chg30d = num(screened?.chg30d) ?? chgOver(closes, 30)
  const band = screened?.band ?? null
  const flags = screened?.flags ?? {}
  const fp = bars.length > 0 ? fingerprint(bars, last) : null

  const sources = [
    screened ? 'board row' : null,
    bars.length >= 60 ? 'candles' : null,
    precedent?.ok ? 'precedent' : null,
    crowd?.score != null ? 'crowd' : null,
  ].filter(Boolean)
  const confidence = sources.length >= 3 ? 'high' : sources.length === 2 ? 'medium' : 'low'

  const call = (id, why) => ({
    id,
    label: PHASE_BY_ID[id]?.label ?? 'Unknown',
    confidence,
    why: why.filter(Boolean),
  })

  // 0 — nothing to read
  if (!screened && bars.length < 20) {
    return {
      id: 'unknown', label: 'Unknown', confidence: 'low',
      why: ['no board row and fewer than 20 candles — there is nothing here to place in a cycle'],
    }
  }

  // 1 — bust: the deepest, and it outranks everything so a dead-cat bounce in a
  // 70% drawdown is never called ignition.
  if (ddFrom60 != null && ddFrom60 >= 40 && chg30d != null && chg30d < -25 &&
      (s200[last] == null || close < s200[last])) {
    return call('bust', [
      `${r1(ddFrom60)}% below the 60-day high with a 30-day return of ${signed(chg30d)}%`,
      s200[last] != null ? `close ${px(close)} is under the 200-day ${px(s200[last])}` : null,
      'a bounce inside a drawdown this deep is not an ignition until it takes back the 200-day',
    ])
  }

  // 2 — distribution: the move happened, the highs stopped
  if (chg30d != null && chg30d >= 50 && chg7d != null && chg7d < 0 &&
      e20[last] != null && close < e20[last]) {
    return call('distribution', [
      `up ${signed(chg30d)}% over 30 days but ${signed(chg7d)}% over the last 7`,
      `close ${px(close)} has lost the EMA20 ${px(e20[last])}`,
      crowd?.state === 'hot' || crowd?.state === 'euphoric'
        ? `the crowd is still "${crowd.state}" — attention lags price, and that lag is what the exit gets sold into`
        : null,
    ])
  }

  // 3 — euphoria
  if (flags.parabolic || band === 'late' || crowd?.state === 'euphoric') {
    return call('euphoria', [
      flags.parabolic ? `parabolic: ${signed(chg7d)}% over 7 days, ${signed(screened?.chg24h)}% in 24h` : null,
      band === 'late' ? 'the board has this banded `late` — the move is behind it, not ahead' : null,
      crowd?.state === 'euphoric' ? 'sentiment reads the crowd as euphoric' : null,
      fp?.distEma50Pct != null ? `price is ${signed(fp.distEma50Pct)}% from the EMA50` : null,
      'new risk here is a chase; this is the phase to sell into, in pieces',
    ])
  }

  // 4 — markup
  if (band === 'underway' ||
      (e20[last] != null && e50[last] != null && close > e20[last] && e20[last] > e50[last] && chg30d != null && chg30d >= 20)) {
    return call('markup', [
      band === 'underway' ? 'the board has this banded `underway`' : null,
      e20[last] != null && e50[last] != null ? `close ${px(close)} over EMA20 ${px(e20[last])} over EMA50 ${px(e50[last])}` : null,
      chg30d != null ? `${signed(chg30d)}% over 30 days` : null,
      'adds belong on pullbacks into structure, and the stop only moves up',
    ])
  }

  // 5 — ignition
  if (band === 'starting' || (flags.freshBreak && num(screened?.accel?.d24VsWeek) != null && screened.accel.d24VsWeek >= 2)) {
    return call('ignition', [
      band === 'starting' ? 'the board has this banded `starting`' : 'the last 24h broke the prior 6-day high with the day running ahead of the week\'s pace',
      num(screened?.rsVsBtc7d) != null ? `${signed(screened.rsVsBtc7d)} points of relative strength vs BTC over 7 days` : null,
      precedent?.ok && precedent.baseRates?.medianFwd21 != null
        ? `this coin's own ${precedent.episodes} prior ignitions ran a median ${signed(precedent.baseRates.medianFwd21)}% over the next 21 days, worst ${signed(precedent.baseRates.worstFwd21)}%`
        : 'no usable precedent for this coin — size it on the plan, not on a base rate that does not exist',
      'the failed break is the common outcome; the invalidation level is the whole position',
    ])
  }

  // 6 — accumulation
  const compressed = fp?.atrPctile != null && fp.atrPctile <= COMPRESSION_PCTILE
  const absorbing = fp?.volTrend != null && fp.volTrend >= 1.1
  if (band === 'quiet' || compressed || absorbing) {
    return call('accumulation', [
      band === 'quiet' ? 'the board has this banded `quiet`' : null,
      compressed ? `ATR is in the ${ord(fp.atrPctile)} percentile of its own last 180 days — the range has contracted` : null,
      absorbing ? `the 20-day volume baseline is ${r2(fp.volTrend)}× the 60-day` : null,
      fp?.higherLows === true ? 'swing lows are ascending' : null,
      precedent?.ok && precedent.matchPct != null
        ? `today matches this coin's day-before-liftoff archetype ${precedent.matchPct}% across ${precedent.episodes} prior ignitions — a similarity, not a probability`
        : null,
      'the work here is the trigger, the invalidation and the size, written down before it moves',
    ])
  }

  // 7 — dormant (default)
  return call('dormant', [
    band ? `the board has this banded \`${band}\`` : null,
    chg30d != null ? `${signed(chg30d)}% over 30 days` : null,
    num(screened?.turnover) != null ? `${(screened.turnover * 100).toFixed(1)}% of the float traded in a day` : null,
    'nothing to act on — this is a watchlist row until compression or a volume baseline shows up',
  ])
}

/* ══ locals ════════════════════════════════════════════════════════════════ */

/**
 * THE TWO DERIVATIVE ROWS READ WHAT sentiment.js MEASURED. THEY DO NOT RE-READ
 * THE FEED, AND THAT IS THE WHOLE POINT.
 *
 * Both numbers used to be recomputed here off the raw altDerivs() payload, and
 * both recomputations were subtly different from crowdRead's:
 *
 *   - the 3×365 funding annualisation existed TWICE, here and in sentiment.js,
 *     while netlify/shared/alts.mjs's parser comment promised the opposite —
 *     "annualised once, in sentiment.js, so there is exactly one place where the
 *     3×365 lives". Two copies of a constant that agree today are a number that
 *     disagrees on the day one of them is corrected.
 *   - the open-interest change skipped the staleness gate crowdRead applies
 *     (OI_MAX_AGE_SEC — a daily series more than three days old is no longer a
 *     24-hour change). So this checklist printed a measured "+12% in 24h" from
 *     two samples the crowd card, two rows further down the SAME card, had
 *     explicitly refused to score. A page that says a number is measurable and
 *     unmeasurable at the same time is worse than either answer alone: nothing
 *     on it tells the reader which half to believe.
 *
 * The gate is shared by being applied ONCE. crowdRead emits a part per
 * derivative input, with `points: null` and a label naming the refusal — no
 * listed perp, a single sample, a stale series — and this reads that verdict
 * instead of second-guessing it, so the refusal here quotes the same words the
 * crowd card shows. When crowdRead did not run at all the row says so and stops;
 * it does not reach around it to the raw feed, because reaching around it is
 * exactly how the two got out of step.
 *
 * @returns { value, why } — `why` is null when there is a value, and otherwise
 *          is the finished note for a `pass: null` / `level: 'unknown'` row.
 */
function fromCrowdRead(crowd, key, value, what) {
  const parts = Array.isArray(crowd?.parts) ? crowd.parts : null
  if (!parts) {
    return { value: null, why: `no crowd read on this pass, and sentiment.js is the single place ${what} is measured — so this row reports nothing rather than deriving a second version of it here. Not measured, and not counted as neutral.` }
  }
  const part = parts.find((p) => p && p.key === key)
  if (!part) {
    return { value: null, why: `the crowd read returned no ${what} at all on this pass — not measured.` }
  }
  if (part.points == null) {
    // The crowd read's own words, so the two rows cannot describe the same
    // refusal differently: "no listed perp", "only one open-interest sample",
    // "open-interest series is stale", "funding snapshot is stale".
    return { value: null, why: `${part.label} — the same gate the crowd read applies, applied here, so the two rows on this card cannot disagree about whether ${what} is measurable. Not measured, and not counted as neutral.` }
  }
  if (!Number.isFinite(value)) {
    return { value: null, why: `the crowd read scored ${what} but carried no number back with it — not measured.` }
  }
  return { value, why: null }
}

/** Bars with a finite close, high and low. Kept local rather than imported from
 *  precedent.js on purpose: the two files must not share a mutable idea of what
 *  the series is, and precedent.js's cleaner also repairs high/low ordering,
 *  which the trigger row here must NOT have done for it — a bar whose high was
 *  below its close is a bar this file should decline to measure a range on. */
function usableBars(candles) {
  if (!Array.isArray(candles)) return []
  return candles.filter((c) => c && typeof c === 'object' && Number.isFinite(c.c) && Number.isFinite(c.h) && Number.isFinite(c.l))
}

function looksCloseOnly(bars) {
  const n = Math.min(120, bars.length)
  if (n < 20) return false
  let flat = 0
  for (let i = bars.length - n; i < bars.length; i++) if (bars[i].h === bars[i].l) flat++
  return flat / n >= 0.95
}

/** High-low range across the n bars ending at endIdx, as a percent of the close
 *  there — so the two windows the contraction test compares are in the same
 *  units even when price has moved between them. */
function rangePct(bars, endIdx, n) {
  if (endIdx == null || endIdx < 0 || endIdx >= bars.length || endIdx - n + 1 < 0) return null
  const hh = highestHigh(bars, n, endIdx)
  const ll = lowestLow(bars, n, endIdx)
  const ref = bars[endIdx].c
  if (!Number.isFinite(hh) || !Number.isFinite(ll) || !(ref > 0)) return null
  return ((hh - ll) / ref) * 100
}

function chgOver(closes, n) {
  const last = closes.length - 1
  if (last < n || !(closes[last - n] > 0)) return null
  return (closes[last] / closes[last - n] - 1) * 100
}

function num(x) { return Number.isFinite(x) ? x : null }

/** "1st percentile", not "1th percentile" — these notes are read off a phone. */
function ord(x) {
  const n = Math.round(x)
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

function r1(x) { return Number.isFinite(x) ? Math.round(x * 10) / 10 : null }
function r2(x) { return Number.isFinite(x) ? Math.round(x * 100) / 100 : null }
/** The sign is taken from the ROUNDED value. Signing the raw one prints "-0.0%"
 *  for a difference of a millionth of a percent, which reads as a fall. */
function signed(x, d = 1) {
  if (!Number.isFinite(x)) return '—'
  const v = Number(x.toFixed(d))
  return `${v >= 0 ? '+' : ''}${v.toFixed(d)}`
}

/** Sub-dollar prices get significant digits, not two decimals — the levels a
 *  user works from are read off exactly these strings, and "$0.00" is not one. */
function px(x) {
  if (!Number.isFinite(x)) return '—'
  const a = Math.abs(x)
  if (a >= 1000) return `$${Math.round(x).toLocaleString('en-US')}`
  if (a >= 1) return `$${(Math.round(x * 100) / 100).toFixed(2)}`
  if (a === 0) return '$0'
  return `$${x.toPrecision(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`
}
