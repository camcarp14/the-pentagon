// ALT SIZING — the same R discipline as risk.js, with the three corrections an
// altcoin actually needs. Pure, imports nothing, returns error codes, never
// throws: these run inside a render and a throw here blanks the tab.
//
// THE LIQUIDITY CAP IS THE POINT OF THIS FILE.
//
// A 2% position in something that trades $400k a day is not a 2% position. It is
// a 2% position on the way in and an unknown fraction of it on the way out,
// because the day you need to sell is the day everyone else does and the book is
// four figures deep. So the notional is capped at a fraction of ACTUAL DAILY
// VOLUME (maxAdvPct: 0.5% for a major down to 0.1% for a micro), and that cap
// binds before the equity cap on almost every small coin the board surfaces.
// It is the reason this tab exists rather than a percentage tacked onto risk.js.
//
// MEME TIER GETS A WIDER STOP AND A SMALLER MAX POSITION. Both directions of
// that are deliberate and they are not symmetric knobs: the wider stop is about
// NOISE (a 4×ATR stop on a coin that routinely does ±25% intraday is still
// inside the day's range), and the smaller position is about the fact that a
// wider stop with the same position size is simply more money at risk. Utility
// tier gets the reverse for the mirror-image reason.
//
// FRACTIONAL UNITS, unlike risk.js's whole shares. A share of MSTR is indivisible
// and 0.4 of one is a rounding error; 0.4 of an ETH is a real order. So the size
// is rounded DOWN to six significant digits — down, always, so the risk budget
// is never rounded through — and a ticket smaller than `minTicketUsd` is a NAMED
// REJECTION rather than a position of 0.0000001 units that no exchange will fill
// and no user will notice is meaningless.

/* ══ tier defaults ══════════════════════════════════════════════════════════
 *
 * The base table, by market-cap tier. Every number is a rule of thumb, in those
 * words — there is no backtest behind them and pretending otherwise would be the
 * same lie the base rates in precedent.js refuse to tell. What IS defensible is
 * the ORDERING: everything gets more permissive as the coin gets bigger, and
 * every column moves in the same direction, so a micro cap can never end up with
 * a tighter stop AND a bigger position than a major.
 *
 *   atrMult         stop distance in ATRs — wider as the coin gets noisier
 *   maxPositionPct  hard ceiling on notional as a % of equity
 *   maxAdvPct       hard ceiling on notional as a % of 24h volume  ← the cap
 *   riskFraction    multiplier the CALLER applies to its own riskPct before
 *                   calling altSize (see the note on altSize) — the risk unit
 *                   for a micro cap is not the risk unit for a major
 *   stopFloorPct    a stop tighter than this is inside the noise; altStop widens
 *                   to it when the caller passes it
 */
const TIERS = {
  major: { atrMult: 2.5, maxPositionPct: 8, maxAdvPct: 0.5, riskFraction: 1, stopFloorPct: 8 },
  mid: { atrMult: 3, maxPositionPct: 5, maxAdvPct: 0.35, riskFraction: 0.8, stopFloorPct: 12 },
  small: { atrMult: 3.5, maxPositionPct: 3, maxAdvPct: 0.2, riskFraction: 0.6, stopFloorPct: 18 },
  micro: { atrMult: 4, maxPositionPct: 1.5, maxAdvPct: 0.1, riskFraction: 0.4, stopFloorPct: 25 },
}

/*
 * The kind adjustment, applied on top of the tier.
 *
 * 'unknown' takes the tier default and NOT the utility widening. The utility
 * bonus is a reward for knowing what the thing is; a coin we could not classify
 * is not a utility coin, it is an unclassified one, and granting it a bigger
 * position for that would make "we could not read the categories feed" a reason
 * to size up.
 */
