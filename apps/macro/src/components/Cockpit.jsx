// The cockpit: a dashboard, not a document. Reading order answers three
// questions in the order a trader actually asks them — can I trust this screen
// (health strip), what do I do and at what numbers (the call), and am I about to
// get stopped out (position) — before it explains itself (market reads) or offers
// planning surface (planner, run plan).
//
// Two hierarchy rules earn their keep here:
//   • The EXECUTABLE NUMBERS ride on the hero's face. The verb alone ("Enter
//     long") is not actionable; the shares/stop/risk are what you type into a
//     broker, so they are not allowed to hide behind a disclosure.
//   • Amber is spent only on things that change a decision. Data-provenance
//     footnotes and freshness live in the health strip as compact marks, because
//     an always-on amber paragraph trains you to ignore the colour that also
//     means "your stop is hit".
// Everything heavy — the reasoning, the regime facts, the full run plan — stays
// one tap away behind a disclosure.
import React, { useState } from 'react'
import { SkPage, Expand, FreshChip } from './primitives.jsx'
import { sizePosition, initialStop } from '../lib/risk.js'
import { fmtPx, round2 } from '../lib/format.js'
import RunPlan from './RunPlan.jsx'

const ACTION_COPY = {
  ENTER: 'Enter long',
  ADD: 'Add to position',
  HOLD: 'Hold',
  TRIM: 'Trim',
  EXIT: 'Exit',
  STOP_OUT: 'STOP OUT',
  STAND_ASIDE: 'Stand aside',
  NO_DATA: 'No data',
}

// The two directives whose numbers you would actually execute right now.
const ENTRY_ACTIONS = new Set(['ENTER', 'ADD'])
const FRESH_RANK = { live: 0, stale: 1, dead: 2 }

export default function Cockpit({ derived, settings, position, sources, onReload }) {
  const loading = sources.quote.loading && !sources.quote.data && !sources.quote.error
  if (loading && !derived.price) return <SkPage cards={4} />

  const failing = [
    sources.quote.error && 'MSTR quote',
    sources.btc.error && 'BTC',
    sources.mstr1d.error && 'MSTR history',
    sources.btc1d.error && 'BTC history',
    sources.settingsSrc.error && 'settings',
    sources.positionSrc.error && 'position',
  ].filter(Boolean)

  // Computed ONCE and shared by the hero ticket and the planner, so the two can
  // never disagree about the stop or the size (they each used to derive it).
  const plan = buildPlan(derived, settings, settings?.stopMode)

  return (
    <div className="grid stagger" data-testid="cockpit">
      <HealthStrip derived={derived} settings={settings} failing={failing} onReload={onReload} />
      <DirectiveHero derived={derived} plan={plan} />
      {position && <PositionCard derived={derived} position={position} />}
      <MarketReads derived={derived} settings={settings} />
      <EntryPlanner derived={derived} settings={settings} hasPosition={!!position} />
      <RunPlanDisclosure derived={derived} settings={settings} position={position} />
    </div>
  )
}

/** Shared sizing math: the stop for a given mode plus the position it implies. */
function buildPlan(derived, settings, mode) {
  if (!settings) return null
  const price = derived.price
  if (price == null) return null
  const stopPlan = initialStop({
    mode, entry: price, atr: derived.atrNow, atrMult: settings.atrMult,
    swingLow: derived.lastSwingLow, pct: settings.stopPct,
  })
  const size = stopPlan?.stop != null
    ? sizePosition({ equity: settings.equity, riskPct: settings.riskPct, entry: price, stop: stopPlan.stop, maxPositionPct: settings.maxPositionPct })
    : null
  return { stopPlan, size }
}

/** One row that answers "how much do I believe this screen": the worst feed's
 *  freshness, whether mNAV rests on estimates, any source trouble, and — the
 *  only place it existed before was inside an error row that requires an error —
 *  a Refresh you can always reach. On a phone this was previously impossible. */
