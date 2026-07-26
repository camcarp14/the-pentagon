import { describe, it, expect } from "vitest";
import {
  buildQueue, queueSummary, preparationBudget, excerpt,
  fromContentDraft, fromOutreachDraft, KIND, STALE_AFTER_DAYS,
} from "../queue.js";

const NOW = Date.parse("2026-07-26T00:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

const content = (over = {}) => ({
  id: "c1",
  title: "Where Seed Phrases Come From",
  summary: "A plain-English explanation of BIP-39.",
  body_html: "<p>Long body</p>",
  rationale: "covers the 'what is a seed phrase' query cluster",
  blog_handle: "news",
  created_at: daysAgo(1),
  ...over,
});

const outreach = (over = {}) => ({
  id: "o1",
  draft_subject: "Your Google Ads spend",
  draft_body: "Noticed you're bidding on your own brand terms.",
  business_name: "Acme Dental",
  contact_name: "Pat",
  contact_email: "pat@acme.example",
  prospect_brief: "spends on brand terms",
  brief_callouts: "brand-term waste",
  created_at: daysAgo(1),
  ...over,
});

describe("excerpt()", () => {
  it("leaves short text alone", () => {
    expect(excerpt("short", 180)).toBe("short");
  });
  it("collapses whitespace", () => {
    expect(excerpt("a   b\n\nc")).toBe("a b c");
  });
  it("does not cut mid-word", () => {
    const out = excerpt("aaaa bbbb cccc dddd", 12);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toBe("aaaa bbbb…");
  });
  it("still truncates when there is no usable space", () => {
    const out = excerpt("a".repeat(50), 10);
    expect(out).toBe(`${"a".repeat(10)}…`);
  });
  it("survives null/undefined", () => {
    expect(excerpt(null)).toBe("");
    expect(excerpt(undefined)).toBe("");
  });
});

describe("fromContentDraft()", () => {
  it("maps a row and marks it tier 2", () => {
    const item = fromContentDraft(content(), NOW);
    expect(item.kind).toBe(KIND.CONTENT);
    expect(item.tier).toBe(2);
    expect(item.ageDays).toBe(1);
    expect(item.stale).toBe(false);
  });
  it("strips HTML when there is no summary", () => {
    const item = fromContentDraft(content({ summary: "", body_html: "<p>Hello <b>world</b></p>" }), NOW);
    expect(item.preview).not.toMatch(/</);
    expect(item.preview).toContain("Hello");
  });
  it("falls back to a title rather than rendering blank", () => {
    expect(fromContentDraft(content({ title: "" }), NOW).title).toBe("Untitled article");
  });
});

describe("fromOutreachDraft()", () => {
  it("carries the recipient through for the send path", () => {
    const item = fromOutreachDraft(outreach(), NOW);
    expect(item.to).toBe("pat@acme.example");
    expect(item.target).toBe("Acme Dental");
  });
  it("degrades through name then email when the business is unknown", () => {
    expect(fromOutreachDraft(outreach({ business_name: "" }), NOW).target).toBe("Pat");
    expect(fromOutreachDraft(outreach({ business_name: "", contact_name: "" }), NOW).target).toBe("pat@acme.example");
  });
});

describe("staleness", () => {
  it("marks outbound stale after a week but content still fresh at the same age", () => {
    const age = STALE_AFTER_DAYS[KIND.OUTBOUND] + 1;
    expect(fromOutreachDraft(outreach({ created_at: daysAgo(age) }), NOW).stale).toBe(true);
    expect(fromContentDraft(content({ created_at: daysAgo(age) }), NOW).stale).toBe(false);
  });

  it("does not mark an item stale exactly on the boundary", () => {
    const item = fromOutreachDraft(outreach({ created_at: daysAgo(STALE_AFTER_DAYS[KIND.OUTBOUND]) }), NOW);
    expect(item.stale).toBe(false);
  });

  it("treats an unparseable date as not stale rather than instantly expired", () => {
    const item = fromOutreachDraft(outreach({ created_at: "garbage" }), NOW);
    expect(item.ageDays).toBeNull();
    expect(item.stale).toBe(false);
  });
});

describe("buildQueue()", () => {
  it("puts outbound above content", () => {
    const q = buildQueue({ contentDrafts: [content()], outreachDrafts: [outreach()], now: NOW });
    expect(q.map((i) => i.kind)).toEqual([KIND.OUTBOUND, KIND.CONTENT]);
  });

  it("orders oldest first within a kind so nothing starves", () => {
    const q = buildQueue({
      outreachDrafts: [outreach({ id: "new", created_at: daysAgo(1) }), outreach({ id: "old", created_at: daysAgo(5) })],
      now: NOW,
    });
    expect(q.map((i) => i.id)).toEqual(["old", "new"]);
  });

  it("sinks stale items below live ones even though they are older", () => {
    const q = buildQueue({
      outreachDrafts: [outreach({ id: "stale", created_at: daysAgo(30) }), outreach({ id: "live", created_at: daysAgo(2) })],
      now: NOW,
    });
    expect(q.map((i) => i.id)).toEqual(["live", "stale"]);
  });

  it("keeps stale items in the list rather than dropping them", () => {
    const q = buildQueue({ outreachDrafts: [outreach({ created_at: daysAgo(60) })], now: NOW });
    expect(q).toHaveLength(1);
    expect(q[0].stale).toBe(true);
  });

  it("sorts an unparseable date last instead of to the front", () => {
    const q = buildQueue({
      outreachDrafts: [outreach({ id: "bad", created_at: "nope" }), outreach({ id: "good", created_at: daysAgo(3) })],
      now: NOW,
    });
    expect(q.map((i) => i.id)).toEqual(["good", "bad"]);
  });

  it("handles an empty queue", () => {
    expect(buildQueue({ now: NOW })).toEqual([]);
  });
});

describe("queueSummary()", () => {
  it("counts live work separately from stale", () => {
    const q = buildQueue({
      contentDrafts: [content()],
      outreachDrafts: [outreach(), outreach({ id: "o2", created_at: daysAgo(40) })],
      now: NOW,
    });
    const s = queueSummary(q);
    expect(s).toMatchObject({ total: 3, waiting: 2, stale: 1, content: 1, outbound: 1 });
  });

  it("reports the oldest live item's age", () => {
    const q = buildQueue({ outreachDrafts: [outreach({ created_at: daysAgo(4) })], now: NOW });
    expect(queueSummary(q).oldestAgeDays).toBe(4);
  });

  it("is all zeroes for an empty queue", () => {
    expect(queueSummary([])).toMatchObject({ total: 0, waiting: 0, stale: 0, oldestAgeDays: 0 });
  });
});

describe("preparationBudget()", () => {
  it("allows the daily allowance when nothing is pending", () => {
    expect(preparationBudget({ perDay: 3 })).toBe(3);
  });

  it("subtracts what was already prepared today", () => {
    expect(preparationBudget({ perDay: 3, preparedToday: 2 })).toBe(1);
  });

  it("stops at zero rather than going negative", () => {
    expect(preparationBudget({ perDay: 3, preparedToday: 99 })).toBe(0);
  });

  it("throttles on backlog even when the daily allowance is untouched", () => {
    // The scarce resource is the operator's attention, not the API quota.
    expect(preparationBudget({ perDay: 5, pendingTotal: 25, maxPending: 25 })).toBe(0);
  });

  it("takes whichever limit binds first", () => {
    expect(preparationBudget({ perDay: 5, pendingTotal: 23, maxPending: 25 })).toBe(2);
  });

  it("returns 0 for a nonsense perDay instead of Infinity", () => {
    for (const bad of [NaN, "abc", 0, -1, undefined, null]) {
      expect(preparationBudget({ perDay: bad })).toBe(0);
    }
  });
});
