// THE ALTS READ — one 0–10 number for "is now a time to be putting money into
// alts", and the four answers that go with it.
//
// WHY THIS FILE EXISTS. The tab already computed everything and told you
// nothing. Six surfaces of equal weight — a regime score, a since-diff, a
// distribution, a shortlist, a filter row and a ranked board — every one of them
// honest, and not one of them answering "so what" by itself. You assembled the
// read out of parts, or you left without one. That is the same failure the
// cockpit had and this is the same fix: ONE card that states a score and answers
// what to think, in rows, each carrying the number you would act on, with
// everything else demoted to evidence. See components/TradeCard.jsx.
//
// Pure. No fetch, no DOM, no Date.now(). It computes NOTHING about the market
// itself: season.js measures the regime, screen.js scores and bands the coins,
// pulse.js counts the bands and diffs the boards. This file only weighs what
// those three already produced, which is what makes the guarantee below possible.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE GUARANTEE, WHICH IS window.js's AND IS THE WHOLE POINT:
// THE HEADLINE CANNOT DISAGREE WITH THE BOARD, BECAUSE THEY ARE THE SAME
// COMPUTATION.
//
// The "what is starting" count on the card is read straight out of
// bandDistribution() — the same call, on the same `rows` array the board
// renders, that draws the distribution strip. It is not a second count over the
// same coins; there is no second count to drift. The named coins are those rows,
// filtered on the same `band === 'starting'` the board's own band filter uses,
// in the order screenUniverse already sorted them. And the regime half is
// season.js's published score, untouched — this file never re-reads breadth,
// dominance or fear & greed, so it cannot form a second opinion about them.
//
// A worked consequence, and it is a THEOREM about the arithmetic rather than a
// promise: 8 of 10 is unreachable without at least one `starting` row on the board
// (the regime is worth 6 and the drift tilt 1, so 7 is the ceiling with an empty
// `starting` band). The card can never say "yes" over a board with nothing on it.
// read.test.js proves that by search rather than by assertion.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TEN POINTS — deliberately simple enough to verify with a phone calculator.
// parts[] always sums to `score` before the 0–10 clamp.
//
//   REGIME ......... 0–6    round(6 × season score ÷ 100)
//     Is anything rotating at all. It is the biggest block because it is the
//     question the operator asks first and the only one that changes what a
//     good-looking coin is WORTH: a 90-score setup in `risk_off` is a 90-score
//     setup that bleeds with everything else. 58/100 is 3 points and you can
//     check that by eye.
//
//   STARTING ....... 0–3    `starting` rows on the board
//                           ≥5 → 3 · ≥2 → 2 · ≥1 → 1 · 0 → 0
//     Is there anything to actually buy. This is the cliff, not a gradient: the
//     difference between a tape that would pay you and a tape that would pay you
//     for something. `starting` and not `warming` because `starting` is the one
//     band that requires a completed event — a break of the prior 6-day high —
//     rather than a shape that might resolve either way.
//
//   DRIFT ......... −1..+1  the board's direction since YOUR last stored board
//     forward (ignitions, band steps up, fresh breaks, score climbs) minus
//     backward (band steps back, score slides), by a margin of 2 or more.
//     A margin, because one event of difference across two hundred rows is
//     noise. `enter`/`exit` are excluded: they are rank moves in a fixed-length
//     head of the board, so they are zero-sum by construction and would count a
//     reshuffle as direction.
//
// A TILT CAN MOVE THE READ BY ONE RUNG AT A BOUNDARY, AND THAT IS INTENDED. A
// board deteriorating at 8 is not the same market as one improving at 7.
//
// WHEN THERE IS NO EARLIER BOARD THE DRIFT PART IS NOT EMITTED AT ALL, rather
// than scored zero — the absence of a comparison is not evidence that the board
// is flat. The cost is stated out loud rather than hidden: the top of the scale
// is 9 on a first visit. It cannot change the call, because 8, 9 and 10 are the
// same rung. This is window.js's treatment of a missing mNAV, for its reason.
//
// ─────────────────────────────────────────────────────────────────────────────
// THREE REFUSALS, THREE DIFFERENT SENTENCES, AND TWO OF THEM STILL ANSWER MOST
// OF THE CARD.
//
//   NO SCAN     the freshness ladder refused the payload. Nothing is computable;
//               the card is an empty state with a Retry.
//   NO BOARD    a live scan that ranked no rows. Same treatment, different words.
//   NO REGIME   season.js declined to publish a score (under half its points had
//               an input, or breadth could not be counted at all). The regime is
//               6 of the 10 here, so no number is published — but "what is
//               starting", "since you last looked" and "what would make me
//               wrong" are all still measured, and they are still answered. A
//               refusal that blanks the facts it DID measure is its own kind of
//               dishonesty.
//
// AND THE BAND IS ONLY NAMED WHERE IT CANNOT MOVE — season.js's rule, carried
// through. season.js ships `bounds: { low, high }`: this same market with every
// unread gauge at zero, and with every one of them at its max. Those bounds run
// through the same × 6 ÷ 100 as the score, so this file gets a band of its own:
//
//     low  = round(6 × season.bounds.low ÷ 100)  + starting + drift
//     high = round(6 × season.bounds.high ÷ 100) + starting + drift
//
// `score` is inside [low, high] by construction (season.js proves the same of
// its own), so when both ends land in one rung, the call named here is EXACTLY
// the call the fully measured read would have named, whatever the missing gauges
// turn out to say. When they straddle a boundary the NUMBER stands and no call
// is named: the hot end would be permission this read did not earn, and the cold
// end a warning it did not measure.
//
// SEASON CAN REFUSE TO NAME A REGIME WHILE THIS FILE STILL NAMES A CALL, AND
// THAT IS NOT A DISAGREEMENT. The two ladders have different boundaries — 22/40/
// 55/72 out of 100 there, 3/6/8 out of 10 here, with two more terms added — so a
// band of uncertainty that crosses a rung on one can sit inside a rung on the
// other. Each names its own only where its own bounds pin it, which is the rule
// both files are built on. The card prints season's label verbatim in the row
// note, refusal wording and all ("Majors rotating to Alt season"), so the
// operator sees exactly which of the two was able to commit.
//
// ─────────────────────────────────────────────────────────────────────────────
// THERE IS NO SIZE ROW HERE, ON PURPOSE. How much to put on is a per-coin
// question — it needs a stop, a spread and a day's volume — and altrisk.js
// answers it in the detail pane. A market-wide position size would be the one
// number on this card that nothing computed.
import { bandDistribution, spanLabel } from './pulse.js'

