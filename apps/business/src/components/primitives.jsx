// ═══════════════════════════════════════════════════════════════════════════
// The tab's visual vocabulary.
//
// <Panel> is the load-bearing one. B3 says loading, empty and stale must never
// be conflated — so no panel in this tab is allowed to decide that for itself.
// Every one of them hands its resolved state to this component, which owns the
// four treatments and makes them structurally different, not just differently
// worded:
//
//   loading  shimmer bars, neutral chrome, no numbers on screen at all
//   empty    DASHED border, plain statement, plus the time of the successful
//            check — "reachable, and really empty"
//   stale    SOLID amber rule + warning glyph + the actual age, over the rows
//   error    SOLID red rule + warning glyph + a Retry, and any rows below it
//            are explicitly labelled as being from the last good read
//
// Shape, colour, glyph and copy all disagree between the four, so telling them
// apart never depends on reading carefully — which is the only standard that
// survives a two-minute glance on a phone.
// ═══════════════════════════════════════════════════════════════════════════
import { Component, useEffect, useRef, useState } from "react";
import { SkeletonLine } from "@cc/ui";
import { PANEL } from "../lib/freshness.js";
import { shortAge } from "../lib/format.js";

// ─── tone ────────────────────────────────────────────────────────────────────
export const TONE = {
  fresh: { fg: "var(--good)", bg: "rgba(62,207,142,0.10)", line: "rgba(62,207,142,0.36)" },
  stale: { fg: "var(--warn)", bg: "rgba(245,184,77,0.12)", line: "rgba(245,184,77,0.42)" },
  error: { fg: "var(--bad)", bg: "rgba(248,113,113,0.12)", line: "rgba(248,113,113,0.45)" },
  empty: { fg: "var(--muted)", bg: "transparent", line: "var(--border)" },
  loading: { fg: "var(--faint)", bg: "transparent", line: "var(--border)" },
  accent: { fg: "var(--accent)", bg: "var(--accent-soft)", line: "var(--accent-line)" },
};

const toneFor = (state) => TONE[state] || TONE.loading;

// ─── the freshness chip — on every panel, always, no exceptions ──────────────
export function FreshnessChip({ state }) {
  const tone = toneFor(state.state);
  const label = (() => {
    switch (state.state) {
      case PANEL.LOADING: return "loading…";
      case PANEL.ERROR: return "unreachable";
      case PANEL.EMPTY: return state.fetchAgeMs === null ? "empty" : `empty · checked ${shortAge(state.fetchAgeMs)} ago`;
      case PANEL.STALE: return state.dataAgeMs === null ? "age unknown" : `${shortAge(state.dataAgeMs)} old`;
      default: return `${shortAge(state.dataAgeMs)} ago`;
    }
  })();
  return (
    // .t-cap is the kit's small-print size (11.5px). The chip was hand-set at
    // 10px — under the 10.5px floor, on the one element that appears on every
    // panel in the tab, which made it the most-repeated violation here.
    <span
      className={state.alarm ? "t-cap biz-pulse" : "t-cap"}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0,
        padding: "3px 8px", borderRadius: 999, whiteSpace: "nowrap",
        background: tone.bg, border: `1px solid ${tone.line}`, color: tone.fg,
        fontWeight: 700, fontFamily: "var(--font-mono)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: tone.fg, flexShrink: 0 }} />
      {label}
    </span>
  );
}

// ─── buttons ─────────────────────────────────────────────────────────────────
// The kit's .btn carries the geometry these were hand-rolling: .md is 44px tall
// (the one-thumb target this tab is designed around) and .sm is 34px — exactly
// the two heights that were written inline — with no border, which is what the
// language wants on a filled control.
//
// Four of the five tones map onto a kit class. `good` does not: the kit's tones
// are accent-derived (.primary/.tinted/.plain) plus .danger, and green here is a
// semantic verdict colour, not the tool's accent. It keeps its own fill on top
// of .btn's geometry rather than borrowing .primary and saying "accent" when it
// means "safe".
const KIT_TONE = {
  ghost: "quiet",
  accent: "tinted",
  danger: "danger",
  good: "",
  solid: "primary",
};

