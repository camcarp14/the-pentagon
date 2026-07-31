// THE ALTS TAB — season answer, ranked board, one coin in depth.
//
// LAYOUT. Desktop (≥1020px) is two panes: the board on the left, the detail
// sticky on the right, both always mounted. Under that it is one column, and
// selecting a coin swaps the board out for the detail — a PANEL in the document
// flow with a back control, not a modal. A modal here would trap the page scroll
// on the one surface that is six cards tall on a phone, and dismissing it by
// tapping a scrim is a coin toss when the scrim is 40px of the screen.
//
// A DEAD SCAN SHOWS NOTHING, NOT A REMEMBERED PRICE. `freshness()` ages
// `alt_scan` through live → stale → dead exactly the way the cockpit ages its
// quote, and past dead the payload is dropped on the floor before anything reads
// it. Every number on this tab is derived from that payload, so keeping it would
// mean printing yesterday's tape under a red chip — and the whole point of the
// chip is that nobody reads it twice.
//
// FRESHNESS IS MEASURED FROM `asOf`, NOT FROM meta.fetchedAt. alt-scan serves a
// 90-second Blobs cache and a stale-fallback beyond it, so `meta.fetchedAt` is
// when the RESPONSE was built — which on a cache hit is always now. Trusting it
// would make an hour-old stale payload read as live, which is precisely what the
// `stale: true` flag exists to prevent.
//
// THE HEAVY READS ARE KEYED ON THE PAYLOAD, NOT ON THE CLOCK. `now` ticks every
// ten seconds in App; screening 250 rows and re-counting breadth on every tick
// would burn a phone's battery to change nothing. The libs get the payload's own
// `asOf` as their `now`, which is also the honest instant to age a dominance
// history against.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SkPage, useToast } from '../primitives.jsx'
import { api } from '../../lib/api.js'
import { freshness } from '../../lib/freshness.js'
import { seasonRead } from '../../lib/alts/season.js'
import { screenUniverse } from '../../lib/alts/screen.js'
import SeasonCard from './SeasonCard.jsx'
import AltBoard from './AltBoard.jsx'
import CoinDetail from './CoinDetail.jsx'

const MAX_WATCH = 60   // mirrors alt-watchlist.mjs; see the comment at the toggle

