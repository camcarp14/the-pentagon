// WHAT IS BEING TALKED ABOUT — /api/alt-news's headlines, intersected with the
// rows THIS board actually ranked.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS NOT, AND THE WHOLE READ IS BUILT AROUND THE DISTINCTION.
//
// A NEWS MENTION IS ATTENTION. IT IS NOT A SIGNAL AND IT IS NOT A REASON.
// sentiment.js already measures attention per coin and its finding is that
// attention is coincident-to-late — the checklist card says it in those words:
// "an attention spike is where a move gets sold into, not where it gets bought".
// Nothing here feeds a score. read.js never imports this file, screen.js never
// sees it, and the band a row is in is exactly the band it was in before the
// feed answered. This changes the ORDER of nothing.
//
// AND THE SIGN IS UNMEASURED. The endpoint says so first — netlify/shared/
// news.mjs's header: "nothing here measures sentiment, relevance or causation,
// so nothing here may imply any of the three". A coin is in the news because it
// shipped a mainnet and a coin is in the news because it was drained for $40m,
// and this pass read titles, not markets. So this file publishes no score, no
// direction and no ranking by volume; it hands over the headline, the literal
// text that matched it, and a link, and lets the operator read it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ENDPOINT'S SHAPE, WHICH THIS FILE IS WRITTEN AGAINST:
//
//   items   [{ title, url, source, at }]          — every headline fetched
//   matches { SYM: [{ title, url, source, at, why, basis, confidence }] }
//   coins   [{ symbol, id, name, rank, starred, count, latestAt, confidence }]
//   skipped [{ symbol, name, id, reason }]        — coins it REFUSED to match
//   coinsConsidered, coinSource, degraded, sourceDetail, asOf, cached, stale
//
// `at` and `latestAt` are ms epoch — the feed parser produces them with
// Date.parse. `confidence` grades HOW SPECIFIC THE MATCH EVIDENCE IS (a
// six-letter ticker is harder to hit by accident than a three-letter one) and
// never how bullish or how important; it is passed through with that meaning
// intact and the component words it that way.
//
// THE INTERSECTION IS LOAD-BEARING. The endpoint builds its coin list from
// alt-scan's Blobs cache plus the watchlist blob, which is NOT this browser's
// board: that cache can be older than the pass on screen, and a starred coin can
// be one the screener excludes (a stablecoin, a wrapper) or one that has dropped
// out of the top 250. So a coin is surfaced only when it is in `rows` — the
// array the board renders — and the ones that are not are COUNTED and stated
// rather than shown, because "on your board" has to mean the board on the
// screen.
//
// `skipped` IS SURFACED, AND THAT IS THE POINT OF IT. The matcher refuses a
// ticker that is also an ordinary English word, one under three characters, and
// a name made only of common words — deliberately, so a story about peppers is
// not a PEPE mention. The cost is that those coins can NEVER show a headline,
// and an operator reading a silent row cannot otherwise tell "nothing was
// written" from "we were not able to look". The number of MY board's rows in
// that state is published here and printed on the strip.
//
// PURE. No fetch, no DOM, no Date.now() — `now` is passed in (ms epoch).

/** How many headlines to keep per coin. The strip draws two and counts the
 *  rest, so "and 4 more" is a real number rather than a cut list. */
const PER_COIN = 6

/**
 * @param payload  the /api/alt-news body, or null
 * @param rows     screenUniverse() output — THE SAME ARRAY THE BOARD RENDERS
 * @param error    the fetch error string, or null
 * @param loading  true while the first request is in flight
 * @param now      ms epoch, from the caller's own clock source
 * @param max      how many matched coins to hand back
 */
