// ONE CALL PER COIN — the alt analogue of advice.js, and built on the same law.
//
// THE PRIORITY LADDER IS LAW: first match wins, and safety rungs outrank
// opportunity rungs, so a broken stop can never be talked over by a fresh
// breakout on the row below it. Every rung returns; nothing accumulates.
//
// NEW RISK REQUIRES LIVE DATA. ENTER, STARTER and ADD are the only rungs that
// put money on, and every one of them is gated on every feed reading `live`.
// A dead or stale feed can never produce an ENTER — a trigger that fired on a
// price we cannot currently verify says so out loud and stands down, rather than
// pretending it never fired. This is copied from advice.js in spirit and in
// wording, because it is the one rule in that file that has never been relaxed.
//
// ONE DEPARTURE FROM THE CONTRACT'S ORDER, AND WHY: `AVOID` is gated on a flat
// book. It is a verdict about OPENING risk ("this is a stablecoin", "you cannot
// get out of this", "this already went"), and a position you already hold in a
// thin coin needs an exit plan, not a note advising you not to buy it. So the
// held-position rungs run first — which is also what the contract asks — and
// AVOID then only ever speaks to a flat book. Everything else is the documented
// order: NO_DATA → exits → AVOID → new risk → ARM → STALK → WATCH → default.
//
// Pure, and imports nothing, exactly like advice.js. The handful of level
// arithmetic it needs (the prior 20-bar high, the base low) is inlined at the
// bottom for the same reason risk.js inlines its ATR: this file decides where
// money goes in and comes out, and a change in a shared TA helper must not be
// able to move a stop here without this file's tests going red.

/**
 * The cycle phases in which a fresh breakout is late rather than early. Named
 * here, once, because they are the only place `phase` changes an action — and a
 * set spelled out inline inside a rung is a set nobody finds when playbook.js
 * renames one.
 */
const LATE_PHASES = new Set(['euphoria', 'distribution', 'bust'])

/**
 * @param screened   screenCoin() result — carries price, band, flags, facts
 * @param season     seasonRead() result — the regime this setup is fighting or riding
 * @param precedent  precedentRead() result — { ok, reason, episodes, baseRates, matchPct, ... }
 * @param crowd      crowdRead() result — { score, state, contrarian, crowding, ... }
 * @param phase      playbook.phaseOf() result — { id, label, confidence, why[] }
 * @param plan       { stop: altStop(), size: altSize(), defaults: tierDefaults() }
 * @param position   { units, avgEntry } | null
 * @param candles    daily OHLCV, oldest first, already multiplier-corrected
 * @param freshness  { scan: {state}, coin: {state} } — or any map of named feeds,
 *                   or a single { state }. ABSENT MEANS DEAD (see feedStates).
 * @param candleQuality 'ohlcv' | 'close-only' | null (null ⇒ detected from the bars)
 * @param now        ms epoch
 */
