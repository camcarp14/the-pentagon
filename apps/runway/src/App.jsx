import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { AppProvider, useApp, STAGES, stageLabel } from './lib/store.jsx';
import { ToastProvider, CommandK, SkBoard, SkLine, ErrorState, useToast } from './ui/primitives.jsx';
import Login from './pages/Login.jsx';
import Board from './pages/Board.jsx';
import Capture from './pages/Capture.jsx';
import JobDetail from './pages/JobDetail.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import Market from './pages/Market.jsx';
import PrintView from './pages/PrintView.jsx';
import ApplyDesk from './pages/ApplyDesk.jsx';
import Skills from './pages/Skills.jsx';

// Bottom-nav icons — minimal geometry in the same line style ZTS/Macro use, so
// the mobile bar reads identically across tools. Hidden on desktop (the pill
// group is label-only there).
const RW_ICONS = {
  board: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><line x1="9.5" y1="4.5" x2="9.5" y2="19.5" /><line x1="15" y1="4.5" x2="15" y2="19.5" /></>,
  capture: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
  insights: <><polyline points="3.5,4 3.5,20 20,20" /><polyline points="7,15 11,11 14,13 19,7" /></>,
  // Skills reads as a stack of bars at different lengths — the demand ranking
  // the page is, drawn at 24px.
  skills: <><line x1="4" y1="6.5" x2="20" y2="6.5" /><line x1="4" y1="12" x2="15" y2="12" /><line x1="4" y1="17.5" x2="10" y2="17.5" /></>,
  profile: <><circle cx="12" cy="8" r="3.2" /><path d="M5.5 20c0-3.6 3-5.6 6.5-5.6s6.5 2 6.5 5.6" /></>,
};
const TabIco = ({ name }) => (
  <svg className="tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{RW_ICONS[name]}</svg>
);

// The rail's destinations, and the ONE place each is named.
//
// Four pages used to open with an <h1> repeating the rail item you had just
// clicked — Board under Board, Capture under Capture, Insights under Insights.
// Those headings are gone, which takes with them the accessible name each page
// had. The name moves onto <main> and reads from this table, so the word a
// screen reader announces and the word lit in the rail are the same string by
// construction rather than by two people remembering to edit both.
const RAIL = [
  { to: '/', end: true, icon: 'board', label: 'Board' },
  { to: '/capture', icon: 'capture', label: 'Find' },
  { to: '/skills', icon: 'skills', label: 'Skills' },
  { to: '/market', icon: 'insights', label: 'Insights' },
  { to: '/profile', icon: 'profile', label: 'Profile' },
];
/** undefined for anything not in the rail — a job's detail page keeps its own
 *  <h1> (the company and the role), which is a record name and not a repeat. */
export const railLabel = (pathname) => RAIL.find((r) => r.to === pathname)?.label;

