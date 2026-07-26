import { describe, it, expect } from "vitest";
import { partitionApprovals, isDecidable, URGENT_WINDOW_MIN, LAST_VISIT_KEY, readLastVisit, writeLastVisit } from "../approvals.js";

const NOW = Date.parse("2026-07-26T12:00:00Z");
const MIN = 60_000;
const at = (offsetMin) => new Date(NOW + offsetMin * MIN).toISOString();

// A pending approval whose deadline is `inMin` minutes from NOW.
const pending = (id, inMin, over = {}) => ({
  id,
  title: `approval ${id}`,
  decision: "pending",
  veto_until: at(inMin),
  created_at: at(-120),
  ...over,
});

const part = (rows, over = {}) => partitionApprovals(rows, { now: NOW, ...over });

describe("an expired-unreviewed row is its own bucket", () => {
  // The failure this whole module exists to prevent: `veto_until` passes with
  // the row still `pending`, the agent proceeds, and NOBODY WRITES ANYTHING.
  // There is no event to subscribe to — the only trace is the shape of the row.
  // If that shape gets sorted into history it reads as a decision you made, and
  // if it gets sorted into pending it reads as something you can still stop.
  // Both are lies, in opposite directions.
  it("never lands in 'decided' and never lands in 'pending'", () => {
    const expired = pending("e1", -30);
    const v = part([expired]);

    expect(v.expiredUnreviewed).toHaveLength(1);
    expect(v.expiredUnreviewed[0].id).toBe("e1");
    expect(v.decided.map((r) => r.id)).not.toContain("e1");
    expect(v.pending.map((r) => r.id)).not.toContain("e1");
    expect(v.urgent.map((r) => r.id)).not.toContain("e1");
    expect(v.pendingLater.map((r) => r.id)).not.toContain("e1");
    expect(v.counts.pending).toBe(0);
    expect(v.counts.expiredUnreviewed).toBe(1);
  });

  it("a row that lapsed this very instant is already gone, not still pending", () => {
    // `<= 0`, not `< 0` — at the deadline the agent has gone ahead.
    expect(part([pending("boundary", 0)]).expiredUnreviewed).toHaveLength(1);
    expect(part([pending("boundary", 0)]).pending).toHaveLength(0);
  });

  it("a row with no decision field at all is still treated as unreviewed, not as history", () => {
    // A null/absent `decision` means nobody acted. Falling through to `decided`
    // would file an auto-proceed as a choice.
    for (const decision of [null, undefined, ""]) {
      const v = part([{ id: "x", decision, veto_until: at(-10) }]);
      expect(v.expiredUnreviewed, `decision=${String(decision)}`).toHaveLength(1);
      expect(v.decided).toHaveLength(0);
    }
  });

  it("newest expiry first — what it just did outranks what it did last week", () => {
    const v = part([pending("old", -10_000), pending("recent", -5), pending("middle", -600)]);
    expect(v.expiredUnreviewed.map((r) => r.id)).toEqual(["recent", "middle", "old"]);
  });

  it("approved and vetoed rows ARE history, including ones past their deadline", () => {
    const v = part([
      { id: "a", decision: "approved", veto_until: at(-500), decided_at: at(-490) },
      { id: "v", decision: "vetoed", veto_until: at(-100), decided_at: at(-110) },
    ]);
    expect(v.decided.map((r) => r.id)).toEqual(["v", "a"]); // most recent decision first
    expect(v.expiredUnreviewed).toHaveLength(0);
  });
});

describe("the 60-minute urgent boundary", () => {
  it("exactly at the window is urgent; one millisecond beyond it is not", () => {
    // Inclusive at the edge. A row with exactly an hour left is one you can
    // still stop, and it belongs pinned where your thumb is.
    const exact = { id: "exact", decision: "pending", veto_until: new Date(NOW + URGENT_WINDOW_MIN * MIN).toISOString() };
    const past = { id: "past", decision: "pending", veto_until: new Date(NOW + URGENT_WINDOW_MIN * MIN + 1000).toISOString() };
    const v = part([exact, past]);
    expect(v.urgent.map((r) => r.id)).toEqual(["exact"]);
    expect(v.pendingLater.map((r) => r.id)).toEqual(["past"]);
  });

  it("urgent and later together are exactly 'pending' — nothing is dropped or double-counted", () => {
    const v = part([pending("a", 5), pending("b", 300), pending("c", 45)]);
    expect(v.pending).toHaveLength(3);
    expect(v.counts.pending).toBe(v.urgent.length + v.pendingLater.length);
    expect(v.counts.urgent).toBe(2);
  });

  it("honours a caller-supplied window instead of hard-coding 60", () => {
    const rows = [pending("a", 20)];
    expect(part(rows, { urgentWindowMin: 10 }).urgent).toHaveLength(0);
    expect(part(rows, { urgentWindowMin: 30 }).urgent).toHaveLength(1);
  });
});