function HealthStrip({ derived, settings, failing, onReload }) {
  const feeds = [
    { label: 'MSTR', fresh: derived.freshQuote },
    { label: 'BTC', fresh: derived.freshBtc },
    { label: 'MSTR 1d', fresh: derived.freshCandles },
    { label: 'BTC 1d', fresh: derived.freshBtcCandles },
  ].filter((f) => f.fresh)
  // Worst-of-four: four separate chips spent four slots to say one thing, and
  // the honest headline is the least trustworthy feed, not the average.
  const worst = feeds.slice().sort((a, b) => (FRESH_RANK[b.fresh.state] ?? 0) - (FRESH_RANK[a.fresh.state] ?? 0))[0]
  const degraded = feeds.filter((f) => f.fresh.state !== 'live')
  const seeded = settings?.btcHoldingsSeeded || settings?.sharesSeeded

  return (
    <section className="hstrip span2" data-testid="health-strip">
      <div className="hstrip-marks">
        {worst && (
          <FreshChip
            fresh={worst.fresh}
            label={degraded.length > 1 ? `${degraded.length} feeds` : worst.label}
            title={feeds.map((f) => `${f.label}: ${f.fresh.label}`).join(' · ')}
          />
        )}
        {seeded && (
          <span className="chip stale" title={`BTC holdings / share count are SEEDED estimates as of ${settings.btcHoldingsAsOf} — verify against the latest 8-K in Settings. mNAV is only as honest as those two numbers.`}>
            <span className="dot" />mNAV est
          </span>
        )}
        {failing.length > 0 && (
          <span className="chip dead" title={`Source trouble: ${failing.join(' · ')} — showing what's still trustworthy.`}>
            <span className="dot" />{failing.length} source{failing.length > 1 ? 's' : ''} down
          </span>
        )}
      </div>
      <button className="btn sm hstrip-btn" onClick={onReload}>Refresh</button>
    </section>
  )
}

/** The hero: the call AND its executable numbers. The verb used to be 30px while
 *  the quantity you would actually place sat at 14.5px — the hierarchy was
 *  inverted, so the ticket row now carries shares/stop/risk at full size. */
