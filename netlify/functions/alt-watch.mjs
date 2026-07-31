// Scheduled alt sentinel (every 2 hours, netlify.toml). It does two jobs, and
// the first one is the reason it exists at all.
//
// 1. IT MANUFACTURES DOMINANCE HISTORY. CoinGecko's free tier has a /global
//    endpoint that returns today's BTC dominance and nothing else — there is no
//    history endpoint at any price we are paying. So "is dominance falling?",
//    which is the single most load-bearing question in an alt-season read, is
//    unanswerable unless something writes down today's number every day. This
//    is that something. Nothing else in the system can backfill a day this pass
//    misses, which is why every failure path below still writes what it can.
//
// 2. It screens the watchlist and alerts on STATE TRANSITIONS only — a band
//    change, a trigger firing, an invalidation breaking, or the directive
//    reaching one of the two verdicts this pass can reach — deduped for 6 hours.
//    A sentinel that re-sends the same "still igniting" every 2 hours gets muted
//    inside a day, and a muted sentinel is worse than none: it is a sentinel you
//    believe you have. See transitionOf() for why each of those is an EDGE and
//    ACTIONABLE for why that list is short.
//
// Modelled on watch-snapshot.mjs, including the rule that matters most here:
// it must NEVER throw. A scheduled function that 500s writes no dominance row,
// and a hole in that series is permanent.
import { json, store, sendTelegram, telegramConfigured } from '../shared/util.mjs'
import { altGlobal, altUniverse, mergeDominanceSample, isDominanceRow, altWatchGate } from '../shared/alts.mjs'
import { seasonRead } from '../../apps/macro/src/lib/alts/season.js'
import { screenUniverse } from '../../apps/macro/src/lib/alts/screen.js'
import { altDirective } from '../../apps/macro/src/lib/alts/directive.js'

const DOM_KEY = 'alt_dom_history'
const WATCHLIST_KEY = 'alt_watchlist'
const ALERT_KEY = 'alt_alert_state'

const DEDUPE_MS = 6 * 3600 * 1000
const MAX_ALERT_LINES = 12

// The directive actions worth a phone buzz, AND THE ONLY ONES THIS PASS CAN
// PRODUCE. Those used to be two different lists, which is the trap altrisk.js's
// header names out loud: a value the contract lists but the code can never
// produce is a bug waiting for a reader.
//
// safeDirective() below calls altDirective with no sizing plan, no position, no
// precedent and no candles — deliberately, see scanWatchlist — and directive.js's
// ladder gates ENTER/STARTER/ARM/ADD on a computed size and EXIT/TRIM on a held
// position. So six of the ten rungs are unreachable from here by construction,
// and listing four of them made this set read as a working alert on states that
// had never fired once. An exhaustive sweep over every band × score × flag ×
// level × season combination of this exact call shape produces NO_DATA, AVOID,
// WATCH and STALK and nothing else; the sweep is pinned in directive.js's test
// so this set cannot quietly go stale again.
//
// GIVING THE PASS WHAT THE OTHER SIX NEED WAS THE ALTERNATIVE, AND IT DOES NOT
// WORK: EXIT and TRIM need a held alt position, and this system has no alt
// position book at all; ENTER needs precedent.ok, which needs 250+ daily candles
// PER COIN — 60 upstream calls inside a 30-second scheduled budget, which is not
// a sentinel, it is an outage; ARM and STARTER need a sizing plan, whose stop on
// a coin with no candles is a flat percentage this digest would then quote as
// "the plan", against this file's rule that it never quotes a level it did not
// compute.
//
// So the set is honest about the two verdicts this pass can reach, and the alert
// that actually matters — something is popping off while you are away — is
// carried by the LEVEL transitions below instead, which the 7-day sparkline this
// pass already holds is enough to measure.
//
//   AVOID — a coin you starred became one you should not buy: untradeable
//           liquidity, or a parabolic chase. A verdict change, not a nudge.
//   STALK — the earliest opportunity rung reachable here: a base forming under a
//           watchlist row. It fires on a score crossing inside an unchanged
//           band, so it is not just a restatement of the band change.
export const ACTIONABLE = new Set(['AVOID', 'STALK'])

