// Scheduled sentinel (every 30 min, netlify.toml). Watches the stop even
// when the app is closed: STOP HIT / STOP NEAR alerts on an open position,
// ENTRY SIGNAL when flat. It also RATCHETS the persisted stop high-water
// mark, which is what makes "the stop only ever rises" true across
// settings edits and position blends, not just within one computation.
// Telegram-optional, deduped by condition (not by cent-level stop drift),
// and never throws — a broken sentinel must not look like a broken market.
//
// PAUSABLE, AND A PAUSE STOPS ALL OF IT. Macro's power switch stops this pass
// via `macro.watch`'s ops_control row — no quote, no candles, no ratchet, no
// alert. That is the whole engine, and it is deliberate on the one point that
// looks risky: skipping the RATCHET cannot corrupt or lose the stop high-water
// mark. `stopHighWater` is a max that only ever rises, and every input to it —
// the anchored chandelier trail and the highest close since entry — is
// recomputed from the FULL candle series on the next unpaused pass, not
// accumulated across passes. So a paused window leaves the mark where it was and
// the next pass re-derives it; the invariant this file exists to hold ("the stop
// only ever rises") is preserved in the safe direction, a stop that may be
// looser than a continuously-running one, never tighter and never wrong.
//
// What a pause DOES cost is the alerts themselves: a STOP HIT while paused is
// not sent. That is what pausing a sentinel means, it is the operator's explicit
// choice, and the switch's copy has to say so — see toolPower.mjs's `stops`.
import { json, store, sendTelegram, checkAuth } from '../shared/util.mjs'
import { enginePause } from '../shared/toolPower.mjs'
import { mstrQuote, btcSpot, mstrCandles } from '../shared/sources.mjs'
import { anchoredChandelier, effectiveStop } from '../../apps/macro/src/lib/risk.js'
import { pullbackSetup, breakout } from '../../apps/macro/src/lib/signals.js'

const SUBSYSTEM = 'macro.watch'
const DEDUPE_MS = 6 * 3600 * 1000
const RESEND_ON_STOP_MOVE_PCT = 0.5
const PRUNE_MS = 7 * 24 * 3600 * 1000