export function altDirective(raw = {}) {
  // `= {}` only fires on undefined. This runs inside a render against whatever
  // the API returned, and `null` destructures into a TypeError that blanks the
  // whole detail pane — the one place a directive is most needed.
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const {
    screened = null, season = null, precedent = null, crowd = null, phase = null,
    plan = null, position = null, candles = null, freshness = null,
    candleQuality = null, now = null,
  } = input

  const sym = String(screened?.symbol ?? '').toUpperCase() || 'this coin'
  const price = Number.isFinite(screened?.price) ? screened.price : null
  const size = plan?.size ?? null
  const stop = Number.isFinite(plan?.stop?.stop) ? plan.stop.stop : null

  const feeds = feedStates(freshness)
  const dead = feeds.filter(([, s]) => s === 'dead').map(([k]) => k)
  const notLive = feeds.filter(([, s]) => s !== 'live')
  const allLive = notLive.length === 0
  const allDead = feeds.length > 0 && dead.length === feeds.length

  const quality = candleQuality ?? detectQuality(candles)
  const levels = buildLevels({ screened, precedent, candles, price, stop })
  // `levels.triggerLive` / `levels.invalidated` are the level tests themselves,
  // computed once in buildLevels and published on the result — see the note
  // above it. `=== true` because both are THREE-state: null means the level or
  // the price was never measured, and treating that as false is how an absent
  // input starts moving a rung.
  const triggerLive = levels.triggerLive === true

  /* ── guardrails: everything the reader should know about the read itself,
   *    attached to EVERY rung including the good ones. A guardrail never
   *    changes the action; it is what makes the action legible. ───────────── */
  const guardrails = []
  for (const [name, state] of notLive) guardrails.push(`the ${name} feed is ${state} — treat every number here with suspicion`)
  if (quality === 'close-only') {
    guardrails.push('candles are CLOSE-ONLY (a CoinGecko fallback, one flat bar per day) — ATR, swing structure and every base rate built on them are meaningless, so the stop below is a percentage and not a volatility measurement')
  }
  if (precedent && precedent.ok === false) guardrails.push(`no usable precedent: ${precedent.reason}`)
  if (!precedent) guardrails.push('no precedent read was run for this coin — there is no base rate behind any target below')
  if (crowd?.contrarian === 'headwind') {
    guardrails.push(`the crowd is a headwind${crowd.extremes?.length ? `: ${crowd.extremes.join(' + ')}` : ''} — you would be buying into positioning that is already on`)
  }
  if (Number.isFinite(crowd?.crowding?.fundingAnnualPct) && crowd.crowding.fundingAnnualPct >= 50) {
    guardrails.push(`funding is ${Math.round(crowd.crowding.fundingAnnualPct)}%/yr — carrying this long costs real money and unwinds violently`)
  }
  if (screened?.flags?.thinLiquidity) guardrails.push(`only ${usd(screened.vol24h)} traded in 24h — you can get in and not out`)
  if (size?.liquidityUnknown) guardrails.push('24h volume is missing, so the liquidity cap could not be applied — the size below is unchecked against what this coin actually trades')
  if (size?.capped === 'liquidity') guardrails.push(`size is capped by LIQUIDITY, not by risk: ${money(size.notional)} is ${size.advPct}% of a day's volume`)
  if (screened?.flags?.newListing) guardrails.push('no 30-day history — every longer-window read on this row is absent, not zero')
  if (hostileSeason(season)) {
    // `score` is null on a read season.js declined to publish, and "(null/100)"
    // on the one guardrail that says the tape is against you is exactly the kind
    // of number this file is not allowed to print.
    guardrails.push(`the regime is ${season.label ?? 'hostile'}${Number.isFinite(season?.score) ? ` (${season.score}/100)` : ''} — alt risk is fighting the tape today`)
    if (bandHostile(season)) guardrails.push(seasonBandVetoText(season))
  }
  // `else if`: a hostile regime is a measured verdict and outranks the note that
  // it might not have been measured. They are mutually exclusive by construction
  // anyway (a phase only exists above the coverage floor), but stating the
  // precedence here keeps a future third season state from printing both.
  else if (unmeasuredSeason(season)) guardrails.push(seasonUnmeasuredText(season))

  const out = (action, headline, reasons, severity) => ({
    action, headline, reasons: reasons.filter(Boolean), guardrails, severity, levels,
  })

  /* ── 1 — no data ────────────────────────────────────────────────────────── */
  if (!screened || price == null || allDead) {
    return out('NO_DATA', 'Stand down — the data is dead, not the market.', [
      screened ? `No trustworthy price for ${sym} right now.` : 'No screened row for this coin.',
      dead.length ? `dead feed${dead.length > 1 ? 's' : ''}: ${dead.join(', ')}` : null,
      position ? 'You hold this: check the exchange directly, do not trust this screen.' : 'No position open; nothing to protect.',
    ], position ? 'urgent' : 'info')
  }

  const r = rMultiple(position, price, stop)
  const openPct = position && Number.isFinite(position.avgEntry) && position.avgEntry > 0
    ? ((price - position.avgEntry) / position.avgEntry) * 100
    : null

  /* ── 2 — held position, hard exits ──────────────────────────────────────── */
  if (position) {
    if (Number.isFinite(stop) && price <= stop) {
      return out('EXIT', `Sell your ${units(position.units)} ${sym} now — the stop is hit.`, [
        `price ${px(price)} at or under the stop ${px(stop)}`,
        rLine(r), pnlLine(openPct),
        'The plan only works if the stop is real. Execute it.',
      ], 'urgent')
    }
    if (levels.invalidated === true) {
      return out('EXIT', `Close ${sym} — the setup is invalidated.`, [
        `price ${px(price)} lost the base low ${px(levels.invalidation)}${levels.invalidationBasis ? ` (${levels.invalidationBasis})` : ''}`,
        'The reason you were in this is gone. What is left is a hope, not a thesis.',
        rLine(r), pnlLine(openPct),
      ], 'urgent')
    }

    /* ── 3 — held position, soft warnings → trim ──────────────────────────── */
    const soft = []
    if (screened.flags?.parabolic) soft.push(`parabolic: ${pct(screened.chg24h)} in 24h / ${pct(screened.chg7d)} in 7d — this is the part of the move that gives itself back`)
    if (screened.band === 'extended') soft.push('band is EXTENDED — the run is behind it, not in front of it')
    if (crowd?.state === 'euphoric') soft.push(`the crowd is euphoric (${crowd.score}/100) — that is who you sell to`)
    if (crowd?.contrarian === 'headwind' && screened.band === 'running') soft.push('running into a crowd headwind — the marginal buyer is already long')
    if (soft.length > 0) {
      return out('TRIM', `Take some ${sym} off — this is late in the move, not early.`, [
        ...soft, rLine(r), pnlLine(openPct), stopLine(stop, price),
      ], 'act')
    }
  }

  /* ── 4 — AVOID (flat books only — see the note at the top) ──────────────── */
  if (!position) {
    if (screened.flags?.stablecoin || screened.flags?.wrapper) {
      return out('AVOID', `${sym} is not a trade — it is ${screened.flags.stablecoin ? 'a dollar' : 'a receipt for another asset'}.`, [
        ...(screened.facts || []).slice(0, 1),
        'It has no independent move to catch. Nothing on this page applies to it.',
      ], 'info')
    }
    if (screened.flags?.thinLiquidity) {
      return out('AVOID', `${sym} is untradeable at any size that matters.`, [
        `${usd(screened.vol24h)} of 24h volume against a ${usd(screened.mcap)} cap`,
        size?.error === 'below_min_ticket'
          ? `the liquidity cap sizes this at ${money(size.notional)}, under the ${money(size.minTicketUsd)} minimum ticket — the position that fits is not worth placing`
          : 'the exit is the problem, not the entry: on the day this matters the book will not be there',
      ], 'info')
    }
    if (screened.flags?.parabolic) {
      return out('AVOID', `${sym} already went — ${pct(screened.chg24h)} in 24h, ${pct(screened.chg7d)} in 7d.`, [
        'Buying here is buying the exit liquidity of everyone who was early.',
        `the setup this board hunts is the day BEFORE this bar${Number.isFinite(levels.invalidation) ? `; the level that would make it interesting again is a base above ${px(levels.invalidation)}` : ''}`,
        ...(crowd?.contrarian === 'headwind' ? [crowd.facts?.find((f) => f.startsWith('HEADWIND'))].filter(Boolean) : []),
      ], 'info')
    }
    if (size && size.ok === false && size.error === 'below_min_ticket') {
      return out('AVOID', `${sym} cannot be sized into a position worth placing.`, [
        `the caps allow ${money(size.notional)}, under the ${money(size.minTicketUsd)} minimum ticket`,
        size.capped === 'liquidity' ? 'the binding cap is liquidity — this is a size problem the risk settings cannot fix' : 'raise the risk budget or skip it',
      ], 'info')
    }
  }

  /* ── 5 — held position with a live trigger → ADD ────────────────────────── */
  // The same spec advice.js requires: a live trigger, a stop already at or above
  // the average entry (so the original position is risk-free), and every feed
  // alive. A blocked add surfaces in the hold rung below rather than vanishing.
  const addSpecMet = !!position && triggerLive && Number.isFinite(stop) &&
    Number.isFinite(position.avgEntry) && stop >= position.avgEntry
  if (addSpecMet && allLive && size?.ok) {
    return out('ADD', `Add ${units(size.units)} ${sym} — the trigger fired with the stop already at breakeven.`, [
      `price ${px(price)} cleared ${px(levels.trigger)}${levels.triggerBasis ? ` (${levels.triggerBasis})` : ''}`,
      `add risk ${money(size.riskUsd)}; the original ${units(position.units)} is already risk-free against ${px(position.avgEntry)}`,
      rLine(r), stopLine(stop, price),
    ], 'act')
  }

  /* ── 6 — held position, nothing to do ───────────────────────────────────── */
  // The contract's action list has no HOLD rung, and inventing one would break
  // every consumer that switches on the documented set. WATCH is the honest fit:
  // there is no action, and the headline says what to do with the position.
  if (position) {
    const blocked = addSpecMet
      ? dead.length > 0
        ? `add trigger live but blocked: the ${dead.join(' + ')} feed is dead — no new risk on blind data`
        : notLive.length > 0
          ? `add trigger live but blocked: the ${notLive.map(([k]) => k).join(' + ')} feed is stale — no new risk on old tape`
          : `add trigger live but blocked: ${sizingErrorText(size?.error)}`
      : null
    return out('WATCH', `Hold your ${units(position.units)} ${sym} — nothing has changed.`, [
      blocked, rLine(r), pnlLine(openPct), stopLine(stop, price),
      `band ${screened.band} · score ${screened.score}/100`,
      phaseLine(phase),
      // The score is null on a read season.js declined to publish, and this
      // printed "regime: Not enough measured (null/100)" — the one rung a held
      // position lands on most days, quoting a number nothing computed. Every
      // other rung already guarded it; this one did not, and no test swept the
      // held-position rungs against a refused season read.
      season?.phase ? `regime: ${season.label}${Number.isFinite(season.score) ? ` (${season.score}/100)` : ''}` : null,
    ], 'info')
  }

  /* ── 7 — the trigger is live: enter, take a starter, or stand down ──────── */
  if (triggerLive) {
    if (!allLive) {
      const which = notLive.map(([k, s]) => `${k} (${s})`).join(' and ')
      return out('WATCH', `A break is live on ${sym} but the ${which} feed is not — no new risk on blind data.`, [
        `price ${px(price)} is above ${px(levels.trigger)}${levels.triggerBasis ? ` (${levels.triggerBasis})` : ''}`,
        'Fix the feed, then re-read the trigger. The setup does not expire in a minute.',
      ], 'info')
    }
    if (!size?.ok) {
      // A size that was NEVER COMPUTED and a size that came back rejected are
      // different facts, and only the second is a statement about the coin.
      // The scheduled sentinel calls this with `plan: null` deliberately —
      // sizing 60 watchlist coins would cost 60 candle fetches inside a 30s
      // budget — and it quotes this headline straight into a Telegram digest,
      // where "the position cannot be sized" reads as a liquidity verdict on a
      // coin that nothing ever tried to size. Same for a UI pane whose settings
      // have not loaded yet.
      const untried = !size
      return out('WATCH', untried
        ? `A break is live on ${sym} — no position size was computed for it in this pass.`
        : `A break is live on ${sym} but the position cannot be sized.`, [
        `price ${px(price)} is above ${px(levels.trigger)}`,
        `blocker: ${sizingErrorText(size?.error)}`,
      ], 'info')
    }
    if (hostileSeason(season)) {
      return out('WATCH', `${sym} broke out into a ${season?.label ?? 'hostile'} tape — the setup is real, the regime is not.`, [
        `price ${px(price)} cleared ${px(levels.trigger)}`,
        Number.isFinite(season?.score) ? `regime ${season.score}/100: ${season.plain}` : (season?.plain ?? null),
        // Which of the two vetoes this is. A read that named `btc_only` and a
        // read whose whole band sits under it are both hostile, and a reader
        // comparing this card against the season header has to be able to tell
        // that the header says "no regime named" for an honest reason.
        bandHostile(season) ? seasonBandVetoText(season) : null,
        'Breakouts in this regime fail more often than they run. Wait for the tape or take it far smaller than the plan below.',
      ], 'info')
    }

    // Everything operational is met. What separates ENTER from STARTER is
    // EVIDENCE, not permission: a full size is for a setup we have measured
    // before on real bars with the crowd not already in it.
    const missing = []
    if (!precedent?.ok) missing.push(precedent?.reason ? `no base rate (${precedent.reason})` : 'no base rate for this setup')
    if (quality === 'close-only') missing.push('close-only candles — the structure read behind this is flat bars')
    if (crowd?.contrarian === 'headwind') missing.push('the crowd is already positioned here')
    if (Number.isFinite(precedent?.matchPct) && precedent.matchPct < 50) missing.push(`today only matches the pre-ignition fingerprint ${Math.round(precedent.matchPct)}%`)
    // A break inside a late-cycle phase is a real break in a bad place. The
    // playbook read is the only input that can say "this already had its run",
    // and it earns a downgrade rather than a veto because it is a judgement over
    // several other reads and not a measurement of its own.
    if (LATE_PHASES.has(phase?.id)) missing.push(`the cycle read says ${String(phase.label ?? phase.id).toLowerCase()} — this is a break late in a move, not the start of one`)
    // An unmeasured regime is a missing piece of EVIDENCE, not a hostile tape —
    // see unmeasuredSeason() for why this is a downgrade and not a veto.
    if (unmeasuredSeason(season)) missing.push(seasonUnmeasuredText(season))

    if (missing.length === 0) {
      return out('ENTER', `Buy ${units(size.units)} ${sym} — the break is live and it has a precedent.`, [
        `price ${px(price)} cleared ${px(levels.trigger)}${levels.triggerBasis ? ` (${levels.triggerBasis})` : ''}`,
        precedentLine(precedent),
        `size ${units(size.units)} ≈ ${money(size.notional)} (${size.positionPct}% of equity${size.advPct == null ? '' : `, ${size.advPct}% of a day's volume`})${size.reduced ? ` — CAPPED by ${size.capped}` : ''}`,
        `risk if stopped ${money(size.riskUsd)}; stop ${px(stop)}${stopDistText(stop, price)}`,
        crowd?.contrarian === 'tailwind' ? crowd.facts?.find((f) => f.startsWith('TAILWIND')) : null,
        phaseLine(phase),
        `regime ${season?.label ?? 'unknown'}${Number.isFinite(season?.score) ? ` (${season.score}/100)` : ''} · band ${screened.band} · score ${screened.score}/100`,
      ], 'act')
    }
    // Half, stated as a number rather than as "a bit less". A starter that is
    // not quantified is a full position with a hedge in the copy.
    const starterUnits = floorSig(size.units / 2, 6)
    return out('STARTER', `Starter only in ${sym} — no more than ${units(starterUnits)} (half the sized ${units(size.units)}).`, [
      `price ${px(price)} cleared ${px(levels.trigger)}, so the trigger is real`,
      `what is missing: ${missing.join('; ')}`,
      `half size risks ${money((size.riskUsd ?? 0) / 2)} instead of ${money(size.riskUsd)}; stop ${px(stop)}${stopDistText(stop, price)}`,
      'Add the rest only if it holds the trigger level and the missing leg fills in.',
    ], 'act')
  }

  /* ── 8 — ARM: everything met, waiting on a price ────────────────────────── */
  const armable = Number.isFinite(levels.trigger) && allLive && !!size?.ok && !hostileSeason(season) &&
    (screened.band === 'igniting' || screened.band === 'waking' || (Number.isFinite(screened.score) && screened.score >= 55))
  if (armable) {
    const away = Number.isFinite(price) && price > 0 ? ((levels.trigger - price) / price) * 100 : null
    return out('ARM', `${sym} is armed — it triggers on a close above ${px(levels.trigger)}.`, [
      away == null ? null : `${px(price)} now, ${away.toFixed(1)}% below the trigger${levels.triggerBasis ? ` (${levels.triggerBasis})` : ''}`,
      `the plan at that trigger: ${units(size.units)} ≈ ${money(size.notional)}, stop ${px(stop)}, risk ${money(size.riskUsd)}`,
      precedentLine(precedent),
      phaseLine(phase),
      `band ${screened.band} · score ${screened.score}/100 · regime ${season?.label ?? 'unknown'}`,
      'Do not front-run it. The level is the whole edge; without it this is a guess with a stop attached.',
    ], 'info')
  }

  /* ── 9 — STALK: a base is forming and it rhymes with the last one ───────── */
  const basing = screened.band === 'basing' || screened.band === 'waking'
  const matches = Number.isFinite(precedent?.matchPct) && precedent.matchPct >= 60
  if (basing && (matches || (Number.isFinite(screened.score) && screened.score >= 45))) {
    return out('STALK', `Stalk ${sym} — a base is forming${matches ? ` and it looks ${Math.round(precedent.matchPct)}% like the day before its last ignition` : ''}.`, [
      matches ? precedentLine(precedent) : null,
      Number.isFinite(levels.trigger) ? `the level that would change this: a close above ${px(levels.trigger)}${levels.triggerBasis ? ` (${levels.triggerBasis})` : ''}` : 'no trigger level yet — not enough history to define one',
      Number.isFinite(levels.invalidation) ? `the level that would kill it: ${px(levels.invalidation)}` : null,
      ...(screened.facts || []).slice(0, 2),
      phaseLine(phase),
      crowd?.contrarian === 'tailwind' ? crowd.facts?.find((f) => f.startsWith('TAILWIND')) : null,
    ], 'info')
  }

  /* ── 10 — WATCH: on the radar, not on the desk ──────────────────────────── */
  if (Number.isFinite(screened.score) && screened.score >= 30) {
    return out('WATCH', `Watch ${sym} — it is doing something, but nothing you can act on.`, [
      `band ${screened.band} · score ${screened.score}/100`,
      ...(screened.facts || []).slice(0, 2),
      Number.isFinite(levels.trigger) ? `the level to wait for: ${px(levels.trigger)}` : null,
    ], 'info')
  }

  /* ── 11 — default ───────────────────────────────────────────────────────── */
  return out('WATCH', `Nothing here in ${sym}. Cash is a position.`, [
    `band ${screened.band} · score ${screened.score ?? '—'}/100`,
    ...(screened.facts || []).slice(0, 2),
    season?.plain ?? null,
  ], 'info')
}

