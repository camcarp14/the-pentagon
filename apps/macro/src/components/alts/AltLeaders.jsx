// WHERE TO LOOK FIRST — what the right-hand pane holds when no coin is picked.
//
// It used to hold the sentence "Pick a coin" and a paragraph describing what
// picking one would give you. At 1020px and up that pane is 330-466px wide and
// as tall as the board beside it, permanently, until something is selected — a
// third of a desktop screen spent on an instruction the row underneath the
// pointer already implies. On the visit where nothing is selected, which is
// every visit until you act, half the command centre said nothing.
//
// So it holds the shortlist instead: the best-scoring rows inside the bands
// worth acting on, grouped, with the band's own meaning above each group. Every
// row is a control that selects the coin, so the pane is now the fastest route
// into the detail rather than a description of it — and the instruction it
// replaced survives, demoted to one line at the bottom where a first-time reader
// will still find it.
//
// A BAND WITH NOTHING IN IT KEEPS ITS HEADING. "Nothing is starting in this
// scan" is one of the more useful readings this pane can give and it is the
// reading you get most days; a pane that silently omits the group says the same
// thing by saying nothing, which is indistinguishable from a component that
// failed to render its first section.
import React from 'react'
import { Sparkline } from './sparkline.jsx'
import { fmtAltPx, pctText, ptsText, toneOf } from './AltBoard.jsx'

export default function AltLeaders({
  groups = [], dist = null, live = true, onSelect,
}) {
  if (!live || !dist || dist.total === 0) {
    return (
      <section className="card pad-md alt-placeholder" data-testid="alt-leaders">
        <div className="empty">
          <div className="glyph" aria-hidden>◎</div>
          <div className="empty-title">Nothing to shortlist</div>
          <div className="empty-sub">
            This pane ranks inside the bands the screener produced, so with no live scan there is nothing to
            rank. Use Refresh in the season card; the shortlist comes back with the next good pass.
          </div>
        </div>
      </section>
    )
  }

  // This is a shortlist, not a second board. The complete universe remains in
  // the board below; two live groups are enough to answer where to begin.
  const visibleGroups = groups.filter((g) => g.rows.length > 0).slice(0, 2)

  return (
    <section className="card pad-md alt-leaders" data-testid="alt-leaders">
      <div className="alt-since-top">
        <span className="ttl t-label alt-since-ttl">Where to look first</span>
        <span className="chip" title="coins the board has as starting, warming or underway">
          <span className="dot" />{dist.actionable} of {dist.total} actionable
        </span>
      </div>

      {visibleGroups.map((g) => (
        <div className="alt-lead-grp" key={g.band}>
          <div className="alt-lead-head">
            <span className={`alt-band b-${g.band}`}>{g.band}</span>
            <span className="alt-lead-n num">{g.n}</span>
          </div>
          <p className="sub t-foot alt-lead-why">{g.meaning}</p>
          {g.rows.length === 0 ? (
            // Not an `.empty` block: six of those stacked in a 400px pane is a
            // column of glyphs. It is a measured zero and it reads as a sentence.
            <p className="sub t-foot alt-lead-none">Nothing is {g.band} in this scan.</p>
          ) : (
            <ul className="alt-leadlist">
              {g.rows.slice(0, 3).map((r) => (
                <li key={r.id ?? r.symbol}>
                  <button
                    type="button" className="alt-leadrow"
                    onClick={() => onSelect?.(r)}
                    aria-label={`${r.symbol}, ${r.name}. Score ${r.score} of 100, band ${r.band}. Price ${fmtAltPx(r.price)}, 7d ${pctText(r.chg7d)}, relative strength ${ptsText(r.rsVsBtc7d)} points against BTC. Open its directive.`}
                  >
                    <span className="alt-leadrow-id">
                      <span className="alt-sym">{r.symbol}</span>
                      <span className="alt-name">{r.name}</span>
                    </span>
                    <span className={`alt-leadrow-score num band-${r.band}`}>{r.score}</span>
                    <span className="alt-leadrow-nums">
                      <span className={`num ${toneOf(r.chg7d)}`}>{pctText(r.chg7d)}</span>
                      <span className="alt-leadrow-k">7d</span>
                      <span className={`num ${toneOf(r.rsVsBtc7d)}`}>{ptsText(r.rsVsBtc7d)}</span>
                      <span className="alt-leadrow-k">RS</span>
                    </span>
                    <span className="alt-leadrow-spark">
                      <Sparkline data={r.sparkline7d} label={`${r.symbol} 7-day shape`} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {/* The instruction the pane used to be. One line, at the bottom, where it
          is still findable and no longer the whole surface. */}
      <p className="sub t-foot alt-lead-foot">The board below keeps every ranked coin; each row opens that coin&apos;s directive.</p>
    </section>
  )
}