const KINDS = {
  meme: { atrMult: 1.2, maxPositionPct: 0.6, maxAdvPct: 1, riskFraction: 0.8, stopFloorPct: 1.35 },
  utility: { atrMult: 0.9, maxPositionPct: 1.2, maxAdvPct: 1, riskFraction: 1, stopFloorPct: 0.85 },
  unknown: { atrMult: 1, maxPositionPct: 1, maxAdvPct: 1, riskFraction: 1, stopFloorPct: 1 },
}

/**
 * Sizing defaults for one coin.
 *
 * An unrecognised or missing tier resolves to `micro`, not to a middle value.
 * A market cap we could not read is not evidence of a large one, and the failure
 * mode of guessing high here is a full-size position in something unsellable.
 */
export function tierDefaults(tier, kind) {
  const base = TIERS[tier] ?? TIERS.micro
  const adj = KINDS[kind] ?? KINDS.unknown
  return {
    atrMult: round(base.atrMult * adj.atrMult, 2),
    maxPositionPct: round(base.maxPositionPct * adj.maxPositionPct, 2),
    maxAdvPct: round(base.maxAdvPct * adj.maxAdvPct, 3),
    riskFraction: round(base.riskFraction * adj.riskFraction, 2),
    stopFloorPct: round(base.stopFloorPct * adj.stopFloorPct, 1),
    tier: TIERS[tier] ? tier : 'micro',
    kind: KINDS[kind] ? kind : 'unknown',
  }
}

/**
 * The initial stop, in the same three modes as risk.js's `initialStop` — and
 * with the same contract: a failure returns `stop: null` plus a `warning` code
 * and never a number the caller has to sanity-check.
 *
 * `stopFloorPct` is OPTIONAL and off by default, so the seven fields the build
 * contract names behave exactly as written. Pass `tierDefaults().stopFloorPct`
 * and a stop tighter than the floor is widened to it, with the widening stated
 * in `detail` and flagged by `floored`. That is not a safety rail, it is a noise
 * rail: a 6%-away stop on a micro cap whose median daily range is 14% is not a
 * tight stop, it is a coin flip you pay a spread for.
 *
 * @returns { stop, basis, detail, warning, floored }
 */
export function altStop({ mode, price, atr, atrMult = 3, swingLow, pct = 20, padAtr = 0.5, stopFloorPct = null } = {}) {
  const out = (stop, detail, warning = null, floored = false) => ({ stop, basis: mode ?? null, detail, warning, floored })
  if (!Number.isFinite(price) || price <= 0) return out(null, 'no price', 'bad_input')

  let stop = null
  let detail = ''
  if (mode === 'atr') {
    if (!Number.isFinite(atr) || atr <= 0) return out(null, 'ATR unavailable', 'no_atr')
    if (!Number.isFinite(atrMult) || atrMult <= 0) return out(null, 'bad ATR multiple', 'bad_input')
    stop = price - atrMult * atr
    detail = `${round(atrMult, 2)}×ATR(${px(atr)}) below ${px(price)}`
  } else if (mode === 'structure') {
    if (!Number.isFinite(swingLow) || !Number.isFinite(atr) || atr <= 0) return out(null, 'no confirmed swing low / ATR', 'no_structure')
    stop = swingLow - padAtr * atr
    detail = `swing low ${px(swingLow)} minus ${round(padAtr, 2)}×ATR pad`
  } else if (mode === 'percent') {
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return out(null, 'bad percent', 'bad_input')
    stop = price * (1 - pct / 100)
    detail = `${round(pct, 1)}% below ${px(price)}`
  } else {
    return out(null, `unknown mode ${mode}`, 'bad_input')
  }

  // The noise floor, when the caller asked for one.
  let floored = false
  if (Number.isFinite(stopFloorPct) && stopFloorPct > 0 && stopFloorPct < 100) {
    const floorStop = price * (1 - stopFloorPct / 100)
    if (stop > floorStop) {
      detail = `${detail}, widened to the ${round(stopFloorPct, 1)}% tier floor (the raw stop sat inside this coin's own noise)`
      stop = floorStop
      floored = true
    }
  }

  if (stop >= price) return out(null, detail, 'stop_not_below_price', floored)
  // risk.js earned this guard on MSTR, where it took an extreme ATR to produce a
  // stop at or below zero. Here it is ROUTINE: 4×ATR on a micro cap whose daily
  // true range is a quarter of its price is a negative number every single time,
  // and a negative stop prices a per-unit risk larger than the coin, which sizes
  // the position to a fraction of what the budget allows and prints "stop −0.004"
  // as a level to work from.
  if (!(stop > 0)) return out(null, detail, 'stop_below_zero', floored)
  return out(stop, detail, null, floored)
}

