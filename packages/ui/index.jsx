// ═══════════════════════════════════════════════════════════════════════════
// @cc/ui — the shared "feel" layer for every tool in The Pentagon.
//
// One canonical copy of the primitives that used to be duplicated three times.
// Motion, skeletons, empty states, toasts, the command palette, and the
// useIsMobile hook — all accent-driven off CSS variables (var(--accent),
// var(--surface), var(--ink), …) that @cc/design emits, so a single component
// renders correctly for every tool on the shared midnight canvas with no
// per-tool forks. Nothing here reaches into business logic; import what a view
// needs.
// ═══════════════════════════════════════════════════════════════════════════
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { M } from "@cc/design";
import { installPolish } from "./polish.js";

export { M };
export { POLISH_CSS, installPolish } from "./polish.js";

// The motion + ergonomics floor, installed on import. Every tool already reaches
// for something in this module, so importing @cc/ui IS the wiring — there is no
// per-app setup step to forget, and no tool can end up as the one that hard-cuts
// while the other five glide. Idempotent; six lazy tools install one stylesheet.
installPolish();

// One responsive hook for the whole platform. Each surface passes the breakpoint
// it wants (phones ~680, tablets ~820, the shell chrome 768) instead of every
// app re-implementing the same resize listener.
export function useIsMobile(bp = 768) {
  const [m, setM] = useState(() => typeof window !== "undefined" && window.innerWidth < bp);
  useEffect(() => {
    const on = () => setM(window.innerWidth < bp);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [bp]);
  return m;
}

// Accent + neutrals resolve at render against the nearest ancestor that set the
// design CSS vars (the shell sets them per active app; standalone apps set them
// on their root). Fallbacks keep the primitives legible if vars are absent.
const U = {
  ink: "var(--ink, #0B1220)",
  sub: "var(--muted, #64748B)",
  faint: "var(--faint, #8A97A8)",
  accent: "var(--accent, #0E9F6E)",
  accentGrad: "var(--accent-grad, linear-gradient(135deg,#12B886,#0A7A54))",
  accentSoft: "var(--accent-soft, rgba(14,159,110,0.09))",
  amber: "var(--warn, #F59E0B)",
  red: "var(--bad, #DC2626)",
  surface: "var(--surface, #FFFFFF)",
  subtle: "var(--subtle, #F8FAFC)",
  line: "var(--border, rgba(15,23,42,0.06))",
  fontDisplay: 'var(--font-display, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)',
  fontBody: "var(--font-body, 'Inter', system-ui, sans-serif)",
  fontMono: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace)',
  shadowPopover: "var(--shadow-popover, 0 8px 24px rgba(15,23,42,0.1), 0 2px 8px rgba(15,23,42,0.06), 0 0 0 1px rgba(15,23,42,0.05))",
  shadowModal: "var(--shadow-modal, 0 32px 80px rgba(15,23,42,0.22), 0 8px 24px rgba(15,23,42,0.12))",
};

// ─── Keyframes — injected once, so any tool gets them without wiring ─────────
// This block is appended to document.head at import time, which puts it AFTER
// the bundled components.css however the bundler orders the sheets. Keyframe
// names are document-global, so anything here named after a components.css
// keyframe replaces it for every tool on screen — components.css is the sole
// owner of those names (DESIGN.md §6). `ccShimmerBg` used to be `shimmer`, and
// as a background-position sweep it did nothing to the kit's `.sk::after`,
// which is a transform sweep starting at translateX(-100%): the kit's own
// skeletons stopped animating in every app that imported @cc/ui.
//
// THIS IS THE KIT'S SECOND STYLESHEET, and the names below are as owned as the
// ones in components.css. That was not obvious, and it cost: ZTS and Clarify
// each redefined `toastIn`/`toastOut`/`toastShrink`/`paletteIn` in their own
// injected sheets with a translateX(18px) throw instead of the translateY(-8px)
// here. Both are lazy() mounted inside a ToastProvider that wraps the whole
// shell, so their copies landed last and won for the life of the page — open
// ZTS once and every tool's toasts slid in from the right. The guard could not
// see it, because it derived the owned set from components.css alone. It now
// derives from every sheet the packages ship, this one included, so a name here
// is protected the moment it is added, with no list to update.
//
// `toastin`/`toastout` in components.css are NOT these. CSS keyframe idents are
// case-sensitive, so `toastin` (the .toast class's spring, bottom-centre) and
// `toastIn` (this module's JS-rendered Toast, top-right) are two distinct
// animations that only read alike. Both are kit-owned; neither shadows the
// other; do not "tidy" one into the other.
const KEYFRAMES = `
@keyframes ccShimmerBg { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
@keyframes toastIn { from { opacity: 0; transform: translateY(-8px) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes toastOut { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(-8px) scale(0.98); } }
@keyframes toastShrink { from { transform: scaleX(1); } to { transform: scaleX(0); } }
@keyframes ccFadein { from { opacity: 0; } to { opacity: 1; } }
@keyframes paletteIn { from { opacity: 0; transform: translateY(-6px) scale(0.985); } to { opacity: 1; transform: none; } }
`;
if (typeof document !== "undefined" && !document.getElementById("cc-ui-keyframes")) {
  const el = document.createElement("style");
  el.id = "cc-ui-keyframes";
  el.textContent = KEYFRAMES;
  document.head.appendChild(el);
}

const reduceMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ─── AnimatedNumber — count from the displayed value to the next one ─────────
export function AnimatedNumber({ value, format, duration = 700, style }) {
  const numeric = typeof value === "number" && !Number.isNaN(value) ? value : 0;
  const [display, setDisplay] = useState(numeric);
  const displayRef = useRef(numeric);
  const rafRef = useRef(null);

  useEffect(() => {
    const from = displayRef.current;
    const to = numeric;
    if (from === to) return;
    if (reduceMotion()) { displayRef.current = to; setDisplay(to); return; }
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = from + (to - from) * eased;
      displayRef.current = v;
      setDisplay(v);
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => rafRef.current && cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numeric, duration]);

  return <span style={style}>{format ? format(display) : Math.round(display)}</span>;
}

// ─── Skeletons ────────────────────────────────────────────────────────────────
const shimmerStyle = (extra) => ({
  background: "linear-gradient(90deg, var(--border, rgba(15,23,42,0.05)) 25%, var(--border-strong, rgba(15,23,42,0.1)) 37%, var(--border, rgba(15,23,42,0.05)) 63%)",
  backgroundSize: "400% 100%",
  animation: "ccShimmerBg 1.6s ease-in-out infinite",
  ...extra,
});

export function SkeletonLine({ width = "100%", height = "11px", style }) {
  return <div style={shimmerStyle({ width, height, borderRadius: "5px", ...style })} />;
}

/** A solid block placeholder — for a chart, a map, an editor pane. Sized by the
 *  caller so it matches the thing it resolves into rather than being a generic
 *  grey box, which is the difference between a page developing and a page
 *  showing a loading state. */
export function SkeletonBlock({ width = "100%", height = "80px", radius = "14px", style }) {
  return <div style={shimmerStyle({ width, height, borderRadius: radius, ...style })} />;
}

export function SkeletonCard({ style }) {
  return (
    <div style={{ background: U.surface, border: `1px solid ${U.line}`, borderRadius: "16px", padding: "14px 16px", ...style }}>
      <SkeletonLine width="55%" height="13px" style={{ marginBottom: "10px" }} />
      <SkeletonLine width="85%" style={{ marginBottom: "6px" }} />
      <SkeletonLine width="40%" />
    </div>
  );
}

export function SkeletonRows({ count = 3, cardStyle }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {Array.from({ length: count }).map((_, i) => <SkeletonCard key={i} style={{ ...cardStyle, opacity: 1 - i * 0.14 }} />)}
    </div>
  );
}

export function SkeletonBoard({ cols = 4 }) {
  return (
    <div style={{ display: "flex", gap: "16px", overflowX: "hidden", paddingBottom: "8px" }}>
      {Array.from({ length: Math.min(cols, 4) }).map((_, i) => (
        <div key={i} style={{ flex: 1, minWidth: "200px" }}>
          <SkeletonLine width="40%" height="10px" style={{ marginBottom: "12px" }} />
          <SkeletonRows count={2} />
        </div>
      ))}
    </div>
  );
}

