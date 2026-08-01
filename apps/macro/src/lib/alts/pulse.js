// THE DASHBOARD LAYER — the reads that turn a ranked list into a screen you can
// open, glance at, and close.
//
// screen.js answers "how good is this coin", season.js answers "is anything
// rotating at all". Between them there was nothing: the tab stated a regime at
// the top and then handed over a hundred undifferentiated rows. This file is the
// missing middle, and it is four questions, none of which a row-by-row list can
// answer:
//
//   1. WHAT CHANGED SINCE I LAST LOOKED.  boardDelta() diffs two board snapshots
//      — both of them real scans this browser actually received — and reports
//      band transitions, fresh breaks, entrants to the top of the board and
//      score moves. basing → igniting is the whole point of the tool and it is
//      the one event a ranked list can never show you, because a ranking has no
//      memory.
//   2. WHERE THE BOARD IS.  bandDistribution() counts the six bands. "Eleven
//      coins are igniting and sixty are dead" is a fact about the market that
//      no single row carries.
//   3. WHAT THE MARKET IS DOING OVER TIME.  altShareSeries() reads the dominance
//      history the alt-watch cron has been accumulating since it shipped and
//      turns it into the share of total cap that is NOT BTC — one number per
//      stored day, which is the only time series this system owns.
//   4. WHAT TO LOOK AT FIRST.  bandLeaders() picks the best-scoring rows inside
//      the bands that are actionable, so the right-hand pane can hold something
//      other than an instruction.
//
// Pure. No fetch, no DOM, no Date.now() — `now` is passed in (ms epoch) or
// omitted. Nulls, short arrays and absent history are normal inputs.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE THIS FILE IS HELD TO, WHICH IS THE SAME ONE season.js IS HELD TO:
//
//   A READ WITH NO INPUT RETURNS `ok: false` AND A `reason` IN WORDS. It never
//   returns an empty result that looks like a measured "nothing happened".
//
// Those two states are opposite claims and they render identically if you let
// them. "No band changed since your last visit" is a measurement — two real
// boards were compared and they agree. "There is no earlier board to compare
// against" is the absence of one. A dashboard that draws the second as the first
// tells you the market is quiet on the morning it is not, which is the exact
// shape of the bug this repo already caught in the season score. Every refusal
// below therefore states its own arithmetic the way season.js's
// "dominance trend unknown (1 of 7 stored days needed)" does.

/**
 * THE ORDER A MOVE HAPPENS IN. screen.js's bandOf() is written as a first-match
 * ladder in exactly this sequence, so a step forward here is a step forward
 * there. It is the only thing that makes "basing → igniting" a DIRECTION rather
 * than two unrelated words.
 *
 * `extended` is last because it is late in the move, NOT because it is best —
 * see BAND_PRIORITY, which is a different order for a different job.
 */
export const BAND_SEQUENCE = ['dead', 'basing', 'waking', 'igniting', 'running', 'extended']

/**
 * THE ORDER AN OPERATOR WANTS THEM ON SCREEN, which is not the order they
 * happen in. `igniting` is the state this whole tool exists to catch and it sits
 * fourth in the sequence above; sorting the board by the sequence would bury it
 * under sixty dead rows. `extended` is above `dead` only because a blow-off you
 * are already holding is worth seeing and a dead row is not.
 *
 * Two orders, two names, two jobs — the same discipline season.js applies to
 * `days` / `samples` / `spanDays`. Using one for the other silently reorders the
 * board or silently reverses every transition.
 */
export const BAND_PRIORITY = ['igniting', 'waking', 'running', 'basing', 'extended', 'dead']

/** One line per band, in the vocabulary screen.js's bandOf() actually tests for.
 *  The group headings and the leaders pane both read from here so the board
 *  cannot describe a band one way in one place and another way in the next. */
export const BAND_MEANING = {
  igniting: 'broke the prior 6-day high with the day running ahead of the week, and is not up 40% yet',
  waking: 'the last day is outpacing the week and it is holding up against BTC — early, unconfirmed',
  running: 'up 15%+ on the week, beating BTC, and high in its own range. The move is underway',
  basing: 'flat within ±12% on the week with real turnover — nothing has started, and that is the point',
  extended: 'parabolic, or up 150% on the month and still near the highs. This is a chase',
  dead: 'no acceleration, no relative strength, or too thin to act on',
}

