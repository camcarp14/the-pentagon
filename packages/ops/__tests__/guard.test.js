import { describe, it, expect } from "vitest";
import { decide, usageInWindow, consecutiveFailures, TIER, MODE, BLOCK } from "../guard.js";

// A subsystem with every guard wide open, so each test can close exactly one and
// prove that one is what stopped the action. Starting from defaults instead
// would let a test pass for the wrong reason.
const OPEN = { enabled: true, dryRun: false, maxActionsPerHour: 60, maxSpendUsdPerHour: 10, consecutiveFailureLimit: 3 };
const ON = { enabled: true };
const ok = (over = {}) => decide({ tier: TIER.READ, global: ON, subsystem: OPEN, now: 1_000_000, ...over });

describe("fail-closed defaults", () => {
  it("refuses everything with no arguments at all", () => {
    const v = decide();
    expect(v.allow).toBe(false);
    // No config must never mean "go ahead". Tier is undefined here, so the
    // unknown-tier guard is what should catch it.
    expect(v.blockedBy).toBe(BLOCK.TIER_UNKNOWN);
  });

  it("a subsystem that was never configured is disabled, not enabled", () => {
    const v = decide({ tier: TIER.READ, global: ON, subsystem: {}, now: 1 });
    expect(v.blockedBy).toBe(BLOCK.SUBSYSTEM_OFF);
  });

  it("a configured subsystem still defaults to dry run", () => {
    const v = decide({ tier: TIER.READ, global: ON, subsystem: { enabled: true }, now: 1 });
    expect(v.mode).toBe(MODE.DRY_RUN);
  });
});

describe("the tier ladder", () => {
  it("tier 3 is refused even with every guard open and the switch on", () => {
    const v = ok({ tier: TIER.NEVER });
    expect(v.allow).toBe(false);
    expect(v.blockedBy).toBe(BLOCK.TIER_NEVER);
    expect(v.recommendOnly).toBe(true);
  });

  it("an unrecognised tier fails closed rather than defaulting to autonomous", () => {
    for (const t of [undefined, null, -1, 4, 99, "0", "read", {}, NaN]) {
      const v = ok({ tier: t });
      expect(v.allow, `tier ${String(t)} must be refused`).toBe(false);
      expect(v.blockedBy).toBe(BLOCK.TIER_UNKNOWN);
    }
  });

  it("tier 2 PREPARES and never executes, whatever the settings say", () => {
    // dryRun off, everything enabled — the most permissive configuration
    // possible. Tier 2 must still refuse to act.
    const v = ok({ tier: TIER.APPROVAL });
    expect(v.mode).toBe(MODE.PREPARE);
    expect(v.mode).not.toBe(MODE.EXECUTE);
    expect(v.allow).toBe(true);
  });

  it("tier 1 requires an undo descriptor", () => {
    expect(ok({ tier: TIER.REVERSIBLE, hasUndo: false }).blockedBy).toBe(BLOCK.NO_UNDO);
    expect(ok({ tier: TIER.REVERSIBLE, hasUndo: true }).mode).toBe(MODE.EXECUTE);
  });

  it("tier 1 notifies after acting; tier 0 stays silent", () => {
    expect(ok({ tier: TIER.REVERSIBLE, hasUndo: true }).notify).toBe(true);
    expect(ok({ tier: TIER.READ }).notify).toBe(false);
  });
});

describe("kill switch", () => {
  it("one global toggle halts every tier", () => {
    for (const tier of [TIER.READ, TIER.REVERSIBLE, TIER.APPROVAL]) {
      const v = decide({ tier, global: { enabled: false }, subsystem: OPEN, hasUndo: true, now: 1 });
      expect(v.allow, `tier ${tier} must halt`).toBe(false);
      expect(v.blockedBy).toBe(BLOCK.KILL_SWITCH);
    }
  });

  it("outranks an enabled subsystem", () => {
    const v = decide({ tier: TIER.READ, global: { enabled: false }, subsystem: OPEN, now: 1 });
    expect(v.blockedBy).toBe(BLOCK.KILL_SWITCH);
  });

  it("does NOT outrank tier 3 — a refusal must name the deepest reason", () => {
    // With the switch off AND a tier-3 action, the honest answer is "never
    // automated", not "the switch is off" — otherwise flipping the switch on
    // would look like it unblocked it.
    const v = decide({ tier: TIER.NEVER, global: { enabled: false }, subsystem: OPEN, now: 1 });
    expect(v.blockedBy).toBe(BLOCK.TIER_NEVER);
  });
});

