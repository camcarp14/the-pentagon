// TORQUE — the shell. Owns: auth gate, source polling, the one derived-state
// computation that feeds every view, tab navigation, ⌘K, toasts.
//
// Honesty rules enforced here (the reviewers' bar):
//  - freshness is computed from the LAST SUCCESSFUL fetch and ages through
//    live → stale → dead; a single failed poll never forges "dead"
//  - once a feed IS dead, its price is nulled — the tape shows "—", never a
//    remembered number beside a dead chip
//  - delayed/EOD quote kinds are labeled on the tape, not hidden
//  - the persisted stop high-water mark joins the effective-stop max, so the
//    governing stop can never render below any level it has already reached
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { regime, pullbackSetup, breakout, exitFlags, btcAlignment } from './lib/signals.js'
import { atr, swings } from './lib/ta.js'
import { sizePosition, initialStop, anchoredChandelier, effectiveStop, rMultiple } from './lib/risk.js'
import { alignByDay, rollingBeta, relativeStrength, mNav, torqueRead } from './lib/torque.js'
import { freshness, nyseSessionState } from './lib/freshness.js'
import { composeDirective } from './lib/advice.js'
import { api } from './lib/api.js'
import { fmtPx, round2 } from './lib/format.js'
import { ToastProvider, CommandK, FreshChip, Num } from './components/primitives.jsx'
import Cockpit from './components/Cockpit.jsx'
import AltsPanel from './components/alts/AltsPanel.jsx'
import ChartPanel from './components/ChartPanel.jsx'
import Journal from './components/Journal.jsx'
import Settings from './components/Settings.jsx'

/** Poll a source; expose {data, error, fetchedAt, loading} + reload().
 *  On error the last-good data and fetchedAt are KEPT — the freshness
 *  ladder (not the error) decides when data stops being trustworthy. */
function useSource(path, intervalMs, onAuthFail) {
  const [state, setState] = useState({ data: null, error: null, fetchedAt: null, loading: true })
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }))
    try {
      const data = await api(path)
      setState({ data, error: null, fetchedAt: data?.meta?.fetchedAt ?? Date.now(), loading: false })
    } catch (e) {
      // A 401 must still clear `loading` and record an error. Returning early
      // left loading:true / error:null forever, and the cockpit's
      // `loading && !data && !error` skeleton gate then never resolved — an
      // expired session showed a permanent skeleton with no message and no
      // retry, while the poll kept re-entering this same branch.
      if (e.code === 401) {
        setState((s) => ({ ...s, error: 'session expired — sign in again', loading: false }))
        onAuthFail()
        return
      }
      setState((s) => ({ ...s, error: e.message, loading: false }))
    }
  }, [path, onAuthFail])
  useEffect(() => {
    load()
    if (!intervalMs) return
    const id = setInterval(load, intervalMs)
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
  }, [load, intervalMs])
  return { ...state, reload: load }
}

