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
import { fmtDateTime } from '../lib/dates.js';

const looksLikeUrl = (s) => /^https?:\/\/\S+$/i.test(s.trim()) && !s.trim().includes('\n');

// ============ DISCOVERY INBOX — keyboard-driven triage of scan finds ============
function DiscoveryInbox() {
  const { discoveries, scanning, boards, acceptDiscovery, dismissDiscovery, requeueDiscovery, runFullScan } = useApp();
  const toast = useToast();
  const [sel, setSel] = useState(0);
  const [accepting, setAccepting] = useState(() => new Set());
  const listRef = useRef(null);
  const rowsRef = useRef([]);

  const items = discoveries || [];
  useEffect(() => { setSel((s) => Math.max(0, Math.min(s, items.length - 1))); }, [items.length]);
  useEffect(() => { rowsRef.current[sel]?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const accept = async (d) => {
    if (accepting.has(d.id)) return;
    setAccepting((s) => new Set(s).add(d.id));
    try {
      const job = await acceptDiscovery(d);
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
            <span className="kbdhint"> <kbd>J</kbd>/<kbd>K</kbd> move · <kbd>A</kbd> accept · <kbd>X</kbd> dismiss · <kbd>O</kbd> open</span>
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
                      {Array.isArray(d.flags) && d.flags.length > 0 && <span className="stale">⚑ {d.flags.length}</span>}
                    </div>
                  </div>
                  <div className="disc-actions">
                    {d.url && <a className="btn ghost sm" href={d.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open</a>}
                    <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); dismiss(d); }}>Dismiss</button>
                    <button className="btn primary sm" disabled={isAccepting} onClick={(e) => { e.stopPropagation(); accept(d); }}>
                      {isAccepting ? 'Adding…' : 'Accept'}
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