export function Btn({ tone = "ghost", size = "md", disabled, busy, children, style, ...rest }) {
  const kit = KIT_TONE[tone] ?? KIT_TONE.ghost;
  const off = disabled || busy;
  return (
    <button
      type="button"
      disabled={off}
      className={["btn", size === "sm" ? "sm" : "md", kit, "biz-press"].filter(Boolean).join(" ")}
      style={{
        ...(tone === "good"
          ? { background: "color-mix(in srgb, var(--good) 13%, transparent)", color: "var(--good)" }
          : null),
        ...style,
      }}
      {...rest}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

/**
 * The busy indicator inside <Btn busy>.
 *
 * It was referenced and never defined — a free variable that threw
 * "Spinner is not defined" the first time anything set `busy`, which is the
 * HALT button mid-halt, Save in the goal editor, Sign out, and every
 * approve/veto. `vite build` was green on it; nothing rendered it until a tap.
 * It is the kit's .spinner now, which is the drawn arc this was always meant
 * to be. See the render test, which renders <Btn busy> on purpose.
 */
function Spinner() {
  return <span className="spinner" aria-hidden="true" style={{ width: 14, height: 14, borderWidth: 2 }} />;
}


// ─── badges ──────────────────────────────────────────────────────────────────
export function Badge({ tone = "empty", children, title, mono = true }) {
  const t = TONE[tone] || TONE.empty;
  return (
    // .t-label IS this badge: 12px, 600, tracked, uppercase. It was hand-rolled
    // at 9.5px — under the floor — doing the identical job, and uppercase is
    // only allowed on .t-label anyway.
    <span title={title} className="t-label" style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "3px 7px", borderRadius: 6, whiteSpace: "nowrap",
      background: t.bg === "transparent" ? "color-mix(in srgb, var(--ink) 6%, transparent)" : t.bg,
      border: `1px solid ${t.line}`, color: t.fg,
      fontFamily: mono ? "var(--font-mono)" : "var(--font-display)",
    }}>{children}</span>
  );
}

/** A labelled meter. `pct` over 1 renders the overflow in the alarm colour. */
export function Meter({ pct, tone = "accent", height = 6 }) {
  const p = Number.isFinite(pct) ? Math.max(0, pct) : 0;
  const over = p > 1;
  const t = over ? TONE.error : TONE[tone] || TONE.accent;
  return (
    <div style={{ position: "relative", height, borderRadius: 999, background: "color-mix(in srgb, var(--ink) 8%, transparent)", overflow: "hidden" }}>
      <div style={{
        position: "absolute", inset: 0, width: `${Math.min(100, p * 100)}%`,
        background: over ? t.fg : "var(--accent-grad)", borderRadius: 999,
        transition: "width var(--dur-3) var(--ease-out)",
      }} />
    </div>
  );
}

// ─── the alarm block — the anti-calm-zero ────────────────────────────────────
export function AlarmBlock({ tone = "error", headline, detail, action }) {
  const t = TONE[tone] || TONE.error;
  return (
    <div style={{
      display: "flex", gap: 11, alignItems: "flex-start",
      padding: "13px 14px", borderRadius: 12,
      background: t.bg,
      // A solid rule on the leading edge. The empty state uses a DASHED border
      // and no fill, so the two do not resemble each other even out of focus.
      border: `1px solid ${t.line}`, borderLeft: `3px solid ${t.fg}`,
    }}>
      <span style={{ color: t.fg, flexShrink: 0, marginTop: 1 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 3.5 22 20H2L12 3.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M12 10v4.5M12 17.4v.1" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="t-call" style={{ fontWeight: 800, color: t.fg, marginBottom: detail ? 4 : 0 }}>{headline}</div>
        {detail && <div className="t-cap" style={{ color: "var(--muted)", lineHeight: 1.55 }}>{detail}</div>}
        {action && <div style={{ marginTop: 10 }}>{action}</div>}
      </div>
    </div>
  );
}

/** Empty ≠ broken. Dashed, unfilled, and it names the successful check. */
export function EmptyBlock({ headline, detail, alarm }) {
  const t = alarm ? TONE.stale : TONE.empty;
  return (
    <div style={{
      padding: "22px 16px", borderRadius: 12, textAlign: "center",
      border: `1px dashed ${t.line}`, background: "transparent",
    }}>
      <div className="t-foot" style={{ fontWeight: 700, color: alarm ? t.fg : "var(--muted)", marginBottom: 5 }}>
        {headline}
      </div>
      {detail && <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.55, maxWidth: 320, margin: "0 auto" }}>{detail}</div>}
    </div>
  );
}

// ─── error boundary — per region, so one panel can't take the tab down ───────
export class Boundary extends Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ padding: this.props.bare ? 0 : "0 0 4px" }}>
        <AlarmBlock
          tone="error"
          headline={this.props.label ? `${this.props.label} crashed` : "This section crashed"}
          detail={`${String(this.state.err.message || this.state.err)} — the halt control above is on its own path and is unaffected.`}
          action={<Btn size="sm" tone="danger" onClick={() => this.setState({ err: null })}>Try again</Btn>}
        />
      </div>
    );
  }
}

