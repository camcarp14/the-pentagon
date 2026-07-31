// The cockpit: ONE answer, then the evidence for it.
//
// Earlier versions were a stack of five honest cards, none of which answered the
// question by itself: readiness gates in one, sizing in another, the stop in a
// third, what would invalidate the thesis two taps down in a fourth. You had to
// assemble the trade yourself from parts. The tab now opens with a single card
// that states the window as a 0-10 score and answers what to do, long or short,
// how much, what leverage, where to get in, where to get out, and what abandons
// the idea — each as one row with the number you would act on.
//
// Everything below that card is the SAME material as before, collapsed. It is
// evidence now, not headline. The rule for what stays visible: a row earns the
// default glance only if it changes what you would type into a broker.
//
// Amber is still spent only on things that change a decision. Data provenance and
// freshness live in the health strip as compact marks, because an always-on amber
// paragraph trains you to ignore the colour that also means "your stop is hit".
import React, { useMemo, useState } from 'react'
import { SkPage, Expand, FreshChip } from './primitives.jsx'
import { sizePosition, initialStop } from '../lib/risk.js'
import { armChecklist } from '../lib/runplan.js'
import { fmtPx, round2 } from '../lib/format.js'
import TradeCard from './TradeCard.jsx'
import RunPlan from './RunPlan.jsx'

const FRESH_RANK = { live: 0, stale: 1, dead: 2 }

// The arm checklist's own labels are full sentences ("close above EMA20 (99.09)")
// because the run plan renders them as prose. In a scannable table the sentence
// IS the noise: the level already has its own column, so each gate needs a short,
// fixed-width key instead.
const GATE_LABELS = {
  close_ema20: 'EMA20',
  close_ema50: 'EMA50',
  ema_stack: 'EMA stack',
  ema50_rising: 'EMA50 slope',
  higher_lows: 'Higher lows',
  btc_confirm: 'BTC 50d',
}
const shortLabel = (id) => GATE_LABELS[id] || id

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
  // An expired session fails EVERY source at once, and listing six dead feeds
  // buries the one thing that actually fixes it. Report the cause, not the
  // symptom count.
  const sessionExpired = Object.values(sources).some((s) => /session expired/i.test(s?.error || ''))

  // Computed ONCE and shared by the hero ticket and the planner, so the two can
  // never disagree about the stop or the size (they each used to derive it).
  const plan = buildPlan(derived, settings, settings?.stopMode)

  return (
    <div className="grid stagger" data-testid="cockpit">
      <HealthStrip derived={derived} settings={settings} failing={failing} sessionExpired={sessionExpired} onReload={onReload} />
      <TradeCard derived={derived} settings={settings} position={position} plan={plan} />
      {/* An open position is the one thing that outranks the answer card, because
          it is the only state where doing nothing has a cost. */}
      {position && <PositionCard derived={derived} position={position} />}
      {/* Evidence, in the order you would ask for it: what is still blocking the
          window, then the raw market reads, then the two planning surfaces. */}
      <EntryReadiness derived={derived} />
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
function HealthStrip({ derived, settings, failing, sessionExpired, onReload }) {
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
        {/* Named in VISIBLE text, not a title tooltip: title does not exist on
            touch, so on the platform this dashboard is mostly read on, "which
            source is down" would have been unreachable — and unannounced to a
            screen reader. role=alert so it is spoken when it appears. */}
        {failing.length > 0 && (
          <span className="chip dead hstrip-fail" role="alert">
            <span className="dot" />{sessionExpired ? 'session expired — sign in again' : `${failing.join(' · ')} down`}
          </span>
        )}
      </div>
      <button className="btn quiet sm hstrip-btn" onClick={onReload}>Refresh</button>
    </section>
  )
}

/** ENTRY READINESS — the gate-by-gate working behind the window score.
 *
 *  The answer card states the score; this says which of the six gates are met and
 *  what price flips each one that is not. It is COLLAPSED by default now: with the
 *  score and the nearest-gate line already on the card above, an always-open table
 *  of six gates was the biggest single block of the tab and repeated its headline.
 *
 *  Distances are deliberately not sugar-coated: "+7.3% away" means the
 *  confirmation costs 7.3%, and that is the price of not buying a falling knife.
 */
