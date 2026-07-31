// THE MARKET-WIDE ANSWER, above everything else on the tab.
//
// One sentence at the top that says what today's regime means for taking alt
// risk, then the score, then the four inputs that produced it. On a phone this
// is the whole visit most days: if the answer is "nothing is rotating", the
// board underneath is a list of ways to lose money slightly differently.
//
// IT REUSES THE ANSWER CARD'S FURNITURE ON PURPOSE — `.tc-head`, `.tc-num`,
// `.tc-label`, `.tc-plain`, `.tc-pips`, `.tc-math`. The cockpit already trained
// the eye that a big numeral in a coloured head is "the call", and a second
// dialect for the same job on a neighbouring tab is the thing that makes two
// screens feel like two products. What it does NOT take is `.tcard` itself: the
// severity stripe belongs to a card that tells you to do something, and this one
// describes the weather.
//
// PHASE DRIVES THE COLOUR, NOT THE SCORE, because season.js derives the phase
// FROM the score — so the two can never disagree, and mapping the six phases
// onto the four bands the stylesheet already owns keeps this file from inventing
// a fifth palette.
import React, { useState } from 'react'
import { Expand, FreshChip, Num } from '../primitives.jsx'

const PHASE_BAND = {
  alt_season: 'go',
  majors_rotating: 'go',
  euphoric: 'armed',    // high score, late innings — warn, never green
  btc_leads: 'building',
  btc_only: 'no',
  risk_off: 'no',
  unknown: 'unknown',
}

