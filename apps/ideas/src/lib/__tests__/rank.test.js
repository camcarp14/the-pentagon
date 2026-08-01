// ─── The feed has to say what a thing IS and why it is worth looking at ──────
//
// Two complaints, both from the screenshot: an agent framework, a bioinformatics
// benchmark and a Roblox script hub sat undifferentiated in one reverse-
// chronological list, and the row at the top was an eight-star first Rust
// project because it happened to be the youngest thing the sweep dated.
//
// Everything below is arithmetic over fields the row already carries, so every
// assertion is checkable by hand against the table in rank.js's header. The
// ones that matter most are the REFUSALS: a repo we cannot measure must come
// back with `score: null` and a sentence, never a number.

import { describe, it, expect } from "vitest";
import {
  categorize, scoreRepo, recommend, interestProfile,
  MIN_STARS, MIN_GAIN, MIN_TRACK_DAYS, RECOMMEND_FLOOR, CATEGORY_LABEL,
} from "../rank.js";

const DAY = 86400000;
const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const seenDaysAgo = (d) => new Date(NOW - d * DAY).toISOString();

const repo = (o) => ({
  id: o.name, name: o.name, full_name: `${o.name}/${o.name}`, hook: "", language: null,
  stars: 1000, stars_at_first_seen: 700, age_days: 30, first_seen: seenDaysAgo(3), ...o,
});

/* ══ categories ═════════════════════════════════════════════════════════════ */

describe("categorize — the three rows that sat in one undifferentiated list", () => {
  it("separates an agent framework, a bioinformatics benchmark and a script hub", () => {
    const agent = categorize({ name: "multigent", hook: "A multi-agent framework for orchestrating LLM agents with tool use, memory and a planner loop.", language: "Python" });
    const bio = categorize({ name: "protfold-bench", hook: "Benchmark suite and dataset for protein structure prediction. Accompanies our paper on single-sequence folding.", language: "Jupyter Notebook" });
    const hub = categorize({ name: "roblox-script-hub", hook: "Roblox script hub with an executor GUI, aimbot and ESP for 40+ games. Updated daily.", language: "Lua" });

    expect(agent.id).toBe("agents");
    expect(bio.id).toBe("science");
    expect(hub.id).toBe("game");
    expect(new Set([agent.id, bio.id, hub.id]).size, "three repos, three buckets").toBe(3);
  });

  it("says HOW it decided, and names the words it matched", () => {
    const c = categorize({ name: "x", hook: "Autonomous coding agent that opens pull requests. MCP server included." });
    expect(c.via).toBe("keywords");
    expect(c.matched).toContain("agent");
    expect(c.why).toMatch(/matched .*in the description/);
  });

  it("lets ONE discriminating word outvote three that travel everywhere", () => {
    // The exact regression this weighting exists for. A flat count read
    // "benchmark", "dataset" and "paper" as 3 against "protein" as 1 and filed a
    // protein-folding benchmark under Models & research. Those three words are
    // in nearly every ML repo; "protein" is in one kind of repo.
    const flatCountWouldSay = ["benchmark", "dataset", "paper"];
    const bio = categorize({ name: "protfold", hook: "Benchmark suite and dataset for protein structure prediction. Accompanies our paper on single-sequence folding." });
    expect(flatCountWouldSay.every((t) => /benchmark|dataset|paper/.test(t))).toBe(true);
    expect(bio.id).toBe("science");
    expect(bio.weight).toBeGreaterThan(3);
  });

  it("still counts, so a pile of weak terms beats one weak term", () => {
    const c = categorize({ name: "x", hook: "Model weights, training datasets and benchmarks. Also a cli." });
    expect(c.id).toBe("research");
  });

  it("breaks an exact tie on declaration order, which is documented as the tiebreak", () => {
    // "trading" (crypto, weight 1) against "terminal" (devtools, weight 1) —
    // a genuine 1–1. Crypto is declared first, so the answer is stable rather
    // than dependent on however the array happened to be built.
    const c = categorize({ name: "x", hook: "A trading terminal." });
    expect(c.weight).toBe(1);
    expect(c.id).toBe("crypto");
  });

  it("falls back to the language ONLY when no keyword matched, and marks it", () => {
    const lang = categorize({ name: "x", hook: "Fun little side project I wrote on a train.", language: "Lua" });
    expect(lang.id).toBe("game");
    expect(lang.via).toBe("language");
    expect(lang.why).toMatch(/no keyword matched/);

    // ...and the description beats the language when it says otherwise.
    const desc = categorize({ name: "x", hook: "A postgres connection pooler with a redis-backed session store.", language: "Lua" });
    expect(desc.id).toBe("infra");
    expect(desc.via).toBe("keywords");
  });

  it("refuses to guess, and says which kind of nothing it had", () => {
    const nodesc = categorize({ name: "x", hook: "", language: null });
    expect(nodesc.id).toBe("other");
    expect(CATEGORY_LABEL.other).toBe("Uncategorised");
    expect(nodesc.why).toMatch(/no description was scraped/);

    const nomatch = categorize({ name: "x", hook: "A thing my friend asked me to make.", language: null });
    expect(nomatch.id).toBe("other");
    expect(nomatch.why).toMatch(/nothing in the description matched/);
  });

  it("matches whole words, so 'go' does not match 'google' and 'cat' does not match 'concatenate'", () => {
    expect(categorize({ name: "x", hook: "Concatenate files. Categorically simple." }).id).toBe("other");
    // …but a real term inside punctuation still matches.
    expect(categorize({ name: "x", hook: "Uses (kubernetes) and [docker]." }).id).toBe("infra");
  });
});