// ORDER IS THE PRODUCT DECISION, AND THE APP READS IT FROM HERE.
//
// Alts is FIRST and it is where the app lands. MSTR is one position that is
// either open or not and whose cockpit answers a question you already know the
// shape of; the alt board is the hunt, it turns over every two hours on its own
// cron, and it is the only tab where something can have happened while you were
// away. A dashboard opens on the thing that changed.
//
// Nothing else in this file names a tab id. `DEFAULT_TAB` is derived below
// rather than typed, and the ⌘K palette is built from this array — a second
// literal 'cockpit' in either place is exactly how a reorder ships half-done.
const TABS = [
  { id: 'alts', label: 'Alts', icon: 'M12 3 3 7.5 12 12l9-4.5L12 3M3 16.5 12 21l9-4.5M3 12l9 4.5 9-4.5' },
  { id: 'cockpit', label: 'Cockpit', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
  { id: 'chart', label: 'Chart', icon: 'M3 3v18h18M7 14l4-4 3 3 5-6' },
  { id: 'journal', label: 'Journal', icon: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z' },
  { id: 'settings', label: 'Settings', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z' },
]

/** The tab the app opens on — the first one, by construction. Written as a
 *  derivation and not as a string so the landing tab cannot disagree with the
 *  nav's own order; a literal here is the second place a reorder has to
 *  remember, and the one it forgets. */
export const DEFAULT_TAB = TABS[0].id

/** Extra words ⌘K should match a tab on — vocabulary, not a second name for it.
 *
 *  'home' and 'dash' MOVED with the landing tab. They used to sit on cockpit
 *  because cockpit was where the app opened; leaving them there after the
 *  reorder would mean typing "home" into the palette takes you somewhere that is
 *  no longer home. Cockpit keeps the words that describe what it actually is —
 *  the MSTR position — and nothing matches both tabs. */
const TAB_KEYWORDS = {
  alts: ['alt', 'coins', 'season', 'board', 'crypto', 'home', 'dash'],
  cockpit: ['mstr', 'position', 'stop'],
  chart: ['candles', 'price'],
  journal: ['trades', 'log'],
  settings: ['risk', 'config'],
}

/** Tab panels stay mounted (drafts survive reference-checking other tabs);
 *  the pagefade animation restarts by class-toggle, not remount. */
function TabPanel({ active, children }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (active && el) {
      el.classList.remove('pagefade')
      void el.offsetWidth // reflow so the animation restarts
      el.classList.add('pagefade')
    }
  }, [active])
  return <div ref={ref} hidden={!active} className="pagefade">{children}</div>
}

export default function App({ embedded = false }) {
  const [needToken, setNeedToken] = useState(false)
  const [tab, setTab] = useState(DEFAULT_TAB)
  const [now, setNow] = useState(Date.now())
  const onAuthFail = useCallback(() => setNeedToken(true), [])

  const quote = useSource('quote', 60_000, onAuthFail)
  const btc = useSource('btc', 60_000, onAuthFail)
  const mstr1d = useSource('candles?symbol=MSTR&tf=1d', 300_000, onAuthFail)
  const btc1d = useSource('candles?symbol=BTC&tf=1d', 300_000, onAuthFail)
  const settingsSrc = useSource('settings', 0, onAuthFail)
  const positionSrc = useSource('position', 0, onAuthFail)
  const journalSrc = useSource('journal', 0, onAuthFail)
  // 90s matches alt-scan's own Blobs TTL, so a poll that misses the cache is the
  // exception rather than the rule — CoinGecko's keyless tier is ~10-30 calls a
  // minute and this endpoint is shared by every open tab and the phone.
  const altScan = useSource('alt-scan', 90_000, onAuthFail)
  // The watchlist is written by the star toggle, not polled: re-fetching it on a
  // timer would race the optimistic write and blink a just-lit star back off.
  const altWatch = useSource('alt-watchlist', 0, onAuthFail)
  // Headlines, five-minutely. NOT 90s like the scan: news moves in hours, the
  // section it feeds changes no number on the tab, and a failing poll every
  // minute and a half is quota spent to re-print the same stated reason. It is
  // its own source rather than a field on alt-scan so a news outage can never
  // take the board down with it — `useSource` keeps the last good data on error
  // and NewsStrip states the failure in its own line.
  const altNews = useSource('alt-news', 300_000, onAuthFail)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(id)
  }, [])

  const settings = settingsSrc.data?.settings ?? null
  const position = positionSrc.data?.position ?? null

  const derived = useMemo(() => {
    // freshness first: it decides which numbers are allowed to exist at all
    const freshQuote = freshness(quote.fetchedAt, 'quote', now)
    const freshBtc = freshness(btc.fetchedAt, 'btc', now)
    const freshCandles = freshness(mstr1d.fetchedAt, 'candles_1d', now)
    const freshBtcCandles = freshness(btc1d.fetchedAt, 'candles_1d', now)
    const price = freshQuote.state === 'dead' ? null : quote.data?.price ?? null
    const btcPrice = freshBtc.state === 'dead' ? null : btc.data?.price ?? null
    const mc = mstr1d.data?.candles ?? []
    const bc = btc1d.data?.candles ?? []

    const reg = regime(mc)
    const align = btcAlignment(bc)
    const pb = pullbackSetup(mc)
    const bo = breakout(mc)

    const aligned = alignByDay(mc, bc)
    const beta = rollingBeta(aligned.a, aligned.b, 30).latest
    const rs = relativeStrength(aligned.a, aligned.b, 20)
    const nav = settings ? mNav({ price, sharesOutstanding: settings.sharesOutstanding, btcHoldings: settings.btcHoldings, btcPrice }) : null
    const tRead = torqueRead({ beta, mNav: nav?.mNav })

    const atrArr = atr(mc, 14)
    const atrNow = atrArr.length ? atrArr[atrArr.length - 1] : null
    const swingLows = swings(mc, 2).lows
    const lastSwingLow = swingLows.length ? swingLows[swingLows.length - 1].price : null

    const stopPlan = settings && price != null
      ? initialStop({ mode: settings.stopMode, entry: price, atr: atrNow, atrMult: settings.atrMult, swingLow: lastSwingLow, pct: settings.stopPct })
      : null
    const sizing = settings && price != null && stopPlan?.stop != null
      ? sizePosition({ equity: settings.equity, riskPct: settings.riskPct, entry: price, stop: stopPlan.stop, maxPositionPct: settings.maxPositionPct })
      : null
    const addSizing = settings && price != null && stopPlan?.stop != null
      ? sizePosition({ equity: settings.equity, riskPct: settings.riskPct * settings.addRiskFraction, entry: price, stop: stopPlan.stop, maxPositionPct: settings.maxPositionPct })
      : null

    // open-position math: anchored trail from the entry date forward
    let posDerived = null
    let flags = []
    if (position && mc.length) {
      const entryIdx = mc.findIndex((c) => new Date(c.t * 1000).toISOString().slice(0, 10) >= position.entryDate)
      let trailNow = null
      let trailSeries = []
      let hcse = null
      if (entryIdx >= 0 && settings) {
        trailSeries = anchoredChandelier(mc, {
          entryIdx, atrPeriod: settings.chandelierPeriod, mult: settings.chandelierMult, initialStop: position.initialStop,
        })
        trailNow = trailSeries.length ? trailSeries[trailSeries.length - 1] : null
        hcse = -Infinity
        for (let k = entryIdx; k < mc.length; k++) hcse = Math.max(hcse, mc[k].c)
      }
      let eff = effectiveStop({
        initialStop: position.initialStop, trailStop: trailNow, entry: position.avgEntry,
        beAtR: settings?.beAtR ?? 1, highestCloseSinceEntry: hcse,
      })
      // manual override and the persisted high-water mark only ever RAISE it
      if (Number.isFinite(position.stopOverride)) eff = Math.max(eff ?? -Infinity, position.stopOverride)
      if (Number.isFinite(position.stopHighWater)) eff = Math.max(eff ?? -Infinity, position.stopHighWater)
      const r = price != null ? rMultiple({ entry: position.avgEntry, initialStop: position.initialStop, price }) : null
      flags = exitFlags({ candles: mc, position, effectiveStop: eff })
      posDerived = { entryIdx, trailNow, trailSeries, effStop: Number.isFinite(eff) ? eff : null, r, hcse }
    }

    // prefer the exchange's own session state when the quote is live
    const marketSession = (freshQuote.state === 'live' && quote.data?.marketState) || nyseSessionState(now)
    const directive = composeDirective({
      price, freshQuote, freshBtc, freshCandles, freshBtcCandles,
      regime: reg, btcAlign: align, pullback: pb, breakout: bo,
      exitFlags: flags,
      position: position ? { shares: position.shares, avgEntry: position.avgEntry, initialStop: position.initialStop } : null,
      effectiveStop: posDerived?.effStop ?? null,
      r: posDerived?.r ?? null,
      sizing, addSizing,
      torque: { read: tRead },
      marketSession,
    })

    return {
      price, btcPrice, freshQuote, freshBtc, freshCandles, freshBtcCandles,
      regime: reg, btcAlign: align, pullback: pb, breakout: bo,
      beta, rs, nav, torqueRead: tRead,
      atrNow, lastSwingLow, stopPlan, sizing, addSizing,
      posDerived, flags, directive, marketSession,
      mstrCandles: mc, btcCandles: bc,
    }
  }, [quote.data, quote.fetchedAt, btc.data, btc.fetchedAt,
    mstr1d.data, mstr1d.fetchedAt, btc1d.data, btc1d.fetchedAt, settings, position, now])

  // Embedded, the shell owns auth (one Supabase login) — never show Torque's own
  // token gate; a 401 there means the shared session lapsed, which the shell
  // handles by returning to its own login.
  if (needToken && !embedded) {
    // same opt-in as the main return below — the gate is a whole screen of this
    // app, so it gets the kit too
    return (
      <div data-kit className="macro-root">
        <TokenGate onDone={() => { setNeedToken(false); window.location.reload() }} />
      </div>
    )
  }

  const sources = { quote, btc, mstr1d, btc1d, settingsSrc, positionSrc, journalSrc }
  const reloadAll = () => { quote.reload(); btc.reload(); mstr1d.reload(); btc1d.reload(); settingsSrc.reload(); positionSrc.reload() }

  return (
    // data-kit: Macro opts into the shared kit HERE, on its own outermost
    // element, and nowhere higher. Under the Pentagon this renders inside the
    // shell's tool slot, so the attribute reaches this app and nothing else —
    // the shell deliberately keeps data-kit off the wrapper that holds every
    // tool, because eight apps own .card / .btn / .field and mean different
    // things by them. It is a plain wrapper div: .navbar is `display: contents`
    // on mobile and a sticky bar on desktop, and neither cares about one more
    // static block ancestor.
    <div data-kit className="macro-root">
      <ToastProvider>
      {/* The nav sits OUTSIDE .shell so that on desktop its wrapper can be a
          full-bleed sticky bar — the same chrome ZTS and Clarify use — instead of
          a pill group parked inside the 1180px content column that scrolls away.
          On mobile .navbar is `display: contents`, so .nav keeps its original
          fixed bottom-bar behaviour untouched. */}
      <div className="navbar">
        <nav className="nav pentagon-dock" aria-label="Main">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} aria-label={t.label} aria-current={tab === t.id ? 'page' : undefined}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
              <span className="nav-label">{t.label}</span>
            </button>
          ))}
        </nav>
      </div>
      <div className="shell">
        <header className="hdr">
          {!embedded && <div className="brand"><span className="bolt">⚡</span>TORQUE <span className="tiny t-cap" style={{ fontWeight: 500 }}>MSTR cockpit</span></div>}
          <div className="tape">
            <Ticker sym="MSTR" px={derived.price} chg={derived.price == null ? null : quote.data?.changePct}
              fresh={derived.freshQuote} kind={quote.data?.kind} delayedMin={quote.data?.delayedMin} sourceDetail={quote.data?.sourceDetail} />
            <Ticker sym="BTC" px={derived.btcPrice} chg={derived.btcPrice == null ? null : btc.data?.changePct24h}
              fresh={derived.freshBtc} sourceDetail={btc.data?.sourceDetail} />
          </div>
        </header>
        <main>
          {/* DOM order follows TABS. Every panel stays mounted, so this is the
              order a screen reader and a keyboard walk the page in, and a nav
              that reads Alts-first over a document that reads Cockpit-first is
              two different answers to "what is this tab" on one screen. */}
          <TabPanel active={tab === 'alts'}><AltsPanel scan={altScan} watchlistSrc={altWatch} newsSrc={altNews} settings={settings} now={now} /></TabPanel>
          <TabPanel active={tab === 'cockpit'}><Cockpit derived={derived} settings={settings} position={position} sources={sources} onReload={reloadAll} /></TabPanel>
          <TabPanel active={tab === 'chart'}><ChartPanel derived={derived} settings={settings} position={position} /></TabPanel>
          <TabPanel active={tab === 'journal'}><Journal journalSrc={journalSrc} /></TabPanel>
          <TabPanel active={tab === 'settings'}><Settings settingsSrc={settingsSrc} positionSrc={positionSrc} derived={derived} /></TabPanel>
        </main>
        <CommandK items={[
          // Built from TABS, not typed out again. The palette used to carry its
          // own five 'Go to <name>' strings, which is the arrangement that let
          // ZTS's palette spell a tab one way while its two nav bars spelled it
          // another. Only the search keywords are per-tab here, because they are
          // genuinely extra vocabulary rather than a second name.
          ...TABS.map((t) => ({ label: `Go to ${t.label}`, k: TAB_KEYWORDS[t.id], run: () => setTab(t.id) })),
          { label: 'Refresh market data', k: ['reload', 'update'], run: reloadAll },
          // Its own entry, not folded into "Refresh market data": the alt scan
          // costs a CoinGecko call against a keyless quota, and a cockpit
          // refresh has no business spending it.
          { label: 'Refresh alt scan', k: ['alts', 'coins', 'rescan'], run: () => { setTab('alts'); altScan.reload(); altWatch.reload() } },
        ]} />
      </div>
      </ToastProvider>
    </div>
  )
}

