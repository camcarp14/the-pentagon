// ═══════════════════════════════════════════════════════════════════════════
// The Pentagon — the shell.
//
// One site, one login, one toggle. The shell owns exactly four things:
//   • auth (a single login gates all three tools)
//   • the top-of-screen app toggle (ZTS · Clarify · Runway · Macro), plus ⌥1-4
//   • per-tool theming (it stamps @cc/design's CSS vars on a wrapper, so
//     switching tools re-accents the whole page over the shared dark canvas)
//   • the cross-tool System hub (usage · minds · agents)
// Each tool keeps its own internal nav — and its own ⌘K palette — directly
// beneath (two clear layers), and is lazy-loaded so opening one never
// downloads the others.
// ═══════════════════════════════════════════════════════════════════════════
import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { appMeta, cssVars, APPS } from "@cc/design";
import { SkeletonBoard, EmptyIcon, M, useIsMobile } from "@cc/ui";
import { auth, isConfigured } from "@cc/supabase";

// Lazily-mounted tools. Wired in per Phase-C increment; a tool without an entry
// here renders the "coming in this build" panel so the toggle always works.
const TOOLS = {
  zts: lazy(() => import("@app/zts")),
  clarify: lazy(() => import("@app/clarify")),
  runway: lazy(() => import("@app/runway")),
  macro: lazy(() => import("@app/macro")),
  looper: lazy(() => import("@app/looper")),
};

// The shell-owned cross-tool management surface (Usage / Minds / Agents).
const System = lazy(() => import("./System.jsx"));

// Neutral "platform" theme for the top bar while System is open, so the chrome
// matches System's own dark surface instead of the active tool's accent.
// Must cover every var the shell's own chrome consumes — while System is open no
// tool stylesheet is mounted, so anything missing here resolves to nothing and
// (because an unresolved var() invalidates the whole declaration) silently drops
// the property. --surface-2 and --accent-line are load-bearing for the toggle's
// active pill and the error-boundary button.
const PLATFORM_VARS = {
  "--bg": "#0A0E15", "--surface": "#131A24", "--surface-2": "#1B2438", "--ink": "#E9EDF5", "--muted": "#93A1B5",
  "--faint": "#66748A", "--border": "rgba(255,255,255,0.08)", "--accent": "#AAB6C6",
  "--accent-soft": "rgba(170,182,198,0.14)", "--accent-line": "rgba(170,182,198,0.32)",
  "--shadow-tab": "0 1px 2px rgba(0,0,0,0.5)",
  "--font-display": "'Syne',system-ui", "--font-body": "'Inter',system-ui,sans-serif", "--font-mono": "'DM Mono',monospace",
};

// ─── hooks ────────────────────────────────────────────────────────────────────
function useSession() {
  const [session, setSession] = useState(undefined); // undefined = still checking
  useEffect(() => {
    if (!isConfigured()) { setSession(null); return; }
    auth.getSession().then((s) => setSession(s || null));
    return auth.onChange((s) => setSession(s || null));
  }, []);
  return session;
}

// ─── boot + login ─────────────────────────────────────────────────────────────
// The Pentagon mark: a five-sided ring (the name) whose gradient sweeps through
// all four tool accents — violet → emerald → brass → amber (cool to warm), one
// glyph that says "four tools under one shell". Reads down to favicon size.
const PentagonLogo = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" style={{ display: "block", flexShrink: 0, filter: "drop-shadow(0 0 6px rgba(139,124,255,0.28))" }}>
    <defs>
      <linearGradient id="pentagon-grad" x1="4" y1="5" x2="28" y2="27" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#8B7CFF" />
        <stop offset="0.38" stopColor="#3ECF8E" />
        <stop offset="0.72" stopColor="#C9A557" />
        <stop offset="1" stopColor="#FFB224" />
      </linearGradient>
    </defs>
    <path
      fillRule="evenodd" clipRule="evenodd" fill="url(#pentagon-grad)"
      d="M16 5.25 L27.29 13.46 L22.98 26.74 L9.02 26.74 L4.71 13.46 Z M16 11.1 L21.74 15.27 L19.54 22.01 L12.46 22.01 L10.26 15.27 Z"
    />
  </svg>
);