/* ══ the gate ═══════════════════════════════════════════════════════════════ */

describe("scoreRepo refuses to score what it cannot measure", () => {
  const refuse = (o) => scoreRepo(repo(o), { now: NOW });

  it("gives an eight-star repo with no history NO score and a stated reason", () => {
    // The exact row from the screenshot: someone/my-first-repo, 8 stars, 2 days
    // old. A score here would be an invented number.
    const s = refuse({ name: "my-first-repo", stars: 8, stars_at_first_seen: 8, age_days: 2 });
    expect(s.score).toBeNull();
    expect(s.blocked).toContain("only 8 stars in total");
    expect(s.parts).toEqual([]);
  });

  it("refuses a repo first seen minutes ago rather than dividing by almost zero", () => {
    const s = refuse({ name: "just-landed", first_seen: new Date(NOW - 2 * 3600 * 1000).toISOString() });
    expect(s.score).toBeNull();
    expect(s.blocked).toMatch(/first seen 2h ago — too recent/);
    expect(s.blockedKind).toBe("too-new");
  });

  it("refuses a repo with no earlier star count, because a total is not a rate", () => {
    const s = refuse({ name: "mystery", stars: 900, stars_at_first_seen: null });
    expect(s.score).toBeNull();
    expect(s.blocked).toMatch(/no earlier star count/);
  });

  it("refuses a repo that has barely moved since we found it", () => {
    const s = refuse({ name: "flat", stars: 900, stars_at_first_seen: 898 });
    expect(s.score).toBeNull();
    expect(s.blocked).toMatch(/gained 2 stars .* too few to call a trend/);
  });

  it("does not read a missing number as zero", () => {
    // Number(null), Number("") and Number(false) are all 0 and all pass
    // Number.isFinite. Each of these used to become "0 stars, brand new".
    for (const bad of [null, undefined, "", NaN, "n/a", false]) {
      const s = refuse({ name: "bad", stars: bad });
      expect(s.score, String(bad)).toBeNull();
    }
  });

  it("is exactly inclusive at each boundary it documents", () => {
    const ok = { name: "edge", stars: MIN_STARS, stars_at_first_seen: MIN_STARS - MIN_GAIN, age_days: 30, first_seen: seenDaysAgo(MIN_TRACK_DAYS) };
    expect(scoreRepo(repo(ok), { now: NOW }).score).not.toBeNull();
    expect(scoreRepo(repo({ ...ok, stars: MIN_STARS - 1, stars_at_first_seen: MIN_STARS - 1 - MIN_GAIN }), { now: NOW }).score).toBeNull();
    expect(scoreRepo(repo({ ...ok, stars_at_first_seen: MIN_STARS - MIN_GAIN + 1 }), { now: NOW }).score).toBeNull();
  });
});