/* ══ levels ═════════════════════════════════════════════════════════════════
 *
 * TRIGGER is the prior 20-bar high, excluding today's bar — the SAME definition
 * signals.js's breakout() uses and the same one precedent.js's ignition test
 * uses. That is not a coincidence and it must not drift: the base rates shown
 * beside these levels were measured from bars that closed above exactly this
 * level, so a trigger defined any other way would attach one setup's statistics
 * to a different setup's entry.
 *
 * INVALIDATION is not the stop. The stop is a money decision (how much am I
 * willing to lose); the invalidation is a thesis decision (below here the base
 * I was buying does not exist). They are usually close and they are not the
 * same number, and collapsing them is how a stop gets moved "just a bit lower"
 * on the day it matters.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BOTH LEVELS COME OUT OF THE SAME WINDOW OF SETTLED BARS, AND THE WINDOW
 * EXCLUDES TODAY. THIS IS TRUE OF BOTH SOURCES, WHICH IS THE SECOND HALF OF THE
 * FIX AND THE HALF THAT WAS MISSED.
 *
 * They drifted apart once — the trigger excluded the current bar and the
 * invalidation included it — and the invalidation is the half where that is
 * fatal. Today's low is by construction ≤ every price that has traded today, so
 * `price <= invalidation` could never be true on a live tape: the EXIT-on-
 * invalidation rung, a SAFETY rung, was unreachable except when the candle feed
 * was a day stale, which is exactly backwards. Worse, the "abandon it" price
 * rendered on the card walked down with price every day, so the level a user
 * wrote down could never be broken. A level that moves with price is not a
 * level. One window, computed once, and the test pins both ends of it.
 *
 * THAT WAS FIXED ON THE CANDLE PATH AND LEFT STANDING ON THE SPARKLINE PATH,
 * WHICH IS THE ONE THAT REACHES THE PHONE. The fallback took its high from
 * `range7d.priorHigh` (prior six days, today excluded) and its low from
 * `range7d.low` — a minimum over the WHOLE 7-day series, today included. So the
 * invalidation equalled the current price on every row making its own 7-day low,
 * and it fired the other way round from the candle bug: not unreachable but
 * ALWAYS reachable, on a test of the series against itself. netlify/functions/
 * alt-watch.mjs passes `candles: null` on every pass, so EVERY level the
 * scheduled sentinel alerts on comes from this path, and it sent
 * "FOO invalidation hit · lost $50.00 — 7-day low from the sparkline" with
 * $50.00 the live price. Over 20,000 random 7-day tapes it fired 1,276 times and
 * on exactly the 1,276 where price was its own minimum.
 *
 * screen.js now publishes `range7d.priorLow` beside `range7d.priorHigh` — one
 * `prior` slice, two ends, today excluded — and the fallback reads that pair and
 * nothing else. `range7d.low`/`.high` remain the 7-day RANGE and are still the
 * right denominator for `pos`; they are simply not levels. A row that carries a
 * range but no `priorLow` (a hand-built object, or a blob written by an older
 * deploy) yields NO invalidation rather than the old self-referential one: the
 * level degrades to null, `invalidated` degrades to null with it, and the ladder
 * reads that as "never measured" rather than as "not broken".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COMPARISON IS CROSS-SOURCE, AND THE TOLERANCE FOR THAT IS ZERO —
 * DELIBERATELY, NOT BY OVERSIGHT.
 *
 * `screened.price` is CoinGecko's cross-exchange USD composite; these highs and
 * lows come from Binance's <SYM>USDT daily klines. The two differ by the USDT
 * peg and by one venue's spread against the composite — basis points, not
 * percent, on anything liquid enough for this board to rank. Every alternative
 * was worse:
 *   - Comparing like against like would mean testing the last candle CLOSE
 *     rather than the live price. That is a settled level against a settled
 *     level, and it is up to 24 hours old: it answers "did yesterday break out",
 *     which is not the question a directive card exists to answer.
 *   - A tolerance band on the trigger would move the break off the exact level
 *     precedent.js measured its base rates from — the drift the paragraph at the
 *     top of this block forbids, arriving through the back door.
 *   - A symmetric band would have to LOOSEN the invalidation by the same amount,
 *     and a safety rung in this file never gets looser to buy tidiness on an
 *     opportunity rung.
 * So the accepted error is that a break or a base loss can register a few basis
 * points early or late. Against a 20-day range that is a rounding error, and it
 * is strictly smaller than the error introduced by moving the level. What is NOT
 * accepted is a level drawn from the same still-forming bar as the price it is
 * compared against: that is not basis noise, it is a self-referential test, and
 * it is what the window above exists to prevent.
 *
 * Every price here is assumed to be in the SAME UNITS as `screened.price`. The
 * 1000× Binance symbols (1000PEPE, 1000SHIB) are divided back upstream by
 * applyMultiplier; if that ever stops happening, every level on this page is
 * 1000× wrong and nothing here can tell.
 */

