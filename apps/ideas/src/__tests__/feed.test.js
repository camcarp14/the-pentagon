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

  // "Gaining fastest" is ordered by the rate the CARD PRINTS — rank.js's
  // (stars − stars_at_first_seen) ÷ days observed — and not by the pipeline's
  // own star_velocity column, which the card does not show anywhere. This is the
  // same rule the "Newest" fix above established: the label, the order and the
  // visible number have to be the same quantity, or the list looks broken
  // against the only figure on screen. The measured values arrive in `scored`,
  // which is the Map recommend() returns.
  const scored = new Map([
    ["a", { observed: 99, score: 40 }],
    ["b", { observed: 1, score: 55 }],
    ["c", { observed: 50, score: null }], // measured nothing: no score
  ]);

  it("gaining-fastest is by the measured rate, highest first", () => {
    expect(ids(selectVisible(rows, { tab: "ideas", sort: "popping", range: 0, saved: NONE, scored })))
      .toEqual(["a", "c", "b"]);
  });

  it("sorts a row we could NOT measure last, rather than reading it as zero", () => {
    // -Infinity, not 0: a repo with no history must not land among the repos
    // that genuinely gained nothing.
    const partial = new Map([["b", { observed: 0, score: 0 }]]);
    expect(ids(selectVisible(rows, { tab: "ideas", sort: "popping", range: 0, saved: NONE, scored: partial })))
      .toEqual(["b", "a", "c"]); // b measured (0), then a and c unmeasured by age
  });

  it("recommended is by the computed score, unscorable rows last", () => {
    expect(ids(selectVisible(rows, { tab: "ideas", sort: "recommended", range: 0, saved: NONE, scored })))
      .toEqual(["b", "a", "c"]);
  });

  it("stars is by stars", () => {
    expect(ids(selectVisible(rows, { tab: "ideas", sort: "stars", range: 0, saved: NONE }))).toEqual(["c", "b", "a"]);
  });

  it("a sort never smuggles a row past the window", () => {
    for (const sort of ["newest", "popping", "stars", "recommended"]) {
      expect(ids(selectVisible(rows, { tab: "ideas", sort, range: 30, saved: NONE, scored })).sort(), sort)
        .toEqual(["a", "b"]);
    }
  });

  it("orders totally, so identical data cannot reshuffle between renders", () => {
    // Every comparator falls through to age, then first_seen, then id. Without
    // the id at the end these three tie on everything and the order is whatever
    // the input array happened to be.
    const tied = ["z", "m", "a"].map((id) => row(id, 5, { stars: 100 }));
    for (const sort of ["newest", "popping", "stars", "recommended"]) {
      const forwards = ids(selectVisible(tied, { tab: "ideas", sort, range: 0, saved: NONE }));
      const backwards = ids(selectVisible([...tied].reverse(), { tab: "ideas", sort, range: 0, saved: NONE }));
      expect(forwards, sort).toEqual(["a", "m", "z"]);
      expect(backwards, sort).toEqual(forwards);
    }
  });
});

describe("the filters the three stacked bars became", () => {
  const rows = [
    row("agent", 5, { hook: "A multi-agent framework for llm tool calls.", language: "Python" }),
    row("bio", 5, { hook: "Protein folding benchmark and genomics dataset.", language: "Python" }),
    row("hub", 5, { hook: "Roblox script hub with an executor and aimbot.", language: "Lua" }),
  ];

  it("filters by a derived category", () => {
    const at = (category) => ids(selectVisible(rows, { tab: "ideas", sort: "newest", range: 0, saved: NONE, category }));
    expect(at("agents")).toEqual(["agent"]);
    expect(at("science")).toEqual(["bio"]);
    expect(at("game")).toEqual(["hub"]);
    expect(at("all").sort()).toEqual(["agent", "bio", "hub"]);
  });

  it("searches the name, the description and the language", () => {
    const at = (query) => ids(selectVisible(rows, { tab: "ideas", sort: "newest", range: 0, saved: NONE, query }));
    expect(at("roblox")).toEqual(["hub"]);      // description
    expect(at("bio")).toEqual(["bio"]);         // name
    expect(at("lua")).toEqual(["hub"]);         // language
    expect(at("  AGENT  ")).toEqual(["agent"]); // trimmed and case-folded
    expect(at("")).toHaveLength(3);
    expect(at("nothing-matches-this")).toEqual([]);
  });

  it("stacks with the window and the tab rather than replacing them", () => {
    const mixed = [
      row("young", 3, { hook: "An llm agent.", language: "Python" }),
      row("old", 300, { hook: "An llm agent.", language: "Python" }),
    ];
    expect(ids(selectVisible(mixed, { tab: "ideas", sort: "newest", range: 7, saved: NONE, category: "agents" })))
      .toEqual(["young"]);
    expect(ids(selectVisible(mixed, { tab: "saved", sort: "newest", range: 0, saved: new Set(["old"]), category: "agents" })))
      .toEqual(["old"]);
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
