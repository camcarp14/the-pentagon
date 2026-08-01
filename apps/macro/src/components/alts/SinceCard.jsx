// SINCE YOU LAST LOOKED — the events, one line per coin.
//
// This is the card the tab was missing. The season card says what the regime is
// and the board says what everything scores, and between the two there was
// nothing that answered the only question an operator actually opens a screener
// with: what happened while I was away. A ranked list cannot answer it, because
// a ranking has no memory — the coin that went from quiet to starting overnight
// looks exactly like the coin that has been starting for a week, and both of
// them look like a row.
//
// IT IS COLLAPSED BY DEFAULT AND NOTHING IN IT WAS REMOVED. The answer card
// above states the count and names the two most important events; this is where
// you come to open one of them. The collapsed row carries the count and the span
// — live state, not a description of the card — and crucially it carries
// "nothing moved" and "no baseline" as DIFFERENT words, because those are the
// two claims this whole file exists to keep apart and the collapsed row is what
// most visits will read.
//
// WHERE THE MEMORY COMES FROM. Two board snapshots, both of them real scans this
// browser received: the one on screen, and one stored at the end of an earlier
// visit. pulse.js does the diff; this file only renders it. There is no server
// round-trip and no modelled baseline, which is why the age of the comparison is
// printed at the top and repeated in every refusal — "since you last looked" is
// only meaningful if you are told when that was.
//
// THE TWO STATES THAT MUST NOT LOOK ALIKE, and the whole reason this card is not
// three lines of JSX:
//
//   "Nothing moved"  — two real boards were compared and they agree. A reading.
//   "Nothing to compare against" — there is no earlier board. Not a reading.
//
// They are opposite claims and they render as the same blank strip unless
// something makes them different, so the first gets a measured sentence with its
// span and its sample count, and the second gets an `.empty` with the reason
// pulse.js wrote and a next step. This is the same rule the season card follows
// when it refuses to name a phase.
import React, { useState } from 'react'
import { Expand } from '../primitives.jsx'
import { spanLabel } from '../../lib/alts/pulse.js'

const FIRST_SHOWN = 6

/** What each kind of event is called in the summary line. The lib owns the
 *  per-coin sentence; this owns the count noun, because "3 ignitions" is a
 *  statement about the LIST and the lib never sees the list as a whole. */
const NOUN = {
  ignite: ['ignition', 'ignitions'],
  advance: ['band step forward', 'band steps forward'],
  break: ['fresh break', 'fresh breaks'],
  enter: ['new to the top rows', 'new to the top rows'],
  climb: ['score climb', 'score climbs'],
  fade: ['band step back', 'band steps back'],
  slide: ['score slide', 'score slides'],
  exit: ['dropped out', 'dropped out'],
}

