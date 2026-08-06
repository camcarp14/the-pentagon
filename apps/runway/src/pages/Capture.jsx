import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useApp, fmtComp } from '../lib/store.jsx';
import { scoreJob, scoreBadge } from '../lib/score.js';
import { classifyJobUrl, classifyBoardUrl } from '../lib/jobsource.js';
import { normalizeExtraction } from '../lib/extract.js';
import { COMPANY_PACKS } from '../lib/companyPacks.js';
import { apiPost } from '../lib/api.js';
import { Num, useToast, SkLine, Expand } from '../ui/primitives.jsx';
import JobForm, { emptyJobForm, toJobShape } from '../ui/JobForm.jsx';
import { BreakdownBars, FlagChips } from '../ui/FitPanel.jsx';
import TagInput from '../ui/TagInput.jsx';
import { fmtDateTime } from '../lib/dates.js';
import { SENIORITY_LADDER } from '../lib/score.js';
import { VERTICAL_LABEL } from '../lib/companyUniverse.js';

const looksLikeUrl = (s) => /^https?:\/\/\S+$/i.test(s.trim()) && !s.trim().includes('\n');

// ============ HUNTS — named searches, each with its own negative space ============
//
// The target profile is one set of criteria and always was. That is fine until
// you are running two searches at once — "senior paid search, remote, $150k+"
// and "any marketing manager in Chicago" are different hunts with different
// floors, and folding them into one profile means every scan is aimed at the
// average of two things you want, which is a third thing you don't.
//
// The half that did not exist at all is the negative space. `exclude` kills a
// posting outright, `must` requires a term, and both run BEFORE scoring — so
// "no agencies" stops being forty dismissals and becomes one word.
const emptyHunt = () => ({
  name: '', include: [], exclude: [], must: [], seniority: [],
  remote_pref: 'any', locations: [], comp_floor: '', min_fit: 0, active: true,
});