/** Bands worth a glance before anything else. `running` is in the list because a
 *  move underway is still tradeable; `extended` and `dead` are not. */
export const ACTIONABLE_BANDS = ['igniting', 'waking', 'running']

/** Where a band sits in the move. Null — not -1, and not 0 — for anything that
 *  is not one of the six, so a typo can never read as `dead`. */
export function bandStep(band) {
  const i = BAND_SEQUENCE.indexOf(band)
  return i === -1 ? null : i
}

/** Where a band sits in the reading order. Unknown bands sort last rather than
 *  first, which is what `indexOf`'s -1 would have done. */
export function bandOrder(band) {
  const i = BAND_PRIORITY.indexOf(band)
  return i === -1 ? BAND_PRIORITY.length : i
}

/* ══ 2. where the board is ══════════════════════════════════════════════════ */

/**
 * Count the six bands over a screened board.
 *
 * @param rows  screenUniverse() output
 * @returns { total, bands: [{band, n, pct, meaning}], actionable, unbanded }
 *
 * `pct` is NULL when there is nothing to divide by, never 0. An empty board is
 * not a board on which 0% of coins are igniting — it is a board with no reading
 * on it, and a 0%-wide segment drawn from an empty scan is a measurement nobody
 * took. Every band appears in the output even at zero, so the strip does not
 * change shape between two renders of a moving market.
 */
export function bandDistribution(rows) {
  const list = Array.isArray(rows) ? rows : []
  const counts = new Map(BAND_PRIORITY.map((b) => [b, 0]))
  let total = 0
  let unbanded = 0
  for (const r of list) {
    const b = r?.band
    if (!counts.has(b)) { unbanded++; continue }
    counts.set(b, counts.get(b) + 1)
    total++
  }
  const bands = BAND_PRIORITY.map((band) => ({
    band,
    n: counts.get(band),
    pct: total > 0 ? (counts.get(band) / total) * 100 : null,
    meaning: BAND_MEANING[band],
  }))
  const actionable = ACTIONABLE_BANDS.reduce((s, b) => s + counts.get(b), 0)
  return { total, bands, actionable, unbanded }
}

/* ══ 1. what changed since I last looked ════════════════════════════════════ */

/**
 * The storable form of a board: everything the diff needs and nothing else.
 *
 * Deliberately NOT the screened rows. Those carry a 168-point sparkline, a
 * parts[] table and a facts[] array per coin — ~300KB for one pass, which is a
 * quota of browser storage spent to answer a question that needs five fields.
 * The snapshot is also the wire format for a value that will be read back by a
 * FUTURE build of this file, so it is kept flat and boring on purpose.
 *
 * @param rows  screenUniverse() output, already in board order
 * @param asOf  the scan payload's own `asOf` — the instant the numbers describe,
 *              not the instant the browser received them. A snapshot stamped
 *              with the receive time would report a 90-second-cached payload as
 *              a new board and diff it against itself.
 */
export function boardSnapshot(rows, { asOf = null, max = 250 } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const cap = Math.max(1, Math.floor(Number.isFinite(max) ? max : 250))
  const out = []
  for (let i = 0; i < list.length && out.length < cap; i++) {
    const r = list[i]
    if (!r?.id || !Number.isFinite(r.score)) continue
    out.push({
      id: String(r.id),
      symbol: String(r.symbol ?? '').toUpperCase(),
      score: r.score,
      band: r.band,
      // Place among the rows that were STORED, not the index in the input. The
      // two differ only when a row was skipped above, and then `i + 1` leaves a
      // gap: two snapshots that skipped different rows would report a place
      // change on every coin after the gap, which is a board-wide reshuffle
      // event manufactured by a bookkeeping detail.
      place: out.length + 1,
      brk: !!r.flags?.freshBreak,
    })
  }
  return { v: 1, asOf: Number.isFinite(asOf) ? asOf : null, n: out.length, rows: out }
}

