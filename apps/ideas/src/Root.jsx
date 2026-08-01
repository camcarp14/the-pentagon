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
//   Ideas   — repos, ranked and categorised
//   Saved   — the ones kept (local to this browser, like the other tools' prefs)
//   Skills  — the SKILL.md files the pipeline wrote, and the reviewer's verdict
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
import { categorize, recommend, CATEGORY_LABEL, fmtRate } from "./lib/rank.js";

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
              style={{ padding: "0 12px", minHeight: 36, whiteSpace: "nowrap", flex: "1 1 auto" }}
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
        <button
          type="button"
          className="btn sm quiet"
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

/* ── what to look at first, and why ───────────────────────────────────────────
 *
 * The whole point of the change. Every number below is computed in rank.js from
 * columns on the row, and the parts line prints the addition so a reader can
 * verify the score by eye — the same posture as Macro's screener.
 *
 * The empty case is a first-class state, not a hidden component: `reason` says
 * which of the two gates stopped it (nothing measurable at all, or measurable
 * and not moving enough) with the counts in it. A tool that quietly shows
 * nothing has told you nothing. */
function Recommended({ picks, reason, noInterests, onOpenCategory }) {
  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <span className="t-label">Worth a look</span>
        <span className="t-cap" style={{ fontFamily: "var(--font-mono)" }}>score / 100</span>
      </div>
      <p className="t-cap" style={{ margin: "6px 0 0", lineHeight: 1.5 }}>{reason}</p>
      {/* Fit reads 0 on every row until something is saved, and a zero with no
          explanation looks like a broken part rather than an absent input. */}
      {noInterests && picks.length > 0 && (
        <p className="t-cap" style={{ margin: "4px 0 0", lineHeight: 1.5 }}>
          Fit is 0 everywhere because nothing is saved yet — what you star is the only
          read on your interests this has.
        </p>
      )}

      {picks.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 10 }}>
          {picks.map((p, i) => {
            const cat = categorize(p.row);
            return (
              <div
                key={p.id}
                style={{
                  display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 10, alignItems: "start",
                  padding: "10px 0",
                  // Hairlines only INSIDE lists, inset — §4.2. The card itself
                  // keeps its shadow and stays outline-free.
                  borderTop: i === 0 ? "none" : "1px solid var(--line)",
                }}
              >
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--faint)", lineHeight: "20px", width: 16 }}>{i + 1}</span>
                <div style={{ minWidth: 0 }}>
                  <a
                    href={p.row.url} target="_blank" rel="noreferrer noopener"
                    style={{ color: "var(--ink)", textDecoration: "none", fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: 600, overflowWrap: "anywhere", display: "inline-block", minHeight: 20 }}
                  >
                    <span style={{ color: "var(--sub)", fontWeight: 400 }}>{p.row.owner}/</span>{p.row.name}
                  </a>
                  <div style={{ marginTop: 5, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    <CategoryChip cat={cat} onClick={onOpenCategory} />
                    {p.row.language && <LangTag language={p.row.language} />}
                  </div>
                  <p style={{ margin: "6px 0 0", fontSize: 12.5, lineHeight: 1.5, color: "var(--ink)" }}>{p.reason}</p>
                  {/* The addition, printed. 45 + 20 + 8 + 0 = 73 is checkable
                      against the table at the top of rank.js without trusting
                      this screen. */}
                  <p style={{ margin: "4px 0 0", fontSize: 11, lineHeight: 1.5, color: "var(--faint)", fontFamily: "var(--font-mono)" }}>
                    {p.parts.map((part) => `${part.label} ${part.points}`).join(" + ")} = {p.score}
                  </p>
                </div>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 19, fontWeight: 600, color: "var(--accent)", fontVariantNumeric: "tabular-nums", lineHeight: "20px" }}>
                  <AnimatedNumber value={p.score} format={(v) => String(Math.round(v))} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
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

/* ── one repo ─────────────────────────────────────────────────────────────── */

function IdeaCard({ item, saved, onSave, verdict, onOpenCategory }) {
  const cat = categorize(item);
  const gained = verdict?.gained;
  return (
    <Card data-ideas-row>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
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
        {/* 44px of target, pulled back out of the layout with a negative margin
            so the row does not grow to accommodate a touch floor. */}
        <button
          type="button"
          onClick={() => onSave(item.id)}
          aria-pressed={saved}
          aria-label={saved ? `Remove ${item.full_name} from saved` : `Save ${item.full_name} for later`}
          style={{
            flexShrink: 0, background: "none", border: "none", cursor: "pointer",
            width: 44, height: 44, margin: "-11px -12px -11px 0", lineHeight: 1, fontSize: 16,
            display: "inline-flex", alignItems: "flex-start", justifyContent: "flex-end", paddingTop: 10, paddingRight: 10,
            color: saved ? "var(--accent)" : "var(--faint)",
          }}
        >
          {saved ? "★" : "☆"}
        </button>
      </div>

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
  const [run, setRun] = useState(null);
  const [err, setErr] = useState(null);
  const [shown, setShown] = useState(PAGE);
  const [nonce, setNonce] = useState(0);
  const [saved, setSaved] = useState(readSaved);

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
        db().from("ideafeed_runs")
          .select("ran_at,scanned,kept_by_filter,skills_generated,cost_usd")
          .order("ran_at", { ascending: false }).limit(1),
      ]);

      if (!alive) return;
      if (c.error) { setErr(c.error.message); return; }
      setRows(c.data || []);
      setSkills(s.error ? [] : s.data || []);
      setRun(r.error ? null : r.data?.[0] || null);
    })();
    return () => { alive = false; };
  }, [nonce]);

  useEffect(() => { setShown(PAGE); }, [tab, sort, range, category, query]);

  // ONE ranking pass over the whole feed, reused by the panel, the sorts and
  // every card's rate. Two passes would be two answers.
  //
  // `Date.now()` is read HERE and handed down, so rank.js stays pure and every
  // row in one render is measured against the same instant — a clock read
  // per row makes two identical repos score differently for no reason.
  // Two picks on a phone, three on a desktop. Three fills a 852px screen to the
  // last pixel before the filters, which turns the lead into a wall; the third
  // is still the third row of the list underneath, because "Recommended" sorts
  // by the same number.
  const ranked = useMemo(() => {
    if (!rows) return null;
    return recommend(rows, { now: Date.now(), saved, limit: isMobile ? 2 : 3 });
  }, [rows, saved, isMobile]);

  const visible = useMemo(
    () => (rows ? selectVisible(rows, { tab, sort, range, saved, query, category, scored: ranked?.scored }) : null),
    [rows, tab, sort, range, saved, query, category, ranked],
  );

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

            {!loading && tab === "ideas" && (
              <Recommended
                picks={ranked.picks}
                reason={ranked.reason}
                noInterests={!ranked.interests.count}
                onOpenCategory={pickCategory}
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

            {/* One line of provenance where three stat tiles used to be. Two of
                the three numbers they carried are in here verbatim, and the
                third (Saved) is on the pill it belongs to. */}
            {!loading && !(tab === "saved" && saved.size === 0) && (
              <p style={{ margin: "0 0 12px", fontSize: 11.5, lineHeight: 1.5, color: "var(--faint)", fontFamily: "var(--font-mono)" }}>
                {/* The denominator is whatever set this tab is showing. On Saved
                    it is what you saved — "0 shown of 26" there counted a feed
                    the tab is not displaying. */}
                {visible.length.toLocaleString()} shown of{" "}
                {tab === "saved" ? `${saved.size.toLocaleString()} saved` : rows.length.toLocaleString()}
                {run && <> · last scan {ago(run.ran_at)} · {run.scanned} scanned · {run.kept_by_filter} kept · {Number(run.cost_usd) > 0 ? `$${Number(run.cost_usd).toFixed(3)}` : "free"}</>}
              </p>
            )}

            {!loading && visible.length === 0 && (
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

            {!loading && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {visible.slice(0, shown).map((item) => (
                  <IdeaCard
                    key={item.id}
                    item={item}
                    saved={saved.has(item.id)}
                    onSave={toggleSave}
                    verdict={ranked?.scored?.get(item.id)}
                    onOpenCategory={pickCategory}
                  />
                ))}
              </div>
            )}

            {!loading && visible.length > shown && (
              <button
                type="button"
                className="btn md quiet full"
                onClick={() => setShown((v) => v + PAGE)}
                style={{ marginTop: 12 }}
              >
                Show more ({(visible.length - shown).toLocaleString()} more)
              </button>
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