// THE SUB-NAV. On a desktop this is the horizontal bar every other tool has
// (see styles in Root.jsx's EMBED_OVERRIDES); on a phone it is the bottom tab
// bar (styles in app.css's mobile block). One markup, two layouts.
//
// WHAT IT BORROWS, AND WHY: the group is the kit's `.seg`, the tabs are its
// `.seg-opt`, and the fill behind the active one is a measured `.seg-thumb` —
// the same three classes ZTS's bar and Clarify's `.co-nav` are built from. The
// pill used to be hand-drawn here (its own fill, its own two-part shadow, its
// own greys) and read like a different product: a raised pill in one tool, a
// recessed one in this one, and in light mode a near-white label on a near-white
// fill, because those greys were literals with no light half.
//
// The active tab is read off the DOM rather than re-derived from the path.
// NavLink already decides it — `to="/"` is `end`, `/jobs/:id` matches nothing —
// and a second copy of that rule here is a second thing to get wrong; when the
// two disagreed the thumb would sit under the wrong word.
function Rail({ onCommand }) {
  const { discoveries } = useApp();
  const cls = ({ isActive }) => `nav-item seg-opt${isActive ? ' active' : ''}`;
  const queued = (discoveries || []).length;
  const location = useLocation();
  const groupRef = useRef(null);
  const [thumb, setThumb] = useState({ left: 0, width: 0, ready: false });

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return undefined;
    const measure = () => {
      const on = group.querySelector('.nav-item.active');
      // No tab is lit on a job's detail page. Hiding the thumb is the honest
      // answer — parking it under Board would claim you were somewhere else.
      if (!on) { setThumb((t) => (t.ready ? { ...t, ready: false } : t)); return; }
      setThumb({ left: on.offsetLeft, width: on.offsetWidth, ready: true });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    // The group resizes when the layout flips between the bar and the bottom
    // dock, and when the discovery badge appears next to Capture.
    const ro = new ResizeObserver(measure);
    ro.observe(group);
    return () => ro.disconnect();
  }, [location.pathname, queued]);

  return (
    <nav className="rail pentagon-dock" aria-label="Runway">
      <div className="brand"><span className="dot" /><span className="t-head">Runway</span></div>
      <div className="navgroup seg" ref={groupRef}>
        {thumb.ready && <span className="seg-thumb" aria-hidden="true" style={{ left: `${thumb.left}px`, width: `${thumb.width}px` }} />}
        {RAIL.map((r) => (
          <NavLink key={r.to} to={r.to} end={r.end} className={cls}>
            <TabIco name={r.icon} />
            <span className="tab-label">
              {r.label}
              {r.to === '/capture' && queued > 0 && <span className="navcount" title={`${queued} discovered role${queued === 1 ? '' : 's'} to review`}>{queued}</span>}
            </span>
          </NavLink>
        ))}
      </div>
      {/* The account lived here and does not any more: the shell's rail footer
          shows who you are signed in as, and two of them on one screen is one
          too many. What stays is ⌘K — and it stays because it is now a CONTROL
          rather than a caption. It used to be the words "⌘K jump anywhere",
          which advertised a shortcut and did nothing when you pressed it; this
          is the same `.btn sm quiet` button ZTS and Clarify carry, so the
          palette is reachable by pointer as well as by keyboard. */}
      <div className="rail-foot">
        <button type="button" className="btn sm quiet cmdk-btn" onClick={onCommand} title="Command palette (⌘K)" aria-label="Command palette">⌘K</button>
      </div>
    </nav>
  );
}

// layout-matched boot skeleton — the page develops, it doesn't arrive
function BootScreen() {
  return (
    <div className="shell">
      <div className="rail">
        <div className="brand"><span className="dot" /><span className="t-head">Runway</span></div>
        <SkLine w="w80" /><SkLine w="w60" /><SkLine w="w80" /><SkLine w="w60" />
      </div>
      <main className="main"><SkBoard /></main>
    </div>
  );
}