export default function SinceCard({ delta = null, rowsById = null, onSelect, live = true }) {
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)

  /** The whole title row is the control, and the collapsed row carries the state
   *  rather than a description of itself — Cockpit.jsx's idiom, and a 12.5px
   *  "expand" word is a ~70px invisible target on a phone. */
  const Head = ({ state }) => (
    <button className="ttl ttl-btn t-label" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
      Since you last looked
      <span className="dr-state">{state}</span>
      <span className={`dr-chev ${open ? 'open' : ''}`} aria-hidden>▾</span>
    </button>
  )

  // A dead or missing scan has no board to diff, and a card that quietly renders
  // its last answer over one is the same failure the season card was fixed for.
  if (!live || !delta) {
    return (
      <section className="card pad-md alt-since" data-testid="alt-since">
        <Head state="no live scan" />
        <Expand open={open}>
          <div className="empty">
            <div className="glyph" aria-hidden>—</div>
            <div className="empty-title">No board to compare</div>
            <div className="empty-sub">
              Every event here is a difference between two scans, so with no live scan there is nothing to
              difference. Use Refresh in the card above; the comparison picks up again with the next good pass.
            </div>
          </div>
        </Expand>
      </section>
    )
  }

  const age = spanLabel(delta.spanMs)

  if (!delta.ok) {
    return (
      <section className="card pad-md alt-since" data-testid="alt-since">
        {/* "no baseline", not "nothing moved" — the two claims are opposites and
            the collapsed row is where most visits will read this card. */}
        <Head state="no baseline" />
        <Expand open={open}>
          <div className="empty">
            <div className="glyph" aria-hidden>◷</div>
            <div className="empty-title">No comparison yet</div>
            {/* pulse.js's own sentence, not a paraphrase of it. It states the
                arithmetic it refused on, the way season.js's "1 of 7 stored days
                needed" does, and a second wording here is a second thing to keep
                true. */}
            <div className="empty-sub">
              {delta.reason}. The board below is complete and current — it is only the
              <em> what changed</em> half that needs two passes to exist.
            </div>
          </div>
        </Expand>
      </section>
    )
  }

  const events = delta.events ?? []
  const shown = all ? events : events.slice(0, FIRST_SHOWN)
  const rest = events.length - shown.length

  return (
    <section className="card pad-md alt-since" data-testid="alt-since">
      <Head state={events.length === 0
        ? `nothing moved${age ? ` in ${age}` : ''}`
        : `${events.length} event${events.length === 1 ? '' : 's'}${age ? ` in ${age}` : ''}`} />
      <Expand open={open}>

      <div className="alt-since-top">
        {/* The age of the BASELINE is the headline fact about this card: the same
            three events are urgent across twenty minutes and unremarkable across
            three days. It is a chip and not a footnote for that reason. */}
        <span className="chip" title="the board this is compared against was stored at the end of your last visit">
          <span className="dot" />{age ? `${age} of tape` : 'span unknown'}
        </span>
      </div>

      {events.length === 0 ? (
        <>
          <p className="alt-since-lead">Nothing moved.</p>
          <p className="sub t-foot alt-since-note">
            {delta.compared} coin{delta.compared === 1 ? '' : 's'} were on both boards and every one of them
            is in the same band, under the same 6-day high and within 10 points of the same score
            {age ? ` across ${age}` : ''}. That is a reading, not a gap in the data.
          </p>
        </>
      ) : (
        <>
          <p className="alt-since-lead">{summary(delta.counts)}</p>
          <ul className="alt-evs">
            {shown.map((e) => (
              <EventRow key={e.key} ev={e} row={rowsById?.get(e.id) ?? null} onSelect={onSelect} />
            ))}
          </ul>
          {(rest > 0 || all) && (
            <>
              <button className="btn ghost sm disclose" onClick={() => setAll((x) => !x)} aria-expanded={all}>
                {all ? 'show fewer' : `show ${rest} more`}
              </button>
              {/* Nothing is hidden behind the Expand that is not also counted in
                  the line above it — the disclosure is a length control, not a
                  place where a fact goes to be unread. */}
            </>
          )}
          <p className="sub t-foot alt-since-note">
            Compared against the board stored at the end of your last visit{age ? `, ${age} of tape ago` : ''}:{' '}
            {delta.compared} coin{delta.compared === 1 ? '' : 's'} on both passes
            {delta.truncated > 0 ? `, ${delta.truncated} further event${delta.truncated === 1 ? '' : 's'} beyond the list` : ''}.
            One line per coin, at its most important change.
          </p>
        </>
      )}

      </Expand>
    </section>
  )
}

/** "2 ignitions, 1 fresh break and 3 new to the top rows" — the counts, in the
 *  same weight order the list is sorted in, so the sentence and the rows agree
 *  about what matters. Zero-count kinds are omitted rather than printed as 0. */
function summary(counts = {}) {
  const parts = []
  for (const kind of ['ignite', 'advance', 'break', 'enter', 'climb', 'fade', 'slide', 'exit']) {
    const n = counts[kind] ?? 0
    if (n <= 0) continue
    const [one, many] = NOUN[kind]
    parts.push(`${n} ${n === 1 ? one : many}`)
  }
  if (parts.length === 0) return 'Nothing moved.'
  if (parts.length === 1) return `${cap(parts[0])}.`
  return `${cap(parts.slice(0, -1).join(', '))} and ${parts[parts.length - 1]}.`
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1) }

/**
 * One event. It is a BUTTON when the coin is still on the board, because the
 * next thing you want after "SOL went quiet → starting" is SOL's directive, and
 * making you find it in a hundred rows is the list problem this card exists to
 * solve. A coin that has left the scan has nothing to open, so it renders as
 * plain text rather than as a control that does nothing — a dead button is worse
 * than no button.
 */
function EventRow({ ev, row, onSelect }) {
  const body = (
    <>
      <span className="alt-ev-sym">{ev.symbol}</span>
      <span className={`alt-band b-${ev.band ?? 'cold'}`}>{ev.band ?? '—'}</span>
      <span className={`alt-ev-t tone-${ev.tone}`}>{ev.text}</span>
    </>
  )
  if (!row) return <li className="alt-ev"><span className="alt-ev-main">{body}</span></li>
  return (
    <li className="alt-ev">
      <button
        type="button" className="alt-ev-main is-link"
        onClick={() => onSelect?.(row)}
        aria-label={`${ev.symbol}: ${ev.text}. Open its directive.`}
      >
        {body}
      </button>
    </li>
  )
}
