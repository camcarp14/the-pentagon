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
// chip is that nobody reads it twice. That means EVERY read: `rows`, `season`,
// `trending`, the cache age AND `screened`, which is the one that carries the
// prices into the detail pane. The gate has to be applied where the payload is
// unpacked, once, or the next read added below is the next one to escape it.
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

  // Past `dead` the payload is not read at all — see the header. EVERY read of
  // `market` goes through this gate, including the one that reaches the detail
  // pane: `screened` shipped ungated while its four siblings were gated, and a
  // dead scan therefore drew an empty board and a "stand down" headline over a
  // full set of remembered prices — score 96, entry $5.88, a stop, an
  // invalidation and a sized position, all from a payload the freshness ladder
  // had already refused. The board's copy and the detail's numbers came from the
  // same object; only one of them was allowed to say so.
  const live = freshScan.state !== 'dead' && !!market.payload
  const rows = live ? market.rows : []
  const season = live ? market.season : null
  const screened = live && sel ? market.byId.get(sel.id) ?? null : null
  const trendingChecked = live && Array.isArray(market.trending)
  const trendingRank = trendingChecked && sel
    ? market.trending.find((t) => t?.id === sel.id)?.rank ?? null
    : null

  /* ── the watchlist, optimistic ───────────────────────────────────────────── */

  const serverIds = watchlistSrc.data?.watchlist?.ids ?? null
  const [localIds, setLocalIds] = useState(null)
  /* The rows whose change has not been acknowledged yet. A SET, not a single
   * id, and it is the only thing that disables a star — see the writer below. */
  const [pendingIds, setPendingIds] = useState(() => new Set())

  /* ── the writer: coalescing, not locking ──────────────────────────────────
   *
   * THE RACE. `alt-watchlist` PUTs the WHOLE array and the function is
   * last-write-wins on it, so two stars a moment apart used to race: the second
   * request was built from the same `prev` the first had, and whichever
   * response landed last decided the list. The star that lost was still lit and
   * its toast had already said it saved — the sentinel would then never watch
   * that coin.
   *
   * WHAT THAT COST THE FIRST TIME. Closing it by refusing every toggle while a
   * write was in flight traded a one-row race for a whole-tab lockout: one
   * in-flight PUT disabled all 26 stars plus the detail pane's, `api()` had no
   * timeout, and five rapid taps landed one write and dropped four with no
   * toast, no spinner and no recovery. The rejection toast that was supposed to
   * name the drop could not fire at all, because every path into it sat behind
   * a disabled button. A lock is the wrong instrument: the user's intent is
   * never invalid, it is just later than the wire.
   *
   * WHAT IS HERE NOW. Intent and transport are separated. Every tap updates
   * `desired` immediately — the optimistic list the UI renders — and the writer
   * drains `desired` in a loop: it sends the current one, and when the response
   * lands it checks whether a newer intent arrived while it was on the wire. If
   * one did, it sends THAT instead of settling. So a superseded write is never
   * dropped, it is superseded by a request that carries it; and because every
   * request carries the whole array, the coin the user tapped third is in the
   * list the first request already sent if it was still on the wire. The race
   * cannot reopen: there is only ever one request in flight, and its body is
   * always built from the latest intent rather than from a stale snapshot.
   *
   * Refs, not state, for `desired`/`inFlight`: they are read and written inside
   * the same async turn as the request, and a state update would not be visible
   * to a second toggle fired before the re-render.
   */
  const inFlight = useRef(false)
  const desiredRef = useRef(null)         // latest intent; null when settled
  const confirmedRef = useRef(null)       // last list the server acknowledged
  const queuedRef = useRef([])            // {symbol,on} per unsettled tap, in order
  const pendingRef = useRef(new Set())

  useEffect(() => {
    if (!serverIds) return
    confirmedRef.current = serverIds
    // A refetch must not clobber taps that have not been acknowledged yet.
    if (!inFlight.current && !desiredRef.current) setLocalIds(serverIds)
  }, [serverIds])

  const ids = localIds ?? serverIds ?? []
  const watched = useMemo(() => new Set(ids.map((e) => e.id)), [ids])

  // One object in both places: the ref is what the next tap builds from and the
  // state is what the board renders, and two empty sets that are not the same
  // empty set is the kind of drift that only shows up under a fast finger.
  const settle = useCallback(() => {
    pendingRef.current = new Set()
    queuedRef.current = []
    setPendingIds(pendingRef.current)
  }, [])

  const drain = useCallback(async () => {
    inFlight.current = true
    try {
      while (desiredRef.current) {
        const sending = desiredRef.current
        // Only the four keys the validator allows, and `addedAt` is deliberately
        // NOT sent: the server owns "when did I star this", and re-sending it on
        // every toggle would reset every date in the list to now.
        const body = { ids: sending.map((e) => ({ id: e.id, symbol: e.symbol, name: e.name ?? '', note: e.note ?? '' })) }
        const res = await api('alt-watchlist', { method: 'PUT', body: JSON.stringify(body) })
        const saved = res?.watchlist?.ids ?? sending
        confirmedRef.current = saved
        // A newer intent arrived while this was on the wire: loop, do not settle.
        if (desiredRef.current !== sending) continue
        desiredRef.current = null
        setLocalIds(saved)
        const q = queuedRef.current
        toast(q.length === 1
          ? (q[0].on ? `${q[0].symbol} off the watchlist` : `${q[0].symbol} on the watchlist`)
          : `${q.length} watchlist changes saved`)
        settle()
      }
    } catch (e) {
      // ROLLBACK, TO THE LAST LIST THE SERVER ACKNOWLEDGED. A star that is lit
      // but did not save is the worst outcome here: the sentinel never watches
      // that coin, and the UI has already told you it does. The toast names the
      // server's own first complaint, because "validation failed" on its own is
      // not actionable — and it says how many taps went back, because with
      // coalescing one failed request can carry several.
      const n = queuedRef.current.length
      desiredRef.current = null
      setLocalIds(confirmedRef.current ?? serverIds ?? [])
      settle()
      const detail = e?.body?.errors?.[0] || e?.message || 'the request failed'
      toast(`Watchlist not saved — ${detail}${n > 1 ? ` (${n} changes rolled back)` : ''}`, { err: true })
    } finally {
      inFlight.current = false
    }
  }, [serverIds, settle, toast])

  const toggleWatch = useCallback((row) => {
    if (!row?.id || !row?.symbol) return
    // The list this tap is a change TO: the outstanding intent if there is one,
    // otherwise the last list the server acknowledged. Reading `localIds` first
    // would read a state value from before the settling render on a tap fired
    // in that gap, which is how the whole-array PUT loses a coin.
    const base = desiredRef.current ?? confirmedRef.current ?? localIds ?? serverIds ?? []
    const on = base.some((e) => e.id === row.id)
    // 60 is the sentinel's budget, enforced server-side. Catching it here means
    // the 61st star fails as a sentence rather than as a validation array.
    if (!on && base.length >= MAX_WATCH) {
      toast(`Watchlist is full at ${MAX_WATCH} coins — unstar something first`, { err: true })
      return
    }
    desiredRef.current = on
      ? base.filter((e) => e.id !== row.id)
      : [...base, { id: row.id, symbol: row.symbol, name: String(row.name ?? '').slice(0, 100), note: '' }]
    setLocalIds(desiredRef.current)   // optimistic: the star lights immediately
    pendingRef.current = new Set(pendingRef.current).add(row.id)
    queuedRef.current = [...queuedRef.current, { symbol: row.symbol, on }]
    setPendingIds(pendingRef.current)
    if (!inFlight.current) void drain()
  }, [drain, localIds, serverIds, toast])

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
            // Gated with the rest of the payload, not beside it. Ungated, a dead
            // scan rendered "cached 4000s" — a real number about a payload
            // nothing else on the card is allowed to quote — with the reasons it
            // was degraded suppressed. The age of a payload we refuse to read is
            // not a fact about the market; `FreshChip` already says how old the
            // scan is, and it says it from `asOf`.
            cached={live && !!market.payload?.cached}
            cacheAgeSec={live ? market.payload?.cacheAgeSec ?? null : null}
            onReload={scan.reload}
          />
          <section className="card pad-md alt-boardcard">
            <div className="ttl t-label">Board</div>
            {/* Under the title, not in `.dr-state`. That class is a nowrap state
                word for the right-hand end of a title bar; a sentence in it is
                361px of min-content, which on a phone is what set this whole
                pane's grid track — 393px of card in a 328px column — and, with
                the track fixed, what got ellipsised mid-clause. */}
            <p className="sub t-foot alt-boardnote">
              Ranked by how likely a move is starting, not by how much it already moved.
            </p>
            {live ? (
              <AltBoard
                rows={rows}
                watched={watched}
                selectedId={sel?.id ?? null}
                // The rows with an unacknowledged change — and ONLY those rows
                // are disabled. See the writer above for why this is a set and
                // not a lock.
                pendingIds={pendingIds}
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
              screened={screened}
              season={season}
              settings={settings}
              freshScan={freshScan}
              freshCoin={freshCoin}
              fearGreed={live ? market.payload?.fearGreed ?? null : null}
              trendingRank={trendingRank}
              trendingChecked={trendingChecked}
              starred={watched.has(sel.id)}
              // THIS coin's write, not any write. The two surfaces share one
              // writer, so a star started on the board and one started here
              // cannot race — they queue into the same intent. Disabling this
              // star because some other row is saving is the 26-row lockout in
              // miniature, and it was measured dead at t+15s.
              saving={pendingIds.has(sel.id)}
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
