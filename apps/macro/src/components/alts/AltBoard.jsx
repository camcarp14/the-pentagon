// THE BOARD — a few hundred screened rows, ranked, filterable, and readable in
// one hand.
//
// ONE DOM, TWO LAYOUTS. The desktop table and the mobile card are the same
// elements re-templated by CSS grid areas, not two component trees behind a
// media query. Two trees means a `useState` on a breakpoint (wrong on the server
// and wrong for one frame after every resize), a duplicate row for screen
// readers, and — the reason this rule exists in the first place — two places to
// fix the next column that renders the wrong number. Five columns that do not
// earn a phone's width — RANK, 30d, RS, turnover and the 7d SHAPE — are
// `display: none` under 768px (`.c-rank, .c-rs, .c-turn, .c-30, .c-spark` in
// styles.css) and live in the detail pane, one tap away. The BAND
// stays: it is the state word the score is inked from, and it carries the `par`
// and `thin` flags, which are the two marks that decide whether a row is
// tradeable at all. This comment named the wrong four for a while — it claimed
// the band was dropped and never mentioned rank — which is how those two flags
// reached the phone with nothing on that screen explaining them. The sparkline
// joined the list because on a phone it sat in the same 62px track that the
// band needed to hold its pill and both flags on one line: a shape cue beside
// the 7-day number it draws, against the two marks that say the row cannot be
// traded. It is still a column at 768 and up, and still drawn full size at the
// top of the detail pane.
//
// THE ROW IS A BUTTON, THE STAR IS ITS SIBLING. A button cannot legally contain
// a button, and nesting them makes the star's click bubble into "open this
// coin" — you would star a row and get thrown into the detail pane every time.
// So `.alt-row` is a two-column grid: the whole row-as-button, then a 44px star
// beside it.
//
// SORT IS TOTAL, NEVER PARTIAL. Every comparator falls through to score and
// then to symbol, and nulls sort last in both directions. A sort with ties left
// unresolved reshuffles between two renders of identical data, which reads as
// live movement — the same reason `screenUniverse` breaks its own ties.
import React, { useMemo, useState } from 'react'
import { Sparkline } from './sparkline.jsx'
import { BAND_PRIORITY, BAND_MEANING, bandOrder } from '../../lib/alts/pulse.js'

/* ══ display formats ═══════════════════════════════════════════════════════
 *
 * These live HERE, in the board, and the detail pane imports them — deliberately.
 * The detail is opened from a row, so the price it prints has to be the same
 * string the row printed. Two formatters mean a coin that reads $0.000012 on the
 * board and $0.00 in the panel, and the second one looks like a broken feed.
 *
 * `fmtPx` in lib/format.js is two-decimal below $10k, which is right for a $400
 * equity and useless here: it renders every micro cap as "$0.00". */

export function fmtAltPx(x) {
  if (!Number.isFinite(x)) return '—'
  const a = Math.abs(x)
  if (a >= 1000) return `$${Math.round(x).toLocaleString('en-US')}`
  if (a >= 1) return `$${x.toFixed(2)}`
  if (a >= 0.01) return `$${x.toFixed(4)}`
  if (a >= 0.0001) return `$${x.toFixed(6)}`
  if (a > 0) return `$${x.toPrecision(3)}`
  return '$0'
}

