// THE ANSWER CARD FOR ALTS — the whole tab compressed into one score and four
// rows.
//
// The tab used to open with six surfaces of equal visual weight: a season card,
// a since-card, a shape card, a leaders pane, a filter row and a banded board.
// Every one of them was honest and not one of them told you what to think, so
// you read all six and left without a read. This is the cockpit's fix applied to
// the same shape — see TradeCard.jsx, which this file deliberately mirrors down
// to the class names. Everything that used to be above the fold is still on the
// tab; it is below this now, collapsed, as the evidence rather than the headline.
//
// EVERY LINE HERE IS A VALUE read.js COMPUTED. This file does no arithmetic at
// all — not a percentage, not a count, not a comparison. If a sentence needs a
// number that was not fetched, read.js refuses in words and this renders the
// refusal. That is not a style preference: the one time this repo shipped a
// component that did its own sums, a score invented 20 points and flipped a call
// from WATCH to ENTER.
//
// IT WEARS THE COCKPIT'S FURNITURE, for SeasonCard's reason: `.tcard`,
// `.tc-head`, `.tc-num`, `.tc-pips`, `.tc-rows`, `.guardrail`, `.tc-math`. The
// cockpit already trained the eye that a big numeral in a coloured head is "the
// call", and a second dialect for the same job one tab over is what makes two
// screens feel like two products. Unlike the season card it DOES take `.tcard`
// itself — the stripe belongs to a card that tells you what to do, and this is
// now the only card on this tab that does.
//
// THE SCAN'S HEALTH LIVES HERE, not on the season card, because this card is the
// first thing on the tab and a refused scan refuses this read before it refuses
// anything else. Refresh has to be reachable from the top of the page on a phone
// whatever else is collapsed.
import React, { useState } from 'react'
import { Expand, FreshChip, Num } from '../primitives.jsx'

export default function ReadCard({
  read, fresh = null, sourceDetail = null, cached = false, cacheAgeSec = null, onReload,
}) {
  const [work, setWork] = useState(false)
  if (!read) return null

  const scoreless = read.score == null
  const pips = scoreless ? 0 : read.score
  // The fragilities the "Wrong if" row is NOT showing. `slice(1)` would be wrong
  // twice — a refused read's row skips `no_regime`, and a card with no rows at
  // all has shown none of them — so read.js publishes which one it used.
  const hiddenRisks = read.risks.filter((r) => r.key !== read.wrongKey)

  return (
    <section className={`card pad-md altread band-${read.band}`} data-testid="alt-read">
      <div className="alt-season-top">
        <span className="ttl t-label alt-season-ttl">Alts</span>
        {fresh && <FreshChip fresh={fresh} title={sourceDetail || undefined} />}
        {cached && Number.isFinite(cacheAgeSec) && <span className="tiny t-cap">cached {cacheAgeSec}s</span>}
        <button className="btn quiet sm alt-season-btn" onClick={onReload}>Refresh</button>
      </div>

      {/* ── the score ─────────────────────────────────────────────────────── */}
      <div className={`tc-head band-${read.band}`}>
        <div className="tc-score">
          <span className="tc-num num" data-testid="alt-read-score">
            {scoreless ? '—' : <Num v={read.score} f={(x) => Math.round(x)} />}
          </span>
          <span className="tc-den num">/ {read.max}</span>
        </div>
        <div className="tc-headtext">
          <div className="tc-label">{read.label}</div>
          <div className="tc-plain">{read.plain}</div>
        </div>
      </div>

      <div className={`tc-pips band-${read.band}`} role="img"
        aria-label={scoreless ? 'alts read unknown' : `alts read ${read.score} out of ${read.max}`}>
        {Array.from({ length: read.max }, (_, i) => <span key={i} className={!scoreless && i < pips ? 'on' : ''} />)}
      </div>

      {/* ── the four answers, or the reason there are none ─────────────────── */}
      {read.rows.length > 0 ? (
        <dl className="tc-rows" data-testid="alt-read-rows">
          {read.rows.map((r) => (
            <div className="tc-row" key={r.key}>
              <dt className="tc-k t-label">{r.k}</dt>
              <dd className="tc-v">
                <span className={`tc-val tone-${r.tone}`}>{r.v}</span>
                {r.note && <span className="tc-note">{r.note}</span>}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        // Not a blank card. A refused scan is a state with a cause and a next
        // step, and the button is the next step (DESIGN.md §4.7).
        <div className="empty altread-empty">
          <div className="glyph" aria-hidden>—</div>
          <div className="empty-title">Nothing to read yet</div>
          <div className="empty-sub">
            Every row on this card is a difference or a count over the one scan, so there is nothing to
            answer with until a good pass lands. The evidence cards below say the same thing in their own
            terms rather than showing you a remembered board.
          </div>
          <button className="btn primary md alt-retry" onClick={onReload}>Retry</button>
        </div>
      )}

      {/* ── the working, one tap away ──────────────────────────────────────── */}
      {(read.parts.length > 0 || read.facts.length > 0 || hiddenRisks.length > 0) && (
        <>
          {/* "the working", NOT "how this scores" — that is the season card's
              label, and two identically worded disclosures one above the other
              on the same tab is a reader wondering which one they already
              opened. */}
          <button className="btn ghost sm disclose" onClick={() => setWork((w) => !w)} aria-expanded={work}>
            {work ? 'hide the working' : hiddenRisks.length > 0
              ? `show the working · +${hiddenRisks.length} more thin input${hiddenRisks.length > 1 ? 's' : ''}`
              : 'show the working'}
          </button>
          <Expand open={work}>
            {/* The fragilities the "Wrong if" row could not fit. Guardrail rows
                and not a plain list, because each one is a reason to trust the
                number above less — the same treatment the cockpit gives them. */}
            {hiddenRisks.map((r) => (
              <div className="guardrail" key={r.key}><span aria-hidden>⚠︎</span><span>{r.text}</span></div>
            ))}

            {read.parts.length > 0 && (
              <div className="tc-math">
                {read.parts.map((p) => (
                  <div className="tc-mrow" key={p.key}>
                    <span className="tc-mk">{p.label}</span>
                    <span className={`tc-mp num ${p.points > 0 ? 'pos' : p.points < 0 ? 'neg' : ''}`}>
                      {p.points > 0 ? '+' : ''}{p.points} / {p.max}
                    </span>
                  </div>
                ))}
                <div className="tc-mrow total">
                  <span className="tc-mk">alts read</span>
                  <span className="tc-mp num">{scoreless ? '—' : `${read.score} / ${read.max}`}</span>
                </div>
              </div>
            )}

            {read.facts.length > 0 && (
              <ul className="factlist">{read.facts.map((f, i) => <li key={i} className="sub t-foot">{f}</li>)}</ul>
            )}

            <p className="sub t-foot tc-foot">
              Six of the ten points are the regime — is capital rotating into alts at all — scaled straight off
              the alt-season score below. Three are whether anything on the board is actually starting, which is
              a completed break of the prior 6-day high and not a shape that might resolve either way. The last
              point is a tilt for which way the board has moved since you last looked, and it is left out
              entirely rather than scored zero when there is no earlier board. Advisory only &mdash; every entry,
              stop and size is per coin, in that coin&rsquo;s own panel.
            </p>
          </Expand>
        </>
      )}
    </section>
  )
}
