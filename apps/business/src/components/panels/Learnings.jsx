// ═══════════════════════════════════════════════════════════════════════════
// Panel 8 — the archive of what the agent now believes.
//
// Every other panel here shows something HAPPENING. This one shows something
// concluded, which makes it the one place where the interface can do damage on
// its own: a row here is a sentence the agent will act on later. Rendered flat,
// a 31%-confident hunch and a 96%-confident finding are the same object, and
// the hunch inherits the finding's authority just by sitting next to it. Every
// arrangement below exists to stop that.
//
//   · confidence is said three ways at once — a lit scale, a percentage, and a
//     band word. A colour alone is a code you must already have learned; a
//     number alone is a digit the eye skims past on the way to the sentence.
//   · the STATEMENT's own weight and colour track the band, so a weak belief is
//     physically quieter on the page than a strong one. That is the part that
//     survives a two-second glance, which is the only reading this panel
//     usually gets.
//   · <Meter> is not used, though this is exactly its shape: its fill is the
//     accent gradient at every value below 1, so 0.30 and 0.95 come out the
//     same colour — the single distinction these rows exist to make.
//   · the leading edge is left alone. In this tab a 3px solid left border means
//     ALARM (AlarmBlock, blocked hypotheses, auto-proceeded approvals). A
//     confidence rail there would spend the alarm grammar on something that is
//     not news, and low confidence is not news — it is a property.
//
// Order is the query's (tables.js: learned_at desc) and is never re-sorted
// here. But a row whose learned_at will not parse has no defensible position in
// a newest-first list, so it is labelled `undated` rather than quietly placed —
// and it is invisible to B3's staleness check too, which is the more expensive
// half of the same fact.
//
// Read-only, and collapsed by default: nothing on this panel is a decision, and
// the panels above it are.
// ═══════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useSource } from "../../lib/AgentData.jsx";
import { PANEL } from "../../lib/freshness.js";
import { shortAge, ageLabel, pct, toMs, dayLabel } from "../../lib/format.js";
import { Panel, Btn, Badge, Row, ScrollList, TONE } from "../primitives.jsx";
import { SkeletonLine } from "@cc/ui";

const DAY_MS = 86_400_000;
const TAG_CHIPS_SHOWN = 10; // per panel, before "+N more"
const TAG_CHIPS_PER_ROW = 6; // per card, before "+N"

/** numeric(4,3) arrives as a string over the wire; null means the row is silent. */
const confOf = (row) => {
  const n = Number(row?.confidence);
  return Number.isFinite(n) ? n : null;
};

/** text[] comes back as an array. A bare string means the column is not the
 *  array the schema promises — kept as a single tag rather than dropped, since
 *  swallowing it would hide the disagreement instead of showing it. */
function tagsOf(row) {
  const t = row?.tags;
  const list = Array.isArray(t) ? t : typeof t === "string" && t.trim() ? [t] : [];
  return list.map((x) => String(x).trim()).filter(Boolean);
}

// The bands, and the only place they are decided. `unrecorded` is amber rather
// than neutral on purpose: a belief filed with no confidence at all is not a
// middling belief, it is an unqualified one — the exact shape this panel is
// built to refuse. Out-of-range is amber for the same reason one step further
// out: the schema CHECKs 0..1, so a 1.4 means the row and this file disagree
// about what the number even means.
function bandOf(c) {
  if (c === null) return { key: "unknown", tone: "stale", word: "confidence unrecorded" };
  if (c < 0 || c > 1) return { key: "out", tone: "stale", word: "out of range" };
  if (c >= 0.8) return { key: "high", tone: "fresh", word: "high" };
  if (c >= 0.5) return { key: "mid", tone: "accent", word: "medium" };
  return { key: "low", tone: "stale", word: "low" };
}

// The typographic ladder. Not decoration — this is the claim's weight, and it
// is the only signal that still works when the phone is at arm's length and the
// colours have merged.
const WEIGHT = {
  high: { size: 13, weight: 700, color: "var(--ink)" },
  mid: { size: 12.5, weight: 600, color: "var(--ink)" },
  low: { size: 12.5, weight: 500, color: "var(--muted)" },
  unknown: { size: 12.5, weight: 500, color: "var(--muted)" },
  out: { size: 12.5, weight: 500, color: "var(--muted)" },
};

