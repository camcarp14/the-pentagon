// THE ANSWER CARD — the whole cockpit compressed into one score and six rows.
//
// The cockpit used to open with a verb, then make you assemble the actual trade
// from four other cards: readiness gates in one, sizing in another, the stop in a
// third, what would kill the thesis in a fourth behind two taps. Every one of
// those cards was honest and none of them answered the question on its own.
//
// This card answers it. Six rows, one per decision, each with the number you
// would act on and a one-line reason. Everything that used to be above the fold
// is still on the tab — it is just below this now, collapsed, as the evidence
// rather than the headline.
//
// The rows read from the DIRECTIVE (advice.js) wherever an action is implied, and
// from the same shared plan object the entry planner uses. That is deliberate:
// two places on one screen disagreeing about a stop price is worse than either
// one being absent.
import React, { useMemo, useState } from 'react'
import { Expand } from './primitives.jsx'
import { armChecklist, thesisBreaks } from '../lib/runplan.js'
import { tradeWindow, directionRead } from '../lib/window.js'
import { fmtPx, round2 } from '../lib/format.js'

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
const ENTRY_ACTIONS = new Set(['ENTER', 'ADD'])

export default function TradeCard({ derived, settings, position, plan }) {
  const d = derived.directive
  const [why, setWhy] = useState(false)

  const arm = useMemo(
    () => armChecklist(derived.mstrCandles, derived.btcCandles),
    [derived.mstrCandles, derived.btcCandles],
  )
  const breaks = useMemo(
    () => thesisBreaks(derived.mstrCandles, derived.btcCandles),
    [derived.mstrCandles, derived.btcCandles],
  )
  const win = useMemo(() => tradeWindow({
    arm,
    pullback: derived.pullback,
    breakout: derived.breakout,
    torqueRead: derived.torqueRead,
    mNav: derived.nav?.mNav ?? null,
  }), [arm, derived.pullback, derived.breakout, derived.torqueRead, derived.nav])

  const dir = directionRead(d.action)
  const quoteLive = derived.freshQuote?.state === 'live'
  // ADD is sized at riskPct x addRiskFraction off the same stop, so the full-risk
  // plan would print roughly double the shares the headline recommends.
  const sizing = d.action === 'ADD' ? derived.addSizing : plan?.size
  const canSize = quoteLive && sizing?.ok && plan?.stopPlan?.stop != null

  // Anchored to MSTR. The old unanchored pattern also matched "BTC data is
  // stale", and since advice.js only emits the MSTR rail when the quote is NOT
  // live, a live quote meant this filter's ONLY possible effect was deleting the
  // BTC feed warning — from shownRails and hiddenRails both, because it runs
  // before the slice.
  const guardrails = (d.guardrails || []).filter((g) => !(quoteLive && /^MSTR data is (live|stale|dead)\b/i.test(g)))
  const shownRails = guardrails.slice(0, 2)
  const hiddenRails = guardrails.slice(2)

  return (
    <section className={`card span2 tcard ${d.severity}`} data-testid="trade-card">
      {/* ── the score ─────────────────────────────────────────────────────── */}
      <div className={`tc-head band-${win.band}`}>
        <div className="tc-score">
          <span className="tc-num num" data-testid="window-score">{win.score == null ? '—' : win.score}</span>
          <span className="tc-den num">/ {win.max}</span>
        </div>
        <div className="tc-headtext">
          <div className="tc-label">{win.label}</div>
          <div className="tc-plain">{win.plain}</div>
        </div>
      </div>

      <div className={`tc-pips band-${win.band}`} role="img"
        aria-label={win.score == null ? 'trade window unknown' : `trade window ${win.score} out of ${win.max}`}>
        {Array.from({ length: win.max }, (_, i) => <span key={i} className={win.score != null && i < win.score ? 'on' : ''} />)}
      </div>

      {/* ── the six answers ───────────────────────────────────────────────── */}
      <dl className="tc-rows" data-testid="trade-rows">
        <Row
          k="Do what"
          v={ACTION_COPY[d.action] ?? d.action}
          tone={dir.tone}
          note={d.headline}
        />
        {/* "Long/short", not "Long or short": at 92px the longer key wrapped to
            two lines and pushed the row taller than the answer in it. */}
        <Row
          k="Long/short"
          v={dir.text}
          tone={dir.tone}
          note={`${dir.note} — long-only rules, no short read`}
        />
        <Row
          k="How much"
          v={canSize
            ? `${sizing.shares} sh`
            : position
              ? `${position.shares} sh held`
              : 'nothing'}
          note={sizeNote({ canSize, sizing, settings, position, action: d.action, win })}
        />
        <Row
          k="Leverage"
          v={derived.beta == null ? '—' : `${round2(derived.beta)}× BTC`}
          // 'efficient', not 'cheap' — torque.js has only ever emitted
          // efficient/fair/rich/unknown, so the green tone was unreachable.
          tone={derived.torqueRead?.grade === 'rich' ? 'warn' : derived.torqueRead?.grade === 'efficient' ? 'go' : 'flat'}
          note={leverageNote(derived)}
        />
        <Row
          k="Get in"
          v={entryRow(d, derived, arm).v}
          tone={entryRow(d, derived, arm).tone}
          note={entryRow(d, derived, arm).note}
        />
        <Row
          k="Get out"
          v={exitRow(derived, plan, position).v}
          tone={exitRow(derived, plan, position).tone}
          note={exitRow(derived, plan, position).note}
        />
        {/* "no level", not "see below": the first break is usually a swing low
            and has a price, but the downtrend-score break does not, and there is
            nothing below this row to see — the note beside it IS the answer. */}
        <Row
          k="Abandon it"
          v={breaks.length ? (breaks[0].level != null ? fmtPx(breaks[0].level) : 'no level') : '—'}
          tone="flat"
          note={breaks.length ? breaks[0].label : 'not enough history to set an invalidation level'}
        />
      </dl>

      {shownRails.map((g, i) => (
        <div className="guardrail" key={i}><span aria-hidden>⚠︎</span><span>{g}</span></div>
      ))}

      {/* ── the evidence, one tap away ────────────────────────────────────── */}
      {(d.reasons?.length > 0 || hiddenRails.length > 0 || win.parts.length > 0) && (
        <>
          <button className="btn ghost sm disclose" onClick={() => setWhy((w) => !w)} aria-expanded={why}>
            {why ? 'hide the reasoning' : hiddenRails.length > 0 ? `why · +${hiddenRails.length} more warning${hiddenRails.length > 1 ? 's' : ''}` : 'why this score'}
          </button>
          <Expand open={why}>
            {hiddenRails.map((g, i) => (
              <div className="guardrail" key={`g${i}`}><span aria-hidden>⚠︎</span><span>{g}</span></div>
            ))}
            {win.parts.length > 0 && (
              <div className="tc-math">
                {win.parts.map((p) => (
                  <div className="tc-mrow" key={p.key}>
                    <span className="tc-mk">{p.label}</span>
                    <span className={`tc-mp num ${p.points > 0 ? 'pos' : p.points < 0 ? 'neg' : ''}`}>
                      {p.points > 0 ? '+' : ''}{p.points}
                    </span>
                  </div>
                ))}
                <div className="tc-mrow total">
                  <span className="tc-mk">window</span>
                  <span className="tc-mp num">{win.score == null ? '—' : `${win.score} / ${win.max}`}</span>
                </div>
              </div>
            )}
            {d.reasons?.length > 0 && <ul className="factlist">{d.reasons.map((r, i) => <li key={i} className="sub">{r}</li>)}</ul>}
            <p className="sub tc-foot">
              8 or more means the rules would take the trade. 6&ndash;7 means the trend is confirmed and only the
              trigger is missing. Below 3 there is no long edge at all. The leverage figure is MSTR&rsquo;s own beta to
              BTC &mdash; it is the instrument, not borrowed money, so &ldquo;how much&rdquo; is the only exposure dial here.
              Advisory only &mdash; place orders at your broker.
            </p>
          </Expand>
        </>
      )}
    </section>
  )
}

