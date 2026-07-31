// THE BOARD — a few hundred screened rows, ranked, filterable, and readable in
// one hand.
//
// ONE DOM, TWO LAYOUTS. The desktop table and the mobile card are the same
// elements re-templated by CSS grid areas, not two component trees behind a
// media query. Two trees means a `useState` on a breakpoint (wrong on the server
// and wrong for one frame after every resize), a duplicate row for screen
// readers, and — the reason this rule exists in the first place — two places to
// fix the next column that renders the wrong number. Four columns that do not
// earn a phone's width — RANK, 30d, RS and turnover — are `display: none` under
// 768px (`.c-rank, .c-rs, .c-turn, .c-30` in styles.css) and live in the detail
// pane, one tap away. The BAND
// stays: it is the state word the score is inked from, and it carries the `par`
// and `thin` flags, which are the two marks that decide whether a row is
// tradeable at all. This comment named the wrong four for a while — it claimed
// the band was dropped and never mentioned rank — which is how those two flags
// reached the phone with nothing on that screen explaining them.
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

const FILTERS = [
  { value: 'all', label: 'All coins' },
  { value: 'watchlist', label: 'Watchlist only' },
  { value: 'meme', label: 'Memes' },
  { value: 'utility', label: 'Utility' },
  { value: 'major', label: 'Majors · $10B+' },
  { value: 'mid', label: 'Mid · $1–10B' },
  { value: 'small', label: 'Small · $100M–1B' },
  { value: 'micro', label: 'Micro · under $100M' },
]

const PAGE = 50

export default function AltBoard({
  rows = [], watched, onSelect, selectedId = null, onToggleWatch, savingId = null,
}) {
  const [sort, setSort] = useState('score')
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(PAGE)

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const filtered = rows.filter((r) => {
      if (filter === 'watchlist' && !watched?.has(r.id)) return false
      if ((filter === 'meme' || filter === 'utility') && r.kind !== filter) return false
      if (TIERS.has(filter) && r.tier !== filter) return false
      if (!needle) return true
      return String(r.symbol).toLowerCase().includes(needle) || String(r.name).toLowerCase().includes(needle)
    })
    return filtered.sort(comparator(sort))
  }, [rows, watched, filter, q, sort])

  const visible = shown.slice(0, limit)

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
          <label htmlFor="alt-filter">Show</label>
          <select className="field" id="alt-filter" value={filter} onChange={(e) => { setFilter(e.target.value); setLimit(PAGE) }}>
            {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
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
              <div className="alt-head" aria-hidden="true">
                <span className="alt-c c-rank">#</span>
                <span className="alt-c c-coin">Coin</span>
                <span className="alt-c c-price">Price</span>
                <span className="alt-c c-24">24h</span>
                <span className="alt-c c-7">7d</span>
                <span className="alt-c c-30">30d</span>
                {/* pts, not %: a difference of two percentages is percentage
                    POINTS, which is what screen.js calls it in its own facts. */}
                <span className="alt-c c-rs">RS 7d · pts</span>
                <span className="alt-c c-turn">Turnover</span>
                <span className="alt-c c-spark">7d shape</span>
                <span className="alt-c c-score">Score</span>
                <span className="alt-c c-band">Band</span>
              </div>
              {visible.map((r) => (
                <BoardRow
                  key={r.id ?? r.symbol}
                  r={r}
                  selected={r.id === selectedId}
                  starred={!!watched?.has(r.id)}
                  saving={savingId === r.id}
                  // EVERY star locks while ANY star is saving, not just the one
                  // being saved. `/api/alt-watchlist` PUTs the whole array and
                  // is last-write-wins on it, so two stars a moment apart both
                  // send a list built from the same starting point and the
                  // second one can be dropped by the first's response — after
                  // its toast has said it saved. Locking only the saving row
                  // left exactly the case that races open: the next tap is on a
                  // DIFFERENT row.
                  locked={savingId != null}
                  onSelect={onSelect}
                  onToggleWatch={onToggleWatch}
                />
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

function BoardRow({ r, selected, starred, saving, locked, onSelect, onToggleWatch }) {
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
        <span className="alt-c c-price num">{fmtAltPx(r.price)}</span>
        <span className={`alt-c c-24 num ${toneOf(r.chg24h)}`}>{pctText(r.chg24h)}</span>
        <span className={`alt-c c-7 num ${toneOf(r.chg7d)}`}>{pctText(r.chg7d)}</span>
        <span className={`alt-c c-30 num ${toneOf(r.chg30d)}`}>{pctText(r.chg30d)}</span>
        <span className={`alt-c c-rs num ${toneOf(r.rsVsBtc7d)}`}>{ptsText(r.rsVsBtc7d)}</span>
        <span className="alt-c c-turn num">{turnText(r.turnover)}</span>
        <span className="alt-c c-spark">
          <Sparkline data={r.sparkline7d} label={`${r.symbol} 7-day shape`} />
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
      </button>
      <button
        type="button"
        className={`alt-star${starred ? ' on' : ''}${saving ? ' saving' : ''}`}
        onClick={() => onToggleWatch?.(r)}
        disabled={saving || locked}
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
