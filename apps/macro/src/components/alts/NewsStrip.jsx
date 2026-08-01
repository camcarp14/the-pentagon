// WHAT IS BEING TALKED ABOUT — and it is deliberately NOT a list you buy from.
//
// WHERE IT SITS AND WHY. Inside the Board card, above the board's own controls,
// so the sentence "these rows were named in a headline" is adjacent to the rows
// it is about and one scroll from the ranking that ignores it. It is not a card:
// this tab already has an answer card and four folds above the board, and a
// fifth surface for a feed that changes no number would be the busyness the
// whole redesign was for. Surfaces before this change: 5 in the board pane, 1 in
// the detail pane, 5 in an open coin. Surfaces after: the same.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE WORDING IS THE FEATURE. Three things had to be impossible to read off it:
//
//   1. THAT IT IS A SIGNAL. It is attention, and this tab's own crowd read says
//      attention is coincident-to-late — "an attention spike is where a move
//      gets sold into, not where it gets bought" (the checklist card, verbatim).
//      The lead line says that, in front of the list, every time.
//   2. THAT IT IS DIRECTIONAL. A coin is in the news because it shipped, and a
//      coin is in the news because it got drained for $40m. The headline is
//      shown BECAUSE it is the only thing here that carries the sign, and the
//      lead line names the exploit case out loud so the reader goes and reads it
//      rather than treating the mention as a tick.
//   3. THAT IT REORDERED ANYTHING. It cannot: news.js never sees screen.js or
//      read.js, and the rows handed back are the board's own objects. The list
//      is sorted by RECENCY, and the band pill travels with each row so a `late`
//      coin in the news still reads `late`.
//
// AND IT IS COLLAPSED. Four of these are one line of the board card until you
// open them; the collapsed line carries the count, which is the only part that
// changes what you would do next.
import React, { useState } from 'react'
import { Expand } from '../primitives.jsx'
import { spanLabel } from '../../lib/alts/pulse.js'

