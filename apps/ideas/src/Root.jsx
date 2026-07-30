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
// The scanner also has a standalone static site. This is the same data; the
// difference is that here it sits behind the one login next to everything else,
// which is the whole point of the shell.
//
// Three surfaces, in the order they get used:
//   Ideas   — repos, newest first
//   Saved   — the ones kept (local to this browser, like the other tools' prefs)
//   Skills  — the SKILL.md files the pipeline wrote, and the reviewer's verdict
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState } from "react";
import { theme } from "@cc/design";
import { supabase } from "@cc/supabase";
import { AnimatedNumber, EmptyState, ErrorState, SkeletonRows, useIsMobile } from "@cc/ui";

const T = theme("ideas");

// The client's default schema is `public`, which is where the scanner writes —
// so unlike ZTS and Runway this tool needs no schema hop.
const db = () => supabase;

const TABS = [
  ["ideas", "Ideas"],
  ["saved", "Saved"],
  ["skills", "Skills"],
];

const SORTS = [
  ["newest", "Newest"],
  ["popping", "Popping"],
  ["stars", "Stars"],
];

const RANGES = [
  [7, "7d"],
  [30, "30d"],
  [90, "90d"],
  [0, "All"],
];

const PAGE = 24;
const SAVED_KEY = "ideas_saved";

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

const Card = ({ children, style }) => (
  <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: T.rLg, padding: 16, minWidth: 0, ...style }}>
    {children}
  </div>
);

// minWidth 96, not 132: at 390px the row has 342px of usable width, so a
// 132px floor forced the third tile onto its own full-width line while the
// other two shared one. Three narrow tiles read as one group; two-plus-one
// reads as a mistake.
const Stat = ({ label, children, sub }) => (
  <Card style={{ flex: 1, minWidth: 96, padding: 14 }}>
    <div style={{ fontSize: 10, fontWeight: 700, color: T.faint, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 7, fontFamily: T.fontDisplay }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 800, color: T.ink, fontFamily: T.fontDisplay, lineHeight: 1 }}>{children}</div>
    {sub && <div style={{ fontSize: 11, color: T.muted, marginTop: 5 }}>{sub}</div>}
  </Card>
);

