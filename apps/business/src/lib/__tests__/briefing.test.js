import { describe, it, expect } from "vitest";
import { composeBriefing, WINDOW_HOURS } from "../briefing.js";

const NOW = Date.parse("2026-07-26T12:00:00Z");
const H = 3_600_000;
const WINDOW_START = NOW - WINDOW_HOURS * H;
const ago = (hours) => new Date(NOW - hours * H).toISOString();

const action = (over = {}) => ({
  id: "a",
  outcome: "success",
  tick_type: "scan",
  cost_usd: 0,
  occurred_at: ago(1),
  ...over,
});

const brief = (over = {}) => composeBriefing({ now: NOW, ...over });

describe("the window", () => {
  it("only counts actions inside the six hours the card claims to cover", () => {
    // The card's headline is a count. If it silently includes whatever the query
    // happened to return, the number means "however many rows we loaded" — and
    // it would change when someone changes the page size, with no visible cause.
    const v = brief({
      actions: [
        action({ id: "in-1", occurred_at: ago(0.5) }),
        action({ id: "in-2", occurred_at: ago(5.9) }),
        action({ id: "out-1", occurred_at: ago(6.1) }),
        action({ id: "out-2", occurred_at: ago(48) }),
      ],
    });
    expect(v.actionCount).toBe(2);
    expect(v.windowStartMs).toBe(WINDOW_START);
    expect(v.windowHours).toBe(6);
  });

  it("includes an action landing exactly on the window boundary", () => {
    // `>=`. Excluding the edge makes the count flicker by one on every render.
    expect(brief({ actions: [action({ occurred_at: new Date(WINDOW_START).toISOString() })] }).actionCount).toBe(1);
    expect(brief({ actions: [action({ occurred_at: new Date(WINDOW_START - 1).toISOString() })] }).actionCount).toBe(0);
  });

  it("drops rows with an unusable timestamp instead of counting them as recent", () => {
    // toMs → null must exclude. Treating null as 0 would put every malformed row
    // in 1970 (excluded, fine); treating it as `now` would inflate the headline
    // with rows of unknown age, which is the dangerous direction.
    const v = brief({ actions: [action({ occurred_at: null }), action({ occurred_at: "junk" }), action({ occurred_at: undefined })] });
    expect(v.actionCount).toBe(0);
  });

  it("honours a caller-supplied window", () => {
    const actions = [action({ occurred_at: ago(2) }), action({ occurred_at: ago(10) })];
    expect(brief({ actions, windowHours: 1 }).actionCount).toBe(0);
    expect(brief({ actions, windowHours: 24 }).actionCount).toBe(2);
  });

  it("with nothing at all it returns a whole briefing rather than throwing", () => {
    const v = composeBriefing({ now: NOW });
    expect(v.actionCount).toBe(0);
    expect(v.costUsd).toBe(0);
    expect(v.blockedOn).toEqual([]);
    expect(v.byOutcome).toEqual({ success: 0, failure: 0, blocked: 0, skipped: 0, dry_run: 0 });
  });
});

describe("byOutcome counts", () => {
  it("counts each outcome separately and only inside the window", () => {
    const v = brief({
      actions: [
        action({ outcome: "success" }),
        action({ outcome: "success" }),
        action({ outcome: "failure" }),
        action({ outcome: "blocked" }),
        action({ outcome: "skipped" }),
        action({ outcome: "dry_run" }),
        action({ outcome: "failure", occurred_at: ago(9) }), // outside — must not count
      ],
    });
    expect(v.byOutcome).toEqual({ success: 2, failure: 1, blocked: 1, skipped: 1, dry_run: 1 });
    expect(v.actionCount).toBe(6);
  });

  // A dry run is not a thing that happened. Folding it into `success` is how a
  // subsystem stuck in dry-run mode reads as a working agent.
  it("keeps dry_run out of success", () => {
    const v = brief({ actions: [action({ outcome: "dry_run" }), action({ outcome: "dry_run" })] });
    expect(v.byOutcome.dry_run).toBe(2);
    expect(v.byOutcome.success).toBe(0);
  });

  it("an unrecognised outcome is counted in the total but not into any bucket", () => {
    // It must not be quietly filed as a success.
    const v = brief({ actions: [action({ outcome: "weird" }), action({ outcome: null })] });
    expect(v.actionCount).toBe(2);
    expect(v.byOutcome.success).toBe(0);
    expect(Object.values(v.byOutcome).every((n) => n === 0)).toBe(true);
  });

  it("surfaces the failing actions themselves, not just a number", () => {
    const v = brief({
      actions: [action({ id: "f1", outcome: "failure" }), action({ id: "ok" }), action({ id: "f2", outcome: "failure" })],
    });
    expect(v.failedActions.map((a) => a.id)).toEqual(["f1", "f2"]);
  });

  it("groups by tick type so a single broken tick is visible", () => {
    const v = brief({
      actions: [action({ tick_type: "scan" }), action({ tick_type: "scan" }), action({ tick_type: "outreach" })],
    });
    expect(v.byTick).toEqual([{ tick: "scan", count: 2 }, { tick: "outreach", count: 1 }]);
  });
});

