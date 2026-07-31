// ONE COIN, IN THE ORDER YOU WOULD ASK.
//
//   1  the directive — what to do, and the four prices that make it executable
//   2  phase + precedent — what happened the last time this setup appeared here
//   3  the early-signal checklist — which of the nine are true, and which are
//      merely confirmation
//   4  the crowd — who is already in it, and on which side
//   5  the size — what the caps allow at your current settings
//
// EVERY MEDIAN CARRIES ITS WORST CASE. precedent.js computes `worstFwd21` and
// `medianMaxDDPct` alongside every median specifically so this file cannot show
// one without the other, and it does not. A base rate rendered as a single
// cheerful number is survivorship with a decimal point in it.
//
// THE LIBS ARE CALLED HERE, NOT IN THE PANEL. Everything below is a pure
// function of the payload, so it recomputes when the payload changes and never
// when the clock ticks — `now` comes from the response's own `asOf`, which is
// also the honest time to age a base rate against.
//
// LOADING IS SKELETONS AND EVERY ERROR HAS A RETRY (DESIGN.md §4.7). A spinner
// on this pane would be the wrong shape twice: it says "wait" without saying
// what is coming, and the pane is two seconds of network away on a phone.
import React, { useMemo, useState } from 'react'
import { SkPage, Expand, FreshChip } from '../primitives.jsx'
import { atr, swings } from '../../lib/ta.js'
import { precedentRead } from '../../lib/alts/precedent.js'
import { crowdRead } from '../../lib/alts/sentiment.js'
import { phaseOf, signalChecklist, PHASES } from '../../lib/alts/playbook.js'
import { tierDefaults, altStop, altSize } from '../../lib/alts/altrisk.js'
import { altDirective } from '../../lib/alts/directive.js'
import { fmtAltPx, usdCompact, pctText, ptsText, turnText, toneOf } from './AltBoard.jsx'
import { Sparkline } from './sparkline.jsx'

/* Verb first, and never a bare enum name on screen. `tone` inks the value the
 * way TradeCard's rows are inked; `band` picks the head colour from the classes
 * the answer card already owns. */
const ACTIONS = {
  NO_DATA: { text: 'No data', tone: 'flat', band: 'unknown' },
  AVOID: { text: 'Avoid', tone: 'bad', band: 'bad' },
  WATCH: { text: 'Watch', tone: 'flat', band: 'building' },
  STALK: { text: 'Stalk it', tone: 'warn', band: 'armed' },
  ARM: { text: 'Arm the order', tone: 'warn', band: 'armed' },
  STARTER: { text: 'Starter size', tone: 'go', band: 'go' },
  ENTER: { text: 'Enter', tone: 'go', band: 'go' },
  ADD: { text: 'Add', tone: 'go', band: 'go' },
  TRIM: { text: 'Trim', tone: 'warn', band: 'armed' },
  EXIT: { text: 'Exit now', tone: 'bad', band: 'bad' },
}

const SIZE_ERRORS = {
  bad_input: 'Sizing inputs are incomplete — check equity and risk % in Settings.',
  stop_not_below_price: 'The computed stop is not below the current price, so there is no per-unit risk to size against.',
  below_min_ticket: 'The caps allow less than the minimum ticket. This coin cannot be sized honestly at your equity — it is a watchlist row, not a position.',
  size_rounds_to_zero: 'The allowed notional rounds to zero units at this price.',
}