describe("ordering", () => {
  it("soonest deadline first, so the one you have least time to stop is on top", () => {
    const v = part([pending("30m", 30), pending("2m", 2), pending("55m", 55), pending("9m", 9)]);
    expect(v.urgent.map((r) => r.id)).toEqual(["2m", "9m", "30m", "55m"]);
  });

  it("sorts the later queue the same direction, not in arrival order", () => {
    const v = part([pending("tomorrow", 1440), pending("tonight", 240), pending("later", 600)]);
    expect(v.pendingLater.map((r) => r.id)).toEqual(["tonight", "later", "tomorrow"]);
  });

  it("computes msRemaining against the injected clock, not the real one", () => {
    const v = part([pending("a", 10)]);
    expect(v.urgent[0].msRemaining).toBe(10 * MIN);
    expect(v.urgent[0].vetoAtMs).toBe(NOW + 10 * MIN);
  });
});

describe("an unreadable deadline is urgent, not filed away", () => {
  // A pending row whose `veto_until` is null or garbage cannot be PROVEN to be
  // safe. Sorting it into "later" hides a decision that may already be seconds
  // from lapsing; sorting it into expired claims something we don't know. Urgent
  // is the only reading that fails in the recoverable direction.
  it("null, empty and unparseable deadlines all land in urgent and are flagged", () => {
    for (const veto of [null, undefined, "", "not a date", "soon"]) {
      const v = part([{ id: "u", decision: "pending", veto_until: veto }]);
      expect(v.urgent, `veto_until=${JSON.stringify(veto)}`).toHaveLength(1);
      expect(v.urgent[0].deadlineUnknown).toBe(true);
      expect(v.urgent[0].msRemaining).toBe(null);
      expect(v.pendingLater).toHaveLength(0);
      expect(v.expiredUnreviewed).toHaveLength(0);
      expect(v.decided).toHaveLength(0);
    }
  });

  it("an unknown deadline sorts ABOVE a known one, since it may already be lapsing", () => {
    const v = part([pending("known", 5), { id: "unknown", decision: "pending", veto_until: null }]);
    expect(v.urgent[0].id).toBe("unknown");
  });
});

describe("since-my-last-visit", () => {
  // The callout that says "while you were away, it went ahead with these".
  const rows = [pending("before", -600), pending("after", -30), pending("way-before", -5_000)];

  it("keeps only auto-proceeds that happened after the recorded visit", () => {
    const v = part(rows, { lastVisitAt: NOW - 120 * MIN });
    expect(v.sinceLastVisit.map((r) => r.id)).toEqual(["after"]);
    expect(v.counts.sinceLastVisit).toBe(1);
  });

  it("everything not in the callout is still reachable as earlier history", () => {
    // Filtering must not DELETE the older auto-proceeds, only demote them.
    const v = part(rows, { lastVisitAt: NOW - 120 * MIN });
    expect(v.earlierExpired.map((r) => r.id).sort()).toEqual(["before", "way-before"]);
    expect(v.sinceLastVisit.length + v.earlierExpired.length).toBe(v.expiredUnreviewed.length);
  });

  it("with no recorded visit it shows ALL of them, erring toward over-reporting", () => {
    // Under-reporting an auto-proceed is the failure this bucket exists to
    // prevent; over-reporting one costs a scroll.
    const v = part(rows, { lastVisitAt: null });
    expect(v.sinceLastVisit).toHaveLength(3);
    expect(v.earlierExpired).toHaveLength(0);
  });

  it("an unparseable stored visit is treated as no visit, not as epoch-zero or now", () => {
    // "now" would hide everything — the dangerous direction.
    for (const bad of ["", "junk", undefined, NaN]) {
      expect(part(rows, { lastVisitAt: bad }).sinceLastVisit, `lastVisitAt=${String(bad)}`).toHaveLength(3);
    }
  });

  it("a row that expired exactly at the visit timestamp is included", () => {
    // `>=`. On the boundary, showing it is the recoverable mistake.
    const v = part([pending("edge", -60)], { lastVisitAt: NOW - 60 * MIN });
    expect(v.sinceLastVisit.map((r) => r.id)).toEqual(["edge"]);
  });
});

