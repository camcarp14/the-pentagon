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
import { Component, forwardRef, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { appMeta, cssVars } from "@cc/design";
import { SkeletonBoard, EmptyIcon, M, useIsMobile } from "@cc/ui";
import { auth, isConfigured } from "@cc/supabase";
import { loadTabPrefs, saveTabPrefs, visibleTabs, resolveActive, TAB_PREFS_KEY } from "./tabPrefs.js";
import {
  loadThemePrefs, saveThemePrefs, resolveMode, resolvePalette, isDefaultTheme,
  themeVars, prefersDark, watchSystemTheme, THEME_PREFS_KEY,
} from "./themePrefs.js";
import { useToolPower, pausedTools, powerFor, stoppedSentence, keepsSentence } from "./toolPower.js";
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
// --subtle, --good, --warn and --bad joined the list when System stopped
// hardcoding its own six-hex palette and started reading these (System.jsx's
// `P`). Their values here are the exact hexes System used to carry, so the
// default rendering of that screen is unchanged to the pixel; the point of the
// move is that the same names are re-pointed at light-capable tokens the moment
// a theme is chosen (themePrefs.js's themeVars).
const PLATFORM_VARS = {
  "--bg": "#0A0E15", "--surface": "#131A24", "--surface-2": "#1B2438", "--subtle": "#0F151E", "--ink": "#E9EDF5", "--muted": "#93A1B5",
  "--faint": "#66748A", "--border": "rgba(255,255,255,0.08)", "--accent": "#AAB6C6",
  "--accent-soft": "rgba(170,182,198,0.14)", "--accent-line": "rgba(170,182,198,0.32)",
  "--good": "#4FD694", "--warn": "#F5B84D", "--bad": "#FF6F6F",
  "--shadow-tab": "0 1px 2px rgba(0,0,0,0.5)",
  "--font-display": "var(--font-body)", "--font-body": "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif", "--font-mono": "ui-monospace, 'SF Mono', Menlo, monospace",
};

// Off-screen but not hidden. `display: none` and `visibility: hidden` are both
// removed from the accessibility tree, which is the opposite of what a
// screen-reader-only marker needs; this is the clip-path form, which stays in
// the tree and contributes nothing to layout.
const SR_ONLY = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
  overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap", border: 0,
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

// ─── the desktop rail ─────────────────────────────────────────────────────────
//
// The tools were a horizontal row in the top bar. On a wide screen that spends
// the scarcest axis — vertical — on chrome, and stacks a tool row above a
// sub-tab row above a page, so the actual content starts a couple of hundred
// pixels down. Vertical space is what a desktop has least of and horizontal is
// what it has most of, so the top-level nav goes where the room is.
//
// One nav level only, deliberately. Each tool keeps its own sub-tabs at the top
// of the content column; nesting those into the rail would be a different
// information architecture than the one this was asked to match.
//
// Mobile never sees this. The phone bar was measured and fixed in the commit
// before last (five tools on one line, eight wrapping 5+3) and is not in scope.
// Line-art marks, one per tool, 18px on a 1.6 stroke. Board Room's rail reads as
// a product because each row has a SHAPE before it has a word — you learn the
// position by glyph and stop reading the label after a day. A coloured dot
// cannot do that: eight dots are eight of the same shape in eight hues, which is
// a legend, not an icon set.
//
// The dot does not disappear, it moves job: it is the paused/active state now,
// carried on the glyph's colour instead of beside it.
const TOOL_ICON = {
  zts: "M12 3 4 6.5v5c0 4.4 3.2 8.3 8 9.5 4.8-1.2 8-5.1 8-9.5v-5L12 3Z",           // shield — security
  clarify: "M4 6h16M4 12h10M4 18h7M17 15l2.5 2.5L23 13",                            // lines + check — outreach
  runway: "M3 20h18M6 20V9l6-5 6 5v11M10 20v-5h4v5",                                // building — the job search
  macro: "M3 17l5-6 4 3 4-6 5 4M3 21h18",                                           // chart — the market
  looper: "M17 3l4 4-4 4M21 7H8a4 4 0 0 0-4 4v1M7 21l-4-4 4-4M3 17h13a4 4 0 0 0 4-4v-1", // loop
  business: "M3 21V8l7-5 7 5v13M9 21v-5h4v5M21 21V12l-4-3",                          // office
  sync: "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1", // the day, radiating
  ideas: "M9 21h6M10 18h4M12 3a6 6 0 0 0-3.5 10.9c.6.5.9 1.2.9 1.9v.2h5.2v-.2c0-.7.3-1.4.9-1.9A6 6 0 0 0 12 3Z", // bulb
};
const ToolGlyph = ({ app, color }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
    <path d={TOOL_ICON[app] || "M4 4h16v16H4z"} />
  </svg>
);

const SunIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
  </svg>
);
const MoonIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
  </svg>
);
const GearIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V11a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </svg>
);

