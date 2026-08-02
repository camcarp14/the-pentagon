import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient";
import DOMPurify from "dompurify";
import { AnimatedNumber, EmptyState, SkeletonLine, SkeletonRows, SkeletonBoard, CommandPalette, useToast, M } from "./ui.jsx";
import { T, syne, mono } from "./theme.js";
import EnginePanel from "./EnginePanel.jsx";
import { FactoryPanel, sendBriefToFactory } from "./factory.jsx";
import { DnaView } from "./dna/DnaView.jsx";
import { DnaWorker } from "./dna/dnaWorker.js";
import { estimateCost } from "@cc/ai";

// ════════════════════════════════════════════════════════════════════════════
// ZERO TO SECURE — Creator outreach + Shorts production command center.
// Built on the Clarify architecture (agent engine, premium design, pipeline
// mechanics) but native to ZTS: YouTube creators instead of local businesses,
// and a Shorts production Studio as a co-equal pillar.
// ════════════════════════════════════════════════════════════════════════════

// ─── Config ──────────────────────────────────────────────────────────────────
// SUPABASE_URL/ANON_KEY used to be declared here but were never actually used
// anywhere in this file — supabaseClient.js now owns that (same platform
// pattern as Board Room and Clarify Outreach).
// localhost ONLY. Read unconditionally, this baked the key into the public
// bundle the moment VITE_ANTHROPIC_API_KEY was ever set in Netlify — deployed
// traffic rides /.netlify/functions/claude and never needs it. Matches the
// guard Clarify already had (apps/clarify/src/config.js).
// BUILD-TIME gate, not a runtime one. `import.meta.env.DEV` is statically
// replaced by Vite with the literal `false` in a production build, so the
// whole ternary folds to "" and the key is NEVER EMITTED into dist.
//
// A `window.location.hostname === "localhost"` check does NOT do this: the
// minifier cannot evaluate it, so it keeps both branches and the key survives
// as a string literal in the shipped JS — readable by anyone who opens
// devtools, even though the code would never USE it off localhost. Verified
// by building with a canary value and grepping dist.
const IS_LOCAL = typeof window !== "undefined" && window.location.hostname === "localhost";
const ANTHROPIC_API_KEY = import.meta.env.DEV ? (import.meta.env.VITE_ANTHROPIC_API_KEY || "") : "";


// ─── Persistence helpers (localStorage-backed stores) ────────────────────────
const sm = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(`zts_${k}`)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(`zts_${k}`, JSON.stringify(v)); } catch {} },
  del: (k) => { try { localStorage.removeItem(`zts_${k}`); } catch {} },
  keys: (prefix) => { const out = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(`zts_${prefix}`)) out.push(k.replace(`zts_${prefix}`, "")); } return out; },
};

// Observability log (mirrors Clarify's Ops)
const obs = {
  getAll: () => sm.get("obs_log") || [],
  log: (entry) => { const e = { id: `${Date.now()}_${Math.random().toString(36).slice(2,6)}`, ts: new Date().toISOString(), ...entry }; sm.set("obs_log", [e, ...(sm.get("obs_log") || [])].slice(0, 500)); },
  clear: () => sm.set("obs_log", []),
};

