// THE POLISH PRIMITIVES — pairs with styles/polish.css.
import { useState, useEffect, useRef, useMemo, createContext, useContext } from 'react';
import { useNavigate } from 'react-router-dom';

// ---- numbers count to their value (ease-out cubic). Use on every big metric. ----
export function useTween(target, dur = 700) {
  const [v, setV] = useState(target ?? 0);
  const fromRef = useRef(target ?? 0);
  useEffect(() => {
    if (target == null) return;
    // JS animation honors the same mandate as the CSS system
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      fromRef.current = target;
      setV(target);
      return;
    }
    const from = fromRef.current ?? 0;
    if (from === target) { setV(target); return; }
    let raf; const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      setV(from + (target - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(step); else fromRef.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, dur]);
  return target == null ? null : Math.round(v);
}
export function Num({ v, f = (x) => x.toLocaleString('en-US'), dur }) {
  const shown = useTween(typeof v === 'number' ? v : null, dur);
  return shown == null ? <>—</> : <>{f(shown)}</>;
}

// ---- responsive branch point ----
// MUST stay in lockstep with the CSS mobile breakpoint, which lives in three
// places: app.css and polish.css (max-width: 767.98px) and Root.jsx's
// EMBED_OVERRIDES (min-width: 768px). 768px is also the shell's own flip
// (@cc/ui useIsMobile), so tool chrome and shell chrome change together.
// When this disagreed with the CSS (it was 820px while the CSS moved to 768px),
// 768-820px viewports — iPad 10.2" and iPad Air in portrait — rendered the
// MOBILE board (single stacked stage) underneath the DESKTOP top bar.
export function useIsMobile(query = '(max-width: 767.98px)') {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    mq.addEventListener('change', onChange);
    setMatches(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

// ---- skeletons: replace EVERY page-level spinner ----
export const SkLine = ({ w }) => <div className={`sk sk-line${w ? ` ${w}` : ''}`} />;
export const SkCard = () => (<div className="card pad-md"><SkLine w="w40" /><div className="sk sk-big" /><SkLine w="w80" /></div>);
export function SkPage({ cards = 4 }) {
  return (
    <div className="pagefade">
      <div className="grid section">{Array.from({ length: cards }).map((_, i) => <SkCard key={i} />)}</div>
      <div className="card pad-md section"><SkLine w="w40" /><SkLine /><SkLine w="w80" /><SkLine w="w60" /></div>
    </div>
  );
}
export function SkBoard() {
  return (
    <div className="pagefade">
      <div className="grid section">{Array.from({ length: 4 }).map((_, i) => <SkCard key={i} />)}</div>
      <div className="kanban">
        {Array.from({ length: 7 }).map((_, i) => (
          <div className="kcol" key={i}>
            <SkLine w="w60" />
            <div className="sk" style={{ height: 74 }} />
            {i < 3 && <div className="sk" style={{ height: 74 }} />}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- states: errors always get Retry, empties always guide ----
export function ErrorState({ msg, onRetry, retryLabel = 'Retry' }) {
  return (
    <div className="errbox" role="alert">
      <div className="m">{String(msg || 'Something went wrong.')}</div>
      {onRetry && <button className="btn sm" onClick={onRetry}>{retryLabel}</button>}
    </div>
  );
}
// The kit's empty state. `.t` / `.h` are `.empty-title` / `.empty-sub` now, and
// the dashed outline is gone — an empty state is an absence, not an object with
// a border. Every one of them still says what to do next and ships the control
// that does it.
export function EmptyState({ title, hint, cta, onCta, ctaTo }) {
  const nav = useNavigate();
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-sub">{hint}</div>}
      {cta && <button className="btn primary md" onClick={onCta || (() => ctaTo && nav(ctaTo))}>{cta}</button>}
    </div>
  );
}

// ---- height:auto expansion, zero measuring, zero jank ----
export function Expand({ open, children }) {
  return <div className={`expand${open ? ' open' : ''}`} aria-hidden={!open}><div>{open ? children : null}</div></div>;
}

// ---- toasts (optional action button, e.g. Undo) ----
const ToastCtx = createContext(null);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const dismiss = (id) => {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, out: true } : x)));
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 260);
  };
  const push = (msg, opts = {}) => {
    const id = Math.random().toString(36).slice(2);
    setItems((xs) => [...xs, { id, msg, err: !!opts.err, action: opts.action || null }]);
    const ms = opts.ms || (opts.action ? 5200 : 2600);
    setTimeout(() => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, out: true } : x))), ms);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), ms + 260);
  };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.err ? ' err' : ''}${t.out ? ' out' : ''}`}>
            {/* the marker is a dot for a success and a diamond for an error
                (polish.css rotates it) — the state does not live in colour alone */}
            <span className="tdot" aria-hidden="true" />
            {t.msg}
            {t.action && (
              <button type="button" className="tbtn" onClick={() => { dismiss(t.id); t.action.fn(); }}>
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx) || (() => {});

// ---- ⌘K command palette: navigation + actions ----
// items: [{ label, path?, run?, hint?, k: ['keyword', ...] }]
// openSignal: bump the number to open it from outside — the sub-nav's ⌘K
//   button does. A signal rather than a controlled `open` prop because this
//   component already owns closing (Escape, a pick, the scrim), and a caller
//   that owns opening but not closing is the shorter half of that contract.
export function CommandK({ items = [], openSignal = 0 }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const nav = useNavigate();
  const inputRef = useRef(null);
  const shown = useMemo(() => {
    // every query term must match somewhere — "log meadow" finds
    // "Log application: Meadow Labs"
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const xs = terms.length
      ? items.filter((x) => {
          const hay = [x.label, ...(x.k || [])].join(' ').toLowerCase();
          return terms.every((t) => hay.includes(t));
        })
      : items;
    return xs.slice(0, 40);
  }, [q, items]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); setQ(''); setI(0); }
      else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // 0 is "nobody has asked yet", so a fresh mount never opens on its own.
  useEffect(() => { if (openSignal > 0) { setOpen(true); setQ(''); setI(0); } }, [openSignal]);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 10); }, [open]);
  useEffect(() => { document.body.style.overflow = open ? 'hidden' : ''; return () => { document.body.style.overflow = ''; }; }, [open]); // scroll lock
  useEffect(() => { setI(0); }, [q]);
  if (!open) return null;
  const go = (item) => {
    setOpen(false);
    if (item.run) item.run();
    else if (item.path) nav(item.path);
  };
  return (
    <div className="cmdk-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="cmdk" role="dialog" aria-label="Command palette">
        <input ref={inputRef} value={q} placeholder="Jump to a job, or type a command…" onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, shown.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
            else if (e.key === 'Enter' && shown[i]) go(shown[i]);
          }} />
        <div className="list">
          {shown.map((item, idx) => (
            <div key={(item.path || '') + item.label} className={`item${idx === i ? ' on' : ''}`} onMouseEnter={() => setI(idx)}
              onMouseDown={(e) => { e.preventDefault(); go(item); }}>
              <span>{item.label}</span>
              <span className="hint">{item.hint || '↵'}</span>
            </div>
          ))}
          {shown.length === 0 && <div className="item">Nothing matches “{q}”</div>}
        </div>
      </div>
    </div>
  );
}
