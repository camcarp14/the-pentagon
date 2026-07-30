import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { T, selectBase } from "./theme";
import { EmptyState, SkeletonLine, SkeletonRows, CommandPalette, useToast } from "./ui.jsx";
import { SAFE_SEND_ADDRESS } from "./config.js";
import { sm } from "./lib/store.js";
import { sbAuth, db, currentAccessToken } from "./lib/supabase.js";
import { auth as shellAuth } from "@cc/supabase";
import { sendMode, checkForReplies, generateReplyDraft } from "./lib/email.js";
import { estimateValue, getProspectPriority, groupCardsByEmail, buildDuplicateMap } from "./lib/leads.js";
import { runProspecting, enrichProspect, generateDraft } from "./lib/prospecting.js";
import { AgentEngine } from "./lib/engine.js";
import { DnaWorker } from "./lib/dnaWorker.js";
import { LoginScreen } from "./features/auth/LoginScreen.jsx";
import { OutreachCard, ToneMemoryPanel } from "./features/outreach/OutreachCard.jsx";
import { KanbanColumn, ChainGroup, BulkActionsBar, UndoToast, ShortcutHelp, DailyPlays, PipelineFunnel, ReplyTriageSummary } from "./features/outreach/OutreachBoard.jsx";
import { InboundView } from "./features/inbound/InboundView.jsx";
import { AnalystView } from "./features/analyst/AnalystView.jsx";
import { ClientsView } from "./features/clients/ClientsView.jsx";
import { GlobalAgent } from "./features/system/GlobalAgent.jsx";
import { SettingsView } from "./features/system/SettingsView.jsx";
import { MissionControl } from "./features/mission/MissionControl.jsx";
import { CalendarView } from "./features/calendar/CalendarView.jsx";
import { QueueView } from "./features/queue/QueueView.jsx";
import { SequencesView } from "./features/sequences/SequencesView.jsx";
import { AnalyticsView } from "./features/analytics/AnalyticsView.jsx";
import { DnaView } from "./features/dna/DnaView.jsx";
import { useSequenceEngine } from "./lib/engineLoop.js";
import { seqDb } from "./lib/sequenceDb.js";
import { classifyReplyAI } from "./lib/classify.js";

const ROUTABLE_VIEWS = ["mission", "analytics", "inbound", "outreach", "queue", "sequences", "analyst", "clients", "dna", "calendar", "settings"];
const parseHash = () => {
  const seg = (window.location.hash || "").replace(/^#\/?/, "").split("/");
  return { view: ROUTABLE_VIEWS.includes(seg[0]) ? seg[0] : "mission", sub: seg[1] ? decodeURIComponent(seg[1]) : null };
};

// ─── Navigation model ─────────────────────────────────────────────────────────
// Five top-level tabs. Legacy views stay hash-routable (#/analyst still works);
// they just light up their parent tab and render under its sub-nav.
const NAV_TABS = [
  { key: "mission", label: "Today", icon: "◉", views: ["mission", "analytics"] },
  { key: "outreach", label: "Outreach", icon: "⇢", views: ["outreach", "queue", "sequences", "calendar"] },
  { key: "inbound", label: "Inbound", icon: "✦", views: ["inbound"] },
  { key: "clients", label: "Clients", icon: "▣", views: ["clients", "analyst"] },
  { key: "dna", label: "DNA", icon: "⌬", views: ["dna"] },
  { key: "system", label: "Settings", icon: "⚙", views: ["settings"] },
];
const SUB_NAVS = {
  mission: [{ view: "mission", label: "Today" }, { view: "analytics", label: "Analytics" }],
  outreach: [{ view: "outreach", label: "Pipeline" }, { view: "queue", label: "Queue" }, { view: "sequences", label: "Sequences" }, { view: "calendar", label: "Calendar" }],
  clients: [{ view: "clients", label: "Accounts" }, { view: "analyst", label: "Analyst" }],
};
const tabForView = (view) => NAV_TABS.find(t => t.views.includes(view))?.key || "mission";

// Header pill: the one place send mode lives. Click to flip; going live asks once.
function SendModePill() {
  const [live, setLive] = useState(() => sendMode.isLive());
  const [confirming, setConfirming] = useState(false);
  const flip = () => {
    if (live) { sendMode.setLive(false); setLive(false); setConfirming(false); return; }
    if (!confirming) { setConfirming(true); return; }
    sendMode.setLive(true); setLive(true); setConfirming(false);
  };
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(t);
  }, [confirming]);
  return (
    <button onClick={flip}
      title={live ? "Emails go to real prospects. Click to return to safe mode." : `Safe mode: every send reroutes to ${SAFE_SEND_ADDRESS}. Click twice to go live.`}
      style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "5px 12px", borderRadius: T.rPill, cursor: "pointer", fontSize: "10px", fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: T.fontDisplay,
        border: `1px solid ${live ? "rgba(248,113,113,0.4)" : "rgba(245,184,77,0.35)"}`,
        background: live ? "rgba(248,113,113,0.1)" : "rgba(245,184,77,0.1)",
        color: live ? T.red : T.amber }}>
      <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: live ? T.red : T.amberHi, animation: live ? "pulse 2s infinite" : "none" }} />
      {confirming ? "Send real emails?" : live ? "Live sending" : "Safe mode"}
    </button>
  );
}