export default function AltsPanel({ scan, watchlistSrc, settings = null, now = Date.now() }) {
  const toast = useToast()
  const [sel, setSel] = useState(null)
  const [coin, setCoin] = useState({ data: null, loading: false, error: null, fetchedAt: null })
  const seqRef = useRef(0)

  /* ── the per-coin fetch ──────────────────────────────────────────────────
   * Not a useSource: the path changes with the selection, and two selections a
   * second apart resolve out of order about as often as not on a phone. `seq`
   * is the guard — a response whose sequence is no longer the current one is
   * dropped, so tapping SOL then PEPE can never leave SOL's candles under
   * PEPE's name. That bug does not look like a race; it looks like the app
   * pricing the wrong coin. */
  const loadCoin = useCallback(async (target) => {
    if (!target?.id || !target?.symbol) return
    const seq = ++seqRef.current
    setCoin({ data: null, loading: true, error: null, fetchedAt: null })
    try {
      const data = await api(`alt-coin?id=${encodeURIComponent(target.id)}&symbol=${encodeURIComponent(target.symbol)}`)
      if (seq !== seqRef.current) return
      setCoin({ data, loading: false, error: null, fetchedAt: data?.asOf ?? data?.meta?.fetchedAt ?? Date.now() })
    } catch (e) {
      if (seq !== seqRef.current) return
      setCoin({ data: null, loading: false, error: e?.message || 'request failed', fetchedAt: null })
    }
  }, [])

  useEffect(() => {
    if (!sel) { seqRef.current++; setCoin({ data: null, loading: false, error: null, fetchedAt: null }); return }
    loadCoin(sel)
  }, [sel, loadCoin])

  /* ── the market read ─────────────────────────────────────────────────────── */

  const asOf = Number.isFinite(scan.data?.asOf) ? scan.data.asOf : scan.fetchedAt
  const freshScan = freshness(asOf, 'alt_scan', now)
  const freshCoin = freshness(coin.fetchedAt, 'alt_coin', now)

  const market = useMemo(() => {
    const payload = scan.data ?? null
    const universe = Array.isArray(payload?.universe) ? payload.universe : []
    const at = Number.isFinite(payload?.asOf) ? payload.asOf : null
    const find = (s) => universe.find((r) => String(r?.symbol ?? '').toUpperCase() === s) ?? null
    const btcRow = find('BTC')
    const ethRow = find('ETH')
    const season = seasonRead({
      universe, btcRow, ethRow,
      global: payload?.global ?? null,
      fearGreed: payload?.fearGreed ?? null,
      trending: payload?.trending ?? null,
      domHistory: payload?.domHistory ?? null,
      now: at,
    })
    const rows = screenUniverse(universe, { btcRow, ethRow, season, now: at })
    const byId = new Map(rows.map((r) => [r.id, r]))
    return { payload, season, rows, byId, trending: payload?.trending ?? null }
  }, [scan.data])

  // Past `dead` the payload is not read at all — see the header.
  const live = freshScan.state !== 'dead' && !!market.payload
  const rows = live ? market.rows : []
  const season = live ? market.season : null
  const trendingChecked = live && Array.isArray(market.trending)
  const trendingRank = trendingChecked && sel
    ? market.trending.find((t) => t?.id === sel.id)?.rank ?? null
    : null

  /* ── the watchlist, optimistic ───────────────────────────────────────────── */

  const serverIds = watchlistSrc.data?.watchlist?.ids ?? null
  const [localIds, setLocalIds] = useState(null)
  const [savingId, setSavingId] = useState(null)
  useEffect(() => { if (serverIds) setLocalIds(serverIds) }, [serverIds])

  const ids = localIds ?? serverIds ?? []
  const watched = useMemo(() => new Set(ids.map((e) => e.id)), [ids])

  const toggleWatch = useCallback(async (row) => {
    if (!row?.id || !row?.symbol) return
    const prev = localIds ?? serverIds ?? []
    const on = prev.some((e) => e.id === row.id)
    // 60 is the sentinel's budget, enforced server-side. Catching it here means
    // the 61st star fails as a sentence rather than as a validation array.
    if (!on && prev.length >= MAX_WATCH) {
      toast(`Watchlist is full at ${MAX_WATCH} coins — unstar something first`, { err: true })
      return
    }
    const next = on
      ? prev.filter((e) => e.id !== row.id)
      : [...prev, { id: row.id, symbol: row.symbol, name: String(row.name ?? '').slice(0, 100), note: '' }]

    setLocalIds(next)          // optimistic: the star lights immediately
    setSavingId(row.id)
    try {
      // Only the five keys the validator allows, and `addedAt` is deliberately
      // NOT sent: the server owns "when did I star this", and re-sending it on
      // every toggle would reset every date in the list to now.
      const body = { ids: next.map((e) => ({ id: e.id, symbol: e.symbol, name: e.name ?? '', note: e.note ?? '' })) }
      const res = await api('alt-watchlist', { method: 'PUT', body: JSON.stringify(body) })
      setLocalIds(res?.watchlist?.ids ?? next)
      toast(on ? `${row.symbol} off the watchlist` : `${row.symbol} on the watchlist`)
    } catch (e) {
      // ROLLBACK. A star that is lit but did not save is the worst outcome here:
      // the sentinel never watches that coin, and the UI has already told you it
      // does. The toast names the server's own first complaint, because
      // "validation failed" on its own is not actionable.
      setLocalIds(prev)
      const detail = e?.body?.errors?.[0] || e?.message || 'the request failed'
      toast(`Watchlist not saved — ${detail}`, { err: true })
    } finally {
      setSavingId(null)
    }
  }, [localIds, serverIds, toast])

  /* ── gates ───────────────────────────────────────────────────────────────── */

  // Skeletons, never a spinner (DESIGN.md §4.7) — and inside the tab's own
  // wrapper, so the panel is one identifiable element in the DOM from the first
  // frame instead of appearing once data lands.
  const cold = scan.loading && !scan.data && !scan.error
  if (cold) return <div className="alts" data-testid="alts-panel"><SkPage cards={4} /></div>

  const onSelect = (row) => {
    setSel((cur) => (cur?.id === row.id ? cur : { id: row.id, symbol: row.symbol, name: row.name }))
  }

  return (
    <div className="alts" data-testid="alts-panel">
      {scan.error && (
        <div className="error-row" role="alert">
          <span>Market scan failed: {scan.error}{scan.data ? ' — showing the last good pass.' : ''}</span>
          <button className="btn sm quiet" onClick={scan.reload}>Retry</button>
        </div>
      )}
      {watchlistSrc.error && (
        <div className="error-row" role="alert">
          <span>Watchlist unavailable: {watchlistSrc.error} — stars will not save until it comes back.</span>
          <button className="btn sm quiet" onClick={watchlistSrc.reload}>Retry</button>
        </div>
      )}

      <div className={`alt-panes${sel ? ' picked' : ''}`}>
        <div className="alt-pane-board">
          <SeasonCard
            season={season}
            fresh={freshScan}
            sourceDetail={market.payload?.sourceDetail ?? null}
            degraded={live ? market.payload?.degraded : null}
            cached={!!market.payload?.cached}
            cacheAgeSec={market.payload?.cacheAgeSec ?? null}
            onReload={scan.reload}
          />
          <section className="card pad-md alt-boardcard">
            <div className="ttl t-label">
              Board
              <span className="dr-state">ranked by how likely a move is starting, not by how much it already moved</span>
            </div>
            {live ? (
              <AltBoard
                rows={rows}
                watched={watched}
                selectedId={sel?.id ?? null}
                savingId={savingId}
                onSelect={onSelect}
                onToggleWatch={toggleWatch}
              />
            ) : (
              <div className="empty">
                <div className="glyph" aria-hidden>—</div>
                <div className="empty-title">The scan is {freshScan.state === 'dead' ? 'stale beyond use' : 'not in yet'}</div>
                <div className="empty-sub">
                  Prices, returns and scores all come from the one scan, so the board stays empty rather than
                  ranking numbers we cannot vouch for. Use Refresh in the card above.
                </div>
              </div>
            )}
          </section>
        </div>

        <div className="alt-pane-detail">
          {sel ? (
            <CoinDetail
              sel={sel}
              payload={coin.data}
              loading={coin.loading}
              error={coin.error}
              onRetry={() => loadCoin(sel)}
              onBack={() => setSel(null)}
              screened={market.byId.get(sel.id) ?? null}
              season={season}
              settings={settings}
              freshScan={freshScan}
              freshCoin={freshCoin}
              fearGreed={live ? market.payload?.fearGreed ?? null : null}
              trendingRank={trendingRank}
              trendingChecked={trendingChecked}
              starred={watched.has(sel.id)}
              saving={savingId === sel.id}
              onToggleWatch={toggleWatch}
            />
          ) : (
            <section className="card pad-md alt-placeholder">
              <div className="empty">
                <div className="glyph" aria-hidden>◎</div>
                <div className="empty-title">Pick a coin</div>
                <div className="empty-sub">
                  Tap any row for its directive, what happened the last time this setup appeared in that coin's
                  own history, the early-signal checklist, and a size the liquidity can actually support.
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
