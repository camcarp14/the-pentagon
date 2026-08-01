// ═══════════════════════════════════════════════════════════════════════════
// IDEAS — what showed up on GitHub, worth a look.
//
// A scanner (github.com/camcarp14/Scanner) sweeps GitHub four times a day for
// new AI projects, filters them, reads their documentation, and once a day
// tries to extract a reusable workflow from the best of them. Everything it
// finds lands in this Supabase project's `public.ideafeed_*` tables — the same
// project the rest of The Pentagon signs into — so this tool is a reader over
// tables that are already here. No second database, no sync, no API of its own.
//
// Three surfaces, in the order they get used:
//   Ideas   — A REVIEW QUEUE: the ranker's top ten, and a button for ten more
//   Saved   — the ones kept (local to this browser, like the other tools' prefs)
//   Skills  — the SKILL.md files the pipeline wrote, and the reviewer's verdict
//
// ── WHY IDEAS IS A QUEUE AND NOT A FEED ────────────────────────────────────
//
// Ranking a firehose does not stop it being a firehose. The list was still five
// hundred rows long with the good ones nearer the top, so the only honest thing
// to do with it was scroll, and the operator's own read was the right one: pick
// ten, let me review them, give me ten more when I ask. Four decisions make
// that work rather than merely look tidy, and each of them is a place this
// could quietly lose the operator's work:
//
//   1. THE BUTTON MARKS, IT DOES NOT DELETE. Pressing it stamps the ten on
//      screen with a round number (src/lib/queue.js) and moves on. They are in
//      Reviewed, one tap away; the whole round comes back with Undo, and any
//      single repo comes back with the ↩ on its row — where it rejoins the pool
//      AT ITS RANK, not at the end. The card under the button says so, because
//      a button that might be discarding ten repos is a button you hesitate on.
//   2. THE QUEUE IS A LIVE VIEW, NOT A FROZEN SLATE. It is recomputed from the
//      ranked pool on every render, so a scan landing mid-round puts its new
//      repos straight into contention. What the button marks is the ids that
//      were ON SCREEN when it was pressed — passed to markReviewed, never
//      recomputed there — so the ten you looked at are the ten that get stamped
//      even if the ranker changed its mind a second earlier.
//   3. FILTERS RE-RANK INSIDE THE QUEUE, AND THE HEADER SAYS SO. Narrowing to
//      Agents gives you the top ten agents repos, not the subset of the top ten
//      overall that happen to be agents — the second reading makes the filter
//      look broken when it returns four rows. The header names every active
//      filter, prints the size of the pool they describe, and offers to clear
//      them. Sort is the ordering, so the header names that too.
//   4. THE END OF THE QUEUE IS A REAL STATE. "Nothing left" says how many you
//      got through and when the next scan is due — measured off the gaps
//      between recorded runs (src/lib/cadence.js), never off the "four times a
//      day" written in the comment above, which is documentation and not data.
//
// ── WHAT THIS PAGE USED TO BE, AND WHY IT CHANGED ──────────────────────────
//
// Three stacked full-width segmented bars — Ideas/Saved/Skills, then
// Newest/Popping/Stars, then 7d/30d/90d/All — plus three stat tiles, spending
// 409px of a 852px phone before the first repo. It read as a settings form
// because it was shaped like one. Two things were wrong and they are separate:
//
//   · The first row is a SUB-NAV and now looks like one: the ZTS/Clarify sticky
//     glass row (apps/zts/src/App.jsx, apps/clarify/src/App.jsx), 52px, a
//     hairline underneath, a drawn pill that slides between tabs, labels from a
//     hoisted map. Sort and window are FILTERS, so they are compact controls
//     sitting on one line above the list they filter — the shape
//     apps/macro/src/components/alts/AltBoard.jsx already uses for a dense list.
//
//   · The feed was 500 raw repos in reverse-chronological order, which is a
//     firehose, not a tool. src/lib/rank.js categorises every row from fields it
//     already carries and ranks what it can measure, and this file prints the
//     REASON next to the rank. When there is nothing worth recommending it says
//     so in a sentence with the counts in it.
//
// ── COLOUR ─────────────────────────────────────────────────────────────────
//
// Every colour here is a token, and that is a fix rather than tidiness. This
// file used to paint from `theme("ideas")`, whose ink/muted/faint/line are dark
// mode LITERALS — so with light mode on, a repo's name rendered near-white on a
// white card and was invisible. The palette tokens have a light half; the
// literals do not. GitHub's per-language hexes below stay literal, because
// those are the meaning of the swatch and not a palette choice.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@cc/supabase";
import { AnimatedNumber, EmptyState, ErrorState, SkeletonRows, useIsMobile } from "@cc/ui";
import { categorize, recommend, CATEGORY_LABEL, fmtRate, RECOMMEND_FLOOR } from "./lib/rank.js";
import {
  BATCH, loadQueue, saveQueue, markReviewed, undoLastRound, requeue, clearReviewed,
  splitQueue, sortReviewed, arrivedSince, lastRoundIds, reviewedCount, roundOf,
} from "./lib/queue.js";
import { scanCadence } from "./lib/cadence.js";

// The client's default schema is `public`, which is where the scanner writes —
// so unlike ZTS and Runway this tool needs no schema hop.
const db = () => supabase;

/* ── the label maps ────────────────────────────────────────────────────────
 *
 * Hoisted, and every control reads them. The rule this follows is the one the
 * rest of the repo took last night: a tab renders `tabLabel(id)`, never the raw
 * id with a textTransform, so the pill, the accessible name of the region and
 * anything else naming a view cannot drift into three different words. */

const TABS = ["ideas", "saved", "skills"];
const TAB_LABELS = { ideas: "Ideas", saved: "Saved", skills: "Skills" };
export const tabLabel = (t) => TAB_LABELS[t] || TAB_LABELS.ideas;

const SORTS = ["recommended", "popping", "newest", "stars"];
const SORT_LABELS = {
  recommended: "Recommended",
  // NOT "Popping". The card now prints the measured rate this sorts by, and a
  // label has to match the number beside it — see the comparator.
  popping: "Gaining fastest",
  newest: "Newest repo",
  stars: "Most stars",
};
export const sortLabel = (s) => SORT_LABELS[s] || SORT_LABELS.recommended;

const RANGES = [0, 7, 30, 90];
const RANGE_LABELS = { 0: "Any age", 7: "Under 7 days old", 30: "Under 30 days old", 90: "Under 90 days old" };
export const rangeLabel = (r) => RANGE_LABELS[r] ?? RANGE_LABELS[0];

const PAGE = 24;
const SAVED_KEY = "ideas_saved";
// One column width for the bar and the body, so the first pill lines up with
// the first card. Declared once because two copies is one drift away from the
// misalignment it exists to prevent.
const BODY_MAX = 1040;