// ─── the desktop rail ─────────────────────────────────────────────────────────
//
// The tools were a horizontal row in the top bar, which spends a desktop's
// scarcest axis — vertical — on chrome. Vertical is what a wide screen has least
// of and horizontal is what it has most of, so the top-level nav goes where the
// room is.
//
// One nav level only. Each tool keeps its own sub-tabs at the top of the content
// column; nesting those in here would be a different information architecture.
// Mobile never sees this — the phone bar was measured and fixed separately and
// renders the wrapping row exactly as it did.
//
// THE FOOTER IS WHERE THE THEME LIVES, and that is the whole reason the setting
// reads as working now. It was correct before this — light mode really did flip
// the ground, the palette really did repaint every tool — but it was three taps
// deep inside System, so the honest report was "the theme tool doesn't seem to
// be working." A setting nobody can find is indistinguishable from one that does
// nothing. One tap here for the ground; the full palette picker stays in System,
// where the sixteen-way choice belongs.
const SideRail = forwardRef(function SideRail({ active, onPick, apps, paused, systemOpen, onSystem, onSignOut, email, mode, onOpenTheme, themed }, ref) {
  // Hover lives in JS because every control in this rail is inline-styled, and a
  // :hover rule cannot reach an inline style. Tracking one id rather than a
  // boolean per row keeps it to a single state change per pointer move.
  const [hot, setHot] = useState(null);
  const hoverProps = (id) => ({
    onMouseEnter: () => setHot(id),
    onMouseLeave: () => setHot((h) => (h === id ? null : h)),
    onFocus: () => setHot(id),
    onBlur: () => setHot((h) => (h === id ? null : h)),
  });
  return (
    <div
      ref={ref}
      data-kit
      // Sticky rather than fixed: fixed takes it out of flow, and the content
      // column would then need a margin equal to a width that is measured
      // asynchronously — a frame of overlap on every load, and a second source
      // of truth for one number. Sticky keeps it in the flex row, so the
      // column's width IS the remainder, with no arithmetic anywhere.
      style={{
        position: "sticky", top: 0, alignSelf: "flex-start",
        height: "100vh", flex: "0 0 auto", width: 212,
        display: "flex", flexDirection: "column",
        paddingTop: "max(12px, env(safe-area-inset-top))", paddingBottom: 10,
        borderRight: "1px solid var(--line)",
        background: "color-mix(in srgb, var(--bg) 55%, var(--surface))",
        zIndex: 101,
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "2px 14px 12px", flexShrink: 0 }}>
        <PentagonLogo size={20} />
        <span className="t-head" style={{ color: "var(--ink)", whiteSpace: "nowrap" }}>The Pentagon</span>
      </div>

      <nav aria-label="Switch tool" style={{ display: "flex", flexDirection: "column", gap: 1, padding: "0 8px", overflowY: "auto", flex: "1 1 auto", minHeight: 0 }}>
        {apps.map((a) => {
          const m = appMeta(a);
          const on = a === active && !systemOpen;
          const off = paused?.has?.(a);
          const hov = hot === a && !on;
          return (
            <button key={a} type="button" onClick={() => onPick(a)} title={off ? `${m.brand} — paused` : m.brand}
              aria-current={on ? "true" : undefined} {...hoverProps(a)}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                width: "100%", minWidth: 0, padding: "0 10px", minHeight: 34,
                border: "none", borderRadius: 8, cursor: "pointer", textAlign: "left",
                // ── THE ACTIVE ROW GLOWS IN ITS OWN ACCENT ──────────────────
                // The active row is drawn, never slid — the same call the
                // horizontal row made when it stopped measuring a thumb. What is
                // new is that it is tinted and ringed in the TOOL's accent
                // rather than in neutral surface grey. Board Room's rail does
                // this and it is most of why it reads as a product: the row you
                // are standing on is the one place the accent is spent, which is
                // exactly the job DESIGN.md §4.4 gives it.
                //
                // color-mix over var(--accent) rather than a hand-mixed rgba, so
                // the same declaration is a soft wash on the dark ground and a
                // pale tint on the light one, with no second value to maintain.
                background: on
                  ? "color-mix(in srgb, var(--accent) 13%, transparent)"
                  : hov ? "color-mix(in srgb, var(--ink) 6%, transparent)" : "transparent",
                boxShadow: on ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)" : "none",
                color: on ? "var(--ink)" : hov ? "var(--ink)" : "var(--muted)",
                fontSize: 13, fontWeight: on ? 600 : 500, letterSpacing: 0,
                transition: `color ${M.durBase} ${M.easeStd}, background ${M.durBase} ${M.easeStd}, box-shadow ${M.durBase} ${M.easeStd}`,
              }}>
              {/* The accent lives on the GLYPH, not on a separate dot. One mark
                  carrying both identity and state is what makes eight rows read
                  as a set rather than as a legend with a colour key. On hover it
                  previews its own accent, so the colour answers "which tool is
                  this" before the click rather than after it. */}
              {/* Under a CHOSEN palette the glyph follows the theme, not the
                  tool. Picking one palette is the operator saying "I want this
                  product to be one colour", and a rail that answers with eight
                  is arguing with the setting — the ring around the active row
                  already reads var(--accent), so leaving the glyph on the tool's
                  own hue put two different colours on one row. On the default
                  ("Match the tool") nothing changes: the accent IS the tool. */}
              <ToolGlyph app={a} color={off ? "var(--faint)" : on || hov ? (themed ? "var(--accent)" : m.accent) : "var(--faint)"} />
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: off ? 0.6 : 1 }}>{m.label}</span>
              {off && <span className="t-cap" style={{ marginLeft: "auto", color: "var(--faint)", flexShrink: 0 }}>off</span>}
            </button>
          );
        })}
      </nav>

      {/* System is chrome, not a tool, so it sits under a hairline rather than
          inside the list — but it is the same row shape, because a full-width
          filled button down here read as a form control in a nav. */}
      <div style={{ padding: "8px 8px 0", marginTop: 6, borderTop: "1px solid var(--line)", flexShrink: 0 }}>
        <button onClick={onSystem} type="button" aria-pressed={systemOpen} {...hoverProps("__system")}
          title="System — ops, usage, minds, agents, tabs and theme"
          style={{
            display: "flex", alignItems: "center", gap: 10, width: "100%",
            padding: "0 10px", minHeight: 34, border: "none", borderRadius: 8, cursor: "pointer", textAlign: "left",
            background: systemOpen
              ? "color-mix(in srgb, var(--accent) 13%, transparent)"
              : hot === "__system" ? "color-mix(in srgb, var(--ink) 6%, transparent)" : "transparent",
            boxShadow: systemOpen ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)" : "none",
            color: systemOpen || hot === "__system" ? "var(--ink)" : "var(--muted)",
            fontSize: 13, fontWeight: systemOpen ? 600 : 500,
            transition: `color ${M.durBase} ${M.easeStd}, background ${M.durBase} ${M.easeStd}, box-shadow ${M.durBase} ${M.easeStd}`,
          }}>
          <span style={{ color: systemOpen ? "var(--accent)" : "var(--faint)", display: "flex" }}><GearIcon /></span>
          System
        </button>
      </div>

      {/* The account row, Board Room's shape: who you are, and the one control
          that changes the whole page, on the same line. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px 0", marginTop: 4, flexShrink: 0 }}>
        <span title={email || undefined} style={{
          minWidth: 0, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          fontSize: 11.5, color: "var(--faint)",
        }}>{email || "signed in"}</span>
        {/* OPENS THE THEME SETTINGS, does not blind-toggle. It flipped the
            ground on tap at first, which is one tap but also a control whose
            outcome you cannot see before you commit to it and which can only
            ever reach two of the sixteen combinations. Board Room's opens its
            settings, and that is the better answer: the icon shows the ground
            you are ON, and tapping it takes you to the surface where the
            palette, the mode and "follow the system" all live together. */}
        <button type="button" onClick={onOpenTheme} {...hoverProps("__theme")}
          title="Theme — palette and light or dark" aria-label="Theme settings"
          style={{
            display: "grid", placeItems: "center", width: 28, height: 28, flexShrink: 0,
            border: "none", borderRadius: 8, cursor: "pointer",
            background: hot === "__theme" ? "color-mix(in srgb, var(--ink) 8%, transparent)" : "transparent",
            color: hot === "__theme" ? "var(--ink)" : "var(--faint)",
            transition: `color ${M.durBase} ${M.easeStd}, background ${M.durBase} ${M.easeStd}`,
          }}>
          {mode === "dark" ? <MoonIcon /> : <SunIcon />}
        </button>
        <button type="button" onClick={onSignOut} title="Sign out" aria-label="Sign out" {...hoverProps("__out")}
          style={{
            display: "grid", placeItems: "center", width: 28, height: 28, flexShrink: 0,
            border: "none", borderRadius: 8, cursor: "pointer",
            background: hot === "__out" ? "color-mix(in srgb, var(--ink) 8%, transparent)" : "transparent",
            color: hot === "__out" ? "var(--ink)" : "var(--faint)",
            transition: `color ${M.durBase} ${M.easeStd}, background ${M.durBase} ${M.easeStd}`,
          }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
          </svg>
        </button>
      </div>
    </div>
  );
});

