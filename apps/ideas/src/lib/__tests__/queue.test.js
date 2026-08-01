// ─── the review queue's memory ───────────────────────────────────────────────
//
// Ideas is a review queue now: ten at a time, a button for the next ten. The
// thing that can quietly ruin it is this file's subject — seen-state that loses
// a repo the operator wanted back, or forgets everything the next time the
// scanner adds rows. Both are tested here rather than in the component, for the
// same reason selectVisible was lifted out of a useMemo: logic no test can
// reach is logic that ships broken.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  BATCH, MAX_REVIEWED, QUEUE_KEY,
  normalizeQueue, emptyQueue, isReviewed, roundOf, reviewedCount, lastRoundIds,
  markReviewed, undoLastRound, requeue, clearReviewed,
  splitQueue, sortReviewed, arrivedSince,
  serializeQueue, loadQueue, saveQueue,
} from "../queue.js";

const row = (id, extra = {}) => ({ id, full_name: `o/${id}`, first_seen: "2026-07-01T00:00:00.000Z", ...extra });
const ids = (list) => list.map((r) => r.id);

describe("normalizeQueue takes anything and returns something usable", () => {
  it("never throws, whatever it is handed", () => {
    for (const junk of [null, undefined, 0, 7, "", "nonsense", true, NaN, [], {}, () => {}, Symbol.iterator]) {
      expect(() => normalizeQueue(junk), String(junk)).not.toThrow();
      const s = normalizeQueue(junk);
      expect(s.reviewed, String(junk)).toBeInstanceOf(Map);
      expect(Number.isInteger(s.round), String(junk)).toBe(true);
      expect(s.round, String(junk)).toBeGreaterThanOrEqual(0);
    }
  });

  it("reads the shape it writes", () => {
    const s = normalizeQueue({ v: 1, round: 2, at: 1000, reviewed: { a: 1, b: 2, c: 2 } });
    expect(reviewedCount(s)).toBe(3);
    expect(s.round).toBe(2);
    expect(s.at).toBe(1000);
    expect(lastRoundIds(s).sort()).toEqual(["b", "c"]);
  });

  it("reads a HALF-WRITTEN object from an older build — a bare list of ids", () => {
    // The obvious earlier shape. It carries the one fact that matters (these
    // were reviewed) and none of the rounds, so it becomes one round of history
    // rather than being discarded.
    for (const raw of [["a", "b"], { reviewed: ["a", "b"] }]) {
      const s = normalizeQueue(raw);
      expect(isReviewed(s, "a")).toBe(true);
      expect(isReviewed(s, "b")).toBe(true);
      expect(s.round).toBe(1);
    }
  });

  it("keeps a repo whose round number is unreadable, at the OLDEST round", () => {
    // "reviewed" is the fact worth keeping. Round 1 is the safe home for it:
    // an undo of round 4 can never sweep up a row it never contained.
    const s = normalizeQueue({ round: 4, reviewed: { good: 4, weird: "x", nul: null, neg: -3, frac: 2.9 } });
    expect(roundOf(s, "weird")).toBe(1);
    expect(roundOf(s, "nul")).toBe(1);
    expect(roundOf(s, "neg")).toBe(1);
    expect(roundOf(s, "frac")).toBe(2); // floored, still a real round
    expect(lastRoundIds(s)).toEqual(["good"]);
  });

  it("drops ids that are not strings rather than storing a key of 'undefined'", () => {
    const s = normalizeQueue({ reviewed: new Map([["ok", 1], [undefined, 1], [7, 1], ["", 1]]) });
    expect([...s.reviewed.keys()]).toEqual(["ok"]);
  });

  it("DERIVES the round from the stamps it holds, never from the stored counter", () => {
    // A counter running ahead of the map is what makes "undo the last round" a
    // button that does nothing when pressed.
    const s = normalizeQueue({ round: 99, reviewed: { a: 1, b: 2 } });
    expect(s.round).toBe(2);
    expect(lastRoundIds(s)).toEqual(["b"]);
    expect(normalizeQueue({ round: 12, reviewed: {} }).round).toBe(0);
  });

  it("is idempotent, so a normalized state can be handed back in", () => {
    const once = normalizeQueue({ round: 2, at: 5, reviewed: { a: 1, b: 2 } });
    const twice = normalizeQueue(once);
    expect(serializeQueue(twice)).toEqual(serializeQueue(once));
  });

  it("caps a corrupted map by dropping the OLDEST rounds whole", () => {
    const reviewed = {};
    for (let i = 0; i < MAX_REVIEWED + 50; i++) reviewed[`r${i}`] = i < 50 ? 1 : 2;
    const s = normalizeQueue({ reviewed });
    expect(reviewedCount(s)).toBe(MAX_REVIEWED);
    // Round 1 went first; round 2 — the recent one — is untouched.
    expect(isReviewed(s, "r0")).toBe(false);
    expect(isReviewed(s, `r${MAX_REVIEWED + 49}`)).toBe(true);
  });
});