export function altNewsRead({ payload = null, rows = null, error = null, loading = false, now = null, max = 6 } = {}) {
  const board = Array.isArray(rows) ? rows : []

  const refuse = (kind, reason, extra = {}) => ({
    ok: false, kind, reason,
    coins: [], matchedCount: 0, truncated: 0,
    itemCount: 0, offBoard: 0, unmatchable: 0, coinsConsidered: null,
    asOf: null, sourceDetail: null, stale: false, degraded: [],
    ...extra,
  })

  /* ── the feed itself did not get here ──────────────────────────────────── */
  if (error) {
    return refuse('no_feed',
      `the news feed did not answer — ${error}. Nothing on this board is marked either way, because a feed that failed is not a feed that found nothing`)
  }
  if (loading && !payload) return refuse('no_feed', 'the news feed has not answered yet')
  if (!payload || typeof payload !== 'object') {
    return refuse('no_feed', 'no news feed reached this browser on this pass, so no headline has been checked against the board')
  }

  /* ── it did, but it is not the shape this reader knows ─────────────────── */
  const items = Array.isArray(payload.items) ? payload.items : null
  const matches = payload.matches && typeof payload.matches === 'object' && !Array.isArray(payload.matches) ? payload.matches : null
  const named = Array.isArray(payload.coins) ? payload.coins : null
  if (items == null || matches == null || named == null) {
    const keys = Object.keys(payload).slice(0, 8)
    return refuse('no_shape',
      `the news endpoint answered with a shape this reader does not recognise${keys.length ? ` (top-level keys: ${keys.join(', ')})` : ' (an empty object)'} — it needs items, matches and coins, and no headline is shown rather than a list guessed out of what did arrive`,
      { asOf: num(payload.asOf) })
  }

  const skipped = Array.isArray(payload.skipped) ? payload.skipped : []
  const base = {
    itemCount: items.length,
    coinsConsidered: num(payload.coinsConsidered),
    asOf: num(payload.asOf),
    sourceDetail: typeof payload.sourceDetail === 'string' ? payload.sourceDetail : null,
    stale: payload.stale === true,
    degraded: Array.isArray(payload.degraded) ? payload.degraded.filter((d) => typeof d === 'string') : [],
    unmatchable: 0,
    offBoard: 0,
  }

  // The endpoint had nothing to match against: alt-scan's cache was cold and the
  // watchlist empty. Its own `degraded` says so, and this is the state where an
  // empty `matches` would be read most easily as a quiet news day.
  if (base.coinsConsidered === 0) {
    return refuse('no_coins',
      `${items.length} headline${items.length === 1 ? '' : 's'} arrived and the matcher had no coin list to check them against${base.degraded.length ? ` (${base.degraded.join('; ')})` : ''} — so nothing has been ruled in or out`,
      base)
  }

  if (items.length === 0) {
    return refuse('no_items',
      'the news feed answered and carried no headlines at all. That is a reading of the feed, not a failure to reach it',
      base)
  }

  /* ── the intersection with THIS board ──────────────────────────────────── */
  const byId = new Map()
  const bySym = new Map()
  for (const r of board) {
    if (r?.id) byId.set(String(r.id).toLowerCase(), r)
    if (r?.symbol) bySym.set(String(r.symbol).toUpperCase(), r)
  }
  const onBoard = (c) => (c?.id && byId.get(String(c.id).toLowerCase()))
    || (c?.symbol && bySym.get(String(c.symbol).toUpperCase()))
    || null

  base.unmatchable = skipped.filter((s) => onBoard(s)).length

  const coins = []
  let offBoard = 0
  for (const c of named) {
    const row = onBoard(c)
    if (!row) { offBoard++; continue }
    const list = Array.isArray(matches[c.symbol]) ? matches[c.symbol] : []
    const kept = list.map((h, i) => headline(h, i, now)).filter(Boolean).sort(byNewest)
    // A named coin whose headlines did not survive the shape check is dropped
    // rather than shown with an empty list. This row exists to hold evidence,
    // and a row with none is a claim with nothing behind it.
    if (kept.length === 0) continue
    coins.push({
      row,
      items: kept.slice(0, PER_COIN),
      // The endpoint's own count when it is at least what arrived, so "and 4
      // more" survives the per-coin cap; never smaller than what is in hand.
      n: Number.isFinite(c.count) && c.count >= kept.length ? c.count : kept.length,
      latestAt: num(c.latestAt) ?? kept[0].publishedAt,
      confidence: grade(c.confidence),
      starred: c.starred === true,
    })
  }
  base.offBoard = offBoard

  if (coins.length === 0) {
    return refuse('no_match',
      `${items.length} headline${items.length === 1 ? '' : 's'} arrived and none of them names a coin on this board` +
      `${offBoard > 0 ? `, though ${offBoard} coin${offBoard === 1 ? ' was' : 's were'} named that this scan does not rank` : ''}` +
      `. That is a reading of the feed against ${board.length} ranked row${board.length === 1 ? '' : 's'}, not an empty section`,
      base)
  }

  /* ORDER IS RECENCY, AND IT IS DELIBERATELY NOT THE ORDER THE ENDPOINT SENT.
   * matchHeadlines ranks by mention COUNT first, which is the right order for an
   * API — it is a fact about the feed. It is the wrong order for this strip: a
   * list sorted by how much has been written reads as a list sorted by how
   * important, and the single thing that generates the most coverage in a day is
   * an exploit. Time cannot be misread as a quality ranking, and the caption
   * says which order this is in. */
  const ordered = coins.slice().sort((a, b) =>
    (b.latestAt ?? -Infinity) - (a.latestAt ?? -Infinity) ||
    String(a.row.symbol).localeCompare(String(b.row.symbol)))

  const cap = Math.max(1, Math.floor(Number.isFinite(max) ? max : 6))
  return {
    ok: true, kind: 'ok', reason: null,
    coins: ordered.slice(0, cap),
    matchedCount: ordered.length,
    truncated: Math.max(0, ordered.length - cap),
    ...base,
  }
}