function EntryReadiness({ derived }) {
  const [open, setOpen] = useState(false)
  const [blocks, setBlocks] = useState(false)
  const radar = useMemo(
    () => armChecklist(derived.mstrCandles, derived.btcCandles),
    [derived.mstrCandles, derived.btcCandles],
  )
  if (radar.insufficient) return null

  const gates = [
    ...radar.mstr,
    {
      id: 'btc_confirm',
      label: `BTC confirms${radar.btc.score != null ? ` (${String(radar.btc.state).replace(/_/g, ' ')} ${radar.btc.score})` : ''}`,
      pass: radar.btc.pass,
      level: radar.btc.level,
      distancePct: radar.btc.pass ? null : radar.btc.distancePct,
      note: radar.btc.note,
    },
  ]
  const passed = gates.filter((g) => g.pass).length
  const blocking = gates.filter((g) => !g.pass)
  // The single most useful line: of the gates still blocking, the one closest in
  // price. Gates with no price level (trend shape) can't be ranked this way.
  const nearest = blocking.filter((g) => g.distancePct != null).sort((a, b) => a.distancePct - b.distancePct)[0]
  const bo = radar.paths?.breakout
  const pb = radar.paths?.pullback
  const tone = radar.armed ? 'armed' : radar.ready ? 'ready' : passed >= gates.length - 2 ? 'close' : 'far'
  // Two kinds of gate, and they deserve different shapes on screen. A PRICE gate
  // has a level and a distance, so it belongs in an aligned numeric table you can
  // scan down. A SHAPE gate (the stack, the slope, higher lows) is binary and has
  // no distance — as a full row it was three lines of identical dead weight, so
  // it reads better as a chip.
  const priceGates = gates.filter((g) => g.level != null)
  const shapeGates = gates.filter((g) => g.level == null)

  return (
    <section className="card pad-md span2 readiness" data-testid="entry-readiness">
      {/* The whole title row is the control — a 12.5px "expand" word was a ~70px
          invisible target on a phone. */}
      <button className="ttl ttl-btn t-label" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        What has to change
        <span className="dr-state">
          {radar.armed ? 'armed' : radar.ready ? 'waiting on a trigger' : `${passed} of ${gates.length} gates`}
        </span>
        <span className={`dr-chev ${open ? 'open' : ''}`} aria-hidden>▾</span>
      </button>
      <Expand open={open}>

      {/* Segment pips, not a big numeral beside a wrapping paragraph: six gates
          read as six marks. Filled by COUNT, left to right — lighting the pip
          that matches each gate's position instead made "1 of 6" illuminate a
          lone pip mid-row, which reads as arbitrary. */}
      <div className={`rd-pips ${tone}`} role="img" aria-label={`${passed} of ${gates.length} entry gates met`}>
        {gates.map((g, i) => <span key={g.id} className={i < passed ? 'on' : ''} />)}
      </div>

      <p className={`rd-next ${tone}`}>
        {radar.armed
          ? 'Every gate is met and a trigger is live — the call above is live.'
          : radar.ready
            ? pb?.stage === 'setup'
              ? 'Regime and BTC confirm. Pullback setup forming — a close above the prior bar\'s high arms it.'
              : bo?.level != null
                ? `Regime and BTC confirm. Waiting on a break above ${fmtPx(bo.level)}.`
                : 'Regime and BTC confirm. Waiting on a pullback reclaim or a breakout.'
            : nearest
              ? <>Nearest gate is <strong>{shortLabel(nearest.id)}</strong>, {nearest.distancePct > 0 ? '+' : ''}{nearest.distancePct}% away.</>
              : 'What is left is trend shape, not price — it needs time above the averages, not one move.'}
      </p>

      {priceGates.length > 0 && (
        <div className="rd-table">
          {priceGates.map((g) => (
            <div key={g.id} className={`rd-row ${g.pass ? 'pass' : 'fail'}`}>
              <span className="rd-mark" aria-hidden>{g.pass ? '✓' : ''}</span>
              <span className="rd-key">{shortLabel(g.id)}</span>
              <span className="rd-lvl num">{fmtPx(g.level)}</span>
              <span className="rd-dist num">{g.pass ? 'held' : g.distancePct == null ? '—' : `${g.distancePct > 0 ? '+' : ''}${g.distancePct}%`}</span>
            </div>
          ))}
        </div>
      )}

      {shapeGates.length > 0 && (
        <div className="rd-shape">
          <span className="rd-shape-k t-label">Trend shape</span>
          {/* Own row, equal columns: inline with the label these three wrapped
              2-then-1 and read ragged. */}
          <div className="rd-tags">
            {shapeGates.map((g) => (
              <span key={g.id} className={`rd-tag ${g.pass ? 'on' : ''}`}>
                <span aria-hidden>{g.pass ? '✓' : '○'}</span>{shortLabel(g.id)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Same hairline-cell treatment as the hero's order ticket, so the two
          numeric strips on this page read as one instrument family. */}
      <div className="ticket rd-ticket">
        <div className="tk">
          <div className="k t-label">Breakout</div>
          <div className={`v num ${bo?.active ? 'good' : ''}`}>
            {bo?.active ? 'live' : bo?.level != null ? fmtPx(bo.level) : '—'}
          </div>
          {!bo?.active && bo?.distancePct != null && <div className="tk-sub num">{bo.distancePct > 0 ? '+' : ''}{bo.distancePct}%</div>}
        </div>
        <div className="tk">
          <div className="k t-label">Pullback</div>
          <div className={`v cap ${pb?.stage === 'trigger' ? 'good' : ''}`}>{!pb?.stage || pb.stage === 'none' ? 'none' : pb.stage}</div>
          <div className="tk-sub">{pb?.stage === 'setup' ? 'arming' : pb?.stage === 'trigger' ? 'fires now' : 'no dip yet'}</div>
        </div>
        <div className="tk">
          <div className="k t-label">Leverage</div>
          <div className={`v cap grade-${derived.torqueRead.grade}`}>{derived.torqueRead.grade}</div>
          <div className="tk-sub num">{derived.beta == null ? '—' : `${round2(derived.beta)}× beta`}</div>
        </div>
      </div>

      {/* Nested one level deeper: the per-gate prose is the long-form "why", and
          the table plus the strip above already answer it for most visits. */}
      <button className="btn ghost sm disclose" onClick={() => setBlocks((b) => !b)} aria-expanded={blocks}>
        {blocks ? 'hide the detail' : 'gate by gate'}
      </button>
      <Expand open={blocks}>
        <ul className="factlist">
          {blocking.length === 0 && <li className="sub t-foot">Nothing — every gate is met.</li>}
          {blocking.map((g) => (
            <li key={g.id} className="sub t-foot">
              <strong>{g.label}</strong>
              {g.level != null && <> · level {fmtPx(g.level)}</>}
              {g.distancePct != null && <> · {g.distancePct > 0 ? '+' : ''}{g.distancePct}% away</>}
              {g.note && <> — {g.note}</>}
            </li>
          ))}
        </ul>
      </Expand>

      </Expand>
    </section>
  )
}

/** The market at a glance — the inputs, not the answer. Collapsed by default:
 *  every number here feeds the window score above, so on a normal visit it is
 *  reference material. The collapsed row carries the two regime scores, which is
 *  the one thing worth seeing without opening it. */
function MarketReads({ derived, settings }) {
  const [open, setOpen] = useState(false)
  const [work, setWork] = useState(false)
  const { regime, btcAlign, torqueRead, beta, nav, rs, pullback, breakout } = derived
  const facts = [...regime.facts, ...(pullback?.facts ?? []), ...(breakout?.facts ?? []), ...btcAlign.facts]
  const seeded = settings?.btcHoldingsSeeded || settings?.sharesSeeded

  return (
    <section className="card pad-md span2" data-testid="market-reads">
      <button className="ttl ttl-btn t-label" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Market reads
        <span className="dr-state num">MSTR {regime.score ?? '—'} · BTC {btcAlign.score ?? '—'}</span>
        <span className={`dr-chev ${open ? 'open' : ''}`} aria-hidden>▾</span>
      </button>
      <Expand open={open}>

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
      {/* The kit's stat tiles. This was a hand-rolled .stat whose label was
          10.5px UPPERCASE tracked 0.8px — .t-label done by hand, a size and a
          half too small, on the only screen where a misread costs money. */}
      <div className="stats stats-2up">
        <div className="stattile"><div className="stattile-label">Beta vs BTC</div><div className="stattile-value num">{beta == null ? '—' : `${round2(beta)}×`}</div><div className="tile-sub">30-day daily</div></div>
        <div className="stattile">
          <div className="stattile-label">mNAV{seeded && <span className="est" title="rests on seeded holdings — see Settings">est</span>}</div>
          <div className="stattile-value num">{nav?.mNav == null ? '—' : `${nav.mNav}×`}</div>
          <div className="tile-sub">{nav?.premiumPct == null ? 'premium' : `${nav.premiumPct >= 0 ? '+' : ''}${round2(nav.premiumPct)}% prem`}</div>
        </div>
        <div className="stattile"><div className="stattile-label">20d RS</div><div className={`stattile-value num ${rs?.spreadPct == null ? '' : rs.spreadPct >= 0 ? 'pos' : 'neg'}`}>{rs?.spreadPct == null ? '—' : `${rs.spreadPct >= 0 ? '+' : ''}${round2(rs.spreadPct)}pp`}</div><div className="tile-sub">MSTR − BTC</div></div>
        <div className="stattile"><div className="stattile-label">Leverage</div><div className={`stattile-value grade-${torqueRead.grade}`}>{torqueRead.grade}</div><div className="tile-sub">vs BTC torque</div></div>
      </div>

      {facts.length > 0 && (
        <>
          <button className="btn ghost sm disclose" onClick={() => setWork((w) => !w)} aria-expanded={work}>
            {work ? 'hide the work' : 'show the work'}
          </button>
          <Expand open={work}>
            <ul className="factlist">
              {facts.map((f, i) => <li key={i} className="sub t-foot">{f}</li>)}
            </ul>
            <p className="sub t-foot torque-note">{torqueRead.text}</p>
          </Expand>
        </>
      )}

      </Expand>
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
  // Same card + title-button shape as the three disclosures above it. As a bare
  // `.disclose-row` it was the one odd control in a stack of four and read like
  // it belonged to a different screen.
  return (
    <section className="card pad-md span2" data-testid="run-plan-disclosure">
      <button className="ttl ttl-btn t-label" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Run plan &amp; tickets
        <span className="dr-state">{armed.length > 0 ? armed.join(' · ') : 'nothing armed'}</span>
        <span className={`dr-chev ${open ? 'open' : ''}`} aria-hidden>▾</span>
      </button>
      <Expand open={open}>
        <div className="grid" style={{ marginTop: 12 }}>
          <RunPlan derived={derived} settings={settings} position={position} />
        </div>
      </Expand>
    </section>
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
    <section className="card pad-md span2" data-testid="position-card">
      <div className="ttl t-label">Open position<span className="spacer" /><span className="pos-id num">{position.shares} @ {fmtPx(position.avgEntry)}</span></div>
      <div className="stats stats-2up">
        <div className="stattile"><div className="stattile-label">Open R</div><div className={`stattile-value num ${r == null ? '' : r >= 0 ? 'pos' : 'neg'}`} data-testid="open-r">{r == null ? '—' : `${r >= 0 ? '+' : ''}${round2(r)}R`}</div></div>
        <div className="stattile"><div className="stattile-label">Unrealized</div><div className={`stattile-value num ${unrealized == null ? '' : unrealized >= 0 ? 'pos' : 'neg'}`}>{unrealized == null ? '—' : `${unrealized < 0 ? '-' : ''}$${Math.abs(Math.round(unrealized)).toLocaleString('en-US')}`}</div></div>
        <div className="stattile"><div className="stattile-label">Stop now</div><div className="stattile-value num">{eff == null ? '—' : fmtPx(eff)}</div><div className="tile-sub">{trailNote(position, posDerived)}</div></div>
        <div className="stattile"><div className="stattile-label">To stop</div><div className={`stattile-value num ${meterCls === 'danger' ? 'neg' : ''}`}>{distPct == null ? '—' : `${round2(distPct)}%`}</div><div className="tile-sub">initial risk {initialRiskPct == null ? '—' : `${round2(initialRiskPct)}%`}</div></div>
      </div>
      <div className="stopbar">
        <div className={`meter ${meterCls}`} role="img" aria-label={distPct == null ? 'stop distance unknown' : `price is ${round2(distPct)} percent above the stop, on a 0 to ${DOMAIN} percent scale`}>
          <div style={{ width: `${distPct == null ? 0 : Math.max(3, Math.min(100, (distPct / DOMAIN) * 100))}%` }} />
        </div>
        <div className="tiny t-cap stopbar-scale"><span>0%</span><span>distance to stop</span><span>{DOMAIN}%+</span></div>
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
  const liveEntry = derived.directive?.action === 'ENTER' || derived.directive?.action === 'ADD'

  return (
    <section className="card pad-md span2" data-testid="entry-planner">
      {/* No .spacer here: .dr-state already carries margin-left:auto, and two
          auto margins split the free space instead of pushing to the edge. */}
      {/* "hypothetical:" when the answer card says to stay flat. Without it the
          collapsed row printed a share count directly under a card whose "How
          much" row read "nothing" — two numbers that look like a contradiction,
          on the screen where a misread costs money. */}
      <button className="ttl ttl-btn t-label" onClick={() => { userToggled.current = true; setOpen((o) => !o) }} aria-expanded={open}>
        If you enter now
        <span className="dr-state">
          {sz?.ok ? `${liveEntry ? '' : 'hypothetical: '}${sz.shares} sh · ${fmtPx(plan.stop)}` : 'no plan'}
        </span>
        <span className={`dr-chev ${open ? 'open' : ''}`} aria-hidden>▾</span>
      </button>
      <Expand open={open}>
        <div className="seg seg-wide" role="tablist">
          {['atr', 'structure', 'percent'].map((m) => (
            <button key={m} type="button" role="tab" aria-selected={effMode === m} className={effMode === m ? 'seg-opt active' : 'seg-opt'} onClick={() => setMode(m)}>{m === 'atr' ? `ATR ×${settings.atrMult}` : m === 'structure' ? 'Swing low' : `${settings.stopPct}%`}</button>
          ))}
        </div>
        {price == null ? (
          <div className="empty">
            <div className="glyph" aria-hidden>—</div>
            <div className="empty-title">No live price to plan against</div>
            {/* an empty state that only says what is missing is a dead end */}
            <div className="empty-sub">Tap Refresh at the top of the tab, or check Settings → Data sources to see which feed is down.</div>
          </div>
        ) : plan?.stop == null ? (
          <div className="empty">
            <div className="empty-title">Stop can’t be computed</div>
            <div className="empty-sub">{plan?.detail ?? 'no data'} ({plan?.warning}). Pick another stop mode above, or add price history by refreshing.</div>
          </div>
        ) : (
          <>
            <div className="stats stats-2up">
              <div className="stattile"><div className="stattile-label">Buy</div><div className="stattile-value num" data-testid="plan-shares">{sz?.ok ? `${sz.shares} sh` : '—'}</div><div className="tile-sub">≈ ${sz?.ok ? Math.round(sz.positionUsd).toLocaleString('en-US') : '—'}</div></div>
              <div className="stattile"><div className="stattile-label">Stop</div><div className="stattile-value num">{fmtPx(plan.stop)}</div><div className="tile-sub">{plan.detail}</div></div>
              <div className="stattile"><div className="stattile-label">Risk</div><div className="stattile-value num">{sz?.ok ? `$${Math.round(sz.riskUsd).toLocaleString('en-US')}` : '—'}</div><div className="tile-sub">{settings.riskPct}% of equity{sz?.capped ? ' · CAPPED' : ''}</div></div>
              <div className="stattile"><div className="stattile-label">Position</div><div className="stattile-value num">{sz?.ok ? `${sz.positionPct}%` : '—'}</div><div className="tile-sub">max {settings.maxPositionPct}%</div></div>
            </div>
            {!sz?.ok && sz?.error && <div className="guardrail"><span>⚠︎</span><span>{sizingErrorCopy(sz.error)}</span></div>}
            <p className="tiny t-cap planner-note">
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