// ─── the app toggle ───────────────────────────────────────────────────────────
function AppToggle({ active, onPick, compact, apps, paused }) {
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
        // PAUSED IS NOT HIDDEN, AND THE BAR HAS TO SHOW THE DIFFERENCE.
        // A hidden tool is not here at all; a paused tool is here, still opens,
        // still shows everything it has ever collected — its scheduled work is
        // what stopped. So it is dimmed and its dot goes hollow rather than
        // being dropped or disabled. Hollow, not merely a different colour:
        // §4.7 and the toggle's own aria-current comment both refuse
        // colour-only state, and eight accents means a "muted" dot is somebody
        // else's normal one.
        const off = paused?.has(a);
        return (
          <button key={a} ref={(el) => { refs.current[a] = el; }} onClick={() => onPick(a)} type="button"
            // No aria-label: it would override the visible label, so voice
            // control ("tap ZTS") would fail against an accessible name of
            // "Zero To Secure" (WCAG 2.5.3). The visible text IS the name; the
            // brand stays as the hover title only.
            title={off ? `${m.brand} — paused` : m.brand} aria-current={on ? "true" : undefined}
            data-paused={off ? "true" : undefined}
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
              opacity: off ? 0.6 : 1,
              transition: `color ${M.durBase} ${M.easeStd}, background ${M.durBase} ${M.easeStd}, opacity ${M.durBase} ${M.easeStd}`,
            }}>
            {/* FIRST child, deliberately. scripts/toolrow-check.mjs measures the
                button's LAST element for truncation, and the label has to stay
                that element or the harness starts measuring this instead. It
                also keeps the visible text inside the accessible name, which is
                what voice control matches on (WCAG 2.5.3). */}
            {off && <span style={SR_ONLY}>Paused: </span>}
            <span aria-hidden style={{
              width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
              background: off ? "transparent" : m.accent,
              border: off ? `1.5px solid ${m.accent}` : "none",
              boxShadow: on && !off ? `0 0 8px ${m.accent}` : "none",
            }} />
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