/* ══ one headline ═══════════════════════════════════════════════════════════ */

/**
 * Null when there is no title — an entry with no words in it is not a headline,
 * and a bare link is a row that says nothing.
 *
 * `url` survives only if it is http(s). The feed parser passes an href through
 * without parsing it, and this one goes straight into a `target="_blank"`
 * anchor: `javascript:` in that position is a script that runs on a click the
 * reader believes is a link out. The check belongs on the last hop before the
 * DOM, which is here.
 */
function headline(h, i, now) {
  if (!h || typeof h !== 'object') return null
  const title = typeof h.title === 'string' ? h.title.trim() : ''
  if (!title) return null
  const publishedAt = num(h.at)
  return {
    key: `${i}:${String(h.url || title).slice(0, 160)}`,
    title: title.slice(0, 240),
    url: httpUrl(h.url),
    source: typeof h.source === 'string' ? h.source.slice(0, 60) : null,
    publishedAt,
    ageMs: Number.isFinite(publishedAt) && Number.isFinite(now) ? Math.max(0, now - publishedAt) : null,
    // The literal text that matched, quoted by the matcher. It is the whole
    // audit trail behind "this headline is about this coin", and it is printed
    // rather than kept, because the alternative is asking the reader to trust a
    // regex they cannot see.
    why: typeof h.why === 'string' ? h.why : null,
    confidence: grade(h.confidence),
  }
}

/** The endpoint's two grades and nothing else — an unknown value becomes null
 *  rather than passing an unrecognised word through to a label. */
function grade(x) { return x === 'high' || x === 'medium' ? x : null }

function httpUrl(s) {
  if (typeof s !== 'string' || !s) return null
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch { return null }
}

/** Newest first; an undated item sorts after every dated one rather than to the
 *  top, because "unknown" is not "now". */
function byNewest(a, b) {
  const at = Number.isFinite(a?.publishedAt) ? a.publishedAt : -Infinity
  const bt = Number.isFinite(b?.publishedAt) ? b.publishedAt : -Infinity
  return bt - at
}

function num(x) { return Number.isFinite(x) ? x : null }
