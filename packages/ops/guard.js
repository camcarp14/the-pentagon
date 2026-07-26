// ═══════════════════════════════════════════════════════════════════════════
// @cc/ops — THE CONTAINMENT LAYER. Nothing autonomous runs before this exists.
//
// This file is the single decision point that every autonomous action in The
// Pentagon must pass through. It is deliberately PURE: no database, no fetch, no
// Date.now(). It takes the current control state and a clock, and returns a
// verdict. The I/O half (reading control, writing the audit log) lives in
// runtime.js and is thin on purpose, because everything worth getting right is
// here and testable.
//
// WHY PURE MATTERS BEYOND TESTABILITY. The bar for this system includes a
// 14-day simulated run with zero missed actions and zero double-sends. You
// cannot simulate 14 days against code that calls Date.now() internally — you
// would have to wait 14 days. Every time-dependent decision in this file takes
// `now` as a parameter. That is not a style preference; it is what makes the
// bar reachable.
//
// THE TIER LADDER (from the autonomy doctrine):
//   0  read / monitor / classify / draft / prepare — full autonomy, no notify.
//      Still inside the budget cap: "aggressive" is not "unbounded".
//   1  reversible, internal-only writes — autonomous, logged, notify after.
//      Requires an undo descriptor; an action that cannot be undone is not T1.
//   2  anything a customer/creator/client sees, anything that moves money,
//      anything touching a live storefront or ad account — PREPARED
//      autonomously, executed only after human approval.
//   3  pricing, refunds above threshold, tax/entity/legal, bulk ad-account
//      changes, ending a relationship, personal finances — NEVER automated.
//      May be recommended. May never be executed by this system.
//
// UNKNOWN TIER IS TIER 3. The doctrine says an uncertain action goes one tier
// stricter; the strictest reading of "I don't know what this is" is "do not do
// it". A typo in a tier constant must fail closed, not default to autonomous.
// ═══════════════════════════════════════════════════════════════════════════

export const TIER = Object.freeze({
  READ: 0,
  REVERSIBLE: 1,
  APPROVAL: 2,
  NEVER: 3,
});

/** Verdict modes. `prepare` means: do the work, write the artifact, do NOT act. */
export const MODE = Object.freeze({
  EXECUTE: "execute",
  DRY_RUN: "dry_run",
  PREPARE: "prepare",
  BLOCKED: "blocked",
});

/** Why an action was stopped. These strings are written to the audit log and
 *  shown verbatim in the UI — a blocked action must always be able to say which
 *  specific guard stopped it, never just "blocked". */
export const BLOCK = Object.freeze({
  KILL_SWITCH: "global kill switch is on",
  SUBSYSTEM_OFF: "subsystem is disabled",
  TIER_NEVER: "tier 3 — never automated, recommend only",
  TIER_UNKNOWN: "unrecognised tier — failing closed",
  RATE_CAP: "hourly action cap reached",
  SPEND_CAP: "hourly spend cap reached",
  BREAKER: "circuit breaker tripped after consecutive failures",
  NO_UNDO: "tier 1 action supplied no undo descriptor",
  PAUSED: "subsystem was paused",
});

const DEFAULT_CONTROL = Object.freeze({
  enabled: false,        // opt-in, never opt-out
  dryRun: true,          // everything ships in dry-run first
  maxActionsPerHour: 60,
  maxSpendUsdPerHour: 1,
  consecutiveFailureLimit: 3,
  pausedReason: null,
});

/**
 * Merge an override onto the defaults, IGNORING undefined and null.
 *
 * This exists because `{ ...DEFAULT_CONTROL, ...override }` does not do what it
 * looks like it does: object spread copies own properties that are explicitly
 * `undefined`, so `{...{enabled:false}, ...{enabled:undefined}}` is
 * `{enabled: undefined}` — the default is destroyed, not preserved. The I/O
 * layer maps every column unconditionally, so a subsystem with NO control row
 * produced exactly that shape and defeated both fail-closed defaults at once:
 * `enabled` stopped being `false` and `dryRun` stopped being `true`. A missing
 * row meant full autonomy.
 *
 * Iterating the DEFAULT keys (rather than the override's) also means an
 * unexpected key in the override — including an own `__proto__` — cannot enter
 * the merged object at all.
 */