export default async (req) => {
  try {
    // WHO MAY SPEND THE QUOTA. This used to be watch-snapshot's posture — the
    // scheduler cannot carry a token, so the pass always ran and only the
    // response BODY was gated on the token. That works there because its
    // upstreams are not the constrained resource. Here they are: /api/* is
    // mapped straight through in netlify.toml, and every hit spends two
    // CoinGecko calls against a keyless tier of roughly 10-30/min, so anyone who
    // could reach the deploy could hold that quota in 429 and pin the whole Alts
    // tab on its stale cache.
    //
    // altWatchGate admits a signed-in operator without limit, or one POST per
    // 2-hour cron slot — see its header in alts.mjs for why a slot rather than a
    // rate limit (a limiter can sit in front of the cron's own fire and starve
    // the dominance series, and a missed day of that series is permanent).
    // Blobs failures fail open there, for the same reason.
    const s = store()
    const now = Date.now()
    const gate = await altWatchGate(req, s, now)
    if (!gate.allowed) return json({ ok: true, skipped: gate.reason })
    const authed = gate.authed

    // ONE global call, feeding both jobs. The dominance row and the season read
    // want the same numbers, and this function runs 12 times a day against the
    // same quota the dashboard is polling.
    let global = null
    let globalError = null
    try {
      global = await altGlobal()
    } catch (e) {
      globalError = msg(e)
    }

    // The history the season read wants is the one this pass just wrote, so it
    // is handed straight over rather than read back out of Blobs.
    const dom = await recordDominance(s, global, now, gate.scheduled)
    const watch = await scanWatchlist(s, global, dom.rows, now)

    const summary = { ok: true, dominance: dom.summary, watchlist: watch.summary }
    return json(authed ? { ...summary, globalError, transitions: watch.transitions } : summary)
  } catch (e) {
    // The outer net. Anything that gets here is a bug, not a market condition,
    // and it still must not surface as a failed scheduled invocation.
    console.error('alt-watch failed:', e)
    return json({ ok: false, error: msg(e) })
  }
}

/**
 * Write today's dominance sample. The one-row-per-day merge itself is pure and
 * lives in alts.mjs (mergeDominanceSample) so it can be tested; what stays here
 * is the Blobs read-modify-write around it.
 *
 * The date key is UTC, not local. A DST shift in a local zone produces either a
 * 23-hour day — one row skipped — or a 25-hour one, two passes writing what the
 * series believes are two different days. A duplicated day silently miscounts
 * every "N days of history" claim built on top of it, and season.js gates its
 * dominance trend on exactly that count.
 */
async function recordDominance(s, global, now, scheduled = true) {
  if (!global) return { summary: { appended: false, reason: 'no global read this pass — nothing to record' }, rows: null }
  try {
    const day = new Date(now).toISOString().slice(0, 10)
    const rows = await s.get(DOM_KEY, { type: 'json' })
    const had = (Array.isArray(rows) ? rows : []).some((r) => r?.d === day)

    // AN OFF-SCHEDULE RUN DOES NOT RESTAMP A DAY THAT ALREADY HAS A ROW.
    // mergeDominanceSample is last-write-wins per calendar day, which is what
    // lets today's row track live dominance as the day goes on — but the value
    // of the series depends on every COMPLETED day settling at the same hour
    // (see its header: that is what makes "-2.1 points in 30 days" a comparison
    // rather than a coincidence). The cron's last pass of a UTC day is 22:00; an
    // operator opening this endpoint at 23:40 would settle that one day at 23:40
    // and skew every window that spans it.
    // Both halves matter: `had` alone would also block the rescue case, so a day
    // the cron missed ENTIRELY can still be written by hand — that is a hole in
    // the series being filled, not a settled row being moved.
    if (had && !scheduled) {
      return { summary: { appended: false, reason: `today's row is already recorded and this is an off-schedule run — not restamping it at a different hour`, day }, rows: Array.isArray(rows) ? rows : null }
    }

    const merged = mergeDominanceSample(rows, {
      d: day,
      btcDom: round(global.btcDominancePct, 3),
      ethDom: round(global.ethDominancePct, 3),
      totalMcap: global.totalMcapUsd,
    })
    await s.setJSON(DOM_KEY, merged)
    return { summary: { appended: true, day, days: merged.length, replacedTodaysSample: had }, rows: merged }
  } catch (e) {
    // The write failed but the series is not lost — the next pass in 2 hours
    // rewrites today's row from scratch. Only a whole missed DAY is permanent.
    return { summary: { appended: false, reason: msg(e) }, rows: null }
  }
}