/** Weight decides which single event a coin is reported under, and the order the
 *  list is read in. One coin, one line: a row that ignited also broke its 6-day
 *  high, also entered the top 15 and also gained 20 points, and printing all
 *  four is three lines of noise around one fact. */
const EVENT_RANK = ['ignite', 'advance', 'break', 'enter', 'climb', 'fade', 'slide', 'exit']

const TONE = {
  ignite: 'go', advance: 'go', break: 'go', enter: 'go', climb: 'go',
  fade: 'warn', slide: 'warn', exit: 'flat',
}

const ZERO_COUNTS = () => ({ ignite: 0, advance: 0, break: 0, enter: 0, climb: 0, fade: 0, slide: 0, exit: 0 })

/**
 * Diff two board snapshots.
 *
 * BOTH SIDES ARE REAL SCANS. `prev` is a snapshot this browser stored at the end
 * of an earlier visit and `curr` is the pass on screen now; there is no
 * interpolation, no modelled baseline and no server round-trip. What that buys
 * is the one thing the board cannot do on its own — memory — and what it costs
 * is that the answer is only ever "since YOU last looked", which is why every
 * refusal and the summary line both state the baseline's age out loud.
 *
 * @param prev  boardSnapshot() from an earlier pass, or null
 * @param curr  boardSnapshot() of the pass on screen
 * @param opts  { topN, minScoreMove, maxEvents }
 *
 * `topN` is the head of the board a new entrant has to reach to count. 15 is
 * about a phone screen of rows: a coin arriving at 84th is not news, and without
 * a cut every scan reports forty "entrants" that are one score point of
 * reshuffling.
 */
