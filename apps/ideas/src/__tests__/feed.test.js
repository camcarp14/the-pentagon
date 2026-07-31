// ─── the filters have to actually filter ─────────────────────────────────────
//
// Both bugs here were reported from a phone, not caught here, because the logic
// lived inside a useMemo that no test could reach:
//
//   · "Newest" listed a 17-day-old repo above an 11-day-old one. It sorted by
//     first_seen — when the scan found it — and since one scan stamps a whole
//     batch with the same timestamp, the comparison fell through to score. The
//     card prints the repo's AGE, so the order looked arbitrary against the only
//     number on screen.
//   · The day windows kept rows they could not measure. `(r.age_days ?? 0) <= range`
//     reads a missing age as zero, i.e. brand new, so an undated row passed 7d.

import { describe, it, expect } from "vitest";
import { selectVisible } from "../Root.jsx";

const NONE = new Set();
// One scan stamps every row it adds with the SAME first_seen — that is what made
// the old tiebreak load-bearing, so the fixture has to reproduce it.
const BATCH = "2026-07-31T04:00:00.000Z";
const row = (id, age, extra = {}) => ({
  id, full_name: `o/${id}`, owner: "o", name: id,
  age_days: age, first_seen: BATCH, stars: 100, star_velocity: 1, score: 50, ...extra,
});

const ids = (list) => list.map((r) => r.id);

describe("newest", () => {
  it("puts the youngest repo first — the number the card actually shows", () => {
    // The reported order, verbatim: multigent 17d sat above pireel 11d.
    const rows = [row("multigent", 17, { score: 90 }), row("pireel", 11, { score: 10 }), row("tura", 3, { score: 20 })];
    expect(ids(selectVisible(rows, { tab: "ideas", sort: "newest", range: 30, saved: NONE })))
      .toEqual(["tura", "pireel", "multigent"]);
  });

  it("does not let score decide the order within one scan batch", () => {
    // The exact mechanism of the bug: identical first_seen, so the old
    // comparator's only live term was score.
    const rows = [row("high", 20, { score: 999 }), row("low", 2, { score: 0 })];
    expect(ids(selectVisible(rows, { tab: "ideas", sort: "newest", range: 0, saved: NONE })))
      .toEqual(["low", "high"]);
  });

  it("sorts an undated repo last, never first", () => {
    const rows = [row("undated", null), row("dated", 40)];
    expect(ids(selectVisible(rows, { tab: "ideas", sort: "newest", range: 0, saved: NONE })))
      .toEqual(["dated", "undated"]);
  });
});

describe("the day windows", () => {
  it("keeps only what is actually inside the window", () => {
    const rows = [row("d3", 3), row("d20", 20), row("d60", 60), row("d200", 200)];
    const at = (range) => ids(selectVisible(rows, { tab: "ideas", sort: "newest", range, saved: NONE }));
    expect(at(7)).toEqual(["d3"]);
    expect(at(30)).toEqual(["d3", "d20"]);
    expect(at(90)).toEqual(["d3", "d20", "d60"]);
    expect(at(0), "All keeps everything").toEqual(["d3", "d20", "d60", "d200"]);
  });

  it("is inclusive at the boundary", () => {
    const rows = [row("exactly7", 7), row("just8", 8)];
    expect(ids(selectVisible(rows, { tab: "ideas", sort: "newest", range: 7, saved: NONE }))).toEqual(["exactly7"]);
  });

  it("DROPS a row whose age is unknown, rather than treating it as brand new", () => {
    // The defect: `?? 0` made every one of these pass every window.
    for (const bad of [null, undefined, "", "n/a", NaN]) {
      const rows = [row("known", 3), row("unknown", bad)];
      expect(ids(selectVisible(rows, { tab: "ideas", sort: "newest", range: 7, saved: NONE })), String(bad))
        .toEqual(["known"]);
      // …but "All" still shows it, because there the window makes no claim.
      expect(ids(selectVisible(rows, { tab: "ideas", sort: "newest", range: 0, saved: NONE })), String(bad))
        .toContain("unknown");
    }
  });
});

describe("the other sorts still work, and still respect the window", () => {
  const rows = [
    row("a", 3, { stars: 10, star_velocity: 99 }),
    row("b", 20, { stars: 900, star_velocity: 1 }),
    row("c", 200, { stars: 5000, star_velocity: 50 }),
  ];
  it("popping is by star velocity", () => {
    expect(ids(selectVisible(rows, { tab: "ideas", sort: "popping", range: 0, saved: NONE }))).toEqual(["a", "c", "b"]);
  });
  it("stars is by stars", () => {
    expect(ids(selectVisible(rows, { tab: "ideas", sort: "stars", range: 0, saved: NONE }))).toEqual(["c", "b", "a"]);
  });
  it("a sort never smuggles a row past the window", () => {
    for (const sort of ["newest", "popping", "stars"]) {
      expect(ids(selectVisible(rows, { tab: "ideas", sort, range: 30, saved: NONE })).sort(), sort)
        .toEqual(["a", "b"]);
    }
  });
});

describe("saved", () => {
  it("shows only saved rows, and still sorts and filters them", () => {
    const rows = [row("keep", 20), row("drop", 5), row("old", 200)];
    const saved = new Set(["keep", "old"]);
    expect(ids(selectVisible(rows, { tab: "saved", sort: "newest", range: 0, saved }))).toEqual(["keep", "old"]);
    expect(ids(selectVisible(rows, { tab: "saved", sort: "newest", range: 30, saved }))).toEqual(["keep"]);
  });
});

describe("it does not mutate what it is given", () => {
  it("leaves the caller's array in its original order", () => {
    const rows = [row("z", 90), row("a", 1)];
    const before = ids(rows);
    selectVisible(rows, { tab: "ideas", sort: "newest", range: 0, saved: NONE });
    expect(ids(rows)).toEqual(before);
  });
});
