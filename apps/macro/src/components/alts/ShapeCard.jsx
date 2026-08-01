// THE SHAPE OF THE MARKET — what the board looks like as a whole, and which way
// it has been moving.
//
// Two reads, neither of which any single row can give you:
//
//   THE DISTRIBUTION. A hundred rows ranked 96 down to 4 tells you the ordering
//   and nothing about the population. "Eleven igniting and sixty dead" is a
//   different market from "one igniting and sixty running", and the ranked list
//   renders them identically. Each segment is also the fastest route into the
//   board — tapping `igniting` filters it — so the strip is a picture and a
//   control at once, which is the only reason it earns the vertical space.
//
//   THE SERIES. altShareSeries() reads the dominance history the alt-watch cron
//   has been appending one row per calendar day since it shipped, and turns it
//   into the share of total market cap that is NOT BTC. That is the only time
//   series this system owns: everything else on the tab is one instant.
//
// IT IS NOT BREADTH AND IT DOES NOT SAY BREADTH. Breadth — how many of the top
// 100 beat BTC — is the honest rotation measure and the season card above already
// carries it, computed fresh from this scan. It is not STORED anywhere, so there
// is no breadth history to draw, and drawing one would mean inventing it. Alt
// share is a real number that CoinGecko published on each of those days and that
// the cron wrote down. The distinction is in the caption, in the aria-label and
// in the lib's own header, because the two are one word apart and the wrong one
// is a claim about data that does not exist.
//
// COLLAPSED BY DEFAULT, AND NOTHING WAS REMOVED. Both reads are reference
// material once the answer card above has stated how many coins are igniting and
// what that is worth: the strip is a picture of a population and the line is a
// month of one series. The collapsed row carries the one number that changes
// what you would do — `N of M actionable`.
//
// THE BAND CHIPS ARE A FILTER AND FOLDING THEM DOES NOT REMOVE THE CONTROL. The
// board's own `Show` select writes the same piece of state (see AltsPanel's
// declaration of it), and the select is the one a keyboard and a screen reader
// reach anyway. The chips are the pointer's shortcut, one tap deeper.
import React, { useState } from 'react'
import { Expand } from '../primitives.jsx'
import { sparkPoints } from './sparkline.jsx'
import { BAND_MEANING } from '../../lib/alts/pulse.js'

export default function ShapeCard({
  dist = null, series = null, activeFilter = 'all', onPickBand, live = true,
}) {
  const [open, setOpen] = useState(false)

  /** Cockpit.jsx's idiom: the whole title row is the control, and the collapsed
   *  row carries a measurement rather than a description of the card. */
  const Head = ({ state }) => (
    <button className="ttl ttl-btn t-label" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
      Shape of the board
      <span className="dr-state">{state}</span>
      <span className={`dr-chev ${open ? 'open' : ''}`} aria-hidden>▾</span>
    </button>
  )

  if (!live || !dist || dist.total === 0) {
    return (
      <section className="card pad-md alt-shape" data-testid="alt-shape">
        <Head state="nothing ranked" />
        <Expand open={open}>
          <div className="empty">
            <div className="glyph" aria-hidden>—</div>
            <div className="empty-title">No ranked coins to count</div>
            <div className="empty-sub">
              The distribution is a count over the same rows the board ranks, so an empty board leaves it
              with no denominator. It is left blank rather than drawn at zero. Use Refresh in the card above.
            </div>
          </div>
        </Expand>
      </section>
    )
  }

  // Only the bands that are actually on the board get a segment and a chip. A
  // 0%-wide segment is invisible and its chip is a control that returns an empty
  // board — ink and a dead end for a band this scan does not contain.
  const present = dist.bands.filter((b) => b.n > 0)

  return (
    <section className="card pad-md alt-shape" data-testid="alt-shape">
      <Head state={`${dist.actionable} of ${dist.total} actionable`} />
      <Expand open={open}>

      <p className="sub t-foot alt-shape-note">
        Every ranked coin in this scan, by the state screen.js put it in — {dist.actionable} of {dist.total} are
        igniting, waking or running. Tap a band to filter the board to it.
      </p>

      <div
        className="alt-dist" role="img"
        aria-label={`Band distribution across ${dist.total} ranked coins: ${present.map((b) => `${b.n} ${b.band}`).join(', ')}`}
      >
        {present.map((b) => (
          <span
            key={b.band}
            className={`alt-dist-seg seg-${b.band}${activeFilter === b.band ? ' on' : ''}`}
            style={{ flexGrow: b.n }}
          />
        ))}
      </div>

      <div className="alt-chips">
        {present.map((b) => {
          const on = activeFilter === b.band
          return (
            <button
              key={b.band}
              type="button"
              className={`alt-chip band-${b.band}${on ? ' on' : ''}`}
              aria-pressed={on}
              // The band's own meaning, from the one place it is written. A
              // tooltip is not the explanation (it does not exist on touch) —
              // the group headings on the board carry the same line in the
              // document, and this is the pointer's shortcut to it.
              title={BAND_MEANING[b.band]}
              onClick={() => onPickBand?.(on ? 'all' : b.band)}
            >
              <span className="alt-chip-k">{b.band}</span>
              <span className="alt-chip-n num">{b.n}</span>
            </button>
          )
        })}
      </div>

      <AltShare series={series} />

      </Expand>
    </section>
  )
}