function merge(base, override) {
  const out = { ...base };
  if (!override || typeof override !== "object") return out;
  for (const k of Object.keys(base)) {
    const v = override[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * The one decision. Returns a verdict; never throws, never mutates its inputs.
 *
 * @param {object}  a
 * @param {number}  a.tier                 TIER.*
 * @param {object}  a.global               control row for 'global' (kill switch)
 * @param {object}  a.subsystem            control row for this subsystem
 * @param {number}  a.actionsThisHour      count already taken in the window
 * @param {number}  a.spendUsdThisHour     $ already spent in the window
 * @param {number}  a.consecutiveFailures  failures since the last success
 * @param {number}  a.costUsd              estimated cost of THIS action
 * @param {boolean} a.hasUndo              whether an undo descriptor was supplied
 * @param {number}  a.now                  epoch ms — INJECTED, never read here
 * @returns {{mode: string, allow: boolean, blockedBy: string|null, reason: string, notify: boolean}}
 */
export function decide({
  tier,
  global: g = {},
  subsystem: s = {},
  actionsThisHour = 0,
  spendUsdThisHour = 0,
  consecutiveFailures = 0,
  costUsd = 0,
  hasUndo = false,
  now = 0,
} = {}) {
  const ctl = merge(DEFAULT_CONTROL, s);
  const glo = merge(DEFAULT_CONTROL, g);

  // Caps are the STRICTER of global and subsystem. The global row used to hold
  // caps that nothing read, so lowering the global ceiling changed nothing and
  // any subsystem could set its own arbitrarily high with nothing above it.
  const capActions = Math.min(num(glo.maxActionsPerHour, 60), num(ctl.maxActionsPerHour, 60));
  const capSpend = Math.min(num(glo.maxSpendUsdPerHour, 1), num(ctl.maxSpendUsdPerHour, 1));

  // ── Order matters. The checks that can never be overridden come first, so a
  // blocked verdict always names the MOST fundamental reason rather than
  // whichever guard happened to be evaluated first.

  // 1. Tier 3 and unknown tiers are refused before anything else is consulted.
  //    Not even the kill switch being off can permit them — that is the point.
  if (tier === TIER.NEVER) return block(BLOCK.TIER_NEVER, { recommendOnly: true });
  if (![TIER.READ, TIER.REVERSIBLE, TIER.APPROVAL].includes(tier)) {
    return block(BLOCK.TIER_UNKNOWN);
  }

  // 2. Global kill switch. One toggle halts everything, immediately, no deploy.
  //    `!== true`, NOT `=== false`. Only an explicit true arms it; undefined,
  //    null, 0, "" and even the string "false" all halt. The previous
  //    `=== false` armed autonomy for every one of those, which turned any
  //    row-shape drift — a renamed column, a narrowed select — into a silently
  //    disabled kill switch.
  if (glo.enabled !== true) return block(BLOCK.KILL_SWITCH);

  // 3. Subsystem enable + explicit pause. Same rule, same reason.
  if (ctl.enabled !== true) return block(BLOCK.SUBSYSTEM_OFF);
  if (ctl.pausedReason) return block(`${BLOCK.PAUSED}: ${ctl.pausedReason}`);

  // 4. Circuit breaker. A subsystem failing repeatedly stops itself rather than
  //    hammering a broken dependency N times an hour.
  if (consecutiveFailures >= num(ctl.consecutiveFailureLimit, 3)) {
    return block(BLOCK.BREAKER);
  }

  // 5. Caps. Checked INCLUSIVE of this action's own cost: an action that would
  //    cross the ceiling is refused, never half-taken. Tier 0 is subject to the
  //    spend cap too — drafting is autonomous but it is not free, and "be
  //    aggressive at tier 0" must not mean "spend without a ceiling".
  //
  //    BOTH operands are coerced, not just the cap. Coercing only the cap left
  //    the counter free to arrive as NaN, and `NaN >= 60` is false, so a NaN
  //    action count sailed past the rate limit. A negative cost is clamped to 0
  //    for the same reason in reverse: it could otherwise pull the projection
  //    back under the ceiling and carry an action through.
  if (num(actionsThisHour, Infinity) >= capActions) return block(BLOCK.RATE_CAP);
  const cost = Math.max(0, num(costUsd, Infinity));
  const projected = Math.max(0, num(spendUsdThisHour, Infinity)) + cost;
  if (projected > capSpend) return block(BLOCK.SPEND_CAP);

  // 6. Tier 2 never executes here regardless of settings — it prepares an
  //    artifact and stops. Approval is a human action taken elsewhere, so there
  //    is no flag on this path that can turn a tier 2 into an execution.
  if (tier === TIER.APPROVAL) {
    return {
      mode: MODE.PREPARE, allow: true, blockedBy: null, notify: false,
      reason: "prepared for approval — execution requires a human",
    };
  }

  // 7. Tier 1 must be undoable. An irreversible action is not tier 1 by
  //    definition, so a missing undo descriptor is a bug in the caller and is
  //    refused rather than silently downgraded.
  if (tier === TIER.REVERSIBLE && !hasUndo) return block(BLOCK.NO_UNDO);

  // 8. Dry run: allowed to run, forbidden to act. Every tier 1+ automation
  //    lives here for a period before it is trusted with the real thing.
  //    `!== false`, so only an explicit false leaves dry-run — anything missing
  //    or malformed keeps the safe behaviour rather than losing it.
  if (ctl.dryRun !== false) {
    return {
      mode: MODE.DRY_RUN, allow: true, blockedBy: null, notify: false,
      reason: "dry run — would have acted, changed nothing",
    };
  }

  return {
    mode: MODE.EXECUTE, allow: true, blockedBy: null,
    // Tier 0 is silent by doctrine; tier 1 notifies after the fact.
    notify: tier === TIER.REVERSIBLE,
    reason: "within every guard",
  };
}

function block(blockedBy, extra = {}) {
  return { mode: MODE.BLOCKED, allow: false, blockedBy, reason: blockedBy, notify: false, ...extra };
}

/** Coerce to a usable number. A NaN cap compared with `>=` is always false,
 *  which silently disables the cap — the same class of bug that made the
 *  pricing table dangerous. Anything non-finite falls back to the default. */
function num(v, fallback) {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Rolling-window helper for the caps above. Pure, and `now` is injected so a
 * simulated run can advance the clock without waiting.
 * @param {Array<{at:number, costUsd?:number}>} entries
 */
export function usageInWindow(entries = [], now = 0, windowMs = 3600_000) {
  const since = now - windowMs;
  let actions = 0, spendUsd = 0;
  for (const e of entries) {
    const at = typeof e?.at === "number" ? e.at : Date.parse(e?.at ?? "");
    if (!Number.isFinite(at) || at < since || at > now) continue;
    actions += 1;
    const c = num(e.costUsd, 0);
    spendUsd += c > 0 ? c : 0;
  }
  return { actions, spendUsd };
}

/** Consecutive failures counted back from the newest entry. Feeds the breaker. */
export function consecutiveFailures(entries = []) {
  let n = 0;
  for (const e of entries) {
    if (e?.ok === false) n += 1;
    else break;
  }
  return n;
}