function DirectiveHero({ derived, plan }) {
  const d = derived.directive
  const [why, setWhy] = useState(false)
  // Freshness sentences are already the health strip's job; repeating them as
  // amber blocks here is what made the hero a wall of warnings.
  const guardrails = (d.guardrails || []).filter((g) => !/\bdata is (live|stale|dead)\b/i.test(g))
  const shown = guardrails.slice(0, 2)
  const hidden = guardrails.slice(2)
  const ticket = ENTRY_ACTIONS.has(d.action) && plan?.size?.ok ? plan : null

  return (
    <section className={`card directive span2 ${d.severity}`} data-testid="directive">
      <div className="action" data-testid="directive-action">{ACTION_COPY[d.action] ?? d.action}</div>
      <p className="headline">{d.headline}</p>

      {ticket && (
        <div className="ticket" data-testid="order-ticket">
          <div className="tk"><div className="k">Buy</div><div className="v num">{ticket.size.shares}<span className="u">sh</span></div></div>
          <div className="tk"><div className="k">Stop</div><div className="v num">{fmtPx(ticket.stopPlan.stop)}</div></div>
          <div className="tk"><div className="k">Risk</div><div className="v num">${Math.round(ticket.size.riskUsd).toLocaleString('en-US')}</div></div>
        </div>
      )}

      {shown.map((g, i) => (
        <div className="guardrail" key={i}><span aria-hidden>⚠︎</span><span>{g}</span></div>
      ))}

      {(d.reasons?.length > 0 || hidden.length > 0) && (
        <>
          <button className="btn ghost sm disclose" onClick={() => setWhy((w) => !w)} aria-expanded={why}>
            {why ? 'hide the reasoning' : hidden.length > 0 ? `why this call · +${hidden.length} more` : 'why this call'}
          </button>
          <Expand open={why}>
            {hidden.map((g, i) => (
              <div className="guardrail" key={`g${i}`}><span aria-hidden>⚠︎</span><span>{g}</span></div>
            ))}
            {d.reasons?.length > 0 && <ul>{d.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
          </Expand>
        </>
      )}
    </section>
  )
}

/** The market at a glance. The two regime SCORES are the tool's core judgement,
 *  so they render as meters you can compare at a glance instead of wrapping text
 *  badges; the supporting facts stay behind "show the work". */
function MarketReads({ derived, settings }) {
  const [open, setOpen] = useState(false)
  const { regime, btcAlign, torqueRead, beta, nav, rs, pullback, breakout } = derived
  const facts = [...regime.facts, ...(pullback?.facts ?? []), ...(breakout?.facts ?? []), ...btcAlign.facts]
  const seeded = settings?.btcHoldingsSeeded || settings?.sharesSeeded

  return (
    <section className="card span2" data-testid="market-reads">
      <div className="ttl">Market reads</div>

      <div className="smeters">
        <ScoreMeter name="MSTR" state={regime.state} score={regime.score} />
        <ScoreMeter name="BTC" state={btcAlign.state} score={btcAlign.score} />
      </div>

      {(pullback?.stage === 'trigger' || breakout?.active) && (
        <div className="signals">
          {pullback?.stage === 'trigger' && <span className="chip live"><span className="dot" />pullback trigger</span>}
          {breakout?.active && <span className="chip live"><span className="dot" />breakout {fmtPx(breakout.level)}</span>}
        </div>
      )}

      {/* Four tiles, hard 2-col on mobile — `auto-fit` fitted exactly three at
          390px, so a four-tile row always left a ragged orphan on its own line.
          "Implied BTC" is gone: it is mNAV x BTC price, so it spent a quarter of
          the row restating two tiles that are already here. */}
      <div className="stats stats-2up">
        <div className="stat"><div className="k">Beta vs BTC</div><div className="v num">{beta == null ? '—' : `${round2(beta)}×`}</div><div className="d">30-day daily</div></div>
        <div className="stat">
          <div className="k">mNAV{seeded && <span className="est" title="rests on seeded holdings — see Settings">est</span>}</div>
          <div className="v num">{nav?.mNav == null ? '—' : `${nav.mNav}×`}</div>
          <div className="d">{nav?.premiumPct == null ? 'premium' : `${nav.premiumPct >= 0 ? '+' : ''}${round2(nav.premiumPct)}% prem`}</div>
        </div>
        <div className="stat"><div className="k">20d RS</div><div className={`v num ${rs?.spreadPct == null ? '' : rs.spreadPct >= 0 ? 'pos' : 'neg'}`}>{rs?.spreadPct == null ? '—' : `${rs.spreadPct >= 0 ? '+' : ''}${round2(rs.spreadPct)}pp`}</div><div className="d">MSTR − BTC</div></div>
        <div className="stat"><div className="k">Leverage</div><div className={`v grade-${torqueRead.grade}`}>{torqueRead.grade}</div><div className="d">vs BTC torque</div></div>
      </div>

      {facts.length > 0 && (
        <>
          <button className="btn ghost sm disclose" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'hide the work' : 'show the work'}
          </button>
          <Expand open={open}>
            <ul className="factlist">
              {facts.map((f, i) => <li key={i} className="sub">{f}</li>)}
            </ul>
            <p className="sub torque-note">{torqueRead.text}</p>
          </Expand>
        </>
      )}
    </section>
  )
}

/** A 0-100 regime score as a meter — same domain for both, so MSTR vs BTC is a
 *  visual comparison instead of two numbers you have to hold in your head. */
function ScoreMeter({ name, state, score }) {
  const pct = score == null ? null : Math.max(0, Math.min(100, score))
  return (
    <div className={`smeter ${state}`}>
      <div className="smeter-top">
        <span className="smeter-name">{name}</span>
        <span className="smeter-state">{String(state).replace(/_/g, ' ')}</span>
        <span className="smeter-score num">{score == null ? '—' : score}</span>
      </div>
      <div className="smeter-track" role="img" aria-label={`${name} regime score ${score == null ? 'unknown' : `${score} of 100`}`}>
        <div style={{ width: `${pct == null ? 0 : pct}%` }} />
      </div>
    </div>
  )
}

/** The full run plan — kept out of the default glance. The collapsed row now
 *  carries live state instead of a static description of itself. */
function RunPlanDisclosure({ derived, settings, position }) {
  const [open, setOpen] = useState(false)
  const armed = [
    derived.pullback?.stage && derived.pullback.stage !== 'none' ? `pullback ${derived.pullback.stage}` : null,
    derived.breakout?.active ? 'breakout armed' : null,
  ].filter(Boolean)
  return (
    <div className="span2" data-testid="run-plan-disclosure">
      <button className="btn ghost disclose-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="dr-label">Run plan &amp; tickets</span>
        <span className="dr-state">{armed.length > 0 ? armed.join(' · ') : 'nothing armed'}</span>
        <span className={`dr-chev ${open ? 'open' : ''}`} aria-hidden>▾</span>
      </button>
      <Expand open={open}>
        <div className="grid" style={{ marginTop: 12 }}>
          <RunPlan derived={derived} settings={settings} position={position} />
        </div>
      </Expand>
    </div>
  )
}

function PositionCard({ derived, position }) {
  const { posDerived, price } = derived
  const r = posDerived?.r
  const eff = posDerived?.effStop
  const unrealized = Number.isFinite(price) ? (price - position.avgEntry) * position.shares : null
  const distPct = Number.isFinite(eff) && Number.isFinite(price) && price > 0 ? ((price - eff) / price) * 100 : null
  const meterCls = distPct == null ? '' : distPct < 3 ? 'danger' : distPct < 6 ? 'warn' : ''
  const initialRiskPct = position.avgEntry > 0 ? ((position.avgEntry - position.initialStop) / position.avgEntry) * 100 : null
  // The bar reads against an explicit 0-10% domain. It used to be distPct * 8,
  // which saturated at an unlabelled 12.5% — a half-full bar meant nothing.
  const DOMAIN = 10

  return (
    <section className="card span2" data-testid="position-card">
      <div className="ttl">Open position<span className="spacer" /><span className="pos-id num">{position.shares} @ {fmtPx(position.avgEntry)}</span></div>
      <div className="stats stats-2up">
        <div className="stat"><div className="k">Open R</div><div className={`v num ${r == null ? '' : r >= 0 ? 'pos' : 'neg'}`} data-testid="open-r">{r == null ? '—' : `${r >= 0 ? '+' : ''}${round2(r)}R`}</div></div>
        <div className="stat"><div className="k">Unrealized</div><div className={`v num ${unrealized == null ? '' : unrealized >= 0 ? 'pos' : 'neg'}`}>{unrealized == null ? '—' : `${unrealized < 0 ? '-' : ''}$${Math.abs(Math.round(unrealized)).toLocaleString('en-US')}`}</div></div>
        <div className="stat"><div className="k">Stop now</div><div className="v num">{eff == null ? '—' : fmtPx(eff)}</div><div className="d">{trailNote(position, posDerived)}</div></div>
        <div className="stat"><div className="k">To stop</div><div className={`v num ${meterCls === 'danger' ? 'neg' : ''}`}>{distPct == null ? '—' : `${round2(distPct)}%`}</div><div className="d">initial risk {initialRiskPct == null ? '—' : `${round2(initialRiskPct)}%`}</div></div>
      </div>
      <div className="stopbar">
        <div className={`meter ${meterCls}`} role="img" aria-label={distPct == null ? 'stop distance unknown' : `price is ${round2(distPct)} percent above the stop, on a 0 to ${DOMAIN} percent scale`}>
          <div style={{ width: `${distPct == null ? 0 : Math.max(3, Math.min(100, (distPct / DOMAIN) * 100))}%` }} />
        </div>
        <div className="tiny stopbar-scale"><span>0%</span><span>distance to stop</span><span>{DOMAIN}%+</span></div>
      </div>
    </section>
  )
}

function trailNote(position, pd) {
  if (!pd) return 'initial stop'
  if (pd.trailNow != null && pd.effStop === pd.trailNow) return 'chandelier trail'
  if (Number.isFinite(position.stopOverride) && pd.effStop === position.stopOverride) return 'manual override'
  if (Number.isFinite(position.stopHighWater) && pd.effStop === position.stopHighWater) return 'ratchet high-water'
  if (pd.effStop === position.avgEntry) return 'breakeven lock'
  return 'initial stop'
}

/** "If you enter now" — live sizing with editable stop mode. The discipline
 *  widget: change the mode, watch shares and risk recompute. Collapsed once a
 *  position is known; the whole title row is the control, because the old 12.5px
 *  "expand" word was a ~70px invisible target on a phone. */
function EntryPlanner({ derived, settings, hasPosition }) {
  const [mode, setMode] = useState(null)
  const [open, setOpen] = useState(!hasPosition)
  const userToggled = React.useRef(false)
  React.useEffect(() => {
    if (!userToggled.current) setOpen(!hasPosition)
  }, [hasPosition])
  if (!settings) return null
  const effMode = mode ?? settings.stopMode
  const price = derived.price
  const built = buildPlan(derived, settings, effMode)
  const plan = built?.stopPlan
  const sz = built?.size

  return (
    <section className="card span2" data-testid="entry-planner">
      <button className="ttl ttl-btn" onClick={() => { userToggled.current = true; setOpen((o) => !o) }} aria-expanded={open}>
        If you enter now
        <span className="spacer" />
        <span className="dr-state">{sz?.ok ? `${sz.shares} sh · ${fmtPx(plan.stop)}` : 'no plan'}</span>
        <span className={`dr-chev ${open ? 'open' : ''}`} aria-hidden>▾</span>
      </button>
      <Expand open={open}>
        <div className="seg seg-wide">
          {['atr', 'structure', 'percent'].map((m) => (
            <button key={m} className={effMode === m ? 'on' : ''} onClick={() => setMode(m)}>{m === 'atr' ? `ATR ×${settings.atrMult}` : m === 'structure' ? 'Swing low' : `${settings.stopPct}%`}</button>
          ))}
        </div>
        {price == null ? (
          <div className="empty"><div className="glyph">—</div>No live price to plan against.</div>
        ) : plan?.stop == null ? (
          <div className="empty">Stop can't be computed: {plan?.detail ?? 'no data'} <span className="tiny">({plan?.warning})</span></div>
        ) : (
          <>
            <div className="stats stats-2up">
              <div className="stat"><div className="k">Buy</div><div className="v num" data-testid="plan-shares">{sz?.ok ? `${sz.shares} sh` : '—'}</div><div className="d">≈ ${sz?.ok ? Math.round(sz.positionUsd).toLocaleString('en-US') : '—'}</div></div>
              <div className="stat"><div className="k">Stop</div><div className="v num">{fmtPx(plan.stop)}</div><div className="d">{plan.detail}</div></div>
              <div className="stat"><div className="k">Risk</div><div className="v num">{sz?.ok ? `$${Math.round(sz.riskUsd).toLocaleString('en-US')}` : '—'}</div><div className="d">{settings.riskPct}% of equity{sz?.capped ? ' · CAPPED' : ''}</div></div>
              <div className="stat"><div className="k">Position</div><div className="v num">{sz?.ok ? `${sz.positionPct}%` : '—'}</div><div className="d">max {settings.maxPositionPct}%</div></div>
            </div>
            {!sz?.ok && sz?.error && <div className="guardrail"><span>⚠︎</span><span>{sizingErrorCopy(sz.error)}</span></div>}
            <p className="tiny planner-note">
              Advisory only — place orders at your broker. A stop is a decision made now, not in the moment.
            </p>
          </>
        )}
      </Expand>
    </section>
  )
}

function sizingErrorCopy(code) {
  return {
    risk_too_small_for_one_share: 'Your risk budget doesn\'t buy one whole share at this stop distance — widen risk % or wait for a tighter setup.',
    stop_not_below_entry: 'Computed stop is not below the entry price.',
    bad_input: 'Sizing inputs incomplete.',
  }[code] ?? code
}