/**
 * Alt share of total market cap, one point per stored day.
 *
 * The refusal path is the one that ships on day one and it prints the lib's own
 * sentence — "0 of 7 days needed" — rather than an empty chart area. An empty
 * chart says the line is flat; the sentence says there is no line.
 */
function AltShare({ series }) {
  if (!series || !series.ok) {
    return (
      <div className="alt-share thin">
        <div className="alt-share-top">
          <span className="alt-share-k">Alt share of total cap</span>
          <span className="alt-share-v num">—</span>
        </div>
        {/* THE LIB'S SENTENCE, NOT A PARAPHRASE OF IT. altShareSeries already
            states the arithmetic it refused on and, in the zero case, why a gap
            in the series is permanent. This used to append its own copy of that
            second clause and printed it twice in a row on the day-one screen —
            the state the refusal exists for. The only thing added here is the
            part the lib cannot know: that the readings it DOES have are kept. */}
        <p className="sub t-foot alt-share-note">
          {series?.reason ?? 'no stored dominance history to read'}
          {series?.samples > 0
            ? `. The ${series.samples} reading${series.samples === 1 ? '' : 's'} already stored are kept, and the line starts once there are seven.`
            : ''}
        </p>
      </div>
    )
  }

  const pts = series.points.map((p) => p.altShare)
  const line = sparkPoints(pts, { width: 240, height: 44, pad: 2 })
  const dir = series.trend === 'rising' ? 'up' : series.trend === 'falling' ? 'down' : 'flat'

  return (
    <div className="alt-share">
      <div className="alt-share-top">
        <span className="alt-share-k">Alt share of total cap</span>
        <span className={`alt-share-v num tone-${dir}`}>{series.last.toFixed(1)}%</span>
      </div>
      {line ? (
        <svg
          className={`alt-sharechart dir-${dir}`}
          viewBox="0 0 240 44" preserveAspectRatio="none" role="img"
          aria-label={`Alt share of total market cap over ${series.samples} stored daily readings: ${series.first.toFixed(1)} percent to ${series.last.toFixed(1)} percent`}
        >
          <polyline
            points={line} fill="none" stroke="currentColor" strokeWidth="1.75"
            strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : (
        // Two readings is enough to state a change and not enough to draw a
        // shape. Saying so beats a two-pixel line that looks like a trend.
        <p className="sub t-foot alt-share-note">{series.samples} readings — too few points to draw a shape.</p>
      )}
      <p className="sub t-foot alt-share-note">
        {signed(series.changePctPts, 2)} points {series.trend}
        {series.spanDays == null
          ? ` across ${series.samples} stored readings`
          : ` across ${series.spanDays} day${series.spanDays === 1 ? '' : 's'} · ${series.samples} readings`}
        {series.altMcapChangePct == null ? '' : ` · alt cap ${signed(series.altMcapChangePct, 1)}%`}
        {/* A cron that stopped writing is the failure this whole series is
            exposed to, and the only place it can be seen is the age of the
            newest row. Two days is the same threshold season.js warns at. */}
        {series.latestAgeDays >= 2 ? ` · newest reading is ${series.latestAgeDays} days old, the cron may be down` : ''}
      </p>
    </div>
  )
}

function signed(x, d = 1) {
  if (!Number.isFinite(x)) return '—'
  return `${x >= 0 ? '+' : ''}${x.toFixed(d)}`
}