export function boardDelta(prev, curr, { topN = 15, minScoreMove = 10, maxEvents = 40 } = {}) {
  const empty = (reason) => ({
    ok: false, reason,
    baselineAt: Number.isFinite(prev?.asOf) ? prev.asOf : null,
    at: Number.isFinite(curr?.asOf) ? curr.asOf : null,
    spanMs: null, compared: 0, topN, truncated: 0,
    events: [], entered: [], exited: [], advanced: [], faded: [], broke: [], climbed: [], slid: [],
    counts: ZERO_COUNTS(),
  })

  const currRows = Array.isArray(curr?.rows) ? curr.rows : []
  if (currRows.length === 0) {
    return empty('no board on screen to compare — the scan carried no ranked rows')
  }
  if (!prev || !Array.isArray(prev.rows) || prev.rows.length === 0) {
    return empty('no earlier board stored in this browser — this pass is the baseline, so changes show from your next visit')
  }
  if (!Number.isFinite(prev.asOf) || !Number.isFinite(curr.asOf)) {
    return empty('one of the two boards has no scan timestamp, so the gap between them is unknown and no change can be dated')
  }
  if (curr.asOf === prev.asOf) {
    return empty('the scan has not refreshed since the stored baseline — this is the same pass, so there is nothing to diff yet')
  }
  if (curr.asOf < prev.asOf) {
    // A stale-fallback payload served after a fresh one, or a clock that went
    // backwards. Diffing them would report every forward transition as a fade.
    return empty('the stored baseline is NEWER than the scan on screen — the board is being served from cache, so nothing is diffed rather than reporting every move backwards')
  }

  const before = new Map(prev.rows.filter((r) => r?.id).map((r) => [String(r.id), r]))
  const spanMs = curr.asOf - prev.asOf

  const entered = []; const exited = []; const advanced = []
  const faded = []; const broke = []; const climbed = []; const slid = []
  const byCoin = new Map()   // id → the single highest-weight event for that coin

  const push = (kind, row, extra) => {
    const ev = {
      key: `${kind}:${row.id}`, kind, id: String(row.id),
      symbol: row.symbol, band: row.band, score: row.score, place: row.place,
      tone: TONE[kind], topN, ...extra,
    }
    ev.text = eventText(ev)
    const held = byCoin.get(ev.id)
    if (!held || EVENT_RANK.indexOf(kind) < EVENT_RANK.indexOf(held.kind)) byCoin.set(ev.id, ev)
    return ev
  }

  let compared = 0
  const stillHere = new Set()
  for (const row of currRows) {
    const was = before.get(String(row.id))
    stillHere.add(String(row.id))

    // NOT SEEN BEFORE AT ALL. Either genuinely new to the scan, or it ranked
    // below the snapshot's cap last time. Only report it if it is in the head of
    // the board now — anything else is a row we simply had not stored, and
    // calling that an arrival is a claim about a coin nobody watched.
    if (!was) {
      if (row.place <= topN) entered.push(push('enter', row, { from: null }))
      continue
    }
    compared++

    const from = bandStep(was.band)
    const to = bandStep(row.band)
    if (from != null && to != null && to > from) {
      advanced.push(push(row.band === 'igniting' ? 'ignite' : 'advance', row, {
        fromBand: was.band, steps: to - from, scoreDelta: row.score - was.score,
      }))
    } else if (from != null && to != null && to < from) {
      faded.push(push('fade', row, { fromBand: was.band, steps: from - to, scoreDelta: row.score - was.score }))
    }

    // A break that was NOT there last pass. `brk` false on both sides is not an
    // event; `brk` true on both sides is the same break still standing, and
    // re-reporting it every visit is how a sentinel gets muted — the rule
    // alt-watch.mjs's transitionOf() already keeps for the phone.
    if (row.brk && !was.brk) broke.push(push('break', row, { scoreDelta: row.score - was.score }))

    if (row.place <= topN && was.place > topN) entered.push(push('enter', row, { from: was.place }))
    else if (row.place > topN && was.place <= topN) exited.push(push('exit', row, { from: was.place }))

    const d = row.score - was.score
    if (d >= minScoreMove) climbed.push(push('climb', row, { scoreDelta: d, fromScore: was.score }))
    else if (d <= -minScoreMove) slid.push(push('slide', row, { scoreDelta: d, fromScore: was.score }))
  }

  // GONE FROM THE SCAN ENTIRELY — dropped out of the fetched universe, or newly
  // classified as a stablecoin/wrapper and therefore never ranked. Reported only
  // when it was in the head of the board, and with `place: null`, because there
  // is no rank to quote: it is not 251st, it is absent.
  for (const was of before.values()) {
    if (stillHere.has(String(was.id))) continue
    if (!Number.isFinite(was.place) || was.place > topN) continue
    exited.push(push('exit', { ...was, place: null, score: null }, { from: was.place, gone: true }))
  }

  const events = [...byCoin.values()].sort((a, b) =>
    EVENT_RANK.indexOf(a.kind) - EVENT_RANK.indexOf(b.kind) ||
    (b.score ?? -1) - (a.score ?? -1) ||
    String(a.symbol).localeCompare(String(b.symbol)))

  const counts = ZERO_COUNTS()
  for (const e of events) counts[e.kind]++

  const cap = Math.max(1, maxEvents)
  return {
    ok: true, reason: null,
    baselineAt: prev.asOf, at: curr.asOf, spanMs, compared, topN,
    events: events.slice(0, cap),
    truncated: Math.max(0, events.length - cap),
    entered, exited, advanced, faded, broke, climbed, slid, counts,
  }
}

/** The sentence for one event. In the lib, not in the component, for the same
 *  reason screen.js writes its own facts: the wording and the numbers it quotes
 *  are the same decision, and splitting them is how a card ends up describing an
 *  arithmetic it did not do. */