describe("marking a round", () => {
  it("stamps exactly the ids it was given, in a new round", () => {
    const s = markReviewed(emptyQueue(), ["a", "b"], { now: 111 });
    expect(s.round).toBe(1);
    expect(s.at).toBe(111);
    expect(lastRoundIds(s).sort()).toEqual(["a", "b"]);

    const t = markReviewed(s, ["c"], { now: 222 });
    expect(t.round).toBe(2);
    expect(roundOf(t, "a")).toBe(1);
    expect(lastRoundIds(t)).toEqual(["c"]);
  });

  it("refuses to open an EMPTY round", () => {
    // An undo button that undoes nothing is worse than no button.
    const s = markReviewed(emptyQueue(), ["a"], { now: 1 });
    for (const nothing of [[], null, undefined, "a", [null, 7, ""]]) {
      const t = markReviewed(s, nothing, { now: 999 });
      expect(t.round, String(nothing)).toBe(1);
      expect(t.at, String(nothing)).toBe(1);
    }
  });

  it("does not mutate the state it was given", () => {
    const s = markReviewed(emptyQueue(), ["a"], { now: 1 });
    const before = serializeQueue(s);
    markReviewed(s, ["b"], { now: 2 });
    expect(serializeQueue(s)).toEqual(before);
  });

  it("dedupes, so ten cards cannot become eleven marks", () => {
    const s = markReviewed(emptyQueue(), ["a", "a", "b"], { now: 1 });
    expect(reviewedCount(s)).toBe(2);
  });
});

describe("getting them back — the part that makes the button safe", () => {
  it("undoes the last round EXACTLY, leaving earlier rounds alone", () => {
    let s = markReviewed(emptyQueue(), ["a", "b"], { now: 1 });
    s = markReviewed(s, ["c", "d"], { now: 2 });
    const back = undoLastRound(s);
    expect([...back.reviewed.keys()].sort()).toEqual(["a", "b"]);
    expect(back.round).toBe(1);
    // The "arrived since" clock referred to the round we just took back, and we
    // keep no per-round timestamps — so it is cleared rather than left lying.
    expect(back.at).toBe(0);
  });

  it("undoes down to nothing, and is a no-op after that", () => {
    let s = markReviewed(emptyQueue(), ["a"], { now: 1 });
    s = undoLastRound(s);
    expect(reviewedCount(s)).toBe(0);
    expect(s.round).toBe(0);
    expect(serializeQueue(undoLastRound(s))).toEqual(serializeQueue(s));
  });

  it("requeues ONE repo without disturbing the rest of its round", () => {
    const s = markReviewed(emptyQueue(), ["a", "b", "c"], { now: 5 });
    const t = requeue(s, "b");
    expect(isReviewed(t, "b")).toBe(false);
    expect(isReviewed(t, "a")).toBe(true);
    expect(t.round).toBe(1);
    expect(t.at).toBe(5);
  });

  it("keeps the undo button honest when a whole round is requeued away", () => {
    // Round 2 emptied one row at a time. `round` follows the stamps, so the undo
    // now points at round 1 — a round that still exists — instead of at a round
    // with nothing in it.
    let s = markReviewed(emptyQueue(), ["a"], { now: 1 });
    s = markReviewed(s, ["b", "c"], { now: 2 });
    s = requeue(requeue(s, "b"), "c");
    expect(s.round).toBe(1);
    expect(lastRoundIds(s)).toEqual(["a"]);
  });

  it("requeuing something never reviewed changes nothing", () => {
    const s = markReviewed(emptyQueue(), ["a"], { now: 1 });
    expect(serializeQueue(requeue(s, "zzz"))).toEqual(serializeQueue(s));
  });

  it("clears everything when asked, and only when asked", () => {
    const s = clearReviewed();
    expect(reviewedCount(s)).toBe(0);
    expect(s.round).toBe(0);
  });
});

describe("splitting a ranked list into the queue and the rest", () => {
  const list = Array.from({ length: 25 }, (_, i) => row(`r${i}`));

  it("hands over the first BATCH that have not been reviewed, in the caller's order", () => {
    const s = emptyQueue();
    const { queue, waiting, pool, done } = splitQueue(list, s, BATCH);
    expect(queue).toHaveLength(BATCH);
    expect(ids(queue)).toEqual(ids(list.slice(0, BATCH)));
    expect(waiting).toBe(15);
    expect(pool).toHaveLength(25);
    expect(done).toHaveLength(0);
  });

  it("SKIPS what was reviewed rather than paging past it", () => {
    // The bug a cursor-based queue would have: after one round, rows 10-19 are
    // the next ten only if nothing was requeued and nothing new arrived.
    const s = markReviewed(emptyQueue(), ids(list.slice(0, 10)), { now: 1 });
    const { queue, waiting, done } = splitQueue(list, s, BATCH);
    expect(ids(queue)).toEqual(ids(list.slice(10, 20)));
    expect(waiting).toBe(5);
    expect(done).toHaveLength(10);
  });

  it("a repo put back rejoins the queue AT ITS RANK, not at the end", () => {
    const s = requeue(markReviewed(emptyQueue(), ids(list.slice(0, 10)), { now: 1 }), "r3");
    expect(ids(splitQueue(list, s, BATCH).queue)[0]).toBe("r3");
  });

  it("hands over what is left when fewer than BATCH remain, and says nothing is waiting", () => {
    const s = markReviewed(emptyQueue(), ids(list.slice(0, 21)), { now: 1 });
    const { queue, waiting } = splitQueue(list, s, BATCH);
    expect(queue).toHaveLength(4);
    expect(waiting).toBe(0);
  });

  it("returns an empty queue rather than a broken one when everything is reviewed", () => {
    const s = markReviewed(emptyQueue(), ids(list), { now: 1 });
    const { queue, waiting, done, total } = splitQueue(list, s, BATCH);
    expect(queue).toEqual([]);
    expect(waiting).toBe(0);
    expect(done).toHaveLength(25);
    expect(total).toBe(25);
  });

  it("survives junk: no list, no state, a silly size", () => {
    expect(splitQueue(null, null).queue).toEqual([]);
    expect(splitQueue(list, null, "ten").queue).toHaveLength(BATCH);
    expect(splitQueue(list, undefined, 0).queue).toEqual([]);
    expect(splitQueue([{ id: null }, row("ok")], emptyQueue(), 5).queue).toHaveLength(2);
  });

  it("does not mutate the list it was given", () => {
    const before = ids(list);
    splitQueue(list, markReviewed(emptyQueue(), ["r0"], { now: 1 }), BATCH);
    expect(ids(list)).toEqual(before);
  });
});