export function usdCompact(x) {
  if (!Number.isFinite(x)) return '—'
  const a = Math.abs(x)
  if (a >= 1e12) return `$${(x / 1e12).toFixed(2)}T`
  if (a >= 1e9) return `$${(x / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `$${(x / 1e6).toFixed(1)}M`
  // one decimal under $100k: a $9,600 ticket rounded to "$10k" is a 4% lie on
  // the one number the user is about to type into an exchange
  if (a >= 1e3) return `$${(x / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`
  return `$${Math.round(x)}`
}

export function pctText(x, d = 1) {
  if (!Number.isFinite(x)) return '—'
  return `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`
}

/** A difference of two percentages is percentage POINTS, and screen.js says so
 *  in its own facts. The board says it the same way or the two disagree. */
export function ptsText(x, d = 1) {
  if (!Number.isFinite(x)) return '—'
  return `${x >= 0 ? '+' : ''}${x.toFixed(d)}`
}

export function turnText(t) {
  if (!Number.isFinite(t)) return '—'
  return `${(t * 100).toFixed(t >= 0.1 ? 0 : 1)}%`
}

export function toneOf(x) {
  if (!Number.isFinite(x)) return 'flat'
  return x > 0 ? 'pos' : x < 0 ? 'neg' : 'flat'
}

/* ══ controls ══════════════════════════════════════════════════════════════ */

const SORTS = [
  { value: 'score', label: 'Score' },
  { value: 'chg24h', label: '24h move' },
  { value: 'chg7d', label: '7d move' },
  { value: 'chg30d', label: '30d move' },
  { value: 'turnover', label: 'Turnover' },
  { value: 'mcap', label: 'Market cap' },
]

/**
 * THE FILTER LIST, IN GROUPS, AND THE BANDS ARE IN IT.
 *
 * The band chips on the shape card and this select are ONE control in two skins,
 * not two controls that have to be kept agreeing: `filter` lives in AltsPanel
 * and both surfaces write to it. That is the whole reason the bands are options
 * here rather than a second piece of state — a chip row that filtered the board
 * while the select still read "All coins" is two answers to "what am I looking
 * at" on one screen, and the select is the one a keyboard reaches.
 */
const FILTER_GROUPS = [
  {
    label: null,
    options: [
      { value: 'all', label: 'All coins' },
      { value: 'watchlist', label: 'Watchlist only' },
    ],
  },
  { label: 'Band', options: BAND_PRIORITY.map((b) => ({ value: b, label: cap(b) })) },
  {
    label: 'Kind',
    options: [
      { value: 'meme', label: 'Memes' },
      { value: 'utility', label: 'Utility' },
    ],
  },
  {
    label: 'Size',
    options: [
      { value: 'major', label: 'Majors · $10B+' },
      { value: 'mid', label: 'Mid · $1–10B' },
      { value: 'small', label: 'Small · $100M–1B' },
      { value: 'micro', label: 'Micro · under $100M' },
    ],
  },
]

const GROUPS = [
  { value: 'band', label: 'By band' },
  { value: 'none', label: 'Flat list' },
]

const BANDS = new Set(BAND_PRIORITY)
const PAGE = 50
const EMPTY = new Set()

export default function AltBoard({
  rows = [], watched, onSelect, selectedId = null, onToggleWatch, pendingIds = EMPTY,
  // Controlled from AltsPanel so the shape card's band chips and this board's
  // "Show" select are the same control. Defaulted so the component still stands
  // up on its own in a test or a fixture render.
  filter = 'all', onFilter,
}) {
  const [sort, setSort] = useState('score')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(PAGE)
  // GROUPED BY DEFAULT. A flat ranked list makes you scroll past forty extended
  // and dead rows to reach the next igniting one, and igniting is the state this
  // whole tool exists to catch. Inside a group the chosen sort still decides the
  // order, so nothing about the ranking is lost — it is partitioned, not
  // replaced — and "Flat list" is one control away for anyone who wants the pure
  // ranking back.
  const [group, setGroup] = useState('band')

  const setFilter = (v) => { onFilter?.(v); setLimit(PAGE) }

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const filtered = rows.filter((r) => {
      if (filter === 'watchlist' && !watched?.has(r.id)) return false
      if ((filter === 'meme' || filter === 'utility') && r.kind !== filter) return false
      if (TIERS.has(filter) && r.tier !== filter) return false
      if (BANDS.has(filter) && r.band !== filter) return false
      if (!needle) return true
      return String(r.symbol).toLowerCase().includes(needle) || String(r.name).toLowerCase().includes(needle)
    })
    const within = comparator(sort)
    // Band first, then the chosen comparator INSIDE the band. Not a second
    // sort key bolted onto the front of the comparator: the fallthrough in
    // `comparator` is what keeps the order total, and burying band ahead of it
    // would leave the ties it resolves resolved differently in each group.
    return filtered.sort(group === 'band'
      ? (a, b) => bandOrder(a.band) - bandOrder(b.band) || within(a, b)
      : within)
  }, [rows, watched, filter, q, sort, group])

  const visible = shown.slice(0, limit)
  // Headings only where there is more than one band to separate. Filtered to a
  // single band, the heading would restate the control that produced the view.
  const heads = group === 'band' && new Set(visible.map((r) => r.band)).size > 1
  // Counted over `shown`, not over `visible`. The number beside a heading is the
  // size of the GROUP, and paging is a property of the view — with 50 of 120
  // rows drawn, a heading reading "igniting 4" when eleven are igniting is the
  // page's arithmetic wearing the market's clothes. The foot line already says
  // how many of the total are on screen.
  const groupCounts = useMemo(() => {
    const m = new Map()
    for (const r of shown) m.set(r.band, (m.get(r.band) ?? 0) + 1)
    return m
  }, [shown])

  return (
    <>
      <div className="alt-controls">
        <div className="fld alt-fld">
          <label htmlFor="alt-q">Search</label>
          {/* type=text, not search: this app's standalone stylesheet only fills
              the input types it names, and a bare `type=search` renders as an
              unstyled box in `npm --workspace @app/macro run dev`. */}
          <input
            className="field" id="alt-q" type="text" value={q} placeholder="symbol or name"
            onChange={(e) => { setQ(e.target.value); setLimit(PAGE) }}
          />
        </div>
        <div className="fld alt-fld">
          <label htmlFor="alt-sort">Sort by</label>
          <select className="field" id="alt-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <div className="fld alt-fld">
          <label htmlFor="alt-group">Group</label>
          <select className="field" id="alt-group" value={group} onChange={(e) => setGroup(e.target.value)}>
            {GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
        </div>
        <div className="fld alt-fld">
          <label htmlFor="alt-filter">Show</label>
          <select className="field" id="alt-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
            {FILTER_GROUPS.map((g) => (g.label
              ? (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </optgroup>
              )
              : (
                // A Fragment with a key, not a bare array: an unkeyed array
                // nested inside a mapped list is a React warning, and this
                // app's render test fails on any React warning at all.
                <React.Fragment key="top">
                  {g.options.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </React.Fragment>
              )))}
          </select>
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="empty">
          <div className="glyph" aria-hidden>◎</div>
          <div className="empty-title">
            {rows.length === 0 ? 'No ranked coins in this scan'
              : filter === 'watchlist' ? 'Nothing starred yet'
                : 'Nothing matches this filter'}
          </div>
          {/* Three different dead ends, three different next steps. "No results"
              with one generic line under it is the empty state that sends people
              to the refresh button for a problem refreshing cannot fix. */}
          <div className="empty-sub">
            {rows.length === 0
              ? 'Stablecoins and wrapped tokens are excluded by design, so an empty board means the universe never arrived. Use Refresh in the card above.'
              : filter === 'watchlist'
                ? 'Set Show back to “All coins”, then tap the star on any row. Starred coins are what the two-hourly sentinel screens and alerts on.'
                : `Clear the search box or set Show back to “All coins” — ${rows.length} ranked coins are in this scan.`}
          </div>
        </div>
      ) : (
        <>
          <div className="tbl-wrap alt-wrap">
            <div className="alt-board" data-testid="alt-board">
              {/* Presentational: every value is repeated in each row's own
                  aria-label, so a screen reader gets the pairing without having
                  to walk a header it cannot associate with grid cells. */}
              {/* DOM ORDER IS READING ORDER, AND READING ORDER IS THE COLUMN
                  BUDGET. The board is ranked by score, and score, band and the
                  star used to be the last three cells of an 831px row inside a
                  576-670px scroller — 0px visible at 1020/1180/1280/1440/1920,
                  with or without a coin selected. Identity, the ranking and the
                  state word now come FIRST, and the twelve columns of evidence
                  (price, the three returns, RS, turnover, the shape) are what
                  runs off the right edge into `.tbl-wrap`. Reading the score
                  can no longer cost you the coin's name. */}
              <div className="alt-head" aria-hidden="true">
                <span className="alt-c c-rank">#</span>
                <span className="alt-c c-coin">Coin</span>
                <span className="alt-c c-score">Score</span>
                <span className="alt-c c-band">Band</span>
                <span className="alt-c c-price">Price</span>
                <span className="alt-c c-24">24h</span>
                <span className="alt-c c-7">7d</span>
                <span className="alt-c c-30">30d</span>
                {/* pts, not %: a difference of two percentages is percentage
                    POINTS, which is what screen.js calls it in its own facts. */}
                <span className="alt-c c-rs">RS 7d · pts</span>
                <span className="alt-c c-turn">Turnover</span>
                <span className="alt-c c-spark">7d shape</span>
              </div>
              {visible.map((r, i) => (
                <React.Fragment key={r.id ?? r.symbol}>
                  {/* A heading whenever the band changes, which with the rows
                      sorted by band is once per group. Emitted as a sibling grid
                      item rather than a wrapper: `.alt-board` is one column of
                      rows, and wrapping each group in a <div> would make the
                      group the grid item and collapse every row inside it onto a
                      single track. */}
                  {heads && (i === 0 || visible[i - 1].band !== r.band) && (
                    <GroupHead band={r.band} n={groupCounts.get(r.band) ?? 0} />
                  )}
                  <BoardRow
                    r={r}
                    selected={r.id === selectedId}
                    starred={!!watched?.has(r.id)}
                    // ONLY the rows whose own change has not landed. A single
                    // in-flight PUT used to disable all 26 stars plus the detail
                    // pane's, with no timeout, no toast and no way back; the
                    // writer in AltsPanel now queues instead of locking, so a
                    // second tap on a different row is a write, not a refusal.
                    saving={!!pendingIds?.has(r.id)}
                    onSelect={onSelect}
                    onToggleWatch={onToggleWatch}
                  />
                </React.Fragment>
              ))}
            </div>
          </div>
          <FlagLegend rows={visible} />
          <div className="alt-boardfoot">
            <span className="tiny t-cap">
              {visible.length} of {shown.length} ranked{shown.length !== rows.length ? ` (${rows.length} in the scan)` : ''}
            </span>
            {shown.length > visible.length && (
              <button className="btn quiet sm" onClick={() => setLimit((n) => n + PAGE)}>
                Show {Math.min(PAGE, shown.length - visible.length)} more
              </button>
            )}
          </div>
        </>
      )}
    </>
  )
}

const TIERS = new Set(['major', 'mid', 'small', 'micro'])

function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1) }

/**
 * The band separator inside the board.
 *
 * WHY THE TEXT IS STICKY-LEFT. At 768 and up the board is 885px of tracks inside
 * a 576-670px scroller, so a heading that simply sat at the start of an 885px
 * grid item would scroll off the left edge with the rank column the moment
 * anybody looked at turnover — and the reader would then be inside a group whose
 * name is off screen, which is worse than no grouping at all. `left: 0` on the
 * inner element pins the words to the visible edge while the rule they sit on
 * still spans the full table.
 *
 * The meaning line is screen.js's rule in words, from pulse.js's single copy of
 * it. It is the piece that makes the grouping mean something rather than sort
 * something: "igniting" is a label, "broke the prior 6-day high with the day
 * running ahead of the week" is why the eleven rows under it are together.
 */
function GroupHead({ band, n }) {
  return (
    <div className="alt-group" role="presentation">
      <div className="alt-group-in">
        <span className={`alt-band b-${band}`}>{band}</span>
        <span className="alt-group-n num">{n}</span>
        <span className="alt-group-sub">{BAND_MEANING[band] ?? ''}</span>
      </div>
    </div>
  )
}

/**
 * What `par` and `thin` mean, in the document, on every platform.
 *
 * They were explained by a `title` attribute alone, which does not exist on
 * touch — and the phone is where a three-letter abbreviation needs the most
 * help. These are the two flags this file calls "the reason a top-of-board score
 * is not an invitation", so an unreadable mark is the score being read without
 * its caveat. The thresholds are screen.js's own (PARABOLIC_24H, PARABOLIC_7D,
 * THIN_VOL_USD) and are quoted here so the legend says what the flag measured,
 * not just that something was flagged.
 *
 * Rendered only when a flagged row is actually on screen: a legend for marks
 * nobody can see is ink spent on nothing (DESIGN.md §4.1).
 */
function FlagLegend({ rows }) {
  const par = rows.some((r) => r.flags?.parabolic)
  const thin = rows.some((r) => r.flags?.thinLiquidity)
  if (!par && !thin) return null
  return (
    <div className="alt-legend">
      {par && (
        <p className="alt-legend-row">
          <span className="alt-flag warn">par</span>
          <span className="alt-legend-t">already parabolic — over +40% in 24h or +100% in 7d. A chase, not an entry.</span>
        </p>
      )}
      {thin && (
        <p className="alt-legend-row">
          <span className="alt-flag bad">thin</span>
          <span className="alt-legend-t">under $250k of 24h volume — you can get in and not out.</span>
        </p>
      )}
    </div>
  )
}

function BoardRow({ r, selected, starred, saving, onSelect, onToggleWatch }) {
  // The two flags are read out in full rather than as "par"/"thin": a screen
  // reader gets no legend, and an abbreviation is exactly what it cannot expand.
  const caveats = [
    r.flags?.parabolic ? 'Flagged parabolic: already over +40% in 24h or +100% in 7d, so this is a chase, not an entry.' : '',
    r.flags?.thinLiquidity ? 'Flagged thin: under $250k of 24h volume, so you can get in and not out.' : '',
  ].filter(Boolean).join(' ')
  const summary =
    `${r.symbol}, ${r.name}. Rank ${r.rank ?? 'unknown'}. Score ${r.score} of 100, band ${r.band}. ` +
    `Price ${fmtAltPx(r.price)}, 24h ${pctText(r.chg24h)}, 7d ${pctText(r.chg7d)}, 30d ${pctText(r.chg30d)}.` +
    (caveats ? ` ${caveats}` : '')

  return (
    <div className={`alt-row band-${r.band}${selected ? ' on' : ''}`}>
      <button
        type="button"
        className="alt-row-main"
        onClick={() => onSelect?.(r)}
        aria-label={summary}
        aria-current={selected ? 'true' : undefined}
      >
        <span className="alt-c c-rank num">{r.rank ?? '—'}</span>
        <span className="alt-c c-coin">
          <span className="alt-sym">{r.symbol}</span>
          <span className="alt-name">{r.name}</span>
        </span>
        <span className={`alt-c c-score num band-${r.band}`}>{r.score}</span>
        <span className="alt-c c-band">
          <span className={`alt-band b-${r.band}`}>{r.band}</span>
          {/* The two flags that change whether the row is tradeable at all get a
              mark on the board rather than waiting for the detail pane — they
              are the reason a top-of-board score is not an invitation. What they
              MEAN is printed under the board by <FlagLegend>; `title` is kept
              for the pointer, but it is not the explanation, because it does not
              exist on touch. */}
          {r.flags?.parabolic && <span className="alt-flag warn" title="already parabolic — this is a chase, not an entry">par</span>}
          {r.flags?.thinLiquidity && <span className="alt-flag bad" title="under $250k of 24h volume — you can get in and not out">thin</span>}
        </span>
        <span className="alt-c c-price num">{fmtAltPx(r.price)}</span>
        <span className={`alt-c c-24 num ${toneOf(r.chg24h)}`}>{pctText(r.chg24h)}</span>
        <span className={`alt-c c-7 num ${toneOf(r.chg7d)}`}>{pctText(r.chg7d)}</span>
        <span className={`alt-c c-30 num ${toneOf(r.chg30d)}`}>{pctText(r.chg30d)}</span>
        <span className={`alt-c c-rs num ${toneOf(r.rsVsBtc7d)}`}>{ptsText(r.rsVsBtc7d)}</span>
        <span className="alt-c c-turn num">{turnText(r.turnover)}</span>
        <span className="alt-c c-spark">
          <Sparkline data={r.sparkline7d} label={`${r.symbol} 7-day shape`} />
        </span>
      </button>
      <button
        type="button"
        className={`alt-star${starred ? ' on' : ''}${saving ? ' saving' : ''}`}
        onClick={() => onToggleWatch?.(r)}
        disabled={saving}
        aria-pressed={starred}
        aria-label={starred ? `Remove ${r.symbol} from the watchlist` : `Add ${r.symbol} to the watchlist`}
        title={starred ? 'On your watchlist — the sentinel screens it every two hours' : 'Add to the watchlist'}
      >
        <span aria-hidden>{starred ? '★' : '☆'}</span>
      </button>
    </div>
  )
}

/** Descending on every key, nulls last, ties broken by score then symbol so the
 *  order is total. `-Infinity` for a missing value is what puts it last without
 *  a second comparison. */
function comparator(key) {
  const v = (r) => {
    const x = key === 'score' ? r.score : r[key]
    return Number.isFinite(x) ? x : -Infinity
  }
  return (a, b) => v(b) - v(a) ||
    (b.score ?? -Infinity) - (a.score ?? -Infinity) ||
    String(a.symbol).localeCompare(String(b.symbol))
}
