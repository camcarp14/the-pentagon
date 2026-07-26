import { describe, it, expect } from "vitest";
import { currentPeriod, budgetSummary, MIN_ELAPSED_FRACTION_FOR_PROJECTION } from "../budget.js";

const T = (iso) => Date.parse(iso);

// A 31-day period. Mid-period NOW is chosen so elapsedFraction is exactly 0.5,
// which makes every projection exactly double the spend — an arithmetic error
// in the projection cannot hide behind a messy fraction.
const JULY = { period_start: "2026-07-01", period_end: "2026-07-31" };
const JULY_START = T("2026-07-01T00:00:00Z");
const JULY_END_EXCLUSIVE = T("2026-08-01T00:00:00Z");
const MID = T("2026-07-16T12:00:00Z"); // exactly half of 31 days

const cap = (category, cap_usd, over = {}) => ({ ...JULY, category, cap_usd, hard_stop: false, ...over });
const spend = (category, amount_usd, iso) => ({ category, amount_usd, spent_at: iso });

const CAPS = [cap("ads", 100), cap("llm", 20, { hard_stop: true })];

describe("currentPeriod", () => {
  it("picks the period that contains now, not merely the newest one", () => {
    const june = [{ period_start: "2026-06-01", period_end: "2026-06-30", category: "ads", cap_usd: 10 }];
    const p = currentPeriod([...june, ...CAPS], MID);
    expect(p.key).toBe("2026-07-01");
    expect(p.expired).toBe(false);
    expect(p.startMs).toBe(JULY_START);
  });

  it("treats period_end as an INCLUSIVE date, so the last day is still inside", () => {
    // period_end is a `date` column. Ending the period at midnight ON that day
    // would silently drop the whole final day of spend.
    expect(currentPeriod(CAPS, T("2026-07-31T23:59:59Z")).expired).toBe(false);
    expect(currentPeriod(CAPS, T("2026-08-01T00:00:00Z")).expired).toBe(true);
  });

  it("includes the first instant of the period", () => {
    expect(currentPeriod(CAPS, JULY_START).expired).toBe(false);
  });

  it("falls back to the newest period but FLAGS it expired rather than passing it off as current", () => {
    // The agent hasn't rolled the month over. Showing last month's caps as if
    // they were this month's is a budget panel that is confidently measuring
    // against the wrong ceiling.
    const p = currentPeriod(CAPS, T("2026-09-15T00:00:00Z"));
    expect(p.key).toBe("2026-07-01");
    expect(p.expired).toBe(true);
  });

  it("groups every cap row of a period together", () => {
    expect(currentPeriod(CAPS, MID).caps).toHaveLength(2);
  });

  it("returns null when there is nothing to measure against", () => {
    expect(currentPeriod([], MID)).toBe(null);
    expect(currentPeriod(null, MID)).toBe(null);
    expect(currentPeriod(undefined, MID)).toBe(null);
    expect(currentPeriod([null, undefined], MID)).toBe(null);
  });

  it("returns null when no row carries a usable period_start", () => {
    // A row we cannot date must not become a period covering all time.
    expect(currentPeriod([{ category: "ads", cap_usd: 5 }], MID)).toBe(null);
    expect(currentPeriod([{ period_start: "whenever", category: "ads", cap_usd: 5 }], MID)).toBe(null);
  });

  it("gives an end-less period a bounded 30-day span instead of running forever", () => {
    const rows = [{ period_start: "2026-07-01", category: "ads", cap_usd: 100 }];
    expect(currentPeriod(rows, MID).expired).toBe(false);
    expect(currentPeriod(rows, T("2026-09-01T00:00:00Z")).expired).toBe(true);
  });
});