function eventText(ev) {
  const d = Number.isFinite(ev.scoreDelta) ? ` (${signed(ev.scoreDelta, 0)} to ${ev.score})` : ''
  switch (ev.kind) {
    case 'ignite': return `${ev.fromBand} → igniting${d}`
    case 'advance': return `${ev.fromBand} → ${ev.band}${d}`
    case 'break': return `broke its prior 6-day high${d}`
    case 'enter': return ev.from == null
      ? `new on the board at #${ev.place}, score ${ev.score}`
      : `into the top ${ev.topN} at #${ev.place}, from #${ev.from}`
    case 'climb': return `score ${signed(ev.scoreDelta, 0)} to ${ev.score}, still ${ev.band}`
    case 'slide': return `score ${signed(ev.scoreDelta, 0)} to ${ev.score}, now ${ev.band}`
    case 'fade': return `${ev.fromBand} → ${ev.band}${d}`
    // `gone` is a different sentence from "slipped down the board", because the
    // coin has no rank at all — quoting one would be inventing the number the
    // whole event is about.
    case 'exit': return ev.gone
      ? `gone from the scan — was #${ev.from}`
      : `out of the top ${ev.topN}, #${ev.from} → #${ev.place}`
    default: return ''
  }
}

/* ══ 3. the shape of the market over time ═══════════════════════════════════ */

// season.js's own thresholds, imported by value rather than by reference
// because season.js does not export them — and duplicated here WITH THE SAME
// NUMBERS on purpose, with a test that pins them together. The two files answer
// the same question from opposite ends (dominance falling ⇔ alt share rising)
// and a drift between the thresholds would let the season card say "dominance
// flat" while the chart beside it says "alt share rising".
const MIN_DOM_SAMPLES = 7
const DOM_FLAT_PTS = 0.5
const DOM_WINDOW_DAYS = 30

/**
 * The share of total market cap that is NOT BTC, one point per stored day.
 *
 * WHY THIS AND NOT BREADTH. The honest rotation measure on this tab is breadth —
 * how many of the top 100 beat BTC — and it is computed fresh from every scan.
 * It is NOT stored: nothing in this system writes a daily breadth row, so there
 * is no breadth history to draw and drawing one would mean inventing it. What
 * IS stored is the dominance sample the alt-watch cron appends once per calendar
 * day, and `100 − btcDom` is a real, unestimated statement about where capital
 * sits, straight off a number CoinGecko published on that day. So the chart says
 * alt share, and the copy says alt share, and neither of them says breadth.
 *
 * @param domHistory  [{ d:'YYYY-MM-DD', btcDom, ethDom, totalMcap }] — the blob
 *                    alt-scan carries through from `alt_dom_history`
 * @param opts        { now, minSamples, windowDays }
 *
 * The window is bounded by DATES and not by a sample count, for the reason
 * season.js gives: after one cron outage `slice(-30)` reaches back two months
 * and calls the result a 30-day move.
 */