/**
 * Screen the watchlist and alert on transitions.
 *
 * Deliberately the CHEAP half of the read: the band comes from screenCoin,
 * which needs only the market rows already in hand, and the directive runs
 * without precedent, crowd or per-coin candles. Fetching candles for 60 coins
 * is 60 upstream calls inside a 30-second budget, which is not a sentinel, it
 * is an outage. So the alert says what changed and tells you to open the tab —
 * it never quotes a number it did not compute. The trigger and invalidation it
 * DOES quote are directive.js's sparkline fallback levels, computed from the
 * 7-day series already on the row, and every line that prints one says which
 * basis it came from.
 */
async function scanWatchlist(s, global, domRows, now) {
  const empty = (reason) => ({ summary: { watched: 0, transitions: 0, delivered: false, reason }, transitions: [] })
  try {
    const saved = await s.get(WATCHLIST_KEY, { type: 'json' })
    const entries = Array.isArray(saved?.ids) ? saved.ids.filter((e) => e && typeof e.id === 'string') : []
    if (!entries.length) return empty('watchlist is empty')

    const { universe } = await altUniverse()
    const btcRow = universe.find((r) => r.symbol === 'BTC') || null
    const ethRow = universe.find((r) => r.symbol === 'ETH') || null
    // What this pass just wrote, or — when the dominance write failed — whatever
    // is already stored. Never nothing-because-we-did-not-look.
    const domHistory = domRows?.length ? domRows : await readDomHistory(s)

    // fearGreed and trending are skipped on purpose. Neither can flip a band or
    // an action on its own, and leaving them out halves the CoinGecko quota
    // this pass spends — 12 passes a day share it with a polling dashboard.
    const season = seasonRead({ universe, btcRow, ethRow, global, fearGreed: null, trending: null, domHistory, now })
    const screened = screenUniverse(universe, { btcRow, ethRow, season, now })
    const byId = new Map(screened.map((r) => [r.id, r]))

    const prevState = (await s.get(ALERT_KEY, { type: 'json' })) || {}
    const nextState = {}
    const pending = []
    const transitions = []
    let skipped = 0

    for (const entry of entries) {
      const row = byId.get(entry.id)
      // Not on the board: either outside the top-250 by market cap, or excluded
      // by the screen as a stablecoin/wrapper. Both are normal, neither is an
      // alert, and carrying the old state forward means the coin picks up where
      // it left off if it climbs back in.
      if (!row) { skipped++; if (prevState[entry.id]) nextState[entry.id] = prevState[entry.id]; continue }

      const directive = safeDirective(row, season, now)
      const prev = prevState[entry.id]
      // The state this pass measured. The two level flags come straight off
      // directive.js's own `levels` rather than being recompared here, so a
      // "trigger fired" on the lock screen and the card the user then opens can
      // never disagree about whether it did.
      const curr = {
        band: row.band ?? 'unknown',
        action: directive?.action ?? 'unknown',
        triggerAbove: threeState(directive?.levels?.triggerLive),
        invalidated: threeState(directive?.levels?.invalidated),
      }
      const { fired, why } = transitionOf(prev, curr)

      // The whole measured state, so a second distinct change inside the 6-hour
      // window is still a new alert. Keying on band+action alone meant a trigger
      // firing an hour after a band change was silently swallowed.
      const key = `${entry.id}:${curr.band}:${curr.action}:${curr.triggerAbove}:${curr.invalidated}`
      const suppressed = fired && prev?.lastAlertKey === key && now - (prev?.lastAlertAt ?? 0) < DEDUPE_MS
      const base = { ...curr, at: now, lastAlertKey: prev?.lastAlertKey ?? null, lastAlertAt: prev?.lastAlertAt ?? null }

      if (fired && !suppressed) {
        const line = alertLine(entry, row, why, curr, directive)
        transitions.push({ id: entry.id, symbol: row.symbol, from: prev?.band ?? null, to: curr.band, action: curr.action, why })
        // Held back rather than written now: the state is only advanced if the
        // message actually goes out (see below), or a Telegram outage would eat
        // the transition permanently — the next pass would see no change.
        pending.push({ id: entry.id, key, line, state: base })
      } else {
        nextState[entry.id] = base
      }
    }

    // One message per pass, not one per coin. On a day the whole board moves,
    // 40 separate Telegrams is a notification storm nobody reads to the end of;
    // one digest is the same information in a form that survives a lock screen.
    let delivered = false
    if (pending.length) {
      const advance = (p) => { nextState[p.id] = { ...p.state, lastAlertKey: p.key, lastAlertAt: now } }
      if (!telegramConfigured()) {
        // No TELEGRAM_* vars is the default deploy, not a failure. Advance the
        // state anyway: holding it back until a delivery that can never happen
        // would make every pass re-detect the same transition forever, and the
        // recorded band would freeze at whatever it was the day alerts stopped.
        pending.forEach(advance)
      } else {
        const res = await sendTelegram(digest(pending.map((p) => p.line)))
        delivered = !!res.sent
        // Undelivered transitions leave prevState untouched, so the next pass
        // re-detects and re-sends them.
        if (delivered) pending.forEach(advance)
        else pending.forEach((p) => { nextState[p.id] = prevState[p.id] })
      }
    }

    // nextState is rebuilt from the CURRENT watchlist every pass, so un-starred
    // coins fall out by construction — there is nothing to prune.
    await s.setJSON(ALERT_KEY, nextState)

    return {
      summary: { watched: entries.length, offBoard: skipped, transitions: transitions.length, delivered },
      transitions,
    }
  } catch (e) {
    return empty(msg(e))
  }
}