/* ══ the arithmetic ═════════════════════════════════════════════════════════ */

describe("the 100 points, verified by hand against the table in the header", () => {
  it("scores the worked example the header's ladders say it should", () => {
    // 1000 stars, 700 when first seen 3 days ago, repo 30 days old.
    //   gained    = 300
    //   observed  = 300 / 3        = 100 /day   → PACE  ≥100 → 45
    //   lifetime  = 1000 / 30      = 33.3 /day
    //   accel     = 100 / 33.3     = 3.0×       → ACCEL ≥2   → 20
    //   age 30d                                 → YOUTH ≤60  → 8
    //   nothing saved                           → FIT        → 0
    //                                             total        73
    const s = scoreRepo(repo({ name: "worked" }), { now: NOW });
    expect(s.gained).toBe(300);
    expect(s.observed).toBeCloseTo(100, 6);
    expect(s.lifetime).toBeCloseTo(33.333, 3);
    expect(s.accel).toBeCloseTo(3, 3);
    expect(s.parts.map((p) => [p.key, p.points])).toEqual([["pace", 45], ["accel", 20], ["youth", 8], ["fit", 0]]);
    expect(s.score).toBe(73);
  });

  it("keeps parts[] summing to the score, on every row it scores", () => {
    const rows = [
      repo({ name: "a" }),
      repo({ name: "b", stars: 200, stars_at_first_seen: 190, age_days: 400, first_seen: seenDaysAgo(5) }),
      repo({ name: "c", stars: 90000, stars_at_first_seen: 89000, age_days: 2000, first_seen: seenDaysAgo(20) }),
      repo({ name: "d", age_days: null }),
      repo({ name: "e", age_days: 0 }),
    ];
    for (const r of rows) {
      const s = scoreRepo(r, { now: NOW });
      expect(s.parts.reduce((n, p) => n + p.points, 0), r.name).toBe(s.score);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
    }
  });

  it("scores a slow-but-sharply-accelerating repo above a fast-but-normal one", () => {
    // The distinction the file exists for. `steady` adds more stars per day, but
    // it always has; `waking` is doing four times its own normal.
    const waking = scoreRepo(repo({ name: "waking", stars: 200, stars_at_first_seen: 190, age_days: 400, first_seen: seenDaysAgo(5) }), { now: NOW });
    // 10 gained / 5 days = 2/day → PACE 7; lifetime 0.5 → accel 4.0 → ACCEL 25;
    // 400 days old → YOUTH 0; nothing saved → 0.  total 32
    expect(waking.score).toBe(32);
    expect(waking.parts.find((p) => p.key === "accel").points).toBe(25);
  });

  it("scores acceleration ZERO — with the reason — when the repo's age is missing", () => {
    const s = scoreRepo(repo({ name: "undated", age_days: null }), { now: NOW });
    const accel = s.parts.find((p) => p.key === "accel");
    expect(accel.points).toBe(0);
    expect(accel.note).toMatch(/age is unknown/);
    // …and it is not silently made up elsewhere.
    expect(s.parts.find((p) => p.key === "youth").points).toBe(0);
  });

  it("never divides by a zero lifetime pace", () => {
    const s = scoreRepo(repo({ name: "zeroage", age_days: 0 }), { now: NOW });
    expect(s.accel).toBeNull();
    expect(Number.isFinite(s.score)).toBe(true);
    expect(s.parts.find((p) => p.key === "accel").note).toMatch(/lifetime pace is zero/);
  });

  it("takes `now` from the caller — no clock inside", () => {
    const r = repo({ name: "pure" });
    const early = scoreRepo(r, { now: NOW });
    const later = scoreRepo(r, { now: NOW + 30 * DAY });
    expect(early.observed).toBeGreaterThan(later.observed);
    expect(scoreRepo(r, { now: NOW })).toEqual(early);
  });
});

/* ══ fit, which must not pretend ════════════════════════════════════════════ */