describe("cost", () => {
  it("sums only in-window cost", () => {
    const v = brief({
      actions: [
        action({ cost_usd: 0.25 }),
        action({ cost_usd: 1.5 }),
        action({ cost_usd: 99, occurred_at: ago(12) }), // outside
      ],
    });
    expect(v.costUsd).toBeCloseTo(1.75, 10);
  });

  it("a missing or unparseable cost is skipped instead of poisoning the sum with NaN", () => {
    // One NaN makes the whole figure "—", so a real spend total disappears
    // because of one bad row.
    const v = brief({
      actions: [
        action({ cost_usd: 1 }),
        action({ cost_usd: undefined }),
        action({ cost_usd: "nope" }),
        action({ cost_usd: "0.5" }), // numeric string — Postgres numerics arrive this way
      ],
    });
    expect(Number.isFinite(v.costUsd)).toBe(true);
    expect(v.costUsd).toBe(1.5);
  });
});

describe("baseline selection — what moved", () => {
  // The delta is "since the window opened". The baseline must therefore be the
  // last snapshot AT OR BEFORE the window start. Using "the oldest snapshot we
  // happen to have loaded" makes the delta's meaning depend on the page size:
  // load 50 rows instead of 20 and the same screen reports a different change,
  // with nothing on the page saying why.
  const snaps = [
    { captured_at: ago(24), mrr_usd: 100 },  // oldest loaded — must NOT be the baseline
    { captured_at: ago(12), mrr_usd: 110 },
    { captured_at: ago(6.5), mrr_usd: 120 }, // last one at/before the window start
    { captured_at: ago(3), mrr_usd: 140 },
    { captured_at: ago(0.5), mrr_usd: 150 }, // latest
  ];

  it("uses the last snapshot at or before the window start, not the oldest row loaded", () => {
    const v = brief({ metrics: snaps });
    const mrr = v.deltas.find((d) => d.key === "mrr_usd");
    expect(v.baselineAtMs).toBe(Date.parse(ago(6.5)));
    expect(mrr.from).toBe(120);   // NOT 100
    expect(mrr.to).toBe(150);
    expect(mrr.delta).toBe(30);   // NOT 50
    expect(v.baselineCoversWindow).toBe(true);
  });

  it("does not depend on the order the rows arrived in", () => {
    const shuffled = [snaps[3], snaps[0], snaps[4], snaps[2], snaps[1]];
    const v = brief({ metrics: shuffled });
    expect(v.deltas.find((d) => d.key === "mrr_usd").delta).toBe(30);
    expect(v.latestSnapshotAtMs).toBe(Date.parse(ago(0.5)));
  });

  it("a snapshot landing exactly on the window start is an eligible baseline", () => {
    const v = brief({
      metrics: [
        { captured_at: new Date(WINDOW_START).toISOString(), mrr_usd: 200 },
        { captured_at: ago(1), mrr_usd: 250 },
      ],
    });
    expect(v.baselineCoversWindow).toBe(true);
    expect(v.deltas.find((d) => d.key === "mrr_usd").delta).toBe(50);
  });

  it("flags baselineCoversWindow false when nothing is old enough", () => {
    // The delta is then over a shorter span than advertised. The card must be
    // able to say "2 hours, not 6" rather than implying full coverage.
    const v = brief({
      metrics: [
        { captured_at: ago(2), mrr_usd: 300 },
        { captured_at: ago(0.5), mrr_usd: 320 },
      ],
    });
    expect(v.baselineCoversWindow).toBe(false);
    expect(v.baselineAtMs).toBe(Date.parse(ago(2))); // best available, honestly labelled
    expect(v.deltas.find((d) => d.key === "mrr_usd").delta).toBe(20);
  });

  it("a single snapshot yields no delta at all rather than a delta of zero", () => {
    // "0" reads as "nothing changed". The truth is "we have nothing to compare to".
    const v = brief({ metrics: [{ captured_at: ago(1), mrr_usd: 400 }] });
    expect(v.baselineCoversWindow).toBe(false);
    expect(v.baselineAtMs).toBe(null);
    const mrr = v.deltas.find((d) => d.key === "mrr_usd");
    expect(mrr.to).toBe(400);
    expect(mrr.from).toBe(null);
    expect(mrr.delta).toBe(null);
    expect(mrr.pct).toBe(null);
  });

  it("ignores snapshots with an unreadable captured_at rather than sorting them to the front", () => {
    const v = brief({
      metrics: [
        { captured_at: "garbage", mrr_usd: 1 },
        { captured_at: null, mrr_usd: 2 },
        ...snaps,
      ],
    });
    expect(v.deltas.find((d) => d.key === "mrr_usd").delta).toBe(30);
  });

  it("drops a metric the latest snapshot does not carry, instead of reporting it as zero", () => {
    const v = brief({ metrics: [{ captured_at: ago(8), customers: 5 }, { captured_at: ago(1), mrr_usd: 10 }] });
    expect(v.deltas.map((d) => d.key)).toEqual(["mrr_usd"]);
  });

  it("suppresses pct when the baseline is zero rather than emitting Infinity", () => {
    const v = brief({ metrics: [{ captured_at: ago(8), mrr_usd: 0 }, { captured_at: ago(1), mrr_usd: 50 }] });
    const mrr = v.deltas.find((d) => d.key === "mrr_usd");
    expect(mrr.delta).toBe(50);
    expect(mrr.pct).toBe(null);
  });
});