function Row({ k, v, note, tone = 'flat' }) {
  return (
    <div className="tc-row">
      <dt className="tc-k">{k}</dt>
      <dd className="tc-v">
        <span className={`tc-val tone-${tone}`}>{v}</span>
        {note && <span className="tc-note">{note}</span>}
      </dd>
    </div>
  )
}

/** How much, and against what risk budget — the engine's own numbers, never a
 *  leverage multiple invented here. */
function sizeNote({ canSize, sizing, settings, position, action, win }) {
  if (canSize) {
    const risk = `$${Math.round(sizing.riskUsd).toLocaleString('en-US')} at risk`
    const pct = sizing.positionPct != null ? `, ${sizing.positionPct}% of equity` : ''
    const budget = action === 'ADD'
      ? `add rung: ${round2((settings?.riskPct ?? 0) * (settings?.addRiskFraction ?? 0.5))}% of equity`
      : `full risk rung: ${settings?.riskPct ?? '—'}% of equity`
    return `${risk}${pct} — ${budget}${sizing.capped ? ', capped by max position size' : ''}`
  }
  if (position) return 'holding what you have — no size to add at this score'
  if (win.score != null && win.score >= 8) return 'the setup is there but the position cannot be sized — see the warnings'
  return 'stay flat until the window opens'
}