describe("fit is the operator's own saves, and zero is not a neutral half", () => {
  const rows = [
    repo({ name: "agentic", hook: "An agent framework with tool use.", language: "Python" }),
    repo({ name: "another-agent", hook: "Agentic planner loop for llm tool calls.", language: "Python" }),
    repo({ name: "shader", hook: "Voxel terrain for the godot game engine.", language: "C++" }),
  ];

  it("says plainly that there is no profile when nothing is saved", () => {
    const s = scoreRepo(rows[0], { now: NOW });
    const fit = s.parts.find((p) => p.key === "fit");
    expect(fit.points).toBe(0);
    expect(fit.note).toMatch(/you have not saved anything yet/);
  });

  it("pays a category match and a language match, and names them", () => {
    const interests = interestProfile(rows, new Set(["agentic"]));
    expect(interests.count).toBe(1);
    expect([...interests.categories]).toEqual(["agents"]);

    const hit = scoreRepo(rows[1], { now: NOW, interests });
    expect(hit.parts.find((p) => p.key === "fit").points).toBe(15); // 10 category + 5 language
    expect(hit.parts.find((p) => p.key === "fit").note).toMatch(/Agents & LLM apps/);

    const miss = scoreRepo(rows[2], { now: NOW, interests });
    expect(miss.parts.find((p) => p.key === "fit").points).toBe(0);
    expect(miss.parts.find((p) => p.key === "fit").note).toMatch(/nothing you have saved/);
  });

  it("never pays fit for landing in Uncategorised alongside another Uncategorised save", () => {
    // "you both have no category" is not a shared interest.
    const blanks = [repo({ name: "b1", hook: "" }), repo({ name: "b2", hook: "" })];
    const interests = interestProfile(blanks, new Set(["b1"]));
    expect(scoreRepo(blanks[1], { now: NOW, interests }).parts.find((p) => p.key === "fit").points).toBe(0);
  });
});

/* ══ the reason printed on the row ══════════════════════════════════════════ */

describe("the sentence on the row is built only from what scored", () => {
  it("quotes the numbers the ladders actually read", () => {
    const s = scoreRepo(repo({ name: "worked" }), { now: NOW });
    expect(s.reason).toContain("+300 stars in the 3 days since the scan found it");
    expect(s.reason).toContain("100/day");
    expect(s.reason).toContain("3.0× its own lifetime pace");
  });

  it("does not claim momentum for a repo running SLOWER than its own average", () => {
    // The ≥0.4 rung pays 3 points at half the lifetime pace, which is fine in a
    // score and a lie in a sentence: "0.5× its own lifetime pace" printed in a
    // list of reasons to look reads as a boast about a slowdown. It scores; it
    // is not narrated.
    const s = scoreRepo(repo({ name: "coasting", stars: 1000, stars_at_first_seen: 940, age_days: 30, first_seen: seenDaysAgo(3) }), { now: NOW });
    expect(s.accel).toBeCloseTo(0.6, 2);
    expect(s.parts.find((p) => p.key === "accel").points).toBe(3);
    expect(s.reason).not.toMatch(/lifetime pace/);
    // …and the part is still there, so the addition on the row still checks out.
    expect(s.parts.reduce((n, p) => n + p.points, 0)).toBe(s.score);
  });

  it("omits acceleration from the sentence when acceleration scored nothing", () => {
    const s = scoreRepo(repo({ name: "slow", stars: 5000, stars_at_first_seen: 4900, age_days: 20, first_seen: seenDaysAgo(10) }), { now: NOW });
    // observed 10/day against a lifetime of 250/day → accel 0.04 → 0 points.
    expect(s.parts.find((p) => p.key === "accel").points).toBe(0);
    expect(s.reason).not.toMatch(/lifetime pace/);
    expect(s.reason).toContain("+100 stars");
  });

  it("carries no NaN, undefined or Infinity into anything it prints", () => {
    for (const r of [repo({ name: "a" }), repo({ name: "b", age_days: 0 }), repo({ name: "c", age_days: null })]) {
      const s = scoreRepo(r, { now: NOW });
      const text = s.reason + s.parts.map((p) => p.note).join(" ");
      expect(text, r.name).not.toMatch(/NaN|undefined|Infinity/);
    }
  });
});