const SIG_DIGITS = 6
const DEFAULT_MIN_TICKET_USD = 25

/**
 * Units to buy, under three simultaneous ceilings: the risk budget, the equity
 * cap, and the liquidity cap. The smallest wins, and `capped` names which one it
 * was.
 *
 * ON `riskPct`: pass the ALREADY-SCALED number. `tierDefaults().riskFraction` is
 * applied by the caller (`riskPct: settings.riskPct * defaults.riskFraction`)
 * rather than in here, so that one function owns one ceiling each and the
 * settings screen can show the user the risk they actually asked for beside the
 * risk this coin's tier will take.
 *
 * ON `capped`: it always names the BINDING constraint, including 'risk' for the
 * healthy uncapped case, and is null only when nothing was sized. A value the
 * contract lists but the code can never produce is a bug waiting for a reader —
 * see the note at the top of window.js about the leverage grade that could never
 * fire. The flag a "CAPPED" badge should read is `reduced`, which is true only
 * when a cap actually cut the size below what the risk budget asked for.
 *
 * @returns { ok, error, units, notional, riskUsd, positionPct, advPct, capped, reduced, ... }
 */
export function altSize({
  equity, riskPct, price, stop, vol24h = null,
  maxPositionPct = 5, maxAdvPct = 0.25, minTicketUsd = DEFAULT_MIN_TICKET_USD,
} = {}) {
  const bad = (error) => ({
    ok: false, error, units: 0, notional: null, riskUsd: null, perUnitRisk: null,
    positionPct: null, advPct: null, capped: null, reduced: false,
    liquidityUnknown: false, caps: null, minTicketUsd: Number.isFinite(minTicketUsd) ? minTicketUsd : null,
  })

  if (![equity, riskPct, price, stop, maxPositionPct, maxAdvPct].every(Number.isFinite)) return bad('bad_input')
  if (equity <= 0 || riskPct <= 0 || price <= 0 || maxPositionPct <= 0 || maxAdvPct <= 0) return bad('bad_input')
  if (!Number.isFinite(minTicketUsd) || minTicketUsd < 0) return bad('bad_input')

  const perUnitRisk = price - stop
  if (perUnitRisk <= 0) return bad('stop_not_below_price')

  const riskNotional = (equity * (riskPct / 100) / perUnitRisk) * price
  const positionCapUsd = equity * (maxPositionPct / 100)

  // A missing 24h volume does NOT silently disable the cap this file exists for.
  // It sizes, because refusing to size a coin whose volume field failed would
  // black out the whole panel, but it says so in `liquidityUnknown` so the
  // directive can raise the guardrail and the user is never told a position is
  // exitable when nobody checked.
  const hasVol = Number.isFinite(vol24h) && vol24h > 0
  const liquidityCapUsd = hasVol ? vol24h * (maxAdvPct / 100) : Infinity

  // Reported to the cent, because these three numbers are shown side by side and
  // `$5000.000000000001` beside `$400` reads as a bug in the page. The RAW
  // values are what `capped` compares against below — rounding first would let
  // two caps a hundredth of a cent apart tie and pick the wrong explanation.
  const caps = {
    risk: round(riskNotional, 2),
    position: round(positionCapUsd, 2),
    liquidity: hasVol ? round(liquidityCapUsd, 2) : null,
  }
  let notional = Math.min(riskNotional, positionCapUsd, liquidityCapUsd)

  // Compared against the RAW values, not the rounded `caps` — the min() came
  // from these, so exactly one of them equals it. Ties resolve toward the SAFETY
  // explanation: when the risk budget and a cap land on the same notional,
  // "capped by liquidity" is the more useful sentence, because it is the one
  // that says why a bigger position is not available at ANY risk setting.
  const capped = notional === liquidityCapUsd ? 'liquidity'
    : notional === positionCapUsd ? 'position'
      : 'risk'
  const reduced = capped !== 'risk'

  if (!(notional > 0)) return { ...bad('size_rounds_to_zero'), caps }

  // Round DOWN to six significant digits: down so the risk budget is never
  // rounded through, six because that is the resolution at which a $0.0000041
  // coin still has a meaningful unit count and a $96,000 coin still has cents.
  const units = floorSig(notional / price, SIG_DIGITS)
  if (!(units > 0)) return { ...bad('size_rounds_to_zero'), caps }

  notional = units * price
  if (notional < minTicketUsd) {
    // Named, not silent. The alternative is a filled-in ticket for 0.0000012
    // units that no exchange accepts and that looks, on screen, exactly like a
    // real plan. The notional it WOULD have been is reported alongside the
    // error, because "the ticket is $4 against a $25 minimum" is actionable and
    // "too small" is not.
    return { ...bad('below_min_ticket'), caps, capped, notional: round(notional, 2), liquidityUnknown: !hasVol }
  }

  return {
    ok: true,
    error: null,
    units,
    notional: round(notional, 2),
    riskUsd: round(units * perUnitRisk, 2),
    perUnitRisk: sig(perUnitRisk, SIG_DIGITS),
    positionPct: round((notional / equity) * 100, 3),
    advPct: hasVol ? round((notional / vol24h) * 100, 3) : null,
    capped,
    reduced,
    liquidityUnknown: !hasVol,
    caps,
    minTicketUsd,
  }
}