// ─── Empty-state iconography — hand-drawn line icons, accent-tintable ────────
const ICONS = {
  inbox: "M4 12l2.5-7A2 2 0 0 1 8.4 3.5h7.2a2 2 0 0 1 1.9 1.5L20 12M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M4 12h4.5a1 1 0 0 1 .95.68L10 15h4l.55-2.32a1 1 0 0 1 .95-.68H20",
  users: "M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2.5 20c.6-3.2 3-5.5 6-5.5s5.4 2.3 6 5.5M16 11a2.5 2.5 0 1 0 0-5M17.5 14.5c2.3.4 4 2.3 4.5 5",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  film: "M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17V7a1.5 1.5 0 0 1 1.5-1.5ZM10 9.3v5.4L15 12l-5-2.7Z",
  doc: "M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM14 3v5h5M9 13h6M9 17h4",
  radar: "M12 2v4M12 2a10 10 0 1 0 7.07 2.93M12 8a4 4 0 1 0 2.83 1.17M12 12l5-5",
  spark: "M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6L12 3Z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
};

export function EmptyIcon({ kind = "inbox", size = 26, color, style }) {
  const d = ICONS[kind] || ICONS.inbox;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path d={d} stroke={color || "currentColor"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── EmptyState — one shape for every "nothing here yet" moment ──────────────
export function EmptyState({ icon = "inbox", tint = U.accent, title, sub, action, dashed = true, compact = false, style }) {
  return (
    <div style={{
      textAlign: "center",
      padding: compact ? "28px 20px" : "52px 32px",
      borderRadius: "16px",
      border: dashed ? "1px dashed var(--border, rgba(15,23,42,0.1))" : "none",
      background: dashed ? "color-mix(in srgb, var(--surface, #fff) 50%, transparent)" : "transparent",
      ...style,
    }}>
      <div style={{
        width: compact ? "34px" : "44px", height: compact ? "34px" : "44px",
        margin: "0 auto", marginBottom: compact ? "10px" : "16px",
        borderRadius: "12px", background: U.accentSoft, border: `1px solid var(--accent-line, ${U.accentSoft})`,
        display: "flex", alignItems: "center", justifyContent: "center", color: tint,
      }}>
        <EmptyIcon kind={icon} size={compact ? 16 : 20} />
      </div>
      <div style={{ fontSize: compact ? "12.5px" : "14px", fontWeight: 700, color: U.ink, fontFamily: U.fontDisplay, marginBottom: sub ? "6px" : 0 }}>{title}</div>
      {sub && <div style={{ fontSize: compact ? "11.5px" : "12.5px", color: U.sub, maxWidth: "340px", margin: "0 auto", lineHeight: 1.6 }}>{sub}</div>}
      {action && <div style={{ marginTop: compact ? "12px" : "18px" }}>{action}</div>}
    </div>
  );
}

// ─── Toasts ───────────────────────────────────────────────────────────────────
const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 220);
  }, []);

  const push = useCallback((message, opts = {}) => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const toast = { id, message, tone: opts.tone || "default", duration: opts.duration ?? 4200 };
    setToasts((t) => [...t.slice(-3), toast]);
    return id;
  }, []);

  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast() must be used inside <ToastProvider>");
  return ctx;
}

const TOAST_TONES = {
  default: { border: "var(--border, rgba(15,23,42,0.1))", dot: U.ink },
  success: { border: "var(--accent-line, rgba(14,159,110,0.3))", dot: U.accent },
  error: { border: "rgba(220,38,38,0.3)", dot: U.red },
  warning: { border: "rgba(245,158,11,0.3)", dot: U.amber },
};

function Toast({ toast, dismiss }) {
  const tone = TOAST_TONES[toast.tone] || TOAST_TONES.default;
  useEffect(() => {
    const t = setTimeout(() => dismiss(toast.id), toast.duration);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id]);
  return (
    <div onClick={() => dismiss(toast.id)} style={{
      position: "relative", overflow: "hidden", cursor: "pointer",
      minWidth: "260px", maxWidth: "360px",
      background: U.surface, border: `1px solid ${tone.border}`, borderRadius: "12px",
      boxShadow: U.shadowPopover, padding: "11px 14px",
      display: "flex", alignItems: "flex-start", gap: "10px",
      animation: `${toast.leaving ? "toastOut" : "toastIn"} ${M.durBase} ${M.easeOut} both`,
    }}>
      <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: tone.dot, flexShrink: 0, marginTop: "5px" }} />
      <span style={{ fontSize: "12.5px", color: U.ink, lineHeight: 1.5, flex: 1 }}>{toast.message}</span>
      {!toast.leaving && (
        <span style={{ position: "absolute", left: 0, bottom: 0, height: "2px", background: tone.dot, opacity: 0.35, width: "100%", transformOrigin: "left", animation: `toastShrink ${toast.duration}ms linear both` }} />
      )}
    </div>
  );
}

