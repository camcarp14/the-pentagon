// ═══════════════════════════════════════════════════════════════════════════
// THE RANKER — what to look at first, out of five hundred repos, and why.
//
// The feed is the scanner's whole catch in reverse-chronological order, which
// is a firehose and not a tool: an agent framework, a bioinformatics benchmark
// and a Roblox script hub sit in one undifferentiated list, and the row at the
// top is whatever the last sweep happened to date youngest — often somebody's
// eight-star first Rust project. This file is the correction, and it has two
// jobs.
//
//   1. CATEGORISE, from what is already on the row. Language is free. A keyword
//      pass over the scraped description does the rest. Nothing is invented and
//      nothing is fetched.
//   2. RECOMMEND, from numbers the row already carries, with the reason printed
//      next to the score. "Trending: 290 stars in 3 days, 4.1x its own lifetime
//      pace" is a recommendation. A sparkle icon is not.
//
// Pure. No fetch, no DOM, no Date.now() — `now` is passed in (ms epoch) or
// defaults to the clock only at the outermost call. Nulls, empty strings and
// NaN are normal inputs, not errors.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE GATE, WHICH COMES BEFORE THE SCORE
//
// A repo is only rankable if we have the evidence to rank it. This is the part
// that keeps the file honest, because the easy version of this feature scores
// everything and lets a repo with eight stars and no history sort somewhere in
// the middle on a number that measured nothing. All four must hold:
//
//   · first_seen and stars_at_first_seen are both present   — without an earlier
//     star count there is no rate, only a total.
//   · at least MIN_TRACK_DAYS (12h) of observation          — a rate over twenty
//     minutes is division by almost zero.
//   · at least MIN_GAIN (5) stars gained while we watched   — below that the
//     "rate" is one person finding it twice.
//   · at least MIN_STARS (50) stars in total                — the pace of a repo
//     nobody has found is noise, however fast it looks.
//
// A row that fails the gate gets `score: null` and a `blocked` string naming the
// input that is missing, in the row's own numbers. It never gets a default, a
// neutral half, or a zero that sorts alongside a real zero.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE 100 POINTS, IN FULL — a reader must be able to verify a score by eye.
// parts[] always sums to score. Every ladder is "first threshold met wins".
//
//   PACE  stars per day since the scan first saw it ................... 0–45
//     observed = (stars − stars_at_first_seen) ÷ days tracked
//        ≥100 →45   ≥50 →38   ≥25 →30   ≥10 →22   ≥4 →14   ≥1 →7   else 0
//     The single most direct measurement available: people are finding this
//     NOW, counted over a window we ourselves observed rather than a number
//     the pipeline handed us.
//
//   ACCELERATION  that pace against the repo's own lifetime pace ...... 0–25
//     lifetime = stars ÷ age_days,  accel = observed ÷ lifetime
//        ≥4 →25   ≥2 →20   ≥1.25 →14   ≥0.8 →8   ≥0.4 →3   else 0
//     A DIFFERENCE would be wrong here and a RATIO is right, because the two
//     quantities have the same units and the question is "how many times its
//     own normal". Guarded against a zero lifetime (age_days 0 or missing), in
//     which case the part scores 0 and says which input was absent.
//
//   YOUTH  how long the repo has existed ............................. 0–15
//        ≤7d →15   ≤21d →12   ≤60d →8   ≤180d →4   else 0
//     A four-year-old project adding forty stars a day is a release, not a
//     discovery. Both are interesting; only one is what this feed is for.
//
//   FIT  does it land where you have already saved things ............. 0–15
//        category matches a category you have saved   →10
//        language matches a language you have saved   →5   (both stack)
//     The ONLY interest signal in the building is the operator's own saves, so
//     that is the only one used. With nothing saved the part is 0 and says so —
//     it is not silently redistributed into the other three, because that would
//     make an empty save list look like an opinion.
//
// A recommendation must also clear RECOMMEND_FLOOR (30/100). Clearing the gate
// means we can measure a repo; clearing the floor means the measurement is worth
// the operator's attention. When nothing clears either, `recommend` returns an
// empty list and a sentence saying which of the two it was, with counts.
// ═══════════════════════════════════════════════════════════════════════════

