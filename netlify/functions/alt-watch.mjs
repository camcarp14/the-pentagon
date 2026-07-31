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
//    change or a newly actionable directive — deduped for 6 hours. A sentinel
//    that re-sends the same "still igniting" every 2 hours gets muted inside a
//    day, and a muted sentinel is worse than none: it is a sentinel you believe
//    you have.
//
// Modelled on watch-snapshot.mjs, including the rule that matters most here:
// it must NEVER throw. A scheduled function that 500s writes no dominance row,
// and a hole in that series is permanent.
import { json, store, sendTelegram, telegramConfigured, checkAuth } from '../shared/util.mjs'
import { altGlobal, altUniverse, mergeDominanceSample, isDominanceRow } from '../shared/alts.mjs'
import { seasonRead } from '../../apps/macro/src/lib/alts/season.js'
import { screenUniverse } from '../../apps/macro/src/lib/alts/screen.js'
import { altDirective } from '../../apps/macro/src/lib/alts/directive.js'

const DOM_KEY = 'alt_dom_history'
const WATCHLIST_KEY = 'alt_watchlist'
const ALERT_KEY = 'alt_alert_state'

const DEDUPE_MS = 6 * 3600 * 1000
const MAX_ALERT_LINES = 12

// The directive actions worth a phone buzz. A drop from ARM back to WATCH is
// real information, but it is not an action — and a phone that buzzes for
// "nothing to do any more" gets silenced, which takes the ENTER with it.
const ACTIONABLE = new Set(['ENTER', 'ARM', 'EXIT', 'TRIM', 'AVOID'])

export default async (req) => {
  try {
    // Same posture as watch-snapshot: the scheduler cannot carry a token, so
    // the pass always runs — its side effects are append-only and dedupe-capped
    // — while the detailed response body is gated on a real token check.
    const authed = await checkAuth(req)
    const s = store()
    const now = Date.now()

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
    const dom = await recordDominance(s, global, now)
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
async function recordDominance(s, global, now) {
  if (!global) return { summary: { appended: false, reason: 'no global read this pass — nothing to record' }, rows: null }
  try {
    const day = new Date(now).toISOString().slice(0, 10)
    const rows = await s.get(DOM_KEY, { type: 'json' })
    const had = (Array.isArray(rows) ? rows : []).some((r) => r?.d === day)
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
 * it never quotes an entry price it did not compute.
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
      const band = row.band ?? 'unknown'
      const action = directive?.action ?? 'unknown'
      const prev = prevState[entry.id]
      const bandChanged = !!prev && prev.band !== band
      const becameActionable = ACTIONABLE.has(action) && (!prev || prev.action !== action)
      // A first sighting is not a transition. Starring a coin that is already
      // running would otherwise fire an alert about a move that happened before
      // you were watching.
      const fired = !!prev && (bandChanged || becameActionable)

      const key = `${entry.id}:${band}:${action}`
      const suppressed = fired && prev?.lastAlertKey === key && now - (prev?.lastAlertAt ?? 0) < DEDUPE_MS
      const base = { band, action, at: now, lastAlertKey: prev?.lastAlertKey ?? null, lastAlertAt: prev?.lastAlertAt ?? null }

      if (fired && !suppressed) {
        const line = alertLine(entry, row, prev, band, action, directive)
        transitions.push({ id: entry.id, symbol: row.symbol, from: prev?.band ?? null, to: band, action })
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

/** The directive is another agent's pure module; a throw in it must not cost us
 *  the dominance row that already landed, so the band alert degrades alone. */
function safeDirective(row, season, now) {
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
function alertLine(entry, row, prev, band, action, directive) {
  const bits = [
    `${row.symbol || entry.symbol || entry.id} ${prev?.band && prev.band !== band ? `${prev.band} → ${band}` : band}`,
    action !== 'unknown' ? action : null,
    pct('24h', row.chg24h),
    pct('7d', row.chg7d),
    Number.isFinite(row.turnover) ? `turnover ${row.turnover.toFixed(2)}×` : null,
    Number.isFinite(row.score) ? `score ${Math.round(row.score)}` : null,
  ].filter(Boolean)
  const head = `• ${bits.join(' · ')}`
  return directive?.headline ? `${head}\n  ${directive.headline}` : head
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
    'Open the Alts tab before acting — this pass has no candles, no precedent and no levels.',
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

function round(v, dp) {
  if (!Number.isFinite(v)) return null
  const f = 10 ** dp
  return Math.round(v * f) / f
}

function msg(e) {
  return String(e?.message || e || 'unknown error')
}