function ToastStack({ toasts, dismiss }) {
  if (toasts.length === 0) return null;
  return (
    <div style={{ position: "fixed", top: "64px", right: "16px", zIndex: 600, display: "flex", flexDirection: "column", gap: "8px", pointerEvents: "none" }}>
      {toasts.map((t) => <div key={t.id} style={{ pointerEvents: "auto" }}><Toast toast={t} dismiss={dismiss} /></div>)}
    </div>
  );
}

// ─── CommandPalette — ⌘/Ctrl+K spotlight, its own styling on every screen size
export function CommandPalette({ open, onClose, actions }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQuery(""); setIndex(0);
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(q) || (a.sub || "").toLowerCase().includes(q) || (a.keywords || "").toLowerCase().includes(q));
  }, [query, actions]);

  useEffect(() => { setIndex(0); }, [query]);

  const run = (a) => { if (!a) return; onClose(); a.run(); };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); run(filtered[index]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); onClose(); }
  };

  if (!open) return null;

  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{
      position: "fixed", inset: 0, background: "rgba(11,18,32,0.45)", zIndex: 700,
      display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "12vh 16px 0",
      animation: `ccFadein ${M.durFast} ease both`,
    }}>
      <div style={{
        width: "100%", maxWidth: "560px", maxHeight: "60vh", display: "flex", flexDirection: "column",
        background: U.surface, borderRadius: "16px", overflow: "hidden", boxShadow: U.shadowModal,
        animation: `paletteIn 0.16s ${M.easeOut} both`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "14px 18px", borderBottom: `1px solid ${U.line}`, flexShrink: 0 }}>
          <span style={{ color: U.faint, display: "flex" }}><EmptyIcon kind="search" size={16} /></span>
          <input
            ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown}
            placeholder="Jump to a tool, tab, record, or action…"
            style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: "14px", color: U.ink, fontFamily: U.fontBody }}
          />
          <kbd style={{ fontSize: "10px", fontFamily: U.fontMono, color: U.faint, background: U.subtle, border: `1px solid ${U.line}`, borderRadius: "5px", padding: "2px 6px" }}>esc</kbd>
        </div>
        <div style={{ overflowY: "auto", padding: "8px", flex: 1 }}>
          {filtered.length === 0 ? (
            <EmptyState compact icon="search" title="No matches" sub="Try a different tool, record, or action." />
          ) : filtered.map((a, i) => (
            <button key={a.id} onMouseEnter={() => setIndex(i)} onClick={() => run(a)} style={{
              width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: "12px",
              padding: "9px 10px", borderRadius: "9px", border: "none", cursor: "pointer",
              background: i === index ? U.accentSoft : "transparent",
            }}>
              <span style={{
                width: "26px", height: "26px", borderRadius: "7px", flexShrink: 0,
                background: i === index ? U.accentGrad : U.subtle, color: i === index ? "#FFFFFF" : U.sub,
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px",
              }}>{a.icon || "→"}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "13px", fontWeight: 600, color: U.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.label}</div>
                {a.sub && <div style={{ fontSize: "11px", color: U.sub, marginTop: "1px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.sub}</div>}
              </span>
              {a.group && <span style={{ fontSize: "9px", fontWeight: 700, color: U.faint, textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0 }}>{a.group}</span>}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: "14px", padding: "9px 16px", borderTop: `1px solid ${U.line}`, fontSize: "10.5px", color: U.faint, flexShrink: 0 }}>
          <span>↑↓ navigate</span><span>↵ select</span><span>esc close</span>
        </div>
      </div>
    </div>
  );
}

// ─── Expand — height:auto with zero measuring ────────────────────────────────
// grid-template-rows 0fr → 1fr animates to the content's natural height without
// a ResizeObserver, a measured max-height, or the jank both produce. The CSS
// lives in polish.js; this is the markup contract it needs (one wrapper, one
// overflow-hidden child).
//
// Children are unmounted while closed so a collapsed panel cannot keep polling,
// hold a subscription, or trap focus — a closed panel that is still working is
// the bug this shape prevents.
export function Expand({ open, children, style }) {
  return (
    <div className={`expand${open ? " open" : ""}`} aria-hidden={!open} style={style}>
      <div>{open ? children : null}</div>
    </div>
  );
}

// ─── ErrorState — a dead end is never acceptable ─────────────────────────────
// The rule this enforces: every error offers a way forward. A banner that says
// what broke and nothing else leaves the operator with reload-the-page as their
// only move, which on a phone at 7am means giving up.
export function ErrorState({ title = "That didn't load", detail, onRetry, retryLabel = "Try again", compact = false, style }) {
  return (
    <div
      role="alert"
      style={{
        display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10,
        padding: compact ? "12px 14px" : "18px 20px",
        border: `1px solid color-mix(in srgb, ${U.red} 34%, transparent)`,
        background: `color-mix(in srgb, ${U.red} 8%, transparent)`,
        borderRadius: 14, ...style,
      }}
    >
      <div style={{ fontSize: compact ? 13 : 14, fontWeight: 700, color: U.ink, fontFamily: U.fontDisplay }}>{title}</div>
      {detail && (
        <div style={{ fontSize: 12.5, color: U.sub, lineHeight: 1.55, fontFamily: U.fontMono, wordBreak: "break-word" }}>
          {detail}
        </div>
      )}
      {onRetry && (
        <button type="button" onClick={onRetry} style={{
          minHeight: 36, padding: "0 14px", borderRadius: 9, cursor: "pointer",
          border: `1px solid ${U.line}`, background: U.surface, color: U.ink,
          fontSize: 12.5, fontWeight: 700, fontFamily: U.fontDisplay,
        }}>{retryLabel}</button>
      )}
    </div>
  );
}

// ─── useTween — the hook behind AnimatedNumber, exposed ──────────────────────
// Rings and gauges need the tweened NUMBER rather than a rendered element, and
// two apps had each grown their own copy to get at it. Same ease-out cubic and
// the same reduced-motion bail as AnimatedNumber, so a page cannot animate one
// figure and snap another.
export function useTween(target, dur = 700) {
  const [v, setV] = useState(target ?? 0);
  const fromRef = useRef(target ?? 0);
  useEffect(() => {
    if (target == null) return undefined;
    const from = fromRef.current ?? 0;
    if (from === target || reduceMotion()) { fromRef.current = target; setV(target); return undefined; }
    let raf;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      setV(from + (target - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(step);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, dur]);
  return target == null ? null : Math.round(v);
}

// ─── Short aliases ───────────────────────────────────────────────────────────
// Macro and Runway grew a terser vocabulary (Num, SkLine, SkCard) for the same
// components ZTS and Clarify call AnimatedNumber and Skeleton*. Both names now
// resolve to ONE implementation: renaming eleven files to settle a style
// argument would be churn with a regression budget and no user-visible gain.
export const Num = ({ v, f, dur, style }) => <AnimatedNumber value={v} format={f} duration={dur} style={style} />;
export const SkLine = SkeletonLine;
export const SkCard = SkeletonCard;
export const SkBoard = SkeletonBoard;

/** A full-page skeleton shaped like the page it resolves into. Replaces a
 *  page-level spinner, which is the single loudest "this is a tool, not a
 *  product" tell there is. */
export function SkPage({ cards = 4, rings = 0 }) {
  return (
    <div className="pagefade" style={{ padding: 4 }}>
      {rings > 0 && (
        <div style={{ display: "flex", gap: 22, alignItems: "center", flexWrap: "wrap", margin: "6px 0 18px" }}>
          {Array.from({ length: rings }).map((_, i) => (
            <SkeletonBlock key={i} width="84px" height="84px" radius="50%" />
          ))}
          <div style={{ flex: 1, minWidth: 180 }}>
            <SkeletonLine width="60%" style={{ marginBottom: 8 }} />
            <SkeletonLine width="80%" />
          </div>
        </div>
      )}
      <SkeletonRows count={cards} />
    </div>
  );
}