const MAX = 10
const REGIME_MAX = 6
const START_MAX = 3

/** First threshold met wins, exactly like screen.js's ladders. */
const START_LADDER = [[5, 3], [2, 2], [1, 1]]

/** How many events of difference stop being noise. See the header. */
const DRIFT_MARGIN = 2

const BAND = [
  { min: 8, key: 'go', label: 'Yes', plain: 'Conditions are there. This is the part of the cycle alt risk actually gets paid in.' },
  { min: 6, key: 'armed', label: 'Selectively', plain: 'Half the case is on the board. The rows below say which half is missing.' },
  { min: 3, key: 'building', label: 'Not yet', plain: 'Not enough of either half to act on. This is something to watch, not something to size.' },
  { min: 0, key: 'no', label: 'Stand down', plain: 'No case for alt risk in this pass. Cash is the position.' },
]

const bandAt = (n) => BAND.find((b) => n >= b.min) ?? BAND[BAND.length - 1]

/**
 * @param season     seasonRead() result, or null
 * @param rows       screenUniverse() output — THE SAME ARRAY THE BOARD RENDERS
 * @param delta      boardDelta() result, or null
 * @param scanState  'live' | 'stale' | 'dead' — the STATE STRING off freshness(),
 *                   never the object. `freshness()` returns a new literal per
 *                   call and its `label` re-renders every ten seconds, so a
 *                   memoised read holding either would either recompute on the
 *                   clock or print a frozen age. CoinDetail's read memo keeps the
 *                   same rule for the same reason; the live age is on the chip.
 * @param live       the panel's payload gate — false means the ladder refused it
 */