export default async (req) => {
  try {
    // FIRST, ahead of even the auth check. Everything below this line either
    // spends an upstream call or writes Blobs, and a paused engine should show
    // up as a flat line on both. An operator hitting /api/watch-snapshot by hand
    // gets the same answer as the scheduler, which is the point: the pause is
    // the tool's state, not a property of who invoked it.
    const power = await enginePause(SUBSYSTEM)
    if (power.paused) return json({ ok: true, skipped: 'paused', reason: power.reason })

    // Trust nothing from the request: the scheduler can't carry our token
    // and any body field can be forged, so the pass always runs (its side
    // effects are dedupe-capped and ratchet-only) — but position-proximity
    // response fields are gated on the real token check alone.
    const authed = await checkAuth(req)

    const s = store()
    const [quote, btc] = await Promise.allSettled([mstrQuote(), btcSpot()])
    const mstrPx = quote.status === 'fulfilled' ? quote.value.price : null
    const btcPx = btc.status === 'fulfilled' ? btc.value.price : null

    if (mstrPx == null) return json({ ok: false, reason: 'no MSTR price; skipping alert pass' })

    const settings = { chandelierPeriod: 22, chandelierMult: 3, beAtR: 1, ...((await s.get('settings', { type: 'json' })) || {}) }
    const position = await s.get('position', { type: 'json' })
    const alerts = []
    let governingStop = null

    if (position) {
      // Fallback before candles resolve: never let an override LOWER the stop.
      let stop = Math.max(position.initialStop, position.stopOverride ?? -Infinity, position.stopHighWater ?? -Infinity)
      try {
        const { candles } = await mstrCandles('1d')
        const entryIdx = candles.findIndex((c) => new Date(c.t * 1000).toISOString().slice(0, 10) >= position.entryDate)
        if (entryIdx >= 0) {
          const trail = anchoredChandelier(candles, {
            entryIdx,
            atrPeriod: settings.chandelierPeriod,
            mult: settings.chandelierMult,
            initialStop: position.initialStop,
          })
          let hcse = -Infinity
          for (let k = entryIdx; k < candles.length; k++) hcse = Math.max(hcse, candles[k].c)
          const eff = effectiveStop({
            initialStop: position.initialStop,
            trailStop: trail.length ? trail[trail.length - 1] : null,
            entry: position.avgEntry,
            beAtR: settings.beAtR,
            highestCloseSinceEntry: hcse,
          })
          if (Number.isFinite(eff)) stop = Math.max(stop, eff)
          if (Number.isFinite(position.stopOverride)) stop = Math.max(stop, position.stopOverride)
        }
      } catch { /* candles down: the initialStop/override/high-water floor still guards */ }

      governingStop = Number.isFinite(stop) ? Math.round(stop * 100) / 100 : null

      // Ratchet the persisted high-water mark — the end-to-end guarantee.
      // Re-read first and merge ONLY stopHighWater into the freshest copy:
      // candle fetches above took seconds, and clobbering a user PUT that
      // landed meanwhile would silently revert their position edit. Skip
      // entirely if the trade identity changed under us.
      if (governingStop != null && governingStop > (position.stopHighWater ?? -Infinity)) {
        try {
          const current = await s.get('position', { type: 'json' })
          if (current && current.entryDate === position.entryDate && governingStop > (current.stopHighWater ?? -Infinity)) {
            await s.setJSON('position', { ...current, stopHighWater: governingStop })
          }
        } catch { /* next run retries */ }
      }

      if (governingStop != null) {
        if (mstrPx <= governingStop) {
          alerts.push({ key: 'stop_hit', stop: governingStop, text: `🔴 TORQUE: STOP HIT — MSTR ${mstrPx} at/under stop ${governingStop.toFixed(2)}. Sell ${position.shares} shares per plan.` })
        } else if ((mstrPx - governingStop) / mstrPx <= 0.03) {
          alerts.push({ key: 'stop_near', stop: governingStop, text: `🟠 TORQUE: STOP NEAR — MSTR ${mstrPx}, stop ${governingStop.toFixed(2)} (${(((mstrPx - governingStop) / mstrPx) * 100).toFixed(1)}% away).` })
        }
      }
    } else {
      const { candles } = await mstrCandles('1d')
      const pb = pullbackSetup(candles)
      const bo = breakout(candles)
      if (pb.stage === 'trigger') alerts.push({ key: 'entry_pullback', stop: null, text: `🟢 TORQUE: ENTRY SIGNAL — pullback trigger on MSTR at ${mstrPx}. Open the cockpit before acting.` })
      else if (bo.active) alerts.push({ key: 'entry_breakout', stop: null, text: `🟢 TORQUE: ENTRY SIGNAL — breakout over ${bo.level} on MSTR at ${mstrPx}. Open the cockpit before acting.` })
    }

    let sent = 0
    if (alerts.length) {
      // Dedupe by CONDITION id, resending only when the suppression window
      // lapses or the governing stop has moved materially — cent-level trail
      // drift must not mint fresh alert spam every bar-roll.
      const log = (await s.get('alerts_sent', { type: 'json' })) || {}
      const now = Date.now()
      for (const k of Object.keys(log)) {
        if (now - (log[k]?.sentAt ?? 0) > PRUNE_MS) delete log[k]
      }
      for (const a of alerts) {
        const prev = log[a.key]
        // Movement-based resend only ever WIDENS resending when BOTH stops
        // are known; with either side null (entry signals) it must default
        // to 0 (suppressed) or the 6h window silently stops existing.
        const stopMovedPct = prev?.stopAtSend != null && a.stop != null
          ? Math.abs(a.stop - prev.stopAtSend) / prev.stopAtSend * 100
          : 0
        if (prev && now - prev.sentAt < DEDUPE_MS && stopMovedPct < RESEND_ON_STOP_MOVE_PCT) continue
        const res = await sendTelegram(a.text)
        if (res.sent) { log[a.key] = { sentAt: now, stopAtSend: a.stop }; sent++ }
      }
      await s.setJSON('alerts_sent', log)
    }
    const summary = { ok: true, alertsConsidered: alerts.length, alertsSent: sent }
    // A pass that ran because it could not read the pause row says so, rather
    // than looking identical to one that ran because nothing was paused. That
    // difference is the only thing standing between "fails open" and "the switch
    // is decorative and nobody noticed".
    if (power.unknown) {
      summary.pauseUnknown = power.why
      console.warn(`[${SUBSYSTEM}] pause state unreadable, running anyway: ${power.why}`)
    }
    // Position-proximity details for token-bearing callers ONLY — the
    // scheduler ignores the response body, so it loses nothing.
    return json(authed ? { ...summary, mstrPx, btcPx, governingStop } : summary)
  } catch (e) {
    console.error('watch-snapshot failed:', e)
    return json({ ok: false, error: String(e?.message || e) })
  }
}