describe("blockedOn", () => {
  it("a halt is listed first and marked critical — it is the reason nothing is happening", () => {
    const v = brief({ config: { halted: true, halt_reason: "spend spike" } });
    expect(v.blockedOn[0]).toMatchObject({ type: "halted", severity: "critical", detail: "spend spike" });
  });

  it("a halt with no recorded reason still appears, saying the reason is missing", () => {
    // Dropping the entry because the reason field is empty would remove the most
    // important line on the card.
    const v = brief({ config: { halted: true } });
    expect(v.blockedOn.filter((b) => b.type === "halted")).toHaveLength(1);
    expect(v.blockedOn[0].detail).toMatch(/no reason/i);
  });

  it("a config that is present but not halted contributes nothing", () => {
    expect(brief({ config: { halted: false } }).blockedOn).toEqual([]);
    expect(brief({ config: null }).blockedOn).toEqual([]);
  });

  it("lists only approvals still awaiting you, not ones whose window already lapsed", () => {
    // An expired approval is not something you are blocking — the agent already
    // went ahead. It belongs in the auto-proceed callout, not here.
    const v = brief({
      approvals: [
        { id: "live", title: "Raise ad budget", decision: "pending", veto_until: new Date(NOW + H).toISOString() },
        { id: "lapsed", title: "Old one", decision: "pending", veto_until: new Date(NOW - H).toISOString() },
        { id: "done", title: "Decided", decision: "approved", veto_until: new Date(NOW + H).toISOString() },
      ],
    });
    expect(v.blockedOn.filter((b) => b.type === "approval").map((b) => b.id)).toEqual(["live"]);
  });

  it("includes blocked hypotheses and failing invariants, with critical severity preserved", () => {
    const v = brief({
      hypotheses: [
        { id: "h1", title: "Try pricing page", status: "blocked", blocked_reason: "needs a card on file" },
        { id: "h2", title: "Queued one", status: "queued" },
      ],
      invariants: [
        { id: "i1", name: "no double charges", passed: false, severity: "critical" },
        { id: "i2", name: "warn one", passed: false, severity: "warn" },
        { id: "i3", name: "passing", passed: true, severity: "critical" },
      ],
    });
    expect(v.blockedOn.filter((b) => b.type === "hypothesis").map((b) => b.id)).toEqual(["h1"]);
    const inv = v.blockedOn.filter((b) => b.type === "invariant");
    expect(inv.map((b) => b.id)).toEqual(["i1", "i2"]);
    expect(inv[0].severity).toBe("critical");
  });

  it("an invariant with an unknown pass state is NOT reported as failing", () => {
    // `passed === false`, not `!passed`. A check that has not run yet is not a
    // check that failed, and conflating them makes the list cry wolf.
    const v = brief({ invariants: [{ id: "x", name: "never ran", passed: null }, { id: "y", name: "u", passed: undefined }] });
    expect(v.blockedOn).toEqual([]);
  });

  it("ranks queued hypotheses by score and shows only the top three", () => {
    const v = brief({
      hypotheses: [
        { id: "low", status: "queued", score: 1 },
        { id: "high", status: "queued", score: 9 },
        { id: "mid", status: "running", score: 5 },
        { id: "meh", status: "queued", score: 3 },
        { id: "shipped", status: "done", score: 99 },
      ],
    });
    expect(v.wantsNext.map((h) => h.id)).toEqual(["high", "mid", "meh"]);
  });

  it("newest learnings first, and only ones from the window", () => {
    const v = brief({
      learnings: [
        { id: "old", learned_at: ago(20) },
        { id: "recent", learned_at: ago(1) },
        { id: "middling", learned_at: ago(4) },
      ],
    });
    expect(v.newLearnings.map((l) => l.id)).toEqual(["recent", "middling"]);
  });
});