export function altsRead({ season = null, rows = null, delta = null, scanState = null, live = true } = {}) {
  const board = Array.isArray(rows) ? rows : []
  // ONE call, on the board's own rows. The panel renders `read.dist` into the
  // distribution strip, so the count under "what is starting" and the count in
  // the strip are not two numbers that agree — they are one number.
  const dist = bandDistribution(board)

  const ign = ignitionRead(board, dist)
  const drift = driftRead(delta)
  const regime = regimeRead(season)
  const ctx = { dist, ign, drift, regime, season, scanState }

  if (!live) return refuse(NO_SCAN, ctx)
  if (dist.total === 0) return refuse(NO_BOARD, ctx)

  if (!regime.scored) {
    // The regime is 6 of the 10, so there is no number. Everything else on the
    // card was measured and still speaks — see the header.
    return published({
      score: null, low: null, high: null, pinned: false,
      label: 'No read', plain: regime.reason, band: 'unknown', parts: [], ...ctx,
    })
  }

  // THE TILT IS CLAMPED TO THE POINTS THAT EXIST, which is screen.js's rule for
  // its parabolic penalty and it is here for screen.js's reason: without it a
  // −1 against a zero-point read lands as −1, the SCORE gets clamped to 0
  // instead, and parts[] silently stops summing to the number beside it. A table
  // whose whole job is "check this by eye" cannot survive that.
  const earned = regime.points + ign.points
  // `|| 0` is not decoration: Math.max(-1, -0) is -0, and a -0 in parts[] renders
  // as "-0 / 1" in the working table and fails an Object.is comparison in a test.
  const driftPoints = drift.scored ? Math.max(drift.points, -earned) || 0 : 0
  // Everything downstream — the row tone, the facts, the risks — reads the
  // APPLIED tilt, so no surface can quote a −1 the score did not take.
  const driftOut = { ...drift, points: driftPoints, raw: drift.points }

  const parts = [
    { key: 'regime', label: `regime ${regime.score} of 100`, points: regime.points, max: REGIME_MAX },
    { key: 'starting', label: ign.n === 0 ? 'nothing starting' : `${ign.n} starting`, points: ign.points, max: START_MAX },
  ]
  if (drift.scored) {
    parts.push({
      key: 'drift',
      label: driftPoints > 0 ? 'board improving' : driftPoints < 0 ? 'board deteriorating' : 'board flat',
      points: driftPoints, max: 1,
    })
  }

  // 6 + 3 + 1 is exactly 10, so nothing is ever clamped at the top; the floor is
  // a true 0 because of the clamp above rather than in spite of it.
  const score = parts.reduce((s, p) => s + p.points, 0)
  // The bounds move ONLY with the regime — starting and drift are counts of
  // things that either happened or did not, and there is no unread half of them.
  const low = clamp(regime.low + ign.points + driftPoints)
  const high = clamp(regime.high + ign.points + driftPoints)
  const lowRung = bandAt(low)
  const highRung = bandAt(high)
  const pinned = lowRung === highRung

  return published({
    score, low, high, pinned,
    label: pinned ? lowRung.label : `${lowRung.label} to ${highRung.label}`,
    plain: pinned ? lowRung.plain : spanPlain(score, regime, low, high, lowRung, highRung),
    band: pinned ? lowRung.key : 'unknown',
    parts, ...ctx, drift: driftOut,
  })
}

/* ══ the three refusals ═════════════════════════════════════════════════════ */

const NO_SCAN = {
  label: 'No read',
  plain: 'The freshness ladder refused this scan, and every number on this tab comes from that one pass. Nothing here is read from a remembered board.',
}
const NO_BOARD = {
  label: 'No read',
  plain: 'The scan came back with no ranked rows, so there is no board to weigh a regime against.',
}

/** Neither of these two can answer any row, so the card falls back to an empty
 *  state. `dist`, `ign` and `drift` are still returned — all three are zeroed
 *  measurements of an absent board, and the component reads `total` to decide
 *  which sentence to draw. */
function refuse(kind, ctx) {
  return published({
    score: null, low: null, high: null, pinned: false,
    label: kind.label, plain: kind.plain, band: 'unknown', parts: [], ...ctx,
  })
}