export const MIN_TRACK_DAYS = 0.5;
export const MIN_GAIN = 5;
export const MIN_STARS = 50;
export const RECOMMEND_FLOOR = 30;

const DAY_MS = 86400000;

/* ── numbers that refuse to lie ─────────────────────────────────────────────
 *
 * Number(null), Number("") and Number(false) are all 0 and all pass
 * Number.isFinite, which is exactly how "unknown age reads as brand new"
 * shipped in selectVisible once already (see Root.jsx). Rejecting the empty
 * cases BEFORE Number() sees them is the whole of the fix, and it belongs here
 * too because every ladder below divides by something. */
export function num(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const ms = (ts) => {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : null;
};

/** First threshold met wins; `steps` is [cutoff, points] descending by cutoff. */
const ladder = (v, steps) => {
  for (const [cut, pts] of steps) if (v >= cut) return pts;
  return 0;
};

/* ══ CATEGORIES ═════════════════════════════════════════════════════════════
 *
 * Derived from the row, never authored per repo. Two passes:
 *
 *   1. KEYWORDS over `${name} ${description}`, scored. Each category owns two
 *      lists and the highest total wins.
 *
 *        strong (3 points each) — a word that essentially only occurs in one
 *          domain: "protein", "roblox", "solana", "kubernetes", "llm".
 *        terms  (1 point each)  — a word that belongs to the domain but travels:
 *          "benchmark", "paper", "model", "cli", "trading", "game".
 *
 *      The weighting is the whole of the second pass at this file. A flat count
 *      put "Benchmark suite and dataset for protein structure prediction,
 *      accompanies our paper on single-sequence folding" in *Models & research*
 *      3–2, because "benchmark", "dataset" and "paper" outnumbered "protein" —
 *      three words that appear in nearly every ML repo beating the one word that
 *      only ever appears in a biology one. Weighting is not a fudge factor here;
 *      it is the difference between counting words and reading them.
 *
 *      Ties fall back to DECLARATION ORDER, which is therefore load-bearing and
 *      runs most-specific-first. That keeps the answer stable rather than
 *      dependent on however the array happened to be built.
 *
 *   2. LANGUAGE, but only when no keyword scored at all. Lua is nearly always a
 *      game script here and Jupyter is nearly always research, but "nearly
 *      always" is a weak signal and it must not beat the description saying
 *      otherwise. A language-derived category is marked `via: "language"` so a
 *      caller can tell the two apart and say so on the row.
 *
 * Anything that matches neither is `other` — "Uncategorised" — with a stated
 * reason. It is not shuffled into the nearest plausible bucket.
 *
 * Word-boundary matched, so "cat" does not match "concatenate" and "go" does
 * not match "google". Multi-word terms are matched as phrases. */

export const STRONG_WEIGHT = 3;

export const CATEGORIES = [
  { id: "agents", label: "Agents & LLM apps",
    strong: ["agent", "agents", "agentic", "llm", "llms", "gpt", "chatbot", "copilot", "rag", "retrieval-augmented", "mcp", "langchain", "multi-agent"],
    terms: ["claude", "prompt", "prompts", "embedding", "embeddings", "vector store", "vector database", "fine-tune", "fine-tuning", "tool call", "tool calls", "tool use", "inference", "planner"] },
  { id: "science", label: "Science & bio",
    strong: ["bioinformatics", "genome", "genomic", "genomics", "protein", "rna", "dna", "molecular", "neuroscience", "single-cell", "sequencing", "clinical", "biology", "hippocampus", "chemistry", "astronomy"],
    terms: ["physics", "folding", "atlas", "assay", "cell", "cells"] },
  { id: "research", label: "Models & research",
    strong: ["arxiv", "diffusion", "pytorch", "tensorflow", "transformer", "transformers", "reinforcement learning", "sota", "fine-tuned"],
    terms: ["model", "models", "dataset", "datasets", "benchmark", "benchmarks", "paper", "papers", "neural", "training", "reproduced", "weights"] },
  { id: "crypto", label: "Crypto & trading",
    strong: ["blockchain", "solana", "ethereum", "bitcoin", "defi", "onchain", "on-chain", "smart contract", "smart contracts", "mev", "nft", "raydium", "jito"],
    terms: ["trading", "backtest", "backtesting", "exchange", "wallet", "arbitrage", "liquidity", "ticker"] },
  { id: "game", label: "Games & scripting",
    strong: ["roblox", "unity", "godot", "minecraft", "fivem", "mod menu", "aimbot", "executor", "script hub", "voxel", "game engine"],
    terms: ["game", "games", "cheat", "cheats", "esp", "shader", "shaders", "sprite", "gameplay"] },
  { id: "security", label: "Security",
    strong: ["pentest", "penetration testing", "cve", "malware", "bug bounty", "fuzzing", "fuzzer", "cryptography", "reverse engineering", "subdomain enumeration", "port scanning"],
    terms: ["security", "exploit", "exploits", "vulnerability", "vulnerabilities", "recon", "subdomain", "hardening"] },
  { id: "infra", label: "Infra & data",
    strong: ["kubernetes", "docker", "kafka", "serverless", "self-hosted", "self-host", "postgres", "postgresql", "redis", "olap", "homelab", "materialized", "observability"],
    terms: ["database", "sql", "deploy", "deployment", "warehouse", "etl", "streaming", "proxy", "compose", "cluster", "sink", "sinks"] },
  { id: "web", label: "Web & UI",
    strong: ["react", "svelte", "tailwind", "next.js", "webgl", "webgpu", "component library", "wgsl"],
    terms: ["vue", "css", "components", "frontend", "front-end", "browser", "ui kit", "web app", "dom", "html"] },
  { id: "mobile", label: "Mobile",
    strong: ["swiftui", "flutter", "react native", "xcode", "app store"],
    terms: ["ios", "android", "on-device", "mobile"] },
  { id: "devtools", label: "Developer tools",
    strong: ["lsp", "bundler", "linter", "formatter", "package manager", "hot reload", "dotfiles", "dev server", "build tool"],
    terms: ["cli", "terminal", "editor", "compiler", "debugger", "sdk", "devtool", "devtools", "ide", "shell", "symlink"] },
  { id: "learning", label: "Learning & lists",
    strong: ["awesome", "curated list", "reading list", "roadmap", "cheat sheet", "cheatsheet"],
    terms: ["tutorial", "tutorials", "course", "interview", "handbook", "guide", "book", "learning"] },
];

export const CATEGORY_LABEL = Object.freeze(
  CATEGORIES.reduce((m, c) => ({ ...m, [c.id]: c.label }), { other: "Uncategorised" }),
);

/** The weak second pass. Only consulted when the description matched nothing. */
const LANGUAGE_CATEGORY = {
  Lua: "game", "Jupyter Notebook": "research", Swift: "mobile", Kotlin: "mobile",
  Shell: "devtools", Solidity: "crypto", R: "science", HTML: "web", CSS: "web", Vue: "web",
};

// Escaped and compiled once at module load, not per row: 300-odd terms across
// 500 repos is 150k regex compiles otherwise, and the terms never change.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rx = (t) => new RegExp(`(^|[^a-z0-9])${esc(t)}([^a-z0-9]|$)`, "i");
const TERM_RE = CATEGORIES.map((c) => ({
  id: c.id,
  label: c.label,
  res: [
    ...c.strong.map((t) => ({ term: t, weight: STRONG_WEIGHT, re: rx(t) })),
    ...c.terms.map((t) => ({ term: t, weight: 1, re: rx(t) })),
  ],
}));

/* Memoised on the ROW OBJECT, because the feed is 500 rows and the answer is
 * asked for by the category filter, the category counts, the fit part of every
 * score and every card that renders — five passes of ~300 regex tests each, on
 * every keystroke in the search box. A WeakMap keyed on identity is safe here
 * and only here: these rows are immutable snapshots handed back by Supabase and
 * replaced wholesale on refresh, never edited in place. Mutate a row and
 * re-categorise it and you will get the previous answer. */
const CAT_CACHE = new WeakMap();

/**
 * Which bucket a repo belongs in, and how we decided.
 *
 * @returns {{id, label, via: "keywords"|"language"|"none", matched: string[], weight: number, why: string}}
 */
export function categorize(row) {
  if (row && typeof row === "object") {
    const hit = CAT_CACHE.get(row);
    if (hit) return hit;
    const out = classify(row);
    CAT_CACHE.set(row, out);
    return out;
  }
  return classify(row);
}

function classify(row) {
  const text = `${row?.name || ""} ${row?.full_name || ""} ${row?.hook || ""}`.toLowerCase();
  const language = typeof row?.language === "string" ? row.language : null;

  let best = null;
  for (const c of TERM_RE) {
    let weight = 0;
    const matched = [];
    // Strongest terms first, so `matched` reads as evidence rather than as
    // whatever happened to be typed first in the list.
    for (const r of c.res) if (r.re.test(text)) { weight += r.weight; matched.push(r.term); }
    // Strictly greater, so a tie leaves the earlier (more specific) category in
    // place — that is what makes declaration order the documented tiebreak.
    if (weight && (!best || weight > best.weight)) best = { id: c.id, label: c.label, matched, weight };
  }
  if (best) {
    return { ...best, via: "keywords", why: `matched ${best.matched.slice(0, 3).map((t) => `“${t}”`).join(", ")} in the description` };
  }

  const byLang = language && LANGUAGE_CATEGORY[language];
  if (byLang) {
    return { id: byLang, label: CATEGORY_LABEL[byLang], via: "language", matched: [], weight: 0, why: `no keyword matched, so this is from the language (${language})` };
  }

  return {
    id: "other", label: CATEGORY_LABEL.other, via: "none", matched: [], weight: 0,
    why: row?.hook ? "nothing in the description matched a category" : "no description was scraped for this repo",
  };
}

/* ══ THE OPERATOR'S INTERESTS ═══════════════════════════════════════════════
 *
 * Read off the saves, because that is the only interest signal that exists.
 * Returns the empty profile when nothing is saved, and the FIT part below is
 * required to say so rather than quietly scoring zero like a mismatch. */
export function interestProfile(rows = [], saved = new Set()) {
  const categories = new Set();
  const languages = new Set();
  let n = 0;
  for (const r of rows) {
    if (!saved?.has?.(r?.id)) continue;
    n++;
    categories.add(categorize(r).id);
    if (r.language) languages.add(r.language);
  }
  return { categories, languages, count: n };
}

export const EMPTY_INTERESTS = Object.freeze({ categories: new Set(), languages: new Set(), count: 0 });

/* ══ THE SCORE ══════════════════════════════════════════════════════════════ */

// [threshold, points], descending — `ladder` takes the first one met.
const PACE_STEPS = [[100, 45], [50, 38], [25, 30], [10, 22], [4, 14], [1, 7]];
const ACCEL_STEPS = [[4, 25], [2, 20], [1.25, 14], [0.8, 8], [0.4, 3]];
// Youth runs the other way — SMALLER is better — so it is [maxDays, points]
// ascending and takes the first bucket the age fits into. Written out rather
// than inverted into `ladder`, because "≤7 days scores 15" is the sentence the
// header promises and a reader should be able to find it in that shape.
const YOUTH_STEPS = [[7, 15], [21, 12], [60, 8], [180, 4]];

/**
 * Score one repo out of 100, or refuse to.
 *
 * @param {object} row      a candidates row as the pipeline writes it
 * @param {object} [opts]
 * @param {number} [opts.now]        ms epoch; defaults to the clock
 * @param {object} [opts.interests]  from interestProfile()
 * @returns {{
 *   id: string, score: number|null, blocked: string|null,
 *   parts: {key:string,label:string,points:number,note:string}[],
 *   observed: number|null, lifetime: number|null, accel: number|null,
 *   gained: number|null, trackedDays: number|null, reason: string,
 * }}
 */
export function scoreRepo(row, { now = Date.now(), interests = EMPTY_INTERESTS } = {}) {
  const stars = num(row?.stars);
  const at = num(row?.stars_at_first_seen);
  const seen = ms(row?.first_seen);
  const ageDays = num(row?.age_days);

  const trackedDays = seen == null ? null : Math.max(0, (now - seen) / DAY_MS);
  const gained = stars == null || at == null ? null : stars - at;
  const observed = gained == null || !trackedDays ? null : gained / trackedDays;
  const lifetime = stars == null || ageDays == null || ageDays <= 0 ? null : stars / ageDays;
  const accel = observed == null || lifetime == null || lifetime <= 0 ? null : observed / lifetime;

  const base = { id: row?.id, observed, lifetime, accel, gained, trackedDays };

  // ── the gate. Each refusal names the input, with the row's own number in it,
  //    so the card can print the sentence unchanged. `kind` is a stable enum so
  //    the summary in `recommend` can group refusals without regex-matching
  //    prose that a copy edit would silently break.
  const gate = (() => {
    if (stars == null) return ["no-stars", "no star count on this row, so there is nothing to measure"];
    if (seen == null) return ["no-history", "no first-seen timestamp, so there is no window to measure over"];
    if (at == null) return ["no-history", "no earlier star count was recorded, so there is no rate — only a total"];
    if (trackedDays < MIN_TRACK_DAYS) {
      const hrs = Math.max(1, Math.round(trackedDays * 24));
      return ["too-new", `first seen ${hrs}h ago — too recent to measure a rate`];
    }
    if (stars < MIN_STARS) return ["too-small", `only ${stars} stars in total — too few to read anything into the pace`];
    if (gained < MIN_GAIN) return ["too-flat", `gained ${gained} star${gained === 1 ? "" : "s"} since the scan found it — too few to call a trend`];
    return null;
  })();

  if (gate) return { ...base, score: null, blocked: gate[1], blockedKind: gate[0], parts: [], reason: gate[1] };

  const parts = [];

  const pace = ladder(observed, PACE_STEPS);
  parts.push({ key: "pace", label: "Pace", points: pace, note: `${fmtRate(observed)}/day since the scan found it` });

  if (accel == null) {
    parts.push({ key: "accel", label: "Acceleration", points: 0, note: ageDays == null ? "the repo's age is unknown, so there is no lifetime pace to compare against" : "the repo's lifetime pace is zero, so a ratio would be meaningless" });
  } else {
    const pts = ladder(accel, ACCEL_STEPS);
    parts.push({ key: "accel", label: "Acceleration", points: pts, note: `${fmtX(accel)} its own lifetime pace of ${fmtRate(lifetime)}/day` });
  }

  if (ageDays == null) {
    parts.push({ key: "youth", label: "Youth", points: 0, note: "the repo's age is unknown" });
  } else {
    const pts = YOUTH_STEPS.find(([max]) => ageDays <= max)?.[1] ?? 0;
    parts.push({ key: "youth", label: "Youth", points: pts, note: `${Math.round(ageDays)} days old` });
  }

  if (!interests.count) {
    parts.push({ key: "fit", label: "Fit", points: 0, note: "you have not saved anything yet, so there is no interest profile to match" });
  } else {
    const cat = categorize(row);
    const catHit = interests.categories.has(cat.id) && cat.id !== "other";
    const langHit = !!row?.language && interests.languages.has(row.language);
    const pts = (catHit ? 10 : 0) + (langHit ? 5 : 0);
    const bits = [catHit ? cat.label : null, langHit ? row.language : null].filter(Boolean);
    parts.push({ key: "fit", label: "Fit", points: pts, note: bits.length ? `matches your saves: ${bits.join(", ")}` : "nothing you have saved is in this category or language" });
  }

  const score = parts.reduce((s, p) => s + p.points, 0);
  return { ...base, score, blocked: null, blockedKind: null, parts, reason: reasonFor({ ...base, parts }) };
}

/* ── the sentence on the row ───────────────────────────────────────────────
 *
 * Built ONLY from parts that actually earned points, so it can never claim
 * something the score did not measure. The numbers in it are the same ones the
 * ladders read, printed at the precision they were compared at. */
function reasonFor({ gained, trackedDays, observed, accel, parts }) {
  const bits = [];
  const days = trackedDays == null ? null : Math.max(1, Math.round(trackedDays));
  if (gained != null && days != null) {
    bits.push(`+${gained.toLocaleString()} star${gained === 1 ? "" : "s"} in the ${days === 1 ? "day" : `${days} days`} since the scan found it (${fmtRate(observed)}/day)`);
  }
  // Only when it IS acceleration. The ≥0.4 rung pays 3 points to a repo running
  // at half its lifetime pace — defensible in the score, and a lie in a sentence
  // that reads as a list of reasons to look: "0.5× its own lifetime pace" is
  // slower than its average, printed as if it were a boast. The parts line on
  // the row still shows "Acceleration 3", so nothing is hidden; it is just not
  // claimed as momentum.
  if (accel != null && accel >= 1) bits.push(`${fmtX(accel)} its own lifetime pace`);
  const youth = parts.find((p) => p.key === "youth");
  if (youth?.points) bits.push(youth.note);
  const fit = parts.find((p) => p.key === "fit");
  if (fit?.points) bits.push(fit.note);
  return bits.join(" · ");
}

export const fmtRate = (v) => (v == null ? "—" : v >= 10 ? String(Math.round(v)) : v >= 1 ? v.toFixed(1) : v.toFixed(2));
export const fmtX = (v) => (v == null ? "—" : `${v >= 10 ? Math.round(v) : v.toFixed(1)}×`);

/* ══ THE LIST ═══════════════════════════════════════════════════════════════ */

// One phrase per refusal, keyed off the enum rather than off the prose, so the
// summary sentence and the per-row sentence can be edited independently.
const BLOCKED_SUMMARY = {
  "no-stars": "missing a star count",
  "no-history": "missing the earlier star count we would measure against",
  "too-new": `first seen less than ${MIN_TRACK_DAYS * 24}h ago`,
  "too-small": `under ${MIN_STARS} stars`,
  "too-flat": "barely moved since the scan found them",
};

/**
 * Rank a feed. Returns every row scored (so a caller can sort or filter by it)
 * plus the subset worth recommending and, when that subset is empty, the reason.
 *
 * @returns {{ scored: Map<string,object>, picks: object[], reason: string }}
 */
export function recommend(rows = [], { now = Date.now(), saved = new Set(), limit = 3 } = {}) {
  const interests = interestProfile(rows, saved);
  const scored = new Map();
  const eligible = [];
  const blockedCounts = new Map();

  for (const r of rows) {
    const s = scoreRepo(r, { now, interests });
    scored.set(r?.id, s);
    if (s.score == null) {
      const kind = BLOCKED_SUMMARY[s.blockedKind] || BLOCKED_SUMMARY["no-history"];
      blockedCounts.set(kind, (blockedCounts.get(kind) || 0) + 1);
    } else eligible.push({ row: r, ...s });
  }

  // Total order: score, then observed pace, then id. A partial sort reshuffles
  // between two renders of identical data and reads as live movement.
  eligible.sort((a, b) => (b.score - a.score) || ((b.observed ?? -Infinity) - (a.observed ?? -Infinity)) || String(a.id).localeCompare(String(b.id)));

  // COUNTED, then sliced — never the other way round. `limit` is a display
  // budget (two picks on a phone, three on a desktop) and the sentence is a
  // claim about the feed, so counting after the slice made the phone say "2 of
  // 26 repos clear 30/100" on a feed where three did.
  const above = eligible.filter((e) => e.score >= RECOMMEND_FLOOR);
  const picks = above.slice(0, limit);

  let reason = "";
  if (picks.length) {
    reason = `${above.length} of ${rows.length} repos clear ${RECOMMEND_FLOOR}/100 on measured star growth`
      + (above.length > picks.length ? `; the top ${picks.length} are here.` : ".");
  } else if (!rows.length) {
    reason = "The feed is empty, so there is nothing to rank.";
  } else if (!eligible.length) {
    const top = [...blockedCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    reason = `Nothing here can be ranked yet: ${top[1]} of ${rows.length} repos are ${top[0]}. A recommendation needs at least ${MIN_TRACK_DAYS * 24}h of history, ${MIN_STARS} stars and ${MIN_GAIN} gained since the scan first saw the repo.`;
  } else {
    const best = eligible[0];
    reason = `${eligible.length} of ${rows.length} repos have enough history to rank, but none clears ${RECOMMEND_FLOOR}/100 — the strongest is ${best.row.full_name} at ${best.score}. Nothing is moving enough to be worth the interruption.`;
  }

  return { scored, picks, reason, interests, eligible: eligible.length, above: above.length };
}
