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
    <span
      className={state.alarm ? "biz-pulse" : undefined}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0,
        padding: "3px 8px", borderRadius: 999, whiteSpace: "nowrap",
        background: tone.bg, border: `1px solid ${tone.line}`, color: tone.fg,
        fontSize: 10, fontWeight: 700, fontFamily: "var(--font-mono)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: tone.fg, flexShrink: 0 }} />
      {label}
    </span>
  );
}

// ─── buttons ─────────────────────────────────────────────────────────────────
export function Btn({ tone = "ghost", size = "md", disabled, busy, children, style, ...rest }) {
  const tones = {
    ghost: { bg: "transparent", fg: "var(--muted)", line: "var(--border)" },
    accent: { bg: "var(--accent-soft)", fg: "var(--accent-hi)", line: "var(--accent-line)" },
    danger: { bg: "rgba(248,113,113,0.14)", fg: "#FFB4B4", line: "rgba(248,113,113,0.45)" },
    good: { bg: "rgba(62,207,142,0.13)", fg: "#7FE7B6", line: "rgba(62,207,142,0.40)" },
    solid: { bg: "var(--accent-grad)", fg: "var(--accent-ink)", line: "transparent" },
  };
  const t = tones[tone] || tones.ghost;
  const off = disabled || busy;
  return (
    <button
      type="button"
      disabled={off}
      className="biz-press"
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7,
        // 44px is the minimum thumb target, and this is a one-thumb tab.
        minHeight: size === "sm" ? 34 : 44,
        padding: size === "sm" ? "0 11px" : "0 16px",
        borderRadius: 10, cursor: off ? "not-allowed" : "pointer",
        background: t.bg, border: `1px solid ${t.line}`, color: t.fg,
        fontFamily: "var(--font-display)", fontSize: size === "sm" ? 11.5 : 13, fontWeight: 700,
        letterSpacing: "0.02em", opacity: off ? 0.55 : 1,
        transition: "transform var(--dur-1) var(--ease-out), background var(--dur-2) var(--ease-out), opacity var(--dur-2) var(--ease-out)",
        ...style,
      }}
      {...rest}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}


// ─── badges ──────────────────────────────────────────────────────────────────
export function Badge({ tone = "empty", children, title, mono = true }) {
  const t = TONE[tone] || TONE.empty;
  return (
    <span title={title} style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 7px", borderRadius: 6, whiteSpace: "nowrap",
      background: t.bg === "transparent" ? "color-mix(in srgb, var(--ink) 6%, transparent)" : t.bg,
      border: `1px solid ${t.line}`, color: t.fg,
      fontSize: 9.5, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase",
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
        <div style={{ fontSize: 13, fontWeight: 800, color: t.fg, fontFamily: "var(--font-display)", marginBottom: detail ? 4 : 0 }}>{headline}</div>
        {detail && <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.55 }}>{detail}</div>}
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
      <div style={{ fontSize: 12.5, fontWeight: 700, color: alarm ? t.fg : "var(--muted)", fontFamily: "var(--font-display)", marginBottom: 5 }}>
        {headline}
      </div>
      {detail && <div style={{ fontSize: 11, color: "var(--faint)", lineHeight: 1.55, maxWidth: 320, margin: "0 auto" }}>{detail}</div>}
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
                <div style={{ fontSize: 10.5, color: "var(--bad)", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", fontFamily: "var(--font-mono)" }}>
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
      style={{
        background: "var(--surface)",
        borderRadius: 16,
        border: `1px solid ${state.alarm ? tone.line : "var(--border)"}`,
        // The alarm reaches the panel's own edge, so a scroll past a collapsed
        // panel still registers that something is wrong.
        boxShadow: state.alarm ? `inset 3px 0 0 ${tone.fg}` : "var(--shadow-card)",
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
        <h2 style={{
          margin: 0, fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase",
          fontFamily: "var(--font-display)", color: "var(--ink)", flex: 1, minWidth: 0,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{title}</h2>
        {right}
        <FreshnessChip state={state} />
      </header>

      {summary && !isOpen && (
        <div style={{ padding: "0 14px 13px", fontSize: 11.5, color: "var(--muted)" }}>{summary}</div>
      )}

      {isOpen && <div style={{ padding: "0 14px 14px" }}>{body}</div>}
    </section>
  );
}

/** A labelled figure. Tabular by default so updating numbers don't jiggle. */
export function Stat({ label, value, sub, tone, align = "left" }) {
  return (
    <div style={{ minWidth: 0, textAlign: align }}>
      <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--faint)", fontFamily: "var(--font-mono)", marginBottom: 3 }}>{label}</div>
      <div style={{
        fontSize: 19, fontWeight: 800, lineHeight: 1.1, fontFamily: "var(--font-display)",
        color: tone ? (TONE[tone] || TONE.accent).fg : "var(--ink)",
        fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 3, fontVariantNumeric: "tabular-nums" }}>{sub}</div>}
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