const compact = (n) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n ?? 0);

const ageLabel = (d) =>
  d == null ? "" : d <= 1 ? "today" : d < 30 ? `${d}d old` : d < 365 ? `${Math.round(d / 30)}mo old` : `${Math.round(d / 365)}y old`;

const ago = (ts) => {
  if (!ts) return "";
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// GitHub's own per-language colours. Data, not theme, so they stay literal —
// this is the one place in the file a hex is correct.
const LANG = {
  TypeScript: "#3178c6", JavaScript: "#f1e05a", Python: "#3572A5", Rust: "#dea584",
  Go: "#00ADD8", Java: "#b07219", "C++": "#f34b7d", C: "#555555", Ruby: "#701516",
  Swift: "#F05138", Kotlin: "#A97BFF", Shell: "#89e051", HTML: "#e34c26", CSS: "#563d7c",
  Zig: "#ec915c", Lua: "#000080", "Jupyter Notebook": "#DA5B0B",
};

const readSaved = () => {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED_KEY));
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set();
  }
};

/* ── chrome ───────────────────────────────────────────────────────────────── */

// The kit's card, not a local one. It separates by tone and a soft shadow with
// NO outline — the language forbids a border and a shadow on the same element,
// and this had both.
const Card = ({ children, style, pad = "md", ...rest }) => (
  <div className={`card pad-${pad}`} style={{ minWidth: 0, ...style }} {...rest}>
    {children}
  </div>
);

/* ── what the feed shows, and in what order ────────────────────────────────────
 *
 * Pure and exported so the filters can be tested. Both of the bugs below shipped
 * because this lived inside a useMemo where nothing could reach it.
 *
 * @param {object[]} rows   candidates as they come back from the pipeline table
 * @param {{tab, sort, range, saved, query, category, scored}} opts
 *        `scored` is the Map from rank.js's recommend(); a row missing from it
 *        is one we could not measure, and it sorts LAST on the measured sorts
 *        rather than being read as a zero.
 */
export function selectVisible(rows, { tab, sort, range, saved, query = "", category = "all", scored = null }) {
  let list = tab === "saved" ? rows.filter((r) => saved.has(r.id)) : rows;

  // A BOUNDED WINDOW MUST EXCLUDE UNKNOWN AGES. This was `(r.age_days ?? 0) <= range`,
  // which read a missing age as ZERO — i.e. brand new — so every row the pipeline
  // failed to date passed every window, including 7d. A filter that silently
  // keeps what it cannot measure is not a filter.
  // Null and "" must be rejected BEFORE Number() sees them: Number(null) is 0
  // and Number("") is 0, both of which pass Number.isFinite — so the obvious
  // one-liner reintroduces the exact "unknown age reads as brand new" defect
  // this is here to remove. (It did, on the first run; the test caught it.)
  const age = (r) => {
    const v = r?.age_days;
    if (v === null || v === undefined || v === "") return null;
    const num = Number(v);
    return Number.isFinite(num) ? num : null;
  };
  if (range > 0) list = list.filter((r) => age(r) != null && age(r) <= range);

  if (category && category !== "all") list = list.filter((r) => categorize(r).id === category);

  const needle = String(query || "").trim().toLowerCase();
  if (needle) {
    list = list.filter((r) =>
      String(r.full_name || "").toLowerCase().includes(needle) ||
      String(r.hook || "").toLowerCase().includes(needle) ||
      String(r.language || "").toLowerCase().includes(needle));
  }

  const n = (v) => Number(v ?? 0);
  // A measured value we do not have is -Infinity, which sorts it last without a
  // second comparison — and, crucially, keeps it away from the genuine zeroes.
  const measured = (r, key) => {
    const s = scored?.get(r.id);
    const v = s?.[key];
    return v == null ? -Infinity : v;
  };

  return [...list].sort((a, b) => {
    // Every comparator falls through to age, then first_seen, then id, so the
    // order is TOTAL. A sort with ties left unresolved reshuffles between two
    // renders of identical data and reads as live movement.
    const tie = () => {
      const [x, y] = [age(a), age(b)];
      return ((x ?? Infinity) - (y ?? Infinity))
        || (new Date(b.first_seen) - new Date(a.first_seen))
        || String(a.id).localeCompare(String(b.id));
    };
    if (sort === "recommended") return measured(b, "score") - measured(a, "score") || tie();
    // MEASURED, not the pipeline's own star_velocity column. The card prints
    // "97/day" from rank.js's (stars − stars_at_first_seen) ÷ days tracked; if
    // this sorted by a different number the visible figure and the order would
    // disagree, which is the same defect "Newest" had when it sorted by
    // first_seen while the card printed the repo's age.
    if (sort === "popping") return measured(b, "observed") - measured(a, "observed") || tie();
    if (sort === "stars") return n(b.stars) - n(a.stars) || tie();
    // NEWEST MEANS THE YOUNGEST REPO — the number the card actually prints
    // ("17d old"). This used to sort by first_seen, i.e. when the scan happened
    // to find it. Defensible for a feed, except one scan stamps every row it
    // adds with the SAME timestamp, so the comparison fell straight through to
    // the score tiebreak and "Newest" put a 17-day-old repo above an 11-day-old
    // one. The label and the visible number now agree. Undated rows sort last.
    return tie();
  });
}

/* ── the sub-nav ──────────────────────────────────────────────────────────────
 *
 * The ZTS/Clarify shape, and deliberately so: a 52px row, a hairline underneath
 * and nothing else (a border AND a shadow on one element is the pair §4.2
 * forbids), glass with a backdrop blur, sticky under the shell bar, and the
 * kit's .seg with its .seg-thumb measured off the active pill so the indicator
 * glides instead of teleporting.
 *
 * `top: var(--shell-bar, 52px)`, NEVER a literal 52. The shell measures its own
 * bar and publishes the answer; it is 0px on a desktop, where the bar is gone
 * and the tools live in the left rail. Hardcoding the constant is what put ZTS's
 * nav 52px below its own content the night the rail landed.
 *
 * No dark fallback on --glass either. ZTS and Clarify still carry
 * `var(--glass, rgba(11,15,26,0.78))`; the token is authored on :root in
 * tokens.css so the fallback can only ever fire in a document with no token
 * layer at all, and what it would paint there is a midnight bar under light
 * content. */