// One control grammar for all three rows, so tab / sort / range never read as
// three different kinds of switch.
function Segment({ value, onChange, options, style }) {
  return (
    <div role="tablist" style={{ display: "inline-flex", background: T.subtle, border: `1px solid ${T.line}`, borderRadius: T.rPill, padding: 3, gap: 2, ...style }}>
      {options.map(([key, label]) => {
        const on = key === value;
        return (
          <button
            key={String(key)}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(key)}
            style={{
              appearance: "none", border: "none", cursor: "pointer",
              background: on ? T.accentSoft : "transparent",
              color: on ? T.accent : T.muted,
              font: "inherit", fontSize: 12, fontWeight: on ? 700 : 600,
              padding: "7px 13px", borderRadius: T.rPill, whiteSpace: "nowrap",
              transition: `background ${T.M.durFast} ${T.M.easeStd}, color ${T.M.durFast} ${T.M.easeStd}`,
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/* ── one repo ─────────────────────────────────────────────────────────────── */

function IdeaCard({ item, saved, onSave }) {
  const gained = Math.max(0, (item.stars ?? 0) - (item.stars_at_first_seen ?? item.stars ?? 0));
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0 }}>
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          style={{ flex: 1, minWidth: 0, color: T.ink, textDecoration: "none", fontFamily: T.fontMono, fontSize: 13, fontWeight: 600, overflowWrap: "anywhere" }}
        >
          <span style={{ color: T.muted, fontWeight: 400 }}>{item.owner}/</span>
          {item.name}
        </a>
        <button
          type="button"
          onClick={() => onSave(item.id)}
          aria-pressed={saved}
          aria-label={saved ? `Remove ${item.full_name} from saved` : `Save ${item.full_name} for later`}
          style={{
            flexShrink: 0, background: "none", border: "none", cursor: "pointer",
            padding: 4, margin: -4, lineHeight: 1, fontSize: 15,
            color: saved ? T.accent : T.faint,
          }}
        >
          {saved ? "★" : "☆"}
        </button>
      </div>

      {item.hook && (
        <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.55, color: T.muted }}>{item.hook}</p>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", marginTop: 10, fontSize: 11, color: T.faint, fontFamily: T.fontMono }}>
        {item.language && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: LANG[item.language] || T.faint }} />
            {item.language}
          </span>
        )}
        <span>{compact(item.stars)}★</span>
        {gained > 0 && <span style={{ color: T.good }}>+{compact(gained)}</span>}
        <span>{ageLabel(item.age_days)}</span>
        {item.skills_extracted > 0 && (
          <span style={{ color: T.accent }}>
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
  const tone = verdict === "approve" ? T.good : verdict === "reject" ? T.bad : T.warn;
  const label = skill.published ? "Published" : verdict === "approve" ? "Approved" : verdict === "reject" ? "Rejected" : "Held";
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span style={{ flex: 1, minWidth: 0, color: T.ink, fontFamily: T.fontMono, fontSize: 12.5, fontWeight: 600, overflowWrap: "anywhere" }}>
          {skill.slug || skill.name}
        </span>
        <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: tone }}>
          {label}
        </span>
      </div>

      {skill.description && (
        <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.55, color: T.muted }}>{skill.description}</p>
      )}

      {skill.source?.full_name && (
        <a
          href={skill.source.url}
          target="_blank"
          rel="noreferrer noopener"
          style={{ display: "inline-block", marginTop: 9, fontSize: 11, color: T.faint, fontFamily: T.fontMono, textDecoration: "none" }}
        >
          {skill.source.full_name} ↗
        </a>
      )}

      {skill.body && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            style={{
              display: "block", width: "100%", marginTop: 12, padding: "8px 12px",
              background: open ? T.accentSoft : "transparent",
              border: `1px solid ${open ? T.accentLine : T.line}`, borderRadius: T.rMd,
              color: open ? T.accent : T.muted, font: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}
          >
            {open ? "Hide SKILL.md" : "Read SKILL.md"}
          </button>
          {open && (
            <pre style={{ margin: "12px 0 0", fontSize: 11.5, lineHeight: 1.6, color: T.muted, fontFamily: T.fontMono, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
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
  const [sort, setSort] = useState("newest");
  const [range, setRange] = useState(30);
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

  useEffect(() => { setShown(PAGE); }, [tab, sort, range]);

  const visible = useMemo(() => {
    if (!rows) return null;
    let list = tab === "saved" ? rows.filter((r) => saved.has(r.id)) : rows;
    if (range > 0) list = list.filter((r) => (r.age_days ?? 0) <= range);

    const n = (v) => Number(v ?? 0);
    return [...list].sort((a, b) => {
      if (sort === "popping") return n(b.star_velocity) - n(a.star_velocity);
      if (sort === "stars") return n(b.stars) - n(a.stars);
      // Newest means when it turned up HERE, not when the repo was created —
      // this is a feed. Score breaks the tie because one scan stamps every row
      // it adds with the same timestamp, so the tiebreak orders the whole batch.
      return new Date(b.first_seen) - new Date(a.first_seen) || n(b.score) - n(a.score);
    });
  }, [rows, tab, sort, range, saved]);

  const newestBatch = useMemo(() => {
    if (!rows?.length) return 0;
    const newest = rows[0].first_seen;
    return newest ? rows.filter((r) => r.first_seen === newest).length : 0;
  }, [rows]);

  const loading = rows === null;
  const pad = isMobile ? 14 : 24;

  return (
    <div style={{ padding: `${pad}px ${pad}px 64px`, maxWidth: 940, margin: "0 auto", fontFamily: T.fontBody }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: isMobile ? 22 : 27, fontWeight: 800, fontFamily: T.fontDisplay, color: T.ink, letterSpacing: "-0.01em" }}>
          Ideas
        </h1>
        <p style={{ margin: "5px 0 0", fontSize: 13, color: T.muted }}>
          What showed up on GitHub, worth a look
        </p>
      </header>

      <Segment value={tab} onChange={setTab} options={TABS} style={{ marginBottom: 16 }} />

      {err && (
        <ErrorState title="Ideas didn't load" detail={err} onRetry={() => setNonce((v) => v + 1)} />
      )}

      {!err && tab !== "skills" && (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <Stat label="In the feed">{loading ? "—" : <AnimatedNumber value={rows.length} format={(v) => Math.round(v).toLocaleString()} />}</Stat>
            <Stat label="Newest batch" sub={run ? `scanned ${ago(run.ran_at)}` : undefined}>
              {loading ? "—" : <AnimatedNumber value={newestBatch} format={(v) => Math.round(v).toLocaleString()} />}
            </Stat>
            <Stat label="Saved">{<AnimatedNumber value={saved.size} format={(v) => Math.round(v).toLocaleString()} />}</Stat>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            <Segment value={sort} onChange={setSort} options={SORTS} />
            <Segment value={range} onChange={setRange} options={RANGES} />
          </div>

          {run && (
            <p style={{ margin: "0 0 12px", fontSize: 11.5, color: T.faint, fontFamily: T.fontMono }}>
              Last scan {ago(run.ran_at)} · {run.scanned} scanned · {run.kept_by_filter} kept ·{" "}
              {Number(run.cost_usd) > 0 ? `$${Number(run.cost_usd).toFixed(3)}` : "free"}
            </p>
          )}

          {loading && <SkeletonRows count={4} />}

          {!loading && visible.length === 0 && (
            <EmptyState
              icon={tab === "saved" ? "star" : "inbox"}
              tint={T.accent}
              title={tab === "saved" ? "Nothing saved yet" : "Nothing in this window"}
              sub={tab === "saved" ? "Tap the star on an idea to keep it here." : "Widen the range to see more."}
            />
          )}

          {!loading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {visible.slice(0, shown).map((item) => (
                <IdeaCard key={item.id} item={item} saved={saved.has(item.id)} onSave={toggleSave} />
              ))}
            </div>
          )}

          {!loading && visible.length > shown && (
            <button
              type="button"
              onClick={() => setShown((v) => v + PAGE)}
              style={{
                display: "block", width: "100%", marginTop: 12, padding: "11px 16px",
                background: "transparent", border: `1px solid ${T.line}`, borderRadius: T.rMd,
                color: T.muted, font: "inherit", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
              }}
            >
              Show more ({visible.length - shown} more)
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
              tint={T.accent}
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
  );
}