describe("a scan landing mid-review", () => {
  it("keeps every mark and lets the new rows into the pool", () => {
    // The whole reason state is keyed by id. Forty rows arrive; the ten you
    // reviewed stay reviewed, wherever the ranker now puts them.
    const first = [row("a"), row("b"), row("c")];
    const s = markReviewed(emptyQueue(), ["a", "b"], { now: 1 });
    const afterScan = [row("new1"), row("a"), row("new2"), row("b"), row("c")];
    const { queue, done } = splitQueue(afterScan, s, BATCH);
    expect(ids(queue)).toEqual(["new1", "new2", "c"]);
    expect(ids(done)).toEqual(["a", "b"]);
    expect(ids(splitQueue(first, s, BATCH).queue)).toEqual(["c"]);
  });

  it("counts what arrived since the round opened, and refuses to when it cannot", () => {
    const s = markReviewed(emptyQueue(), ["a"], { now: Date.parse("2026-07-10T00:00:00Z") });
    const rows = [
      row("old", { first_seen: "2026-07-09T00:00:00.000Z" }),
      row("new", { first_seen: "2026-07-11T00:00:00.000Z" }),
      row("undated", { first_seen: null }),
    ];
    expect(arrivedSince(rows, s)).toBe(1);
    // No round has ever been opened, so there is no "since" — null, and the
    // screen says nothing rather than printing a 0 that reads as a measurement.
    expect(arrivedSince(rows, emptyQueue())).toBe(null);
    expect(arrivedSince(rows, undoLastRound(s))).toBe(null);
  });
});

describe("the reviewed list reads newest round first", () => {
  it("orders by round, then by the rank it was handed", () => {
    let s = markReviewed(emptyQueue(), ["a", "b"], { now: 1 });
    s = markReviewed(s, ["c", "d"], { now: 2 });
    // Incoming order is the ranker's; within one round it has to survive.
    const list = [row("a"), row("c"), row("b"), row("d")];
    expect(ids(sortReviewed(list, s))).toEqual(["c", "d", "a", "b"]);
  });

  it("is a total order, so identical data cannot reshuffle between renders", () => {
    const s = markReviewed(emptyQueue(), ["a", "b", "c"], { now: 1 });
    const list = [row("a"), row("b"), row("c")];
    expect(ids(sortReviewed(list, s))).toEqual(ids(sortReviewed([...list], s)));
  });
});

describe("storage", () => {
  const store = new Map();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips", () => {
    const s = markReviewed(markReviewed(emptyQueue(), ["a"], { now: 1 }), ["b"], { now: 2 });
    saveQueue(s);
    expect(serializeQueue(loadQueue())).toEqual(serializeQueue(s));
    expect(JSON.parse(store.get(QUEUE_KEY))).toEqual({ v: 1, round: 2, at: 2, reviewed: { a: 1, b: 2 } });
  });

  it("returns an empty queue when storage holds garbage, rather than throwing on the render path", () => {
    for (const junk of ["{", "null", "3", '"x"', "[1,2,3]", '{"reviewed":5}']) {
      store.set(QUEUE_KEY, junk);
      expect(() => loadQueue(), junk).not.toThrow();
      expect(loadQueue().reviewed, junk).toBeInstanceOf(Map);
    }
  });

  it("keeps working when localStorage throws, which is private mode", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("nope"); },
      setItem: () => { throw new Error("nope"); },
    });
    expect(() => loadQueue()).not.toThrow();
    expect(reviewedCount(loadQueue())).toBe(0);
    const s = markReviewed(emptyQueue(), ["a"], { now: 1 });
    expect(() => saveQueue(s)).not.toThrow();
    expect(reviewedCount(saveQueue(s))).toBe(1); // the session still works
  });
});