// ─── Panel ───────────────────────────────────────────────────────────────────
export function Panel({
  title,
  state,
  onRetry,
  skeleton,
  emptyHeadline,
  emptyDetail,
  right,
  summary,
  collapsible = false,
  defaultOpen = true,
  children,
  id,
}) {
  // An alarming panel cannot be collapsed shut. Hiding an outage behind a tap
  // is the same failure as painting it calm — it just takes one more gesture
  // to be misled. Alarms force themselves open and stay open.
  const [open, setOpen] = useState(defaultOpen);
  const forced = state.alarm;
  const isOpen = forced || open || !collapsible;

  const body = (() => {
    switch (state.state) {
      case PANEL.LOADING:
        return skeleton || (
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <SkeletonLine width="70%" height="12px" />
            <SkeletonLine width="92%" />
            <SkeletonLine width="48%" />
          </div>
        );

      case PANEL.ERROR:
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <AlarmBlock
              tone="error"
              headline={state.headline}
              detail={[state.detail, state.error].filter(Boolean).join(" · ")}
              action={onRetry ? <Btn size="sm" tone="danger" onClick={onRetry}>Retry</Btn> : null}
            />
            {state.rowCount > 0 && (
              <>
                <div className="t-label" style={{ color: "var(--bad)", fontWeight: 700, fontFamily: "var(--font-mono)" }}>
                  ↓ from the last good read, not from now
                </div>
                <div style={{ opacity: 0.5, filter: "saturate(0.4)" }}>{children}</div>
              </>
            )}
          </div>
        );

      case PANEL.EMPTY:
        return <EmptyBlock alarm={state.alarm} headline={emptyHeadline || state.headline} detail={emptyDetail || state.detail} />;

      case PANEL.STALE:
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <AlarmBlock tone="stale" headline={state.headline} detail={state.detail} action={onRetry ? <Btn size="sm" tone="ghost" onClick={onRetry}>Refresh</Btn> : null} />
            {state.rowCount > 0 && children}
          </div>
        );

      default:
        return children;
    }
  })();

  const tone = toneFor(state.state);

  return (
    <section
      id={id}
      // The kit's card — one material, no outline. This had a 1px border AND a
      // shadow, which the language forbids on the same element; separating by
      // tone and shadow is what .card already does. The alarm rail survives as
      // an inset shadow stacked on the card's own, so nothing regains a border.
      className="card"
      style={{
        // The alarm reaches the panel's own edge, so a scroll past a collapsed
        // panel still registers that something is wrong.
        boxShadow: state.alarm ? `inset 3px 0 0 ${tone.fg}, var(--shadow-card)` : undefined,
        overflow: "hidden",
      }}
    >
      <header
        onClick={collapsible && !forced ? () => setOpen((o) => !o) : undefined}
        style={{
          display: "flex", alignItems: "center", gap: 9, padding: "13px 14px",
          cursor: collapsible && !forced ? "pointer" : "default",
          minHeight: collapsible ? 44 : undefined,
        }}
      >
        {collapsible && (
          <span style={{
            color: "var(--faint)", flexShrink: 0, display: "inline-flex",
            transform: `rotate(${isOpen ? 90 : 0}deg)`, transition: "transform var(--dur-2) var(--ease-out)",
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
        )}
        {/* .t-label — 12px, tracked, uppercase, which is what this was doing by
            hand at the same size. Uppercase is only allowed on .t-label. */}
        <h2 className="t-label" style={{
          margin: 0, fontWeight: 800, color: "var(--ink)", flex: 1, minWidth: 0,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{title}</h2>
        {right}
        <FreshnessChip state={state} />
      </header>

      {summary && !isOpen && (
        <div className="t-cap" style={{ padding: "0 14px 13px", color: "var(--muted)" }}>{summary}</div>
      )}

      {isOpen && <div style={{ padding: "0 14px 14px" }}>{body}</div>}
    </section>
  );
}

/** A labelled figure. Tabular by default so updating numbers don't jiggle. */
export function Stat({ label, value, sub, tone, align = "left" }) {
  return (
    // The kit's stat-tile grammar (.t-label + .stattile-value) without the tile
    // itself — these sit inside a Panel, which is already a card, and nesting a
    // second surface inside it would be a well inside a well. The label was
    // 9.5px, under the floor, hand-doing what .t-label does at 12.
    <div style={{ minWidth: 0, textAlign: align }}>
      <div className="t-label" style={{ color: "var(--faint)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>{label}</div>
      <div className="stattile-value" style={{
        fontWeight: 800, lineHeight: 1.1,
        color: tone ? (TONE[tone] || TONE.accent).fg : "var(--ink)",
      }}>{value}</div>
      {sub && <div className="t-cap" style={{ color: "var(--muted)", marginTop: 3, fontVariantNumeric: "tabular-nums" }}>{sub}</div>}
    </div>
  );
}

export function Row({ children, gap = 10, wrap = false, align = "center", style }) {
  return <div style={{ display: "flex", alignItems: align, gap, flexWrap: wrap ? "wrap" : "nowrap", minWidth: 0, ...style }}>{children}</div>;
}

/** Scroll a long list without letting the page grow forever on a phone. */
export function ScrollList({ maxHeight = 340, children }) {
  const ref = useRef(null);
  return <div ref={ref} className="biz-scroll" style={{ maxHeight, overflowY: "auto", margin: "0 -4px", padding: "0 4px" }}>{children}</div>;
}