/** Bars in the level window: the last N CLOSED daily bars, today excluded. */
const LEVEL_WINDOW = 20

function buildLevels({ screened, precedent, candles, price, stop }) {
  const bars = Array.isArray(candles) ? candles.filter((c) => c && Number.isFinite(c.h) && Number.isFinite(c.l) && Number.isFinite(c.c)) : []

  // ONE half-open slice, read by both levels. `to` is exclusive, so it stops at
  // the last closed bar and never reaches bars[len-1] — the bar still forming.
  // N closed bars therefore need N+1 bars of history, and below that BOTH levels
  // fall back together rather than one of them silently outliving the other.
  const window = bars.length >= LEVEL_WINDOW + 1
    ? { from: bars.length - (LEVEL_WINDOW + 1), to: bars.length - 1 }
    : null

  let trigger = null
  let triggerBasis = null
  if (window) {
    trigger = highestHigh(bars, window.from, window.to)
    triggerBasis = `prior ${LEVEL_WINDOW}-day high`
  } else if (Number.isFinite(screened?.range7d?.priorHigh)) {
    // The sparkline fallback: the prior six days' high out of the 7-day series.
    // A shorter, weaker level than the 20-day high — labelled so, because a user
    // reading "trigger" off the screen deserves to know which one they got.
    trigger = screened.range7d.priorHigh
    triggerBasis = 'prior 6-day high from the 7-day sparkline (no candle history)'
  }

  let invalidation = null
  let invalidationBasis = null
  if (window) {
    invalidation = lowestLow(bars, window.from, window.to)
    invalidationBasis = `${LEVEL_WINDOW}-day base low`
  } else if (Number.isFinite(screened?.range7d?.priorLow)) {
    // `priorLow`, NOT `low` — the other end of the same prior-six-day slice
    // `priorHigh` comes from, so the fallback pair excludes today exactly the way
    // the candle window does. `low` is the 7-day range's floor and includes the
    // live point; using it here made the invalidation equal the price. See the
    // block above.
    invalidation = screened.range7d.priorLow
    invalidationBasis = 'prior 6-day low from the 7-day sparkline (no candle history)'
  }

  const entry = Number.isFinite(price) && Number.isFinite(trigger) && price > trigger ? price : (trigger ?? price ?? null)

  return {
    entry: fin(entry), trigger: fin(trigger), stop: fin(stop), invalidation: fin(invalidation),
    triggerBasis, invalidationBasis,
    // THE LEVEL TESTS SHIP WITH THE LEVELS. Both are published because more than
    // one consumer asks "did it break" — the ladder above, and the scheduled
    // sentinel in netlify/functions/alt-watch.mjs, which alerts on the EDGES of
    // exactly these two booleans. A second implementation of the comparison is a
    // second answer, and the day they disagree the phone says a trigger fired
    // while the card the user opens says ARM.
    triggerLive: sideTest(price, trigger, 'above'),
    invalidated: sideTest(price, invalidation, 'below'),
    targets: buildTargets(precedent, entry),
  }
}