function Boot() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#0b0d12" }}>
      <div style={{ width: 30, height: 30, border: "2px solid rgba(255,255,255,0.1)", borderTopColor: "#FFB224", borderRadius: "50%", animation: "spin .8s linear infinite" }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try { await auth.signIn(email.trim(), password); }
    catch (ex) { setErr(ex?.message || "Sign in failed"); setBusy(false); }
  };
  const field = { width: "100%", padding: "11px 13px", background: "#0e1118", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 9, color: "#e9e7e0", fontSize: 14, outline: "none", fontFamily: "'Inter',system-ui" };
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "radial-gradient(1200px 600px at 50% -10%, #171b26 0%, #0b0d12 60%)", padding: 20 }}>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: 360, background: "#12151d", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 18, padding: "30px 26px", boxShadow: "0 24px 70px rgba(0,0,0,0.55)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 20 }}>
          <PentagonLogo size={26} />
          <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: "0.16em", textTransform: "uppercase", color: "#e9e7e0", fontFamily: "'Syne',system-ui" }}>The Pentagon</span>
        </div>
        <div style={{ fontSize: 12.5, color: "#9aa1ae", marginBottom: 18, lineHeight: 1.6 }}>One sign-in for ZTS, Clarify, and Runway.</div>
        <label style={{ fontSize: 11, color: "#9aa1ae", fontWeight: 600 }}>Email</label>
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} style={{ ...field, margin: "6px 0 14px" }} />
        <label style={{ fontSize: 11, color: "#9aa1ae", fontWeight: 600 }}>Password</label>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ ...field, margin: "6px 0 4px" }} />
        {err && <div style={{ color: "#ff6f6f", fontSize: 12, marginTop: 10 }}>{err}</div>}
        {!isConfigured() && <div style={{ color: "#FFB224", fontSize: 11.5, marginTop: 10, lineHeight: 1.5 }}>Supabase isn't configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.</div>}
        <button type="submit" disabled={busy} style={{ width: "100%", marginTop: 18, padding: "11px", borderRadius: 9, border: "none", cursor: busy ? "default" : "pointer", background: "linear-gradient(135deg,#FFC155,#E09000)", color: "#1a1204", fontWeight: 800, fontSize: 13.5, fontFamily: "'Syne',system-ui", opacity: busy ? 0.7 : 1 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

// ─── the app toggle ───────────────────────────────────────────────────────────
function AppToggle({ active, onPick, compact }) {
  const refs = useRef({});
  const [ind, setInd] = useState({ left: 0, width: 0, ready: false });
  // Measure the active button so the pill glides between tools instead of
  // teleporting. Beyond tool switch + the mobile/desktop flip, this must also
  // re-measure on resize (segments are flex-sized on mobile, so every width
  // change moves them) and after the webfont loads — Syne arrives late, so a
  // first-paint measurement captures fallback-font widths and would leave the
  // pill mis-sized until the next switch. ZTS/Clarify already do the resize
  // half; the font half fixes the wrong-on-first-load case they still have.
  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[active];
      if (el) setInd({ left: el.offsetLeft, width: el.offsetWidth, ready: true });
    };
    measure();
    window.addEventListener("resize", measure);
    let alive = true;
    document.fonts?.ready?.then(() => { if (alive) measure(); });
    return () => { alive = false; window.removeEventListener("resize", measure); };
  }, [active, compact]);
  return (
    <div
      // Deliberately NOT role="tablist": a real tablist owes arrow-key
      // navigation and aria-controls pointing at a tabpanel, and claiming the
      // role without them tells a screen-reader user to expect a keyboard model
      // that does not exist. A labelled group of buttons is honest and complete.
      role="group"
      aria-label="Switch tool"
      style={{
        // 2px inset on mobile, not 3: a 44px segment + 3px padding + 2 borders
        // would be 52px inside a 51px row. At 2px the group is 50px and the
        // segments keep their full 44px height.
        position: "relative", gap: 2, padding: compact ? 2 : 3, borderRadius: compact ? 12 : 11,
        background: "color-mix(in srgb, var(--ink) 6%, transparent)",
        // lineSoft, matching the pill groups inside ZTS/Clarify rather than the
        // harder --border edge the shell used to draw.
        border: "1px solid rgba(255,255,255,0.055)",
        ...(compact
          // On mobile the toggle owns the row: four equal segments beat four
          // unequal ones, and it can spend the horizontal room that was
          // previously left empty.
          ? { display: "flex", flex: "1 1 auto", minWidth: 0 }
          : { display: "inline-flex" }),
      }}
    >
      {ind.ready && (
        <div style={{ position: "absolute", top: compact ? 2 : 3, bottom: compact ? 2 : 3, left: ind.left, width: ind.width, background: "var(--surface-2, var(--surface))", borderRadius: compact ? 9 : 8, boxShadow: "var(--shadow-tab)", transition: `left ${M.durBase} ${M.easeSpring}, width ${M.durBase} ${M.easeSpring}` }} />
      )}
      {APPS.map((a) => {
        const m = appMeta(a);
        const on = a === active;
        return (
          <button key={a} ref={(el) => { refs.current[a] = el; }} onClick={() => onPick(a)} type="button"
            // No aria-label: it would override the visible label, so voice
            // control ("tap ZTS") would fail against an accessible name of
            // "Zero To Secure" (WCAG 2.5.3). The visible text IS the name; the
            // brand stays as the hover title only.
            title={m.brand} aria-current={on ? "true" : undefined}
            style={{
              position: "relative", zIndex: 1,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              // The dot costs 15px per segment (8 + 7 gap). On mobile that room
              // buys the label instead, and the accent moves onto the text —
              // every tool stays identifiable without relying on colour alone.
              gap: compact ? 0 : 7,
              // 3px inset, 9.5px, no tracking: five segments need every pixel.
              // Measured at 430/393/375/360/320 with a fallback font WIDER than
              // Syne — no label clips at 375px (the narrowest current iPhone) and
              // up. 360px is 2-3px short in the fallback, which real Syne
              // absorbs; 320px genuinely does not fit five words, so it
              // ellipsises rather than overlapping (see the label span below).
              padding: compact ? "0 3px" : "6px 14px",
              minHeight: compact ? 44 : 32,
              ...(compact ? { flex: "1 1 0", minWidth: 0, overflow: "hidden" } : {}),
              border: "none", borderRadius: compact ? 9 : 8, cursor: "pointer", background: "transparent",
              color: on ? (compact ? m.accent : "var(--ink)") : "var(--faint)",
              fontFamily: "'Syne',system-ui", fontSize: compact ? 9.5 : 11.5, fontWeight: 700,
              letterSpacing: compact ? "0em" : "0.06em", textTransform: "uppercase", whiteSpace: "nowrap",
              transition: `color ${M.durBase} ${M.easeStd}`,
            }}>
            {!compact && (
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: m.accent, boxShadow: on ? `0 0 8px ${m.accent}` : "none", flexShrink: 0 }} />
            )}
            {/* The label needs its own block to truncate: `text-overflow` does
                nothing on a flex container, so with the text as a direct child
                of the button an over-wide label overflowed its segment and ran
                into its neighbour instead of clipping. */}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, display: "block" }}>{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── the panel for a not-yet-mounted tool ───────────────────────────────────
function ComingSoon({ app }) {
  const m = appMeta(app);
  return (
    <div style={{ minHeight: "60vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ textAlign: "center", maxWidth: 380 }}>
        <div style={{ width: 52, height: 52, margin: "0 auto 16px", borderRadius: 14, background: "var(--accent-soft)", border: "1px solid var(--accent-line)", display: "grid", placeItems: "center", color: "var(--accent)" }}>
          <EmptyIcon kind="spark" size={22} />
        </div>
        <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Syne',system-ui", color: "var(--ink)", marginBottom: 8 }}>{m.brand}</div>
        <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
          Getting mounted into The Pentagon. The toggle, theme, and one-login are already wired — this tool comes online in the next build increment.
        </div>
      </div>
    </div>
  );
}

// ─── tool error boundary ──────────────────────────────────────────────────────
// Without this, a single tool taking a throw takes the whole Pentagon with it:
// the tools are React.lazy imports, so a rejected dynamic import surfaces during
// render and React unmounts the entire root — top bar, toggle and System hub
// included. Two real paths reach that: (1) after a deploy, an open tab asks for
// a chunk whose content hash no longer exists, and (2) a tool that throws at
// module scope on missing env. Keyed on the active tool so switching away clears
// the error, and the shell chrome above it stays mounted and usable.
class ToolBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    const { err } = this.state;
    if (!err) return this.props.children;
    // A stale-chunk failure is not a bug the user can act on — it just means a
    // new version shipped under them, so say that and offer the reload.
    const stale = /Loading chunk|Failed to fetch dynamically imported module|error loading dynamically imported module/i.test(err.message || "");
    return (
      <div style={{ minHeight: "50vh", display: "grid", placeItems: "center", padding: 24 }}>
        <div style={{ textAlign: "center", maxWidth: 380 }}>
          <div style={{ fontSize: 15, fontWeight: 800, fontFamily: "'Syne',system-ui", color: "var(--ink)", marginBottom: 8 }}>
            {stale ? "A new version shipped" : "This tool hit an error"}
          </div>
          <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6, marginBottom: 16 }}>
            {stale
              ? "Reload to pick it up — the other tools are still fine."
              : "The rest of the Pentagon still works; switch tools from the toggle above, or reload."}
          </div>
          {!stale && <div style={{ fontSize: 11.5, color: "var(--faint)", fontFamily: "var(--font-mono)", marginBottom: 16, wordBreak: "break-word" }}>{String(err.message || err)}</div>}
          <button onClick={() => window.location.reload()} type="button" style={{
            background: "var(--accent-soft)", border: "1px solid var(--accent-line)", borderRadius: 9, color: "var(--ink)",
            fontSize: 12.5, fontWeight: 700, fontFamily: "'Syne',system-ui", padding: "0 18px", minHeight: 44, cursor: "pointer",
          }}>Reload</button>
        </div>
      </div>
    );
  }
}

// ─── shell ────────────────────────────────────────────────────────────────────
export default function Shell() {
  const session = useSession();
  const isMobile = useIsMobile();
  // Always open on ZTS — the Pentagon's home tool. (We still remember the last
  // pick within a session for niceties, but every fresh load lands on ZTS.)
  const [active, setActive] = useState("zts");
  const [systemOpen, setSystemOpen] = useState(false);

  const pick = useCallback((a) => {
    setActive(a);
    setSystemOpen(false);
    try { localStorage.setItem("cc_active_app", a); } catch {}
  }, []);

  // ─── iOS standalone letterbox guard → publishes --safe-bottom ──────────────
  // iOS reads apple-mobile-web-app-status-bar-style ONLY at Add-to-Home-Screen
  // time, so an icon installed while we shipped "black-translucent" still gets
  // that half-applied window: sized below the status bar yet top-anchored,
  // leaving a dead ~59pt strip at the BOTTOM where nothing paints. There the
  // reported safe-area-inset-bottom IS that dead space and must not be padded
  // for (padding it floats the tab bar off the screen edge — the bug we chased);
  // in a healthy "black" window the same inset is real and clears the home
  // indicator. One static value cannot serve both installs, so detect which
  // window we're in and publish the usable inset as --safe-bottom for every
  // tool's bottom bar. (Field-proven in the Board Room app — see its .lbx path.)
  useEffect(() => {
    const root = document.documentElement;
    // env() is only readable by measuring an element that uses it.
    const probeEnvTop = () => {
      const el = document.createElement("div");
      el.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:env(safe-area-inset-top);";
      document.body.appendChild(el);
      const h = el.getBoundingClientRect().height;
      el.remove();
      return Math.round(h);
    };
    const apply = () => {
      const standalone = window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
      const vvh = window.visualViewport ? Math.round(window.visualViewport.height) : null;
      const screenH = window.screen?.height || null;
      // Renderable height falls short of the screen WHILE sitting under the
      // status bar (envTop > 0) — the discriminator between a dead bottom
      // strip and a healthy home-indicator inset.
      const letterboxed = !!(standalone && vvh && screenH && screenH - vvh >= 20 && probeEnvTop() > 0);
      root.style.setProperty("--safe-bottom", letterboxed ? "0px" : "env(safe-area-inset-bottom, 0px)");
    };
    apply();
    let raf = 0;
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(apply); };
    const vv = window.visualViewport;
    vv?.addEventListener("resize", on);
    window.addEventListener("orientationchange", on);
    return () => { cancelAnimationFrame(raf); vv?.removeEventListener("resize", on); window.removeEventListener("orientationchange", on); };
  }, []);

  // ⌥1..⌥5 jump between tools. Deliberately NOT ⌘K — each tool owns its
  // own (richer) ⌘K palette, and Option+number never collides with the browser.
  useEffect(() => {
    const onKey = (e) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      // Match e.code, not e.key: on macOS, Option composes the digit into a glyph
      // (⌥1 → "¡"), so e.key is never "1"/"2"/"3" and the shortcut would silently
      // do nothing. e.code stays "Digit1".."Digit3" regardless of the modifier.
      const i = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5"].indexOf(e.code);
      if (i === -1 || !APPS[i]) return;
      e.preventDefault();
      pick(APPS[i]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pick]);

  if (session === undefined) return <Boot />;
  if (!session) return <LoginScreen />;

  const m = appMeta(active);
  const Tool = TOOLS[active];

  return (
    <div data-app={systemOpen ? "system" : active} data-theme={systemOpen ? "dark" : m.mode} style={{ ...(systemOpen ? PLATFORM_VARS : cssVars(active)), minHeight: "100vh", background: "var(--bg)", color: "var(--ink)", fontFamily: "var(--font-body)", transition: `background ${M.durSlow} ${M.easeStd}` }}>
      {/* Shell top bar — the ONE global chrome, themed to the active tool */}
      <div style={{
        position: "sticky", top: 0, zIndex: 100,
        paddingTop: "env(safe-area-inset-top)",
        borderBottom: "1px solid var(--border)",
        background: "color-mix(in srgb, var(--bg) 82%, transparent)", backdropFilter: "blur(20px) saturate(140%)", WebkitBackdropFilter: "blur(20px) saturate(140%)",
      }}>
      {/* One row, still 52px: the switcher gets 44px-tall targets without
          spending a second row of vertical chrome. On mobile the wordmark drops
          and the labels run small and untracked, which keeps all FIVE tool
          labels un-truncated with the System button still visible from 430px
          down to 375px, the narrowest phone still shipping. Segments land at
          56x44 on a 393px phone, against the 28x26 the old dots-only compact
          mode gave. Below 375px the labels ellipsise; see AppToggle. */}
      {/* 51 + the outer 1px borderBottom = the 52px the bar has always been. Ten
          call sites across the four tools hardcode `calc(100vh - 52px)` or
          `top: 52px`, so growing this to 53 would put a permanent 1px overflow
          on every one of them. */}
      <div style={{
        height: 51, paddingLeft: isMobile ? 10 : 20, paddingRight: isMobile ? 10 : 20,
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 14, minWidth: 0, flex: isMobile ? 1 : "0 1 auto" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <PentagonLogo size={isMobile ? 21 : 23} />
            {!isMobile && (
              <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--ink)", fontFamily: "'Syne',system-ui", whiteSpace: "nowrap" }}>The Pentagon</span>
            )}
          </span>
          <AppToggle active={active} onPick={pick} compact={isMobile} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, marginLeft: 8 }}>
          {/* Icon-only on mobile: the four labelled tool segments need that ~43px
              more than this button needs its word, and it keeps a 44px target. */}
          <button onClick={() => setSystemOpen((o) => !o)} type="button"
            title="System — usage, minds & agents across every tool"
            aria-label="System — usage, minds & agents across every tool"
            aria-pressed={systemOpen}
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
              background: systemOpen ? "var(--accent-soft)" : "none", border: "1px solid var(--border)", borderRadius: 7,
              color: systemOpen ? "var(--ink)" : "var(--muted)", fontSize: 10.5,
              padding: isMobile ? "0 11px" : "5px 10px",
              minHeight: isMobile ? 44 : "auto", minWidth: isMobile ? 40 : "auto",
              cursor: "pointer",
              fontWeight: 700, fontFamily: "'Syne',system-ui", letterSpacing: "0.06em", textTransform: "uppercase",
            }}>
            <span style={{ width: isMobile ? 8 : 6, height: isMobile ? 8 : 6, borderRadius: "50%", background: systemOpen ? "var(--ink)" : "var(--faint)" }} />{!isMobile && "System"}
          </button>
          {!isMobile && (
            <button onClick={() => auth.signOut()} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 7, color: "var(--muted)", fontSize: 10, padding: "5px 10px", cursor: "pointer", fontWeight: 600, fontFamily: "'Syne',system-ui" }}>Sign out</button>
          )}
        </div>
      </div>
      </div>

      {/* System hub (cross-tool) or the active tool, both lazy-loaded */}
      <ToolBoundary key={systemOpen ? "system" : active}>
        <Suspense fallback={<div style={{ padding: 24 }}><SkeletonBoard /></div>}>
          {systemOpen
            ? <System onExit={() => setSystemOpen(false)} onOpenTool={pick} />
            : Tool ? <Tool key={active} /> : <ComingSoon app={active} />}
        </Suspense>
      </ToolBoundary>
    </div>
  );
}