/* ══ the three components of the score ══════════════════════════════════════ */

/**
 * The regime half, straight off season.js's published score — never re-derived.
 *
 * `scored: false` carries season.js's OWN refusal wording rather than a
 * paraphrase, for the reason SinceCard gives about pulse.js's reasons: a second
 * copy of a sentence about arithmetic is a second thing to keep true.
 */
function regimeRead(season) {
  // THREE SENTENCES FOR THREE PLACES, AND THEY ARE DIFFERENT LENGTHS ON PURPOSE.
  // `reason` is the headline paragraph and it carries season.js's own words in
  // full; `short` is the one-line version the row note and the risk line use.
  // The first draft used `reason` in all three, so a refused read printed the
  // same 60-word paragraph as the headline, as the note under the first row, AND
  // as the note under the last one — three copies of one sentence on a card whose
  // whole job is to be read at a glance.
  if (!season) {
    return {
      scored: false, score: null, points: 0, low: 0, high: REGIME_MAX,
      coverage: null, of: null, unread: null, missing: [], label: null,
      reason: 'No regime read was run for this pass, and the regime is 6 of the 10 points here — so no number is published rather than one built out of the other 4.',
      short: 'no regime read was run for this pass',
    }
  }
  if (!Number.isFinite(season.score)) {
    const of = Number.isFinite(season.measured?.of) ? season.measured.of : 0
    return {
      scored: false, score: null, points: 0, low: 0, high: REGIME_MAX,
      coverage: of / 100, of, unread: 100 - of, missing: missingNames(season),
      label: season.label ?? null,
      // OUR CLAUSE, THEN SEASON'S SENTENCE — and our clause deliberately does
      // not restate the arithmetic season is about to state. The first draft
      // did, and the headline read "only 40 of its 100 points had an input,
      // which is under half. … Under half of this read had an input — 40 of its
      // 100 points."
      reason: of > 0
        // "the regime read", not "season.js" — a filename on screen tells an
        // operator nothing and reads like a stack trace.
        ? `The regime is 6 of these 10 points and the regime read published no score, so no number is published off the other 4 either. ${season.plain}`
        : `No regime score at all — ${season.plain}`,
      short: of > 0
        ? `${season.label ?? 'no regime'} — no score off ${of} of 100 points measured, which is under half`
        : `${season.label ?? 'no regime'} — breadth could not be counted at all`,
    }
  }
  const of = Number.isFinite(season.measured?.of) ? season.measured.of : 100
  const bLow = Number.isFinite(season.bounds?.low) ? season.bounds.low : season.score
  const bHigh = Number.isFinite(season.bounds?.high) ? season.bounds.high : season.score
  return {
    scored: true,
    score: season.score,
    points: scale(season.score),
    low: scale(bLow),
    high: scale(bHigh),
    boundsPts: { low: bLow, high: bHigh },
    coverage: of / 100,
    of,
    unread: 100 - of,
    missing: missingNames(season),
    label: season.label ?? null,
    reason: null, short: null,
  }
}

/** The one arithmetic this file owns, and it is one line so it can be checked. */
const scale = (score100) => Math.round((REGIME_MAX * score100) / 100)

function missingNames(season) {
  return (season?.parts ?? []).filter((p) => p?.points == null).map((p) => p?.label).filter(Boolean)
}

/**
 * The board half. The COUNTS come out of `dist` — the same object the
 * distribution strip is drawn from — and the NAMES out of the rows behind it,
 * filtered on the field the board's own band filter tests. See the header.
 */
function ignitionRead(board, dist) {
  const countOf = (b) => dist.bands.find((x) => x.band === b)?.n ?? 0
  const n = countOf('starting')
  const starting = board.filter((r) => r?.band === 'starting')
  const thin = starting.filter((r) => r?.flags?.thinLiquidity || r?.flags?.newListing)
  return {
    n,
    points: ladder(n, START_LADDER),
    // screenUniverse already sorted by score descending, so "the first three"
    // is "the best three" without a second sort that could order them otherwise.
    top: starting.slice(0, 3),
    thin: thin.length,
    warming: countOf('warming'),
    underway: countOf('underway'),
    total: dist.total,
    actionable: dist.actionable,
  }
}