export default function Learnings({ now }) {
  const src = useSource("learnings", now);
  const [tag, setTag] = useState(null);
  const [allTags, setAllTags] = useState(false);
  const [openIds, setOpenIds] = useState(() => new Set());

  const rows = src.rows;

  // Parsed once per fetch, not once per second: `now` is deliberately out of
  // this dependency list so a ticking clock doesn't re-derive a hundred rows.
  const items = useMemo(
    () => rows.map((row, i) => ({
      row,
      key: row?.id ?? `r${i}`,
      conf: confOf(row),
      tags: tagsOf(row),
      atMs: toMs(row?.learned_at),
    })),
    [rows]
  );

  const stats = useMemo(() => {
    const s = { high: 0, mid: 0, low: 0, unqualified: 0 };
    const tagCounts = new Map();
    for (const it of items) {
      const b = bandOf(it.conf).key;
      if (b === "high") s.high += 1;
      else if (b === "mid") s.mid += 1;
      else if (b === "low") s.low += 1;
      else s.unqualified += 1;
      for (const t of it.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
    // Commonest first, alphabetical inside a tie — a tag list that reorders
    // itself between polls is a filter row you have to re-read every time.
    s.tags = [...tagCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return s;
  }, [items]);

  const recentDay = items.reduce((n, it) => n + (it.atMs !== null && now - it.atMs < DAY_MS ? 1 : 0), 0);

  const visible = tag === null ? items : items.filter((it) => it.tags.includes(tag));

  const toggle = (key) => setOpenIds((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // Panel draws `summary` OUTSIDE its state switch, so it is the one line in
  // this component where a number could escape B3's chrome. Built per state
  // rather than from `stats`: a collapsed "0 learnings" while the first read is
  // still in flight is precisely the calm zero this tab exists to prevent.
  // ERROR and STALE force the panel open and have no collapsed line to fill.
  const summary = (() => {
    switch (src.state.state) {
      case PANEL.LOADING:
        return "Reading the archive…";
      case PANEL.EMPTY:
        return "Nothing concluded yet — the table is reachable and holds no rows.";
      case PANEL.FRESH:
        return <SummaryLine total={items.length} stats={stats} />;
      default:
        return null;
    }
  })();

  return (
    <Panel
      id="learnings"
      title="Learnings"
      state={src.state}
      onRetry={src.refresh}
      skeleton={<ArchiveSkeleton />}
      collapsible
      defaultOpen={false}
      summary={summary}
      emptyHeadline="Nothing learned yet"
      emptyDetail={`The learnings table is reachable and genuinely holds no rows${
        src.state.fetchAgeMs !== null ? ` — checked ${shortAge(src.state.fetchAgeMs)} ago` : ""
      }. An agent that has been running and has concluded nothing either found nothing surprising or stopped writing down what it did.`}
      // "How many since yesterday" is the only reason to open this panel, and it
      // is the one count the collapsed summary does not carry. Gated on the calm
      // state because Panel draws `right` in the error chrome too, and a count
      // from the last good read sitting in the header during an outage is a
      // stale number wearing the header's authority.
      right={src.state.state === PANEL.FRESH && recentDay > 0 ? <Badge tone="accent">{recentDay} today</Badge> : null}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {/* ─── tag filter ───────────────────────────────────────────────────
            Only drawn when tags exist at all. An always-present filter row over
            an untagged archive is a control that promises a cut of the data
            nobody recorded. */}
        {stats.tags.length > 0 && (
          <Row gap={6} wrap>
            <Btn size="sm" tone={tag === null ? "accent" : "ghost"} aria-pressed={tag === null} onClick={() => setTag(null)}>
              All
              <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", fontSize: 11, fontWeight: 800, color: tag === null ? "inherit" : "var(--faint)" }}>
                {items.length}
              </span>
            </Btn>
            {(allTags ? stats.tags : stats.tags.slice(0, TAG_CHIPS_SHOWN)).map((t) => {
              const active = tag === t.name;
              return (
                <Btn key={t.name} size="sm" tone={active ? "accent" : "ghost"} aria-pressed={active} onClick={() => setTag(active ? null : t.name)}>
                  {/* Tag values are printed verbatim, never re-cased: the point
                      of a tag is that what you read matches what is stored. */}
                  <span style={{ textTransform: "none", fontWeight: 700 }}>{t.name}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", fontSize: 11, fontWeight: 800, color: active ? "inherit" : "var(--faint)" }}>
                    {t.count}
                  </span>
                </Btn>
              );
            })}
            {stats.tags.length > TAG_CHIPS_SHOWN && (
              <Btn size="sm" tone="ghost" onClick={() => setAllTags((s) => !s)}>
                {allTags ? "Fewer tags" : `+${stats.tags.length - TAG_CHIPS_SHOWN} more`}
              </Btn>
            )}
          </Row>
        )}

        {/* ─── the archive, newest first ──────────────────────────────────── */}
        {visible.length > 0 && (
          <ScrollList maxHeight={420}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {visible.map((it) => (
                <LearningRow
                  key={it.key}
                  it={it}
                  now={now}
                  open={openIds.has(it.key)}
                  onToggle={() => toggle(it.key)}
                />
              ))}
            </div>
          </ScrollList>
        )}

        {/* ─── the filter is empty, and the source is not ───────────────────
            Deliberately NOT an EmptyBlock. The dashed, centred, unfilled frame
            is this tab's vocabulary for "we reached the database and it truly
            holds nothing"; borrowing it for a chip that matched nothing would
            make a false claim about the database. Solid, filled, left-aligned,
            and it names the rows it is hiding. Reachable in practice: a tag can
            disappear from the archive between polls while still selected. */}
        {visible.length === 0 && items.length > 0 && (
          <div style={{ borderRadius: 11, border: "1px solid var(--border)", background: "var(--subtle)", padding: "12px 12px" }}>
            <div className="t-foot" style={{ fontWeight: 700, color: "var(--ink)" }}>
              Nothing tagged “{tag}”
            </div>
            <div className="t-cap" style={{ color: "var(--muted)", lineHeight: 1.55, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
              The archive holds {items.length} learning{items.length === 1 ? "" : "s"} — none carrying this tag. The filter is
              empty, not the source; the database answered {src.state.fetchAgeMs === null ? "this session" : `${shortAge(src.state.fetchAgeMs)} ago`}.
            </div>
            <Btn size="sm" tone="ghost" onClick={() => setTag(null)} style={{ marginTop: 10, width: "100%" }}>
              Show all {items.length}
            </Btn>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ─── one learning ────────────────────────────────────────────────────────────
function LearningRow({ it, now, open, onToggle }) {
  const { row, conf, tags, atMs } = it;
  const band = bandOf(conf);
  const type = WEIGHT[band.key] || WEIGHT.mid;

  const statement = typeof row?.statement === "string" ? row.statement.trim() : "";
  const detail = typeof row?.detail === "string" ? row.detail.trim() : "";
  const sourceId = typeof row?.source_action_id === "string" ? row.source_action_id.trim() : "";
  // Provenance earns a tap even with no working written down — "which action
  // produced this belief" is the only way to audit it from outside this screen.
  const expandable = detail.length > 0 || sourceId.length > 0;
  const ageMs = atMs === null ? null : Math.max(0, now - atMs);

  const press = expandable
    ? {
        className: "biz-press",
        role: "button",
        tabIndex: 0,
        "aria-expanded": open,
        onClick: onToggle,
        onKeyDown: (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
        },
      }
    : {};

  return (
    <div
      {...press}
      style={{
        padding: "10px 11px", borderRadius: 11, minHeight: 44,
        background: "var(--subtle)", border: "1px solid var(--border)",
        cursor: expandable ? "pointer" : "default",
        transition: "background var(--dur-2) var(--ease-out)",
      }}
    >
      {/* The belief itself, at the weight its confidence has earned. Clamped to
          four lines closed and released open — a statement truncated forever is
          a belief you cannot check. */}
      <div style={{
        fontSize: type.size, fontWeight: type.weight, color: type.color, lineHeight: 1.45,
        overflowWrap: "anywhere", overflow: "hidden",
        display: "-webkit-box", WebkitBoxOrient: "vertical",
        WebkitLineClamp: open ? undefined : 4,
      }}>
        {statement || "No statement recorded"}
      </div>

      <Row gap={7} wrap style={{ marginTop: 8 }}>
        <ConfidenceScale value={conf} tone={band.tone} />
        <Badge
          tone={band.tone}
          title={conf === null
            ? "This row carries no readable confidence, so how strongly it is held cannot be shown."
            : `Recorded confidence ${conf}. 0.8+ high · 0.5–0.8 medium · below 0.5 low.`}
        >
          {conf === null ? band.word : (
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{pct(conf, 0)} · {band.word}</span>
          )}
        </Badge>

        {/* Source is left uncoloured. The confidence band is the only colour
            axis on a row this small; a second ramp for evidence type would mean
            neither gets read. Unknown values print verbatim rather than being
            dropped — a source outside the documented three is worth seeing. */}
        {row?.source && <Badge>{row.source}</Badge>}

        {atMs === null
          ? <Badge tone="stale" title="No readable learned_at, so this row's place in a newest-first list means nothing.">undated</Badge>
          : (
            <span style={{ fontSize: 10.5, color: "var(--faint)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
              {ageLabel(ageMs)}
            </span>
          )}

        {expandable && (
          <span style={{
            marginLeft: "auto", display: "inline-flex", color: "var(--faint)", flexShrink: 0,
            transform: `rotate(${open ? 90 : 0}deg)`, transition: "transform var(--dur-2) var(--ease-out)",
          }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}
      </Row>

      {/* Tags stay flat text, not buttons: the card is already one tap target,
          and a control nested inside it would fight the gesture that opens it.
          Filtering lives in the row of chips at the top, where it can be hit. */}
      {tags.length > 0 && (
        <Row gap={5} wrap style={{ marginTop: 7 }}>
          {tags.slice(0, TAG_CHIPS_PER_ROW).map((t) => <TagChip key={t} label={t} />)}
          {tags.length > TAG_CHIPS_PER_ROW && (
            <TagChip label={`+${tags.length - TAG_CHIPS_PER_ROW}`} title={tags.slice(TAG_CHIPS_PER_ROW).join(", ")} />
          )}
        </Row>
      )}

      {expandable && open && (
        <div style={{ marginTop: 9, paddingTop: 9, borderTop: "1px solid var(--border)" }}>
          <SectionLabel>{detail ? "The working" : "Provenance"}</SectionLabel>
          <div className="t-cap" style={{
            lineHeight: 1.6, marginTop: 4, overflowWrap: "anywhere",
            color: detail ? "var(--muted)" : TONE.stale.fg,
          }}>
            {detail || "No working recorded — this belief is stated without the reasoning behind it, so nothing here can be checked against anything."}
          </div>

          {/* 11.5px, not 10: Row takes no className, so the kit's .t-cap size
              is written out. 10 was under the floor. */}
          <Row gap={7} wrap style={{ marginTop: 8, fontSize: 11.5, color: "var(--faint)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            {/* The relative age above answers "is this recent"; the date answers
                "which week was this", and past a few days those stop being the
                same question. */}
            <span>{atMs === null ? "no recorded date" : `learned ${dayLabel(row?.learned_at)}`}</span>
            <span style={{ opacity: 0.45 }}>·</span>
            <span title={sourceId || undefined}>
              {sourceId ? `from action ${sourceId.slice(0, 8)}` : "no source action"}
            </span>
          </Row>
        </div>
      )}
    </div>
  );
}

// ─── the scale ───────────────────────────────────────────────────────────────
/**
 * Five lamps, each holding exactly 0.2, and the boundary lamp filled to its true
 * fraction instead of rounded. Rounding up is how 0.79 starts looking like 0.8,
 * which is the precise border this panel is drawing — so the scale is allowed to
 * look awkward rather than tidy. aria-hidden because the badge beside it already
 * says the same thing in words a screen reader can use.
 */
function ConfidenceScale({ value, tone }) {
  const t = TONE[tone] || TONE.empty;
  const known = value !== null && Number.isFinite(value);
  const v = known ? Math.max(0, Math.min(1, value)) : 0;
  return (
    <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
      {[0, 1, 2, 3, 4].map((k) => {
        const fill = Math.max(0, Math.min(1, v * 5 - k));
        return (
          <span
            key={k}
            style={{
              width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
              border: `1px solid ${known ? t.line : "var(--border)"}`,
              background: fill <= 0
                ? "transparent"
                : `linear-gradient(to right, ${t.fg} ${fill * 100}%, transparent ${fill * 100}%)`,
              transition: "background var(--dur-2) var(--ease-out)",
            }}
          />
        );
      })}
    </span>
  );
}

// ─── bits ────────────────────────────────────────────────────────────────────
function TagChip({ label, title }) {
  return (
    // .stattile-label is the kit's 10.5px micro-label; the chip was 9.5px.
    <span title={title} className="stattile-label" style={{
      display: "inline-flex", alignItems: "center", padding: "2px 6px", borderRadius: 6,
      background: "color-mix(in srgb, var(--ink) 6%, transparent)", border: "1px solid var(--border)",
      color: "var(--muted)", fontFamily: "var(--font-mono)", fontWeight: 700,
      maxWidth: 140,
    }}>{label}</span>
  );
}

function SectionLabel({ children, tone }) {
  return (
    // .t-label IS this label — 12px, 600, tracked, uppercase. It was hand-set
    // at 9.5px, under the 10.5px floor, and uppercase is only allowed on
    // .t-label anyway.
    <div className="t-label" style={{
      color: tone ? (TONE[tone] || TONE.empty).fg : "var(--faint)", fontFamily: "var(--font-mono)",
    }}>{children}</div>
  );
}

/** The collapsed line. High confidence leads because it is the part of the
 *  archive the agent is entitled to act on; the low count is carried beside it
 *  in amber so the ratio is visible without opening anything — an archive that
 *  is mostly hunches is a different object from one that is mostly findings. */
function SummaryLine({ total, stats }) {
  const parts = [
    { k: "total", text: `${total} learning${total === 1 ? "" : "s"}` },
    { k: "high", text: `${stats.high} high confidence`, fg: stats.high > 0 ? TONE.fresh.fg : undefined },
  ];
  if (stats.low > 0) parts.push({ k: "low", text: `${stats.low} low`, fg: TONE.stale.fg });
  if (stats.unqualified > 0) parts.push({ k: "unq", text: `${stats.unqualified} unqualified`, fg: TONE.stale.fg });

  return (
    <Row gap={6} wrap style={{ fontVariantNumeric: "tabular-nums" }}>
      {parts.map((p, i) => (
        <span key={p.k} style={{ display: "inline-flex", gap: 6 }}>
          {i > 0 && <span style={{ opacity: 0.4 }}>·</span>}
          <span style={{ color: p.fg || "inherit", fontWeight: p.fg ? 700 : 400 }}>{p.text}</span>
        </span>
      ))}
    </Row>
  );
}

// ─── loading ─────────────────────────────────────────────────────────────────
// Shaped like a filter row over stacked statements, and containing no digits and
// no lit lamps: a skeleton carrying a placeholder count or a half-full scale is
// the calm zero wearing a shimmer.
function ArchiveSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      <Row gap={6} wrap>
        {["44px", "70px", "58px", "66px"].map((w, i) => <SkeletonLine key={i} width={w} height="26px" />)}
      </Row>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{
          borderRadius: 11, border: "1px solid var(--border)", padding: "10px 11px",
          display: "flex", flexDirection: "column", gap: 8, opacity: 1 - i * 0.22,
        }}>
          <SkeletonLine width="90%" height="13px" />
          <SkeletonLine width="62%" height="13px" />
          <Row gap={6}>
            <ConfidenceScale value={null} tone="empty" />
            <SkeletonLine width="86px" height="12px" />
          </Row>
        </div>
      ))}
    </div>
  );
}