export default function CoinDetail({
  sel, payload, loading, error, onRetry, onBack,
  screened = null, season = null, settings = null,
  freshScan = null, freshCoin = null,
  fearGreed = null, trendingRank = null, trendingChecked = false,
  starred = false, onToggleWatch, saving = false,
}) {
  const sym = String(sel?.symbol ?? screened?.symbol ?? '').toUpperCase()
  const name = sel?.name ?? screened?.name ?? ''

  // The response's own timestamp, not the wall clock: it is what the base rates,
  // the ATR and the derivative samples were measured at, and re-aging them every
  // ten seconds would recompute 700 candles to change nothing.
  const now = Number.isFinite(payload?.asOf) ? payload.asOf : null

  const read = useMemo(() => {
    if (!screened) return null
    const candles = Array.isArray(payload?.candles) && payload.candles.length ? payload.candles : null
    const quality = payload?.candleQuality ?? null
    const derivs = payload?.derivs ?? null
    const price = Number.isFinite(screened.price) ? screened.price : null

    const precedent = candles ? precedentRead(candles, { quality, now }) : null

    // ABSENT ≠ NULL for the trending rank. sentiment.js scores a null rank as
    // "we fetched the list and this coin is not on it" (a real measurement) and
    // an ABSENT key as "the list never arrived" (no measurement at all). Send
    // the key only when the scan actually got a trending list, or every coin on
    // the board reads "nobody is looking" — the most bullish attention value
    // there is — on the days CoinGecko rate-limits us.
    const crowdInput = { fearGreed, community: payload?.coin?.community ?? null, derivs, screened, now }
    if (trendingChecked) crowdInput.trendingRank = trendingRank
    const crowd = crowdRead(crowdInput)

    const phase = phaseOf({ screened, precedent, crowd, candles })
    // The checklist gets the key on the SAME terms as crowdRead above: present
    // only when the scan actually came back with a trending list. Passing a bare
    // `null` here made the late-stage attention row report "not on the trending
    // list" — a measurement — on the passes where the list never arrived.
    const checklistCtx = { quality, crowd, derivs, now }
    if (trendingChecked) checklistCtx.trendingRank = trendingRank
    const checklist = signalChecklist(candles, screened, checklistCtx)

    const defaults = tierDefaults(screened.tier, screened.kind)
    const bars = candles ?? []
    const atrSeries = atr(bars, 14)
    const atrNow = atrSeries.length ? atrSeries[atrSeries.length - 1] : null
    const lows = swings(bars, 2).lows
    const swingLow = lows.length ? lows[lows.length - 1].price : null

    // The stop mode comes from Settings, but a close-only tape has an ATR of
    // exactly zero (high = low = close on every bar), so an ATR stop there
    // returns `no_atr` and the card would print no stop at all. directive.js
    // already tells the reader that on close-only candles "the stop below is a
    // percentage and not a volatility measurement" — this is where that becomes
    // true. The fallback is the TIER FLOOR, not settings.stopPct: an 8% stop is
    // a Settings number written for MSTR and it sits inside a micro cap's daily
    // range.
    let stopMode = settings?.stopMode ?? 'atr'
    let stop = altStop({
      mode: stopMode, price, atr: atrNow, atrMult: defaults.atrMult,
      swingLow, pct: settings?.stopPct ?? defaults.stopFloorPct,
      stopFloorPct: defaults.stopFloorPct,
    })
    if (stop.stop == null && stopMode !== 'percent' && price != null) {
      stopMode = 'percent'
      stop = altStop({ mode: 'percent', price, pct: defaults.stopFloorPct, stopFloorPct: defaults.stopFloorPct })
    }

    const size = settings && price != null && stop.stop != null
      ? altSize({
        equity: settings.equity,
        // The tier's risk fraction is applied by the CALLER, by contract, so
        // the card can show both the risk you asked for and the risk this
        // coin's tier will actually take.
        riskPct: settings.riskPct * defaults.riskFraction,
        price, stop: stop.stop, vol24h: screened.vol24h,
        maxPositionPct: defaults.maxPositionPct, maxAdvPct: defaults.maxAdvPct,
      })
      : null

    const plan = { stop, size, defaults }
    const directive = altDirective({
      screened, season, precedent, crowd, phase, plan, position: null, candles,
      freshness: { scan: freshScan, coin: freshCoin },
      candleQuality: quality, now,
    })

    return { candles, quality, precedent, crowd, phase, checklist, defaults, plan, stop, stopMode, size, directive, atrNow, price }
  }, [payload, screened, season, settings, freshScan, freshCoin, fearGreed, trendingRank, trendingChecked, now])

  const head = (
    <div className="alt-dhead">
      {/* Mobile only (hidden at ≥1020px, where the board is still on screen).
          A back CONTROL, not a modal dismiss — the detail is a panel in the
          document flow, so the page scroll is never trapped behind it. */}
      <button className="btn quiet sm alt-back" onClick={onBack}>← Board</button>
      <div className="alt-ident">
        <span className="alt-ident-sym">{sym || '—'}</span>
        <span className="alt-ident-name">{name}</span>
      </div>
      <span className="alt-ident-spark">
        <Sparkline data={screened?.sparkline7d} width={104} height={26} label={`${sym} 7-day shape`} />
      </span>
      {freshCoin && <FreshChip fresh={freshCoin} label="coin" title={payload?.sourceDetail} />}
      <button
        type="button"
        className={`alt-star${starred ? ' on' : ''}`}
        onClick={() => onToggleWatch?.(sel ?? screened)}
        disabled={saving}
        aria-pressed={starred}
        aria-label={starred ? `Remove ${sym} from the watchlist` : `Add ${sym} to the watchlist`}
      >
        <span aria-hidden>{starred ? '★' : '☆'}</span>
      </button>
    </div>
  )

  if (loading) {
    return (
      <div className="alt-detail" data-testid="coin-detail">
        {head}
        <SkPage cards={3} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="alt-detail" data-testid="coin-detail">
        {head}
        <section className="card pad-md">
          <div className="error-row" role="alert">
            <span>{sym || 'This coin'} could not be read: {error}</span>
            <button className="btn sm quiet" onClick={onRetry}>Retry</button>
          </div>
          <p className="sub t-foot alt-note">
            The board rows above are unaffected — they come from the market scan, which is a different feed.
            Binance and CoinGecko both rate-limit; a retry in a few seconds usually lands.
          </p>
        </section>
      </div>
    )
  }

  if (!screened) {
    return (
      <div className="alt-detail" data-testid="coin-detail">
        {head}
        <section className="card pad-md">
          <div className="empty">
            <div className="glyph" aria-hidden>◎</div>
            <div className="empty-title">No board row for {sym || 'this coin'}</div>
            <div className="empty-sub">
              It is not in the current scan — it may have dropped out of the top 250, or the scan may have aged out.
              Go back to the board and hit Refresh.
            </div>
          </div>
        </section>
      </div>
    )
  }

  const d = read.directive
  const act = ACTIONS[d.action] ?? { text: d.action, tone: 'flat', band: 'unknown' }

  return (
    <div className="alt-detail" data-testid="coin-detail">
      {head}
      <div className="alt-detail-grid">
        <DirectiveCard d={d} act={act} read={read} screened={screened} sym={sym} />
        <PrecedentCard read={read} screened={screened} sym={sym} />
        <ChecklistCard read={read} sym={sym} />
        <CrowdCard read={read} sym={sym} />
        <SizingCard read={read} screened={screened} settings={settings} sym={sym} />
        {payload?.degraded?.length > 0 && (
          <section className="card pad-md alt-degraded">
            <div className="ttl t-label">What did not arrive</div>
            <ul className="factlist">
              {payload.degraded.map((g, i) => <li key={i} className="sub t-foot">{g}</li>)}
            </ul>
            <p className="tiny t-cap alt-note">
              Source: {payload.sourceDetail || 'unknown'}
              {payload.binanceSymbol ? ` · candles keyed on ${payload.binanceSymbol}` : ''}
              {payload.priceMultiplier > 1 ? ` (÷${payload.priceMultiplier} back to per-coin units)` : ''}
            </p>
          </section>
        )}
      </div>
    </div>
  )
}