/**
 * The direction half. Zero when the two boards agree inside the margin — which
 * is a measurement — and NOT SCORED AT ALL when there is no earlier board, which
 * is not. Those two states are opposite claims and pulse.js already keeps them
 * apart; this keeps them apart in the score as well.
 */
function driftRead(delta) {
  if (!delta || delta.ok !== true) {
    return {
      scored: false, points: 0, forward: null, backward: null, events: [],
      span: null, compared: null,
      reason: delta?.reason ?? 'no board diff was run for this pass, so there is nothing to compare against',
    }
  }
  const c = delta.counts ?? {}
  const n = (k) => (Number.isFinite(c[k]) ? c[k] : 0)
  const forward = n('ignite') + n('advance') + n('break') + n('climb')
  const backward = n('fade') + n('slide')
  const points = forward - backward >= DRIFT_MARGIN ? 1
    : backward - forward >= DRIFT_MARGIN ? -1 : 0
  return {
    scored: true, points, forward, backward,
    events: Array.isArray(delta.events) ? delta.events : [],
    span: spanLabel(delta.spanMs),
    compared: Number.isFinite(delta.compared) ? delta.compared : null,
    reason: null,
  }
}

/* ══ the four answers, written here and not in the component ════════════════
 *
 * Same rule pulse.js keeps for its event sentences: the wording and the numbers
 * it quotes are one decision, and splitting them is how a card ends up
 * describing an arithmetic it did not do. It is also the only way the rows can
 * be tested without a DOM.
 */
function buildRows({ score, band, label, regime, ign, drift, dist, wrong }) {
  const rows = []

  rows.push({
    key: 'look',
    k: 'Look at alts',
    v: score == null ? 'No read' : label,
    tone: band === 'go' ? 'go' : band === 'armed' ? 'warn' : 'flat',
    note: regime.scored
      ? `${regime.label} — ${regime.score} of 100, measured on ${regime.of} of those 100 points${regime.of >= 100 ? ', nothing dropped' : ''}`
      // The SHORT form: the headline above this row already carries season.js's
      // full refusal, and repeating a 60-word paragraph two lines under itself
      // is how a card teaches you to stop reading it.
      : regime.short,
  })

  rows.push({
    key: 'starting',
    k: "What's starting",
    v: ign.n === 0 ? 'nothing starting' : `${ign.n} starting`,
    tone: ign.n > 0 ? 'go' : 'flat',
    note: ign.n === 0
      ? `${ign.warming} warming and ${ign.underway} underway out of ${ign.total} ranked — but nothing took out its prior 6-day high in this pass`
      : `${ign.top.map((r) => `${r.symbol} ${r.score}`).join(' · ')}${ign.n > ign.top.length ? ` and ${ign.n - ign.top.length} more` : ''} — best first, out of ${ign.total} ranked`,
  })

  rows.push({
    key: 'since',
    k: 'Since last look',
    v: !drift.scored ? 'no baseline'
      : drift.events.length === 0 ? 'nothing moved'
        : `${drift.forward} forward, ${drift.backward} back`,
    tone: !drift.scored ? 'flat' : drift.points > 0 ? 'go' : drift.points < 0 ? 'warn' : 'flat',
    note: !drift.scored
      ? drift.reason
      : drift.events.length === 0
        ? `${drift.compared} coin${drift.compared === 1 ? '' : 's'} were on both boards across ${drift.span ?? 'an unknown span'} of tape, in the same bands and within 10 points of the same scores`
        : `${drift.events.slice(0, 2).map((e) => `${e.symbol} ${e.text}`).join(' · ')} — across ${drift.span ?? 'an unknown span'} of tape`,
  })

  // AMBER IS NOT SPENT HERE, EVER. This row is present on every single visit,
  // and a permanent warning colour is how a screen teaches you to ignore the
  // colour that also means "your stop is hit". The words carry it.
  //
  // AND IT NEVER REPEATS THE ROW AT THE TOP OF THE CARD. On a read with no
  // regime score, `no_regime` is the highest-weight fragility AND the note under
  // "Look at alts" — so this row showed the same sentence twice on one card,
  // four lines apart. It skips to the next real fragility, and only falls back
  // to repeating when there is nothing else wrong to report.
  rows.push({
    key: 'wrong',
    k: 'Wrong if',
    v: wrong ? wrong.short : 'nothing thin',
    tone: 'flat',
    note: wrong
      ? wrong.text
      : `Every input this read uses was measured: all 100 regime points, a known dominance trend, ${dist.total} ranked rows and a live baseline.`,
  })

  return rows
}