// Sub-nav rendered under the header for tabs that hold two views.
function SubNav({ tab, currentView, onNavigate }) {
  const items = SUB_NAVS[tab];
  if (!items) return null;
  return (
    <div className="co-subnav" style={{ display: "flex", gap: "4px", padding: "10px 28px 0" }}>
      {items.map(it => (
        <button key={it.view} onClick={() => onNavigate(it.view)}
          style={{ padding: "6px 16px", borderRadius: T.rPill, border: `1px solid ${currentView === it.view ? T.line : "transparent"}`, background: currentView === it.view ? T.raised : "transparent", color: currentView === it.view ? T.inkDeep : T.muted, fontSize: "11.5px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay, boxShadow: currentView === it.view ? T.shadowTab : "none" }}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

// Mobile bottom tab bar — icon-only, hidden on desktop via CSS.
function BottomBar({ activeTab, onTab, inboundNew }) {
  return (
    // Canonical bottom-bar geometry — must stay identical to ZTS, Runway and
    // Macro (see the note on ZTS's BottomNav) or the bar changes height when you
    // switch tools.
    <div className="co-bottombar" style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 400, display: "none", background: "rgba(11,15,26,0.92)", backdropFilter: "blur(20px) saturate(140%)", WebkitBackdropFilter: "blur(20px) saturate(140%)", borderTop: `1px solid ${T.line}`, boxShadow: "0 -2px 16px rgba(0,0,0,0.4)", padding: "4px 6px max(10px, calc(6px + var(--safe-bottom, 0px)))" }}>
      <div style={{ display: "flex" }}>
        {NAV_TABS.map(t => {
          const on = activeTab === t.key;
          return (
            <button key={t.key} onClick={() => onTab(t)} title={t.label} aria-label={t.label} style={{ flex: 1, minHeight: 46, padding: "8px 2px 7px", background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "3px", position: "relative" }}>
              <span style={{ fontSize: "21px", lineHeight: 1, color: on ? T.gold : T.faint }}>{t.icon}</span>
              <span style={{ fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", fontFamily: T.fontDisplay, color: on ? T.gold : T.faint }}>{t.label}</span>
              {t.key === "inbound" && inboundNew > 0 && <span style={{ position: "absolute", top: "4px", right: "50%", marginRight: "-18px", fontSize: "8px", fontWeight: 800, color: "#1A0A12", background: T.pink, borderRadius: T.rPill, padding: "1px 5px" }}>{inboundNew}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function App({ embedded = false }) {
  const [currentView, setCurrentView] = useState(() => parseHash().view);
  const [routeSub, setRouteSub] = useState(() => parseHash().sub);

  // hash → state: browser back/forward, manual URL edits, in-view sub changes
  useEffect(() => {
    const onHash = () => { const h = parseHash(); setCurrentView(h.view); setRouteSub(h.sub); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // state → hash: tab clicks; never stomps a same-view sub like /clients/<id>
  useEffect(() => {
    if (parseHash().view !== currentView) window.location.hash = `/${currentView}`;
  }, [currentView]);

  // Synchronous on purpose: a useState initializer cannot await, and this only
  // seeds first paint. The mount effect below replaces it with the live session.
  const [authToken, setAuthToken] = useState(() => localStorage.getItem("clarify_token") || null);
  const [authChecked, setAuthChecked] = useState(false);
  const [cards, setCards] = useState([]);
  const [inboundNew, setInboundNew] = useState(0);
  useEffect(() => {
    let alive = true;
    const loadInbound = async () => {
      if (typeof document !== "undefined" && document.hidden) return; // no polling in background tabs
      try { const r = await db.getInboundNewCount(); if (alive) setInboundNew(r ? r.length : 0); } catch {}
    };
    loadInbound();
    const iv = setInterval(loadInbound, 30000);
    return () => { alive = false; clearInterval(iv); };
  }, []);
  const [toneMemory, setToneMemory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState("all");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [prospecting, setProspecting] = useState(false);
  const [checkingReplies, setCheckingReplies] = useState(false);
  const [prospectStatus, setProspectStatus] = useState("");
  const [sortBy, setSortBy] = useState("adsFirst");  // ads-live prospects surface first by default
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [quickFilters, setQuickFilters] = useState({ adsLive: false, hot: false, untouched: false });
  const [searchQuery, setSearchQuery] = useState("");
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [batchProgress, setBatchProgress] = useState("");
  const [selectedCards, setSelectedCards] = useState(new Set());

  const toggleCardSelect = (id) => setSelectedCards(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Round 4: undo + keyboard shortcut state
  const [undoState, setUndoState] = useState(null); // { message, restore }
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const toast = useToast();

  // Sequence engine: computes due steps while the app is open and DRAFTS them
  // into the approval queue. It never sends — sending is always a human click.
  useSequenceEngine({ cards, toneMemory, enabled: !!authToken });

  // Cmd/Ctrl+K opens the command palette from anywhere in the app. Skips while
  // typing in a field — same guard as the ?/Escape shortcut below — so it never
  // hijacks a keystroke mid-draft in one of the many compose textareas.
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

  // Bulk status change with undo — snapshots prior statuses so it can be reversed
  const bulkStatusChange = async (status, label) => {
    const ids = Array.from(selectedCards);
    if (ids.length === 0) return;
    const prior = ids.map(id => { const c = cards.find(x => x.id === id); return { id, status: c?.status }; });
    for (const id of ids) await handleStatusChange(id, status);
    setSelectedCards(new Set());
    setUndoState({
      message: `${ids.length} ${label}`,
      restore: async () => { for (const p of prior) if (p.status) await handleStatusChange(p.id, p.status); setUndoState(null); },
    });
  };

  // Keyboard shortcuts (only on outreach view)
  useEffect(() => {
    const onKey = (e) => {
      if (currentView !== "outreach") return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key === "?") { e.preventDefault(); setShowShortcuts(s => !s); }
      else if (e.key === "Escape") { setSelectedCards(new Set()); setShowShortcuts(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentView]);

  // Cross-tab handoff: Inbound's "View in Outreach" / Clients' origin trail set a
  // focus target; landing on Outreach consumes it once as the search query.
  useEffect(() => {
    if (currentView !== "outreach") return;
    const f = sm.get("outreach_focus");
    if (f) { setSearchQuery(String(f)); sm.del("outreach_focus"); }
  }, [currentView]);

  useEffect(() => {
    // Fonts load from index.html; this injects only the global stylesheet.
    const style = document.createElement("style");
    style.textContent = `
      *, *::before, *::after { box-sizing: border-box; }
      * { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }
      html, body { margin: 0; font-family: 'Inter', system-ui, sans-serif; }
      /* Midnight canvas — deep blue-black with the brand's dual "desk lamp"
         radial glow: brass top-left, cool blue top-right. The dark cut of the
         same signature the light era had. */
      body {
        background-color: #0B0F1A;
        background-image:
          radial-gradient(1200px 600px at 12% -8%, rgba(201,165,87,0.07), transparent 60%),
          radial-gradient(1000px 700px at 100% 0%, rgba(110,168,254,0.05), transparent 55%);
        background-attachment: fixed;
        color-scheme: dark;
      }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 10px; border: 2px solid transparent; background-clip: padding-box; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.24); background-clip: padding-box; }
      textarea, input, select, button { font-family: 'Inter', system-ui, sans-serif; }
      ::selection { background: rgba(201,165,87,0.32); color: #F7F9FC; }
      /* Global micro-interactions — everything interactive eases */
      button, a, [role="button"], input, select, textarea { transition: background-color 0.16s ease, border-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease, transform 0.12s ease, opacity 0.16s ease; }
      button:not(:disabled):active { transform: translateY(0.5px); }
      /* Refined focus rings — accessible but elegant */
      button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(201,165,87,0.45); }
      input::placeholder, textarea::placeholder { color: #5A6780; }
      select, option { background-color: #0F1626; color: #E9EDF5; }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
      @keyframes fadein { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
      @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
      @keyframes toastIn { from { opacity: 0; transform: translateX(18px) scale(0.97); } to { opacity: 1; transform: none; } }
      @keyframes toastOut { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateX(18px) scale(0.97); } }
      @keyframes toastShrink { from { transform: scaleX(1); } to { transform: scaleX(0); } }
      @keyframes paletteIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: none; } }
      @keyframes cardIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
      }

      /* ── Responsive layer ─────────────────────────────────────────────────
         The app styles inline; these class-keyed overrides adapt structure at
         two breakpoints so the same interface feels native on a phone. */
      .co-scroll-x { scrollbar-width: none; }
      .co-scroll-x::-webkit-scrollbar { display: none; }

      /* Standalone PWA (added to home screen): no browser chrome, so the
         header needs to clear the notch/status bar itself. */
      @media (display-mode: standalone) {
        .co-nav { padding-top: env(safe-area-inset-top) !important; height: calc(52px + env(safe-area-inset-top)) !important; }
      }

      @media (max-width: 1080px) {
        .co-grid4 { grid-template-columns: repeat(2, 1fr) !important; }
        .co-grid5 { grid-template-columns: repeat(3, 1fr) !important; }
      }

      @media (max-width: 860px) {
        /* Header: logo + actions only; navigation moves to the bottom bar */
        .co-nav { padding: 0 16px !important; height: 50px !important; }
        .co-nav-tabs { display: none !important; }
        .co-signout { display: none !important; }
        .co-bottombar { display: block !important; }
        .co-subnav { padding: 10px 16px 0 !important; }

        /* Views get a little more room than a cramped edge-to-edge 14px would give */
        .co-viewwrap > div { padding-left: 16px !important; padding-right: 16px !important; padding-bottom: 96px !important; }

        /* Grids collapse to a single column */
        .co-grid2 { grid-template-columns: 1fr !important; }
        .co-grid3 { grid-template-columns: 1fr !important; }
        .co-grid-side { grid-template-columns: 1fr !important; }
        .co-inbound-grid { grid-template-columns: 1fr !important; }
        .co-grid5 { grid-template-columns: repeat(2, 1fr) !important; }
        .co-funnel { display: grid !important; grid-template-columns: repeat(2, 1fr) !important; }

        /* A consistent, slightly more generous gap across every collapsed grid */
        .co-grid2, .co-grid4, .co-grid5, .co-grid-side, .co-inbound-grid, .co-funnel, .co-portfolio-bar { gap: 12px !important; }

        /* Sidebars that "stick" on desktop just stack in normal flow on mobile */
        .co-sticky-side { position: static !important; top: auto !important; }

        /* Portfolio stat row (Clients tab): wrap into 2x2, Add button gets its own row */
        .co-portfolio-bar { flex-wrap: wrap !important; }
        .co-portfolio-card { min-width: calc(50% - 6px) !important; flex: none !important; }
        .co-portfolio-bar > button { width: 100%; order: 5; margin-top: 2px; }

        /* Kanban: edge-to-edge snap columns */
        .co-kanban { scroll-snap-type: x mandatory; gap: 12px !important; margin: 0 -16px; padding: 0 16px 32px !important; }
        .co-kcol { min-width: 84vw !important; max-width: 84vw !important; scroll-snap-align: start; }

        /* Toolbars become one-line horizontal scrollers */
        .co-toolbar { flex-wrap: nowrap !important; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; margin: 0 -16px 14px; padding: 0 16px; }
        .co-toolbar::-webkit-scrollbar { display: none; }
        .co-toolbar > input { min-width: 150px !important; flex: 0 0 auto !important; }
        .co-scroll-x { flex-wrap: nowrap !important; overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 -16px 16px; padding: 0 16px; }

        /* Floating layers clear the bottom bar */
        .co-agent-root { bottom: calc(68px + var(--safe-bottom)) !important; right: 12px !important; }
        .co-agent-panel { width: calc(100vw - 24px) !important; height: min(520px, 72vh) !important; }
        .co-bulkbar { bottom: calc(76px + var(--safe-bottom)) !important; max-width: calc(100vw - 20px); flex-wrap: wrap; justify-content: center; }
        .co-undo { bottom: calc(76px + var(--safe-bottom)) !important; left: 12px !important; }

        /* Modals become bottom sheets — slide up from the edge instead of
           floating as a letterboxed card with wasted margin on every side. */
        .co-modal-overlay { align-items: flex-end !important; padding: 0 !important; }
        .co-modal-sheet { width: 100% !important; max-width: 100% !important; max-height: 88vh !important; margin: 0 !important; border-radius: 20px 20px 0 0 !important; padding-bottom: max(16px, var(--safe-bottom)) !important; animation: sheetup 0.22s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
        @keyframes sheetup { from { transform: translateY(28px); opacity: 0.5; } to { transform: translateY(0); opacity: 1; } }

        /* Every input gets a real 16px+ so iOS Safari doesn't zoom the page on focus */
        input, textarea, select { font-size: 16px !important; }

        /* Icon-only buttons (delete, close) get a real touch target, not just their glyph's box */
        .co-icon-btn, .co-modal-close { min-width: 40px !important; min-height: 40px !important; display: inline-flex !important; align-items: center; justify-content: center; padding: 0 !important; }
        .co-modal-close { font-size: 26px !important; }

        /* Inbound master-detail: the list makes way for the open conversation instead of stacking above it */
        .co-hide-when-detail { display: none !important; }
        .co-mobile-only { display: flex !important; }
        .co-desktop-only { display: none !important; }

        /* Removes the native pull-to-refresh bounce so the PWA doesn't fight your own scroll views */
        body { overscroll-behavior-y: contain; }
      }

      /* Outside any breakpoint — harmless on desktop, removes the gray tap
         flash and 300ms double-tap delay on touch devices everywhere. */
      button, a, [role="button"] { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
      .co-mobile-only { display: none; }

      @media (max-width: 560px) {
        .co-grid4 { grid-template-columns: 1fr !important; }
        .co-grid5 { grid-template-columns: repeat(2, 1fr) !important; }
        .co-funnel { grid-template-columns: repeat(2, 1fr) !important; }
        .co-kcol { min-width: 88vw !important; max-width: 88vw !important; }
        .co-portfolio-card { min-width: 100% !important; }
      }
    `;
    document.head.appendChild(style);
  }, []);

  // Stay signed in. Clarify does NOT renew the session — supabase-js does, and
  // it is the only thing that may, because Supabase refresh tokens are
  // single-use and a second exchanger revokes the first one's token (which is
  // how a Clarify renewal used to sign you out of every Pentagon tool at once).
  const persistSession = (session) => {
    localStorage.setItem("clarify_token", session.access_token);
    if (session.refresh_token) localStorage.setItem("clarify_refresh", session.refresh_token);
    setAuthToken(session.access_token);
  };

  useEffect(() => {
    // Ask supabase-js for the session. getSession() transparently refreshes a
    // near-expired token using ITS copy of the refresh token, so the expired
    // case is handled without Clarify ever exchanging one itself. This replaced
    // a getUser()-then-sbAuth.refresh() ladder that was the second exchanger.
    let cancelled = false;
    (async () => {
      let session = null;
      try { session = await shellAuth.getSession(); } catch { /* standalone */ }
      if (cancelled) return;
      if (session?.access_token) {
        persistSession(session);
      } else {
        // No live session: clear the mirror rather than leaving a stale bearer
        // that would 401 on the next request.
        localStorage.removeItem("clarify_token");
        localStorage.removeItem("clarify_refresh");
        setAuthToken(null);
      }
      setAuthChecked(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // The 45-minute renewal timer that used to live here is GONE, deliberately.
  //
  // Supabase refresh tokens are single-use: exchanging one revokes it. This timer
  // refreshed against the mirrored `clarify_refresh` while supabase-js — the
  // shell's session of record, shared by all five tools — ran its own renewal on
  // the same underlying session. Whichever fired first revoked the other's token.
  // When supabase-js lost that race its next auto-refresh failed, it emitted
  // SIGNED_OUT, and the shell dropped you out of EVERY Pentagon tool mid-session.
  //
  // supabase-js is now the only thing that refreshes, and lib/supabase.js resolves
  // the bearer from it at call time (see currentAccessToken there), which also
  // covers the expiry case this timer was written to prevent.

  const handleLogout = async () => {
    const token = await currentAccessToken();
    if (token) await sbAuth.signOut(token).catch(() => {});
    localStorage.removeItem("clarify_token");
    localStorage.removeItem("clarify_refresh");
    setAuthToken(null);
  };

  const loadData = useCallback(async () => {
    try {
      const [boardData, toneData] = await Promise.all([db.getOutreachBoard(), db.getToneMemory()]);
      setCards(boardData || []);
      setToneMemory(toneData || []);
    } catch (err) {
      console.error("Load error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const handleProspect = async () => {
    setProspecting(true);
    setProspectStatus("Starting prospecting run…");
    try {
      // Exclude ALL existing place IDs — including rejected and snoozed — to prevent re-pulling
      const existingIds = new Set(cards.map((c) => c.prospect?.google_place_id).filter(Boolean));
      const existingDomains = new Set(cards.map((c) => c.prospect?.website).filter(Boolean));
      const results = await runProspecting(existingIds, setProspectStatus, existingDomains, toneMemory);
      setProspectStatus(`Done — ${results.added} added, ${results.enriched} enriched, ${results.drafted} drafted, ${results.skipped} skipped`);
      toast.push(`Prospecting done — ${results.added} added, ${results.drafted} drafted.`, { tone: "success" });
      await loadData();
    } catch (err) {
      setProspectStatus("Error: " + err.message);
      toast.push("Prospecting run failed: " + err.message, { tone: "error" });
    }
    setProspecting(false);
    setTimeout(() => setProspectStatus(""), 6000);
  };

  const handleCheckReplies = async () => {
    setCheckingReplies(true);
    try {
      const sentCards = cards.filter((c) => c.status === "sent" && c.gmail_thread_id);
      if (sentCards.length === 0) {
        setProspectStatus("No sent emails with thread IDs to check");
        toast.push("No sent emails with thread IDs to check yet.");
        setTimeout(() => setProspectStatus(""), 3000);
        setCheckingReplies(false);
        return;
      }
      const replies = await checkForReplies(sentCards);
      if (replies.length === 0) {
        setProspectStatus("No new replies found");
        toast.push("No new replies found.");
        setTimeout(() => setProspectStatus(""), 3000);
      } else {
        for (const reply of replies) {
          const card = sentCards.find((c) => c.gmail_thread_id === reply.threadId);
          if (card) {
            await db.markReplied(card.id, reply);

            // Ledger: record the inbound message (the thread's source of truth).
            let inboundMsg = null;
            try {
              inboundMsg = await seqDb.insertMessage({
                outreach_id: card.id, direction: "inbound", kind: "reply",
                subject: reply.subject || null, body: reply.body || null, status: "received",
                gmail_message_id: reply.messageId || null, gmail_thread_id: reply.threadId || null,
              });
            } catch {}

            // Classify + suggest. The suggestion is a DRAFT — it lands in the
            // approval queue and (legacy dual-write) on the card's reply_draft.
            const cls = await classifyReplyAI({
              replyBody: reply.body, replyFrom: reply.from,
              originalSubject: card.draft_subject, originalBody: card.draft_body,
              prospect: card.prospect || {}, toneMemory,
            });
            try {
              await db.updateOutreach(card.id, {
                reply_classification: cls.classification,
                reply_classification_confidence: cls.confidence,
                reply_classification_source: cls.source,
              });
              if (inboundMsg?.id) {
                await seqDb.updateMessage(inboundMsg.id, {
                  classification: cls.classification,
                  classification_confidence: cls.confidence,
                  classification_source: cls.source,
                  classified_at: new Date().toISOString(),
                });
              }
            } catch {}

            const draft = cls.suggested || await generateReplyDraft(
              { subject: card.draft_subject, body: card.draft_body },
              reply,
              card.prospect || {},
              toneMemory
            );
            await db.saveReplyDraft(card.id, draft.subject, draft.body);
            try {
              await seqDb.insertMessage({
                outreach_id: card.id, direction: "outbound", kind: "reply",
                subject: draft.subject, body: draft.body, status: "draft",
                gmail_thread_id: reply.threadId || null,
                meta: { classification: cls.classification, source: cls.source },
              });
            } catch {}
          }
        }
        setProspectStatus(`✓ ${replies.length} new repl${replies.length === 1 ? "y" : "ies"} — check the Replied tab`);
        toast.push(`${replies.length} new repl${replies.length === 1 ? "y" : "ies"} — drafts are ready in the Replied column.`, { tone: "success" });
        await loadData();
        setTimeout(() => setProspectStatus(""), 5000);
      }
    } catch (err) {
      setProspectStatus("Error checking replies: " + err.message);
      toast.push("Couldn't check replies: " + err.message, { tone: "error" });
      setTimeout(() => setProspectStatus(""), 4000);
    }
    setCheckingReplies(false);
  };

  const handleStatusChange = async (id, status) => {
    await db.updateOutreach(id, {
      status,
      ...(status === "rejected" ? { rejected_at: new Date().toISOString() } : {}),
    });
    setCards((prev) => prev.map((c) => c.id === id ? { ...c, status } : c));
  };

  const handleDraftRegenerate = async (id, subject, body) => {
    await db.updateOutreach(id, { draft_subject: subject, draft_body: body, status: "draft" });
    setCards((prev) => prev.map((c) => c.id === id ? { ...c, draft_subject: subject, draft_body: body, status: "draft" } : c));
  };

  const handleBatchGenerate = async () => {
    const pool = cards.filter(c => ["prospected","draft","draft_ready"].includes(c.status));
    const targets = selectedCards.size > 0
      ? pool.filter(c => selectedCards.has(c.id))
      : pool.filter(c => !c.draft_subject);
    if (targets.length === 0) return;
    setBatchGenerating(true);
    for (let i = 0; i < targets.length; i++) {
      const card = targets[i];
      setBatchProgress(`${i + 1} / ${targets.length}`);
      try {
        const draft = await generateDraft(card.prospect || {}, card.contact || {}, toneMemory);
        await handleDraftRegenerate(card.id, draft.subject || "", draft.body || "");
      } catch {}
      await new Promise(r => setTimeout(r, 400));
    }
    setBatchProgress("");
    setSelectedCards(new Set());
    setBatchGenerating(false);
  };

  const handleEnrich = async (card) => {
    setProspectStatus(`Enriching ${card.prospect?.business_name}…`);
    try {
      const result = await enrichProspect(card, setProspectStatus);
      if (result.success) {
        const parts = [];
        if (result.email) parts.push("email found");
        if (result.hasBrief) parts.push("research brief built");
        if (result.hasWebContext) parts.push("site scraped");
        setProspectStatus(`✓ ${card.prospect?.business_name} — ${parts.join(", ") || "enriched"}`);
        toast.push(`${card.prospect?.business_name} enriched — ${parts.join(", ") || "done"}.`, { tone: "success" });
        await loadData();
      } else {
        setProspectStatus(`Could not enrich: ${result.reason}`);
        toast.push(`Couldn't enrich ${card.prospect?.business_name}: ${result.reason}`, { tone: "warning" });
      }
    } catch (err) {
      setProspectStatus("Enrichment failed: " + err.message);
      toast.push("Enrichment failed: " + err.message, { tone: "error" });
    }
    setTimeout(() => setProspectStatus(""), 4000);
  };

  // Every card-level send funnels through here. `sent` carries what was ACTUALLY
  // emailed ({kind, subject, body}) so the ledger never records the initial
  // draft text for a follow-up or reply send.
  const handleMarkSent = async (id, messageId, threadId, rfcMessageId, sent = {}) => {
    const card = cards.find((c) => c.id === id);
    const isFollowUp = !!card?.sent_at;
    const kind = sent.kind || (isFollowUp ? "followup" : "initial");
    await db.markSent(id, messageId, threadId, rfcMessageId, { initial: !isFollowUp });

    // Ledger dual-write: the messages table is the thread's source of truth
    // for the sequence engine and analytics; legacy columns stay for the
    // Kanban lenses.
    try {
      await seqDb.insertMessage({
        outreach_id: id,
        direction: "outbound",
        kind,
        subject: sent.subject ?? card?.draft_subject ?? null,
        body: sent.body ?? (kind === "initial" ? card?.draft_body : null) ?? null,
        status: "sent",
        sent_at: new Date().toISOString(),
        gmail_message_id: messageId || null,
        gmail_thread_id: threadId || null,
        gmail_rfc_message_id: rfcMessageId || null,
      });
    } catch {}

    // A human just touched this thread — any queued drafts for it are stale
    // (the engine re-evaluates on the new timeline next pass). This is what
    // prevents the double-send: card-sent bump + queue-approved bump.
    try {
      const pending = await seqDb.getMessagesFor([id]);
      for (const m of pending || []) {
        if (m.direction === "outbound" && m.status === "draft") {
          await seqDb.updateMessage(m.id, { status: "superseded" });
        }
      }
    } catch {}

    // First send auto-enrolls the thread in the default active sequence — the
    // engine then drafts each due follow-up INTO THE APPROVAL QUEUE (it never
    // sends). This replaces the old hardcoded CADENCE ladder, whose touch
    // counter was broken and never advanced.
    if (!isFollowUp) {
      try {
        const existing = await seqDb.getEnrollments(["active", "paused"]);
        if (!existing.some((e) => e.outreach_id === id)) {
          const sequences = await seqDb.getSequences();
          const def = (sequences || []).find((s) => s.is_active);
          if (def) await seqDb.enroll(id, def.id);
        }
      } catch {}
    }

    setCards((prev) => prev.map((c) => c.id === id ? { ...c, status: "sent", sent_at: c.sent_at || new Date().toISOString(), gmail_message_id: messageId, gmail_thread_id: threadId, gmail_rfc_message_id: rfcMessageId } : c));
  };

  const handleToneFeedback = async (feedback, outreachId) => {
    await db.addToneMemory(feedback, outreachId);
    const updated = await db.getToneMemory();
    setToneMemory(updated || []);
  };

  const handleToneDelete = async (id) => {
    await db.deleteToneMemory(id);
    setToneMemory((prev) => prev.filter((t) => t.id !== id));
  };

  // ─── Sorting + Filtering logic ───────────────────────────────────────────
  const allCategories = [...new Set(cards.map((c) => c.prospect?.category).filter(Boolean))].sort();

  const applyFiltersAndSort = (cardList) => {
    let result = [...cardList];

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((c) =>
        c.prospect?.business_name?.toLowerCase().includes(q) ||
        c.prospect?.address?.toLowerCase().includes(q) ||
        c.contact?.email?.toLowerCase().includes(q) ||
        c.contact?.name?.toLowerCase().includes(q)
      );
    }

    // Category filter
    if (categoryFilter !== "all") {
      result = result.filter((c) => c.prospect?.category === categoryFilter);
    }

    // Quick-filter chips (additive)
    if (quickFilters.adsLive) result = result.filter((c) => c.prospect?.ads_detected);
    if (quickFilters.hot) result = result.filter((c) => getProspectPriority(c).tier === "Hot");
    if (quickFilters.untouched) result = result.filter((c) => c.status === "prospected");

    // Sort
    result.sort((a, b) => {
      if (sortBy === "newest") return new Date(b.created_at) - new Date(a.created_at);
      if (sortBy === "oldest") return new Date(a.created_at) - new Date(b.created_at);
      if (sortBy === "confidence") return (b.contact?.email_confidence_score || 0) - (a.contact?.email_confidence_score || 0);
      if (sortBy === "name") return (a.prospect?.business_name || "").localeCompare(b.prospect?.business_name || "");
      if (sortBy === "adsFirst") {
        // Ads-live businesses first (already spending = highest intent), then by value.
        const adsA = a.prospect?.ads_detected ? 1 : 0, adsB = b.prospect?.ads_detected ? 1 : 0;
        if (adsA !== adsB) return adsB - adsA;
        return estimateValue(b).monthly - estimateValue(a).monthly;
      }
      if (sortBy === "value") return estimateValue(b).monthly - estimateValue(a).monthly;
      return 0;
    });

    return result;
  };

  const columns = [
    { key: "prospected", title: "Prospected", color: T.muted },
    { key: "draft", title: "Draft", color: T.amberHi },
    { key: "sent", title: "Sent", color: T.blue },
    { key: "replied", title: "Replied", color: T.pink },
    { key: "meeting", title: "Meeting", color: T.green },
    { key: "rejected", title: "Rejected", color: T.red },
    { key: "snoozed", title: "Snoozed", color: T.violet },
  ];

  const activeCards = cards.filter((c) => !["snoozed", "rejected"].includes(c.status));
  const totalByStatus = (s) => cards.filter((c) => c.status === s).length;
  const draftCount = totalByStatus("draft") + totalByStatus("draft_ready");

  const getDisplayCards = () => {
    let base;
    if (activeFilter === "all") base = cards.filter((c) => c.status !== "snoozed" && c.status !== "rejected");
    else base = cards.filter((c) => c.status === activeFilter);
    return applyFiltersAndSort(base);
  };

  const displayCards = getDisplayCards();
  // Memoized — this walks the whole card list several times and App re-renders
  // on every keystroke of the search box.
  const { dupeNames, dupeEmails } = useMemo(() => buildDuplicateMap(cards), [cards]);
  const hasActiveFilters = searchQuery || categoryFilter !== "all" || sortBy !== "adsFirst" || quickFilters.adsLive || quickFilters.hot || quickFilters.untouched;

  const selectStyle = selectBase;
  const activeTab = tabForView(currentView);

  // Sliding tab indicator — measures the active tab's DOM position so the pill
  // glides between tabs instead of snapping (the one moment this app should
  // feel physical rather than instant).
  const tabRefs = useRef({});
  const tabRowRef = useRef(null);
  const [tabIndicator, setTabIndicator] = useState({ left: 0, width: 0, ready: false });
  useLayoutEffect(() => {
    const measure = () => {
      const el = tabRefs.current[activeTab];
      const row = tabRowRef.current;
      if (!el || !row) return;
      setTabIndicator({ left: el.offsetLeft, width: el.offsetWidth, ready: true });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [activeTab, authToken, authChecked, inboundNew]);

  // Command palette actions — tabs first, then live prospect search, then
  // one-shot operations. Rebuilt each render; the list is small and cheap.
  // Rebuilt fresh each render (cheap — a handful of tabs plus up to 300 cards)
  // rather than memoized, since the handlers it closes over aren't stable
  // references anyway; a useMemo here would just be dead weight.
  const paletteActions = (() => {
    const acts = [];
    NAV_TABS.forEach(tab => {
      const subs = SUB_NAVS[tab.key] || [{ view: tab.views[0], label: tab.label }];
      subs.forEach(s => acts.push({ id: `nav_${s.view}`, group: "Go to", icon: tab.icon, label: subs.length > 1 ? `${tab.label} — ${s.label}` : tab.label, run: () => setCurrentView(s.view) }));
    });
    acts.push({ id: "act_refresh", group: "Action", icon: "↺", label: "Refresh data", run: handleRefresh });
    acts.push({ id: "act_prospect", group: "Action", icon: "⟳", label: "Find prospects", sub: "Search Chicago businesses for new leads", run: handleProspect });
    acts.push({ id: "act_replies", group: "Action", icon: "💬", label: "Check replies", run: handleCheckReplies });
    if (sendMode.isLive()) acts.push({ id: "act_safe", group: "Safety", icon: "◉", label: "Switch to safe mode", sub: "Reroute sends back to your own inbox", run: () => { sendMode.setLive(false); toast.push("Back to safe mode — sends reroute to your inbox.", { tone: "warning" }); } });
    cards.slice(0, 300).forEach(c => {
      const name = c.prospect?.business_name;
      if (!name) return;
      acts.push({ id: `card_${c.id}`, group: "Prospect", icon: "→", label: name, sub: c.contact?.email || c.prospect?.category || "", run: () => { setCurrentView("outreach"); sm.set("outreach_focus", name); } });
    });
    return acts;
  })();

  if (!embedded && !authChecked) return (
    <div style={{ minHeight: "100vh", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: "32px", height: "32px", border: `2px solid ${T.lineSoft}`, borderTopColor: T.gold, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
  if (!embedded && !authToken) return <LoginScreen onLogin={(token) => { setAuthToken(token); setAuthChecked(true); }} />;

  return (
    <div style={{ minHeight: "100vh", background: "transparent", color: T.ink, fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Nav — five tabs, one product */}
      <div className="co-nav" style={{ borderBottom: `1px solid ${T.lineSoft}`, padding: "0 24px", height: "52px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: embedded ? "52px" : 0, background: "rgba(11,15,26,0.78)", backdropFilter: "blur(20px) saturate(140%)", WebkitBackdropFilter: "blur(20px) saturate(140%)", boxShadow: "0 1px 0 rgba(255,255,255,0.03), 0 4px 16px rgba(0,0,0,0.35)", zIndex: 50 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "18px", minWidth: 0 }}>
          {!embedded && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
            <span style={{ width: "18px", height: "18px", borderRadius: "5px", background: T.goldGrad, boxShadow: "0 1px 3px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.35), 0 0 12px rgba(201,165,87,0.25)", display: "inline-block" }} />
            <span style={{ fontSize: "13px", fontWeight: 800, color: T.inkBrand, letterSpacing: "0.14em", textTransform: "uppercase", fontFamily: "'Syne', system-ui" }}>Clarify</span>
          </span>
          )}
          <div ref={tabRowRef} className="co-nav-tabs" style={{ display: "flex", gap: "2px", alignItems: "center", background: "rgba(255,255,255,0.045)", borderRadius: T.rMd, padding: "3px", border: `1px solid ${T.lineSoft}`, position: "relative" }}>
            {tabIndicator.ready && (
              <div style={{ position: "absolute", top: "3px", bottom: "3px", left: `${tabIndicator.left}px`, width: `${tabIndicator.width}px`, background: T.raised, borderRadius: "7px", boxShadow: `${T.shadowTab}, inset 0 1px 0 rgba(255,255,255,0.06)`, transition: `left ${T.durBase} ${T.easeSpring}, width ${T.durBase} ${T.easeSpring}`, zIndex: 0 }} />
            )}
            {NAV_TABS.map(tab => {
              const on = activeTab === tab.key;
              return (
                <button key={tab.key} ref={el => { tabRefs.current[tab.key] = el; }} onClick={() => setCurrentView(tab.views[0])} style={{ position: "relative", zIndex: 1, padding: "5px 14px", background: "transparent", border: "none", borderRadius: "7px", color: on ? T.inkDeep : T.ghost, fontSize: "11.5px", fontWeight: 700, cursor: "pointer", letterSpacing: "0.05em", fontFamily: T.fontDisplay, transition: `color ${T.durBase} ${T.easeStd}` }}>
                  {tab.label}
                  {tab.key === "inbound" && inboundNew > 0 ? <span style={{ marginLeft: "6px", fontSize: "9px", fontWeight: 800, color: "#1A0A12", background: T.pink, borderRadius: T.rPill, padding: "1px 6px", verticalAlign: "middle" }}>{inboundNew}</span> : null}
                </button>
              );
            })}
          </div>
        </div>
        <div className="co-nav-actions" style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          <SendModePill />
          {!embedded && (
          <button onClick={() => setPaletteOpen(true)} title="Command palette (⌘K)" className="co-signout" style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "6px 10px", background: "transparent", border: `1px solid ${T.lineSoft}`, borderRadius: "8px", color: T.faint, fontSize: "11px", cursor: "pointer", fontFamily: T.fontMono }}>
            ⌘K
          </button>
          )}
          <button onClick={handleRefresh} disabled={refreshing} title="Refresh" style={{ padding: "6px 10px", background: "transparent", border: `1px solid ${T.lineSoft}`, borderRadius: "8px", color: T.faint, fontSize: "13px", cursor: refreshing ? "not-allowed" : "pointer" }}>
            {refreshing ? "…" : "↺"}
          </button>
          {!embedded && (
          <button className="co-signout" onClick={handleLogout} title="Sign out" style={{ padding: "6px 12px", background: "transparent", border: `1px solid ${T.line}`, borderRadius: "8px", color: T.muted, fontSize: "11px", cursor: "pointer" }}>
            ↪ Out
          </button>
          )}
        </div>
      </div>
      <SubNav tab={activeTab} currentView={currentView} onNavigate={setCurrentView} />
      <BottomBar activeTab={activeTab} onTab={(t) => setCurrentView(t.views[0])} inboundNew={inboundNew} />

      <GlobalAgent cards={cards} />
      <AgentEngine cards={cards} />
      <DnaWorker cards={cards} toneMemory={toneMemory} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} actions={paletteActions} />
      <style>{`@keyframes fadeup { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } } @keyframes fadein { from { opacity: 0; } to { opacity: 1; } } @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
      {currentView === "outreach" && (
        <BulkActionsBar
          count={selectedCards.size}
          generating={batchGenerating}
          onGenerate={handleBatchGenerate}
          onSnooze={() => bulkStatusChange("snoozed", "snoozed")}
          onReject={() => bulkStatusChange("rejected", "rejected")}
          onClear={() => setSelectedCards(new Set())}
        />
      )}
      {undoState && <UndoToast message={undoState.message} onUndo={undoState.restore} onDismiss={() => setUndoState(null)} />}
      {showShortcuts && <ShortcutHelp onClose={() => setShowShortcuts(false)} />}
      <div className="co-viewwrap">
      {currentView === "inbound" ? <InboundView cards={cards} onNavigate={setCurrentView} onCardsChange={loadData} toneMemory={toneMemory} /> : currentView === "analyst" ? <AnalystView /> : currentView === "clients" ? <ClientsView deepClientId={routeSub} onNavigate={setCurrentView} /> : currentView === "mission" ? <MissionControl cards={cards} onNavigate={setCurrentView} inboundNew={inboundNew} /> : currentView === "calendar" ? <CalendarView cards={cards} onStatusChange={handleStatusChange} onDataChange={loadData} /> : currentView === "queue" ? <QueueView onNavigate={setCurrentView} /> : currentView === "sequences" ? <SequencesView /> : currentView === "analytics" ? <AnalyticsView cards={cards} /> : currentView === "dna" ? <DnaView cards={cards} toneMemory={toneMemory} /> : currentView === "settings" ? <SettingsView /> : null}
      </div>
      {currentView === "outreach" && <div className="co-viewwrap" style={{ display: "flex", minHeight: "calc(100vh - 52px)" }}>
        <div style={{ flex: 1, padding: "24px 28px", overflow: "auto" }}>

          {/* Actions row — outreach's tools live with outreach, not in the global header */}
          <div className="co-toolbar" style={{ display: "flex", gap: "8px", marginBottom: "14px", flexWrap: "wrap", alignItems: "center" }}>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, email, location…"
              style={{ flex: 1, minWidth: "180px", background: T.subtle, border: `1px solid ${T.line}`, borderRadius: "8px", padding: "7px 12px", fontSize: "12px", color: T.ink, outline: "none" }}
            />
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={selectStyle}>
              <option value="adsFirst">⚡ Ads live first</option>
              <option value="value">Highest value</option>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="confidence">Highest confidence</option>
              <option value="name">A → Z</option>
            </select>
            <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} style={selectStyle}>
              <option value="all">All categories</option>
              {allCategories.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
            <button onClick={handleCheckReplies} disabled={checkingReplies} style={{ padding: "7px 14px", background: "rgba(244,114,182,0.09)", border: "1px solid rgba(244,114,182,0.25)", borderRadius: "8px", color: checkingReplies ? T.faint : T.pink, fontSize: "11px", fontWeight: 700, cursor: checkingReplies ? "not-allowed" : "pointer", letterSpacing: "0.04em", fontFamily: "'Syne', system-ui", whiteSpace: "nowrap" }}>
              {checkingReplies ? "Checking…" : "💬 Check Replies"}
            </button>
            <button onClick={handleProspect} disabled={prospecting} style={{ padding: "7px 14px", background: T.subtle, border: `1px solid ${T.line}`, borderRadius: "8px", color: T.muted, fontSize: "11px", fontWeight: 700, cursor: prospecting ? "not-allowed" : "pointer", letterSpacing: "0.04em", fontFamily: "'Syne', system-ui", whiteSpace: "nowrap" }}>
              {prospecting ? prospectStatus || "Prospecting…" : "⟳ Find Prospects"}
            </button>
            <button onClick={() => setSidebarOpen(!sidebarOpen)} style={{ padding: "7px 12px", background: sidebarOpen ? T.goldSoft : "transparent", border: `1px solid ${sidebarOpen ? T.goldLine : T.lineSoft}`, borderRadius: "8px", color: sidebarOpen ? T.gold : T.muted, fontSize: "11px", fontWeight: 700, cursor: "pointer", letterSpacing: "0.04em", fontFamily: "'Syne', system-ui", whiteSpace: "nowrap" }}>
              🧠 {toneMemory.length > 0 ? `Tone (${toneMemory.length})` : "Tone"}
            </button>
            {hasActiveFilters && (
              <button onClick={() => { setSearchQuery(""); setCategoryFilter("all"); setSortBy("adsFirst"); setQuickFilters({ adsLive: false, hot: false, untouched: false }); }} style={{ padding: "5px 10px", background: "transparent", border: `1px solid ${T.red}40`, borderRadius: "6px", color: T.red, fontSize: "11px", cursor: "pointer", whiteSpace: "nowrap" }}>
                Clear
              </button>
            )}
          </div>

          {/* Status tabs */}
          <div className="co-scroll-x" style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap", alignItems: "center" }}>
            {[
              { key: "all", label: `Active (${activeCards.length})` },
              { key: "prospected", label: `Prospected (${totalByStatus("prospected")})` },
              { key: "draft", label: `Draft (${draftCount})` },
              { key: "sent", label: `Sent (${totalByStatus("sent")})` },
              { key: "replied", label: `Replied 💬 (${totalByStatus("replied")})` },
              { key: "meeting", label: `Meeting 📅 (${totalByStatus("meeting")})` },
              { key: "snoozed", label: `Snoozed (${totalByStatus("snoozed")})` },
              { key: "rejected", label: `Rejected (${totalByStatus("rejected")})` },
            ].map((tab) => (
              <button key={tab.key} onClick={() => setActiveFilter(tab.key)} style={{ padding: "5px 12px", background: activeFilter === tab.key ? "rgba(255,255,255,0.08)" : "transparent", border: `1px solid ${activeFilter === tab.key ? T.line : T.lineSoft}`, borderRadius: "20px", color: activeFilter === tab.key ? T.ink : T.muted, fontSize: "11px", fontWeight: 600, cursor: "pointer", letterSpacing: "0.02em", whiteSpace: "nowrap" }}>
                {tab.label}
              </button>
            ))}
          </div>

          {/* Quick-filter chips — fast access to the highest-intent segments */}
          {cards.length > 0 && (() => {
            // All chip counts use the same active basis (exclude dead leads) so the
            // numbers match what filtering actually surfaces.
            const activeForChips = cards.filter(c => !["rejected","snoozed"].includes(c.status));
            const adsLiveCount = activeForChips.filter(c => c.prospect?.ads_detected).length;
            const hotCount = activeForChips.filter(c => getProspectPriority(c).tier === "Hot").length;
            const untouchedCount = activeForChips.filter(c => c.status === "prospected").length;
            const Chip = ({ on, onClick, color, children, count }) => (
              <button onClick={onClick} style={{ display: "inline-flex", alignItems: "center", gap: "7px", padding: "7px 13px", borderRadius: "20px", border: `1px solid ${on ? color : T.line}`, background: on ? color + "1C" : T.surface, color: on ? color : T.muted, fontSize: "12px", fontWeight: 700, cursor: "pointer", fontFamily: "'Syne', system-ui", transition: "all 0.12s" }}>
                {children}
                {count != null && <span style={{ fontSize: "11px", fontWeight: 600, opacity: 0.8, fontFamily: "'DM Mono', monospace" }}>{count}</span>}
              </button>
            );
            const toggle = (k) => setQuickFilters(q => ({ ...q, [k]: !q[k] }));
            return (
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
                <Chip on={quickFilters.adsLive} onClick={() => toggle("adsLive")} color={T.red} count={adsLiveCount}>⚡ Ads Live</Chip>
                <Chip on={quickFilters.hot} onClick={() => toggle("hot")} color={T.amber} count={hotCount}>🔥 Hot</Chip>
                <Chip on={quickFilters.untouched} onClick={() => toggle("untouched")} color={T.blue} count={untouchedCount}>Untouched</Chip>
                {adsLiveCount > 0 && !quickFilters.adsLive && (
                  <span style={{ fontSize: "11px", color: T.faint, marginLeft: "4px" }}>
                    {adsLiveCount} {adsLiveCount === 1 ? "business is" : "businesses are"} already spending on ads — your warmest leads.
                  </span>
                )}
              </div>
            );
          })()}

          {loading ? (
            <div style={{ display: "flex", gap: "20px", overflowX: "hidden", paddingBottom: "8px" }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{ flex: 1, minWidth: "260px" }}>
                  <SkeletonLine width="40%" height="10px" style={{ marginBottom: "14px" }} />
                  <SkeletonRows count={2} />
                </div>
              ))}
            </div>
          ) : cards.length === 0 ? (
            <EmptyState
              icon="radar" title="No prospects yet"
              sub={'Click "Find Prospects" to search Chicago businesses and start building your pipeline.'}
              action={<button onClick={handleProspect} disabled={prospecting} style={{ padding: "9px 18px", background: T.goldGrad, border: "none", borderRadius: T.rSm, color: T.textOnBrand, fontSize: "12px", fontWeight: 700, cursor: prospecting ? "not-allowed" : "pointer", fontFamily: T.fontDisplay, letterSpacing: "0.02em", boxShadow: `0 2px 12px rgba(201,165,87,0.25), ${T.glowBrass}` }}>{prospecting ? "Searching…" : "⟳ Find Prospects"}</button>}
            />
          ) : activeFilter === "all" ? (
            <>
              {/* Today's plays + funnel — the two lenses that matter */}
              <DailyPlays cards={cards} onFilter={setActiveFilter} />
              <PipelineFunnel cards={cards} />

              {/* Kanban — only render columns that have cards, always show Prospected */}
              <div className="co-kanban" style={{ display: "flex", gap: "20px", alignItems: "flex-start", overflowX: "auto", paddingBottom: "32px" }}>
                {columns.filter((c) => c.key !== "snoozed" && c.key !== "rejected").map((col) => {
                  const colCards = applyFiltersAndSort(cards.filter((c) => c.status === col.key || (col.key === "draft" && c.status === "draft_ready")));
                  // Hide empty non-core columns
                  if (colCards.length === 0 && col.key !== "prospected") return null;
                  const isProspected = col.key === "prospected";
                  return (
                    <KanbanColumn key={col.key} title={col.title} count={colCards.length} color={col.color}
                      onBatchGenerate={isProspected ? handleBatchGenerate : undefined}
                      batchGenerating={isProspected ? batchGenerating : undefined}
                      batchProgress={isProspected ? batchProgress : undefined}
                      batchLabel={isProspected && selectedCards.size > 0 ? `✦ Generate (${selectedCards.size})` : undefined}
                      bgTint={col.key === "draft" ? "rgba(245,184,77,0.04)" : col.key === "replied" ? "rgba(244,114,182,0.05)" : undefined}
                      emptyNote={col.key === "replied" ? (() => { const sentCount = cards.filter(c => c.status === "sent").length; const oldest = cards.filter(c => c.status === "sent").sort((a,b) => new Date(a.sent_at) - new Date(b.sent_at))[0]; const daysAgo = oldest ? Math.floor((Date.now() - new Date(oldest.sent_at).getTime()) / 86400000) : null; return sentCount > 0 ? `No replies yet — ${sentCount} email${sentCount !== 1 ? "s" : ""} sent${daysAgo !== null ? `, oldest ${daysAgo}d ago` : ""}. Consider a follow-up.` : "No replies yet."; })() : undefined}>
                      {col.key === "replied" && <ReplyTriageSummary cards={cards} />}
                      {groupCardsByEmail(colCards).map((item, idx) => {
                        const entrance = { animation: `cardIn 0.3s ${T.easeOut} both`, animationDelay: `${Math.min(idx, 8) * 30}ms` };
                        if (item.type === "single") {
                          const card = item.card;
                          return <div key={card.id} style={entrance}><OutreachCard card={card} toneMemory={toneMemory} onStatusChange={handleStatusChange} onDraftRegenerate={handleDraftRegenerate} onToneFeedback={handleToneFeedback} onEnrich={handleEnrich} onMarkSent={handleMarkSent} isDupeName={false} isDupeEmail={false} isSelected={selectedCards.has(card.id)} onToggleSelect={isProspected ? toggleCardSelect : undefined} /></div>;
                        }
                        // Chain group — same contact email
                        const { primary, rest, email } = item;
                        const chainName = primary.prospect?.business_name?.replace(/\s*[-–]\s*(Chicago|Loop|West Loop|South Loop|River North|Lincoln Park|Wicker Park|Lakeview|Downtown|The Loop|North|South|East|West|LLC|Inc)\s*$/i, "") || primary.prospect?.business_name || "Chain";
                        return (
                          <div key={email} style={entrance}>
                            <ChainGroup primary={primary} rest={rest} chainName={chainName}
                              toneMemory={toneMemory} onStatusChange={handleStatusChange} onDraftRegenerate={handleDraftRegenerate}
                              onToneFeedback={handleToneFeedback} onEnrich={handleEnrich} onMarkSent={handleMarkSent}
                              isSelected={selectedCards.has(primary.id)} onToggleSelect={isProspected ? toggleCardSelect : undefined} />
                          </div>
                        );
                      })}
                      {colCards.length === 0 && (
                        <EmptyState compact dashed icon="inbox" tint={T.faint} title="Nothing here" />
                      )}
                    </KanbanColumn>
                  );
                })}
              </div>
            </>
          ) : (
            // List view for filtered tabs
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", maxWidth: "560px" }}>
              {displayCards.length === 0 ? (
                <EmptyState compact icon={hasActiveFilters ? "search" : "inbox"} tint={T.faint}
                  title={hasActiveFilters ? "No results match your filters" : "Nothing here yet"}
                  sub={hasActiveFilters ? "Try clearing a filter or search term." : undefined}
                />
              ) : (
                displayCards.map((card, idx) => (
                  <div key={card.id} style={{ animation: `cardIn 0.3s ${T.easeOut} both`, animationDelay: `${Math.min(idx, 8) * 30}ms` }}>
                    <OutreachCard card={card} toneMemory={toneMemory} onStatusChange={handleStatusChange} onDraftRegenerate={handleDraftRegenerate} onToneFeedback={handleToneFeedback} onEnrich={handleEnrich} onMarkSent={handleMarkSent} isDupeName={dupeNames.has(card.id)} isDupeEmail={dupeEmails.has(card.id)} />
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Tone Memory Sidebar */}
        {sidebarOpen && (
          <div style={{ width: "280px", minWidth: "280px", borderLeft: `1px solid ${T.lineSoft}`, padding: "24px 18px", background: "rgba(15,22,38,0.85)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", overflowY: "auto" }}>
            <ToneMemoryPanel toneMemory={toneMemory} onDelete={handleToneDelete} onAdd={async (text) => {
              await db.addToneMemory(text, null);
              const updated = await db.getToneMemory();
              setToneMemory(updated || []);
            }} />
          </div>
        )}
      </div>}
    </div>

  );
}