/**
 * A level test with THREE outcomes, not two.
 *
 * `null` is not `false`: it means the level or the price was never measured (no
 * candles and no sparkline, or a row that arrived without a price). A consumer
 * watching for a transition needs that distinction — unknown → true is a first
 * measurement, not a break, and alerting on it fires on the day the data showed
 * up rather than on the day price moved.
 *
 * The comparisons are strict-above for the trigger and at-or-below for the
 * invalidation, matching the ladder's own reading of each: a break has to CLEAR
 * the level, and a base low is lost by trading AT it.
 */
function sideTest(price, level, dir) {
  if (!Number.isFinite(price) || !Number.isFinite(level)) return null
  return dir === 'above' ? price > level : price <= level
}

/**
 * Targets come from MEASURED forward returns or they do not exist.
 *
 * There is no round-number target here, no Fibonacci extension and no "next
 * resistance" invented from a chart. If precedent.js could not find at least
 * three comparable episodes it returns ok:false, and this returns an empty
 * array — the guardrail then says there is no base rate behind any number on the
 * card. A target with no sample behind it is the most confidently-read wrong
 * number a trading screen can print.
 *
 * The worst 21-day outcome in the same sample rides along in every basis string,
 * because a median shown without its downside is survivorship wearing a decimal
 * point.
 */
