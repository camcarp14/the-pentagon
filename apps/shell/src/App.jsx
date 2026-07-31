// ═══════════════════════════════════════════════════════════════════════════
// The Pentagon — the shell.
//
// One site, one login, one toggle. The shell owns exactly four things:
//   • auth (a single login gates all three tools)
//   • the top-of-screen app toggle, plus ⌥1-N. WHICH tools it shows and in what
//     order is a preference (tabPrefs.js), edited in System → Tabs — so the
//     toggle renders the visible list, never the full APPS list, and the
//     shortcuts index that same list so ⌥2 is always the second thing on screen
//   • per-tool theming (it stamps @cc/design's CSS vars on a wrapper, so
//     switching tools re-accents the whole page over the shared dark canvas)
//   • the cross-tool System hub (ops · usage · minds · agents · tabs)
// Each tool keeps its own internal nav — and its own ⌘K palette — directly
// beneath (two clear layers), and is lazy-loaded so opening one never
// downloads the others.
// ═══════════════════════════════════════════════════════════════════════════
import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { appMeta, cssVars } from "@cc/design";
import { SkeletonBoard, EmptyIcon, M, useIsMobile } from "@cc/ui";
import { auth, isConfigured } from "@cc/supabase";
import { loadTabPrefs, saveTabPrefs, visibleTabs, resolveActive, TAB_PREFS_KEY } from "./tabPrefs.js";
import { parseRoute, formatRoute, sameRoute } from "./route.js";

// Lazily-mounted tools. Wired in per Phase-C increment; a tool without an entry
// here renders the "coming in this build" panel so the toggle always works.
const TOOLS = {
  zts: lazy(() => import("@app/zts")),
  clarify: lazy(() => import("@app/clarify")),
  runway: lazy(() => import("@app/runway")),
  macro: lazy(() => import("@app/macro")),
  looper: lazy(() => import("@app/looper")),
  business: lazy(() => import("@app/business")),
  sync: lazy(() => import("@app/sync")),
  ideas: lazy(() => import("@app/ideas")),
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
  "--font-display": "var(--font-body)", "--font-body": "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif", "--font-mono": "ui-monospace, 'SF Mono', Menlo, monospace",
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
// ONE MARK, ONE METAL. This used to sweep violet → emerald → brass → amber, one
// stop per tool accent, with a violet glow behind it. Four hues and a glow is a
// lot of noise for a 21px mark whose whole job is to sit still while eight tools
// change colour underneath it — and it read as a toy rather than as a tool.
//
// It is Board Room's grammar now, because these are the same person's apps and
// they belong on the same shelf: a thin ring with a solid mark centred inside,
// in Board Room's own gold ramp (#E9CB7F → #D6B362 → #C29A45, sampled from its
// icon rather than guessed) on a near-black plate. Board Room draws a circle
// with a diamond; this draws a pentagon with a pentagon, which is the name.
//
// Deliberately NOT var(--accent): the accent is the ACTIVE TOOL's colour and it
// changes on every switch. This is the shell's own identity and holds still.
const PentagonLogo = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
    <defs>
      <linearGradient id="pentagon-gold" x1="9" y1="5.1" x2="23.7" y2="27.5" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#E9CB7F" />
        <stop offset="0.52" stopColor="#D6B362" />
        <stop offset="1" stopColor="#C29A45" />
      </linearGradient>
    </defs>
    <path d="M 16 5.6 L 25.89 12.79 L 22.11 24.41 L 9.89 24.41 L 6.11 12.79 Z"
      fill="none" stroke="url(#pentagon-gold)" strokeWidth="1.34" strokeLinejoin="round" />
    <path d="M 16 11.68 L 20.11 14.67 L 18.54 19.49 L 13.46 19.49 L 11.89 14.67 Z" fill="url(#pentagon-gold)" />
  </svg>
);