export default function NewsStrip({ read = null, onSelect, live = true }) {
  const [open, setOpen] = useState(false)
  if (!read) return null

  // A refused board has nothing to match against, and "0 in the news" over it
  // would be a count nobody took.
  const state = !live ? 'no live board'
    : read.ok ? `${read.matchedCount} on this board`
      : SHORT[read.kind] ?? 'not read'

  return (
    <div className="alt-news" data-testid="alt-news">
      <button
        type="button" className="alt-news-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}
      >
        <span className="alt-news-k t-label">In the news</span>
        <span className="dr-state">{state}</span>
        <span className={`dr-chev ${open ? 'open' : ''}`} aria-hidden>&#9662;</span>
      </button>

      <Expand open={open}>
        {!live ? (
          <p className="sub t-foot alt-news-note">
            Headlines are matched against the ranked rows, and the scan that produces them was refused by the
            freshness ladder &mdash; so there is no board to match against. Nothing is claimed about what is or is
            not in the news. Use Refresh in the card at the top.
          </p>
        ) : !read.ok ? (
          // THE LIB'S OWN SENTENCE. news.js states which of the six "nothing
          // here" cases this is and why, and a paraphrase here would be a second
          // thing to keep true — SinceCard's rule about pulse.js's reasons.
          <p className="sub t-foot alt-news-note">{cap(read.reason)}.</p>
        ) : (
          <>
            <p className="sub t-foot alt-news-note">
              A mention is ATTENTION, not a signal, and it carries no direction: a coin is in the news because it
              shipped something and a coin is in the news because it just got exploited. Nothing here read a
              market &mdash; read the headline. The board below is ranked on price, structure and turnover and does
              not know this feed exists: no row, score or band moved because of anything on this list, which is in
              the order the stories were published.
            </p>
            <ul className="alt-newslist">
              {read.coins.map((c) => (
                <li key={c.row.id ?? c.row.symbol} className="alt-newsrow">
                  <button
                    type="button" className="alt-newsrow-coin"
                    onClick={() => onSelect?.(c.row)}
                    aria-label={`${c.row.symbol}, ${c.row.name}. The board has it ${c.row.band}, score ${c.row.score} of 100. ${c.n} headline${c.n === 1 ? '' : 's'}. Open its directive.`}
                  >
                    <span className="alt-sym">{c.row.symbol}</span>
                    {/* The band travels with the row. Without it this list is six
                        symbols with headlines beside them, which is the shape of
                        a buy list; with it, a coin in the news that the board has
                        as `late` says `late` right here. */}
                    <span className={`alt-band b-${c.row.band}`}>{c.row.band}</span>
                    <span className="alt-newsrow-n num">{c.n}</span>
                  </button>
                  <div className="alt-newsrow-body">
                    {c.items.slice(0, 2).map((it) => (
                      <p className="alt-newsitem" key={it.key}>
                        {it.url ? (
                          // `noopener` is not optional on a target=_blank link to
                          // a third-party page: without it the opened tab gets a
                          // handle on this window.
                          <a className="alt-newsitem-t" href={it.url} target="_blank" rel="noopener noreferrer nofollow">{it.title}</a>
                        ) : (
                          // No usable link — the headline is still the evidence,
                          // and a dead anchor is worse than plain text.
                          <span className="alt-newsitem-t">{it.title}</span>
                        )}
                        <span className="alt-newsitem-m">
                          {it.source ?? 'source not stated'}
                          {it.ageMs == null ? '' : ` \u00b7 ${spanLabel(it.ageMs) ?? '—'} ago`}
                          {/* WHY THIS HEADLINE IS FILED UNDER THIS COIN, quoted
                              from the matcher. It is the entire audit trail for
                              the only claim this section makes, and `title` is
                              not the place for it — a tooltip does not exist on
                              touch, and the phone is where this is read. */}
                          {it.why ? ` \u00b7 ${it.why}` : ''}
                        </span>
                      </p>
                    ))}
                    {c.n > 2 && <p className="alt-newsitem-more sub t-foot">and {c.n - 2} more naming {c.row.symbol}</p>}
                  </div>
                </li>
              ))}
            </ul>
            <p className="tiny t-cap alt-news-foot">
              {read.itemCount} headline{read.itemCount === 1 ? '' : 's'} checked against {read.coinsConsidered ?? '—'} coins;{' '}
              {read.matchedCount} on this board{read.truncated > 0 ? `, ${read.truncated} beyond this list` : ''}
              {read.offBoard > 0 ? `, and ${read.offBoard} named that this scan does not rank` : ''}.
              {/* THE SILENCE THAT IS NOT A READING. The matcher refuses a ticker
                  that is also an ordinary word, so those rows can never appear
                  here however much is written about them — and a reader with no
                  way to know that would take a silent row as "nothing written". */}
              {read.unmatchable > 0
                ? ` ${read.unmatchable} row${read.unmatchable === 1 ? '' : 's'} on this board cannot be matched at all (their ticker or name is ordinary English), so silence about them is not a reading.`
                : ''}
              {read.stale ? ' The feed is being served from cache past its window.' : ''}
              {read.sourceDetail ? ` Source: ${read.sourceDetail}.` : ''}
              {read.degraded.length > 0 ? ` ${read.degraded.join('; ')}.` : ''}
            </p>
          </>
        )}
      </Expand>
    </div>
  )
}

/** The collapsed line, which is what most visits read. Each of these is a
 *  DIFFERENT claim and they get different words for that reason — see news.js's
 *  header. "feed did not answer" and "none on this board" are opposites. */
const SHORT = {
  no_feed: 'feed did not answer',
  no_shape: 'feed shape unknown',
  no_coins: 'no coin list to check',
  no_items: 'feed carried nothing',
  no_match: 'none on this board',
}

function cap(s) {
  const t = String(s ?? '')
  return t.charAt(0).toUpperCase() + t.slice(1)
}