describe("caps", () => {
  it("refuses at the action ceiling, not after crossing it", () => {
    expect(ok({ actionsThisHour: 59 }).allow).toBe(true);
    expect(ok({ actionsThisHour: 60 }).blockedBy).toBe(BLOCK.RATE_CAP);
    expect(ok({ actionsThisHour: 61 }).blockedBy).toBe(BLOCK.RATE_CAP);
  });

  it("counts THIS action's cost before allowing it — never half-takes an action", () => {
    // $9.50 spent, $10 cap, this action costs $1 → would land at $10.50.
    expect(ok({ spendUsdThisHour: 9.5, costUsd: 1 }).blockedBy).toBe(BLOCK.SPEND_CAP);
    // Exactly at the cap is allowed; over it is not.
    expect(ok({ spendUsdThisHour: 9.5, costUsd: 0.5 }).allow).toBe(true);
  });

  it("applies the spend cap to tier 0 as well — aggressive is not unbounded", () => {
    const v = ok({ tier: TIER.READ, spendUsdThisHour: 10, costUsd: 0.01 });
    expect(v.blockedBy).toBe(BLOCK.SPEND_CAP);
  });

  it("a NaN or missing cap falls back to the default instead of disabling itself", () => {
    // `NaN >= x` and `x > NaN` are both false, so an unguarded NaN cap silently
    // permits everything forever. This is the pricing-table bug in another suit.
    for (const bad of [NaN, undefined, null, "not-a-number", Infinity]) {
      const v = decide({
        tier: TIER.READ, global: ON, now: 1,
        subsystem: { ...OPEN, maxSpendUsdPerHour: bad },
        spendUsdThisHour: 5, costUsd: 5,
      });
      expect(v.allow, `cap ${String(bad)} must not permit a $10 spend`).toBe(false);
      expect(v.blockedBy).toBe(BLOCK.SPEND_CAP);
    }
  });

  it("accepts numeric strings, because Postgres numerics arrive as strings", () => {
    const v = decide({
      tier: TIER.READ, global: ON, now: 1,
      subsystem: { ...OPEN, maxSpendUsdPerHour: "10" },
      spendUsdThisHour: 2, costUsd: 1,
    });
    expect(v.allow).toBe(true);
  });
});

describe("circuit breaker", () => {
  it("trips at the limit and stays tripped", () => {
    expect(ok({ consecutiveFailures: 2 }).allow).toBe(true);
    expect(ok({ consecutiveFailures: 3 }).blockedBy).toBe(BLOCK.BREAKER);
    expect(ok({ consecutiveFailures: 30 }).blockedBy).toBe(BLOCK.BREAKER);
  });

  it("counts back from the newest entry and stops at the first success", () => {
    expect(consecutiveFailures([{ ok: false }, { ok: false }, { ok: true }, { ok: false }])).toBe(2);
    expect(consecutiveFailures([{ ok: true }, { ok: false }])).toBe(0);
    expect(consecutiveFailures([])).toBe(0);
  });
});

describe("pause", () => {
  it("names the pause reason in the block, rather than a generic message", () => {
    const v = ok({ subsystem: { ...OPEN, pausedReason: "supplier feed 404ing" } });
    expect(v.allow).toBe(false);
    expect(v.blockedBy).toContain("supplier feed 404ing");
  });
});

// ── The property that makes the 14-day simulation bar reachable ──────────────
describe("injected clock", () => {
  it("decide() is a pure function of its arguments — same in, same out", () => {
    const args = { tier: TIER.REVERSIBLE, global: ON, subsystem: OPEN, hasUndo: true, now: 1_700_000_000_000 };
    expect(decide(args)).toEqual(decide(args));
  });

  it("does not mutate the control objects it is handed", () => {
    const g = { enabled: true }, s = { ...OPEN };
    const gCopy = JSON.stringify(g), sCopy = JSON.stringify(s);
    decide({ tier: TIER.READ, global: g, subsystem: s, now: 5 });
    expect(JSON.stringify(g)).toBe(gCopy);
    expect(JSON.stringify(s)).toBe(sCopy);
  });

  it("usageInWindow honours the injected now and excludes the future", () => {
    const now = 1_000_000;
    const entries = [
      { at: now - 100, costUsd: 1 },            // in window
      { at: now - 3_600_001, costUsd: 99 },     // just outside — excluded
      { at: now + 5_000, costUsd: 50 },         // future — excluded, not counted
      { at: now - 1000, costUsd: 0.5 },         // in window
    ];
    expect(usageInWindow(entries, now)).toEqual({ actions: 2, spendUsd: 1.5 });
  });

  it("advancing the clock ages entries out of the window without any real waiting", () => {
    const t0 = 1_000_000;
    const entries = [{ at: t0, costUsd: 2 }];
    expect(usageInWindow(entries, t0).actions).toBe(1);
    expect(usageInWindow(entries, t0 + 3_600_001).actions).toBe(0);
  });

  it("tolerates ISO timestamps and junk without producing NaN spend", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    const entries = [
      { at: new Date(now - 60_000).toISOString(), costUsd: 1 },
      { at: "not a date", costUsd: 5 },         // unparseable time → whole entry skipped
      { at: now - 30_000, costUsd: "0.25" },    // numeric STRING → counted; Postgres
                                                // returns numerics as strings, so
                                                // dropping these would under-report
                                                // spend, the dangerous direction
      { at: now - 30_000, costUsd: -3 },        // negative cost cannot credit back
    ];
    const u = usageInWindow(entries, now);
    expect(Number.isFinite(u.spendUsd)).toBe(true);
    expect(u.actions).toBe(3);
    expect(u.spendUsd).toBe(1.25);              // 1 + 0.25 + 0 (negative clamped)
  });
});