/* ══ the list, and the honest empty ═════════════════════════════════════════ */

describe("recommend", () => {
  const strong = repo({ name: "strong", hook: "An agent framework.", stars: 4000, stars_at_first_seen: 3400, age_days: 12, first_seen: seenDaysAgo(3) });
  const weak = repo({ name: "weak", stars: 5000, stars_at_first_seen: 4940, age_days: 900, first_seen: seenDaysAgo(20) });

  it("returns picks above the floor, best first, with the reason on each", () => {
    const { picks, reason } = recommend([weak, strong], { now: NOW });
    expect(picks.map((p) => p.id)).toEqual(["strong"]);
    expect(picks[0].score).toBeGreaterThanOrEqual(RECOMMEND_FLOOR);
    expect(picks[0].reason).toMatch(/\+600 stars/);
    expect(reason).toMatch(/clear 30\/100/);
  });

  it("says plainly when NOTHING can be ranked, and which gate did it", () => {
    const fresh = [1, 2, 3].map((i) => repo({ name: `f${i}`, first_seen: new Date(NOW - 3600 * 1000).toISOString() }));
    const { picks, reason } = recommend(fresh, { now: NOW });
    expect(picks).toEqual([]);
    expect(reason).toMatch(/Nothing here can be ranked yet/);
    expect(reason).toMatch(/3 of 3 repos are first seen less than 12h ago/);
    expect(reason).toMatch(/at least 12h of history, 50 stars and 5 gained/);
  });

  it("distinguishes 'cannot measure' from 'measured, and it is not interesting'", () => {
    const { picks, reason } = recommend([weak], { now: NOW });
    expect(picks).toEqual([]);
    expect(reason).toMatch(/1 of 1 repos have enough history to rank/);
    expect(reason).toMatch(/the strongest is weak\/weak at \d+/);
    expect(reason).not.toMatch(/Nothing here can be ranked/);
  });

  it("counts what CLEARS the floor, not what fits on the screen", () => {
    // `limit` is a display budget — two picks on a phone, three on a desktop —
    // and the sentence is a claim about the feed. Counting after the slice made
    // the phone say "2 of 4 repos clear 30/100" on a feed where three did.
    const many = [1, 2, 3].map((i) => repo({
      name: `s${i}`, hook: "An agent framework.",
      stars: 4000 + i, stars_at_first_seen: 3400, age_days: 12, first_seen: seenDaysAgo(3),
    })).concat(weak);
    const { picks, reason, above } = recommend(many, { now: NOW, limit: 2 });
    expect(picks).toHaveLength(2);
    expect(above).toBe(3);
    expect(reason).toMatch(/3 of 4 repos clear 30\/100/);
    expect(reason).toMatch(/the top 2 are here/);
    // …and with room for all of them, no dangling clause.
    expect(recommend(many, { now: NOW, limit: 5 }).reason).not.toMatch(/top \d+ are here/);
  });

  it("says the feed is empty when the feed is empty", () => {
    expect(recommend([], { now: NOW }).reason).toMatch(/feed is empty/);
  });

  it("orders totally, so identical data does not reshuffle between renders", () => {
    const tied = ["b", "a", "c"].map((n) => repo({ name: n }));
    const once = recommend(tied, { now: NOW, limit: 3 }).picks.map((p) => p.id);
    const twice = recommend([...tied].reverse(), { now: NOW, limit: 3 }).picks.map((p) => p.id);
    expect(once).toEqual(["a", "b", "c"]);
    expect(twice).toEqual(once);
  });

  it("scores every row, including the ones it will not recommend", () => {
    const { scored } = recommend([strong, weak, repo({ name: "tiny", stars: 8, stars_at_first_seen: 8 })], { now: NOW });
    expect(scored.size).toBe(3);
    expect(scored.get("tiny").score).toBeNull();
    expect(scored.get("tiny").blocked).toContain("only 8 stars");
  });

  it("does not mutate what it is given", () => {
    const rows = [strong, weak];
    const before = JSON.stringify(rows);
    recommend(rows, { now: NOW });
    expect(JSON.stringify(rows)).toBe(before);
  });
});