function buildTargets(precedent, entry) {
  if (!precedent?.ok || !precedent.baseRates || !Number.isFinite(entry) || entry <= 0) return []
  const br = precedent.baseRates
  const n = Number.isFinite(precedent.episodes) ? precedent.episodes : null
  const worst = Number.isFinite(br.worstFwd21) ? `; worst 21d in that sample ${signed(br.worstFwd21)}%` : ''
  const sample = n == null ? 'prior ignitions' : `${n} prior ignition${n === 1 ? '' : 's'}`
  const targets = []
  if (Number.isFinite(br.medianFwd21) && br.medianFwd21 > 0) {
    targets.push({
      label: '21-day median', price: fin(entry * (1 + br.medianFwd21 / 100)),
      basis: `median 21-day return after ${sample} was ${signed(br.medianFwd21)}%${worst}`,
    })
  }
  if (Number.isFinite(br.medianFwd60) && br.medianFwd60 > 0) {
    targets.push({
      label: '60-day median', price: fin(entry * (1 + br.medianFwd60 / 100)),
      basis: `median 60-day return after ${sample} was ${signed(br.medianFwd60)}%${worst}`,
    })
  }
  return targets
}

/* ══ inputs that are absent vs inputs that are broken ═══════════════════════ */

/**
 * Normalise whatever the caller wired up into [[name, state], ...].
 *
 * Accepts the documented `{ scan: {state}, coin: {state} }`, any other map of
 * named freshness results, or a single `{ state }`. An EMPTY or missing map
 * resolves to one dead feed — the same default advice.js takes for its quote,
 * and for the same reason: a caller that has not wired the freshness ladder yet
 * must not be rewarded with an ENTER on data of unknown age.
 */
function feedStates(freshness) {
  if (!freshness || typeof freshness !== 'object') return [['data', 'dead']]
  if (typeof freshness.state === 'string') return [['data', freshness.state]]
  const entries = Object.entries(freshness)
    .filter(([, v]) => v && typeof v === 'object' && typeof v.state === 'string')
    .map(([k, v]) => [k, v.state])
  return entries.length > 0 ? entries : [['data', 'dead']]
}

/**
 * Close-only candles are DETECTED, not trusted to arrive labelled.
 *
 * parseCoinGeckoMarketChart emits `{ t, o: c, h: c, l: c, c, v }` — every bar
 * flat — and the `quality` flag has to survive four hops (fetcher → function →
 * API response → component) before it reaches this file, while the bars
 * themselves arrive here directly. Twenty consecutive bars with no range at all
 * is not something a real OHLC feed produces; a coin that genuinely did not
 * move for twenty days is excluded from the board as a stablecoin long before
 * it gets here.
 */
function detectQuality(candles) {
  if (!Array.isArray(candles) || candles.length < 20) return null
  const tail = candles.slice(-20)
  const flat = tail.every((c) => c && Number.isFinite(c.h) && Number.isFinite(c.l) && c.h === c.l)
  return flat ? 'close-only' : 'ohlcv'
}

/**
 * THE TAPE IS HOSTILE — and there are two ways to know that, because season.js
 * now publishes a BAND as well as a phase.
 *
 * The first is the phase it named: `risk_off` or `btc_only`. That is the case
 * this rung was written for and it is unchanged.
 *
 * The second is new, and it is a hole this file had. season.js only names a
 * phase when its `bounds` — the same market with every unread gauge at zero
 * (`low`) and with every one of them at its max (`high`) — fall inside a single
 * rung. When they straddle a boundary it publishes `phase: 'unknown'` and lets
 * the number stand, because naming either side would be a claim it cannot make.
 * But a band can straddle a boundary and still be hostile at BOTH ENDS: measured
 * on a real read — 20% breadth, dominance rising, ETH losing both legs, fear &
 * greed 429ing — `seasonRead` returned score 13, `bounds {low: 12, high: 22}`,
 * label "Risk off to BTC only", `phase: 'unknown'`. Every point of that band is a
 * tape alt risk is fighting; the fully measured read of that market is hostile
 * whatever the unread gauge turns out to say. Yet `phase === 'unknown'` sent it
 * down the unmeasured path and a live break bought a HALF SIZE into it, while the
 * same market with fear & greed answering got the veto. Less information, more
 * risk taken. So the veto is keyed on the band where the band settles it, which
 * is exactly what season.js published `bounds` for.
 *
 * THE 40 IS A DUPLICATED CONSTANT AND IT IS DELIBERATE, LIKE THE LEVEL
 * ARITHMETIC AT THE BOTTOM OF THIS FILE. This module imports nothing (contract),
 * so it cannot read season.js's ladder — it already duplicates the two phase IDs
 * above for the same reason. `HOSTILE_CEILING` is the bottom of `btc_leads`, the
 * first rung on which this file will act: `high < 40` means the complete read
 * lands in `btc_only` or `risk_off` however the missing gauges fall. The coupling
 * is held by a test that drives the REAL seasonRead through this gate rather than
 * a hand-built season object, so moving that boundary one file over turns this
 * file's tests red instead of quietly widening what ENTER will buy into.
 */