describe("budgetSummary refuses to guess with no caps", () => {
  it("returns ok:false rather than a summary measured against nothing", () => {
    // A panel that renders "$55 spent" with no ceiling looks like a number under
    // control. It is a number with no opinion attached.
    for (const caps of [[], null, undefined, [{ category: "ads", cap_usd: 5 }]]) {
      const v = budgetSummary(caps, [spend("ads", 55, "2026-07-05T00:00:00Z")], MID);
      expect(v.ok, `caps=${JSON.stringify(caps)}`).toBe(false);
      expect(v.reason).toBe("no_caps");
      expect(v.total).toBeUndefined();
    }
  });
});

describe("spend outside the period does not count", () => {
  const spends = [
    spend("ads", 30, "2026-07-05T00:00:00Z"),   // in
    spend("llm", 25, "2026-07-10T00:00:00Z"),   // in
    spend("ads", 999, "2026-06-15T00:00:00Z"),  // last month — must not count
    spend("ads", 500, "2026-08-02T00:00:00Z"),  // next month — must not count
  ];

  it("last month's and next month's spend are excluded from this month's totals", () => {
    // Leaking a neighbouring month in either direction produces a breach that
    // isn't real, or hides one that is.
    const v = budgetSummary(CAPS, spends, MID);
    expect(v.ok).toBe(true);
    expect(v.spendRowCount).toBe(2);
    expect(v.total.spentUsd).toBe(55);
    expect(v.categories.find((c) => c.category === "ads").spentUsd).toBe(30);
  });

  it("includes the first instant and the last instant of the period, and nothing beyond", () => {
    const edges = [
      spend("ads", 1, "2026-07-01T00:00:00.000Z"),  // exactly the start — in
      spend("ads", 2, "2026-07-31T23:59:59.999Z"),  // last moment of the last day — in
      spend("ads", 4, "2026-06-30T23:59:59.999Z"),  // one ms before — out
      spend("ads", 8, "2026-08-01T00:00:00.000Z"),  // first ms after — out
    ];
    expect(budgetSummary(CAPS, edges, MID).total.spentUsd).toBe(3);
  });

  it("rows with an unusable spent_at are dropped, not counted at time zero", () => {
    // toMs returning null must exclude the row; a `null → 0` coercion would file
    // every malformed row into 1970 and quietly under-report the month.
    const v = budgetSummary(CAPS, [
      spend("ads", 30, "2026-07-05T00:00:00Z"),
      spend("ads", 400, null),
      spend("ads", 400, "not a date"),
    ], MID);
    expect(v.total.spentUsd).toBe(30);
  });

  it("a non-numeric amount is skipped instead of turning the total into NaN", () => {
    // One NaN would make every downstream comparison false, so a breached
    // category would stop reporting as breached.
    const v = budgetSummary(CAPS, [
      spend("ads", 30, "2026-07-05T00:00:00Z"),
      spend("ads", "oops", "2026-07-06T00:00:00Z"),
      spend("ads", "12.50", "2026-07-07T00:00:00Z"), // numeric string: Postgres numerics arrive as strings
    ], MID);
    expect(Number.isFinite(v.total.spentUsd)).toBe(true);
    expect(v.total.spentUsd).toBe(42.5);
  });

  it("a non-array spends feed yields zero spend rather than throwing", () => {
    expect(budgetSummary(CAPS, null, MID).total.spentUsd).toBe(0);
    expect(budgetSummary(CAPS, undefined, MID).ok).toBe(true);
  });
});