/**
 * THE FOUR TRANSITIONS, and the rule that they are EDGES.
 *
 * The contract names three — band change, trigger fired, invalidation hit — and
 * the fourth is the directive reaching one of the two verdicts this pass can
 * reach (see ACTIONABLE). Pure, and exported, so it can be pinned in a test
 * without a Blobs round-trip.
 *
 * `null` on either level flag means NOT MEASURED: no sparkline on the row, so
 * there is no 7-day high or low to be above or below. An edge is only ever
 * false → true, never null → true, because null → true is the day the data
 * arrived and not the day price moved — and an alert that fires on the arrival
 * of its own input is the fastest way to get a sentinel muted. Rows stored by an
 * earlier deploy carry no level flags at all and read as `null` here, so the
 * first pass after this ships records them and the second is the first that can
 * fire on them.
 */
export function transitionOf(prev, curr) {
  // A first sighting is not a transition. Starring a coin that is already
  // running would otherwise fire an alert about a move that happened before you
  // were watching.
  if (!prev) return { fired: false, why: [] }
  // Same rule as alertLine's: this is exported and this file never throws. A
  // missing `curr` is "nothing was measured this pass", which is not a
  // transition — and reading `.band` off it was a throw inside the one function
  // whose whole job is to decide whether to wake someone up.
  if (!curr || typeof curr !== 'object') return { fired: false, why: [] }
  const why = []
  if (prev.band !== curr.band) why.push(`${prev.band} → ${curr.band}`)
  if (prev.triggerAbove === false && curr.triggerAbove === true) why.push('trigger fired')
  if (prev.invalidated === false && curr.invalidated === true) why.push('invalidation hit')
  if (ACTIONABLE.has(curr.action) && prev.action !== curr.action) why.push(`now ${curr.action}`)
  return { fired: why.length > 0, why }
}

/** true / false / null, never undefined — an absent flag is an unmeasured one,
 *  and it has to survive a JSON round-trip through Blobs as such. */
function threeState(v) {
  return v === true ? true : v === false ? false : null
}

/** The directive is another agent's pure module; a throw in it must not cost us
 *  the dominance row that already landed, so the band alert degrades alone.
 *  Exported so the reachable-action sweep in directive.js's test drives the
 *  EXACT call shape this pass uses, rather than a reconstruction of it that can
 *  drift away from the ACTIONABLE set it is there to justify. */
export function safeDirective(row, season, now) {
  try {
    return altDirective({
      screened: row,
      season,
      precedent: null,
      crowd: null,
      phase: null,
      plan: null,
      position: null,
      candles: null,
      // Honest, not optimistic: the universe row this is computed from was
      // fetched seconds ago in this same pass.
      freshness: { state: 'live', ageSec: 0 },
      now,
    })
  } catch {
    return null
  }
}