const HOSTILE_CEILING = 40

function hostileSeason(season) {
  if (season?.phase === 'risk_off' || season?.phase === 'btc_only') return true
  const high = season?.bounds?.high
  return Number.isFinite(high) && high < HOSTILE_CEILING
}

/** True only when the veto above came from the BAND rather than from a named
 *  phase — so the rung can say which of the two it is standing down on. */
function bandHostile(season) {
  return season?.phase !== 'risk_off' && season?.phase !== 'btc_only' && hostileSeason(season)
}

/** The band, spelled out, for the rung that vetoed on it. Every number in it is
 *  a field season.js published; nothing here is re-derived. */
function seasonBandVetoText(season) {
  const { low, high } = season?.bounds ?? {}
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null
  return `no regime was named — but the ${high - low} unread point${high - low === 1 ? '' : 's'} put the fully measured read of this same market between ${low} and ${high} out of 100, and every point of that band is a tape alt risk is fighting`
}

/**
 * THE REGIME WAS NOT NAMED — which is a third state, not a synonym for either of
 * the two above, and the ladder has to say which of them it is treated as.
 *
 * season.js reports `phase: 'unknown'` in THREE cases now, and this file has to
 * consume all three without asserting anything about which one it got:
 *
 *   NO_READ  breadth could not be counted at all. `score: null`, no bounds.
 *   THIN     under half the 100 points had an input, so no score is published
 *            (`score: null`) — the day-one state of a fresh deploy, because the
 *            dominance trend needs seven days of history the alt-watch cron has
 *            not accumulated yet.
 *   SPAN     the score STANDS — real arithmetic over the parts that answered,
 *            and it can be a high number — but the unread points put the fully
 *            measured read on both sides of a rung boundary, so no regime is
 *            named off it. `bounds` says where the two ends land.
 *
 * SPAN is the one that walked straight through this gate, and it is the common
 * one: on day one BOTH breadth windows resolve, so `of` is 60 of 100 and the
 * score is published. `hostileSeason` is false for 'unknown', so at the ENTER
 * rung a regime nobody could name was indistinguishable from a measured
 * `majors_rotating` — reproduced through the real seasonRead at 80% day-one
 * breadth: `score 80, bounds {48, 88}, label "BTC leads to Alt season"`, and a
 * full-size ENTER off it. An absent input was being scored as a friendly tape,
 * which is the exact failure season.js was rewritten one file over to stop
 * committing.
 *
 * So it is deliberately NEITHER:
 *   - NOT a green light. It joins the `missing` list at the ENTER gate, so the
 *     break downgrades to the half-size STARTER with the reason printed on the
 *     card, and a guardrail names it on every other rung.
 *   - NOT a permanent block. Vetoing on it the way `hostileSeason` vetoes would
 *     make ENTER unreachable for the first week of every deploy's life, and for
 *     any scan where fear & greed happens to 404 — and it would hand a feed
 *     outage the same veto a measured `risk_off` tape gets, which is the mirror
 *     of the original bug: treating an unread gauge as evidence.
 * This is the treatment LATE_PHASES already gets, for the same stated reason —
 * a downgrade is what you apply when the input is a judgement or an absence
 * rather than a measurement.
 *
 * ARM IS LEFT ALONE, DELIBERATELY. `armable` still only excludes a HOSTILE
 * regime, so an unmeasured one still arms. ARM takes no risk today — it names
 * the level and says do not front-run it — and blocking it would be the
 * permanent block this whole note rejects, on the one rung whose entire job is
 * to wait. It carries the guardrail like every other rung, which is this file's
 * stated division of labour: a guardrail never changes the action, it makes the
 * action legible. The one loose end is that ARM quotes the full sized plan while
 * the trigger firing on that same unmeasured regime will come back STARTER at
 * half of it — the guardrail is what tells the reader that, and it is on the
 * card before the trigger ever fires.
 */
function unmeasuredSeason(season) {
  return !season || season.phase === 'unknown' || season.score == null
}

/**
 * WHY the regime has no name — in season.js's own arithmetic, and only ever the
 * reason that actually applies.
 *
 * This shipped as one sentence for all three refusals: "only ${of} of its 100
 * points had an input, too little to name a phase off". On the SPAN case that is
 * a false statement of fact wearing a real number. Measured: a read with `of: 90`
 * and a published score of 13 printed "only 90 of its 100 points had an input,
 * too little to name a phase off" — 90% coverage, a score published off it, and
 * "too little" is not remotely why the phase was refused. The card said a
 * measurement was missing while the card above it rendered the measurement.
 *
 * So each branch states its own shortfall, out of fields season.js publishes —
 * `measured.of`, `score`, `bounds`, `label`. Nothing here is re-derived, and the
 * unread-point count is `high − low` rather than `100 − of`: the same number by
 * season.js's construction, but read off the two numbers being quoted rather
 * than off an assumption about its denominator.
 */
function seasonUnmeasuredText(season) {
  const of = Number.isFinite(season?.measured?.of) && season.measured.of > 0 ? season.measured.of : null
  const { low, high } = season?.bounds ?? {}
  const banded = Number.isFinite(low) && Number.isFinite(high) && high > low
  const span = banded ? `the ${high - low} nobody could read put the full read anywhere from ${low} to ${high} out of 100` : null

  if (of == null) return 'the regime was not measured — no rotation read came back at all, so this setup has a tape behind it that nobody has read'
  if (!Number.isFinite(season?.score)) {
    return `the regime was not measured — only ${of} of its 100 points had an input, under the half a regime score needs${span ? `, and ${span}` : ''}, so this setup has a tape behind it that nobody has read`
  }
  return `the regime was not named — ${of} of its 100 points had an input and score ${season.score}/100, but ${span ?? 'the rest went unread'}${season?.label ? ` (${season.label})` : ''}, so this setup has a tape nobody has read to the end`
}