export function altShareSeries(domHistory, { now = null, minSamples = MIN_DOM_SAMPLES, windowDays = DOM_WINDOW_DAYS } = {}) {
  const refuse = (reason, extra = {}) => ({
    ok: false, reason, points: [], days: 0, samples: 0, spanDays: null,
    first: null, last: null, changePctPts: null, trend: 'unknown',
    altMcapChangePct: null, latestAgeDays: null, ...extra,
  })

  if (!Array.isArray(domHistory) || domHistory.length === 0) {
    return refuse(`no dominance history stored yet — 0 of ${minSamples} days needed. The alt-watch cron writes one row per calendar day and nothing can backfill a day it missed`)
  }

  // Same sanitiser as alts.mjs's isDominanceRow: a row without a date or a
  // dominance is not history, and a half-written blob must not be counted as a
  // day that was sampled.
  const seen = new Set()
  const clean = []
  for (const r of domHistory) {
    if (!r || typeof r.d !== 'string' || !Number.isFinite(r.btcDom)) continue
    if (seen.has(r.d)) continue         // one row per calendar day, first wins
    seen.add(r.d)
    clean.push(r)
  }
  clean.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
  const days = clean.length
  if (days === 0) {
    return refuse(`${domHistory.length} stored row${domHistory.length === 1 ? '' : 's'} carried no date and dominance pair — nothing in the history is usable`)
  }

  const newestMs = Date.parse(`${clean[days - 1].d}T00:00:00Z`)
  const window = Number.isFinite(newestMs)
    ? clean.filter((s) => {
      const t = Date.parse(`${s.d}T00:00:00Z`)
      return !Number.isFinite(t) || t > newestMs - windowDays * 86_400_000
    })
    : clean.slice(Math.max(0, days - windowDays))

  const points = window.map((s) => {
    const altShare = 100 - s.btcDom
    const exBigTwo = Number.isFinite(s.ethDom) ? 100 - s.btcDom - s.ethDom : null
    return {
      d: s.d,
      btcDom: s.btcDom,
      altShare,
      exBigTwo,
      totalMcap: Number.isFinite(s.totalMcap) ? s.totalMcap : null,
      // A cap we cannot compute stays null. Multiplying a share by a missing
      // total to get 0 would draw a market that vanished on the day one field
      // of one row failed to write.
      altMcap: Number.isFinite(s.totalMcap) ? (s.totalMcap * altShare) / 100 : null,
    }
  })

  const spanDays = spanDaysOf(window)
  const latestAgeDays = Number.isFinite(now) && Number.isFinite(newestMs)
    ? Math.floor((now - newestMs) / 86_400_000)
    : null

  if (window.length < minSamples) {
    const inside = window.length === days
      ? `${days} of ${minSamples} stored days needed`
      : `only ${window.length} of ${days} stored days fall inside the last ${windowDays}, and ${minSamples} recent ones are needed`
    return refuse(`alt share over time unknown — ${inside}`, {
      points, days, samples: window.length, spanDays, latestAgeDays,
    })
  }

  const first = points[0].altShare
  const last = points[points.length - 1].altShare
  const changePctPts = last - first
  // The mirror of season.js's dominance trend, with its threshold: alt share
  // rising IS BTC dominance falling, so a different cut here would let the two
  // cards on this tab disagree about one series.
  const trend = changePctPts > DOM_FLAT_PTS ? 'rising' : changePctPts < -DOM_FLAT_PTS ? 'falling' : 'flat'

  const capA = points[0].altMcap
  const capB = points[points.length - 1].altMcap
  const altMcapChangePct = Number.isFinite(capA) && capA > 0 && Number.isFinite(capB)
    ? ((capB / capA) - 1) * 100
    : null

  return {
    ok: true, reason: null, points, days, samples: window.length, spanDays,
    first, last, changePctPts, trend, altMcapChangePct, latestAgeDays,
  }
}

/** Calendar days between the first and last sample — the span the change was
 *  measured across, which is not the number of readings inside it. */
function spanDaysOf(window) {
  if (!Array.isArray(window) || window.length === 0) return null
  const a = Date.parse(`${window[0]?.d}T00:00:00Z`)
  const b = Date.parse(`${window[window.length - 1]?.d}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 86_400_000)
}

/* ══ 4. what to look at first ═══════════════════════════════════════════════ */

/**
 * The best-scoring rows inside each requested band.
 *
 * A band with nothing in it is RETURNED, empty, rather than dropped. "Nothing is
 * igniting right now" is a reading of the market and it is one of the more
 * useful ones; a pane that silently omits the heading says the same thing by
 * saying nothing, which is indistinguishable from a render that failed.
 */
export function bandLeaders(rows, { bands = ACTIONABLE_BANDS, perBand = 3 } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const n = Math.max(1, Math.floor(Number.isFinite(perBand) ? perBand : 3))
  return bands.map((band) => {
    const inBand = list.filter((r) => r?.band === band)
    return { band, meaning: BAND_MEANING[band] ?? null, n: inBand.length, rows: inBand.slice(0, n) }
  })
}

/* ══ shared formatting — kept here so the lib stays pure and import-free ════ */

/**
 * "2h 10m ago" — the age of a baseline, in the coarsest unit that is still
 * honest. Null for a non-finite span, because "0m ago" about an unknown gap is
 * the same class of lie as a neutral default in a score.
 */
export function spanLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'under a minute'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const rem = min % 60
  if (h < 24) return rem === 0 ? `${h}h` : `${h}h ${rem}m`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh === 0 ? `${d}d` : `${d}d ${rh}h`
}

function signed(x, dp = 1) {
  if (!Number.isFinite(x)) return '—'
  return `${x >= 0 ? '+' : ''}${x.toFixed(dp)}`
}