function SubNav({ tab, onTab, savedCount, onRefresh, refreshing, isMobile }) {
  const refs = useRef({});
  const [thumb, setThumb] = useState({ left: 0, width: 0, ready: false });

  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[tab];
      if (!el) return;
      setThumb({ left: el.offsetLeft, width: el.offsetWidth, ready: true });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [tab, isMobile, savedCount]);

  return (
    <div
      data-ideas-nav
      style={{
        position: "sticky", top: "var(--shell-bar, 52px)", zIndex: 40,
        height: 52,
        borderBottom: "1px solid var(--line)",
        background: "var(--glass)",
        backdropFilter: "blur(20px) saturate(140%)", WebkitBackdropFilter: "blur(20px) saturate(140%)",
      }}
    >
      {/* The HAIRLINE is full-bleed and the CONTENT is not: the row shares the
          body's max-width and padding, so the first pill lines up with the first
          card underneath it. A bar whose contents start 94px left of the column
          they sit above reads as two pages stacked. */}
      <div style={{
        height: "100%", maxWidth: BODY_MAX, margin: "0 auto",
        padding: isMobile ? "0 14px" : "0 24px",
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
      }}>
        <div className="seg" role="tablist" aria-label="Ideas sections" style={{ minWidth: 0, flex: isMobile ? "1 1 auto" : "0 0 auto" }}>
          {thumb.ready && <div className="seg-thumb" style={{ left: `${thumb.left}px`, width: `${thumb.width}px`, zIndex: 0 }} />}
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              ref={(el) => { refs.current[t] = el; }}
              onClick={() => onTab(t)}
              className={tab === t ? "seg-opt active" : "seg-opt"}
              // 44 on a phone, and it fits: the bar is 52 and .seg adds 2px of
              // padding either side, so a 44px pill is a 48px control inside it.
              // The kit's .seg-opt floor is 32 and this was overriding it to 36
              // — a hair over the kit and a full 8px under the touch floor, on
              // the three targets this tool is navigated by.
              style={{ padding: "0 12px", minHeight: isMobile ? 44 : 36, whiteSpace: "nowrap", flex: "1 1 auto" }}
            >
              {tabLabel(t)}
              {/* The saved count moves ONTO the pill it describes — the stat tile
                  that used to carry it was a third of a phone screen spent on
                  three numbers, two of which the scan line below repeats. */}
              {t === "saved" && savedCount > 0 && (
                <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--sub)" }}>
                  {savedCount}
                </span>
              )}
            </button>
          ))}
        </div>
        {/* .btn sm is 34px, which is under the touch floor — fine for a pointer,
            not for a thumb. The bar is 52px tall, so md (44px) fits inside it
            with 4px to spare on the surface where the floor applies. */}
        <button
          type="button"
          className={isMobile ? "btn md quiet" : "btn sm quiet"}
          onClick={onRefresh}
          disabled={refreshing}
          title="Re-read the scanner's tables"
          aria-label="Refresh the feed"
          style={{ flex: "none" }}
        >
          {refreshing ? "…" : "↺"}
        </button>
      </div>
    </div>
  );
}

/* ── the filters ──────────────────────────────────────────────────────────────
 *
 * A search box and three selects on one line, which is AltBoard's shape and the
 * reason it reads as a list control rather than a settings form. They wrap to
 * two lines on a phone rather than becoming three full-width bars: a segmented
 * control is for two or three options you want to see at once, and "any of
 * eleven categories" is not that.
 *
 * The category list is DERIVED — only categories actually present in what is
 * loaded, each with its count — so the menu can never offer a filter that
 * returns nothing. */
function Filters({ query, onQuery, sort, onSort, category, onCategory, range, onRange, counts, total }) {
  const fld = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };
  return (
    <div data-ideas-filters style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", marginBottom: 12 }}>
      <div style={{ ...fld, flex: "2 1 210px" }}>
        <label className="t-cap" htmlFor="ideas-q">Search</label>
        {/* type=text, not search: a bare type=search renders unstyled in some
            engines and the kit fills the types it names. */}
        <input
          id="ideas-q" className="field" type="text" value={query}
          placeholder="name, description or language"
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
      <div style={{ ...fld, flex: "1 1 150px" }}>
        <label className="t-cap" htmlFor="ideas-sort">Sort by</label>
        <select id="ideas-sort" className="field" value={sort} onChange={(e) => onSort(e.target.value)}>
          {SORTS.map((s) => <option key={s} value={s}>{sortLabel(s)}</option>)}
        </select>
      </div>
      <div style={{ ...fld, flex: "1 1 170px" }}>
        <label className="t-cap" htmlFor="ideas-cat">Category</label>
        <select id="ideas-cat" className="field" value={category} onChange={(e) => onCategory(e.target.value)}>
          <option value="all">All categories ({total})</option>
          {counts.map(([id, n]) => <option key={id} value={id}>{CATEGORY_LABEL[id]} ({n})</option>)}
        </select>
      </div>
      <div style={{ ...fld, flex: "1 1 150px" }}>
        <label className="t-cap" htmlFor="ideas-age">Repo age</label>
        <select id="ideas-age" className="field" value={range} onChange={(e) => onRange(Number(e.target.value))}>
          {RANGES.map((r) => <option key={r} value={r}>{rangeLabel(r)}</option>)}
        </select>
      </div>
    </div>
  );
}

/* ── progress, drawn ──────────────────────────────────────────────────────────
 *
 * aria-hidden, and that is not laziness: the line directly underneath states
 * the same two numbers exactly, so a screen reader that also announced this
 * would hear the fraction twice. The bar is the glanceable copy of a sentence
 * that is already there — never the only place a number appears. */