export default function SeasonCard({
  season = null, fresh = null, sourceDetail = null, degraded = null,
  cached = false, cacheAgeSec = null, onReload,
}) {
  const [work, setWork] = useState(false)

  // A dead scan does not get to render a remembered regime. The freshness ladder
  // has already decided these numbers are untrustworthy, and a stale alt-season
  // call is worse than none: it is the one read on this tab that changes how
  // large every position below it should be.
  if (!season) {
    return (
      <section className="card pad-md alt-season" data-testid="season-card">
        <div className="ttl t-label">Alt season<span className="spacer" />{fresh && <FreshChip fresh={fresh} title={sourceDetail} />}</div>
        <div className="empty">
          <div className="glyph" aria-hidden>—</div>
          <div className="empty-title">No live market scan</div>
          <div className="empty-sub">
            The scan is older than the freshness ladder allows, so nothing here is shown rather than showing
            you yesterday's tape. Hit Refresh; if it keeps failing, CoinGecko is rate-limiting and the next
            pass is 90 seconds away.
          </div>
          <button className="btn primary md alt-retry" onClick={onReload}>Retry</button>
        </div>
      </section>
    )
  }

  const band = PHASE_BAND[season.phase] ?? 'unknown'
  const b = season.breadth ?? {}
  const dom = season.dominance ?? {}
  const eth = season.ethBtc
  const fg = season.fearGreed
  const pips = season.score == null ? 0 : Math.round(season.score / 10)

  return (
    <section className="card pad-md alt-season" data-testid="season-card">
      <div className="alt-season-top">
        <span className="ttl t-label alt-season-ttl">Alt season</span>
        {fresh && <FreshChip fresh={fresh} title={sourceDetail || undefined} />}
        {cached && Number.isFinite(cacheAgeSec) && (
          <span className="tiny t-cap">cached {cacheAgeSec}s</span>
        )}
        <button className="btn quiet sm alt-season-btn" onClick={onReload}>Refresh</button>
      </div>

      <div className={`tc-head band-${band}`}>
        <div className="tc-score">
          <span className="tc-num num" data-testid="season-score">
            {season.score == null ? '—' : <Num v={season.score} f={(x) => Math.round(x)} />}
          </span>
          <span className="tc-den num">/ 100</span>
        </div>
        <div className="tc-headtext">
          <div className="tc-label">{season.label}</div>
          <div className="tc-plain">{season.plain}</div>
        </div>
      </div>

      <div className={`tc-pips band-${band}`} role="img"
        aria-label={season.score == null ? 'alt season score unknown' : `alt season ${season.score} out of 100`}>
        {Array.from({ length: 10 }, (_, i) => <span key={i} className={i < pips ? 'on' : ''} />)}
      </div>

      {/* BREADTH IS THE ANSWER, the rest are tilts — so it gets bars and they get
          tiles. "How many alts beat BTC" is the only rotation measure computable
          from data we actually have, and it carries 60 of the 100 points. */}
      <div className="alt-bars">
        <BreadthBar label="Beat BTC · 7d" pct={b.beatBtc7dPct} n={b.n7} />
        <BreadthBar label="Beat BTC · 30d" pct={b.beatBtc30dPct} n={b.n30} />
      </div>

      <div className="stats stats-2up alt-stats">
        <div className="stattile">
          <div className="stattile-label">BTC dominance</div>
          <div className="stattile-value num">{dom.pct == null ? '—' : `${dom.pct.toFixed(1)}%`}</div>
          <div className="tile-sub">
            {dom.trend === 'unknown'
              ? `trend unknown · ${dom.days ?? 0}d stored`
              : `${dom.trend}${dom.changePctPts30d == null ? '' : ` ${signed(dom.changePctPts30d, 2)}pts / ${dom.windowDays}d`}`}
          </div>
        </div>
        <div className="stattile">
          <div className="stattile-label">ETH / BTC</div>
          <div className={`stattile-value num ${tone(eth?.chg7dPct)}`}>{eth?.chg7dPct == null ? '—' : `${signed(eth.chg7dPct)}%`}</div>
          <div className="tile-sub">{eth?.chg30dPct == null ? '7d on the pair' : `30d ${signed(eth.chg30dPct)}% · ${eth.trend}`}</div>
        </div>
        <div className="stattile">
          <div className="stattile-label">Fear &amp; greed</div>
          <div className="stattile-value num">{fg?.value == null ? '—' : fg.value}</div>
          <div className="tile-sub">{fg?.label ?? 'feed unavailable'}</div>
        </div>
        <div className="stattile">
          <div className="stattile-label">Counted</div>
          <div className="stattile-value num">{b.n ?? 0}</div>
          <div className="tile-sub">top-100 alts{b.excluded ? `, ${b.excluded} excluded` : ''}</div>
        </div>
      </div>

      {degraded?.length > 0 && (
        <div className="guardrail">
          <span aria-hidden>⚠︎</span>
          <span>{degraded.join(' · ')}</span>
        </div>
      )}

      {(season.parts?.length > 0 || season.facts?.length > 0) && (
        <>
          <button className="btn ghost sm disclose" onClick={() => setWork((w) => !w)} aria-expanded={work}>
            {work ? 'hide the work' : 'how this scores'}
          </button>
          <Expand open={work}>
            {season.parts?.length > 0 && (
              <div className="tc-math">
                {season.parts.map((p) => (
                  <div className="tc-mrow" key={p.key}>
                    <span className="tc-mk">{p.label}</span>
                    {/* No pos/neg ink here, unlike the cockpit's version: every
                        part of this score is additive out of its own max, so
                        colouring them all green would say "good" about a
                        midpoint the file explicitly calls no-evidence. */}
                    <span className="tc-mp num">{p.points} / {p.max}</span>
                  </div>
                ))}
                <div className="tc-mrow total">
                  <span className="tc-mk">alt season</span>
                  <span className="tc-mp num">{season.score == null ? '—' : `${season.score} / 100`}</span>
                </div>
              </div>
            )}
            {season.facts?.length > 0 && (
              <ul className="factlist">{season.facts.map((f, i) => <li key={i} className="sub t-foot">{f}</li>)}</ul>
            )}
            <p className="sub t-foot alt-note">
              Breadth is 60 of the 100 points because it is the only rotation measure computable without an
              estimation step: how many of the eligible top 100 actually beat BTC over the same window.
              Stablecoins and wrapped tokens are excluded from the count — left in, USDT reads as a flawless
              low-volatility outperformer.
            </p>
          </Expand>
        </>
      )}
    </section>
  )
}

/** One breadth window. The bar is the share; the caption is the denominator,
 *  because "63%" out of 9 rows and out of 94 rows are different claims. */
function BreadthBar({ label, pct, n }) {
  const v = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null
  const hot = v != null && v >= 60
  const cold = v != null && v < 35
  return (
    <div className={`alt-bar${hot ? ' hot' : ''}${cold ? ' cold' : ''}`}>
      <div className="alt-bar-top">
        <span className="alt-bar-k">{label}</span>
        <span className="alt-bar-v num">{v == null ? '—' : `${Math.round(v)}%`}</span>
      </div>
      <div className="meter" role="img"
        aria-label={v == null ? `${label} unavailable` : `${Math.round(v)} percent of ${n ?? 0} eligible alts beat BTC`}>
        <div style={{ width: `${v == null ? 0 : v}%` }} />
      </div>
      <div className="tiny t-cap">{n ? `of ${n} eligible` : 'no eligible rows'}</div>
    </div>
  )
}

function signed(x, d = 1) {
  if (!Number.isFinite(x)) return '—'
  return `${x >= 0 ? '+' : ''}${x.toFixed(d)}`
}

function tone(x) {
  if (!Number.isFinite(x)) return 'flat'
  return x > 0 ? 'pos' : x < 0 ? 'neg' : 'flat'
}