/** Kept to one line. The standing caveat — that this leverage is the instrument's
 *  own, not borrowed money — belongs in the footnote, not repeated on every read. */
function leverageNote(derived) {
  const grade = derived.torqueRead?.grade
  const mnav = derived.nav?.mNav
  const prem = derived.nav?.premiumPct
  const bits = [
    grade ? `${grade} way to own BTC now` : null,
    mnav == null ? null : `mNAV ${mnav}×${prem == null ? '' : ` (${prem >= 0 ? '+' : ''}${round2(prem)}% to NAV)`}`,
  ].filter(Boolean)
  return bits.length ? bits.join(' · ') : 'leverage read unavailable'
}

/** Where the entry is: at market when a directive is live, otherwise the price
 *  that would arm one, with the honest distance to it. */
function entryRow(d, derived, arm) {
  if (ENTRY_ACTIONS.has(d.action)) {
    return {
      v: derived.price == null ? 'now' : `now, ~${fmtPx(derived.price)}`,
      tone: 'go',
      note: 'the trigger is live — this is the entry',
    }
  }
  if (d.action === 'HOLD' || d.action === 'TRIM') {
    return { v: 'already in', tone: 'hold', note: 'no new entry while the position runs' }
  }
  const pb = arm.paths?.pullback
  const bo = arm.paths?.breakout
  if (arm.ready && pb?.stage === 'setup' && pb.refHigh != null) {
    return {
      v: `above ${fmtPx(pb.refHigh)}`,
      tone: 'warn',
      note: 'pullback is set — a close above the prior bar\'s high arms the entry',
    }
  }
  if (bo?.level != null) {
    const dist = bo.distancePct == null ? null : `${bo.distancePct > 0 ? '+' : ''}${bo.distancePct}% away`
    return {
      v: `above ${fmtPx(bo.level)}`,
      tone: arm.ready ? 'warn' : 'flat',
      note: [dist, arm.ready ? 'trend confirmed — this level is the last thing missing' : 'and the trend gates below have to be met first'].filter(Boolean).join(' · '),
    }
  }
  return { v: 'no level yet', tone: 'flat', note: 'the trend has to build before an entry price means anything' }
}

/** Where the exit is: the live effective stop when a position exists, otherwise
 *  the stop the plan would place if you entered now. */
function exitRow(derived, plan, position) {
  const eff = derived.posDerived?.effStop
  const price = derived.price
  if (position && Number.isFinite(eff)) {
    const dist = Number.isFinite(price) && price > 0 ? ((price - eff) / price) * 100 : null
    return {
      v: fmtPx(eff),
      tone: dist != null && dist < 3 ? 'bad' : dist != null && dist < 6 ? 'warn' : 'hold',
      note: dist == null ? 'your live stop' : `your live stop, ${round2(dist)}% below price — sell if it closes here`,
    }
  }
  const s = plan?.stopPlan?.stop
  if (Number.isFinite(s)) {
    const dist = Number.isFinite(price) && price > 0 ? ((price - s) / price) * 100 : null
    return {
      v: fmtPx(s),
      tone: 'flat',
      note: `where the stop would go if you entered now${dist == null ? '' : `, ${round2(dist)}% below`} — ${plan.stopPlan.detail}`,
    }
  }
  return { v: '—', tone: 'flat', note: 'no stop can be computed yet — fix that before risking anything' }
}