// ─── Claude call (shared) ────────────────────────────────────────────────────
async function callClaude({ system, messages, model = "claude-haiku-4-5-20251001", maxTokens = 1024, fn = "generate" }) {
  const t0 = Date.now();
  try {
    const isDeployed = window.location.hostname !== "localhost";
    const url = isDeployed ? "/.netlify/functions/claude" : "https://api.anthropic.com/v1/messages";
    let bearer = null;
    if (isDeployed) { try { bearer = (await supabase?.auth.getSession())?.data?.session?.access_token || null; } catch {} }
    const headers = isDeployed
      ? { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }
      : { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
    const body = { model, max_tokens: maxTokens, messages };
    if (system) body.system = system;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const data = await res.json();
    const text = data.content?.map(b => b.type === "text" ? b.text : "").join("") || "";
    const inTok = data.usage?.input_tokens || Math.round(JSON.stringify(messages).length / 4);
    const outTok = data.usage?.output_tokens || Math.round(text.length / 4);
    obs.log({ fn, model, inputTokens: inTok, outputTokens: outTok, costEstimate: estimateCost(model, inTok, outTok), latencyMs: Date.now() - t0, ok: !!text });
    return text;
  } catch (e) {
    obs.log({ fn, model, ok: false, latencyMs: Date.now() - t0 });
    return null;
  }
}

// ─── ZTS domain: creator-fit value model ─────────────────────────────────────
// Unlike Clarify's monthly retainer, a creator's value to ZTS is audience reach
// weighted by how relevant their niche is to Bitcoin self-custody and how engaged
// their audience is. A 50k-sub Bitcoin-privacy channel beats a 500k general-tech one.
const NICHE_FIT = [
  { match: ["self custody","self-custody","hardware wallet","seed phrase","cold storage","privacy"], weight: 1.0, label: "Self-Custody" },
  { match: ["bitcoin","btc","satoshi","lightning"], weight: 0.9, label: "Bitcoin" },
  { match: ["crypto","cryptocurrency","altcoin","ethereum","defi"], weight: 0.6, label: "Crypto" },
  { match: ["finance","investing","money","wealth"], weight: 0.4, label: "Finance" },
  { match: ["tech","security","cybersecurity","privacy tech"], weight: 0.5, label: "Tech/Security" },
];
function nicheFit(creator) {
  const text = `${creator.channel_name || ""} ${creator.niche || ""} ${creator.description || ""}`.toLowerCase();
  const hit = NICHE_FIT.find(n => n.match.some(m => text.includes(m)));
  return hit || { weight: 0.25, label: "General" };
}
function creatorValue(creator) {
  const subs = creator.subscriber_count || 0;
  const fit = nicheFit(creator);
  const engagement = creator.engagement_rate != null ? creator.engagement_rate : 0.04; // default 4%
  // Reach-value: effective engaged audience in the right niche.
  const score = Math.round(subs * fit.weight * Math.min(engagement / 0.04, 2.5));
  return { score, fitLabel: fit.label, fitWeight: fit.weight, tier: score >= 40000 ? "Prime" : score >= 12000 ? "Strong" : score >= 3000 ? "Fit" : "Light" };
}
function fmtSubs(n) {
  if (!n) return "0";
  if (n >= 1e6) return `${(n/1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n/1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
}
// ─── Premium design system (inherited from Clarify's redesign) ───────────────
// ON THE SHARED KIT. ZTS has no .css file — this template string IS its
// stylesheet, so the migration happens here rather than in a sheet. What is left
// below is only what packages/ui/components.css does NOT own: the page canvas,
// the scrollbars, the selection colour, ZTS's own keyframe names (referenced by
// name from a dozen inline `animation:` values), and the iOS input rule.
//
// The webfont <link> is GONE. It pulled Syne + DM Mono + Inter off Google's CDN
// on every mount; the language allows the system stack and nothing else, and
// theme.js's `syne`/`mono` consts now resolve --font-display / --font-mono.
//
// The `.zts-card-hover` lift is gone too: it added a 1px ring in a box-shadow to
// an element that already drew a 1px border, which is the border-and-shadow pair
// the language forbids. Cards that respond to a tap are `.card.pressable` now,
// which is the kit's own press physics.
function useGlobalStyles() {
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `
      *, *::before, *::after { box-sizing: border-box; }
      * { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }
      html, body { margin: 0; font-family: var(--font-body, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif); }
      body { background-color: var(--shell-canvas, #0B0F1A); background-image: radial-gradient(1200px 600px at 12% -8%, rgba(62,207,142,0.06), transparent 60%), radial-gradient(1000px 700px at 100% 0%, rgba(110,168,254,0.05), transparent 55%); background-attachment: fixed; }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 10px; border: 2px solid transparent; background-clip: padding-box; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); background-clip: padding-box; }
      textarea, input, select, button { font-family: var(--font-body, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif); }
      ::selection { background: rgba(62,207,142,0.28); color: #F7F9FC; }
      button, a, [role="button"], input, select, textarea { transition: background-color 0.16s ease, border-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease, transform 0.12s ease, opacity 0.16s ease; }
      button:not(:disabled):active { transform: translateY(0.5px); }
      button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(62,207,142,0.34); }
      input::placeholder, textarea::placeholder { color: #5A6780; }
      /* pulse, fadein, spin and shimmer are the KIT's (packages/ui/components.css)
         and are referenced, never redefined here. Keyframe names are
         document-global — no attribute, class or scope can contain them — and
         this sheet is appended to document.head and never removed, so it lands
         after the shell's kit import and wins for every tool on screen, not just
         ZTS. The shimmer copy was the sharpest edge: it was a background-position
         sweep, and it silently froze the kit's transform-driven .sk::after
         skeleton loader everywhere.

         The line that used to sit here — "Only ZTS-owned names live below" — was
         false when it was written. toastIn, toastOut, toastShrink and
         paletteIn belong to @cc/ui (packages/ui/index.jsx injects them at
         import time and Toast/CommandPalette consume them), and this sheet
         redefined all four with a translateX(18px) throw against the kit's
         translateY(-8px). ZTS is lazy() mounted inside a shell whose
         ToastProvider wraps everything, so the copies landed last and stayed:
         once ZTS had been opened, EVERY tool's toasts slid in from the right for
         the life of the page. Nothing in ZTS referenced any of the four — the
         only consumers were the kit's own — so they are simply gone, and the
         kit's motion is what ZTS gets. cardIn was byte-identical to Clarify's
         and is promoted to packages/ui/components.css; ZTS's call sites still
         say cardIn and are unchanged. slideup stays: it is ZTS's own, no
         package defines it, and this app's sheets are its only definition.
         See DESIGN.md §6, and packages/ui/__tests__/keyframes.test.js, which now
         derives the owned set from every sheet the packages ship rather than
         from components.css alone — which is why the four were invisible to it. */
      @keyframes slideup { from { opacity: 0; transform: translateY(28px); } to { opacity: 1; transform: none; } }
      html { overflow-x: hidden; }
      body { overflow-x: hidden; }
      /* A tappable card lifts on hover. Elevation ONLY: no transform, so it
         cannot fight the kit's :active press or survive prefers-reduced-motion,
         and no ring, so the element never carries a border and a shadow at once.
         Scoped to .zts-card and not to .card: this sheet is injected into the
         document head and never removed, and every other tool's root carries
         data-kit too — a bare "[data-kit] .card" rule here would follow the user
         into Ideas and Business the moment they left ZTS.

         NO BACKTICKS IN THIS COMMENT. It lives inside a template literal, so a
         backtick ENDS the string and everything after it is parsed as
         JavaScript. This comment once quoted that selector in backticks, which
         closed the template and left the selector to evaluate as the subtraction
         "data minus kit" — throwing "data is not defined" the instant the effect
         ran, and taking the whole tool down behind the shell's error boundary.

         Why nothing caught it: the result is still SYNTACTICALLY VALID, so the
         build stayed green, and the expression lives inside a useEffect, which
         renderToStaticMarkup never executes — so all 1,695 tests stayed green
         too. Only a real browser reaches it. That is what smoke.mjs is for. */
      @media (hover: hover) and (pointer: fine) {
        [data-kit] .zts-card.pressable:hover { box-shadow: 0 6px 16px rgba(0,0,0,0.45), 0 16px 40px rgba(0,0,0,0.35); }
      }
      @media (max-width: ${MOBILE_BP}px) {
        input, select, textarea { font-size: 16px !important; }
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
      }
    `;
    document.head.appendChild(style);
  }, []);
}

// ZTS palette (T), display/mono fonts, and motion (M) now live in ./theme.js —
// the shared midnight canvas + emerald accent, derived from @cc/design.

// THE KIT'S CARD, not a local one. This drew a 1px border AND a drop shadow —
// the pair the language forbids; .card separates by tone and shadow with no
// outline. `hover` (and any onClick) now maps to .card.pressable, which is the
// kit's press physics rather than a bespoke transform.
const Card = ({ children, style, onClick, hover }) => (
  <div onClick={onClick} className={`card zts-card pad-md${onClick || hover ? " pressable" : ""}`}
    style={{ minWidth: 0, ...style }}>{children}</div>
);
// THE KIT'S .t-label. This was 11px, weight 700, tracked 0.13em and uppercase in
// a decorative face — under the 10.5px floor is the least of it: it was
// hand-doing exactly what .t-label does at 12px. Uppercase now exists in this
// app in one class only, which is the rule.
const Label = ({ children, style }) => <div className="t-label" style={style}>{children}</div>;
// THE KIT'S .btn. Was 12px text in a 10/18 padded box — a 38px target with a
// gradient fill and a 1px line. .btn.md is the 44px one-thumb target, and
// .primary / .quiet carry the fill, the radius, the disabled opacity and the
// press physics.
const Btn = ({ children, onClick, primary, disabled, style }) => (
  <button type="button" onClick={onClick} disabled={disabled}
    className={`btn md ${primary ? "primary" : "quiet"}`} style={style}>{children}</button>
);

// ─── Mobile retrofit — shared responsive helpers (desktop paths untouched) ───
// Single breakpoint: phones only (largest phones ~430px, smallest tablets
// ~768px — 680 sits in the gap so tablets/desktop windows are never caught).
const MOBILE_BP = 680;
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" ? window.innerWidth <= MOBILE_BP : false);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= MOBILE_BP);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile;
}
const viewPad = (isMobile) => (isMobile ? "16px 16px 26px" : "24px 28px");
// Kanban boards: unchanged grid on desktop; a horizontal scroll-snap rail on
// mobile so every stage stays reachable with a swipe instead of collapsing.
const kanbanWrapStyle = (isMobile, cols) => isMobile
  ? { display: "flex", gap: "10px", overflowX: "auto", WebkitOverflowScrolling: "touch", scrollSnapType: "x proximity", paddingBottom: "6px" }
  : { display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: "12px", alignItems: "start" };
const kanbanColStyle = (isMobile) => isMobile ? { minWidth: "80vw", maxWidth: "80vw", flexShrink: 0, scrollSnapAlign: "start" } : undefined;

// Shared modal chrome: centered card on desktop (unchanged), bottom sheet on
// mobile so it feels native instead of a floating box on a big screen.
// The scrim is the kit's .sheet-scrim (fixed inset-0, --scrim, z-300, fade-in);
// the flex centring stays inline because this shell centres on desktop and
// bottom-anchors on phone off ZTS's OWN 680px breakpoint. The panel is NOT the
// kit's .sheet: .sheet flips to a centred modal at 761px, and ZTS decides
// "mobile" at 680, so between those two widths the two would disagree about
// where the panel lives. The grabber IS the kit's .sheet-grab.
function ModalShell({ onClose, isMobile, width = 560, children }) {
  return (
    <div onClick={onClose} className="sheet-scrim" style={{ display: "flex", alignItems: isMobile ? "flex-end" : "center", justifyContent: "center", animation: `${isMobile ? "slideup" : "fadein"} 0.18s ease both` }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "var(--surface)", borderRadius: isMobile ? "20px 20px 0 0" : "18px", width: isMobile ? "100%" : `${width}px`, maxWidth: isMobile ? "100%" : "94vw", maxHeight: isMobile ? "90vh" : "88vh", display: "flex", flexDirection: "column", boxShadow: "var(--shadow-deep, 0 32px 80px rgba(11,17,32,0.24))", overflow: "hidden" }}>
        {isMobile && <div className="sheet-grab" style={{ flexShrink: 0 }} />}
        {children}
      </div>
    </div>
  );
}

// ─── The tabs, and their ONE set of labels ──────────────────────────────────
//
// The id is what the code switches on; the label is what a human reads, and the
// two are not the same string. They used to be: the desktop segment and the
// phone dock both rendered the raw id under `text-transform: capitalize`, which
// is a STYLE and cannot know that SEO and DNA are acronyms — it shipped "Seo"
// and "Dna" on both bars. The ⌘K palette had a private map with them right, so
// the same tab was spelled two ways in one app depending on which control you
// were looking at.
//
// One map, three consumers (segment, dock, palette), and the capitalize is
// gone. An acronym belongs in the label's TEXT; §4.3 reserves uppercase-as-style
// for `.t-label` and this is not that.
export const TABS = ["mission", "creators", "studio", "seo", "dna"];
export const TAB_LABELS = { mission: "Mission", creators: "Creators", studio: "Studio", seo: "SEO", dna: "DNA" };
/** Never returns undefined: an id with no entry reads as itself rather than blank. */
export const tabLabel = (t) => TAB_LABELS[t] || t;

// Bottom-nav icon set — plain geometry only (circles/lines/polygons), no
// icon library dependency, matches the app's existing minimal glyph style.
const TAB_ICONS = {
  mission: (c) => <><polyline points="4,11 12,4.5 20,11" /><path d="M6 10 V19.5 H18 V10" /></>,
  creators: (c) => <><circle cx="8.6" cy="7.8" r="2.5" /><polygon points="8.6,11.3 4.2,19 13,19" /><circle cx="16.6" cy="9.4" r="2.1" /><polygon points="16.6,12.4 13.3,19 19.9,19" /></>,
  studio: (c) => <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><polygon points="10,9.3 10,14.7 15,12" fill={c} stroke="none" /></>,
  seo: (c) => <><circle cx="10.3" cy="10.3" r="6" /><line x1="14.7" y1="14.7" x2="20" y2="20" /></>,
  dna: (c) => <><circle cx="5.5" cy="8" r="2" /><circle cx="18.5" cy="6.5" r="2" /><circle cx="7.5" cy="18" r="2" /><circle cx="17" cy="17.5" r="2" /><line x1="7.4" y1="8.9" x2="16.6" y2="7.4" /><line x1="6.4" y1="9.8" x2="8.6" y2="16.2" /><line x1="9.4" y1="17.8" x2="15.1" y2="17.6" /></>,
  agents: (c) => <><circle cx="12" cy="5.5" r="2" /><circle cx="5.8" cy="17" r="2" /><circle cx="18.2" cy="17" r="2" /><line x1="12" y1="7.5" x2="7.2" y2="15.3" /><line x1="12" y1="7.5" x2="16.8" y2="15.3" /></>,
  ops: (c) => <polyline points="3,13 7,13 9,19 13,6 15,13 21,13" />,
};
const TabIcon = ({ tab, color, size = 21 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {TAB_ICONS[tab] ? TAB_ICONS[tab](color) : null}
  </svg>
);
// Fixed bottom tab bar — replaces the top segmented control on mobile only.
// EXPORTED for apps/zts/src/__tests__/render.test.jsx. It only ever renders
// under `isMobile`, which is derived from window state the cold render never
// reaches, so the test could not get at it through <App/> — and while it could
// not, a free-variable ReferenceError in the entire phone navigation bar was
// invisible to the suite. No prop, key or call site changed to export it.
export function BottomNav({ view, setView, tabs }) {
  return (
    // CANONICAL BOTTOM-BAR GEOMETRY — all four tools must match exactly, or the
    // bar visibly changes height as you switch tools (measured on an iPhone
    // before this was unified: ZTS 84, Clarify 82, Runway 92, Macro 94px, from
    // three different bottom-padding formulas and two icon sizes).
    //   bar:  padding 4px 6px max(10px, calc(6px + var(--safe-bottom, 0px)))
    //   item: min-height 46, padding 8px 2px 7px, gap 3, icon 21, label 10.5px
    //
    // The label line reads 10.5px because that is what every bar RENDERS. It
    // said 9px until 2026-07-31 and the code below said 10.5, which made the
    // canonical block a liar about the one measurement it existed to pin — and
    // 9px would violate the hard 10.5px type floor (DESIGN.md §4.3), so the
    // code was right and the comment was wrong. Corrected here, not there.
    //
    // TWO corrections to the ORIGINAL bar, both made in Macro and Looper first
    // and then in all four bars together, so they still match each other:
    //   · the label is 10.5px sentence case, not 9px UPPERCASE — 9px was under
    //     the hard floor, and it was a second uppercase micro-style competing
    //     with .t-label. 10.5px is the kit's own .dock-label size for this job,
    //     which is why the canonical line above now reads 10.5.
    //   · the drop shadow is gone. The bar already separates with a hairline,
    //     and a border plus a shadow on one element is not allowed.
    // The bar keeps its own geometry rather than the kit's .dock, because .dock
    // pads with env(safe-area-inset-bottom) and this bar's safe-area formula is
    // the canonical one above, shared with three other tools.
    <nav className="dock app-dock" aria-label="ZTS sections">
      {tabs.map(t => {
        const active = view === t;
        const color = active ? "var(--accent)" : "var(--faint)";
        return (
          // The kit's .dock-tab / .dock-icon / .dock-label — the same three
          // classes Clarify's bar takes, which is what "must match exactly"
          // means now that a kit exists. The inline padding STAYS and wins the
          // cascade: .dock-tab adds env(safe-area-inset-bottom) of its own and
          // the wrapper above already pays that inset, so taking the kit's
          // padding would double it. .dock-tab also buys the press grammar —
          // the tab does not scale, the icon nudges.
          <button key={t} type="button" onClick={() => setView(t)} aria-current={active ? "page" : undefined} className={active ? "dock-tab active" : "dock-tab"}>
            <span className="dock-icon"><TabIcon tab={t} color={color} /></span>
            {/* .dock-label IS 10.5px / 600 / 0.01em — the canonical numbers, now
                read off the kit rather than restated here. Only what is ZTS's
                own is left inline: the tab hue, the active weight, sentence
                case and the display family.
                It also pins line-height: 1, which the canonical block never
                listed and nothing here set, so this label's line box was
                10.5 × `normal` ≈ 12.6px and the bar stood ~2px taller than
                Clarify's — the one tool that had already taken .dock-label.
                Reading the size off the kit closes that gap too. Macro's and
                Runway's labels still inherit a 1.5 body line-height and run
                ~5px taller again; that is theirs to fix, not this file's. */}
            <span className="dock-label" style={{ fontWeight: active ? 700 : 600, color, fontFamily: syne }}>{tabLabel(t)}</span>
          </button>
        );
      })}
    </nav>
  );
}
// ════════════════════════════════════════════════════════════════════════════
// STUDIO — Shorts production. Each Short moves: idea → script → assets → ready →
// posted. Claude generates the assets live; the three Short types frame the angle.
// ════════════════════════════════════════════════════════════════════════════

const SHORT_TYPES = {
  angle: {
    label: "ZTS Angle",
    desc: "Repeatable self-custody truths — 'not your keys', exchange risk, sovereignty.",
    systemHint: "Draw on the ZTS angle library: 'not your keys, not your coins', exchange collapses (FTX, Mt. Gox, Celsius), the case for cold storage, sovereignty and self-reliance. Punchy, conviction-driven, slightly contrarian.",
  },
  news: {
    label: "Newsjack",
    desc: "React to a current crypto event — hack, collapse, regulation, price move.",
    systemHint: "React to a specific current event the user provides. Open with the news hook, pivot fast to the self-custody lesson. Timely and urgent without being alarmist.",
  },
  educational: {
    label: "Educational",
    desc: "Explain how self-custody works — seed phrases, backups, threat models.",
    systemHint: "Teach one concrete self-custody concept clearly and simply (seed phrase backup, metal vs paper, passphrase, inheritance planning). Calm, credible, beginner-friendly.",
  },
};

const ZTS_BRAND = `Zero To Secure (ZTS) sells a premium stainless-steel seed phrase backup kit for Bitcoin self-custody. Brand voice: confident, sovereign, no-nonsense, security-first, respects the viewer's intelligence. Core belief: people locked out of traditional systems deserve real control over their own money. Never fear-monger cheaply; lead with empowerment. Audience: Bitcoin holders who are serious about not losing their coins to exchange failure, hacks, or their own mistakes.`;

// Generate a full Shorts asset package in one structured call.
async function generateShort({ type, topic, creatorContext, model = "claude-haiku-4-5-20251001" }) {
  const t = SHORT_TYPES[type] || SHORT_TYPES.angle;
  const system = `You are the head of short-form content for Zero To Secure. ${ZTS_BRAND}

You are writing a YouTube Short (under 60 seconds, ~140-160 words of spoken script). ${t.systemHint}

Respond ONLY with valid JSON, no preamble or markdown fences:
{
  "hook": "the first 3 seconds — a scroll-stopping spoken line",
  "script": "the full spoken script, ~140-160 words, punchy short sentences, written to be read aloud, with natural pauses",
  "thumbnail_concepts": [
    { "visual": "what's on screen", "text_overlay": "3-5 words max, bold" },
    { "visual": "alternate concept", "text_overlay": "3-5 words max" }
  ],
  "title": "YouTube title, under 60 chars, high-CTR, no clickbait lies",
  "description": "2-3 line description with a soft CTA to ZTS",
  "tags": ["8-12 relevant tags"],
  "pinned_comment": "a comment to pin that drives engagement or the ZTS link"
}`;
  const userMsg = `Short type: ${t.label}\nTopic / angle: ${topic || "(choose a strong one for this type)"}${creatorContext ? `\nThis Short is for a collab with: ${creatorContext}` : ""}`;
  const raw = await callClaude({ system, messages: [{ role: "user", content: userMsg }], model, maxTokens: 1400, fn: "generate_short" });
  if (!raw) return null;
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return null; }
}

// Regenerate a single asset (when the user wants just a new title, or new thumbnails).
async function regenAsset({ asset, short, type, model = "claude-haiku-4-5-20251001" }) {
  const t = SHORT_TYPES[type] || SHORT_TYPES.angle;
  const assetSpec = {
    title: 'Respond ONLY with JSON: {"title": "..."} — a fresh high-CTR title under 60 chars.',
    thumbnail_concepts: 'Respond ONLY with JSON: {"thumbnail_concepts": [{"visual":"...","text_overlay":"..."},{"visual":"...","text_overlay":"..."}]}',
    hook: 'Respond ONLY with JSON: {"hook": "..."} — a new scroll-stopping opening line.',
    description: 'Respond ONLY with JSON: {"description":"...","tags":["..."]}',
  }[asset];
  const system = `You are the head of short-form content for Zero To Secure. ${ZTS_BRAND} ${t.systemHint} ${assetSpec}`;
  const userMsg = `Existing script:\n${short.script || short.topic || ""}\n\nGive a fresh ${asset.replace("_", " ")}.`;
  const raw = await callClaude({ system, messages: [{ role: "user", content: userMsg }], model, maxTokens: 600, fn: "regen_asset" });
  if (!raw) return null;
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return null; }
}

const SHORT_STAGES = [
  { key: "idea", label: "Idea", color: "#8A97A8" },
  { key: "script", label: "Script", color: "#B68A2E" },
  { key: "assets", label: "Assets", color: "#3B82F6" },
  { key: "ready", label: "Ready", color: "#0E9F6E" },
  { key: "posted", label: "Posted", color: "#7C3AED" },
];

// ─── Stage stepping — one helper for every pipeline in the app ────────────────
// Returns the stage one step forward/back, or null at the ends. Every kanban
// (creators, shorts, articles) moves through its stages with the same ‹ ›
// controls, in both directions.
function stepStage(stages, current, dir) {
  const order = stages.map(s => s.key);
  const i = order.indexOf(current);
  if (i === -1) return dir > 0 ? order[0] : null;
  const next = i + dir;
  if (next < 0 || next >= order.length) return null;
  return order[next];
}

// Compact ‹ › stepper rendered on kanban cards. stopPropagation so steppers
// never fight the card's own onClick (open detail).
function StageStepper({ stages, current, onMove, blockForward = false, blockBack = false, forwardTitle }) {
  const back = blockBack ? null : stepStage(stages, current, -1);
  const fwd = blockForward ? null : stepStage(stages, current, +1);
  const fwdLabel = fwd ? stages.find(s => s.key === fwd)?.label : null;
  // The kit's .btn.sm — 34px and 13px type, where these were 10px inside a 26px
  // box. The disabled state is .btn:disabled's opacity, not a second colour.
  return (
    <div style={{ display: "flex", gap: "5px", marginTop: "8px" }} onClick={e => e.stopPropagation()}>
      <button type="button" className="btn sm quiet" title={back ? `Back to ${stages.find(s => s.key === back)?.label}` : "Already at the first stage"}
        disabled={!back} onClick={() => back && onMove(back)} style={{ paddingLeft: 11, paddingRight: 11 }}>‹</button>
      <button type="button" className="btn sm quiet" title={fwd ? `Move to ${fwdLabel}` : forwardTitle || "Already at the last stage"}
        disabled={!fwd} onClick={() => fwd && onMove(fwd)} style={{ flex: 1, minWidth: 0 }}>
        {fwd ? `${fwdLabel} ›` : stages[stages.length - 1].key === current ? "✓" : "—"}
      </button>
    </div>
  );
}

// The publish checklist — every Short runs the same pre-flight before going live.
const PUBLISH_CHECKLIST = [
  "Script recorded & edited",
  "Thumbnail designed (1080×1920)",
  "Title finalized (under 60 chars)",
  "Description + ZTS link added",
  "Tags added",
  "Pinned comment ready",
  "Captions / subtitles on",
  "Scheduled or posted",
];
// ════════════════════════════════════════════════════════════════════════════
// AGENT ENGINE — same two-speed design as Clarify: free heuristic heartbeat,
// rare gated synthesis. ZTS-native watchers cover BOTH pillars (creators + studio).
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// SEO — article pipeline with an approval gate. The agent drafts on a cadence
// (or on demand); nothing publishes without passing your review. Phase 1 uses a
// manual keyword panel (paste from Search Console); Phase 2 wires GSC OAuth.
// ════════════════════════════════════════════════════════════════════════════
const ARTICLE_STAGES = [
  { key: "idea", label: "Idea", color: "#8A97A8" },
  { key: "review", label: "In Review", color: "#F59E0B" },
  { key: "approved", label: "Approved", color: "#3B82F6" },
  { key: "published", label: "Published", color: "#0E9F6E" },
];

// ZTS's natural topic clusters — the agent seeds article ideas from these when
// no keyword is supplied. These are the queries ZTS buyers actually search.
const SEO_TOPIC_CLUSTERS = [
  "metal seed phrase backup vs paper",
  "how to back up a seed phrase safely",
  "what happens to your bitcoin if an exchange collapses",
  "hardware wallet backup best practices",
  "bitcoin inheritance planning self custody",
  "seed phrase storage mistakes that lose bitcoin",
  "stainless steel crypto backup comparison",
  "not your keys not your coins explained",
];

async function generateArticle({ keyword, notes, model = "claude-haiku-4-5-20251001" }) {
  const system = `You are the SEO content lead for Zero To Secure. ${ZTS_BRAND}

Write a search-optimized blog article. Rules: genuinely useful first, optimized second — no keyword stuffing. Write for a smart beginner-to-intermediate Bitcoin holder. Use the target keyword naturally in the title, first paragraph, and 1-2 H2s. Weave in ZTS product relevance without being an ad. Suggest internal links to: /products (the ZTS kit), /pages/breach-index (exchange hack history), /pages/academy (self-custody lessons).

Respond ONLY with valid JSON, no preamble or markdown fences:
{
  "target_keyword": "the primary keyword",
  "search_intent": "informational | commercial | transactional",
  "title_tag": "under 60 chars, keyword near front",
  "meta_description": "under 155 chars, compelling, includes keyword",
  "slug": "url-slug-here",
  "outline": ["H2: ...", "H2: ...", "H3: ..."],
  "article_html": "the full article as clean HTML (h2/h3/p/ul/li/strong only), 1000-1400 words",
  "internal_links": [{ "anchor": "anchor text", "target": "/pages/breach-index" }],
  "word_count": 1200
}`;
  const userMsg = keyword
    ? `Target keyword: ${keyword}${notes ? `\nNotes/angle: ${notes}` : ""}`
    : `No keyword supplied — pick the strongest un-covered topic from ZTS's clusters: ${SEO_TOPIC_CLUSTERS.join("; ")}`;
  const raw = await callClaude({ system, messages: [{ role: "user", content: userMsg }], model, maxTokens: 4000, fn: "generate_article" });
  if (!raw) return null;
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return null; }
}

// Publish to the Shopify blog. Deployed → Netlify function (holds the Admin token);
// local → copies the HTML so you can paste into Shopify admin manually. Mirrors
// the sendEmail/createMeeting graceful-degradation pattern.
async function publishToShopify(article) {
  const isDeployed = window.location.hostname !== "localhost";
  if (isDeployed) {
    // The function now requires a session (it publishes a live, public article
    // with the store's admin token), so send the same bearer callClaude uses.
    let bearer = null;
    try { bearer = (await supabase?.auth.getSession())?.data?.session?.access_token || null; } catch {}
    const res = await fetch("/.netlify/functions/shopify-publish", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ title: article.title_tag, body_html: article.article_html, summary: article.meta_description, tags: article.target_keyword, handle: article.slug }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || "Shopify publish failed");
    return { method: "api", url: data.url || null };
  }
  try { await navigator.clipboard.writeText(article.article_html || ""); } catch {}
  return { method: "clipboard" };
}

const ENGINE_DEFAULTS = {
  running: false, observeOnly: true, cadenceSec: 20, synthEveryMin: 30,
  hourlyCostCap: 0.25, pauseWhenIdle: true, idleMin: 10, allowSonnet: false,
  seoAutoDraft: false, seoEveryDays: 4,
  agents: { creatorScout: true, production: true, cadence: true, reply: true, pattern: true, seoCadence: true, cost: true },
};
const eng = {
  get: () => ({ ...ENGINE_DEFAULTS, ...(sm.get("engine_ctrl") || {}), agents: { ...ENGINE_DEFAULTS.agents, ...((sm.get("engine_ctrl") || {}).agents || {}) } }),
  set: (patch) => sm.set("engine_ctrl", { ...eng.get(), ...patch }),
  setAgent: (key, on) => { const c = eng.get(); eng.set({ agents: { ...c.agents, [key]: on } }); },
};
const kb = {
  all: () => sm.get("agent_kb") || [],
  add: (entries) => { if (!entries || !entries.length) return 0; const ex = sm.get("agent_kb") || []; const stamped = entries.map(e => ({ id: `${Date.now()}_${Math.random().toString(36).slice(2,6)}`, ts: new Date().toISOString(), ...e })); sm.set("agent_kb", [...stamped, ...ex].slice(0, 400)); return stamped.length; },
  clear: () => sm.set("agent_kb", []),
  seenToday: (agent, key) => { const t = new Date().toISOString().slice(0,10); return (sm.get("agent_kb") || []).some(e => e.agent === agent && e.dedupKey === key && (e.ts||"").slice(0,10) === t); },
};
function markActivity() { sm.set("engine_last_activity", Date.now()); }
function isIdle(min) { const last = sm.get("engine_last_activity") || Date.now(); return (Date.now() - last) > min * 60000; }

// Heuristic watchers — pure JS, zero cost. Cover creators AND studio production.
const HEURISTIC_AGENTS = {
  creatorScout: { name: "Creator Scout", scan: (ctx) => {
    const out = [];
    const primeIdle = ctx.creators.filter(c => c.status === "prospected" && creatorValue(c).tier === "Prime");
    if (primeIdle.length > 0 && !kb.seenToday("creatorScout", "prime_idle")) {
      const top = primeIdle.sort((a,b) => creatorValue(b).score - creatorValue(a).score)[0];
      out.push({ agent: "creatorScout", type: "observation", signal: "warning", dedupKey: "prime_idle", text: `${primeIdle.length} Prime-fit creator${primeIdle.length!==1?"s":""} un-contacted. Top: ${top.channel_name} (${fmtSubs(top.subscriber_count)} subs, ${creatorValue(top).fitLabel}). These convert best for ZTS — reach out first.` });
    }
    return out;
  }},
  production: { name: "Production Watcher", scan: (ctx) => {
    const out = [];
    const stuck = ctx.shorts.filter(s => s.stage === "script" || s.stage === "assets");
    if (stuck.length >= 3 && !kb.seenToday("production", "wip_pileup")) out.push({ agent: "production", type: "observation", signal: "info", dedupKey: "wip_pileup", text: `${stuck.length} Shorts are mid-production (script/assets). Batching the finish step keeps your posting cadence alive.` });
    const ready = ctx.shorts.filter(s => s.stage === "ready").length;
    if (ready >= 2 && !kb.seenToday("production", "ready_queue")) out.push({ agent: "production", type: "observation", signal: "warning", dedupKey: "ready_queue", text: `${ready} Shorts are READY to post but not scheduled. Get them on the calendar — published beats perfect.` });
    return out;
  }},
  cadence: { name: "Cadence Monitor", scan: (ctx) => {
    const out = [];
    const posted = ctx.shorts.filter(s => s.stage === "posted" && s.posted_at);
    if (posted.length > 0) {
      const last = posted.sort((a,b) => new Date(b.posted_at) - new Date(a.posted_at))[0];
      const days = Math.floor((Date.now() - new Date(last.posted_at).getTime()) / 86400000);
      if (days >= 3 && !kb.seenToday("cadence", "posting_gap")) out.push({ agent: "cadence", type: "observation", signal: "warning", dedupKey: "posting_gap", text: `${days} days since your last Short went live. The algorithm rewards consistency — ship one today.` });
    }
    return out;
  }},
  reply: { name: "Reply Sentinel", scan: (ctx) => {
    const out = [];
    const replies = ctx.creators.filter(c => c.status === "replied");
    if (replies.length > 0 && !kb.seenToday("reply", "creator_replies")) out.push({ agent: "reply", type: "observation", signal: "critical", dedupKey: "creator_replies", text: `${replies.length} creator repl${replies.length!==1?"ies":"y"} waiting. Warm collab interest goes cold fast — respond before anything else.` });
    return out;
  }},
  pattern: { name: "Pattern Learner", scan: (ctx) => {
    const out = [];
    const posted = ctx.shorts.filter(s => s.stage === "posted");
    if (posted.length < 4) return out;
    const byType = {};
    posted.forEach(s => { const t = s.type || "angle"; if (!byType[t]) byType[t] = 0; byType[t]++; });
    const top = Object.entries(byType).sort((a,b) => b[1]-a[1])[0];
    if (top && !kb.seenToday("pattern", "type_mix")) out.push({ agent: "pattern", type: "learning", signal: "info", dedupKey: "type_mix", text: `Learning: ${SHORT_TYPES[top[0]]?.label || top[0]} is your most-produced Short type (${top[1]} posted). Watch which type actually drives ZTS clicks and lean in.` });
    return out;
  }},
  seoCadence: { name: "SEO Cadence", scan: (ctx) => {
    const out = [];
    const inReview = ctx.articles.filter(a => a.stage === "review").length;
    if (inReview >= 2 && !kb.seenToday("seoCadence", "review_backlog")) out.push({ agent: "seoCadence", type: "observation", signal: "warning", dedupKey: "review_backlog", text: `${inReview} articles are waiting in your SEO review queue. Approve or reject them so the cadence keeps moving.` });
    const published = ctx.articles.filter(a => a.stage === "published" && a.published_at);
    if (published.length > 0) {
      const last = published.sort((a,b) => new Date(b.published_at) - new Date(a.published_at))[0];
      const days = Math.floor((Date.now() - new Date(last.published_at).getTime()) / 86400000);
      if (days >= 7 && !kb.seenToday("seoCadence", "publish_gap")) out.push({ agent: "seoCadence", type: "observation", signal: "info", dedupKey: "publish_gap", text: `${days} days since your last article published. Steady cadence compounds — check the review queue.` });
    }
    return out;
  }},
  cost: { name: "Cost Sentinel", scan: (ctx) => {
    const out = [];
    const hourAgo = Date.now() - 3600000;
    const spend = ctx.obsLogs.filter(l => new Date(l.ts).getTime() > hourAgo).reduce((s,l) => s + (l.costEstimate||0), 0);
    if (spend > 0.5 && !kb.seenToday("cost", "spend")) out.push({ agent: "cost", type: "observation", signal: "warning", dedupKey: "spend", text: `AI spend hit $${spend.toFixed(2)} this hour. Generation runs on Haiku-first to keep this low.` });
    return out;
  }},
};

const AGENT_META = [
  { key: "creatorScout", name: "Creator Scout", role: "Outreach prioritization", watches: "Prime-fit creators (high subs × niche relevance × engagement) sitting un-contacted. Surfaces the highest-value collab targets for ZTS first.", cost: "Free heuristic" },
  { key: "production", name: "Production Watcher", role: "Studio throughput", watches: "Shorts stuck mid-production and finished Shorts not yet scheduled. Keeps the content pipeline flowing so you actually ship.", cost: "Free heuristic" },
  { key: "cadence", name: "Cadence Monitor", role: "Posting consistency", watches: "Days since your last Short went live. Flags posting gaps because the algorithm rewards consistency.", cost: "Free heuristic" },
  { key: "reply", name: "Reply Sentinel", role: "Collab triage", watches: "Creator replies waiting on you. Raises a critical flag so warm collab interest never goes cold.", cost: "Free heuristic" },
  { key: "pattern", name: "Pattern Learner", role: "Content learning", watches: "Which Short types you produce most, building toward which ones actually drive ZTS conversions.", cost: "Free heuristic" },
  { key: "seoCadence", name: "SEO Cadence", role: "Content pipeline", watches: "The article review queue and days since last publish. When auto-draft is on, it also queues a new draft for your approval on your cadence.", cost: "Free heuristic (draft = 1 gated call)" },
  { key: "cost", name: "Cost Sentinel", role: "Spend guardrail", watches: "AI generation spend over the last hour. Keeps the engine honest on token cost.", cost: "Free heuristic" },
  { key: "synthesizer", name: "Synthesizer", role: "Insight distillation", watches: "Accumulated observations from every agent. Occasionally distills them into one highest-leverage move across creators + studio. The only agent that spends tokens.", cost: "Haiku · gated" },
];

function engineSpendThisHour() { const h = Date.now() - 3600000; return obs.getAll().filter(l => l.fn === "agent_synthesis" && new Date(l.ts).getTime() > h).reduce((s,l) => s + (l.costEstimate||0), 0); }
function stateHash(creators, shorts) { const sig = [...creators.map(c => `${c.id}:${c.status}`), ...shorts.map(s => `${s.id}:${s.stage}`)].sort().join("|"); let h = 0; for (let i=0;i<sig.length;i++){ h = ((h<<5)-h+sig.charCodeAt(i))|0; } return String(h); }

async function synthesizeInsight(recentObs, allowSonnet) {
  if (!recentObs || !recentObs.length) return null;
  const model = allowSonnet ? "claude-sonnet-4-6" : "claude-haiku-4-5-20251001";
  const bullets = recentObs.slice(0, 12).map(o => `- [${o.agent}] ${o.text}`).join("\n");
  const system = `You are the strategist for Zero To Secure, a Bitcoin self-custody brand running creator outreach AND a YouTube Shorts production pipeline. Your agents observed the following. In 1-2 sentences, name the single highest-leverage move right now across either pillar. Be specific and actionable. No preamble.`;
  const raw = await callClaude({ system, messages: [{ role: "user", content: bullets }], model, maxTokens: 200, fn: "agent_synthesis" });
  return raw;
}
// ─── STUDIO VIEW — the Shorts production pillar ──────────────────────────────
export function StudioView({ shorts, setShorts, isMobile, loading, openSignal = 0, onSignalConsumed }) {
  const [composing, setComposing] = useState(false);
  const [openShort, setOpenShort] = useState(null);
  const toast = useToast();

  // Palette handoff: "New Short" from ⌘K opens the composer, even if Studio
  // was already the active view. Consuming clears the signal in App so a
  // later remount doesn't re-open it.
  useEffect(() => { if (openSignal > 0) { setComposing(true); onSignalConsumed?.(); } }, [openSignal, onSignalConsumed]);

  const addShort = async (short) => {
    const fields = { stage: "script", ...short };
    if (!supabase) {
      const s = { id: `local_${Date.now()}`, created_at: new Date().toISOString(), ...fields };
      setShorts(prev => [s, ...prev]); setComposing(false); setOpenShort(s);
      return;
    }
    const { data, error: err } = await supabase.from("shorts").insert(fields).select();
    if (err) { console.warn("[StudioView] insert failed:", err.message); toast.push("Couldn't save the Short: " + err.message, { tone: "error" }); setComposing(false); return; }
    const s = data?.[0];
    if (s) { setShorts(prev => [s, ...prev]); setOpenShort(s); }
    setComposing(false);
  };
  const updateShort = async (id, patch) => {
    setShorts(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s)); // optimistic
    if (openShort?.id === id) setOpenShort(prev => ({ ...prev, ...patch }));
    if (!supabase) return;
    const { error: err } = await supabase.from("shorts").update(patch).eq("id", id);
    if (err) { console.warn("[StudioView] update failed:", err.message); toast.push("Change didn't save — " + err.message, { tone: "error" }); }
  };
  const delShort = async (id) => {
    setShorts(prev => prev.filter(s => s.id !== id)); // optimistic
    setOpenShort(null);
    if (!supabase) return;
    const { error: err } = await supabase.from("shorts").delete().eq("id", id);
    if (err) { console.warn("[StudioView] delete failed:", err.message); toast.push("Delete didn't stick — " + err.message, { tone: "error" }); }
  };

  const byStage = (k) => shorts.filter(s => s.stage === k);

  return (
    <div role="region" aria-label={TAB_LABELS.studio} style={{ minHeight: "calc(100vh - 52px)", padding: viewPad(isMobile) }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          {/* The title said "Studio" directly under a lit Studio pill. The line
              under it does NOT repeat the sub-nav — it says what this surface is
              for — so it stays and the title goes, rather than deleting the one
              sentence here that carries information. */}
          <p className="t-foot" style={{ margin: 0 }}>Generate Shorts and every asset — script, thumbnail, title, description — then ship.</p>
        </div>
        <Btn primary onClick={() => setComposing(true)}>✦ New Short</Btn>
      </div>

      {/* Stage board */}
      {loading ? (
        <SkeletonBoard cols={4} />
      ) : shorts.length === 0 ? (
        <EmptyState icon="film" title="No Shorts yet"
          sub="Spin up your first Short — pick a type, give a topic, and Claude drafts the whole package."
          action={<Btn primary onClick={() => setComposing(true)}>✦ Create your first Short</Btn>} />
      ) : (
        <div style={kanbanWrapStyle(isMobile, 5)}>
          {SHORT_STAGES.map(stage => {
            const items = byStage(stage.key);
            return (
              <div key={stage.key} style={kanbanColStyle(isMobile)}>
                <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "10px", padding: "0 2px" }}>
                  {/* The stage colour is a DOMAIN colour (SHORT_STAGES) — it stays
                      literal. It is never the only signal: the name is right next
                      to it, and the same colour rails the card's left edge. */}
                  <span className="dotstatus" style={{ background: stage.color }} />
                  <span className="t-label" style={{ color: "var(--ink)" }}>{stage.label}</span>
                  <span className="t-cap t-num" style={{ fontFamily: mono }}>{items.length}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {items.map((s, idx) => {
                    const t = SHORT_TYPES[s.type] || SHORT_TYPES.angle;
                    return (
                      <div key={s.id} style={{ animation: `cardIn 0.3s ${M.easeOut} both`, animationDelay: `${Math.min(idx, 8) * 30}ms` }}>
                      <Card hover onClick={() => setOpenShort(s)} style={{ padding: "12px 15px", boxShadow: `inset 3px 0 0 ${stage.color}, var(--shadow-card)` }}>
                        <span className="t-label" style={{ display: "inline-block", color: T.amberDeep, background: "rgba(245,158,11,0.1)", padding: "3px 7px", borderRadius: "5px", marginBottom: "6px" }}>{t.label}</span>
                        <div className="t-call" style={{ fontWeight: 600, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{s.title || s.topic || "Untitled"}</div>
                        {s.hook && <div className="t-cap" style={{ marginTop: "4px", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{s.hook}</div>}
                        <StageStepper stages={SHORT_STAGES} current={stage.key}
                          onMove={(next) => updateShort(s.id, { stage: next, ...(next === "posted" ? { posted_at: new Date().toISOString() } : stage.key === "posted" ? { posted_at: null } : {}) })} />
                      </Card>
                      </div>
                    );
                  })}
                  {items.length === 0 && <EmptyState compact icon="inbox" tint={T.faint} title="Nothing here" sub="Move one in with the › stepper on a card." />}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Factory — the production half of the Studio. shorts-factory (factory/
          in this repo) turns filmed footage into the finished 9:16 Short; this
          rail shows its live project state whenever the local bridge is up. */}
      <FactoryPanel isMobile={isMobile} />

      {composing && <ComposeModal isMobile={isMobile} onClose={() => setComposing(false)} onCreate={addShort} />}
      {openShort && <ShortDetail short={openShort} isMobile={isMobile} onClose={() => setOpenShort(null)} onUpdate={updateShort} onDelete={delShort} />}
    </div>
  );
}

// Compose: pick type + topic, generate the full package.
// EXPORTED for apps/zts/src/__tests__/render.test.jsx. It sits behind Studio's
// primary action, so it only mounts when `composing` state flips — state with
// no prop behind it, which a cold render cannot move. Same reason as the four
// view components above; nothing else in the app imports it.
export function ComposeModal({ onClose, onCreate, isMobile }) {
  const [type, setType] = useState("angle");
  const [topic, setTopic] = useState("");
  const [gen, setGen] = useState(false);
  const toast = useToast();

  const create = async () => {
    setGen(true);
    const pkg = await generateShort({ type, topic });
    setGen(false);
    if (pkg) { onCreate({ type, topic, stage: "assets", ...pkg }); toast.push("Short package drafted — hook, script, thumbnails, title, the lot.", { tone: "success" }); }
    else { onCreate({ type, topic, stage: "idea" }); toast.push("Generation didn't complete — the Short was saved as an idea. Open it to retry.", { tone: "warning" }); }
  };

  return (
    <ModalShell onClose={onClose} isMobile={isMobile} width={560}>
      <div style={{ padding: isMobile ? "14px 18px calc(18px + var(--safe-bottom))" : "26px 28px", overflowY: "auto" }}>
        <h2 className="t-head" style={{ margin: "0 0 4px" }}>New Short</h2>
        <p className="t-foot" style={{ margin: "0 0 20px" }}>Pick a type and topic — Claude drafts the hook, script, thumbnails, title, description, and tags.</p>

        <Label style={{ marginBottom: "8px" }}>Short type</Label>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: "8px", marginBottom: "18px" }}>
          {Object.entries(SHORT_TYPES).map(([k, t]) => (
            // The kit's .stattile — the left-aligned, column, well-toned tile
            // this was drawing by hand with a 1px outline and an 11px radius.
            // `.tappable` is the press physics; `.selected` is the kit's own
            // 1.5px inset accent ring, which replaces the hand-rolled accent
            // border (and is an inset SHADOW on a border:none surface, so the
            // selected tile is not carrying both — §4.2).
            // Selected still reads as selected without colour: a ✓ and a
            // heavier weight carry it, and the accent tint only reinforces.
            <button key={k} type="button" onClick={() => setType(k)} aria-pressed={type === k}
              className={`stattile tappable${type === k ? " selected" : ""}`}
              style={{ padding: "12px 13px", background: type === k ? "var(--accent-a10, rgba(14,159,110,0.07))" : undefined, cursor: "pointer" }}>
              <span className="t-cap" style={{ fontWeight: 700, color: type === k ? "var(--accent)" : "var(--ink)" }}>{type === k ? "✓ " : ""}{t.label}</span>
              <span className="t-cap" style={{ lineHeight: 1.4 }}>{t.desc}</span>
            </button>
          ))}
        </div>

        <Label style={{ marginBottom: "8px" }}>{type === "news" ? "What's the news / event?" : "Topic or angle (optional)"}</Label>
        <textarea className="field" value={topic} onChange={e => setTopic(e.target.value)} placeholder={type === "news" ? "e.g. another exchange just froze withdrawals…" : type === "educational" ? "e.g. why a metal backup beats paper" : "e.g. not your keys, not your coins — leave blank for Claude to pick"}
          style={{ minHeight: "70px", resize: "vertical" }} />

        <div style={{ display: "flex", gap: "8px", marginTop: "20px" }}>
          <Btn primary onClick={create} disabled={gen} style={{ flex: 1 }}>{gen ? "Generating the package…" : "✦ Generate Short"}</Btn>
          <Btn onClick={onClose}>Cancel</Btn>
        </div>
        <p className="t-cap" style={{ textAlign: "center", margin: "10px 0 0" }}>One Claude call drafts all assets. Runs on Haiku to stay cheap.</p>
      </div>
    </ModalShell>
  );
}
// Short detail — view/edit/regenerate every asset, run the publish checklist, advance stage.
export function ShortDetail({ short, onClose, onUpdate, onDelete, isMobile }) {
  const [regen, setRegen] = useState(null); // which asset is regenerating
  const [tab, setTab] = useState("assets");
  const toast = useToast();
  const t = SHORT_TYPES[short.type] || SHORT_TYPES.angle;
  const checklist = short.checklist || {};

  const doRegen = async (asset) => {
    setRegen(asset);
    const result = await regenAsset({ asset, short, type: short.type });
    setRegen(null);
    if (result) onUpdate(short.id, result);
    else toast.push("Regeneration failed — try again in a moment.", { tone: "error" });
  };
  const toggleCheck = (item) => { const next = { ...checklist, [item]: !checklist[item] }; onUpdate(short.id, { checklist: next }); };
  const moveStage = (dir) => {
    const next = stepStage(SHORT_STAGES, short.stage, dir);
    if (!next) return;
    onUpdate(short.id, { stage: next, ...(next === "posted" ? { posted_at: new Date().toISOString() } : short.stage === "posted" ? { posted_at: null } : {}) });
  };
  const [sendingBrief, setSendingBrief] = useState(false);
  const sendToFactory = async () => {
    setSendingBrief(true);
    await sendBriefToFactory(short, toast);
    setSendingBrief(false);
  };
  const copyAll = () => {
    const text = `TITLE: ${short.title || ""}\n\nHOOK: ${short.hook || ""}\n\nSCRIPT:\n${short.script || ""}\n\nDESCRIPTION:\n${short.description || ""}\n\nTAGS: ${(short.tags||[]).join(", ")}\n\nPINNED COMMENT: ${short.pinned_comment || ""}`;
    try { navigator.clipboard.writeText(text); toast.push("All assets copied — paste straight into YouTube Studio.", { tone: "success" }); }
    catch { toast.push("Couldn't reach the clipboard.", { tone: "error" }); }
  };

  const checkDone = PUBLISH_CHECKLIST.filter(i => checklist[i]).length;

  const AssetBlock = ({ title, asset, children }) => (
    <div style={{ marginBottom: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: "7px" }}>
        <Label>{title}</Label>
        {asset && <button type="button" className="btn sm plain" onClick={() => doRegen(asset)} disabled={regen === asset}>{regen === asset ? "↻ regenerating…" : "↻ regenerate"}</button>}
      </div>
      {children}
    </div>
  );
  // A read-only well, on the kit's well tone and radius. It used to carry a
  // hairline as well; the tone step does that job on its own.
  const box = { background: "var(--surface-2)", borderRadius: "var(--r-well, 12px)", padding: "12px 14px", fontSize: "13px", color: "var(--ink)", lineHeight: 1.6, whiteSpace: "pre-wrap" };

  const hPad = isMobile ? "18px" : "24px";
  return (
    <ModalShell onClose={onClose} isMobile={isMobile} width={640}>
        <div style={{ padding: `18px ${hPad}`, borderBottom: `1px solid ${T.line}`, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexShrink: 0 }}>
          <div style={{ minWidth: 0 }}>
            <span className="t-label" style={{ display: "inline-block", color: T.amberDeep, background: "rgba(245,158,11,0.1)", padding: "3px 8px", borderRadius: "5px", marginBottom: "6px" }}>{t.label} · {short.stage}</span>
            <h2 className="t-head" style={{ margin: 0, lineHeight: 1.3 }}>{short.title || short.topic || "Untitled Short"}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" style={{ fontSize: "20px", lineHeight: 1 }}>×</button>
        </div>

        {/* The kit's segmented control — two options, equal width. */}
        <div className="seg" role="tablist" style={{ margin: `12px ${hPad} 0`, flexShrink: 0 }}>
          {[["assets", "Assets"], ["publish", `Publish (${checkDone}/${PUBLISH_CHECKLIST.length})`]].map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={tab === k ? "seg-opt active" : "seg-opt"}>{l}</button>
          ))}
        </div>

        <div style={{ padding: `18px ${hPad}`, overflowY: "auto" }}>
          {tab === "assets" ? (
            <>
              {!short.script && short.stage === "idea" ? (
                <div style={{ textAlign: "center", padding: "30px 0" }}>
                  {/* An error gets a retry, and the retry says what it will do. */}
                  <p className="t-call" style={{ margin: "0 0 16px", color: "var(--sub)" }}>Generation didn't complete. Try again:</p>
                  <Btn primary disabled={regen === "all"} onClick={async () => { setRegen("all"); const pkg = await generateShort({ type: short.type, topic: short.topic }); setRegen(null); if (pkg) onUpdate(short.id, { stage: "assets", ...pkg }); else toast.push("Generation failed again — try in a moment.", { tone: "error" }); }}>{regen === "all" ? "Generating…" : "✦ Generate assets"}</Btn>
                </div>
              ) : (
                <>
                  <AssetBlock title="Hook (first 3 seconds)" asset="hook"><div style={box}>{short.hook || "—"}</div></AssetBlock>
                  <AssetBlock title="Script"><div style={box}>{short.script || "—"}</div></AssetBlock>
                  <AssetBlock title="Thumbnail concepts" asset="thumbnail_concepts">
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      {(short.thumbnail_concepts || []).map((tc, i) => (
                        <div key={i} style={{ ...box, display: "flex", gap: "12px", alignItems: "center" }}>
                          {/* A thumbnail mock-up. The overlay keeps its poster
                              weight but loses the CSS uppercase: in this language
                              uppercase exists in .t-label and nowhere else, and
                              the model already writes the overlay in the case it
                              wants. */}
                          <div style={{ flexShrink: 0, width: "70px", height: "90px", background: T.navyGrad, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", padding: "8px", textAlign: "center" }}>
                            <span style={{ fontSize: "11px", fontWeight: 800, color: T.amber, fontFamily: syne, lineHeight: 1.1 }}>{tc.text_overlay}</span>
                          </div>
                          <div className="t-cap" style={{ lineHeight: 1.5 }}>{tc.visual}</div>
                        </div>
                      ))}
                    </div>
                  </AssetBlock>
                  <AssetBlock title="Title" asset="title"><div style={box}>{short.title || "—"}</div></AssetBlock>
                  <AssetBlock title="Description + tags" asset="description">
                    <div style={box}>{short.description || "—"}</div>
                    {(short.tags || []).length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", marginTop: "8px" }}>{short.tags.map((tag, i) => <span key={i} className="t-cap" style={{ background: "var(--ink-a06, rgba(255,255,255,0.06))", padding: "2px 9px", borderRadius: "999px", fontFamily: mono }}>#{tag}</span>)}</div>}
                  </AssetBlock>
                  {short.pinned_comment && <AssetBlock title="Pinned comment"><div style={box}>{short.pinned_comment}</div></AssetBlock>}
                </>
              )}
            </>
          ) : (
            <div>
              {/* The kit's inset-grouped list: one .cellgroup, one .cell per
                  item, hairlines only between rows. Done is a tick AND a
                  strike-through, so the state never rests on colour. */}
              <div className="cellgroup" style={{ marginBottom: "16px" }}>
                {PUBLISH_CHECKLIST.map(item => (
                  <button key={item} type="button" className="cell tappable has-leading" role="checkbox" aria-checked={!!checklist[item]} onClick={() => toggleCheck(item)}>
                    <span className="cell-leading" style={{ width: "22px", height: "22px", borderRadius: "6px", background: checklist[item] ? T.green : "var(--ink-a08, rgba(255,255,255,0.08))", color: checklist[item] ? "#FFF" : "transparent", fontSize: "12px" }}>✓</span>
                    <span className="cell-body">
                      <span className="cell-title" style={{ whiteSpace: "normal", color: checklist[item] ? "var(--sub)" : "var(--ink)", textDecoration: checklist[item] ? "line-through" : "none" }}>{item}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: `14px ${hPad}`, borderTop: `1px solid ${T.line}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", flexShrink: 0 }}>
          <button type="button" className="btn sm quiet" onClick={() => onDelete(short.id)}>Delete</button>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {short.script && <Btn onClick={sendToFactory} disabled={sendingBrief} title="Hand this Short's script + packaging to the shorts-factory production pipeline">{sendingBrief ? "Sending…" : "⇢ Factory"}</Btn>}
            <Btn onClick={copyAll}>Copy all</Btn>
            {short.stage !== "idea" && <Btn onClick={() => moveStage(-1)} title={`Back to ${SHORT_STAGES.find(s => s.key === stepStage(SHORT_STAGES, short.stage, -1))?.label || ""}`}>‹ Back</Btn>}
            {short.stage !== "posted" && <Btn primary onClick={() => moveStage(+1)}>{short.stage === "ready" ? "Mark posted →" : isMobile ? "Advance →" : "Advance stage →"}</Btn>}
          </div>
        </div>
    </ModalShell>
  );
}
// ─── CREATORS VIEW — outreach pipeline (YouTube creators) ────────────────────
const CREATOR_STAGES = [
  { key: "prospected", label: "Prospected", color: "#8A97A8" },
  { key: "drafted", label: "Drafted", color: "#F59E0B" },
  { key: "sent", label: "Sent", color: "#3B82F6" },
  { key: "replied", label: "Replied", color: "#EC4899" },
  { key: "collab", label: "Collab", color: "#0E9F6E" },
];

// Collab pitch draft — the "Drafted" stage finally has a drafting mechanism.
// One Haiku call, grounded in the creator's niche/size and the ZTS brand voice.
async function generateCreatorPitch(creator) {
  const v = creatorValue(creator);
  const system = `You are Cameron, founder of Zero To Secure. ${ZTS_BRAND}

You are writing a first-touch collab pitch email to a YouTube creator. Rules:
- Reference their channel and niche specifically — show you actually watch.
- The offer: a paid/affiliate collab featuring the ZTS metal seed-phrase backup kit (integration or dedicated Short), creative control stays with them.
- Confident and peer-to-peer, never fawning. No "I hope this finds you well".
- Under 130 words. Sign off: Cameron | Zero To Secure

Respond ONLY with valid JSON, no markdown fences: {"subject": "...", "body": "..."}`;
  const userMsg = `Channel: ${creator.channel_name}
Subscribers: ${fmtSubs(creator.subscriber_count)}
Niche: ${creator.niche || "unknown"} (fit: ${v.fitLabel}, tier: ${v.tier})
${creator.description ? `About them: ${creator.description}` : ""}`;
  const raw = await callClaude({ system, messages: [{ role: "user", content: userMsg }], maxTokens: 500, fn: "creator_pitch" });
  if (!raw) return null;
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return null; }
}
export function CreatorsView({ creators, setCreators, isMobile, loading, openSignal = 0, onSignalConsumed }) {
  const [adding, setAdding] = useState(false);
  const [openCreator, setOpenCreator] = useState(null);
  const [sortBy, setSortBy] = useState("value");
  const toast = useToast();

  // Palette handoff: "Add Creator" from ⌘K opens the form, even if Creators
  // was already the active view. Consuming clears the signal in App.
  useEffect(() => { if (openSignal > 0) { setAdding(true); onSignalConsumed?.(); } }, [openSignal, onSignalConsumed]);

  const move = async (id, stage) => {
    setCreators(prev => prev.map(c => c.id === id ? { ...c, stage, status: stage } : c)); // optimistic
    if (openCreator?.id === id) setOpenCreator(prev => ({ ...prev, stage, status: stage }));
    if (!supabase) return;
    const { error: err } = await supabase.from("creators").update({ stage, status: stage }).eq("id", id);
    if (err) { console.warn("[CreatorsView] stage update failed:", err.message); toast.push("Stage change didn't save — " + err.message, { tone: "error" }); }
  };

  // localOnly: update React state without touching Supabase — used when the
  // caller already persisted (or deliberately persisted elsewhere, e.g. the
  // pitch's localStorage fallback when the columns don't exist).
  const updateCreator = async (id, patch, { localOnly = false } = {}) => {
    setCreators(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c)); // optimistic
    if (openCreator?.id === id) setOpenCreator(prev => ({ ...prev, ...patch }));
    if (localOnly || !supabase) return true;
    const { error: err } = await supabase.from("creators").update(patch).eq("id", id);
    if (err) { console.warn("[CreatorsView] update failed:", err.message); toast.push("Change didn't save — " + err.message, { tone: "error" }); return false; }
    return true;
  };

  const delCreator = async (id) => {
    setCreators(prev => prev.filter(c => c.id !== id)); // optimistic
    setOpenCreator(null);
    sm.del(`pitch_${id}`); // clear any locally-stored pitch for the deleted row
    if (!supabase) return;
    const { error: err } = await supabase.from("creators").delete().eq("id", id);
    if (err) { console.warn("[CreatorsView] delete failed:", err.message); toast.push("Delete didn't stick — " + err.message, { tone: "error" }); }
  };

  const sorted = [...creators].sort((a, b) => {
    if (sortBy === "value") return creatorValue(b).score - creatorValue(a).score;
    if (sortBy === "subs") return (b.subscriber_count||0) - (a.subscriber_count||0);
    return (a.channel_name||"").localeCompare(b.channel_name||"");
  });
  const byStage = (k) => sorted.filter(c => (c.stage || "prospected") === k);
  const totalReach = creators.filter(c => !["rejected"].includes(c.stage)).reduce((s, c) => s + creatorValue(c).score, 0);

  return (
    <div role="region" aria-label={TAB_LABELS.creators} style={{ minHeight: "calc(100vh - 52px)", padding: viewPad(isMobile) }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <p className="t-foot" style={{ margin: 0 }}>Find, contact, and track YouTube creators for ZTS collabs — prioritized by audience fit.</p>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <select className="field" aria-label="Sort creators" value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ width: "auto" }}>
            <option value="value">Best fit first</option>
            <option value="subs">Most subscribers</option>
            <option value="name">A → Z</option>
          </select>
          <Btn primary onClick={() => setAdding(true)}>+ Add Creator</Btn>
        </div>
      </div>

      {creators.length > 0 && (
        <div className="stattile" style={{ marginBottom: "16px" }}>
          <div className="stattile-label">Audience-fit reach</div>
          <div className="stattile-value">{fmtSubs(totalReach)}</div>
          <div className="t-cap">weighted reach in pipeline</div>
        </div>
      )}

      {loading ? (
        <SkeletonBoard cols={4} />
      ) : creators.length === 0 ? (
        <EmptyState icon="users" title="No creators yet"
          sub="Add YouTube creators to start building your collab pipeline. They're auto-scored by fit to ZTS."
          action={<Btn primary onClick={() => setAdding(true)}>+ Add your first creator</Btn>} />
      ) : (
        <div style={kanbanWrapStyle(isMobile, 5)}>
          {CREATOR_STAGES.map(stage => {
            const items = byStage(stage.key);
            return (
              <div key={stage.key} style={kanbanColStyle(isMobile)}>
                <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "10px", padding: "0 2px" }}>
                  {/* CREATOR_STAGES colours are domain data — the pipeline stage
                      IS the colour. The stage name sits beside the dot, so the
                      hue is never carrying the state on its own. */}
                  <span className="dotstatus" style={{ background: stage.color }} />
                  <span className="t-label" style={{ color: "var(--ink)" }}>{stage.label}</span>
                  <span className="t-cap t-num" style={{ fontFamily: mono }}>{items.length}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {items.map((c, idx) => {
                    const v = creatorValue(c);
                    const tierColor = v.tier === "Prime" ? T.green : v.tier === "Strong" ? T.blue : v.tier === "Fit" ? T.amber : T.faint;
                    return (
                      <div key={c.id} style={{ animation: `cardIn 0.3s ${M.easeOut} both`, animationDelay: `${Math.min(idx, 8) * 30}ms` }}>
                      <Card hover onClick={() => setOpenCreator(c)} style={{ padding: "12px 15px", boxShadow: `inset 3px 0 0 ${tierColor}, var(--shadow-card)` }}>
                        <div className="t-call" style={{ fontWeight: 600, lineHeight: 1.3 }}>{c.channel_name}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "5px", flexWrap: "wrap" }}>
                          <span className="t-cap t-num" style={{ fontFamily: mono }}>{fmtSubs(c.subscriber_count)} subs</span>
                          <span className="t-label" style={{ color: tierColor, background: tierColor + "15", padding: "2px 7px", borderRadius: "5px" }}>{v.tier} · {v.fitLabel}</span>
                          {(c.pitch_body || sm.get(`pitch_${c.id}`)) && <span title="Collab pitch drafted" className="t-label" style={{ color: T.amberDeep, background: "rgba(245,158,11,0.1)", padding: "2px 7px", borderRadius: "5px" }}>✦ pitch</span>}
                        </div>
                        <StageStepper stages={CREATOR_STAGES} current={stage.key} onMove={(next) => move(c.id, next)} />
                      </Card>
                      </div>
                    );
                  })}
                  {items.length === 0 && <EmptyState compact icon="inbox" tint={T.faint} title="Nothing here" sub="Move one in with the › stepper on a card." />}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {adding && <AddCreatorModal isMobile={isMobile} onClose={() => setAdding(false)} onAdd={async (c) => {
        const fields = { stage: "prospected", status: "prospected", ...c };
        if (!supabase) {
          setCreators(prev => [{ id: `local_${Date.now()}`, created_at: new Date().toISOString(), ...fields }, ...prev]);
          setAdding(false);
          return;
        }
        const { data, error: err } = await supabase.from("creators").insert(fields).select();
        if (err) { console.warn("[AddCreatorModal] insert failed:", err.message); toast.push("Couldn't add the creator: " + err.message, { tone: "error" }); return; }
        if (data?.[0]) { setCreators(prev => [data[0], ...prev]); toast.push(`${c.channel_name} added to the pipeline.`, { tone: "success" }); }
        setAdding(false);
      }} />}
      {openCreator && <CreatorDetail creator={openCreator} isMobile={isMobile} onClose={() => setOpenCreator(null)} onUpdate={updateCreator} onDelete={delCreator} onMove={move} />}
    </div>
  );
}

// Creator detail — edit, delete, move stages, and draft the collab pitch.
// The pitch persists to the creators row when the columns exist; if the
// schema doesn't have them yet, it falls back to local storage so the
// feature works either way (the card badge reads from the same field).
export function CreatorDetail({ creator, onClose, onUpdate, onDelete, onMove, isMobile }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ channel_name: creator.channel_name || "", subscriber_count: String(creator.subscriber_count || ""), niche: creator.niche || "", engagement_rate: creator.engagement_rate != null ? String(creator.engagement_rate * 100) : "", description: creator.description || "" });
  const [pitch, setPitch] = useState(() => (creator.pitch_subject || creator.pitch_body) ? { subject: creator.pitch_subject || "", body: creator.pitch_body || "" } : sm.get(`pitch_${creator.id}`));
  const [drafting, setDrafting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const toast = useToast();
  const v = creatorValue(creator);
  const tierColor = v.tier === "Prime" ? T.green : v.tier === "Strong" ? T.blue : v.tier === "Fit" ? T.amber : T.faint;
  const stage = creator.stage || "prospected";
  const stageMeta = CREATOR_STAGES.find(s => s.key === stage) || CREATOR_STAGES[0];
  const hPad = isMobile ? "18px" : "24px";
  const set = (k, val) => setF(p => ({ ...p, [k]: val }));

  const saveEdit = async () => {
    const patch = {
      channel_name: f.channel_name.trim() || creator.channel_name,
      subscriber_count: Number(f.subscriber_count) || 0,
      niche: f.niche.trim(),
      engagement_rate: f.engagement_rate ? Number(f.engagement_rate) / 100 : null,
      description: f.description.trim(),
    };
    if (await onUpdate(creator.id, patch)) toast.push("Creator updated.", { tone: "success" });
    setEditing(false);
  };

  const savePitch = async (p) => {
    setPitch(p);
    // Try the DB first; if the pitch columns don't exist in the schema the
    // update fails and the pitch lives in localStorage instead. Either way the
    // in-memory row is patched localOnly — persistence already happened here,
    // so onUpdate must not retry Supabase (that would error-toast every blur).
    if (supabase) {
      const { error: err } = await supabase.from("creators").update({ pitch_subject: p.subject, pitch_body: p.body }).eq("id", creator.id);
      if (!err) { onUpdate(creator.id, { pitch_subject: p.subject, pitch_body: p.body }, { localOnly: true }); return; }
    }
    sm.set(`pitch_${creator.id}`, p);
    onUpdate(creator.id, { pitch_subject: p.subject, pitch_body: p.body }, { localOnly: true });
  };

  const draftPitch = async () => {
    setDrafting(true);
    const p = await generateCreatorPitch(creator);
    setDrafting(false);
    if (p) { await savePitch(p); if (stage === "prospected") onMove(creator.id, "drafted"); toast.push("Collab pitch drafted — edit it, then copy into your email client.", { tone: "success" }); }
    else toast.push("Pitch generation failed — try again in a moment.", { tone: "error" });
  };

  const copyPitch = () => {
    if (!pitch) return;
    try { navigator.clipboard.writeText(`Subject: ${pitch.subject}\n\n${pitch.body}`); toast.push("Pitch copied.", { tone: "success" }); } catch {}
  };

  // The kit's .field carries the geometry, the tone and the focus ring; only the
  // stacking gap is local. Same for the read-only well below.
  const input = { marginBottom: "8px" };
  const box = { background: "var(--surface-2)", borderRadius: "var(--r-well, 12px)", padding: "12px 14px", fontSize: "13px", color: "var(--ink)", lineHeight: 1.6, whiteSpace: "pre-wrap" };

  return (
    <ModalShell onClose={onClose} isMobile={isMobile} width={560}>
      <div style={{ padding: `18px ${hPad}`, borderBottom: `1px solid ${T.line}`, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexShrink: 0 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap", marginBottom: "5px" }}>
            <span className="t-label" style={{ color: stageMeta.color, background: stageMeta.color + "15", padding: "3px 8px", borderRadius: "5px" }}>{stageMeta.label}</span>
            <span className="t-label" style={{ color: tierColor, background: tierColor + "15", padding: "3px 8px", borderRadius: "5px" }}>{v.tier} · {v.fitLabel}</span>
          </div>
          <h2 className="t-head" style={{ margin: 0 }}>{creator.channel_name}</h2>
          <div className="t-cap t-num" style={{ fontFamily: mono, marginTop: "2px" }}>{fmtSubs(creator.subscriber_count)} subs · weighted reach {fmtSubs(v.score)}</div>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" style={{ fontSize: "20px", lineHeight: 1 }}>×</button>
      </div>

      <div style={{ padding: `16px ${hPad}`, overflowY: "auto" }}>
        {/* Stage movement — full stepper, both directions */}
        <Label style={{ marginBottom: "8px" }}>Pipeline stage</Label>
        <div style={{ display: "flex", gap: "5px", marginBottom: "18px", flexWrap: "wrap" }}>
          {/* The kit's .pill, tinted with the stage's own domain colour. The
              current stage is marked with a ✓ and aria-current as well as the
              tint, so it does not depend on the hue being seen. */}
          {CREATOR_STAGES.map(s => (
            <button key={s.key} type="button" className="pill" aria-current={s.key === stage ? "step" : undefined}
              onClick={() => s.key !== stage && onMove(creator.id, s.key)}
              style={s.key === stage
                ? { background: s.color + "22", color: s.color, fontWeight: 700, cursor: "default" }
                : undefined}>
              {s.key === stage ? "✓ " : ""}{s.label}
            </button>
          ))}
        </div>

        {/* Profile — view or edit */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
          <Label>Profile</Label>
          {!editing && <button type="button" className="btn sm plain" onClick={() => setEditing(true)}>Edit</button>}
        </div>
        {editing ? (
          <div style={{ marginBottom: "16px" }}>
            <input className="field" placeholder="Channel name" value={f.channel_name} onChange={e => set("channel_name", e.target.value)} style={input} />
            <input className="field" placeholder="Subscriber count" value={f.subscriber_count} onChange={e => set("subscriber_count", e.target.value)} style={input} />
            <input className="field" placeholder="Niche" value={f.niche} onChange={e => set("niche", e.target.value)} style={input} />
            <input className="field" placeholder="Engagement rate % (optional)" value={f.engagement_rate} onChange={e => set("engagement_rate", e.target.value)} style={input} />
            <textarea className="field" placeholder="Channel description" value={f.description} onChange={e => set("description", e.target.value)} style={{ ...input, minHeight: "56px", resize: "vertical" }} />
            <div style={{ display: "flex", gap: "8px" }}>
              <Btn primary onClick={saveEdit} style={{ flex: 1 }}>Save</Btn>
              <Btn onClick={() => setEditing(false)}>Cancel</Btn>
            </div>
          </div>
        ) : (
          <div style={{ ...box, marginBottom: "16px" }}>
            {[creator.niche && `Niche: ${creator.niche}`, creator.engagement_rate != null && `Engagement: ${(creator.engagement_rate * 100).toFixed(1)}%`, creator.description].filter(Boolean).join("\n") || "No profile details yet — hit edit."}
          </div>
        )}

        {/* Collab pitch — the "Drafted" stage's actual draft */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
          <Label>Collab pitch</Label>
          <button type="button" className="btn sm plain" onClick={draftPitch} disabled={drafting}>
            {drafting ? "✦ drafting…" : pitch ? "↻ redraft" : "✦ draft with AI"}
          </button>
        </div>
        {pitch ? (
          <div style={{ marginBottom: "6px" }}>
            {/* Edits stay local per keystroke; persistence happens on blur. */}
            <input className="field" aria-label="Pitch subject" value={pitch.subject} onChange={e => setPitch(p => ({ ...p, subject: e.target.value }))} onBlur={() => savePitch(pitch)} style={{ ...input, fontWeight: 600 }} />
            <textarea className="field" aria-label="Pitch body" value={pitch.body} onChange={e => setPitch(p => ({ ...p, body: e.target.value }))} onBlur={() => savePitch(pitch)} rows={7} style={{ ...input, resize: "vertical", lineHeight: 1.6, marginBottom: "8px" }} />
            <Btn onClick={copyPitch}>Copy pitch</Btn>
          </div>
        ) : (
          <div style={{ ...box, color: "var(--sub)" }}>No pitch yet. "Draft with AI" writes a first-touch collab email grounded in their niche and the ZTS voice — drafting also moves them to Drafted.</div>
        )}
      </div>

      <div style={{ padding: `13px ${hPad}`, borderTop: `1px solid ${T.line}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        {!confirmDel ? (
          <button type="button" className="btn sm quiet" onClick={() => setConfirmDel(true)}>Delete</button>
        ) : (
          <span style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span className="t-cap" style={{ color: T.red }}>Delete {creator.channel_name}?</span>
            <button type="button" className="btn sm danger-solid" onClick={() => onDelete(creator.id)}>Yes, delete</button>
            <button type="button" className="btn sm quiet" onClick={() => setConfirmDel(false)}>Keep</button>
          </span>
        )}
        <Btn onClick={onClose}>Done</Btn>
      </div>
    </ModalShell>
  );
}

export function AddCreatorModal({ onClose, onAdd, isMobile }) {
  const [f, setF] = useState({ channel_name: "", subscriber_count: "", niche: "", description: "", engagement_rate: "" });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const submit = () => { if (!f.channel_name) return; onAdd({ ...f, subscriber_count: Number(f.subscriber_count) || 0, engagement_rate: f.engagement_rate ? Number(f.engagement_rate) / 100 : null }); };
  const v = f.channel_name ? creatorValue({ ...f, subscriber_count: Number(f.subscriber_count) || 0 }) : null;
  const input = { marginBottom: "10px" };
  return (
    <ModalShell onClose={onClose} isMobile={isMobile} width={480}>
      <div style={{ padding: isMobile ? "14px 18px calc(18px + var(--safe-bottom))" : "26px 28px", overflowY: "auto" }}>
        <h2 className="t-head" style={{ margin: "0 0 18px" }}>Add Creator</h2>
        <input className="field" placeholder="Channel name" value={f.channel_name} onChange={e => set("channel_name", e.target.value)} style={input} />
        <input className="field" placeholder="Subscriber count (e.g. 45000)" value={f.subscriber_count} onChange={e => set("subscriber_count", e.target.value)} style={input} />
        <input className="field" placeholder="Niche (e.g. Bitcoin self-custody)" value={f.niche} onChange={e => set("niche", e.target.value)} style={input} />
        <input className="field" placeholder="Engagement rate % (optional, e.g. 5)" value={f.engagement_rate} onChange={e => set("engagement_rate", e.target.value)} style={input} />
        <textarea className="field" placeholder="Channel description (helps fit scoring)" value={f.description} onChange={e => set("description", e.target.value)} style={{ ...input, minHeight: "60px", resize: "vertical" }} />
        {v && <div className="t-cap" style={{ marginBottom: "14px", padding: "9px 12px", background: "var(--accent-a08, rgba(14,159,110,0.06))", borderRadius: "8px" }}>Fit: <strong style={{ color: "var(--accent)" }}>{v.tier}</strong> · {v.fitLabel} · weighted reach {fmtSubs(v.score)}</div>}
        <div style={{ display: "flex", gap: "8px" }}>
          <Btn primary onClick={submit} style={{ flex: 1 }}>Add to pipeline</Btn>
          <Btn onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </ModalShell>
  );
}
// ─── AGENT ENGINE (headless) ─────────────────────────────────────────────────
function AgentEngine({ creators, shorts, articles, onArticleDraft }) {
  const cRef = useRef(creators), sRef = useRef(shorts), aRef = useRef(articles);
  useEffect(() => { cRef.current = creators; }, [creators]);
  useEffect(() => { sRef.current = shorts; }, [shorts]);
  useEffect(() => { aRef.current = articles; }, [articles]);
  useEffect(() => {
    const onAct = () => markActivity();
    window.addEventListener("mousemove", onAct, { passive: true });
    window.addEventListener("keydown", onAct, { passive: true });
    markActivity();
    let lastWork = 0;
    const poll = setInterval(async () => {
      const ctrl = eng.get();
      if (!ctrl.running) return;
      if (ctrl.pauseWhenIdle && isIdle(ctrl.idleMin)) { eng.set({ running: false }); kb.add([{ agent: "system", type: "system", signal: "info", text: "Auto-paused — no activity detected." }]); return; }
      const now = Date.now();
      const forced = sm.get("engine_force_pass");
      if (!forced && now - lastWork < ctrl.cadenceSec * 1000) return;
      if (forced) sm.del("engine_force_pass");
      lastWork = now;
      sm.set("engine_pass_count", (sm.get("engine_pass_count") || 0) + 1);
      const ctx = { creators: cRef.current || [], shorts: sRef.current || [], articles: aRef.current || [], obsLogs: obs.getAll() };
      let newObs = [];
      Object.entries(HEURISTIC_AGENTS).forEach(([k, a]) => { if (ctrl.agents[k] === false) return; try { newObs = newObs.concat(a.scan(ctx) || []); } catch {} });
      const added = kb.add(newObs);
      sm.set("engine_last_tick", now);
      if (added > 0) sm.set("engine_obs_since_synth", (sm.get("engine_obs_since_synth") || 0) + added);
      if (forced && added === 0) kb.add([{ agent: "system", type: "system", signal: "info", text: `Manual pass #${sm.get("engine_pass_count")} — scanned ${ctx.creators.length} creators + ${ctx.shorts.length} Shorts, nothing new to flag.` }]);
      // ── SEO auto-draft: agent-initiated, approval-gated. Runs only when the
      //    toggle is on, the cadence has elapsed, spend is allowed, and we're
      //    under the cost cap. The draft lands in "In Review" — never published.
      if (ctrl.seoAutoDraft && !ctrl.observeOnly && engineSpendThisHour() < ctrl.hourlyCostCap) {
        const lastDraft = sm.get("seo_last_autodraft") || 0;
        if (now - lastDraft > (ctrl.seoEveryDays || 4) * 86400000) {
          sm.set("seo_last_autodraft", now); // set BEFORE the call so a slow call can't double-fire
          const kws = (sm.get("seo_keywords") || "").split("\n").map(k => k.trim()).filter(Boolean);
          const covered = new Set((aRef.current || []).map(a => (a.target_keyword || a.keyword || "").toLowerCase()));
          const kw = kws.find(k => !covered.has(k.toLowerCase())) || null;
          const pkg = await generateArticle({ keyword: kw });
          if (pkg && onArticleDraft) {
            onArticleDraft({ id: `a_${Date.now()}`, created_at: new Date().toISOString(), stage: "review", auto_drafted: true, keyword: kw, ...pkg });
            kb.add([{ agent: "seoCadence", type: "observation", signal: "info", text: `Drafted a new article for review: "${pkg.title_tag}" (${pkg.target_keyword}). Approve or reject it in the SEO tab.` }]);
          }
        }
      }

      if (ctrl.observeOnly) return;
      if ((sm.get("engine_obs_since_synth") || 0) < 3) return;
      if (now - (sm.get("engine_last_synth_ts") || 0) < ctrl.synthEveryMin * 60000) return;
      const hash = stateHash(ctx.creators, ctx.shorts);
      if (hash === sm.get("engine_last_synth_hash")) return;
      if (engineSpendThisHour() >= ctrl.hourlyCostCap) { eng.set({ observeOnly: true }); kb.add([{ agent: "system", type: "system", signal: "warning", text: `Hourly cost cap reached — dropped to observe-only.` }]); return; }
      const recent = kb.all().filter(e => e.type === "observation" || e.type === "learning").slice(0, 12);
      const insight = await synthesizeInsight(recent, ctrl.allowSonnet);
      sm.set("engine_last_synth_ts", now); sm.set("engine_last_synth_hash", hash); sm.set("engine_obs_since_synth", 0);
      if (insight) kb.add([{ agent: "synthesizer", type: "insight", signal: "info", text: insight }]);
    }, 2000);
    return () => { clearInterval(poll); window.removeEventListener("mousemove", onAct); window.removeEventListener("keydown", onAct); };
  }, []);
  return null;
}

// ─── AGENTS VIEW (control panel + feed) ──────────────────────────────────────
export function SeoView({ articles, setArticles, onAddArticle, isMobile, loading, openSignal = 0, onSignalConsumed }) {
  const [composing, setComposing] = useState(false);
  const [openArticle, setOpenArticle] = useState(null);
  const [keywords, setKeywords] = useState(() => sm.get("seo_keywords") || "");
  const [autoDraft, setAutoDraft] = useState(() => eng.get().seoAutoDraft || false);
  const [everyDays, setEveryDays] = useState(() => eng.get().seoEveryDays || 4);
  const toast = useToast();

  // Palette handoff: "New Article" from ⌘K opens the composer, even if SEO
  // was already the active view. Consuming clears the signal in App.
  useEffect(() => { if (openSignal > 0) { setComposing(true); onSignalConsumed?.(); } }, [openSignal, onSignalConsumed]);

  const update = async (id, patch) => {
    setArticles(prev => prev.map(a => a.id === id ? { ...a, ...patch } : a)); // optimistic
    if (openArticle?.id === id) setOpenArticle(prev => ({ ...prev, ...patch }));
    if (!supabase) return;
    const { error: err } = await supabase.from("articles").update(patch).eq("id", id);
    if (err) { console.warn("[SeoView] update failed:", err.message); toast.push("Change didn't save — " + err.message, { tone: "error" }); }
  };
  const byStage = (k) => articles.filter(a => (a.stage || "idea") === k);
  const lastAuto = sm.get("seo_last_autodraft");
  const nextAuto = autoDraft && lastAuto ? new Date(lastAuto + everyDays * 86400000) : null;

  return (
    <div role="region" aria-label={TAB_LABELS.seo} style={{ minHeight: "calc(100vh - 52px)", padding: viewPad(isMobile) }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <p className="t-foot" style={{ margin: 0 }}>The agent drafts search content on a cadence — nothing publishes without your approval.</p>
        </div>
        <Btn primary onClick={() => setComposing(true)}>✦ New Article</Btn>
      </div>

      {/* Auto-draft cadence + keyword panel */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: isMobile ? "10px" : "14px", marginBottom: "18px" }}>
        <Card>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
            <Label>Auto-draft cadence</Label>
            {/* The kit's .switch — iOS proportions, --green when on. The state is
                also written out in the sentence below it, so "on" is legible
                without reading the colour. */}
            <button type="button" role="switch" aria-checked={autoDraft} aria-label="Auto-draft cadence"
              className={autoDraft ? "switch small on" : "switch small"}
              onClick={() => { const on = !autoDraft; setAutoDraft(on); eng.set({ seoAutoDraft: on }); }}>
              <span className="switch-knob" />
            </button>
          </div>
          <p className="t-foot" style={{ margin: "0 0 10px", lineHeight: 1.5 }}>{autoDraft ? "On — the engine drafts a new article into In Review" : "Off — articles only generate when you click New Article"}{autoDraft && <> every <strong>{everyDays}</strong> days. It targets your keyword list first, then ZTS topic clusters.</>}</p>
          {autoDraft && (
            <>
              <input className="scoreSlider" aria-label="Days between auto-drafts" type="range" min="2" max="7" step="1" value={everyDays} onChange={e => { const v = Number(e.target.value); setEveryDays(v); eng.set({ seoEveryDays: v }); }} style={{ "--slider-color": "var(--accent)", "--slider-fill": `${((everyDays - 2) / 5) * 100}%` }} />
              <div className="t-cap" style={{ marginTop: "8px" }}>{everyDays <= 3 ? "≈ twice a week" : "≈ once a week"}{nextAuto ? ` · next draft ~${nextAuto.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}` : " · first draft on next engine pass"}</div>
            </>
          )}
        </Card>
        <Card>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: "10px" }}>
            <Label>Target keywords</Label>
            <span className="t-cap" style={{ textAlign: "right" }}>paste from Search Console — GSC sync coming in phase 2</span>
          </div>
          <textarea className="field" aria-label="Target keywords" value={keywords} onChange={e => { setKeywords(e.target.value); sm.set("seo_keywords", e.target.value); }} placeholder={"one keyword per line, e.g.\nmetal seed phrase backup\nbitcoin inheritance planning"} style={{ minHeight: "76px", resize: "vertical", lineHeight: 1.6, fontFamily: mono }} />
        </Card>
      </div>

      {/* Pipeline board */}
      {loading ? (
        <SkeletonBoard cols={4} />
      ) : articles.length === 0 ? (
        <EmptyState icon="doc" title="No articles yet"
          sub="Generate your first SEO article, or flip on auto-draft and let the agent queue them for your review."
          action={<Btn primary onClick={() => setComposing(true)}>✦ Draft the first article</Btn>} />
      ) : (
        <div style={kanbanWrapStyle(isMobile, 4)}>
          {ARTICLE_STAGES.map(stage => {
            const items = byStage(stage.key);
            return (
              <div key={stage.key} style={kanbanColStyle(isMobile)}>
                <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "10px", padding: "0 2px" }}>
                  {/* ARTICLE_STAGES colours are domain data; the label carries
                      the meaning next to them. */}
                  <span className="dotstatus" style={{ background: stage.color }} />
                  <span className="t-label" style={{ color: "var(--ink)" }}>{stage.label}</span>
                  <span className="t-cap t-num" style={{ fontFamily: mono }}>{items.length}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {items.map((a, idx) => (
                    <div key={a.id} style={{ animation: `cardIn 0.3s ${M.easeOut} both`, animationDelay: `${Math.min(idx, 8) * 30}ms` }}>
                    <Card hover onClick={() => setOpenArticle(a)} style={{ padding: "12px 15px", boxShadow: `inset 3px 0 0 ${stage.color}, var(--shadow-card)` }}>
                      {a.auto_drafted && <span className="t-label" style={{ display: "inline-block", color: "var(--accent)", background: "var(--accent-a10, rgba(14,159,110,0.1))", padding: "3px 7px", borderRadius: "5px", marginBottom: "6px" }}>Agent draft</span>}
                      <div className="t-call" style={{ fontWeight: 600, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{a.title_tag || a.keyword || "Untitled"}</div>
                      {a.target_keyword && <div className="t-cap t-num" style={{ marginTop: "4px", fontFamily: mono }}>{a.target_keyword}{a.word_count ? ` · ${a.word_count}w` : ""}</div>}
                      {/* Arrows stop at Approved — actually publishing to Shopify
                          stays behind the explicit button in the detail modal.
                          Published articles are frozen: stepping one back would
                          leave a stale published_url and invite a duplicate
                          publish (publishToShopify always creates a new post). */}
                      <StageStepper stages={ARTICLE_STAGES} current={stage.key}
                        blockForward={stage.key === "approved" || stage.key === "published"}
                        blockBack={stage.key === "published"}
                        forwardTitle={stage.key === "approved" ? "Publishing happens in the article view — open it and hit Publish" : undefined}
                        onMove={(next) => update(a.id, { stage: next, ...(next === "approved" ? { approved_at: new Date().toISOString() } : {}) })} />
                    </Card>
                    </div>
                  ))}
                  {items.length === 0 && <EmptyState compact icon="inbox" tint={T.faint} title="Nothing here" sub="Move one in with the › stepper on a card." />}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {composing && <ComposeArticleModal keywords={keywords} isMobile={isMobile} onClose={() => setComposing(false)} onCreate={async (a) => { await onAddArticle(a); setComposing(false); }} />}
      {openArticle && <ArticleDetail article={openArticle} isMobile={isMobile} onClose={() => setOpenArticle(null)} onUpdate={update} onDelete={async (id) => {
        setArticles(prev => prev.filter(a => a.id !== id)); // optimistic
        setOpenArticle(null);
        if (!supabase) return;
        const { error: err } = await supabase.from("articles").delete().eq("id", id);
        if (err) { console.warn("[SeoView] delete failed:", err.message); toast.push("Delete didn't stick — " + err.message, { tone: "error" }); }
      }} />}
    </div>
  );
}

export function ComposeArticleModal({ keywords, onClose, onCreate, isMobile }) {
  const kwList = (keywords || "").split("\n").map(k => k.trim()).filter(Boolean);
  const [keyword, setKeyword] = useState(kwList[0] || "");
  const [notes, setNotes] = useState("");
  const [gen, setGen] = useState(false);
  const toast = useToast();
  const create = async () => {
    setGen(true);
    const pkg = await generateArticle({ keyword, notes });
    setGen(false);
    if (pkg) { onCreate({ keyword, stage: "review", ...pkg }); toast.push(`Article drafted into review: "${pkg.title_tag}"`, { tone: "success" }); }
    else { onCreate({ keyword, stage: "idea" }); toast.push("Drafting didn't complete — saved as an idea. Open it to retry.", { tone: "warning" }); }
  };
  return (
    <ModalShell onClose={onClose} isMobile={isMobile} width={520}>
      <div style={{ padding: isMobile ? "14px 18px calc(18px + var(--safe-bottom))" : "26px 28px", overflowY: "auto" }}>
        <h2 className="t-head" style={{ margin: "0 0 4px" }}>New Article</h2>
        <p className="t-foot" style={{ margin: "0 0 18px" }}>Claude drafts the full package — title tag, meta, outline, article, internal links — into your review queue.</p>
        <Label style={{ marginBottom: "8px" }}>Target keyword</Label>
        {kwList.length > 0 ? (
          <select className="field" aria-label="Target keyword" value={keyword} onChange={e => setKeyword(e.target.value)} style={{ marginBottom: "14px" }}>
            {kwList.map((k, i) => <option key={i} value={k}>{k}</option>)}
            <option value="">— let the agent pick from ZTS clusters —</option>
          </select>
        ) : (
          <input className="field" aria-label="Target keyword" value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="e.g. metal seed phrase backup (blank = agent picks)" style={{ marginBottom: "14px" }} />
        )}
        <Label style={{ marginBottom: "8px" }}>Angle / notes (optional)</Label>
        <textarea className="field" aria-label="Angle or notes" value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. compare against paper backups, mention the FTX collapse" style={{ minHeight: "60px", resize: "vertical" }} />
        <div style={{ display: "flex", gap: "8px", marginTop: "18px" }}>
          <Btn primary onClick={create} disabled={gen} style={{ flex: 1 }}>{gen ? "Drafting (~30s)…" : "✦ Generate article"}</Btn>
          <Btn onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </ModalShell>
  );
}

export function ArticleDetail({ article, onClose, onUpdate, onDelete, isMobile }) {
  const [publishing, setPublishing] = useState(false);
  const [pubResult, setPubResult] = useState(null);
  const [regenerating, setRegenerating] = useState(false);
  const toast = useToast();
  const stage = article.stage || "idea";
  const approve = () => onUpdate(article.id, { stage: "approved", approved_at: new Date().toISOString() });
  const reject = () => onUpdate(article.id, { stage: "idea", rejected: true });
  // Recovery path for ideas (failed generations land here with no article body).
  const regenerate = async () => {
    setRegenerating(true);
    const kw = article.target_keyword || article.keyword || "";
    const pkg = await generateArticle({ keyword: kw });
    setRegenerating(false);
    if (pkg) { onUpdate(article.id, { ...pkg, stage: "review" }); toast.push(`Draft ready for review: "${pkg.title_tag}"`, { tone: "success" }); }
    else toast.push("Drafting failed again — try in a moment.", { tone: "error" });
  };
  const publish = async () => {
    setPublishing(true);
    try {
      const res = await publishToShopify(article);
      setPubResult(res);
      onUpdate(article.id, { stage: "published", published_at: new Date().toISOString(), published_url: res.url || null });
    } catch (e) { setPubResult({ error: e.message }); }
    setPublishing(false);
  };
  const box = { background: "var(--surface-2)", borderRadius: "var(--r-well, 12px)", padding: "12px 14px", fontSize: "13px", color: "var(--ink)", lineHeight: 1.6 };
  const hPad = isMobile ? "18px" : "24px";
  return (
    <ModalShell onClose={onClose} isMobile={isMobile} width={720}>
        <div style={{ padding: `18px ${hPad}`, borderBottom: `1px solid ${T.line}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexShrink: 0 }}>
          <div style={{ minWidth: 0 }}>
            <span className="t-label" style={{ display: "inline-block", color: T.amberDeep, background: "rgba(245,158,11,0.1)", padding: "3px 8px", borderRadius: "5px", marginBottom: "6px" }}>{stage}{article.auto_drafted ? " · agent draft" : ""}</span>
            <h2 className="t-head" style={{ margin: 0, lineHeight: 1.3 }}>{article.title_tag || article.keyword || "Untitled"}</h2>
            {article.target_keyword && <div className="t-cap t-num" style={{ marginTop: "3px", fontFamily: mono }}>{article.target_keyword} · {article.search_intent || "—"} · {article.word_count || "?"} words</div>}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" style={{ fontSize: "20px", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: `18px ${hPad}`, overflowY: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "10px", marginBottom: "16px" }}>
            <div><Label style={{ marginBottom: "6px" }}>Title tag</Label><div style={box}>{article.title_tag || "—"}</div></div>
            <div><Label style={{ marginBottom: "6px" }}>Slug</Label><div style={{ ...box, fontFamily: mono, fontSize: "12px" }}>/{article.slug || "—"}</div></div>
          </div>
          <Label style={{ marginBottom: "6px" }}>Meta description</Label>
          <div style={{ ...box, marginBottom: "16px" }}>{article.meta_description || "—"}</div>
          {(article.internal_links || []).length > 0 && (<>
            <Label style={{ marginBottom: "6px" }}>Internal links</Label>
            <div style={{ ...box, marginBottom: "16px" }}>{article.internal_links.map((l, i) => <div key={i} className="t-cap" style={{ color: "var(--ink)" }}>"{l.anchor}" → <span style={{ fontFamily: mono, color: "var(--accent)" }}>{l.target}</span></div>)}</div>
          </>)}
          <Label style={{ marginBottom: "6px" }}>Article</Label>
          <div style={{ ...box, maxHeight: isMobile ? "44vh" : "320px", overflowY: "auto" }} dangerouslySetInnerHTML={{ __html: article.article_html ? DOMPurify.sanitize(article.article_html) : "<em>No draft yet.</em>" }} />
          {/* The publish result is a status message, and it says which one it is
              in words — the tint only agrees with the sentence. */}
          {pubResult && <div className="t-cap" style={{ marginTop: "12px", padding: "10px 14px", borderRadius: "9px", background: pubResult.error ? "rgba(220,38,38,0.07)" : "var(--accent-a08, rgba(14,159,110,0.07))", color: pubResult.error ? T.red : "var(--accent)" }}>{pubResult.error ? `Publish failed: ${pubResult.error} — fix it and hit Publish again.` : pubResult.method === "clipboard" ? "Local mode — article HTML copied to clipboard. Paste into Shopify admin → Blog posts → Add." : "Published to Shopify ✓"}</div>}
        </div>
        <div style={{ padding: `14px ${hPad}`, borderTop: `1px solid ${T.line}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap", flexShrink: 0 }}>
          <button type="button" className="btn sm quiet" onClick={() => onDelete(article.id)}>Delete</button>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {stage === "idea" && <Btn primary onClick={regenerate} disabled={regenerating}>{regenerating ? "Drafting…" : "✦ Generate draft"}</Btn>}
            {stage === "review" && <><Btn onClick={reject}>✕ Reject</Btn><Btn primary onClick={approve}>✓ Approve</Btn></>}
            {stage === "approved" && <>
              <Btn onClick={() => onUpdate(article.id, { stage: "review" })} title="Send back for another look">‹ Back to review</Btn>
              <Btn primary onClick={publish} disabled={publishing}>{publishing ? "Publishing…" : "🚀 Publish to Shopify"}</Btn>
            </>}
            {stage === "published" && article.published_url && <a className="btn md plain" href={article.published_url} target="_blank" rel="noopener" style={{ textDecoration: "none" }}>View live ›</a>}
          </div>
        </div>
    </ModalShell>
  );
}

// ─── MISSION — command center across both pillars ────────────────────────────
export function MissionView({ creators, shorts, onNavigate, isMobile, loading }) {
  const engCtrl = eng.get();
  const kbAll = kb.all();
  const cPipe = { prospected: creators.filter(c => (c.stage||"prospected") === "prospected").length, sent: creators.filter(c => c.stage === "sent").length, replied: creators.filter(c => c.stage === "replied").length, collab: creators.filter(c => c.stage === "collab").length };
  const sPipe = { wip: shorts.filter(s => ["script","assets"].includes(s.stage)).length, ready: shorts.filter(s => s.stage === "ready").length, posted: shorts.filter(s => s.stage === "posted").length };
  const totalReach = creators.filter(c => c.stage !== "rejected").reduce((s, c) => s + creatorValue(c).score, 0);
  const roster = AGENT_META.map(m => { const notes = kbAll.filter(e => e.agent === m.key); const enabled = m.key === "synthesizer" ? !engCtrl.observeOnly : engCtrl.agents[m.key] !== false; return { key: m.key, name: m.name, enabled, notes: notes.length }; });
  const recent = obs.getAll().slice(0, 6);

  // The kit's stat tile — .stattile.on-canvas is the card-weight variant, so it
  // sits in the same grid as the two pipeline cards without a second material.
  const Stat = ({ label, value, sub, accent, format, onClick }) => (
    // No role/tabIndex: this is the same click-a-div affordance it has always
    // been, and giving it keyboard FOCUS without a keyboard ACTIVATION would be
    // a promise the element does not keep. Wiring one is a behaviour change and
    // this pass is a restyle.
    <div className={`stattile on-canvas${onClick ? " tappable" : ""}`} onClick={onClick}>
      <div className="stattile-label">{label}</div>
      <div className="stattile-value" style={{ fontSize: "26px", color: accent || "var(--ink)" }}>{typeof value === "number" ? <AnimatedNumber value={value} format={format} /> : value}</div>
      {sub && <div className="t-cap" style={{ marginTop: "4px" }}>{sub}</div>}
    </div>
  );
  const spanMobile = isMobile ? { gridColumn: "1 / -1" } : undefined;

  if (loading) {
    return (
      // The two lines that stood in for the title and its sub are gone with the
      // title itself. A skeleton that reserves space nothing will fill drops the
      // whole page 70px the moment the data lands.
      <div style={{ minHeight: "calc(100vh - 52px)", padding: viewPad(isMobile) }}>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: isMobile ? "10px" : "14px" }}>
          {[0,1,2,3].map(i => <SkeletonRows key={i} count={1} />)}
        </div>
      </div>
    );
  }

  return (
    // role/aria-label, not a heading: the visible <h1>Mission</h1> and the
    // "Zero To Secure" line under it are gone — the sub-nav's Mission pill is
    // already lit and the shell's tool row already says ZTS, so both were
    // spending 70px to repeat two things on screen. A screen reader had been
    // getting the view's name from that h1, so the name moves onto the region
    // and reads from TAB_LABELS: the pill and the accessible name are now the
    // same string by construction and cannot drift apart.
    <div role="region" aria-label={TAB_LABELS.mission} style={{ minHeight: "calc(100vh - 52px)", padding: viewPad(isMobile) }}>
      {/* The engine states its own condition. The hardcoded green "Live" dot
          that used to sit here was a constant in a file — it rendered the same
          whether the system was armed, disarmed, or had never run once. */}
      <EnginePanel isMobile={isMobile} />

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: isMobile ? "10px" : "14px", marginBottom: "16px" }}>
        <Card style={spanMobile}>
          <Label style={{ marginBottom: "12px" }}>Creator Pipeline</Label>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
            {/* The stage colours here are the CREATOR_STAGES hues — domain data.
                The stage name is under every number, so the count is never read
                off the colour alone. */}
            {[["Prospected", cPipe.prospected, T.faint], ["Sent", cPipe.sent, T.blue], ["Replied", cPipe.replied, "#EC4899"], ["Collab", cPipe.collab, T.green]].map(([l, v, c], i) => (
              <div key={i} style={{ textAlign: "center", minWidth: 0 }}><div className="stattile-value" style={{ fontSize: "22px", color: c, lineHeight: 1 }}><AnimatedNumber value={v} /></div><div className="stattile-label" style={{ marginTop: "5px" }}>{l}</div></div>
            ))}
          </div>
          <div className="t-cap" style={{ marginTop: "12px", textAlign: "center" }}><span style={{ color: "var(--accent)", fontWeight: 600 }}>{fmtSubs(totalReach)} weighted reach</span> in pipeline</div>
        </Card>
        <Card style={spanMobile}>
          <Label style={{ marginBottom: "12px" }}>Shorts Studio</Label>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
            {[["In Production", sPipe.wip, T.amber], ["Ready", sPipe.ready, T.green], ["Posted", sPipe.posted, T.purple]].map(([l, v, c], i) => (
              <div key={i} style={{ textAlign: "center", minWidth: 0 }}><div className="stattile-value" style={{ fontSize: "22px", color: c, lineHeight: 1 }}><AnimatedNumber value={v} /></div><div className="stattile-label" style={{ marginTop: "5px" }}>{l}</div></div>
            ))}
          </div>
          <button type="button" className="btn sm plain full" style={{ marginTop: "10px" }} onClick={() => onNavigate("studio")}>Open Studio ›</button>
        </Card>
        <Stat label="Ready to Post" value={sPipe.ready} sub={sPipe.ready > 0 ? "get them scheduled" : "none queued"} accent={sPipe.ready > 0 ? T.green : T.ink} onClick={() => onNavigate("studio")} />
        <Stat label="AI Spend" value={obs.getAll().reduce((s,l) => s + (l.costEstimate||0), 0)} format={(n) => `$${n.toFixed(2)}`} sub={`${obs.getAll().length} calls`} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: isMobile ? "12px" : "16px" }}>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: "14px" }}><Label>Agent Roster</Label><span className="t-cap">Controls in System ›</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            {/* running / ready / off is spelled out under every name — the dot
                agrees with the word rather than replacing it. */}
            {roster.map((a, i) => { const active = a.enabled && engCtrl.running; return (
              <div key={i} className="stattile" style={{ flexDirection: "row", alignItems: "center", gap: "9px", padding: "9px 11px" }}>
                <span className="dotstatus" style={{ background: active ? T.green : a.enabled ? T.faint : T.ghost }} />
                <div style={{ minWidth: 0 }}><div className="t-cap" style={{ color: "var(--ink)", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</div><div className="stattile-label">{a.notes > 0 ? `${a.notes} note${a.notes!==1?"s":""}` : active ? "running" : a.enabled ? "ready" : "off"}</div></div>
              </div>
            ); })}
          </div>
        </Card>
        <Card>
          <Label style={{ marginBottom: "14px" }}>Recent Activity</Label>
          {recent.length === 0 ? <EmptyState compact dashed={false} icon="spark" tint={T.faint} title="No AI activity yet" sub="Generate a Short or run an engine pass — calls land here." /> : (
            <div style={{ display: "flex", flexDirection: "column", gap: "9px" }}>
              {recent.map((l, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "9px" }}>
                  <span className="dotstatus" style={{ background: l.ok === false ? T.red : T.green }} />
                  <div style={{ flex: 1, minWidth: 0 }}><div className="t-cap" style={{ color: "var(--ink)", fontWeight: 600 }}>{({ generate_short: "Generated a Short", regen_asset: "Regenerated asset", agent_synthesis: "Engine synthesis" })[l.fn] || l.fn}{l.ok === false ? " · failed" : ""}</div></div>
                  <span className="t-cap t-num" style={{ fontFamily: mono }}>${(l.costEstimate||0).toFixed(4)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ─── OPS — observability ─────────────────────────────────────────────────────
export function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("password");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [sent, setSent] = useState(false);
  const inputStyle = { marginBottom: 10 };

  if (!supabase) {
    return (
      // data-kit: the unconfigured gate is a separate root from the form below,
      // so it opts in on its own.
      <div data-kit style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, color: T.ink, background: "var(--bg)" }}>
        <div className="card pad-lg" style={{ width: 380, maxWidth: "94vw" }}>
          <h1 className="t-head" style={{ margin: "0 0 8px" }}>Supabase isn't configured yet</h1>
          <p className="t-foot" style={{ margin: 0, lineHeight: 1.6 }}>Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then redeploy — sign-in needs a real Supabase project to check against.</p>
        </div>
      </div>
    );
  }

  const signIn = async () => {
    setBusy(true); setErr(null);
    const { error: err0 } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (err0) setErr(err0.message);
    setBusy(false);
  };
  const sendMagic = async () => {
    setBusy(true); setErr(null);
    const { error: err0 } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: window.location.origin } });
    if (err0) setErr(err0.message); else setSent(true);
    setBusy(false);
  };
  const disabled = busy || !email || (mode === "password" && !password);

  return (
    // data-kit: the sign-in screen is a root of its own (it renders instead of
    // the app, not inside it), so it opts into the kit here.
    <div data-kit style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "var(--bg)" }}>
      {/* .entrance-card is the kit's own sign-in surface: one material, a deep
          shadow, no outline. It carried a 1px line AND a two-part shadow. */}
      {/* animationDelay 0: the kit's .entrance-card holds the card invisible for
          500ms, which is tuned for a shell boot that has already painted. This
          screen IS the first paint. */}
      <div className="entrance-card" style={{ animationDelay: "0s" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 6 }}>
          {/* The ZTS seal. Its brass gradient is the brand mark itself, not a
              theme choice, so the hexes stay literal. */}
          <span style={{ width: 20, height: 20, borderRadius: 6, background: `linear-gradient(135deg, ${T.amberDeep} 0%, #A87C2E 100%)`, boxShadow: "0 2px 6px rgba(184,145,58,0.4)" }} />
          <span className="t-label" style={{ color: "var(--ink)" }}>Zero To Secure</span>
        </div>
        <p className="t-foot" style={{ margin: "0 0 22px" }}>Sign in to the command center.</p>
        <input className="field" value={email} onChange={e => setEmail(e.target.value)} placeholder="email" type="email" autoComplete="email"
          style={inputStyle} />
        {mode === "password" && (
          <input className="field" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === "Enter") signIn(); }} placeholder="password" type="password" autoComplete="current-password"
            style={inputStyle} />
        )}
        {/* The failure names itself and the button beside it IS the retry. */}
        {err && <p className="t-cap" role="alert" style={{ color: T.red, margin: "0 0 10px" }}>{err} — check the details and try again.</p>}
        {sent && <p className="t-cap" style={{ color: "var(--accent)", margin: "0 0 10px" }}>Login link sent — check your email.</p>}
        <button type="button" className="btn md primary full" onClick={mode === "password" ? signIn : sendMagic} disabled={disabled}>
          {busy ? (mode === "password" ? "Signing in…" : "Sending…") : (mode === "password" ? "Sign in" : "Email me a login link")}
        </button>
        <button type="button" className="btn sm plain full" style={{ marginTop: 8 }}
          onClick={() => { setMode(mode === "password" ? "magic" : "password"); setErr(null); setSent(false); }}>
          {mode === "password" ? "Use a magic link instead" : "Use a password instead"}
        </button>
      </div>
    </div>
  );
}

export default function App({ embedded = false }) {
  useGlobalStyles();
  const isMobile = useIsMobile();
  const [view, setView] = useState("mission");
  const [creators, setCreators] = useState([]);
  const [shorts, setShorts] = useState([]);
  const [articles, setArticles] = useState([]);
  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Palette → view handoff: bumping a counter tells the target view to open
  // its composer. A counter (not a flag) so it works even when you're already
  // on that view; the view clears it after consuming so a later remount
  // (navigate away and back) doesn't re-open the composer uninvited.
  const [createSignal, setCreateSignal] = useState({ studio: 0, seo: 0, creators: 0 });
  const signalCreate = (key) => setCreateSignal(s => ({ ...s, [key]: s[key] + 1 }));
  const clearSignal = useCallback((key) => setCreateSignal(s => (s[key] === 0 ? s : { ...s, [key]: 0 })), []);
  const toast = useToast();

  // Cmd/Ctrl+K opens the command palette from anywhere. Skips while typing in
  // a field so it never hijacks a keystroke mid-script or mid-article.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      e.preventDefault();
      setPaletteOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auth gate — this app had none before. Same pattern as Board Room:
  // check for an existing Supabase session on load, and keep listening for
  // sign-in/sign-out. Nothing renders below until this resolves.
  useEffect(() => {
    if (!supabase) { setAuthChecked(true); return; } // unconfigured — see LoginScreen's own messaging
    supabase.auth.getSession().then(({ data }) => { setSession(data.session || null); setAuthChecked(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub?.subscription?.unsubscribe();
  }, []);

  // Load from Supabase on mount — replaces the old synchronous localStorage
  // read. Waits for a real session first: querying before sign-in would
  // just return empty results once RLS requires authentication anyway.
  useEffect(() => {
    if (!supabase || !session?.user) return;
    setDataLoading(true);
    (async () => {
      const [{ data: cr, error: crErr }, { data: sh, error: shErr }, { data: ar, error: arErr }] = await Promise.all([
        supabase.from("creators").select("*").order("created_at", { ascending: false }),
        supabase.from("shorts").select("*").order("created_at", { ascending: false }),
        supabase.from("articles").select("*").order("created_at", { ascending: false }),
      ]);
      if (crErr) console.warn("[App] creators load failed:", crErr.message);
      if (shErr) console.warn("[App] shorts load failed:", shErr.message);
      if (arErr) console.warn("[App] articles load failed:", arErr.message);
      const failed = [crErr && "creators", shErr && "Shorts", arErr && "articles"].filter(Boolean);
      if (failed.length) toast.push(`Couldn't load ${failed.join(", ")} — check your connection and refresh.`, { tone: "error" });
      setCreators(cr || []);
      setShorts(sh || []);
      setArticles(ar || []);
      setDataLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  const addArticle = async (a) => {
    // Callers (e.g. the auto-draft cadence below) still build a client-side
    // id/created_at out of habit from the old localStorage shape — strip them
    // so Supabase generates its own UUID/timestamp instead of rejecting a
    // non-UUID string in the id column.
    const { id: _id, created_at: _ca, ...fields } = a;
    if (!supabase) { setArticles(prev => [{ id: `local_${Date.now()}`, created_at: new Date().toISOString(), ...fields }, ...prev]); return; }
    const { data, error: err } = await supabase.from("articles").insert(fields).select();
    if (err) { console.warn("[addArticle] insert failed:", err.message); return; }
    if (data?.[0]) setArticles(prev => [data[0], ...prev]);
  };

  // Sliding tab indicator — measured from the active tab's DOM position so the
  // white pill glides between tabs instead of teleporting.
  const tabRefs = useRef({});
  const [tabIndicator, setTabIndicator] = useState({ left: 0, width: 0, ready: false });
  useLayoutEffect(() => {
    const measure = () => {
      const el = tabRefs.current[view];
      if (!el) return;
      setTabIndicator({ left: el.offsetLeft, width: el.offsetWidth, ready: true });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [view, isMobile, authChecked, session]);

  // Command palette actions — tabs, quick creates, live records. Rebuilt each
  // render; the list is small and the handlers aren't stable refs anyway.
  const paletteActions = (() => {
    const acts = [];
    // The palette's copy of this map is what shipped SEO/DNA correctly here and
    // nowhere else. It now reads the hoisted one, so the palette entry and the
    // pill it navigates to cannot say different words again.
    TABS.forEach(t => acts.push({ id: `nav_${t}`, group: "Go to", icon: "→", label: tabLabel(t), run: () => setView(t) }));
    acts.push({ id: "act_short", group: "Create", icon: "✦", label: "New Short", sub: "Generate a full Shorts package", run: () => { signalCreate("studio"); setView("studio"); } });
    acts.push({ id: "act_article", group: "Create", icon: "✦", label: "New Article", sub: "Draft an SEO article into review", run: () => { signalCreate("seo"); setView("seo"); } });
    acts.push({ id: "act_creator", group: "Create", icon: "+", label: "Add Creator", sub: "Add a YouTube creator to the pipeline", run: () => { signalCreate("creators"); setView("creators"); } });
    acts.push({ id: "act_pass", group: "Action", icon: "⚡", label: "Run engine pass now", run: () => { sm.set("engine_force_pass", true); eng.set({ running: true }); } });
    creators.slice(0, 200).forEach(c => c.channel_name && acts.push({ id: `cr_${c.id}`, group: "Creator", icon: "▸", label: c.channel_name, sub: `${fmtSubs(c.subscriber_count)} subs · ${c.stage || "prospected"}`, run: () => setView("creators") }));
    shorts.slice(0, 200).forEach(s => acts.push({ id: `sh_${s.id}`, group: "Short", icon: "▸", label: s.title || s.topic || "Untitled Short", sub: s.stage, run: () => setView("studio") }));
    articles.slice(0, 100).forEach(a => acts.push({ id: `ar_${a.id}`, group: "Article", icon: "▸", label: a.title_tag || a.keyword || "Untitled", sub: a.stage, run: () => setView("seo") }));
    return acts;
  })();

  if (!embedded && !authChecked) return (
    // data-kit: the boot gate is its own root, and .spinner is the kit's drawn
    // arc — including its reduced-motion stop, which a hand-rolled
    // `animation: spin infinite` does not get.
    <div data-kit style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
      <span className="spinner" role="status" aria-label="Checking your session" style={{ width: "32px", height: "32px" }} />
    </div>
  );
  if (!embedded && !session) return <LoginScreen />;

  return (
    // data-kit: ZTS opts into the shared kit HERE, on its own root. It renders
    // inside the shell's tool slot, so every [data-kit] rule in
    // packages/ui/components.css reaches this app and nothing else — the same
    // rule the shell follows by keeping data-kit off the wrapper that holds
    // every tool.
    <div data-kit style={{ minHeight: "100vh", fontFamily: "var(--font-body)", paddingBottom: isMobile ? "calc(60px + var(--safe-bottom))" : 0 }}>
      <AgentEngine creators={creators} shorts={shorts} articles={articles} onArticleDraft={addArticle} />
      <DnaWorker creators={creators} shorts={shorts} articles={articles} onArticleDraft={addArticle} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} actions={paletteActions} />
      {/* each tool owns its own ⌘K palette; the shell does not capture ⌘K */}
      {!(embedded && isMobile) && (
      // Glass bar: a hairline edge and NOTHING else. It used to draw the
      // hairline AND a two-part drop shadow, which is the border-plus-shadow
      // pair the language forbids — the same fix Macro's bar took.
      <div style={{ borderBottom: `1px solid ${T.line}`, padding: isMobile ? "0 16px" : "0 24px", height: "52px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: embedded ? "var(--shell-bar, 52px)" : 0, background: "var(--glass, rgba(11,15,26,0.78))", backdropFilter: "blur(20px) saturate(140%)", WebkitBackdropFilter: "blur(20px) saturate(140%)", zIndex: 50 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          {!embedded && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            {/* The ZTS mark — brand, not theme, so the gradient stays literal. */}
            <span style={{ width: "18px", height: "18px", borderRadius: "5px", background: "linear-gradient(135deg, #12B886 0%, #0A7A54 100%)", boxShadow: "0 1px 3px rgba(10,122,84,0.4), inset 0 1px 0 rgba(255,255,255,0.25)", display: "inline-block" }} />
            <span className="t-label" style={{ color: T.inkDeep }}>Zero To Secure</span>
          </span>
          )}
          {!isMobile && (
            // The kit's segmented control. The sliding pill is .seg-thumb, still
            // measured off the active tab's offsetLeft/offsetWidth exactly as
            // before — the kit already animates left/width, so the only thing
            // that changed is who owns the geometry.
            <div className="seg" role="tablist" style={{ marginLeft: "12px", minWidth: 320 }}>
              {tabIndicator.ready && (
                <div className="seg-thumb" style={{ left: `${tabIndicator.left}px`, width: `${tabIndicator.width}px`, zIndex: 0 }} />
              )}
              {TABS.map(t => (
                <button key={t} type="button" role="tab" aria-selected={view === t} ref={el => { tabRefs.current[t] = el; }} onClick={() => setView(t)}
                  className={view === t ? "seg-opt active" : "seg-opt"}>{tabLabel(t)}</button>
              ))}
            </div>
          )}
        </div>
        {!isMobile && !embedded && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button type="button" className="btn sm quiet" onClick={() => setPaletteOpen(true)} title="Command palette (⌘K)" style={{ fontFamily: mono }}>⌘K</button>
            <button type="button" className="btn sm quiet" onClick={() => supabase?.auth.signOut()}>Sign out</button>
          </div>
        )}
      </div>
      )}
      {view === "mission" && <MissionView creators={creators} shorts={shorts} onNavigate={setView} isMobile={isMobile} loading={dataLoading} />}
      {view === "creators" && <CreatorsView creators={creators} setCreators={setCreators} isMobile={isMobile} loading={dataLoading} openSignal={createSignal.creators} onSignalConsumed={() => clearSignal("creators")} />}
      {view === "studio" && <StudioView shorts={shorts} setShorts={setShorts} isMobile={isMobile} loading={dataLoading} openSignal={createSignal.studio} onSignalConsumed={() => clearSignal("studio")} />}
      {view === "seo" && <SeoView articles={articles} setArticles={setArticles} onAddArticle={addArticle} isMobile={isMobile} loading={dataLoading} openSignal={createSignal.seo} onSignalConsumed={() => clearSignal("seo")} />}
      {view === "dna" && <DnaView creators={creators} shorts={shorts} articles={articles} onArticleDraft={addArticle} />}
      {isMobile && <BottomNav view={view} setView={setView} tabs={TABS} />}
    </div>
  );
}