function Boot() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#0b0d12" }}>
      {/* `spin` is the kit's (packages/ui/components.css), imported once in
          main.jsx and identical to the copy that used to live here. Keyframe
          names are document-global, so a second definition mounted by the shell
          would shadow the kit's for every tool it hosts. See DESIGN.md §6. */}
      <div style={{ width: 30, height: 30, border: "2px solid rgba(255,255,255,0.1)", borderTopColor: "#FFB224", borderRadius: "50%", animation: "spin .8s linear infinite" }} />
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
          {/* Same treatment as the bar's wordmark: sentence case at the scale, no
              tracking theatrics, and a token instead of a hardcoded #e9e7e0 —
              this screen is meant to be the quietest in the app.
              These braces are load-bearing: `//` is NOT a comment in JSX
              children, it is text, and without them all three lines rendered
              verbatim next to the logo on the live sign-in screen. */}
          <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em", color: "var(--ink)" }}>The Pentagon</span>
        </div>
        <div style={{ fontSize: 12.5, color: "#9aa1ae", marginBottom: 18, lineHeight: 1.6 }}>One sign-in for ZTS, Clarify, and Runway.</div>
        <label style={{ fontSize: 11, color: "#9aa1ae", fontWeight: 600 }}>Email</label>
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} style={{ ...field, margin: "6px 0 14px" }} />
        <label style={{ fontSize: 11, color: "#9aa1ae", fontWeight: 600 }}>Password</label>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ ...field, margin: "6px 0 4px" }} />
        {err && <div style={{ color: "#ff6f6f", fontSize: 12, marginTop: 10 }}>{err}</div>}
        {!isConfigured() && <div style={{ color: "#FFB224", fontSize: 11.5, marginTop: 10, lineHeight: 1.5 }}>Supabase isn't configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.</div>}
        <button type="submit" disabled={busy} style={{ width: "100%", marginTop: 18, padding: "11px", borderRadius: 9, border: "none", cursor: busy ? "default" : "pointer", background: "linear-gradient(135deg,#FFC155,#E09000)", color: "#1a1204", fontWeight: 800, fontSize: 13.5, opacity: busy ? 0.7 : 1 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

// ─── the app toggle ───────────────────────────────────────────────────────────
function AppToggle({ active, onPick, compact, apps }) {
  const refs = useRef({});
  // The sliding indicator pill and everything it needed — a layout-effect
  // measuring the active button, a resize listener because segments were
  // flex-sized, a fonts.ready re-measure, and scrollIntoView to drag an
  // off-screen active tool back — all lived here and none of it survives the
  // move to a wrapping grid. There is no single row to slide along once tools
  // wrap; a 2D glide between rows reads as a glitch rather than as motion; and
  // nothing can be off-screen in a grid that shows everything. The active cell
  // is drawn instead.
  return (
    <div
      // Deliberately NOT role="tablist": a real tablist owes arrow-key
      // navigation and aria-controls pointing at a tabpanel, and claiming the
      // role without them tells a screen-reader user to expect a keyboard model
      // that does not exist. A labelled group of buttons is honest and complete.
      role="group"
      aria-label="Switch tool"
      className="toolrow"
      style={{
        // ── EVERY TOOL VISIBLE, NO SCROLL ───────────────────────────────────
        //
        // This was a horizontally scrolling pill row, on the reasoning that a
        // segmented control is for four or fewer and eight will not fit a phone
        // at a legible size. The second half of that is true — measured at
        // 393px, eight full labels need ~345px against ~288px of usable row,
        // even in sentence case with no dot and no tracking. The conclusion was
        // wrong: the answer to "too many for one row" is more rows, not a
        // scroller. A scrolled tool is an invisible tool, and half the point of
        // the bar is seeing at a glance what is there.
        //
        // auto-fit rather than a fixed column count, so this holds for however
        // many tools are visible — hide three in System and it reflows to one
        // row on its own. The bar's height is measured and published as
        // --shell-bar (see the header), so nothing downstream assumes 52px.
        // ── AND THE TWO BRANCHES ARE NOT THE SAME LAYOUT ────────────────────
        //
        // They used to be: one `width: 100%` auto-fit grid for both. On a phone
        // that is correct, because the row below the identity line is a
        // full-width flex item and the percentage has a real width to resolve
        // against. On a DESKTOP it collapsed the bar into a vertical stack.
        //
        // The parent is `flex: 0 1 auto` — shrink-to-fit, so its width comes
        // FROM its contents. A percentage width on a child of a shrink-to-fit
        // parent is a cycle: the child asks the parent, whose width depends on
        // the child. CSS breaks it by having the child contribute its
        // MIN-CONTENT, which for `repeat(auto-fit, minmax(92px, 1fr))` is one
        // 92px column. So the grid resolved to a single column and every tool
        // stacked. Measured in Chromium before the fix, identical at 1024,
        // 1280, 1440 and 1920: columns 1, toolrow 100x176, bar 177px tall
        // instead of 52 — a narrow ladder of tools overlapping the page under
        // it, at every desktop width.
        //
        // Nothing caught it because the assertion was on the SOURCE TEXT: the
        // string "auto-fit" was present, exactly as the test demanded, and the
        // rendered result was a column. scripts/toolrow-check.mjs measures the
        // built page instead, which is the only kind of test that can see this.
        //
        // Desktop is a wrapping FLEX row: no percentage, so no cycle, and each
        // tool is as wide as its own name rather than stretched to an equal
        // share. It still wraps rather than scrolling or truncating — measured
        // at 768px with all eight tools, flex wraps to two lines with every
        // label intact, where a single-row grid clipped all eight to ellipsis.
        // A truncated tool is the same invisible tool the scroller was.
        ...(compact
          // 70px is the widest cell that still fits FIVE columns on a 393px
          // phone — "Business" is the long one, ~46px of label plus the dot and
          // its gap. Five rather than four matters: at four, the default set of
          // five tools stranded one tool alone on a second row with three empty
          // cells beside it. At five they sit on one line and the full eight go
          // 5 + 3.
          ? { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(70px, 1fr))", width: "100%" }
          : { display: "flex", flexWrap: "wrap", width: "auto", maxWidth: "100%" }),
        gap: 2, padding: compact ? 2 : 3, borderRadius: compact ? 12 : 11,
        minWidth: 0,
        background: "color-mix(in srgb, var(--ink) 6%, transparent)",
        border: "1px solid rgba(255,255,255,0.055)",
      }}
    >
      {apps.map((a) => {
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
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
              // Desktop cells size to their own label (the row is flex there),
              // so they need real side padding — 6px was tuned for a grid cell
              // already stretched to 92px, and on a content-sized button it
              // reads as text jammed against the edge. `flex: 0 1 auto` lets a
              // narrow window shrink them before the row wraps.
              ...(compact ? { padding: "0 6px" } : { flex: "0 1 auto", padding: "0 12px" }),
              minWidth: 0,
              minHeight: compact ? 36 : 32,
              border: "none", borderRadius: compact ? 9 : 8, cursor: "pointer",
              // The active cell is drawn, not slid. A sliding thumb has to be
              // measured against one row of segments; across a wrapping grid it
              // would need to jump rows, and a 2D glide reads as a glitch.
              background: on ? "var(--surface-2, var(--surface))" : "transparent",
              boxShadow: on ? "var(--shadow-tab)" : "none",
              color: on ? m.accent : "var(--faint)",
              // Sentence case, not uppercase. §4.3 reserves uppercase for
              // .t-label, and it is also ~10% narrower, which is most of what
              // bought the second row its comfort.
              fontSize: compact ? 11.5 : 12, fontWeight: on ? 600 : 500,
              letterSpacing: 0, whiteSpace: "nowrap",
              transition: `color ${M.durBase} ${M.easeStd}, background ${M.durBase} ${M.easeStd}`,
            }}>
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: m.accent, boxShadow: on ? `0 0 8px ${m.accent}` : "none", flexShrink: 0 }} />
            {/* The label gets its own block so it can ellipsise if a tool is
                ever named something very long — text-overflow does nothing on a
                flex container. At the current names nothing truncates. */}
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>{m.label}</span>
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
        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--ink)", marginBottom: 8 }}>{m.brand}</div>
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
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)", marginBottom: 8 }}>
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
            fontSize: 12.5, fontWeight: 700, padding: "0 18px", minHeight: 44, cursor: "pointer",
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
  const [tabPrefs, setTabPrefs] = useState(loadTabPrefs);
  const tabs = visibleTabs(tabPrefs);
  // Open on the first visible tool rather than a hardcoded "zts", which would
  // land on a tab the operator has hidden.
  // Seeded from the URL when there is one. An empty hash still resolves to the
  // first visible tool, which is the documented behaviour above — the hash only
  // decides anything when it is actually present.
  const [active, setActive] = useState(
    () => parseRoute(typeof location !== "undefined" ? location.hash : "", visibleTabs(loadTabPrefs())).tool);
  const [systemOpen, setSystemOpen] = useState(
    () => parseRoute(typeof location !== "undefined" ? location.hash : "", visibleTabs(loadTabPrefs())).system);

  // One writer for the URL, driven by state rather than by every call site, so
  // a destination reached by keyboard shortcut, by toggle, or by the tool being
  // hidden underneath you all leave the same address behind.
  useEffect(() => {
    const dest = { tool: active, system: systemOpen };
    if (sameRoute(location.hash, dest)) return;
    // replace, not push: switching tools is changing WHERE YOU ARE, not
    // navigating within a page. Pushing would make the back button walk the
    // history of every tool you glanced at.
    history.replaceState(null, "", formatRoute(dest));
  }, [active, systemOpen]);

  // The back button, and a hash typed or pasted into the address bar.
  useEffect(() => {
    const onHash = () => {
      const r = parseRoute(location.hash, visibleTabs(loadTabPrefs()));
      // A hash the shell does not recognise belongs to the tool that is open —
      // Clarify, Runway and SYNC all route their own views through this same
      // hash. Acting on it threw the operator out of Clarify and into whichever
      // tool happened to be first in the toggle. Silence is the correct response.
      if (!r.known) return;
      setActive(r.tool);
      setSystemOpen(r.system);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const pick = useCallback((a) => {
    setActive(a);
    setSystemOpen(false);
  }, []);

  // ── the bar's height, measured rather than assumed ──────────────────────────
  //
  // Ten call sites across six tools hardcoded `calc(100vh - 52px)` or
  // `top: 52px`, which pinned this bar to one row forever: the comment here used
  // to say that growing it to 53 would put a permanent 1px overflow on every one
  // of them, and it was right. Now the real height is measured and written to
  // --shell-bar on the root, and those call sites read `var(--shell-bar, 52px)`.
  // The fallback keeps each tool's standalone dev entry — which has no shell bar
  // at all — behaving exactly as it did.
  //
  // Measured rather than computed because the height depends on how many tools
  // are visible, how they wrap, and the font: any arithmetic here would be a
  // second source of truth that drifts. A ResizeObserver just watches it.
  const barRef = useRef(null);
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const root = el.closest("[data-app]") || document.documentElement;
    const publish = () => {
      // +1 for the bar's own bottom border, which is on the wrapper, not here.
      root.style.setProperty("--shell-bar", `${Math.round(el.getBoundingClientRect().height) + 1}px`);
    };
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isMobile, tabs, systemOpen]);

  // Preference changes come from System → Tabs, which is rendered by this same
  // component, so they arrive through here rather than through storage events.
  const applyTabPrefs = useCallback((next) => {
    const saved = saveTabPrefs(next);
    setTabPrefs(saved);
    // Hiding the tool you are looking at has to go somewhere. resolveActive
    // owns that rule so the shell cannot strand you on a surface the toggle can
    // no longer reach.
    setActive((cur) => resolveActive(saved, cur));
  }, []);

  // Another tab of the same site editing preferences should not leave this one
  // rendering a toggle that no longer matches what was saved.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key && e.key !== TAB_PREFS_KEY) return;
      const next = loadTabPrefs();
      setTabPrefs(next);
      setActive((cur) => resolveActive(next, cur));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
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
      const i = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6"].indexOf(e.code);
      // Indexed into the VISIBLE tabs, so ⌥2 is always the second thing on
      // screen. Indexing the full APPS list would make the shortcuts point at
      // hidden tools and skip numbers.
      if (i === -1 || !tabs[i]) return;
      e.preventDefault();
      pick(tabs[i]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pick, tabs]);

  if (session === undefined) return <Boot />;
  if (!session) return <LoginScreen />;

  const m = appMeta(active);
  const Tool = TOOLS[active];

  return (
    <div data-app={systemOpen ? "system" : active} data-palette={systemOpen ? "sync" : active} data-theme={systemOpen ? "dark" : m.mode} style={{ ...(systemOpen ? PLATFORM_VARS : cssVars(active)), minHeight: "100vh", background: "var(--bg)", color: "var(--ink)", fontFamily: "var(--font-body)", transition: `background ${M.durSlow} ${M.easeStd}` }}>
      {/* Shell top bar — the ONE global chrome, themed to the active tool.
          data-kit goes HERE and not on the wrapper above. The wrapper contains
          every tool, and @cc/ui's kit styles .btn/.card/.field/.sheet — names
          eight apps already own and mean different things by. Opting the wrapper
          in would restyle all of them at once; opting the bar in restyles the
          chrome and nothing else. */}
      <div data-kit style={{
        position: "sticky", top: 0, zIndex: 100,
        paddingTop: "env(safe-area-inset-top)",
        borderBottom: "1px solid var(--line)",
        background: "color-mix(in srgb, var(--bg) 82%, transparent)", backdropFilter: "blur(20px) saturate(140%)", WebkitBackdropFilter: "blur(20px) saturate(140%)",
      }}>
      {/* TWO ROWS ON A PHONE, ONE ON A DESKTOP, NEVER A SCROLLER.
          The bar used to be locked at exactly 51px + 1px border, because ten
          call sites across six tools hardcode `calc(100vh - 52px)` or
          `top: 52px`. That constant is now MEASURED and published as
          --shell-bar (see the ref below), so the bar can be whatever height its
          contents need and every one of those call sites follows it. */}
      <div ref={barRef} style={{
        minHeight: 51, paddingLeft: isMobile ? 10 : 20, paddingRight: isMobile ? 10 : 20,
        paddingTop: isMobile ? 6 : 0, paddingBottom: isMobile ? 6 : 0,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        // On a phone the tool grid needs the full width to wrap into, so identity
        // and System take their own line above it. On a desktop the whole thing
        // still fits one line and splitting it there would just be noise.
        flexDirection: isMobile ? "column" : "row", gap: isMobile ? 6 : 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 14, minWidth: 0, width: isMobile ? "100%" : undefined, flex: isMobile ? "none" : "0 1 auto", order: isMobile ? 2 : 0 }}>
          {!isMobile && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <PentagonLogo size={23} />
              {/* SESSION: system stack, sentence case, hierarchy from size and
                  weight rather than tracking. Uppercase survives in exactly one
                  place in this language and a wordmark is not it. */}
              <span className="t-head" style={{ color: "var(--ink)", whiteSpace: "nowrap" }}>The Pentagon</span>
            </span>
          )}
          <AppToggle active={active} onPick={pick} compact={isMobile} apps={tabs} />
        </div>
        <div style={{
          display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
          // On a phone this is the identity line: mark on the left, System on
          // the right, with the tool grid on its own full-width row beneath.
          width: isMobile ? "100%" : undefined, marginLeft: isMobile ? 0 : 8,
          justifyContent: isMobile ? "space-between" : undefined, order: isMobile ? 1 : 0,
        }}>
          {isMobile && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <PentagonLogo size={21} />
              <span className="t-head" style={{ color: "var(--ink)", whiteSpace: "nowrap" }}>The Pentagon</span>
            </span>
          )}
          {/* Icon-only on mobile: it keeps a 44px target without spending width
              the tool grid below needs. */}
          <button onClick={() => setSystemOpen((o) => !o)} type="button"
            title="System — usage, minds & agents across every tool"
            aria-label="System — usage, minds & agents across every tool"
            aria-pressed={systemOpen}
            className={systemOpen ? "btn sm tinted" : "btn sm quiet"}
            style={{
              // The kit owns colour, radius, weight, press physics and the focus
              // ring. Only the mobile target floor is local, because that is a
              // fact about this bar rather than about buttons.
              minHeight: isMobile ? 44 : undefined, minWidth: isMobile ? 44 : undefined,
              padding: isMobile ? "0 11px" : undefined,
            }}>
            <span aria-hidden style={{ width: isMobile ? 8 : 6, height: isMobile ? 8 : 6, borderRadius: "50%", background: systemOpen ? "var(--accent)" : "var(--faint)", flex: "none" }} />{!isMobile && "System"}
          </button>
          {!isMobile && (
            // Was 10px — under this language's 10.5px floor, which is stated as
            // absolute. The kit's .btn.sm sits at the floor.
            <button className="btn sm quiet" onClick={() => auth.signOut()}>Sign out</button>
          )}
        </div>
      </div>
      </div>

      {/* System hub (cross-tool) or the active tool, both lazy-loaded */}
      <ToolBoundary key={systemOpen ? "system" : active}>
        <Suspense fallback={<div style={{ padding: 24 }}><SkeletonBoard /></div>}>
          {systemOpen
            ? <System onExit={() => setSystemOpen(false)} onOpenTool={pick} tabPrefs={tabPrefs} onTabPrefs={applyTabPrefs} />
            : Tool ? <Tool key={active} /> : <ComingSoon app={active} />}
        </Suspense>
      </ToolBoundary>
    </div>
  );
}