describe("uncapped categories still appear", () => {
  it("money leaving through a category nobody capped is rendered, not silently dropped", () => {
    // The failure: the panel only iterates the cap rows, so a new spend category
    // shows $0 of overrun while the money leaves.
    const v = budgetSummary(CAPS, [
      spend("ads", 10, "2026-07-05T00:00:00Z"),
      spend("tools", 77, "2026-07-06T00:00:00Z"),
    ], MID);

    const tools = v.categories.find((c) => c.category === "tools");
    expect(tools).toBeDefined();
    expect(tools.uncapped).toBe(true);
    expect(tools.spentUsd).toBe(77);
    // It has no ceiling, so it cannot claim to be on pace or breached.
    expect(tools.capUsd).toBe(null);
    expect(tools.onPace).toBe(null);
    expect(tools.breached).toBe(false);
    // …but it must still reach the total, or the total is wrong too.
    expect(v.total.spentUsd).toBe(87);
  });

  it("capped categories with no spend still appear at zero", () => {
    // A cap that vanishes when unused makes the panel's shape change month to
    // month, which is how you stop noticing a missing row.
    const v = budgetSummary(CAPS, [], MID);
    expect(v.categories.map((c) => c.category).sort()).toEqual(["ads", "llm"]);
    expect(v.categories.every((c) => c.spentUsd === 0)).toBe(true);
  });

  it("sorts by spend so the biggest line is at the top", () => {
    const v = budgetSummary(CAPS, [
      spend("ads", 5, "2026-07-05T00:00:00Z"),
      spend("llm", 19, "2026-07-05T00:00:00Z"),
      spend("tools", 12, "2026-07-05T00:00:00Z"),
    ], MID);
    expect(v.categories.map((c) => c.category)).toEqual(["llm", "tools", "ads"]);
  });
});

describe("projection is suppressed early in the period", () => {
  // Dividing spend by a tiny elapsed-fraction multiplies noise by ~30. One $4
  // test call on the 1st projects to $120 and paints the panel red. Crying wolf
  // on day one is how the alarm gets ignored on day twenty.
  const EARLY = T("2026-07-02T00:00:00Z"); // 1/31 ≈ 0.032, under the 0.08 floor

  it("below the floor there is no projection at all — and it is NOT reported as on-pace", () => {
    const v = budgetSummary(CAPS, [spend("ads", 4, "2026-07-01T06:00:00Z")], EARLY);
    expect(v.elapsedFraction).toBeLessThan(MIN_ELAPSED_FRACTION_FOR_PROJECTION);
    expect(v.projectable).toBe(false);

    const ads = v.categories.find((c) => c.category === "ads");
    expect(ads.projectedUsd).toBe(null);
    expect(ads.overBy).toBe(null);
    // The assertion that matters: `null` must not be readable as "fine".
    expect(ads.onPace).toBe(null);
    expect(ads.onPace).not.toBe(true);
    expect(ads.onPace).not.toBe(false);
    expect(v.total.projectedUsd).toBe(null);
    expect(v.total.onPace).toBe(null);
  });

  it("a real breach is still reported early — a breach is a fact, not a forecast", () => {
    // Suppressing the projection must not suppress the thing that already
    // happened: $25 spent against a $20 cap is over, on day one or day thirty.
    const v = budgetSummary(CAPS, [spend("llm", 25, "2026-07-01T06:00:00Z")], EARLY);
    const llm = v.categories.find((c) => c.category === "llm");
    expect(llm.breached).toBe(true);
    expect(llm.spentUsd).toBe(25);
    expect(llm.remainingUsd).toBe(-5);
    expect(llm.onPace).toBe(null); // still refuses to forecast
  });

  it("turns on once enough of the period has elapsed", () => {
    const v = budgetSummary(CAPS, [spend("ads", 4, "2026-07-01T06:00:00Z")], MID);
    expect(v.projectable).toBe(true);
    expect(v.categories.find((c) => c.category === "ads").projectedUsd).toBe(8);
  });

  it("the floor is a real threshold, honoured at the boundary", () => {
    // 0.08 of 31 days ≈ 2.48 days. Just under must refuse; just over must project.
    const justUnder = JULY_START + (MIN_ELAPSED_FRACTION_FOR_PROJECTION * (JULY_END_EXCLUSIVE - JULY_START)) - 1000;
    const justOver = JULY_START + (MIN_ELAPSED_FRACTION_FOR_PROJECTION * (JULY_END_EXCLUSIVE - JULY_START)) + 1000;
    expect(budgetSummary(CAPS, [], justUnder).projectable).toBe(false);
    expect(budgetSummary(CAPS, [], justOver).projectable).toBe(true);
  });
});