// Plain English WITH the numbers, same as every other read in this codebase —
// the point of the alert is that it can be acted on from the lock screen
// without opening anything, or knowingly ignored.
//
// Exported for one reason: every number on this line also appears on the board
// the line tells you to go and open, and the units have to match. They did not —
// turnover went out as `0.12×` against the board's `12%` — so the agreement is
// pinned by a test rather than by everyone remembering.
export function alertLine(entry, row, why, curr, directive) {
  // Nothing in this file is allowed to throw — a 500 here writes no dominance
  // row, and a hole in that series is permanent. So the arguments are normalised
  // rather than trusted, even though the only caller builds them itself.
  //
  // ALL FIVE, not the last two. `why` and `curr` were normalised here while
  // `entry` and `row` were still dereferenced directly, so this threw on a null
  // either side of them. The live call site cannot produce that — `entries` is
  // filtered to objects with a string id and `row` is guarded before this runs —
  // but the normalising is the point: this is an EXPORTED formatter, its own
  // header promises it, and "the only caller builds them itself" is a property
  // of today's caller rather than of this function.
  const changes = Array.isArray(why) ? why.filter(Boolean) : []
  const state = curr && typeof curr === 'object' ? curr : {}
  const e = entry && typeof entry === 'object' ? entry : {}
  const row_ = row && typeof row === 'object' ? row : {}
  const bits = [
    `${row_.symbol || e.symbol || e.id || 'unknown coin'} ${changes.length ? changes.join(', ') : state.band ?? 'unknown'}`,
    state.action && state.action !== 'unknown' ? state.action : null,
    pct('24h', row_.chg24h),
    pct('7d', row_.chg7d),
    turnover(row_.turnover),
    Number.isFinite(row_.score) ? `score ${Math.round(row_.score)}` : null,
  ].filter(Boolean)
  const lines = [`• ${bits.join(' · ')}`]
  // The level that moved, with the basis attached. Named because the sparkline
  // levels are the WEAKER ones — a 6-day high, not the 20-day high the tab draws
  // off candles — and a user comparing this line against the card deserves to
  // know which one fired.
  const level = changes.includes('trigger fired')
    ? levelText('cleared', directive?.levels?.trigger, directive?.levels?.triggerBasis)
    : changes.includes('invalidation hit')
      ? levelText('lost', directive?.levels?.invalidation, directive?.levels?.invalidationBasis)
      : null
  if (level) lines.push(`  ${level}`)
  if (directive?.headline) lines.push(`  ${directive.headline}`)
  return lines.join('\n')
}

/** Em-dash rather than brackets: directive.js's own basis strings already carry
 *  a parenthetical ("…(no candle history)"), and nesting them reads as noise on
 *  a lock screen, which is the only place this string is ever seen. */
function levelText(verb, level, basis) {
  if (!Number.isFinite(level)) return null
  return `${verb} ${px(level)}${basis ? ` — ${basis}` : ''}`
}

function digest(lines) {
  const shown = lines.slice(0, MAX_ALERT_LINES)
  const extra = lines.length - shown.length
  return [
    `🟡 ALTS: ${lines.length} state change${lines.length === 1 ? '' : 's'} on the watchlist`,
    '',
    ...shown,
    extra > 0 ? `…and ${extra} more` : null,
    '',
    'Open the Alts tab before acting — this pass has no candles, no precedent and no sizing plan, so any level above is the 7-day sparkline\'s and not the 20-day candle level the tab draws.',
  ].filter((l) => l !== null).join('\n')
}

async function readDomHistory(s) {
  try {
    const rows = await s.get(DOM_KEY, { type: 'json' })
    if (!Array.isArray(rows)) return null
    const clean = rows.filter(isDominanceRow)
    return clean.length ? clean : null
  } catch {
    return null
  }
}

function pct(label, v) {
  return Number.isFinite(v) ? `${label} ${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : null
}

/**
 * TURNOVER IS A PERCENT OF MARKET CAP, EVERYWHERE.
 *
 * `row.turnover` is the raw FRACTION vol24h ÷ mcap. Every surface that shows it
 * shows it as a percent — screen.js's own label and fact say "12.0% of cap",
 * AltBoard renders "12%" — and this line used to print `turnover 0.12×`, the
 * same field in a second unit with a multiplier suffix that made a heavy day
 * look like a light one. One field, one unit: the number in a Telegram alert has
 * to be the number on the board it tells you to go and open.
 */
function turnover(t) {
  return Number.isFinite(t) ? `turnover ${(t * 100).toFixed(1)}% of cap` : null
}

/** Sub-dollar alt prices need significant digits, not two decimals — most of
 *  this watchlist trades below a cent and "$0.00" is not a level. Same rule as
 *  directive.js's px(), because these two strings are read side by side. */
function px(x) {
  if (!Number.isFinite(x)) return '—'
  const a = Math.abs(x)
  if (a >= 1000) return `$${Math.round(x).toLocaleString('en-US')}`
  if (a >= 1) return `$${(Math.round(x * 100) / 100).toFixed(2)}`
  if (a === 0) return '$0'
  return `$${x.toPrecision(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`
}

function round(v, dp) {
  if (!Number.isFinite(v)) return null
  const f = 10 ** dp
  return Math.round(v * f) / f
}

function msg(e) {
  return String(e?.message || e || 'unknown error')
}