/* ══ 1 — the directive ═════════════════════════════════════════════════════ */

function DirectiveCard({ d, act, read, screened, sym }) {
  const [why, setWhy] = useState(false)
  const lv = d.levels || {}
  const size = read.size
  const rails = d.guardrails || []
  const shown = rails.slice(0, 2)
  const hidden = rails.slice(2)

  return (
    <section className={`card pad-md tcard ${d.severity}`} data-testid="coin-directive">
      <div className={`tc-head band-${act.band}`}>
        <div className="tc-score">
          <span className="tc-num num">{screened.score == null ? '—' : screened.score}</span>
          <span className="tc-den num">/ 100</span>
        </div>
        <div className="tc-headtext">
          <div className="tc-label">{act.text}</div>
          <div className="tc-plain">{d.headline}</div>
        </div>
      </div>

      <div className="alt-tags">
        <span className={`alt-band b-${screened.band}`}>{screened.band}</span>
        <span className="chip">{screened.tier}</span>
        <span className="chip">{screened.kind}</span>
        <span className="chip" title="24h volume as a share of market cap — the liquidity and interest gauge">
          turnover {turnText(screened.turnover)}
        </span>
        {read.quality === 'close-only' && (
          <span className="chip stale" title="CoinGecko market_chart fallback: one flat bar per day, so ATR and swing structure are not measurable">
            <span className="dot" />close-only candles
          </span>
        )}
      </div>

      <dl className="tc-rows" data-testid="coin-rows">
        <Row k="Do what" v={act.text} tone={act.tone} note={d.headline} />
        <Row k="Get in" v={fmtAltPx(lv.entry)} tone={act.tone === 'go' ? 'go' : 'flat'}
          note={lv.entry == null ? 'no entry reference — there is no live price' : 'the last price, and what every level below is measured from'} />
        <Row k="Trigger" v={fmtAltPx(lv.trigger)} tone={lv.trigger != null && read.price > lv.trigger ? 'go' : 'warn'}
          note={lv.triggerBasis || 'no trigger level — the tape has not built one'} />
        <Row k="Stop" v={fmtAltPx(read.stop?.stop)} tone="warn"
          note={read.stop?.stop == null
            ? `no stop could be computed (${read.stop?.warning || 'no data'}) — do not size anything until there is one`
            : `${read.stop.detail}${read.stopMode !== 'atr' ? ` · ${read.stopMode} mode` : ''}`} />
        <Row k="Abandon it" v={fmtAltPx(lv.invalidation)} tone="bad"
          note={lv.invalidationBasis || 'no invalidation level — not enough structure to name one'} />
        <Row k="How much" v={size?.ok ? `${trimUnits(size.units)} ${sym}` : 'nothing'}
          note={size?.ok
            ? `${usdCompact(size.notional)} · $${Math.round(size.riskUsd).toLocaleString('en-US')} at risk · ${size.positionPct}% of equity${size.reduced ? ` · capped by ${size.capped}` : ''}`
            : SIZE_ERRORS[size?.error] ?? 'no size — the plan has no stop to measure risk against'} />
        <Row k="Targets"
          v={lv.targets?.length ? fmtAltPx(lv.targets[0].price) : 'none'}
          note={lv.targets?.length
            ? lv.targets[0].basis
            : 'no measured base rate behind a target, so none is printed — a number with no sample behind it is the most confidently wrong thing a trading screen can show'} />
      </dl>

      {shown.map((g, i) => (
        <div className="guardrail" key={i}><span aria-hidden>⚠︎</span><span>{g}</span></div>
      ))}

      {(d.reasons?.length > 0 || hidden.length > 0) && (
        <>
          <button className="btn ghost sm disclose" onClick={() => setWhy((w) => !w)} aria-expanded={why}>
            {why ? 'hide the reasoning' : hidden.length > 0 ? `why · +${hidden.length} more warning${hidden.length > 1 ? 's' : ''}` : 'why this call'}
          </button>
          <Expand open={why}>
            {hidden.map((g, i) => (
              <div className="guardrail" key={`h${i}`}><span aria-hidden>⚠︎</span><span>{g}</span></div>
            ))}
            {d.reasons?.length > 0 && <ul className="factlist">{d.reasons.map((r, i) => <li key={i} className="sub t-foot">{r}</li>)}</ul>}
            {screened.facts?.length > 0 && (
              <ul className="factlist">{screened.facts.map((f, i) => <li key={`f${i}`} className="sub t-foot">{f}</li>)}</ul>
            )}
            <p className="sub t-foot alt-note">
              Advisory only — place orders at your exchange. This tab never sends one.
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
      <dt className="tc-k t-label">{k}</dt>
      <dd className="tc-v">
        <span className={`tc-val tone-${tone}`}>{v}</span>
        {note && <span className="tc-note">{note}</span>}
      </dd>
    </div>
  )
}

/* ══ 2 — phase and precedent ═══════════════════════════════════════════════ */

function PrecedentCard({ read, screened, sym }) {
  const [open, setOpen] = useState(false)
  const p = read.precedent
  const phase = read.phase
  const book = PHASES.find((x) => x.id === phase?.id) ?? null
  const br = p?.ok ? p.baseRates : null

  return (
    <section className="card pad-md" data-testid="coin-precedent">
      <div className="ttl t-label">
        Phase &amp; precedent
        <span className="dr-state">{phase?.label ?? 'Unknown'} · {phase?.confidence ?? 'low'} confidence</span>
      </div>

      {book && <p className="tc-plain alt-lead">{book.whatToDo}</p>}
      {phase?.why?.length > 0 && (
        <ul className="factlist">{phase.why.map((w, i) => <li key={i} className="sub t-foot">{w}</li>)}</ul>
      )}

      {!p || !p.ok ? (
        <div className="empty">
          <div className="glyph" aria-hidden>∅</div>
          <div className="empty-title">No base rate for {sym}</div>
          <div className="empty-sub">
            {p?.reason ?? 'No candles arrived for this coin, so there is no history to count ignitions in.'}
            {' '}Work the checklist below instead — it measures today without needing a sample.
          </div>
        </div>
      ) : (
        <>
          <div className="ticket alt-rates">
            <div className="tk">
              <div className="k t-label">7d after</div>
              <div className={`v num ${toneOf(br.medianFwd7)}`}>{pctText(br.medianFwd7)}</div>
              <div className="tk-sub num">{br.nFwd7} episodes</div>
            </div>
            <div className="tk">
              <div className="k t-label">21d after</div>
              <div className={`v num ${toneOf(br.medianFwd21)}`}>{pctText(br.medianFwd21)}</div>
              {/* The worst case sits under the median EVERYWHERE the median is
                  shown. That is precedent.js's rule and this is the surface it
                  exists to police. */}
              <div className="tk-sub num">worst {pctText(br.worstFwd21)}</div>
            </div>
            <div className="tk">
              <div className="k t-label">60d after</div>
              <div className={`v num ${toneOf(br.medianFwd60)}`}>{pctText(br.medianFwd60)}</div>
              <div className="tk-sub num">{br.nFwd60} episodes</div>
            </div>
          </div>

          <div className="stats stats-2up alt-stats">
            <div className="stattile">
              <div className="stattile-label">Match to the archetype</div>
              <div className="stattile-value num">{p.matchPct == null ? '—' : `${p.matchPct}%`}</div>
              <div className="tile-sub">similarity, not a probability</div>
            </div>
            <div className="stattile">
              <div className="stattile-label">Sample size</div>
              <div className="stattile-value num">{p.episodes}</div>
              <div className="tile-sub">prior ignitions in this coin</div>
            </div>
            <div className="stattile">
              <div className="stattile-label">Hit rate · 21d</div>
              <div className="stattile-value num">{br.hitRate21 == null ? '—' : `${Math.round(br.hitRate21)}%`}</div>
              <div className="tile-sub">higher than the ignition close</div>
            </div>
            <div className="stattile">
              <div className="stattile-label">Median drawdown</div>
              <div className="stattile-value num neg">{br.medianMaxDDPct == null ? '—' : `−${Math.round(br.medianMaxDDPct)}%`}</div>
              <div className="tile-sub">inside the run, before the peak</div>
            </div>
          </div>

          <div className="alt-eps">
            {p.matched.slice(0, 3).map((e) => (
              <div className="alt-ep" key={e.date}>
                <span className="alt-ep-d num">{e.date}</span>
                <span className="alt-ep-r num pos">{pctText(e.runPct)}</span>
                <span className="alt-ep-k">in {e.daysToPeak}d</span>
                <span className={`alt-ep-f num ${toneOf(e.fwd21)}`}>21d {pctText(e.fwd21)}</span>
                <span className="alt-ep-dd num">{e.maxDrawdownDuringPct == null ? 'dd —' : `dd −${Math.round(e.maxDrawdownDuringPct)}%`}</span>
                <span className="alt-ep-s num">{e.similarity == null ? '—' : `${e.similarity}% alike`}</span>
              </div>
            ))}
          </div>

          <button className="btn ghost sm disclose" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'hide the working' : 'how this was counted'}
          </button>
          <Expand open={open}>
            <ul className="factlist">{p.facts.map((f, i) => <li key={i} className="sub t-foot">{f}</li>)}</ul>
          </Expand>
        </>
      )}
    </section>
  )
}

/* ══ 3 — the early-signal checklist ════════════════════════════════════════ */

function ChecklistCard({ read, sym }) {
  const rows = read.checklist || []
  const measured = rows.filter((r) => r.pass != null)
  const passed = measured.filter((r) => r.pass).length

  return (
    <section className="card pad-md" data-testid="coin-checklist">
      <div className="ttl t-label">
        Early signals
        <span className="dr-state num">{passed} of {measured.length} measured</span>
      </div>
      <p className="sub t-foot alt-lead">
        The first six fire while the chart still looks like nothing. The last three are confirmation —
        an attention spike is where a move gets sold into, not where it gets bought.
      </p>
      <div className="alt-sig">
        {rows.map((s) => (
          <div key={s.id} className={`alt-sig-row ${s.pass === true ? 'pass' : s.pass === false ? 'fail' : 'unknown'}`}>
            <span className="alt-sig-mark" aria-hidden>{s.pass === true ? '✓' : s.pass === false ? '·' : '?'}</span>
            <span className="alt-sig-k">{s.label}</span>
            <span className={`alt-sig-lvl lvl-${s.level}`}>{s.level}</span>
            <span className={`alt-sig-stage stage-${s.stage}`}>{s.stage}</span>
            <span className="alt-sig-note">{s.note}</span>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="empty">
            <div className="glyph" aria-hidden>∅</div>
            <div className="empty-title">No checklist for {sym}</div>
            <div className="empty-sub">The candles never arrived, so none of the nine signals could be measured. Retry the coin from the header above.</div>
          </div>
        )}
      </div>
    </section>
  )
}

/* ══ 4 — the crowd ═════════════════════════════════════════════════════════ */

function CrowdCard({ read, sym }) {
  const [open, setOpen] = useState(false)
  const c = read.crowd
  const a = c?.attention ?? null
  const k = c?.crowding ?? null

  return (
    <section className="card pad-md" data-testid="coin-crowd">
      <div className="ttl t-label">
        Crowd
        <span className="dr-state">
          {c?.state ?? 'unknown'}{c?.score == null ? '' : ` · ${c.score}/100`} · {c?.contrarian ?? 'neutral'}
        </span>
      </div>

      {c?.contrarian === 'headwind' && (
        <div className="guardrail">
          <span aria-hidden>⚠︎</span>
          <span>{c.extremes?.length ? c.extremes.join(' + ') : 'positioning is already extreme'} — you would be buying the exit liquidity, however the chart looks.</span>
        </div>
      )}
      {c?.contrarian === 'tailwind' && (
        <p className="alt-tail">Price is moving before the attention is, which is the only order that pays.</p>
      )}

      <div className="alt-two">
        <div className="alt-col">
          <div className="alt-col-k t-label">Attention</div>
          {a ? (
            <dl className="alt-kv">
              <KV k="Trending rank" v={a.trendingRank == null ? 'not on the list' : `#${a.trendingRank}`} />
              {/* Two decimals: this ratio is a fraction of a percent on every
                  large coin, and the raw float printed sixteen digits of it. */}
              <KV k="Reddit active 48h" v={a.redditActivePct == null ? '—'
                : `${a.redditActivePct.toFixed(2)}%${a.redditSubs == null ? '' : ` of ${Math.round(a.redditSubs).toLocaleString('en-US')} subs`}`} />
              <KV k="CoinGecko up-votes" v={a.upVotePct == null ? '—' : `${Math.round(a.upVotePct)}%`} />
              <KV k="Watchlist users" v={a.watchlistUsers == null ? '—' : Math.round(a.watchlistUsers).toLocaleString('en-US')} />
              <KV k="Level" v={a.level} />
            </dl>
          ) : (
            <p className="sub t-foot">No attention data — the coin metadata feed did not answer.</p>
          )}
        </div>

        <div className="alt-col">
          <div className="alt-col-k t-label">Crowding</div>
          {k ? (
            <dl className="alt-kv">
              <KV k="Funding" v={k.fundingAnnualPct == null ? '—' : `${pctText(k.fundingAnnualPct, 0)}/yr`} tone={k.fundingAnnualPct > 30 ? 'neg' : k.fundingAnnualPct < 0 ? 'pos' : ''} />
              <KV k="Open interest 24h" v={pctText(k.oiChange24hPct)} tone={toneOf(k.oiChange24hPct)} />
              <KV k="Retail long" v={k.retailLongPct == null ? '—' : `${Math.round(k.retailLongPct)}%`} />
              <KV k="Top traders long" v={k.topLongPct == null ? '—' : `${Math.round(k.topLongPct)}%`} />
              {/* THE divergence — the reason derivatives are in this app at all.
                  Retail heavily long while the top traders are not is the read;
                  either number alone is noise. */}
              <KV k="Divergence" v={k.divergencePts == null ? '—' : `${ptsText(k.divergencePts, 0)} pts retail`} tone={k.divergencePts > 8 ? 'neg' : k.divergencePts < -8 ? 'pos' : ''} />
              <KV k="Level" v={k.level} />
            </dl>
          ) : (
            <div className="empty">
              <div className="empty-title">No listed perpetual</div>
              <div className="empty-sub">
                {sym} has no Binance perp, so funding, open interest and positioning do not exist for it —
                they are absent, not neutral. Judge this one on the chart and the checklist alone.
              </div>
            </div>
          )}
        </div>
      </div>

      {c?.facts?.length > 0 && (
        <>
          <button className="btn ghost sm disclose" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'hide the crowd read' : 'show the crowd read'}
          </button>
          <Expand open={open}>
            <ul className="factlist">{c.facts.map((f, i) => <li key={i} className="sub t-foot">{f}</li>)}</ul>
          </Expand>
        </>
      )}
    </section>
  )
}

function KV({ k, v, tone = '' }) {
  return (
    <div className="alt-kv-row">
      <dt className="alt-kv-k">{k}</dt>
      <dd className={`alt-kv-v num${tone ? ` ${tone}` : ''}`}>{v}</dd>
    </div>
  )
}

/* ══ 5 — sizing ════════════════════════════════════════════════════════════ */

function SizingCard({ read, screened, settings, sym }) {
  const s = read.size
  const def = read.defaults
  const stop = read.stop

  if (!settings) {
    return (
      <section className="card pad-md" data-testid="coin-sizing">
        <div className="ttl t-label">Size it</div>
        <div className="empty">
          <div className="glyph" aria-hidden>◎</div>
          <div className="empty-title">No settings loaded</div>
          <div className="empty-sub">Equity and risk % live in the Settings tab — open it once and this card fills in.</div>
        </div>
      </section>
    )
  }

  return (
    <section className="card pad-md" data-testid="coin-sizing">
      <div className="ttl t-label">
        Size it
        <span className="dr-state num">{def.tier} · {def.kind} · max {def.maxPositionPct}% of equity</span>
      </div>

      {s?.ok ? (
        <>
          <div className="stats stats-2up alt-stats">
            <div className="stattile">
              <div className="stattile-label">Buy</div>
              <div className="stattile-value num">{trimUnits(s.units)}</div>
              <div className="tile-sub">{sym} · {usdCompact(s.notional)}</div>
            </div>
            <div className="stattile">
              <div className="stattile-label">Risk</div>
              <div className="stattile-value num">${Math.round(s.riskUsd).toLocaleString('en-US')}</div>
              <div className="tile-sub">{r2(settings.riskPct * def.riskFraction)}% of equity ({def.riskFraction}× your {settings.riskPct}% rung)</div>
            </div>
            <div className="stattile">
              <div className="stattile-label">Position</div>
              <div className="stattile-value num">{s.positionPct}%</div>
              <div className="tile-sub">cap {def.maxPositionPct}%</div>
            </div>
            <div className="stattile">
              <div className="stattile-label">Share of a day</div>
              {/* altSize rounds advPct to three decimals, so a $10k ticket in a
                  $5B/day coin comes back as a literal 0. Printing "0%" reads as
                  a broken field on the one tile that is meant to say "this is
                  nothing to this book" — say that instead. */}
              <div className={`stattile-value num${s.capped === 'liquidity' ? ' neg' : ''}`}>
                {s.advPct == null ? '—' : s.advPct === 0 ? '<0.001%' : `${s.advPct}%`}
              </div>
              <div className="tile-sub">cap {def.maxAdvPct}% of {usdCompact(screened.vol24h)}</div>
            </div>
          </div>

          {/* WHICH CAP BOUND, in words. `capped` always names the binding
              constraint — including 'risk' for the healthy case — so this line
              can never be blank, and 'liquidity' is the one that says why a
              bigger position is unavailable at ANY risk setting. */}
          <p className="sub t-foot alt-note">
            {s.capped === 'liquidity'
              ? `Capped by LIQUIDITY: ${usdCompact(s.notional)} is ${s.advPct}% of what ${sym} trades in a day. A bigger position is not available at any risk setting — it is the exit that does not exist, not the entry.`
              : s.capped === 'position'
                ? `Capped by the ${def.maxPositionPct}% position ceiling for a ${def.tier}-cap ${def.kind} coin, not by the risk budget.`
                : `Sized by the risk budget: ${usdCompact(s.notional)} against a stop at ${fmtAltPx(stop?.stop)}.`}
            {s.liquidityUnknown && ' 24h volume is missing, so the liquidity cap could not be applied — this size is unchecked against what the coin actually trades.'}
          </p>
        </>
      ) : (
        <div className="empty">
          <div className="glyph" aria-hidden>⊘</div>
          <div className="empty-title">No size for {sym}</div>
          <div className="empty-sub">
            {SIZE_ERRORS[s?.error] ?? 'There is no stop to size against yet.'}
            {' '}Raise equity or risk % in Settings, or pick a coin the caps can actually fit.
          </div>
        </div>
      )}

      <p className="tiny t-cap alt-note">
        Fractional units, rounded down. Advisory only — place orders at your exchange.
      </p>
    </section>
  )
}

/* ══ local helpers ═════════════════════════════════════════════════════════ */

/** Six significant digits is what altSize rounds to; printing all of them turns
 *  "12.4 SOL" into "12.4000". Trailing zeros are dropped, the magnitude is not. */
function trimUnits(u) {
  if (!Number.isFinite(u)) return '—'
  if (u >= 1000) return Math.round(u).toLocaleString('en-US')
  if (u >= 1) return String(Number(u.toFixed(3)))
  return String(Number(u.toPrecision(4)))
}

function r2(x) { return Number.isFinite(x) ? Math.round(x * 100) / 100 : '—' }