/* ══ local helpers — nothing imported, by contract ══════════════════════════ */

/**
 * Round DOWN to `sig` significant digits. `Math.floor(x * mag) / mag` is doing
 * the work; the exponent is derived from log10 so this holds from 1e-9 to 1e6
 * without a table. Non-positive and non-finite inputs return 0 rather than NaN,
 * because every caller here treats 0 as "no position" and NaN as a crash.
 */
function floorSig(x, sig) {
  if (!Number.isFinite(x) || x <= 0) return 0
  const mag = Math.pow(10, sig - 1 - Math.floor(Math.log10(x)))
  if (!Number.isFinite(mag) || mag <= 0) return 0
  const out = Math.floor(x * mag) / mag
  return Number.isFinite(out) ? out : 0
}

/** Nearest, for display quantities where rounding direction carries no risk. */
function sig(x, digits) {
  if (!Number.isFinite(x) || x === 0) return x
  return Number(x.toPrecision(digits))
}

function round(x, d) {
  if (!Number.isFinite(x)) return x
  const m = Math.pow(10, d)
  return Math.round(x * m) / m
}

/**
 * Sub-dollar prices get significant digits, not two decimals — "$0.00" is not a
 * price, and these strings end up inside `detail`, which is what a user reads a
 * level off. Same rule as screen.js's formatter, duplicated on purpose: this
 * file imports nothing.
 */
function px(x) {
  if (!Number.isFinite(x)) return '—'
  const a = Math.abs(x)
  if (a >= 1000) return `$${Math.round(x).toLocaleString('en-US')}`
  if (a >= 1) return `$${(Math.round(x * 100) / 100).toFixed(2)}`
  if (a === 0) return '$0'
  return `$${x.toPrecision(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`
}