// ─── "this tool's scheduled work is stopped" ─────────────────────────────────
//
// THE TOOL ITSELF IS NOT PAUSED. Everything below this strip renders exactly as
// it always did: the data is there, the buttons work, a manual run still runs.
// What stopped is the part that happens while nobody is looking. That
// distinction is the whole reason this is a banner over a live screen and not a
// lock over a dead one — and it is why the strip names the engines rather than
// saying "paused", which would be read as "this tool is off".
//
// It sits inside the scroll, not fixed: it is a statement of fact you read once,
// not an alert that has to follow you down the page.
function PausedBanner({ app, entry, onResume, busy }) {
  const stopped = stoppedSentence(entry);
  const keeps = keepsSentence(entry);
  // A failed resume rolls the state back, so this strip simply stays — which on
  // its own reads as "the button did nothing". The error has to be said out
  // loud, next to the control that produced it, or the operator's next move is
  // to press it again.
  const [err, setErr] = useState("");
  const resume = () => { setErr(""); Promise.resolve(onResume()).catch((e) => setErr(String(e?.message || e))); };
  return (
    // NO data-kit AND NO CLASS NAMES. This strip renders inside whichever tool
    // is open, and DESIGN.md §5 is about exactly this: eight apps already own
    // `.btn`, `.card` and `.field` and mean different things by them. Measured
    // rather than reasoned — `className="btn sm"` here came out as an unreadable
    // dark slab over light-mode Macro, because apps/macro/src/styles.css ships
    // an UNSCOPED `.btn` with its own dark background and it wins wherever Macro
    // is mounted. The bar above can wear data-kit because it sits outside every
    // tool; this cannot.
    <div role="status" style={{
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      margin: "12px 16px 0", padding: "10px 14px", borderRadius: 12,
      // Border, no shadow — §4.2. --warn rather than the accent: the accent
      // says which tool you are in (§4.4) and this says something about it.
      border: "1px solid color-mix(in srgb, var(--warn) 42%, transparent)",
      background: "color-mix(in srgb, var(--warn) 10%, transparent)",
    }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", border: "1.5px solid var(--warn)" }} />
      <span style={{ minWidth: 0, flex: "1 1 260px" }}>
        <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>
          {appMeta(app).label} is paused
        </span>
        <span style={{ display: "block", fontSize: 11.5, color: "var(--muted)", marginTop: 2, lineHeight: 1.5 }}>
          {stopped ? `${stopped} Everything on this screen still works — nothing runs on its own until you resume.` : "Its scheduled work is stopped. Everything on this screen still works."}
          {/* The one thing a pause does not stop, said here too: this banner is
              the surface an operator reads WHILE paused, so it is where a wrong
              belief about what is still sampling would do its damage. */}
          {keeps && ` ${keeps}`}
        </span>
        {err && <span role="alert" style={{ display: "block", fontSize: 11.5, color: "var(--bad)", marginTop: 4, lineHeight: 1.5 }}>Couldn't resume — {err}. It is still paused.</span>}
      </span>
      <button type="button" onClick={resume} disabled={busy} style={{
        flex: "none", minHeight: 34, padding: "0 16px", borderRadius: 10, cursor: busy ? "default" : "pointer",
        border: "1px solid color-mix(in srgb, var(--warn) 55%, transparent)", background: "transparent",
        color: "var(--ink)", fontSize: 12.5, fontWeight: 700, fontFamily: "var(--font-body)",
        opacity: busy ? 0.55 : 1,
      }}>
        {busy ? "Resuming…" : "Resume"}
      </button>
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
  // Which System tab to land on. The rail's theme icon deep-links to "theme";
  // everything else opens System where it was left.
  const [systemTab, setSystemTab] = useState(null);
  const [systemOpen, setSystemOpen] = useState(
    () => parseRoute(typeof location !== "undefined" ? location.hash : "", visibleTabs(loadTabPrefs())).system);

  // ── theme ───────────────────────────────────────────────────────────────────
  // Two axes and the device's own answer to the second one. `sysDark` is read
  // once at mount and then SUBSCRIBED to — "System" that only samples
  // prefers-color-scheme at boot is not System, it is "whatever your laptop was
  // doing when this tab last loaded", and an iOS standalone window can go weeks
  // without a reload while the OS flips at sunset every day.
  const [themePrefs, setThemePrefs] = useState(loadThemePrefs);
  const [sysDark, setSysDark] = useState(prefersDark);
  useEffect(() => watchSystemTheme(setSysDark), []);

  // ── pause ───────────────────────────────────────────────────────────────────
  // ONE reader for the whole shell, here rather than in each consumer: the tool
  // row and the System switch that writes it must not be able to disagree about
  // what is running.
  const toolPower = useToolPower();
  const paused = useMemo(() => pausedTools(toolPower.power), [toolPower.power]);

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
  // ── the rail, and its width, measured the same way ──────────────────────────
  //
  // The tools moved out of the top bar and onto a left rail on desktop. That
  // publishes a SECOND dimension nothing in this repo had before: the content
  // column no longer starts at x=0. --shell-rail is its twin of --shell-bar,
  // measured for exactly the same reason (the width depends on the longest
  // label and the font, and arithmetic would be a second source of truth), and
  // it is 0px whenever the rail is not rendered so a phone and a standalone dev
  // entry are unchanged.
  //
  // The content column is a containing block for fixed descendants, so tools do
  // not have to read this at all — see the comment at that element. It is
  // published because a measurement that exists is worth more than one that has
  // to be re-derived, and because the harness asserts against it.
  const rail = !isMobile;
  const railRef = useRef(null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = railRef.current;
    if (!rail || !el) { root.style.setProperty("--shell-rail", "0px"); return; }
    const publish = () => root.style.setProperty("--shell-rail", `${Math.round(el.getBoundingClientRect().width)}px`);
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => { ro.disconnect(); root.style.setProperty("--shell-rail", "0px"); };
  }, [rail, tabs]);

  const barRef = useRef(null);
  useLayoutEffect(() => {
    const el = barRef.current;
    // No bar (desktop, rail up) means no offset. Publish 0 rather than leaving
    // the last measured height behind, or six tools sizing themselves with
    // `calc(100vh - var(--shell-bar))` each keep a 52px hole where a bar was.
    //
    // Written to [data-app] and NOWHERE ELSE, including when that element does
    // not exist yet. Falling back to documentElement looked harmless and was
    // not: on the first paint the shell is still resolving its session, so the
    // wrapper is absent, the 0px landed on the root — and custom properties
    // inherit, so every tool then read `var(--shell-bar, 52px)` as 0 for the
    // life of the page, with the real height set one element further down where
    // it could never win. The browser harness caught it; no unit test could.
    const root = document.querySelector("[data-app]");
    if (!el) { if (root) root.style.setProperty("--shell-bar", "0px"); return; }
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

  const applyThemePrefs = useCallback((next) => { setThemePrefs(saveThemePrefs(next)); }, []);

  // Another tab of the same site editing preferences should not leave this one
  // rendering a toggle that no longer matches what was saved.
  useEffect(() => {
    const onStorage = (e) => {
      // Two keys now. The theme one matters more than the tab one here: the
      // operator sets it in one window and the second window is the obvious
      // place to notice it did not take.
      if (e.key && e.key !== TAB_PREFS_KEY && e.key !== THEME_PREFS_KEY) return;
      if (!e.key || e.key === THEME_PREFS_KEY) setThemePrefs(loadThemePrefs());
      if (e.key === THEME_PREFS_KEY) return;
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

  // ── the resolved theme ──────────────────────────────────────────────────────
  //
  // "Match the tool" keeps the attribute the shell has always stamped — the open
  // tool, or "sync" while System is open. A chosen palette replaces it, on both.
  const palette = resolvePalette(themePrefs, systemOpen ? "sync" : active);
  const mode = resolveMode(themePrefs, sysDark);
  // `themed` decides WHICH SET OF INLINE VARIABLES gets stamped, and that is the
  // whole feature. themes.css has carried a light half for every palette since
  // the token layer landed, and none of it could ever reach the page, because
  // cssVars() writes MIDNIGHT's dark hexes inline and an inline custom property
  // beats a stylesheet one (main.jsx says so). Flipping data-theme alone would
  // have shipped a Light button that changed an attribute and nothing else.
  //
  // False here means the resolved answer is exactly what production already
  // renders — the tool's accent over midnight — so that path stays literally the
  // old expression and cannot drift.
  const themed = !isDefaultTheme(themePrefs, sysDark);
  const vars = themed ? themeVars(palette) : systemOpen ? PLATFORM_VARS : cssVars(active);

  // The shell paints from <div data-app> down; the DOCUMENT behind it is painted
  // by index.html's `body` rule and by the browser's own color-scheme (form
  // controls, scrollbars, overscroll rubber-banding). Both live above this
  // component's root, so a light Pentagon with a black overscroll gutter and
  // white-on-white scrollbars is what "the wrapper went light" gets you on its
  // own. --shell-canvas is published only when the operator has chosen
  // something, so the default document is byte-for-byte what it was.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", mode);
    root.style.colorScheme = mode;
    if (themed) root.style.setProperty("--shell-canvas", "var(--bg)");
    else root.style.removeProperty("--shell-canvas");
  }, [mode, themed]);

  if (session === undefined) return <Boot />;
  if (!session) return <LoginScreen />;

  const Tool = TOOLS[active];
  const activePower = powerFor(toolPower.power, active);

  return (
    <div data-app={systemOpen ? "system" : active} data-palette={palette} data-theme={mode} style={{ ...vars, minHeight: "100vh", background: "var(--bg)", color: "var(--ink)", fontFamily: "var(--font-body)", transition: `background ${M.durSlow} ${M.easeStd}`, display: rail ? "flex" : "block", alignItems: rail ? "stretch" : undefined }}>

      {rail && (
        <SideRail
          ref={railRef} active={active} onPick={pick} apps={tabs} paused={paused}
          systemOpen={systemOpen} onSystem={() => setSystemOpen((o) => !o)} onSignOut={() => auth.signOut()}
          email={session?.user?.email}
          mode={mode}
          onOpenTheme={() => { setSystemTab("theme"); setSystemOpen(true); }}
          themed={themed}
        />
      )}

      {/* ── THE CONTENT COLUMN, AND WHY IT IS TRANSFORMED ────────────────────
          `transform: translateZ(0)` is not a paint hint here. It makes this
          element the CONTAINING BLOCK for every `position: fixed` descendant,
          which is the entire reason the rail is safe to add.

          The eight tools own 28 fixed elements between them — Clarify 12, SYNC
          6, Runway 5, Macro 3, ZTS 1, Looper 1: bottom navs, bottom sheets,
          toast stacks, command palettes, modal scrims. Every one is anchored to
          the VIEWPORT, because until now the content column started at x=0 and
          the two were the same rectangle. Add a rail and they are not: anything
          at `left: 0` slides under it and anything centred with `left: 50%`
          sits off-centre by half the rail.

          The alternative was to find all 28 and inset each by hand, in eight
          apps nobody would remember to check again — and to be wrong the first
          time someone adds a 29th. One containing block fixes the whole class,
          including the ones not written yet, and it is why `--shell-rail` below
          is published for measurement rather than for arithmetic in tool CSS.

          `100vh` still means the viewport, so every `calc(100vh - var(--shell-bar))`
          call site is untouched. Horizontal is the axis that changed, and this is
          the axis this fixes. */}
      <div style={rail
        ? { flex: "1 1 auto", minWidth: 0, transform: "translateZ(0)", position: "relative" }
        : undefined}>

      {/* THE TOP BAR IS DESKTOP-OPTIONAL NOW. With the rail up it holds the
          mark, the tools, System and Sign out — all of which moved into the
          rail — so what is left is 52px of empty chrome charged to the axis a
          desktop has least of.

          The first attempt at this broke ZTS: its sub-nav was `top: "52px"`,
          a hardcoded copy of a number that had been measured and published as
          --shell-bar for exactly this reason, so with the bar gone the nav sat
          52px down while its content started at 0 and the two overlapped. The
          nav reads the variable now (and so does Clarify's), which is what makes
          removing the bar safe rather than merely tempting.

          Shell top bar — the ONE global chrome, themed to the active tool.
          data-kit goes HERE and not on the wrapper above. The wrapper contains
          every tool, and @cc/ui's kit styles .btn/.card/.field/.sheet — names
          eight apps already own and mean different things by. Opting the wrapper
          in would restyle all of them at once; opting the bar in restyles the
          chrome and nothing else. */}
      {!rail && <div data-kit style={{
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
          {/* On desktop the mark and the tools BOTH live in the rail, so the top
              bar keeps only what is about the current tool. On a phone there is
              no rail and this is the identity line, unchanged. */}
          {!isMobile && !rail && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <PentagonLogo size={23} />
              {/* SESSION: system stack, sentence case, hierarchy from size and
                  weight rather than tracking. Uppercase survives in exactly one
                  place in this language and a wordmark is not it. */}
              <span className="t-head" style={{ color: "var(--ink)", whiteSpace: "nowrap" }}>The Pentagon</span>
            </span>
          )}
          {!rail && <AppToggle active={active} onPick={pick} compact={isMobile} apps={tabs} paused={paused} />}
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
              the tool grid below needs. With the rail up both of these live at
              the bottom of it, so rendering them here too would be the same two
              controls twice on one screen. */}
          {!rail && <>
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
          </>}
        </div>
      </div>
      </div>}

      {/* OUTSIDE the boundary and outside Suspense, on purpose: the tool below
          may still be downloading, or may have thrown, and "your engines are
          stopped" is exactly the fact you still need in both of those states. */}
      {!systemOpen && activePower.paused && (
        <PausedBanner
          app={active}
          entry={activePower}
          busy={toolPower.busy === active}
          onResume={() => toolPower.setPaused(active, false)}
        />
      )}

      {/* System hub (cross-tool) or the active tool, both lazy-loaded */}
      <ToolBoundary key={systemOpen ? "system" : active}>
        <Suspense fallback={<div style={{ padding: 24 }}><SkeletonBoard /></div>}>
          {systemOpen
            ? <System onExit={() => setSystemOpen(false)} onOpenTool={pick} initialTab={systemTab} onTabConsumed={() => setSystemTab(null)} tabPrefs={tabPrefs} onTabPrefs={applyTabPrefs}
                themePrefs={themePrefs} onThemePrefs={applyThemePrefs} systemPrefersDark={sysDark} toolPower={toolPower} />
            : Tool ? <Tool key={active} /> : <ComingSoon app={active} />}
        </Suspense>
      </ToolBoundary>

      </div>{/* /content column */}
    </div>
  );
}