function Shell() {
  const { session, jobs, loadError, refresh, moveStage, boards, runScan } = useApp();
  const toast = useToast();
  const location = useLocation();
  // The ⌘K button in the sub-nav and the ⌘K keystroke open the same palette.
  // A bumped counter rather than a boolean: CommandK owns whether it is open
  // (it closes itself on Escape, on a pick and on the scrim), and a controlled
  // `open` prop here would mean two things believing they own that state.
  const [commandSignal, setCommandSignal] = useState(0);

  // auto-scan watched boards on open, at most once per session and only when
  // the last scan is stale — new roles appear without hunting through tabs
  const scanTriedRef = useRef(false);
  useEffect(() => {
    if (!session || scanTriedRef.current || !boards || boards.length === 0) return;
    const last = Math.max(0, ...boards.map((b) => (b.last_scanned_at ? new Date(b.last_scanned_at).getTime() : 0)));
    if (Date.now() - last < 6 * 60 * 60 * 1000) return;
    scanTriedRef.current = true;
    runScan()
      .then((s) => {
        if (s.queued > 0) toast(`Found ${s.queued} new match${s.queued === 1 ? '' : 'es'} — review them on Capture`);
      })
      .catch(() => { /* quiet here — Scan now on Capture surfaces errors with Retry */ });
  }, [session, boards, runScan, toast]);

  const paletteItems = useMemo(() => {
    const items = [
      { label: 'Board', path: '/', hint: 'page', k: ['board', 'pipeline', 'home', 'dashboard'] },
      { label: 'Find roles', path: '/capture', hint: 'page', k: ['add', 'new', 'paste', 'capture', 'find', 'search'] },
      { label: 'Review discovered roles', path: '/capture', hint: 'inbox', k: ['discover', 'inbox', 'scan', 'triage', 'review', 'matches'] },
      { label: 'Edit your hunts', path: '/capture', hint: 'searches', k: ['hunt', 'hunts', 'search', 'criteria', 'terms', 'keywords'] },
      { label: 'Find companies hiring for you', path: '/capture', hint: 'discovery', k: ['companies', 'employers', 'discover', 'expand', 'who'] },
      { label: 'Skills & positioning', path: '/skills', hint: 'page', k: ['skills', 'gap', 'gaps', 'positioning', 'demand', 'learn'] },
      { label: 'Insights', path: '/market', hint: 'page', k: ['market', 'comp', 'salary', 'pay', 'insights', 'funnel', 'stats'] },
      { label: 'Profile & targets', path: '/profile', hint: 'page', k: ['profile', 'settings', 'resume', 'target', 'criteria'] },
    ];
    for (const j of jobs || []) {
      const co = j.company || 'Unknown';
      items.push({
        label: `${co} — ${j.title || 'Untitled'}`,
        path: `/jobs/${j.id}`,
        hint: stageLabel(j.status),
        k: [j.company, j.title, j.status],
      });
      if (j.status === 'closed') continue;
      items.push({
        label: `Apply: ${co}`,
        path: `/apply/${j.id}`, hint: 'apply desk',
        k: ['apply', 'application', 'form', 'questions', 'cover', 'resume', j.company, j.title],
      });
      const move = (stage, verb) => async () => {
        try {
          await moveStage(j.id, stage);
          toast(`${co} → ${stageLabel(stage)}`);
        } catch (ex) { toast(`Couldn't ${verb}: ${ex.message}`, { err: true }); }
      };
      if (j.status === 'saved' || j.status === 'researching') {
        items.push({
          label: `Log application: ${co}`,
          hint: 'action', run: move('applied', 'log it'),
          k: ['log', 'apply', 'applied', 'application', j.company],
        });
      }
      const idx = STAGES.findIndex((s) => s.id === j.status);
      const next = STAGES[idx + 1];
      if (next) {
        items.push({
          label: `Advance: ${co} → ${next.label}`,
          hint: 'action', run: move(next.id, 'advance it'),
          k: ['advance', 'move', 'stage', 'next', j.company],
        });
      }
      items.push({
        label: `Add follow-up: ${co}`,
        path: `/jobs/${j.id}?tab=followups`, hint: 'action',
        k: ['follow', 'followup', 'follow-up', 'note', 'remind', j.company],
      });
    }
    return items;
  }, [jobs, moveStage, toast]);

  if (session === undefined) return <BootScreen />;
  if (!session) return <Login />;

  return (
    <div className="shell">
      <Rail onCommand={() => setCommandSignal((n) => n + 1)} />
      <main className="main" aria-label={railLabel(location.pathname)}>
        {loadError ? (
          <ErrorState msg={`Couldn't load your data: ${loadError}`} onRetry={refresh} />
        ) : (
          <div className="pagefade" key={location.pathname}>
            <Routes location={location}>
              <Route path="/" element={<Board />} />
              <Route path="/capture" element={<Capture />} />
              <Route path="/jobs/:id" element={<JobDetail />} />
              <Route path="/apply/:id" element={<ApplyDesk />} />
              <Route path="/print/:id/:kind" element={<PrintView />} />
              <Route path="/skills" element={<Skills />} />
              <Route path="/market" element={<Market />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        )}
      </main>
      <CommandK items={paletteItems} openSignal={commandSignal} />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </AppProvider>
  );
}