function HuntEditor({ value, onChange, idPrefix }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const listSetter = (field) => ({
    onAdd: (t) => onChange({ ...value, [field]: value[field].includes(t) ? value[field] : [...value[field], t] }),
    onRemove: (t) => onChange({ ...value, [field]: value[field].filter((x) => x !== t) }),
  });
  return (
    <>
      <div className="frow c2">
        <div>
          <label className="f" htmlFor={`${idPrefix}-name`}>Name this hunt</label>
          <input className="field" id={`${idPrefix}-name`} placeholder="e.g. Senior paid search, remote"
            value={value.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div>
          <label className="f" htmlFor={`${idPrefix}-floor`}>Comp floor ($/yr)</label>
          <input className="field" id={`${idPrefix}-floor`} type="number" min="0" step="5000" placeholder="140000"
            value={value.comp_floor} onChange={(e) => set({ comp_floor: e.target.value })} />
          <p className="sub" style={{ marginBottom: 0 }}>A posting whose stated ceiling is under this is dropped. Silence about comp never drops anything.</p>
        </div>
      </div>
      <div className="fld">
        <label className="f" htmlFor={`${idPrefix}-inc`}>Role terms <span style={{ fontWeight: 400 }}>(any may match — each expands to its synonyms)</span></label>
        <TagInput id={`${idPrefix}-inc`} value={value.include} suggest
          placeholder="e.g. paid search — also finds SEM, PPC, paid media, performance marketing" {...listSetter('include')} />
      </div>
      <div className="frow c2">
        <div>
          <label className="f" htmlFor={`${idPrefix}-exc`}>Never show me <span style={{ fontWeight: 400 }}>(a hit anywhere kills it)</span></label>
          <TagInput id={`${idPrefix}-exc`} value={value.exclude} placeholder="e.g. agency, contract, unpaid" {...listSetter('exclude')} />
        </div>
        <div>
          <label className="f" htmlFor={`${idPrefix}-must`}>Must mention <span style={{ fontWeight: 400 }}>(every one required)</span></label>
          <TagInput id={`${idPrefix}-must`} value={value.must} placeholder="use sparingly — each one is a hard filter" {...listSetter('must')} />
        </div>
      </div>
      <div className="frow c2">
        <div>
          <label className="f" htmlFor={`${idPrefix}-loc`}>Locations</label>
          <TagInput id={`${idPrefix}-loc`} value={value.locations} placeholder="e.g. chicago, new york" {...listSetter('locations')} />
        </div>
        <div>
          <label className="f">Remote preference</label>
          <div className="seg" role="radiogroup" aria-label="Remote preference">
            {['remote', 'hybrid', 'onsite', 'any'].map((r) => (
              <button key={r} type="button" className={value.remote_pref === r ? 'seg-opt active' : 'seg-opt'}
                onClick={() => set({ remote_pref: r })}>{r}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="fld">
        <label className="f">Seniority</label>
        <div className="chips">
          {SENIORITY_LADDER.map((s) => (
            <button key={s} type="button" className={`chip pick${value.seniority.includes(s) ? ' on' : ''}`}
              onClick={() => set({ seniority: value.seniority.includes(s) ? value.seniority.filter((x) => x !== s) : [...value.seniority, s] })}>
              {s}
            </button>
          ))}
        </div>
        <p className="sub" style={{ marginBottom: 0 }}>One rung off still surfaces, scored lower. Three rungs off is a different job and never surfaces.</p>
      </div>
      <div className="frow c2">
        <div>
          <label className="f" htmlFor={`${idPrefix}-minfit`}>Only queue matches above</label>
          <input className="field" id={`${idPrefix}-minfit`} type="number" min="0" max="100" step="5"
            value={value.min_fit} onChange={(e) => set({ min_fit: e.target.value })} />
          <p className="sub" style={{ marginBottom: 0 }}>0 queues everything that matched. Raise it once the inbox gets noisy.</p>
        </div>
      </div>
    </>
  );
}

function HuntsCard() {
  const { hunts, addHunt, saveHunt, deleteHunt, runFullScan, scanning } = useApp();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(emptyHunt);
  const [editing, setEditing] = useState(null); // hunt id being edited
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const toRow = (d) => ({
    name: d.name.trim(),
    include: d.include, exclude: d.exclude, must: d.must,
    seniority: d.seniority, locations: d.locations,
    remote_pref: d.remote_pref,
    comp_floor: d.comp_floor === '' ? null : Number(d.comp_floor),
    min_fit: Number(d.min_fit) || 0,
    active: d.active !== false,
  });

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (!draft.name.trim()) { setErr('Give the hunt a name so you can tell two of them apart.'); return; }
    if (!draft.include.length) { setErr('A hunt needs at least one role term — that is what it searches for.'); return; }
    setBusy(true);
    try {
      if (editing) { await saveHunt(editing, toRow(draft)); toast('Hunt saved'); }
      else { await addHunt(toRow(draft)); toast('Hunt created — the next scan uses it'); }
      setDraft(emptyHunt()); setEditing(null); setOpen(false);
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };

  const edit = (h) => {
    setDraft({
      name: h.name || '',
      include: h.include || [], exclude: h.exclude || [], must: h.must || [],
      seniority: h.seniority || [], locations: h.locations || [],
      remote_pref: h.remote_pref || 'any',
      comp_floor: h.comp_floor ?? '',
      min_fit: h.min_fit ?? 0,
      active: h.active !== false,
    });
    setEditing(h.id);
    setOpen(true);
  };

  const rescan = async () => {
    try {
      const s = await runFullScan();
      toast(`Rescanned — ${s.queued} new match${s.queued === 1 ? '' : 'es'} queued`);
    } catch (ex) { toast(`Scan failed: ${ex.message}`, { err: true }); }
  };

  const list = hunts || [];
  return (
    <div className="card pad-md section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Hunts {list.length > 0 && <span className="countpill">{list.length}</span>}</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          {list.length > 0 && <button className="btn ghost sm" onClick={rescan} disabled={scanning}>{scanning ? 'Scanning…' : 'Rescan with these'}</button>}
          <button type="button" className="btn sm" onClick={() => { setDraft(emptyHunt()); setEditing(null); setOpen((o) => !o); }}>
            {open && !editing ? 'Close' : '+ New hunt'}
          </button>
        </div>
      </div>
      <p className="sub" style={{ marginTop: 2 }}>
        A saved search with its own terms, exclusions and floor. Every scan runs all of them, and each match says which hunt found it and why.
        {list.length === 0 && ' With no hunts, scans fall back to your Profile keywords.'}
      </p>

      {list.length > 0 && (
        <ul className="timeline section" style={{ marginBottom: 12 }}>
          {list.map((h) => (
            <li key={h.id} style={{ alignItems: 'center' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>{h.name}</b>
                {h.active === false && <span className="dimtext"> · paused</span>}
                <div className="sub" style={{ margin: 0 }}>
                  {(h.include || []).join(', ') || 'no terms'}
                  {(h.exclude || []).length > 0 && ` · never: ${h.exclude.join(', ')}`}
                  {h.comp_floor != null && ` · $${Math.round(h.comp_floor / 1000)}k floor`}
                  {h.remote_pref && h.remote_pref !== 'any' && ` · ${h.remote_pref}`}
                </div>
              </span>
              <span className="when">{h.last_run_at ? `ran ${fmtDateTime(h.last_run_at)}` : 'never run'}</span>
              <button type="button" className="btn ghost sm" onClick={() => saveHunt(h.id, { active: h.active === false })
                .then(() => toast(h.active === false ? 'Hunt resumed' : 'Hunt paused'))
                .catch((ex) => toast(ex.message, { err: true }))}>
                {h.active === false ? 'Resume' : 'Pause'}
              </button>
              <button type="button" className="btn ghost sm" onClick={() => edit(h)}>Edit</button>
              <button type="button" className="btn ghost sm" aria-label={`delete ${h.name}`}
                onClick={() => deleteHunt(h.id).then(() => toast('Hunt deleted')).catch((ex) => toast(ex.message, { err: true }))}>×</button>
            </li>
          ))}
        </ul>
      )}

      <Expand open={open}>
        <form onSubmit={submit} style={{ paddingTop: 6 }}>
          <HuntEditor value={draft} onChange={setDraft} idPrefix={editing ? 'he' : 'hn'} />
          {err && <p className="err-text" role="alert">{err}</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary sm" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save hunt' : 'Create hunt'}</button>
            <button type="button" className="btn ghost sm" onClick={() => { setOpen(false); setEditing(null); setDraft(emptyHunt()); }}>Cancel</button>
          </div>
        </form>
      </Expand>
    </div>
  );
}

// ============ COMPANY DISCOVERY — employers you never thought to name ============
function CompanyDiscovery() {
  const { discoverCompanies, addWatchBoard, hunts } = useApp();
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [found, setFound] = useState([]);
  const [checked, setChecked] = useState(0);
  const [poolSize, setPoolSize] = useState(0);
  const [label, setLabel] = useState('');
  const [err, setErr] = useState(null);
  const [deep, setDeep] = useState(false);
  const [watched, setWatched] = useState(() => new Set());
  const stopRef = useRef(false);

  const run = async () => {
    setRunning(true); setErr(null); setFound([]); setChecked(0);
    stopRef.current = false;
    try {
      let offset = 0;
      let failures = 0;
      // Six batches is roughly 50 companies — enough to fill a screen with
      // real hits without holding the user for the whole pool. "Search again"
      // starts over; Stop ends it where it is.
      for (let i = 0; i < 6; i++) {
        if (stopRef.current) break;
        let res;
        try {
          res = await discoverCompanies({ offset, deep, hunt_id: hunts?.[0]?.id });
        } catch (ex) {
          // One slow batch must not throw away the five that would have
          // worked. A probe sweep is a lot of third-party requests and some of
          // them time out; that is a reason to skip ahead, not to stop. Two
          // consecutive failures means something real is wrong — say so.
          failures += 1;
          if (failures >= 2) { setErr(ex.message); break; }
          offset += 8;
          continue;
        }
        failures = 0;
        setLabel(res.criteria_label);
        setPoolSize(res.pool_size);
        setChecked((c) => c + res.checked);
        if (res.found.length) setFound((f) => [...f, ...res.found].sort((a, b) => b.rank - a.rank));
        if (res.next_offset == null) break;
        offset = res.next_offset;
      }
    } catch (ex) { setErr(ex.message); } finally { setRunning(false); }
  };

  const watch = async (c) => {
    try {
      await addWatchBoard({ provider: c.provider, board: c.board, company_label: c.name });
      setWatched((s) => new Set(s).add(c.name));
      toast(`Watching ${c.name} — the next scan queues its ${c.matching_roles} matching role${c.matching_roles === 1 ? '' : 's'}`);
    } catch (ex) { toast(ex.message, { err: true }); }
  };

  const watchAll = async () => {
    const todo = found.filter((c) => !watched.has(c.name));
    let n = 0;
    for (const c of todo) {
      try { await addWatchBoard({ provider: c.provider, board: c.board, company_label: c.name }); n += 1; } catch { /* already watched, or gone */ }
    }
    setWatched(new Set(found.map((c) => c.name)));
    toast(`Now watching ${n} more compan${n === 1 ? 'y' : 'ies'} — run a scan to queue their roles`);
  };

  return (
    <div className="card pad-md section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Who else is hiring for this</h2>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* A toggle in the app's own language rather than a bare checkbox:
              every other on/off in Runway is a .chip pick, and the kit has no
              styled checkbox to fall back on. */}
          <button type="button" className={`chip pick${deep ? ' on' : ''}`} aria-pressed={deep}
            onClick={() => setDeep((d) => !d)} title="Probe all 13 ATS providers instead of the three that host most boards">
            all 13 ATS providers
          </button>
          {running
            ? <button className="btn sm" onClick={() => { stopRef.current = true; }}>Stop</button>
            : <button className="btn primary sm" onClick={run}>{found.length ? 'Search again' : 'Find companies'}</button>}
        </div>
      </div>
      <p className="sub" style={{ marginTop: 2 }}>
        Everything Runway could find used to be bounded by companies you had already thought of — and you cannot type a name you have never heard.
        This walks a pool of employers, finds each one's public board live, and ranks them by how many roles actually match your hunt.
      </p>

      {err && (
        <div className="errbox" role="alert" style={{ marginBottom: 12 }}>
          <div className="m">{err}</div>
          <button className="btn sm" onClick={run}>Retry</button>
        </div>
      )}

      {(running || checked > 0) && (
        <p className="sub">
          {running ? `Probing… ${checked} companies checked` : `Checked ${checked} of ${poolSize} companies`}
          {label && ` · aimed at ${label}`}
          {found.length > 0 && ` · ${found.length} with roles for you`}
        </p>
      )}

      {found.length > 0 && (
        <>
          <div className="disco">
            {found.map((c) => (
              <div className="disco-row" key={`${c.provider}-${c.board}`}>
                <div className="disco-main">
                  <div className="disco-co">
                    <b>{c.name}</b>
                    <span className="dimtext"> · {c.provider} · {VERTICAL_LABEL[c.vertical] || c.vertical}</span>
                  </div>
                  <div className="disco-count">
                    <b>{c.matching_roles}</b> matching role{c.matching_roles === 1 ? '' : 's'} of {c.open_roles} open
                  </div>
                  <ul className="disco-samples">
                    {c.samples.map((s, i) => (
                      <li key={i}>
                        {s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> : s.title}
                        <span className="dimtext"> · {s.score}{s.location ? ` · ${s.location}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <button className="btn sm" disabled={watched.has(c.name)} onClick={() => watch(c)}>
                  {watched.has(c.name) ? '✓ Watching' : 'Watch'}
                </button>
              </div>
            ))}
          </div>
          {!running && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button className="btn sm" onClick={watchAll}>Watch all {found.length}</button>
            </div>
          )}
        </>
      )}

      {!running && checked > 0 && found.length === 0 && (
        <p className="sub" style={{ marginBottom: 0 }}>
          Nothing matched across {checked} companies. That usually means the hunt's terms are narrow — widen them, or turn on the full provider search above.
        </p>
      )}
    </div>
  );
}

// ============ DISCOVERY INBOX — keyboard-driven triage of scan finds ============
function DiscoveryInbox() {
  const { discoveries, scanning, boards, hunts, acceptDiscovery, dismissDiscovery, requeueDiscovery, runFullScan } = useApp();
  const nav = useNavigate();
  const toast = useToast();
  const [sel, setSel] = useState(0);
  const [accepting, setAccepting] = useState(() => new Set());
  const listRef = useRef(null);
  const rowsRef = useRef([]);

  const items = discoveries || [];
  const huntName = (id) => (hunts || []).find((h) => h.id === id)?.name || null;
  useEffect(() => { setSel((s) => Math.max(0, Math.min(s, items.length - 1))); }, [items.length]);
  useEffect(() => { rowsRef.current[sel]?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  // `thenApply` is the whole point of triage: the reason you accepted a role is
  // that you intend to apply to it, and making that two separate journeys (back
  // to the board, find the card, open it, find the tab) is where the intent
  // goes. One key takes you to the apply desk with the job already created.
  const accept = async (d, { thenApply = false } = {}) => {
    if (accepting.has(d.id)) return;
    setAccepting((s) => new Set(s).add(d.id));
    try {
      const job = await acceptDiscovery(d);
      if (thenApply) { nav(`/apply/${job.id}`); return; }
      toast(`Added ${d.company} — ${d.title}${job.fit_score != null ? ` (fit ${job.fit_score})` : ''} to the board`);
    } catch (ex) {
      toast(`Couldn't add it: ${ex.message}`, { err: true });
      setAccepting((s) => { const n = new Set(s); n.delete(d.id); return n; });
    }
  };
  const dismiss = async (d) => {
    try {
      await dismissDiscovery(d);
      toast('Dismissed', { action: { label: 'Undo', fn: () => requeueDiscovery(d).catch((ex) => toast(ex.message, { err: true })) } });
    } catch (ex) { toast(`Couldn't dismiss: ${ex.message}`, { err: true }); }
  };

  const onKeyDown = (e) => {
    // only the list container drives triage keys; a keydown bubbling up from an
    // inner Open/Dismiss/Accept control must not act on the hovered row too
    if (e.target !== e.currentTarget) return;
    if (!items.length) return;
    const d = items[sel];
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if ((e.key === 'a' || e.key === 'Enter') && d) { e.preventDefault(); accept(d); }
    else if (e.key === 'p' && d) { e.preventDefault(); accept(d, { thenApply: true }); }
    else if ((e.key === 'x' || e.key === 'Backspace') && d) { e.preventDefault(); dismiss(d); }
    else if (e.key === 'o' && d?.url) { e.preventDefault(); window.open(d.url, '_blank', 'noopener'); }
  };

  const scanAll = async () => {
    try {
      const s = await runFullScan((done, total) => { if (total > 12) toast(`Scanning ${done}/${total} boards…`, { ms: 900 }); });
      if (s.keywords_missing) toast('Add title keywords on Profile so scans can match roles', { err: true });
      else toast(`Scan complete — ${s.queued} new match${s.queued === 1 ? '' : 'es'} queued`);
      if (s.board_errors?.length) toast(`${s.board_errors.length} board${s.board_errors.length === 1 ? '' : 's'} couldn’t be read: ${s.board_errors[0].error}`, { err: true, ms: 5000 });
    } catch (ex) { toast(`Scan failed: ${ex.message}`, { err: true }); }
  };

  const watchedCount = (boards || []).length;

  return (
    <div className="card pad-md section inbox">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>
          Discovery inbox{items.length > 0 && <span className="countpill">{items.length}</span>}
          {scanning && <span className="scanning-dot" title="scanning">● scanning…</span>}
        </h2>
        {watchedCount > 0 && (
          <button className="btn sm" onClick={scanAll} disabled={scanning}>{scanning ? 'Scanning…' : 'Scan now'}</button>
        )}
      </div>

      {discoveries === null ? (
        <><SkLine w="w60" /><SkLine w="w80" /><SkLine w="w40" /></>
      ) : items.length === 0 ? (
        <p className="sub" style={{ marginBottom: 0 }}>
          {watchedCount === 0
            ? 'Watch some companies below (a starter pack is the fastest start) and Runway will surface matching roles here — scored, ready to accept onto your board with one key.'
            : scanning
              ? 'Scanning your watched boards…'
              : 'All caught up — no new matches waiting. New roles on your watched boards show up here automatically.'}
        </p>
      ) : (
        <>
          <p className="sub" style={{ marginTop: 2 }}>
            {items.length} scored match{items.length === 1 ? '' : 'es'} from your watched boards.
            <span className="kbdhint"> <kbd>J</kbd>/<kbd>K</kbd> move · <kbd>A</kbd> accept · <kbd>P</kbd> accept &amp; apply · <kbd>X</kbd> dismiss · <kbd>O</kbd> open</span>
          </p>
          <div className="inbox-list" ref={listRef} tabIndex={0} onKeyDown={onKeyDown} role="listbox" aria-label="Discovered roles">
            {items.map((d, i) => {
              const comp = fmtComp(d.comp_min, d.comp_max);
              const isAccepting = accepting.has(d.id);
              return (
                <div key={d.id} ref={(el) => (rowsRef.current[i] = el)} role="option" aria-selected={i === sel}
                  className={`disc${i === sel ? ' on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => setSel(i)}>
                  <div className={`badge ${scoreBadge(d.fit_score)} disc-score`}>{d.fit_score ?? '—'}</div>
                  <div className="disc-main">
                    <div className="disc-co">{d.company} · <span className="mono">{d.provider}</span></div>
                    <div className="disc-ti">{d.title}</div>
                    <div className="disc-meta">
                      {comp && <span>{comp}</span>}
                      {d.remote_type && d.remote_type !== 'unknown' && <span>{d.remote_type}</span>}
                      {d.location && <span>{d.location}</span>}
                      {huntName(d.hunt_id) && <span title="the hunt that found this">◆ {huntName(d.hunt_id)}</span>}
                      {Array.isArray(d.flags) && d.flags.length > 0 && <span className="stale">⚑ {d.flags.length}</span>}
                    </div>
                    {/* WHY it matched, in the card. A match used to be a
                        boolean, so every card cost the same attention — you
                        could not tell a bullseye from a coincidence without
                        opening the posting. The reason is the whole difference
                        between triaging and reading. */}
                    {Array.isArray(d.match_why) && d.match_why.length > 0 && (
                      <div className="disc-why">
                        {d.match_why.slice(0, 3).map((w, wi) => (
                          <span key={wi} className={`whytag k-${w.kind}`}>{w.text}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="disc-actions">
                    {d.url && <a className="btn ghost sm" href={d.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open</a>}
                    <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); dismiss(d); }}>Dismiss</button>
                    <button className="btn sm" disabled={isAccepting} onClick={(e) => { e.stopPropagation(); accept(d); }}>
                      {isAccepting ? 'Adding…' : 'Accept'}
                    </button>
                    <button className="btn primary sm" disabled={isAccepting} title="Add it and open the apply desk"
                      onClick={(e) => { e.stopPropagation(); accept(d, { thenApply: true }); }}>
                      Accept &amp; apply →
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ============ STARTER PACKS — one click watches a whole vetted vertical ============
function StarterPacks() {
  const { boards, addWatchBoards, runFullScan } = useApp();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busyPack, setBusyPack] = useState(null);

  const watched = useMemo(() => new Set((boards || []).map((b) => `${b.provider}|${b.board}`)), [boards]);
  const packState = (pack) => {
    const total = pack.companies.length;
    const have = pack.companies.filter((c) => watched.has(`${c.provider}|${c.board}`)).length;
    return { total, have, remaining: total - have };
  };

  const addPack = async (pack) => {
    setBusyPack(pack.id);
    try {
      const added = await addWatchBoards(pack.companies);
      toast(added > 0 ? `Watching ${added} new compan${added === 1 ? 'y' : 'ies'} from ${pack.label}` : 'All of those are already watched');
      // immediately sweep the newly-watched boards so the inbox fills now
      const s = await runFullScan((done, total) => { if (total > 12) toast(`Scanning ${done}/${total}…`, { ms: 800 }); });
      if (s.keywords_missing) toast('Set title keywords on Profile so matches can surface', { err: true });
      else toast(`${pack.label}: ${s.queued} match${s.queued === 1 ? '' : 'es'} queued in the inbox`);
      if (s.board_errors?.length) toast(`${s.board_errors.length} board${s.board_errors.length === 1 ? '' : 's'} couldn’t be read right now`, { err: true, ms: 5000 });
    } catch (ex) { toast(`Couldn't add pack: ${ex.message}`, { err: true }); }
    finally { setBusyPack(null); }
  };

  return (
    <div className="card pad-md section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Starter packs</h2>
        <button type="button" className="btn ghost sm" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Browse packs'}</button>
      </div>
      <p className="sub" style={{ marginTop: 2 }}>
        Curated companies that hire paid-search / performance-marketing roles, each verified to have a live public board. One click watches the whole set and scans it.
      </p>
      <Expand open={open}>
        <div className="packs">
          {COMPANY_PACKS.map((pack) => {
            const st = packState(pack);
            const done = st.remaining === 0;
            return (
              <div className="pack" key={pack.id}>
                <div className="pack-head">
                  <b>{pack.label}</b>
                  <span className="sub">{st.total} companies{st.have > 0 && !done ? ` · ${st.have} watched` : ''}</span>
                </div>
                <p className="sub pack-blurb">{pack.blurb}</p>
                <button className="btn sm" disabled={busyPack === pack.id || done}
                  onClick={() => addPack(pack)}>
                  {done ? '✓ All watched' : busyPack === pack.id ? 'Adding…' : st.have > 0 ? `Watch ${st.remaining} more` : `Watch ${st.total} companies`}
                </button>
              </div>
            );
          })}
        </div>
      </Expand>
    </div>
  );
}

// one click on any job posting in the browser → lands here pre-parsed
function BookmarkletCard() {
  const toast = useToast();
  const anchorRef = useRef(null);
  const code = `javascript:void(window.open('${window.location.origin}/capture?url='+encodeURIComponent(location.href)))`;
  useEffect(() => { anchorRef.current?.setAttribute('href', code); }, [code]);
  return (
    <div className="card pad-md section bookmarklet">
      <h2>Capture from anywhere</h2>
      <p className="sub" style={{ marginTop: 0 }}>
        Drag this to your bookmarks bar. On any job posting, click it — Runway opens with the URL ready to parse.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <a ref={anchorRef} className="btn sm" onClick={(e) => e.preventDefault()} title="Drag me to the bookmarks bar">⚡ Send to Runway</a>
        <button type="button" className="btn ghost sm" onClick={async () => {
          try { await navigator.clipboard.writeText(code); toast('Bookmarklet code copied — paste it as a bookmark URL'); }
          catch { toast("Couldn't copy — drag the button instead", { err: true }); }
        }}>Copy code instead</button>
      </div>
    </div>
  );
}

// Watched boards: the companies Runway scans on your behalf.
function WatchlistCard() {
  const { boards, profile, addWatchBoard, removeWatchBoard } = useApp();
  const toast = useToast();
  const [input, setInput] = useState('');
  const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(false);
  const [finding, setFinding] = useState(false);
  const [findHits, setFindHits] = useState(null);
  const [findName, setFindName] = useState('');

  const noKeywords = !profile || !(profile.title_keywords || []).length;
  const looksLikeName = input.trim() && !/^https?:\/\//i.test(input.trim());

  const add = async (e) => {
    e.preventDefault();
    setErr(null); setFindHits(null);
    if (looksLikeName) {
      setFinding(true);
      try {
        const res = await apiPost('/api/find-board', { name: input.trim() });
        setFindName(input.trim());
        setFindHits(res.hits);
        if (!res.hits.length) setErr(`No public job board found for “${input.trim()}” across 13 providers — paste a board URL if you know it (Workday boards can only be pasted).`);
      } catch (ex) { setErr(ex.message); } finally { setFinding(false); }
      return;
    }
    const cls = classifyBoardUrl(input);
    if (!cls.ok) { setErr(cls.reason); return; }
    setAdding(true);
    try {
      await addWatchBoard({ provider: cls.provider, board: cls.board });
      setInput('');
      toast(`Watching ${cls.board} (${cls.provider})`);
    } catch (ex) { setErr(ex.message); } finally { setAdding(false); }
  };

  const watchHit = async (hit) => {
    try {
      await addWatchBoard({ provider: hit.provider, board: hit.board, company_label: findName || hit.board });
      setFindHits(null); setInput('');
      toast(`Watching ${findName || hit.board} (${hit.provider})`);
    } catch (ex) { setErr(ex.message); }
  };

  return (
    <div className="card pad-md section">
      <h2>Watched boards {(boards || []).length > 0 && <span className="countpill">{boards.length}</span>}</h2>
      <p className="sub" style={{ marginTop: 0 }}>
        Type a company name (Runway probes 13 board providers for it) or paste a board URL — Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, Breezy, Rippling, BambooHR, Jobvite, Pinpoint, Teamtailor, Personio, and Workday all publish public feeds. Scanned on open and every weekday morning once scheduled scans are on.
      </p>
      {noKeywords && (
        <div className="callout" style={{ marginBottom: 12 }}>
          <span>Scans match against your title keywords — none set yet, so nothing will surface.</span>
          <Link className="btn sm" to="/profile">Set keywords</Link>
        </div>
      )}
      {boards === null ? (
        <><SkLine w="w60" /><SkLine w="w40" /></>
      ) : boards.length === 0 ? (
        <p className="sub">No boards watched yet — grab a starter pack above, or add one here.</p>
      ) : (
        <ul className="timeline section" style={{ marginBottom: 14, maxHeight: 240, overflowY: 'auto' }}>
          {boards.map((b) => (
            <li key={b.id} style={{ alignItems: 'center' }}>
              <span style={{ flex: 1 }}>
                <b>{b.company_label || b.board}</b> · {b.provider}
                {(b.consecutive_failures || 0) >= 3 && (
                  <span className="stale" title={`${b.consecutive_failures} consecutive failed scans — the board may have moved or been taken down`}> ⚠ unreachable ×{b.consecutive_failures}</span>
                )}
              </span>
              <span className="when">{b.last_scanned_at ? `scanned ${fmtDateTime(b.last_scanned_at)}` : 'never scanned'}</span>
              <button type="button" className="btn ghost sm" aria-label={`stop watching ${b.board}`}
                onClick={async () => {
                  try { await removeWatchBoard(b.id); toast('Stopped watching'); }
                  catch (ex) { toast(ex.message, { err: true }); }
                }}>×</button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add}>
        <div className="frow" style={{ gridTemplateColumns: '1fr auto', marginBottom: 0 }}>
          <input className="field" aria-label="Company name or board URL to watch" placeholder="Company name, or a board URL"
            value={input} onChange={(e) => { setInput(e.target.value); setFindHits(null); }} />
          <button className="btn sm" disabled={adding || finding || !input.trim()}>
            {finding ? 'Finding…' : adding ? 'Adding…' : looksLikeName ? 'Find board' : '+ Watch'}
          </button>
        </div>
        {findHits?.length > 0 && (
          <div className="chips" style={{ marginTop: 10 }}>
            {findHits.map((h) => (
              <button key={`${h.provider}-${h.board}`} type="button" className="chip pick" onClick={() => watchHit(h)}>
                {h.board} · {h.provider} · {h.count} open role{h.count === 1 ? '' : 's'} — watch
              </button>
            ))}
          </div>
        )}
        {err && <p className="err-text" role="alert" style={{ marginTop: 8 }}>{err}</p>}
      </form>
    </div>
  );
}

export default function Capture() {
  const { addJob, profile } = useApp();
  const nav = useNavigate();
  const toast = useToast();
  const [f, setF] = useState(emptyJobForm);
  const [flags, setFlags] = useState([]);
  const [notes, setNotes] = useState('');
  const [source, setSource] = useState('manual');
  const [aiNotes, setAiNotes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const [paste, setPaste] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parseErr, setParseErr] = useState(null);

  const jobShape = useMemo(() => toJobShape(f, flags), [f, flags]);
  const preview = useMemo(() => scoreJob(jobShape, profile), [jobShape, profile]);

  const [searchParams] = useSearchParams();
  const autoRan = useRef(false);
  useEffect(() => {
    const u = searchParams.get('url');
    if (u && !autoRan.current) {
      autoRan.current = true;
      setPaste(u);
      parse(u);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const parse = async (override) => {
    const input = (typeof override === 'string' ? override : paste).trim();
    if (!input) return;
    setParseErr(null);
    const isUrl = looksLikeUrl(input);
    if (isUrl) {
      const cls = classifyJobUrl(input);
      if (cls.kind === 'blocked') {
        setParseErr(`${cls.host} doesn't allow automated reading of postings — open it and paste the description text here instead.`);
        return;
      }
    }
    setParsing(true);
    try {
      const res = await apiPost('/api/parse-job', isUrl ? { url: input } : { text: input });
      const x = normalizeExtraction(res.extraction);
      setF({
        company: x.company, title: x.title, url: res.source_url || (isUrl ? input : ''),
        location: x.location || '', remote_type: x.remote_type, seniority: x.seniority,
        industry: x.industry || '', comp_min: x.comp_min ?? '', comp_max: x.comp_max ?? '',
        raw_description: isUrl ? (res.raw_text || '') : input,
      });
      setFlags(x.flags);
      setAiNotes(x.notes);
      setSource(res.source || (isUrl ? 'url' : 'paste'));
      toast('Parsed — review the fields, then save');
    } catch (ex) {
      setParseErr(ex.message);
    } finally {
      setParsing(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const job = await addJob({ ...jobShape, notes, source });
      toast(job.fit_score != null ? `Captured — fit ${job.fit_score}/100` : 'Captured');
      nav(`/jobs/${job.id}`);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* "Capture" said what the lit rail item says. The sentence beside it is
          the one thing here the rail cannot carry — that nothing is submitted on
          your behalf — so it stays and becomes the head on its own. */}
      <div className="page-head">
        <span className="sub">Runway finds and scores roles for you — nothing is ever submitted on your behalf.</span>
      </div>

      <DiscoveryInbox />
      <HuntsCard />
      <CompanyDiscovery />
      <StarterPacks />

      <div className="cap-grid">
        <div>
          <WatchlistCard />

          <div className="card pad-md section">
            <h2>Paste a posting</h2>
            <div className="fld">
              <label className="f" htmlFor="cap-paste">Job URL or full description text</label>
              <textarea className="field" id="cap-paste" rows={3}
                placeholder="https://boards.greenhouse.io/… or paste the whole posting text"
                value={paste} onChange={(e) => setPaste(e.target.value)} />
            </div>
            {parseErr && (
              <div className="errbox" role="alert" style={{ marginBottom: 12 }}>
                <div className="m">{parseErr}</div>
                <button type="button" className="btn sm" onClick={() => parse()}>Retry</button>
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" className="btn primary" disabled={parsing || !paste.trim()} onClick={() => parse()}>
                {parsing ? 'Parsing…' : 'Parse with AI'}
              </button>
              <span className="sub">Greenhouse, Lever &amp; Ashby read cleanly via their public feeds. LinkedIn/Indeed: paste the text.</span>
            </div>
          </div>

          <form className="card pad-md section" onSubmit={submit}>
            <h2>Details</h2>
            <JobForm value={f} onChange={setF} flags={flags} onFlags={setFlags} idPrefix="cap" />
            <div className="fld">
              <label className="f" htmlFor="cap-notes">Notes</label>
              <textarea className="field" id="cap-notes" rows={3} placeholder="Anything worth remembering about this one…" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            {err && <p className="err-text" role="alert">Couldn’t save: {err} — fix and try again.</p>}
            <button className="btn primary" disabled={busy || !f.company.trim() || !f.title.trim()}>
              {busy ? 'Saving…' : 'Save to board'}
            </button>
          </form>

          <BookmarkletCard />
        </div>

        <aside className="card pad-md">
          <h2>Fit preview</h2>
          {preview.score == null ? (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                No target profile yet — captures will save unscored. Set your criteria once and every role gets graded against them.
              </p>
              <Link className="btn sm" to="/profile">Set up your profile</Link>
            </>
          ) : !(f.company.trim() || f.title.trim() || f.raw_description.trim()) ? (
            <p className="sub" style={{ marginTop: 0 }}>
              Parse a posting or start typing — the fit score previews live against your targets.
            </p>
          ) : (
            <>
              <div className="fitnum"><Num v={preview.score} dur={400} /></div>
              <p className="sub" style={{ marginTop: 0 }}>{preview.rationale}</p>
              <BreakdownBars breakdown={preview.breakdown} />
              <FlagChips flags={preview.flags} />
            </>
          )}
          {aiNotes.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h2>Between the lines</h2>
              <ul className="timeline">
                {aiNotes.map((n, i) => <li key={i}><span>⚑ {n}</span></li>)}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