describe("projection, breach and overBy once projecting is allowed", () => {
  const v = budgetSummary(CAPS, [
    spend("ads", 30, "2026-07-05T00:00:00Z"),
    spend("llm", 25, "2026-07-10T00:00:00Z"),
  ], MID);
  const ads = v.categories.find((c) => c.category === "ads");
  const llm = v.categories.find((c) => c.category === "llm");

  it("halfway through the period, the projection is exactly double the spend", () => {
    expect(v.elapsedFraction).toBe(0.5);
    expect(ads.projectedUsd).toBe(60);
    expect(llm.projectedUsd).toBe(50);
  });

  it("on-pace is judged against the projection, not against spend-to-date", () => {
    // $30 of a $100 cap looks comfortable; at this pace it lands at $60, so it
    // is genuinely fine. $25 of a $20 cap is already over.
    expect(ads.onPace).toBe(true);
    expect(llm.onPace).toBe(false);
  });

  it("overBy is the projected overshoot, and zero (not negative) when under", () => {
    expect(llm.overBy).toBe(30);  // projected 50 against a 20 cap
    expect(ads.overBy).toBe(0);   // under: must not report a negative overshoot
  });

  it("breached reflects money ALREADY spent past the cap, independent of the forecast", () => {
    expect(llm.breached).toBe(true);
    expect(ads.breached).toBe(false);
    // ads is projected to stay under AND is not breached; llm is both.
    expect(ads.remainingUsd).toBe(70);
    expect(ads.pctUsed).toBeCloseTo(0.3, 10);
  });

  it("carries hard_stop through, since a hard cap and a soft one read differently", () => {
    expect(llm.hardStop).toBe(true);
    expect(ads.hardStop).toBe(false);
  });

  it("derives a total cap from the category caps when no explicit total row exists", () => {
    expect(v.total.capUsd).toBe(120);
    expect(v.total.spentUsd).toBe(55);
    expect(v.total.projectedUsd).toBe(110);
    expect(v.total.onPace).toBe(true);
  });

  it("an explicit total row wins over the derived sum and is not listed as a category", () => {
    const withTotal = budgetSummary(
      [...CAPS, cap("total", 40, { hard_stop: true })],
      [spend("ads", 30, "2026-07-05T00:00:00Z")],
      MID,
    );
    expect(withTotal.total.capUsd).toBe(40);
    expect(withTotal.total.hardStop).toBe(true);
    expect(withTotal.total.onPace).toBe(false); // 30 → projected 60 against 40
    expect(withTotal.categories.map((c) => c.category)).not.toContain("total");
  });

  it("reports the period it measured, so the panel can label what it is showing", () => {
    expect(v.periodStartMs).toBe(JULY_START);
    expect(v.periodEndExclusiveMs).toBe(JULY_END_EXCLUSIVE);
    expect(v.periodExpired).toBe(false);
    expect(v.daysElapsed).toBeCloseTo(15.5, 6);
    expect(v.daysRemaining).toBe(16);
  });

  it("the daily allowance never goes negative on an over-cap category", () => {
    // A negative allowance would render as "you may spend −$0.31/day", which is
    // noise where the honest reading is "nothing left".
    expect(llm.allowancePerDayUsd).toBe(0);
    expect(ads.allowancePerDayUsd).toBeCloseTo(70 / 16, 10);
  });
});

describe("an expired period is still summarised, and says so", () => {
  it("flags periodExpired instead of pretending the stale caps are current", () => {
    const v = budgetSummary(CAPS, [spend("ads", 30, "2026-07-05T00:00:00Z")], T("2026-09-15T00:00:00Z"));
    expect(v.ok).toBe(true);
    expect(v.periodExpired).toBe(true);
    expect(v.daysRemaining).toBe(0);
    // The whole period has elapsed, so the "projection" is just the final total.
    expect(v.elapsedFraction).toBe(1);
    expect(v.categories.find((c) => c.category === "ads").projectedUsd).toBe(30);
  });
});