function Ticker({ sym, px, chg, fresh, kind, delayedMin, sourceDetail }) {
  const cls = chg == null ? 'flat' : chg >= 0 ? 'pos' : 'neg'
  return (
    <span className="tk">
      <span className="sym">{sym}</span>
      <span className="px num"><Num v={px} f={fmtPx} /></span>
      <span className={`chg num ${cls}`}>{chg == null ? '' : `${chg >= 0 ? '+' : ''}${round2(chg)}%`}</span>
      <FreshChip fresh={fresh} title={sourceDetail} />
      {kind === 'eod' && <span className="chip stale" title={`end-of-day close via ${sourceDetail || 'fallback'}`}><span className="dot" />EOD</span>}
      {kind === 'delayed' && Number.isFinite(delayedMin) && <span className="tiny t-cap" title={sourceDetail}>{delayedMin}m delayed</span>}
    </span>
  )
}

function TokenGate({ onDone }) {
  const [val, setVal] = useState('')
  // If a token is already stored yet we're back at the gate, that token was
  // rejected — say so instead of looping a silent identical screen.
  const [rejected] = useState(() => !!sessionStorage.getItem('torque_token'))
  return (
    <div className="gate">
      <div className="card pad-md">
        <div className="ttl t-label">⚡ Torque — access token</div>
        {rejected && (
          <div className="error-row" style={{ marginBottom: 12 }} role="alert">
            <span>That token was rejected — check <code>DASHBOARD_TOKEN</code> in your Netlify environment.</span>
          </div>
        )}
        <p className="sub t-foot">This cockpit is protected by a shared secret (the <code>DASHBOARD_TOKEN</code> you set on Netlify). Paste it once; it stays in this browser session only.</p>
        <form onSubmit={(e) => { e.preventDefault(); sessionStorage.setItem('torque_token', val.trim()); onDone() }}>
          <div className="fld">
            <label htmlFor="tok">Token</label>
            <input className="field" id="tok" type="password" value={val} onChange={(e) => setVal(e.target.value)} autoFocus />
          </div>
          <button className="btn primary md" type="submit" disabled={!val.trim()}>Unlock</button>
        </form>
      </div>
    </div>
  )
}