describe("the headline", () => {
  // One line, for the moment there is only time for one line. Its ordering is
  // the whole design: the most alarming true statement wins.
  it("a halt outranks everything, including a busy window", () => {
    const v = brief({
      config: { halted: true, halt_reason: "you stopped it" },
      actions: [action(), action({ outcome: "failure" })],
    });
    expect(v.headline).toBe("Halted — it is not doing anything.");
  });

  it("no actions says so, and names both readings rather than picking the calm one", () => {
    // "0 actions" alone reads as calm. Idle and dead look identical from here,
    // and the line has to admit that.
    const v = brief({ actions: [] });
    expect(v.headline).toBe("No actions in the window. Either it is idle or it stopped.");
  });

  it("actions that are all outside the window count as no actions", () => {
    expect(brief({ actions: [action({ occurred_at: ago(30) })] }).headline).toMatch(/^No actions/);
  });

  it("failures outrank a waiting approval and are stated with both numbers", () => {
    const v = brief({
      actions: [action(), action({ outcome: "failure" }), action({ outcome: "failure" })],
      approvals: [{ id: "a", title: "t", decision: "pending", veto_until: new Date(NOW + H).toISOString() }],
    });
    expect(v.headline).toBe("3 actions, 2 failed.");
  });

  it("a waiting approval is named when nothing failed", () => {
    const v = brief({
      actions: [action(), action()],
      approvals: [{ id: "a", title: "t", decision: "pending", veto_until: new Date(NOW + H).toISOString() }],
    });
    expect(v.headline).toBe("2 actions, 1 waiting on you.");
  });

  it("only says 'all clean' when there is genuinely nothing to report", () => {
    expect(brief({ actions: [action(), action()] }).headline).toBe("2 actions, all clean.");
  });
});

describe("purity", () => {
  it("is a pure function of its arguments — same in, same out", () => {
    const args = { now: NOW, actions: [action()], metrics: [{ captured_at: ago(8), mrr_usd: 1 }] };
    expect(composeBriefing(args)).toEqual(composeBriefing(args));
  });

  it("does not mutate the rows it was handed", () => {
    const metrics = [{ captured_at: ago(8), mrr_usd: 1 }, { captured_at: ago(1), mrr_usd: 2 }];
    const before = JSON.stringify(metrics);
    composeBriefing({ now: NOW, metrics });
    expect(JSON.stringify(metrics)).toBe(before);
  });
});