/**
 * WHAT WOULD MAKE ME WRONG — every entry a computed fragility, and the FIRST one
 * is what the last row of the card shows. Nothing here is a standing disclaimer:
 * a line appears because a specific input was thin in THIS pass, and it says
 * which and by how much.
 *
 * THE ORDER IS HOW FAR THE THING COULD MOVE THE READ, and it was wrong the first
 * time. `no_baseline` was first, so on every visit that had not stored a board —
 * which is every first visit, on every device — the one fragility on the card
 * was the least interesting one available, and a 13-minute-old scan sat behind
 * it unmentioned. A stale scan invalidates every number here at once; an unread
 * regime gauge moves the score; an untradeable `starting` row changes what the
 * shortlist is worth. A missing baseline only costs the tilt, and the row above
 * it already says so in its own words.
 */
function buildRisks({ regime, ign, drift, dist, scanState, low, high, season }) {
  const out = []

  if (!regime.scored) {
    out.push({ key: 'no_regime', short: 'no regime score', text: regime.short })
  }

  if (scanState === 'stale') {
    out.push({
      key: 'stale_scan',
      short: 'scan is stale',
      text: 'The scan is past its live window — the chip at the top of this card says how far past. Every number here is that old, the band counts included.',
    })
  }

  if (regime.scored && regime.unread > 0) {
    out.push({
      key: 'regime_thin',
      short: `${regime.unread} regime points unread`,
      text: `${regime.unread} of the regime's 100 points had no input${regime.missing.length ? ` (${regime.missing.join('; ')})` : ''}` +
        `${low != null && high != null && low !== high ? `, which puts this read anywhere from ${low} to ${high} out of 10` : ''}.`,
    })
  }

  // The dominance series still filling is the input that is thin for a week
  // after every deploy, and it is worth naming with its day count. But when the
  // regime WAS scored, `regime_thin` above already names it — season.js's own
  // part label is "dominance trend unknown (2 of 7 stored days needed)" — and
  // printing the same fact twice under "what would make me wrong" is how a list
  // of real fragilities starts reading like boilerplate. So this fires only
  // where the line above cannot: on a read with no regime score at all.
  const dom = season?.dominance
  if (!regime.scored && dom && dom.trend === 'unknown') {
    out.push({
      key: 'dominance_filling',
      short: 'dominance still filling',
      text: `The dominance trend is unknown — ${dom.days ?? 0} of the 7 stored days it needs, so 20 of the regime's 100 points are not in this read. Rotation is measured by breadth alone until the cron has a week.`,
    })
  }

  if (ign.thin > 0) {
    out.push({
      key: 'thin_starts',
      short: `${ign.thin} of ${ign.n} starts are thin`,
      text: `${ign.thin} of the ${ign.n} starting rows are either under $250k of daily volume or have less than a month of history, so "${ign.n} starting" is not ${ign.n} names you can size.`,
    })
  }

  if (!drift.scored) {
    out.push({
      key: 'no_baseline',
      short: 'no earlier board',
      text: `${cap(drift.reason)} — so the drift tilt is left out of the score rather than scored zero, and 9 is the top of the scale on this pass.`,
    })
  }

  if (dist.total > 0 && dist.total < 40) {
    out.push({
      key: 'small_board',
      short: `only ${dist.total} rows ranked`,
      text: `Only ${dist.total} rows survived the screen in this pass, so every band count above rests on a small board.`,
    })
  }

  return out
}

/* ══ assembly ═══════════════════════════════════════════════════════════════ */