describe("isDecidable mirrors the RLS policy", () => {
  // The database enforces `veto_until > now()`. A button the database will
  // refuse produces a tap that looks like it worked and changed nothing —
  // which is indistinguishable, from the couch, from a veto that landed.
  it("refuses a row whose window has closed", () => {
    expect(isDecidable(pending("x", -1), NOW)).toBe(false);
    expect(isDecidable(pending("x", 5), NOW)).toBe(true);
  });

  it("refuses at exactly the deadline, matching the strict `>` in the policy", () => {
    expect(isDecidable({ decision: "pending", veto_until: new Date(NOW).toISOString() }, NOW)).toBe(false);
    expect(isDecidable({ decision: "pending", veto_until: new Date(NOW + 1000).toISOString() }, NOW)).toBe(true);
  });

  it("refuses anything already decided, so history is not re-votable", () => {
    for (const decision of ["approved", "vetoed", "expired", null, undefined]) {
      expect(isDecidable({ decision, veto_until: at(60) }, NOW), `decision=${String(decision)}`).toBe(false);
    }
  });

  it("refuses an unreadable deadline even though the list PINS that same row", () => {
    // Deliberate asymmetry, and both halves fail safe: the list shows the row
    // because it might be about to lapse, and the button stays off because the
    // database cannot be shown to accept it.
    const row = { id: "u", decision: "pending", veto_until: null };
    expect(part([row]).urgent[0].deadlineUnknown).toBe(true);
    expect(isDecidable(row, NOW)).toBe(false);
    expect(isDecidable({ ...row, veto_until: "garbage" }, NOW)).toBe(false);
  });

  it("refuses a missing row rather than throwing", () => {
    expect(isDecidable(null, NOW)).toBe(false);
    expect(isDecidable(undefined, NOW)).toBe(false);
  });
});

describe("malformed input", () => {
  it("a non-array or null feed yields empty buckets instead of throwing", () => {
    for (const bad of [null, undefined, {}, "rows", 7]) {
      const v = part(bad);
      expect(v.counts, `rows=${JSON.stringify(bad)}`).toEqual({ urgent: 0, pending: 0, expiredUnreviewed: 0, sinceLastVisit: 0 });
    }
  });

  it("null entries inside the array are skipped, not counted as pending", () => {
    const v = part([null, pending("real", 5), undefined]);
    expect(v.counts.pending).toBe(1);
  });

  it("does not mutate the rows it was handed", () => {
    const row = pending("a", 5);
    const before = JSON.stringify(row);
    part([row]);
    expect(JSON.stringify(row)).toBe(before);
  });
});

describe("last-visit storage", () => {
  const fakeStorage = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
  };

  it("round-trips a timestamp through the storage key the tab actually uses", () => {
    const s = fakeStorage();
    writeLastVisit(NOW, s);
    expect(s.getItem(LAST_VISIT_KEY)).toBe(String(NOW));
    expect(readLastVisit(s)).toBe(NOW);
  });

  it("a storage that throws (private mode) degrades to 'no visit', which shows everything", () => {
    // The safe direction: worst case you re-see an auto-proceed you already saw.
    const hostile = {
      getItem() { throw new Error("SecurityError"); },
      setItem() { throw new Error("SecurityError"); },
    };
    expect(readLastVisit(hostile)).toBe(null);
    expect(() => writeLastVisit(NOW, hostile)).not.toThrow();
  });

  it("an empty or corrupt stored value reads as no visit, not as epoch zero", () => {
    const s = fakeStorage();
    s.setItem(LAST_VISIT_KEY, "");
    expect(readLastVisit(s)).toBe(null);
    s.setItem(LAST_VISIT_KEY, "garbage");
    expect(readLastVisit(s)).toBe(null);
  });
});