/* ══ copy helpers ═══════════════════════════════════════════════════════════ */

function precedentLine(precedent) {
  if (!precedent?.ok || !precedent.baseRates) return null
  const br = precedent.baseRates
  const n = Number.isFinite(precedent.episodes) ? precedent.episodes : '—'
  const match = Number.isFinite(precedent.matchPct) ? `, today matches the pre-ignition fingerprint ${Math.round(precedent.matchPct)}%` : ''
  return `${n} prior ignition${n === 1 ? '' : 's'}: median 21d ${signed(br.medianFwd21)}%, worst 21d ${signed(br.worstFwd21)}%, median drawdown during the run ${signed(br.medianMaxDDPct)}%${match}`
}

/**
 * The cycle placement, with its confidence. `confidence` is not decoration:
 * playbook.phaseOf derives it from how many of its four inputs actually
 * answered, so a 'low' here means the phase was called off one source.
 */
function phaseLine(phase) {
  if (!phase?.label || phase.id === 'unknown') return null
  return `cycle phase: ${phase.label}${phase.confidence ? ` (${phase.confidence} confidence)` : ''}`
}

function rMultiple(position, price, stop) {
  if (!position || ![position.avgEntry, price, stop].every(Number.isFinite)) return null
  const per = position.avgEntry - stop
  if (per <= 0) return null
  return (price - position.avgEntry) / per
}
function rLine(r) {
  if (!Number.isFinite(r)) return null
  return `open R: ${r >= 0 ? '+' : ''}${Math.round(r * 100) / 100}R`
}
function pnlLine(openPct) {
  if (!Number.isFinite(openPct)) return null
  return `position is ${openPct >= 0 ? 'up' : 'down'} ${Math.abs(openPct).toFixed(1)}% against the average entry`
}
function stopLine(stop, price) {
  if (!Number.isFinite(stop)) return 'no stop computed — fix this before anything else'
  return `stop ${px(stop)}${stopDistText(stop, price)}`
}
function stopDistText(stop, price) {
  if (!Number.isFinite(stop) || !Number.isFinite(price) || price <= 0) return ''
  return ` (${(((price - stop) / price) * 100).toFixed(1)}% below price)`
}
function sizingErrorText(code) {
  return {
    bad_input: 'sizing inputs incomplete',
    stop_not_below_price: 'the computed stop is not below the current price',
    below_min_ticket: 'the position the caps allow is under the minimum ticket',
    size_rounds_to_zero: 'the size rounds to zero units',
  }[code] ?? (code || 'no sizing plan available')
}

/* ══ arithmetic, inlined by contract (this file imports nothing) ════════════ */

function highestHigh(bars, from, to) {
  let hi = -Infinity
  for (let i = Math.max(0, from); i < Math.min(bars.length, to); i++) hi = Math.max(hi, bars[i].h)
  return Number.isFinite(hi) ? hi : null
}
function lowestLow(bars, from, to) {
  let lo = Infinity
  for (let i = Math.max(0, from); i < Math.min(bars.length, to); i++) lo = Math.min(lo, bars[i].l)
  return Number.isFinite(lo) ? lo : null
}
function floorSig(x, sig) {
  if (!Number.isFinite(x) || x <= 0) return 0
  const mag = Math.pow(10, sig - 1 - Math.floor(Math.log10(x)))
  if (!Number.isFinite(mag) || mag <= 0) return 0
  const out = Math.floor(x * mag) / mag
  return Number.isFinite(out) ? out : 0
}
function fin(x) { return Number.isFinite(x) ? x : null }

function signed(x, d = 1) {
  if (!Number.isFinite(x)) return '—'
  return `${x >= 0 ? '+' : ''}${x.toFixed(d)}`
}
function pct(x, d = 1) {
  if (!Number.isFinite(x)) return '—'
  return `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`
}
/** MARKET-scale money: volumes and market caps, where one significant figure of
 *  magnitude is the whole message. */
function usd(x) {
  if (!Number.isFinite(x)) return '—'
  const a = Math.abs(x)
  if (a >= 1e12) return `$${(x / 1e12).toFixed(1)}T`
  if (a >= 1e9) return `$${(x / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `$${(x / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `$${Math.round(x / 1e3).toLocaleString('en-US')}k`
  return `$${Math.round(x * 100) / 100}`
}
/**
 * ACCOUNT-scale money: the notional, the risk, the minimum ticket. Kept separate
 * from usd() because "$1k" is a fine way to describe a day's volume and a
 * useless way to describe the position you are about to place — a size rounded
 * to the nearest thousand is not a size, and the difference between $1,320 and
 * $1,000 of risk-bearing notional is the whole point of the sizer.
 */
function money(x) {
  if (!Number.isFinite(x)) return '—'
  const a = Math.abs(x)
  if (a >= 1e6) return `$${(x / 1e6).toFixed(2)}M`
  if (a >= 100) return `$${Math.round(x).toLocaleString('en-US')}`
  return `$${Math.round(x * 100) / 100}`
}
/** Fractional unit counts: 6 significant digits, trailing zeros stripped. */
function units(x) {
  if (!Number.isFinite(x)) return '—'
  if (x === 0) return '0'
  const a = Math.abs(x)
  if (a >= 1000) return Math.round(x).toLocaleString('en-US')
  return String(Number(x.toPrecision(6)))
}
function px(x) {
  if (!Number.isFinite(x)) return '—'
  const a = Math.abs(x)
  if (a >= 1000) return `$${Math.round(x).toLocaleString('en-US')}`
  if (a >= 1) return `$${(Math.round(x * 100) / 100).toFixed(2)}`
  if (a === 0) return '$0'
  return `$${x.toPrecision(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`
}