function published({ score, low, high, pinned, label, plain, band, parts, regime, ign, drift, dist, season, scanState }) {
  const risks = buildRisks({ regime, ign, drift, dist, scanState, low, high, season })
  const answering = dist.total > 0
  const wrong = answering ? pickWrong(risks, regime) : null
  const rows = answering
    ? buildRows({ score, band, label, regime, ign, drift, dist, wrong })
    : []   // nothing to answer with — the component draws an empty state

  return {
    score, max: MAX, band, label, plain,
    bounds: { low, high }, pinned,
    parts, rows, risks,
    // WHICH risk the "Wrong if" row is showing, so the card can put the REST in
    // the disclosure without guessing. `risks.slice(1)` would be wrong twice: on
    // a refused read the row skips `no_regime` (see buildRows), and on a card
    // with no rows at all nothing has been shown yet, so every risk is still
    // owed to the reader.
    wrongKey: wrong?.key ?? null,
    facts: buildFacts({ score, regime, ign, drift, low, high, pinned, dist }),
    regime, ignition: ign, drift, dist,
  }
}

/**
 * The fragility the last row shows: the highest-weight one that is not already
 * the note under the FIRST row. See buildRows.
 */
function pickWrong(risks, regime) {
  const eligible = regime.scored ? risks : risks.filter((r) => r.key !== 'no_regime')
  return eligible[0] ?? risks[0] ?? null
}

/** The arithmetic trail, one line per step, for the disclosure. Every number in
 *  it appears somewhere above it on the card — this is the working, not a
 *  second set of facts. */
function buildFacts({ score, regime, ign, drift, low, high, pinned, dist }) {
  const facts = []
  if (regime.scored) {
    facts.push(`regime ${regime.score} of 100 → ${regime.points} of ${REGIME_MAX} (round(${REGIME_MAX} × ${regime.score} ÷ 100))`)
  } else if (regime.reason) {
    facts.push(regime.reason)
  }
  if (dist.total > 0) {
    facts.push(`${ign.n} starting of ${dist.total} ranked rows → ${ign.points} of ${START_MAX} (≥5 → 3 · ≥2 → 2 · ≥1 → 1 · 0 → 0)`)
  }
  if (drift.scored) {
    const clamped = Number.isFinite(drift.raw) && drift.raw !== drift.points
    facts.push(`${drift.forward} forward event${drift.forward === 1 ? '' : 's'} against ${drift.backward} back` +
      `${clamped ? `, and a ${drift.raw} tilt clamped to the ${drift.points === 0 ? 'nothing' : drift.points} this read has to give back`
        : drift.points === 0 ? `, inside the margin of ${DRIFT_MARGIN}` : ''}` +
      ` → ${drift.points > 0 ? '+' : ''}${drift.points}`)
  } else {
    facts.push('no earlier board, so the drift tilt is not in this score at all — the top of the scale is 9 on this pass, which cannot change the call because 8, 9 and 10 are one rung')
  }
  if (score != null && regime.unread > 0) {
    facts.push(pinned
      ? `the ${regime.unread} unread regime points put the fully measured read of this same market between ${low} and ${high} out of 10 — the same call at both ends, so it holds whatever those gauges would have said`
      : `the ${regime.unread} unread regime points put the fully measured read of this same market between ${low} and ${high} out of 10, which straddles a boundary — so the number stands and no call is named off it`)
  }
  return facts
}

function spanPlain(score, regime, low, high, lowRung, highRung) {
  return `${score} out of 10 assumes the ${regime.unread} regime points we could not read look like the ${regime.of} we could. They could land the full read anywhere from ${low} to ${high} — ${lowRung.label} through ${highRung.label} — so the number stands and no call is named off it.`
}

/* ══ local helpers ══════════════════════════════════════════════════════════ */

function ladder(value, table) {
  if (!Number.isFinite(value)) return 0
  for (const [min, points] of table) if (value >= min) return points
  return 0
}

function clamp(n) { return Math.max(0, Math.min(MAX, n)) }

function cap(s) {
  const t = String(s ?? '')
  return t.charAt(0).toUpperCase() + t.slice(1)
}