const Meter = ({ done, total }) => (
  <div
    aria-hidden="true"
    style={{ height: 4, borderRadius: 999, background: "var(--ink-a05)", overflow: "hidden", margin: "10px 0 8px" }}
  >
    <div style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%`, height: "100%", borderRadius: 999, background: "var(--accent)" }} />
  </div>
);

/* Undo works on the ROUND, which is a fact about your history and not about the
 * filter you happen to have on. So under a filter the button would promise "put
 * 10 back" and visibly return one, with the other nine landing outside the
 * filter — a number on screen that does not match what pressing it does, which
 * is the exact shape this repo has been burned by. Both counts are printed
 * instead, and only when they differ. */
const UndoLabel = ({ round, count, here }) => (
  <>
    Undo round {round} — put {count.toLocaleString()} back
    {here != null && here !== count && <>, {here.toLocaleString()} of them here</>}
  </>
);

/* ── the queue's header ───────────────────────────────────────────────────────
 *
 * Everything the operator needs to trust the button, in the order they need it:
 * how far through they are, what the ten were chosen from, what a filter is
 * doing to that, and the two ways back.
 *
 * Every number is passed in already computed from fetched rows. There is no
 * arithmetic in here that could disagree with the list underneath, and no
 * sentence that is true only when a filter happens to be off. */
function QueueHeader({
  round, done, pool, onScreen, waiting, filters, sortName, arrived,
  rankNote, noInterests, lastRound, lastRoundHere, onUndo, onClearFilters, onShowReviewed,
}) {
  const total = done + pool;
  const scope = filters.length ? "that match these filters" : "in the feed";
  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <span className="t-label">Review queue</span>
        <span className="t-cap" style={{ fontFamily: "var(--font-mono)", flex: "none" }}>
          {round > 0 && <>round {round} · </>}score / 100
        </span>
      </div>

      <Meter done={done} total={total} />

      {/* The progress claim. Denominator is whatever set the filters describe,
          and the sentence says which — "30 of 217" over a filtered pool while
          the words implied the whole feed would be a number that measured a
          different thing from the one it names. */}
      <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: "var(--faint)", fontFamily: "var(--font-mono)" }}>
        {done.toLocaleString()} of {total.toLocaleString()} reviewed {scope} · {onScreen} on screen · {waiting.toLocaleString()} waiting
      </p>

      <p className="t-cap" style={{ margin: "6px 0 0", lineHeight: 1.5 }}>
        {onScreen > 0 && <>The top {onScreen} by {sortName.toLowerCase()}. </>}{rankNote}
      </p>

      {/* DECISION 3, on screen. A filter re-ranks inside the queue, so what you
          are looking at is the top ten OF THE FILTER — said in words, with the
          filters named and the pool size printed, and a way out. */}
      {filters.length > 0 && (
        <p className="t-cap" style={{ margin: "6px 0 0", lineHeight: 1.5 }}>
          Filtered to {filters.join(" · ")} — the queue re-ranks inside that, so these are the top{" "}
          {onScreen} of {total.toLocaleString()}, not of the whole feed.
        </p>
      )}

      {/* Only ever printed when there is a round to have measured it against;
          arrivedSince() returns null before the first one and the caller passes
          null straight through rather than a 0 that reads as a measurement. */}
      {arrived > 0 && (
        <p className="t-cap" style={{ margin: "6px 0 0", lineHeight: 1.5 }}>
          {arrived} of the {pool.toLocaleString()} waiting arrived since your last round opened.
        </p>
      )}

      {/* Fit reads 0 on every row until something is saved, and a zero with no
          explanation looks like a broken part rather than an absent input. */}
      {noInterests && onScreen > 0 && (
        <p className="t-cap" style={{ margin: "6px 0 0", lineHeight: 1.5 }}>
          Fit is 0 everywhere because nothing is saved yet — what you star is the only
          read on your interests this has.
        </p>
      )}

      {/* Only while there is a queue to be standing in front of. With the queue
          empty the state below carries the same three controls as its action —
          and two rows of identical buttons 200px apart is how an operator ends
          up wondering whether they do the same thing. */}
      {onScreen > 0 && (lastRound > 0 || done > 0 || filters.length > 0) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          {lastRound > 0 && (
            <button type="button" className="btn md quiet" onClick={onUndo}>
              <UndoLabel round={round} count={lastRound} here={lastRoundHere} />
            </button>
          )}
          {done > 0 && (
            <button type="button" className="btn md quiet" onClick={onShowReviewed}>
              Reviewed {done.toLocaleString()}
            </button>
          )}
          {filters.length > 0 && (
            <button type="button" className="btn md quiet" onClick={onClearFilters}>Clear filters</button>
          )}
        </div>
      )}
    </Card>
  );
}

/* ── the history ──────────────────────────────────────────────────────────────
 *
 * The answer to "what happened to the ten I just saw". They are here, in
 * rounds, newest first, with the same card and the same score — plus one
 * control that puts a repo back where the ranker thinks it belongs.
 *
 * Two controls here and the third at the FOOT of the list. Emptying the whole
 * history is the one action in the tool that cannot be undone, and putting it
 * beside "Back to the queue" both crowded a phone into three stacked buttons
 * and put the irreversible one under the thumb that was reaching for the way
 * out. At the bottom it is where you are when you have actually read the
 * history and decided you want all of it back. */
function ReviewedHeader({ shownCount, totalCount, round, lastRound, lastRoundHere, filters, onUndo, onBack }) {
  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <span className="t-label">Reviewed</span>
        <span className="t-cap" style={{ fontFamily: "var(--font-mono)", flex: "none" }}>
          {round > 0 ? <>{round} round{round === 1 ? "" : "s"}</> : "no rounds"}
        </span>
      </div>
      <p className="t-cap" style={{ margin: "6px 0 0", lineHeight: 1.5 }}>
        {shownCount === totalCount
          ? <>All {totalCount.toLocaleString()} you have been through, newest round first.</>
          : filters.length
            ? <>{shownCount.toLocaleString()} of your {totalCount.toLocaleString()} reviewed repos match these filters ({filters.join(" · ")}).</>
            // Not a filter: the scan keeps 500 rows, and a repo you reviewed
            // weeks ago can fall out of that window. Saying so beats printing
            // two counts that do not add up and letting the operator wonder.
            : <>{shownCount.toLocaleString()} of your {totalCount.toLocaleString()} reviewed repos are still in the feed the scan keeps; the rest have aged out of it.</>}
        {" "}Nothing here was deleted — put one back with ↩ and it rejoins the queue at its rank.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        <button type="button" className="btn md tinted" onClick={onBack}>Back to the queue</button>
        {lastRound > 0 && (
          <button type="button" className="btn md quiet" onClick={onUndo}>
            <UndoLabel round={round} count={lastRound} here={lastRoundHere} />
          </button>
        )}
      </div>
    </Card>
  );
}

/* The one irreversible control in the tool, at the foot of the list it empties.
 * It asks first, and the confirm is the button's own words changing rather than
 * a dialog: a sheet for a two-word question is furniture, and a destructive
 * default nobody reads is how you lose four rounds of work. The question times
 * out, so a tap you walked away from cannot be completed by the next one. */
function PutAllBack({ count, onClear }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return undefined;
    const t = setTimeout(() => setConfirm(false), 6000);
    return () => clearTimeout(t);
  }, [confirm]);
  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        className={confirm ? "btn md danger full" : "btn md quiet full"}
        onClick={() => (confirm ? onClear() : setConfirm(true))}
      >
        {confirm ? `Put all ${count.toLocaleString()} back into the queue? Tap again` : "Put them all back"}
      </button>
      <p className="t-cap" style={{ margin: "8px 0 0", lineHeight: 1.5, textAlign: "center" }}>
        This one cannot be undone — every round is forgotten and all {count.toLocaleString()} rejoin the pool.
      </p>
    </div>
  );
}

function CategoryChip({ cat, onClick }) {
  const body = (
    <>
      {cat.label}
      {cat.via === "language" && <span style={{ color: "var(--faint)" }}> ·&nbsp;by language</span>}
    </>
  );
  const style = {
    display: "inline-flex", alignItems: "center", borderRadius: 999, padding: "3px 9px",
    fontSize: 11.5, lineHeight: 1.3, fontWeight: 500,
    background: cat.id === "other" ? "var(--ink-a05)" : "var(--accent-a10)",
    color: cat.id === "other" ? "var(--faint)" : "var(--accent)",
    border: "none", cursor: onClick ? "pointer" : "default", font: "inherit", fontFamily: "var(--font-body)",
  };
  if (!onClick) return <span style={style} title={cat.why}>{body}</span>;
  return (
    <button type="button" style={style} onClick={() => onClick(cat.id)} aria-label={`Filter to ${cat.label} — ${cat.why}`}>
      {body}
    </button>
  );
}

const LangTag = ({ language }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "var(--sub)", fontFamily: "var(--font-mono)" }}>
    <span style={{ width: 7, height: 7, borderRadius: "50%", background: LANG[language] || "var(--faint)", flex: "none" }} />
    {language}
  </span>
);

/* ── one repo ─────────────────────────────────────────────────────────────────
 *
 * `rank` and `why` only arrive on the Ideas tab. The queue is ten cards you are
 * meant to read rather than skim past, so each one carries the score, the
 * sentence rank.js built out of the parts that actually earned points, and the
 * addition itself — the same three things the old three-row panel showed for
 * the top two, now on every row you are being asked to judge.
 *
 * A row the ranker REFUSED shows the refusal in its own words and no number.
 * That is the case the score-inventing bug lived in, and it is why the score
 * slot renders an em dash rather than a value: a dash is not a quantity, cannot
 * be read as one, and the line underneath says which input was missing. */

// 44px of target, pulled back out of the layout with a negative margin so a row
// does not grow to accommodate a touch floor. Shared by the star and the ↩ so
// the two cannot drift apart.
const rowBtn = (last) => ({
  flexShrink: 0, background: "none", border: "none", cursor: "pointer",
  width: 44, height: 44, margin: `-11px ${last ? -12 : 0}px -11px 0`, lineHeight: 1, fontSize: 16,
  display: "inline-flex", alignItems: "flex-start", justifyContent: "flex-end", paddingTop: 10, paddingRight: last ? 10 : 0,
});

function IdeaCard({ item, saved, onSave, verdict, onOpenCategory, rank, why, round, onRequeue }) {
  const cat = categorize(item);
  const gained = verdict?.gained;
  const scored = verdict?.score != null;
  return (
    <Card data-ideas-row>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
        {rank != null && (
          <span style={{ flex: "none", fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--faint)", lineHeight: "20px", width: 17, fontVariantNumeric: "tabular-nums" }}>
            {rank}
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: "var(--ink)", textDecoration: "none", fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: 600, overflowWrap: "anywhere" }}
          >
            <span style={{ color: "var(--sub)", fontWeight: 400 }}>{item.owner}/</span>
            {item.name}
          </a>
          <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center" }}>
            <CategoryChip cat={cat} onClick={onOpenCategory} />
            {item.language && <LangTag language={item.language} />}
          </div>
        </div>
        {why && (
          <span
            title={scored ? `${verdict.parts.map((p) => `${p.label} ${p.points}`).join(" + ")} = ${verdict.score}` : verdict?.blocked || "not scored in this pass"}
            style={{
              flex: "none", fontFamily: "var(--font-mono)", fontSize: scored ? 19 : 15, fontWeight: 600,
              color: scored ? "var(--accent)" : "var(--faint)", fontVariantNumeric: "tabular-nums", lineHeight: "20px",
            }}
          >
            {scored ? <AnimatedNumber value={verdict.score} format={(v) => String(Math.round(v))} /> : "—"}
          </span>
        )}
        {onRequeue && (
          <button
            type="button"
            onClick={() => onRequeue(item.id)}
            aria-label={`Put ${item.full_name} back in the review queue`}
            title="Put back in the queue"
            style={{ ...rowBtn(false), color: "var(--sub)" }}
          >
            ↩
          </button>
        )}
        <button
          type="button"
          onClick={() => onSave(item.id)}
          aria-pressed={saved}
          aria-label={saved ? `Remove ${item.full_name} from saved` : `Save ${item.full_name} for later`}
          style={{ ...rowBtn(true), color: saved ? "var(--accent)" : "var(--faint)" }}
        >
          {saved ? "★" : "☆"}
        </button>
      </div>

      {/* The reason, then the addition. 45 + 20 + 8 + 0 = 73 is checkable
          against the table at the top of rank.js without trusting this screen. */}
      {why && (
        <div style={{ marginTop: 8 }}>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: scored ? "var(--ink)" : "var(--faint)" }}>
            {scored ? verdict.reason : `Not ranked — ${verdict?.blocked || "this row was not scored in this pass"}`}
          </p>
          {scored && (
            <p style={{ margin: "4px 0 0", fontSize: 11, lineHeight: 1.5, color: "var(--faint)", fontFamily: "var(--font-mono)" }}>
              {verdict.parts.map((part) => `${part.label} ${part.points}`).join(" + ")} = {verdict.score}
            </p>
          )}
        </div>
      )}

      {/* Clamped to two lines. These hooks are scraped repo descriptions and run
          to five or six lines, which pushed the meta row — language, stars, age,
          the things you actually scan by — a full screen apart between cards.
          The title links out; the full text is one tap away. */}
      {item.hook && (
        <p
          title={item.hook}
          style={{
            margin: "8px 0 0", fontSize: 13, lineHeight: 1.5, color: "var(--sub)",
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
          }}
        >{item.hook}</p>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", marginTop: 9, fontSize: 11.5, color: "var(--faint)", fontFamily: "var(--font-mono)" }}>
        <span>{compact(item.stars)}★</span>
        {gained > 0 && <span style={{ color: "var(--good)" }}>+{compact(gained)}</span>}
        {/* The rate the "Gaining fastest" sort orders by, printed where it is
            ordered — and printed ONLY when rank.js could measure it. A row we
            could not measure shows nothing here rather than a zero. */}
        {verdict?.observed != null && verdict.score != null && (
          <span style={{ color: "var(--ink)" }}>{fmtRate(verdict.observed)}/day</span>
        )}
        <span>{ageLabel(item.age_days)}</span>
        {item.skills_extracted > 0 && (
          <span style={{ color: "var(--accent)" }}>
            {item.skills_extracted} skill{item.skills_extracted === 1 ? "" : "s"}
          </span>
        )}
        {/* Which round marked it. Printed only in the Reviewed list, where it is
            what makes "undo round 4" legible against the rows it will return. */}
        {round != null && <span>round {round}</span>}
      </div>
    </Card>
  );
}

function SkillCard({ skill }) {
  const [open, setOpen] = useState(false);
  const verdict = skill.verdict || "hold";
  const tone = verdict === "approve" ? "var(--good)" : verdict === "reject" ? "var(--bad)" : "var(--warn)";
  const label = skill.published ? "Published" : verdict === "approve" ? "Approved" : verdict === "reject" ? "Rejected" : "Held";
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span style={{ flex: 1, minWidth: 0, color: "var(--ink)", fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, overflowWrap: "anywhere" }}>
          {skill.slug || skill.name}
        </span>
        {/* .t-label is the ONE place uppercase survives in this language; this
            was hand-rolling it with a textTransform and its own tracking. */}
        <span className="t-label" style={{ flexShrink: 0, color: tone }}>{label}</span>
      </div>

      {skill.description && (
        <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.55, color: "var(--sub)" }}>{skill.description}</p>
      )}

      {skill.source?.full_name && (
        <a
          href={skill.source.url}
          target="_blank"
          rel="noreferrer noopener"
          style={{ display: "inline-block", marginTop: 9, fontSize: 11.5, color: "var(--faint)", fontFamily: "var(--font-mono)", textDecoration: "none" }}
        >
          {skill.source.full_name} ↗
        </a>
      )}

      {skill.body && (
        <>
          {/* .btn md, not sm: sm is 34px, and this is the one control on a skill
              card. A 44px floor on a phone is not negotiable. */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className={open ? "btn md tinted full" : "btn md quiet full"}
            style={{ marginTop: 12 }}
          >
            {open ? "Hide SKILL.md" : "Read SKILL.md"}
          </button>
          {open && (
            <pre style={{ margin: "12px 0 0", fontSize: 11.5, lineHeight: 1.6, color: "var(--sub)", fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {skill.body}
            </pre>
          )}
        </>
      )}
    </Card>
  );
}

/* ── tool ─────────────────────────────────────────────────────────────────── */

export default function IdeasRoot() {
  const isMobile = useIsMobile();
  const [tab, setTab] = useState("ideas");
  const [sort, setSort] = useState("recommended");
  // Any age by default. The 30-day window used to be doing the recommending —
  // badly, since a repo's age is a poor proxy for whether it is moving — and
  // that job now belongs to the ranker, where age is one scored part of four.
  const [range, setRange] = useState(0);
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState(null);
  const [skills, setSkills] = useState(null);
  const [runs, setRuns] = useState(null);
  const [err, setErr] = useState(null);
  const [shown, setShown] = useState(PAGE);
  const [nonce, setNonce] = useState(0);
  const [saved, setSaved] = useState(readSaved);
  // Seen-state. `loadQueue` is wrapped in its own try/catch, so this is also
  // what makes the component render under react-dom/server, where there is no
  // localStorage to read at all.
  const [review, setReview] = useState(loadQueue);
  // Two views inside the Ideas tab: the ten to review, and everything already
  // reviewed. Not a fourth pill — "Reviewed" is a long word and a four-segment
  // control on a 360px phone gives each segment 78px, which ellipsises the one
  // that had to be legible.
  const [view, setView] = useState("queue");

  // Every write goes through saveQueue, which normalizes and persists in one
  // step, so the state in React and the state in localStorage cannot disagree —
  // and a private-mode failure to write still leaves the session working.
  const commit = useCallback((fn) => setReview((prev) => saveQueue(fn(prev))), []);
  const undoRound = useCallback(() => commit(undoLastRound), [commit]);
  const putBack = useCallback((id) => commit((prev) => requeue(prev, id)), [commit]);
  const putAllBack = useCallback(() => commit(clearReviewed), [commit]);

  const toggleSave = useCallback((id) => {
    setSaved((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try { localStorage.setItem(SAVED_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
      return next;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!supabase) { setErr("Supabase isn't configured in this build."); return; }
      setErr(null); setRows(null); setSkills(null);

      // The pipeline caps the feed at 500 rows, so this is one request rather
      // than a paginated reader over a table that cannot grow past a page.
      const [c, s, r] = await Promise.all([
        db().from("ideafeed_candidates")
          .select("id,full_name,owner,name,url,hook,language,stars,star_velocity,age_days,score,skills_extracted,stars_at_first_seen,first_seen")
          .order("first_seen", { ascending: false }).limit(500),
        db().from("ideafeed_skills")
          .select("id,name,slug,description,body,verdict,published,skill_score,source,first_seen")
          .order("first_seen", { ascending: false }).limit(60),
        // EIGHT runs, not one. The queue owes an answer the feed never did —
        // "you are through them all, when is there more" — and the only honest
        // source for that is the gaps between runs that actually happened. One
        // row can date the last scan but cannot time the next one.
        db().from("ideafeed_runs")
          .select("ran_at,scanned,kept_by_filter,skills_generated,cost_usd")
          .order("ran_at", { ascending: false }).limit(8),
      ]);

      if (!alive) return;
      if (c.error) { setErr(c.error.message); return; }
      setRows(c.data || []);
      setSkills(s.error ? [] : s.data || []);
      setRuns(r.error ? [] : r.data || []);
    })();
    return () => { alive = false; };
  }, [nonce]);

  useEffect(() => { setShown(PAGE); }, [tab, sort, range, category, query, view]);
  // Leaving the tab leaves the history behind it; and undoing your way back to
  // an empty history returns you to the queue rather than to a blank screen
  // with a "Back" button on it.
  useEffect(() => { setView("queue"); }, [tab]);
  useEffect(() => { if (view === "reviewed" && !reviewedCount(review)) setView("queue"); }, [view, review]);

  // ONE clock read per load of the data, handed to everything that needs an
  // instant. rank.js and cadence.js are both pure and both take `now`; reading
  // the clock inside either of them would make two identical repos score
  // differently, and would make the modules untestable. It is deliberately not
  // a per-render read: nothing on this screen ticks, and a value that changed
  // on every keystroke in the search box would re-rank 500 rows for nothing.
  const now = useMemo(() => Date.now(), [rows, runs]);

  // ONE ranking pass over the whole feed, reused by the queue, the sorts and
  // every card's rate. Two passes would be two answers.
  const ranked = useMemo(() => {
    if (!rows) return null;
    return recommend(rows, { now, saved, limit: BATCH });
  }, [rows, saved, now]);

  const visible = useMemo(
    () => (rows ? selectVisible(rows, { tab, sort, range, saved, query, category, scored: ranked?.scored }) : null),
    [rows, tab, sort, range, saved, query, category, ranked],
  );

  /* ── the queue ───────────────────────────────────────────────────────────
   *
   * `visible` is already filtered by the tab, the search, the category and the
   * age window, and already ordered by the selected sort. splitQueue only CUTS
   * that list — which is the whole of decision 3: a filter changes the pool, so
   * it changes the queue, because the queue is defined as the head of the pool
   * and not as a snapshot taken before the filter ran. */
  const split = useMemo(
    () => (visible && tab === "ideas" ? splitQueue(visible, review, BATCH) : null),
    [visible, review, tab],
  );

  const reviewedRows = useMemo(
    () => (split ? sortReviewed(split.done, review) : []),
    [split, review],
  );

  // Named filters, for the sentence that tells the operator what the queue was
  // drawn from. Sort is not in here — it is the ordering, and it is named
  // separately — and neither is the tab, which is the surface itself.
  const filters = useMemo(() => [
    query.trim() ? `“${query.trim()}”` : null,
    category !== "all" ? CATEGORY_LABEL[category] : null,
    range > 0 ? rangeLabel(range) : null,
  ].filter(Boolean), [query, category, range]);

  const clearFilters = useCallback(() => { setQuery(""); setCategory("all"); setRange(0); }, []);

  const cadence = useMemo(() => scanCadence(runs, now), [runs, now]);
  const run = runs?.[0] || null;

  /* Pressing the button marks EXACTLY the ids that were on screen. The queue is
   * recomputed every render, so between the paint and the tap a refresh could
   * have changed which ten the ranker offers; marking a freshly computed slice
   * would then stamp a repo the operator never saw. */
  const advance = useCallback(() => {
    const ids = (split?.queue || []).map((r) => r.id);
    if (!ids.length) return;
    commit((prev) => markReviewed(prev, ids));
    // Ten new cards land above the fold, so the scroll position from the round
    // you just finished is meaningless. Reduced motion gets the jump, not the
    // glide — §4.6 puts all motion behind that query.
    try {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    } catch { /* no window to scroll; the state change still landed */ }
  }, [split, commit]);

  // Only categories actually present, biggest first, so the menu can never
  // offer a filter that returns an empty list.
  const catCounts = useMemo(() => {
    if (!rows) return [];
    const m = new Map();
    for (const r of rows) {
      const id = categorize(r).id;
      m.set(id, (m.get(id) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || CATEGORY_LABEL[a[0]].localeCompare(CATEGORY_LABEL[b[0]]));
  }, [rows]);

  const loading = rows === null;
  const pad = isMobile ? 14 : 24;
  const feedTab = tab !== "skills";

  // TAP THE CHIP TO FILTER — with a mouse only. The chip is ~22px tall, which is
  // fine for a pointer and under this repo's 44px touch floor, and there is one
  // on every card: twenty-five sub-floor targets on a phone is a worse trade
  // than one affordance, especially when the Category select right above the
  // list is a 44px control that does the same job and lists the counts. Passing
  // null makes CategoryChip render a <span>, so nothing on touch even looks
  // pressable.
  const pickCategory = isMobile ? null : setCategory;

  const queueMode = tab === "ideas" && view === "queue";
  const historyMode = tab === "ideas" && view === "reviewed";
  // The rows the list under the header actually renders. One expression, so the
  // count line, the pager and the cards can never be counting different things.
  const listRows = !visible ? [] : historyMode ? reviewedRows : queueMode ? split.queue : visible;

  /* The ranker's own summary sentence, but only the half of it that stays true
   * inside a queue. rank.js writes "…the top 3 are here", which is a claim
   * about a slice taken off the top of the WHOLE feed — after two rounds the
   * ten on screen are ranks 21–30 and that sentence is false. So the count of
   * what clears the floor is printed (it is a claim about the feed, and it is
   * exactly right), and rank.js's prose is used verbatim only in the two cases
   * where it is a refusal rather than a slice. */
  const rankNote = !ranked ? "" : ranked.above > 0
    ? `${ranked.above.toLocaleString()} of the ${rows.length.toLocaleString()} repos in the feed clear ${RECOMMEND_FLOOR}/100 on measured star growth.`
    : ranked.reason;

  const lastRoundSet = new Set(lastRoundIds(review));
  const lastRound = lastRoundSet.size;
  const reviewedAll = reviewedCount(review);
  // How many of that round are inside the current filters — the number the
  // operator will actually watch come back. Equal to `lastRound` whenever the
  // filters are off, in which case the label says it once.
  const lastRoundHere = (historyMode ? reviewedRows : split?.done || []).filter((r) => lastRoundSet.has(r.id)).length;

  return (
    // data-kit: Ideas opts into the shared kit. It renders inside the shell's
    // tool slot, so this reaches this app and nothing else — the same rule the
    // shell follows by keeping data-kit off the wrapper that holds every tool.
    //
    // The name is on the REGION and tracks the selected tab rather than the
    // tool, so a screen reader standing in Saved hears "Saved" — which is more
    // than the deleted <h1>Ideas</h1> ever said, since it read "Ideas" on all
    // three. The shell's rail already says Ideas; so does the first pill.
    <div data-kit role="region" aria-label={tabLabel(tab)} style={{ paddingBottom: 8 }}>
      <SubNav
        tab={tab}
        onTab={setTab}
        savedCount={saved.size}
        onRefresh={() => setNonce((v) => v + 1)}
        refreshing={loading}
        isMobile={isMobile}
      />

      <div style={{ padding: `${pad}px ${pad}px 64px`, maxWidth: BODY_MAX, margin: "0 auto" }}>
        {/* The one line the nav does not carry: where these come from and what
            the page is now for. It survived the deletion of the <h1> above it
            because it was never a repeat of anything — but it is about the FEED,
            so it does not follow you onto Skills, where it describes the wrong
            thing. */}
        {feedTab && (
          <p className="t-cap" style={{ margin: "0 0 12px" }}>
            What showed up on GitHub, and what is actually moving
          </p>
        )}

        {err && (
          <ErrorState title="Ideas didn't load" detail={err} onRetry={() => setNonce((v) => v + 1)} />
        )}

        {!err && feedTab && (
          <>
            {loading && <SkeletonRows count={5} />}

            {!loading && queueMode && (
              <QueueHeader
                round={review.round}
                done={split.done.length}
                pool={split.pool.length}
                onScreen={split.queue.length}
                waiting={split.waiting}
                filters={filters}
                sortName={sortLabel(sort)}
                arrived={arrivedSince(split.pool, review)}
                rankNote={rankNote}
                noInterests={!ranked.interests.count}
                lastRound={lastRound}
                lastRoundHere={lastRoundHere}
                onUndo={undoRound}
                onClearFilters={clearFilters}
                onShowReviewed={() => setView("reviewed")}
              />
            )}

            {!loading && historyMode && (
              <ReviewedHeader
                shownCount={reviewedRows.length}
                totalCount={reviewedAll}
                round={review.round}
                lastRound={lastRound}
                lastRoundHere={lastRoundHere}
                filters={filters}
                onUndo={undoRound}
                onBack={() => setView("queue")}
              />
            )}

            {/* Nothing saved means nothing to sort, search or narrow. Four
                controls over an empty set is chrome charged to a screen whose
                only job is to say how to fill it. */}
            {!loading && !(tab === "saved" && saved.size === 0) && (
              <Filters
                query={query} onQuery={setQuery}
                sort={sort} onSort={setSort}
                category={category} onCategory={setCategory}
                range={range} onRange={setRange}
                counts={catCounts} total={rows.length}
              />
            )}

            {/* One line of provenance where three stat tiles used to be. In the
                queue the counts are dropped from it: the header card above owns
                them, and two lines claiming the same thing is how they end up
                disagreeing. What is left is where the rows came from. */}
            {!loading && !(tab === "saved" && saved.size === 0) && (run || !queueMode) && (
              <p style={{ margin: "0 0 12px", fontSize: 11.5, lineHeight: 1.5, color: "var(--faint)", fontFamily: "var(--font-mono)" }}>
                {/* The denominator is whatever set this view is showing. On Saved
                    it is what you saved — "0 shown of 26" there counted a feed
                    the tab is not displaying — and in the history it is what you
                    have reviewed, not the feed either. */}
                {!queueMode && (
                  <>
                    {listRows.length.toLocaleString()} shown of{" "}
                    {tab === "saved" ? `${saved.size.toLocaleString()} saved`
                      : historyMode ? `${reviewedAll.toLocaleString()} reviewed`
                        : rows.length.toLocaleString()}
                  </>
                )}
                {run && <>{queueMode ? "" : " · "}last scan {ago(run.ran_at)} · {run.scanned} scanned · {run.kept_by_filter} kept · {Number(run.cost_usd) > 0 ? `$${Number(run.cost_usd).toFixed(3)}` : "free"}</>}
              </p>
            )}

            {!loading && !historyMode && visible.length === 0 && (
              <EmptyState
                icon={tab === "saved" ? "star" : "inbox"}
                tint="var(--accent)"
                title={
                  tab === "saved" ? "Nothing saved yet"
                    : query ? `Nothing matches “${query}”`
                      : category !== "all" ? `Nothing in ${CATEGORY_LABEL[category]}`
                        : "Nothing in this window"
                }
                sub={
                  tab === "saved" ? "Tap the star on an idea to keep it here. What you save is also the only thing the ranker uses to judge fit."
                    : query ? "Clear the search box, or widen the category and age filters above."
                      : category !== "all" ? "Set Category back to “All categories”, or widen the age filter."
                        : "Set Repo age to “Any age” to see everything the scan kept."
                }
              />
            )}

            {/* THE END OF THE QUEUE. Not a blank list: what you got through,
                and when there will be more — the second from the gaps between
                runs we actually fetched, never from the schedule in a comment.
                Both ways back out are right here, because this is the screen
                where "wait, I wanted one of those" happens. */}
            {!loading && queueMode && visible.length > 0 && split.queue.length === 0 && (
              <EmptyState
                icon="star"
                tint="var(--accent)"
                title={filters.length
                  ? `Reviewed all ${split.done.length.toLocaleString()} that match these filters`
                  : `Reviewed all ${split.done.length.toLocaleString()} in the feed`}
                sub={cadence.text}
                action={
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
                    {lastRound > 0 && (
                      <button type="button" className="btn md quiet" onClick={undoRound}>
                        <UndoLabel round={review.round} count={lastRound} here={lastRoundHere} />
                      </button>
                    )}
                    {split.done.length > 0 && (
                      <button type="button" className="btn md tinted" onClick={() => setView("reviewed")}>
                        See what you reviewed
                      </button>
                    )}
                    {filters.length > 0 && (
                      <button type="button" className="btn md quiet" onClick={clearFilters}>Clear filters</button>
                    )}
                  </div>
                }
              />
            )}

            {!loading && historyMode && reviewedRows.length === 0 && (
              <EmptyState
                icon="inbox"
                tint="var(--accent)"
                title="None of what you reviewed matches these filters"
                sub="The history is still there — clear the filters to see all of it."
                action={<button type="button" className="btn md quiet" onClick={clearFilters}>Clear filters</button>}
              />
            )}

            {!loading && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {(queueMode ? listRows : listRows.slice(0, shown)).map((item, i) => (
                  <IdeaCard
                    key={item.id}
                    item={item}
                    saved={saved.has(item.id)}
                    onSave={toggleSave}
                    verdict={ranked?.scored?.get(item.id)}
                    onOpenCategory={pickCategory}
                    // The queue is an ordered ten and reads as one. The history
                    // is grouped by round, where a running number would be a
                    // rank in a list nothing is ranked by.
                    rank={queueMode ? i + 1 : null}
                    why={tab === "ideas"}
                    round={historyMode ? roundOf(review, item.id) : null}
                    onRequeue={historyMode ? putBack : null}
                  />
                ))}
              </div>
            )}

            {/* DECISION 1, in the two places it has to be legible: on the button
                and directly under it. "Done with these" is a mark, not a delete,
                and the sentence names all three ways back before you press it —
                not after, in a toast that has already gone. */}
            {!loading && queueMode && split.queue.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <button type="button" className="btn md primary full" onClick={advance}>
                  {split.waiting > 0
                    ? `Done with these ${split.queue.length} — show the next ${Math.min(BATCH, split.waiting)}`
                    : `Done with these ${split.queue.length} — that empties the queue`}
                </button>
                <p className="t-cap" style={{ margin: "8px 0 0", lineHeight: 1.5, textAlign: "center" }}>
                  Marks them reviewed; nothing is deleted. They move to Reviewed, where ↩ puts
                  one back at its rank — and Undo puts the whole round back.
                </p>
              </div>
            )}

            {!loading && !queueMode && listRows.length > shown && (
              <button
                type="button"
                className="btn md quiet full"
                onClick={() => setShown((v) => v + PAGE)}
                style={{ marginTop: 12 }}
              >
                Show more ({(listRows.length - shown).toLocaleString()} more)
              </button>
            )}

            {/* At the foot of the history, under the rows it would empty. */}
            {!loading && historyMode && reviewedAll > 0 && (
              <PutAllBack count={reviewedAll} onClear={putAllBack} />
            )}
          </>
        )}

        {!err && tab === "skills" && (
          <>
            {skills === null && <SkeletonRows count={3} />}
            {skills?.length === 0 && (
              <EmptyState
                icon="inbox"
                tint="var(--accent)"
                title="No skills yet"
                sub="The reviewer holds anything it can't trace back to the source docs, which is most of what gets written."
              />
            )}
            {skills?.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {skills.map((s) => <SkillCard key={s.id} skill={s} />)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
