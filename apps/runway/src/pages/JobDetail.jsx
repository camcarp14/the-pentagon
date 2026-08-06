import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { apiPost } from '../lib/api.js';
import { normalizeExtraction } from '../lib/extract.js';
import { computeCoverage } from '../lib/coverage.js';
import { useApp, STAGES, stageLabel, fmtComp } from '../lib/store.jsx';
import { Num, SkPage, SkLine, EmptyState, ErrorState, Expand, useToast } from '../ui/primitives.jsx';
import { BreakdownBars, FlagChips } from '../ui/FitPanel.jsx';
import JobForm, { fromJob, toJobShape } from '../ui/JobForm.jsx';
import TailorTab from '../ui/TailorTab.jsx';
import { fmtDate, fmtDateTime, isoDay } from '../lib/dates.js';
import { suggestNextFollowUp } from '../lib/cadence.js';

const TABS = [
  ['overview', 'Overview'],
  ['tailor', 'Tailor'],
  ['notes', 'Notes & prep'],
  ['contacts', 'Contacts'],
  ['followups', 'Follow-ups'],
  ['history', 'History'],
];

// destructive actions arm first, never fire on a single stray click
function ArmButton({ label, armedLabel = 'Click again to confirm', className = 'btn danger sm', onConfirm }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button type="button" className={className} onClick={() => (armed ? onConfirm() : setArmed(true))}>
      {armed ? armedLabel : label}
    </button>
  );
}

function Stepper({ job, onMove }) {
  const cur = STAGES.findIndex((s) => s.id === job.status);
  return (
    <div className="stepper section" role="tablist" aria-label="Pipeline stage">
      {STAGES.map((s, i) => (
        <button key={s.id} type="button"
          className={`step${s.id === job.status ? ' on' : i < cur ? ' past' : ''}`}
          onClick={() => s.id !== job.status && onMove(s.id)}>
          {s.label}
        </button>
      ))}
    </div>
  );
}

// deterministic hit/miss of each posting requirement against the master
// resume — "can I claim this role, and where are the gaps"
//
// The resume comes off the store rather than a fetch of its own: four surfaces
// read this one row now, and four independent copies of it is four chances for
// two of them to disagree about what your resume says.
function CoveragePanel({ job }) {
  const { resume } = useApp();

  const reqs = Array.isArray(job.requirements) ? job.requirements.filter((r) => typeof r === 'string' && r.trim()) : [];
  if (!reqs.length) return null;
  if (resume === null) return <div className="card pad-md section"><SkLine w="w40" /><SkLine w="w80" /></div>;
  if (!resume || !Object.keys(resume).length) {
    return (
      <div className="card pad-md section">
        <h2>Requirements coverage</h2>
        <EmptyState title="Add your master resume to see coverage" hint="Once it's stored, every posting requirement gets a deterministic hit/miss against your actual experience." cta="Open profile" ctaTo="/profile" />
      </div>
    );
  }

  const cov = computeCoverage(reqs, resume);
  return (
    <div className="card pad-md section">
      <h2>Requirements coverage — {cov.hits}/{cov.total} evidenced by your resume</h2>
      <ul className="timeline">
        {cov.rows.map((r, i) => (
          <li key={i}>
            <span className="when" style={{ minWidth: 64, color: r.generic ? 'var(--faint)' : r.hit ? 'var(--good)' : 'var(--accent)' }}>
              {r.generic ? '—' : r.hit ? '✓ hit' : '△ gap'}
            </span>
            <span style={{ flex: 1 }}>
              {r.req}
              {r.hit && r.matched.length > 0 && (
                <span style={{ color: 'var(--faint)', fontSize: 12 }}> · via {r.matched.slice(0, 3).join(', ')}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {cov.hits < cov.total && (
        <p className="sub" style={{ marginBottom: 0 }}>
          Gaps aren’t disqualifiers — the Prep brief on the Tailor tab turns each one into an honest talking point.
        </p>
      )}
    </div>
  );
}

function Overview({ job }) {
  const { profile, updateJob, rescoreJob, deleteJob } = useApp();
  const toast = useToast();
  const nav = useNavigate();
  const [editOpen, setEditOpen] = useState(false);
  const [ef, setEf] = useState(() => fromJob(job));
  const [eflags, setEflags] = useState(() => (Array.isArray(job.flags) ? job.flags.filter((x) => typeof x === 'string') : []));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const saveEdit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await updateJob(job.id, toJobShape(ef, eflags));
      const updated = { ...job, ...toJobShape(ef, eflags) };
      if (profile) await rescoreJob(updated);
      toast('Details saved' + (profile ? ' and re-scored' : ''));
      setEditOpen(false);
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };

  const rescore = async () => {
    try {
      const j = await rescoreJob(job);
      toast(`Re-scored — fit ${j.fit_score}/100`);
    } catch (ex) { toast(`Couldn't re-score: ${ex.message}`, { err: true }); }
  };

  // enrich a scanned/pasted job with the full AI extraction (requirements,
  // flags, between-the-lines) — keeps existing values where the AI has none
  const [reextracting, setReextracting] = useState(false);
  const reextract = async () => {
    setReextracting(true);
    try {
      const res = await apiPost('/api/parse-job', { text: job.raw_description });
      const x = normalizeExtraction(res.extraction);
      const patch = {
        company: x.company || job.company,
        title: x.title || job.title,
        location: x.location ?? job.location,
        remote_type: x.remote_type !== 'unknown' ? x.remote_type : job.remote_type,
        seniority: x.seniority !== 'unknown' ? x.seniority : job.seniority,
        industry: x.industry ?? job.industry,
        comp_min: x.comp_min ?? job.comp_min,
        comp_max: x.comp_max ?? job.comp_max,
        requirements: x.requirements,
        flags: [...new Set([...x.flags, ...(Array.isArray(job.flags) ? job.flags.filter((f) => typeof f === 'string') : [])])],
      };
      const updated = await updateJob(job.id, patch);
      if (profile) await rescoreJob(updated);
      toast('Re-extracted with AI and re-scored');
    } catch (ex) {
      toast(`Couldn't re-extract: ${ex.message}`, { err: true });
    } finally {
      setReextracting(false);
    }
  };

  return (
    <>
      <div className="card pad-md section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <h2>Fit against your targets</h2>
          <div style={{ display: 'flex', gap: 6 }}>
            {job.raw_description && (
              <button className="btn ghost sm" onClick={reextract} disabled={reextracting} title="Run the full AI extraction over the stored posting text">
                {reextracting ? 'Extracting…' : 'Re-extract with AI'}
              </button>
            )}
            {profile && <button className="btn ghost sm" onClick={rescore}>Re-score</button>}
          </div>
        </div>
        {job.fit_score == null ? (
          <EmptyState title="Unscored" hint="Set up a target profile and re-score this role against it." cta="Open profile" ctaTo="/profile" />
        ) : (
          <>
            <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <div className="fitnum"><Num v={job.fit_score} dur={500} /></div>
              <p className="sub" style={{ margin: 0, flex: 1, minWidth: 200 }}>{job.fit_rationale}</p>
            </div>
            <BreakdownBars breakdown={Array.isArray(job.fit_breakdown) ? job.fit_breakdown : []} />
            <FlagChips flags={Array.isArray(job.flags) ? job.flags.filter((x) => typeof x === 'string') : []} />
          </>
        )}
      </div>

      <CoveragePanel job={job} />

      <div className="card pad-md section">
        <h2>Details</h2>
        <div className="dl">
          <div><div className="t-label">Comp</div><div className="val">{fmtComp(job.comp_min, job.comp_max) || '—'}</div></div>
          <div><div className="t-label">Location</div><div className="val">{job.location || '—'}</div></div>
          <div><div className="t-label">Remote</div><div className="val">{job.remote_type}</div></div>
          <div><div className="t-label">Seniority</div><div className="val">{job.seniority}</div></div>
          <div><div className="t-label">Industry</div><div className="val">{job.industry || '—'}</div></div>
          <div><div className="t-label">Source</div><div className="val">{job.source}</div></div>
          <div><div className="t-label">Captured</div><div className="val">{fmtDate(job.created_at)}</div></div>
          <div><div className="t-label">Applied</div><div className="val">{fmtDate(job.applied_at)}</div></div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => setEditOpen((o) => !o)}>{editOpen ? 'Close editor' : 'Edit details'}</button>
          <ArmButton label="Delete job" onConfirm={async () => {
            try { await deleteJob(job.id); toast('Deleted'); nav('/'); }
            catch (ex) { toast(`Couldn't delete: ${ex.message}`, { err: true }); }
          }} />
        </div>
        <Expand open={editOpen}>
          <form onSubmit={saveEdit} style={{ paddingTop: 16 }}>
            <JobForm value={ef} onChange={setEf} flags={eflags} onFlags={setEflags} idPrefix="edit" />
            {err && <p className="err-text" role="alert">Couldn’t save: {err} — try again.</p>}
            <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
          </form>
        </Expand>
      </div>

      {job.raw_description && (
        <div className="card pad-md section">
          <h2>Posting</h2>
          <pre className="desc">{job.raw_description}</pre>
        </div>
      )}
    </>
  );
}

function Notes({ job }) {
  const { updateJob } = useApp();
  const toast = useToast();
  const [notes, setNotes] = useState(job.notes || '');
  const [prep, setPrep] = useState(job.prep_notes || '');

  const saveIfChanged = async (field, value, current) => {
    if (value === current) return;
    try {
      await updateJob(job.id, { [field]: value });
      toast('Saved');
    } catch (ex) { toast(`Couldn't save: ${ex.message}`, { err: true }); }
  };

  return (
    <div className="card pad-md">
      <div className="fld">
        <label className="f" htmlFor="jd-notes">Notes</label>
        <textarea className="field" id="jd-notes" rows={6} placeholder="Research, comp intel, referral angles…"
          value={notes} onChange={(e) => setNotes(e.target.value)}
          onBlur={() => saveIfChanged('notes', notes, job.notes || '')} />
      </div>
      <div className="fld">
        <label className="f" htmlFor="jd-prep">Interview prep</label>
        <textarea className="field" id="jd-prep" rows={6} placeholder="Stories to tell, questions to ask, who you're meeting…"
          value={prep} onChange={(e) => setPrep(e.target.value)}
          onBlur={() => saveIfChanged('prep_notes', prep, job.prep_notes || '')} />
      </div>
      <p className="sub" style={{ margin: 0 }}>Saves automatically when you click away.</p>
    </div>
  );
}

function Contacts({ jobId }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [f, setF] = useState({ name: '', role: '', email: '', notes: '' });
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setErr(null);
    const { data, error } = await supabase.from('contacts').select('*').eq('job_id', jobId).order('created_at');
    if (error) setErr(error.message); else setRows(data);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [jobId]);

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data, error } = await supabase.from('contacts').insert({ job_id: jobId, ...f, role: f.role || null, email: f.email || null, notes: f.notes || null }).select().single();
      if (error) throw error;
      setRows((xs) => [...(xs || []), data]);
      setF({ name: '', role: '', email: '', notes: '' });
      toast('Contact added');
    } catch (ex) { toast(`Couldn't add: ${ex.message}`, { err: true }); }
    finally { setBusy(false); }
  };

  const del = async (id) => {
    const { error } = await supabase.from('contacts').delete().eq('id', id);
    if (error) return toast(`Couldn't delete: ${error.message}`, { err: true });
    setRows((xs) => xs.filter((x) => x.id !== id));
    toast('Contact removed');
  };

  if (err) return <ErrorState msg={`Couldn't load contacts: ${err}`} onRetry={load} />;
  if (rows === null) return <div className="card pad-md"><SkLine w="w60" /><SkLine w="w80" /><SkLine w="w40" /></div>;

  return (
    <div className="card pad-md">
      {rows.length === 0 ? (
        <p className="sub" style={{ marginTop: 0 }}>No contacts yet — add the recruiter or hiring manager below so follow-ups have a name.</p>
      ) : (
        <div className="tablewrap section">
          <table>
            <thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Notes</th><th /></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td><td>{c.role || '—'}</td>
                  <td>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : '—'}</td>
                  <td>{c.notes || '—'}</td>
                  <td><ArmButton label="×" armedLabel="sure?" className="btn ghost sm" onConfirm={() => del(c.id)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form onSubmit={add}>
        <div className="frow c3">
          <div><label className="f" htmlFor="ct-name">Name *</label><input className="field" id="ct-name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><label className="f" htmlFor="ct-role">Role</label><input className="field" id="ct-role" placeholder="recruiter / HM" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} /></div>
          <div><label className="f" htmlFor="ct-email">Email</label><input className="field" id="ct-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        </div>
        <div className="fld"><label className="f" htmlFor="ct-notes">Notes</label><input className="field" id="ct-notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
        <button className="btn sm" disabled={busy || !f.name.trim()}>{busy ? 'Adding…' : 'Add contact'}</button>
      </form>
    </div>
  );
}

function FollowUps({ job }) {
  const jobId = job.id;
  const { followUps, events, addFollowUp, setFollowUpDone, deleteFollowUp } = useApp();
  const toast = useToast();
  const defaultDue = () => { const d = new Date(); d.setDate(d.getDate() + 3); return isoDay(d); };
  const [due, setDue] = useState(defaultDue);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const rows = (followUps || []).filter((x) => x.job_id === jobId);
  const today = isoDay();

  // cadence suggestion (career-ops rules): stage-aware next follow-up, or the
  // stop signal once the applied-stage ladder is exhausted
  const stageEntered = [...(events || [])].reverse().find((e) => e.job_id === jobId)?.changed_at || null;
  const suggestion = suggestNextFollowUp(job, followUps, stageEntered);

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await addFollowUp({ job_id: jobId, due_date: due, note: note || null });
      setNote(''); setDue(defaultDue());
      toast('Follow-up scheduled');
    } catch (ex) { toast(`Couldn't schedule: ${ex.message}`, { err: true }); }
    finally { setBusy(false); }
  };

  return (
    <div className="card pad-md">
      {rows.length === 0 ? (
        <p className="sub" style={{ marginTop: 0 }}>Nothing scheduled — a follow-up on the books is what keeps this role off the “gone quiet” list.</p>
      ) : (
        <ul className="timeline section">
          {rows.map((fu) => (
            <li key={fu.id} style={{ alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={fu.done}
                onChange={async (e) => {
                  try { await setFollowUpDone(fu.id, e.target.checked); toast(e.target.checked ? 'Marked done' : 'Reopened'); }
                  catch (ex) { toast(ex.message, { err: true }); }
                }} aria-label={`follow-up ${fmtDate(fu.due_date)} done`} />
              <span className="when" style={{ color: !fu.done && fu.due_date < today ? 'var(--bad)' : undefined }}>
                {fmtDate(fu.due_date)}{!fu.done && fu.due_date < today ? ' · overdue' : ''}
              </span>
              <span style={{ flex: 1, textDecoration: fu.done ? 'line-through' : 'none', opacity: fu.done ? 0.55 : 1 }}>{fu.note || 'Follow up'}</span>
              <ArmButton label="×" armedLabel="sure?" className="btn ghost sm" onConfirm={async () => {
                try { await deleteFollowUp(fu.id); toast('Removed'); } catch (ex) { toast(ex.message, { err: true }); }
              }} />
            </li>
          ))}
        </ul>
      )}
      {suggestion?.cold && (
        <p className="sub" style={{ marginTop: 0 }}>⏸ {suggestion.reason} — energy spent here is energy not spent on a live one.</p>
      )}
      {suggestion && !suggestion.cold && (
        <div className="chips" style={{ marginBottom: 12 }}>
          <button type="button" className="chip pick" onClick={() => { setDue(suggestion.due_date); setNote(suggestion.note); }}
            title="Stage-aware cadence: applied → +7d (max 2, then rest); recruiter conversation → next day, then every 3; interview → thank-you next day">
            Suggested: {suggestion.note} · {fmtDate(suggestion.due_date)} — use
          </button>
        </div>
      )}
      <form onSubmit={add}>
        <div className="frow c2">
          <div><label className="f" htmlFor="fu-due">Due</label><input className="field" id="fu-due" type="date" required value={due} onChange={(e) => setDue(e.target.value)} /></div>
          <div><label className="f" htmlFor="fu-note">Note</label><input className="field" id="fu-note" placeholder="e.g. nudge the recruiter" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>
        <button className="btn sm" disabled={busy}>{busy ? 'Scheduling…' : 'Schedule follow-up'}</button>
      </form>
    </div>
  );
}

function History({ jobId }) {
  const { events } = useApp();
  const rows = [...(events || []).filter((e) => e.job_id === jobId)].reverse();
  if (rows.length === 0) return <div className="card pad-md"><p className="sub" style={{ margin: 0 }}>No history yet.</p></div>;
  return (
    <div className="card pad-md">
      <ul className="timeline">
        {rows.map((e) => (
          <li key={e.id}>
            <span className="when">{fmtDateTime(e.changed_at)}</span>
            <span><b>{stageLabel(e.stage)}</b>{e.note ? ` — ${e.note}` : ''}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function JobDetail() {
  const { id } = useParams();
  const { jobs, loading, moveStage } = useApp();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const wanted = searchParams.get('tab');
  const [tab, setTab] = useState(TABS.some(([t]) => t === wanted) ? wanted : 'overview');

  // ⌘K deep-links (e.g. "Add follow-up") land with ?tab=…
  useEffect(() => {
    if (wanted && TABS.some(([t]) => t === wanted)) setTab(wanted);
  }, [wanted]);

  if (loading || jobs === null) return <SkPage />;
  const job = jobs.find((j) => j.id === id);
  if (!job) return <EmptyState title="Job not found" hint="It may have been deleted." cta="Back to the board" ctaTo="/" />;

  const onMove = async (stage) => {
    try {
      await moveStage(job.id, stage);
      toast(`Moved to ${stageLabel(stage)}`);
    } catch (ex) { toast(`Couldn't move: ${ex.message}`, { err: true }); }
  };

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <Link to="/" className="sub">← Board</Link>
          <h1 className="t-title2" style={{ marginTop: 4 }}>{job.company || 'Unknown'} — {job.title || 'Untitled role'}</h1>
          <div className="sub" style={{ marginTop: 4 }}>
            {[fmtComp(job.comp_min, job.comp_max), job.location, job.remote_type !== 'unknown' ? job.remote_type : null].filter(Boolean).join(' · ') || 'No details yet'}
            {job.url && <> · <a href={job.url} target="_blank" rel="noreferrer">View posting ↗</a></>}
          </div>
        </div>
        <div className="jd-head-right">
          {/* The primary action on a job is applying to it. It used to be four
              clicks deep behind a tab called "Tailor" that produced prose you
              then retyped into a form; the apply desk is where the whole thing
              happens, so it is the button. */}
          {job.status !== 'closed' && (
            <Link className="btn primary" to={`/apply/${job.id}`} title="Fetch the real application form and draft every answer in one pass">
              Apply →
            </Link>
          )}
          {job.fit_score != null && <div className="fitnum" title={job.fit_rationale}><Num v={job.fit_score} dur={500} /></div>}
        </div>
      </div>

      {job.posting_state === 'gone' && (
        <div className="callout section" role="alert">
          <span>
            ✕ <b>This posting looks taken down</b>{job.posting_checked_at ? ` (checked ${fmtDateTime(job.posting_checked_at)})` : ''}
            {job.posting_note ? ` — ${job.posting_note}` : ''}. Nothing was changed automatically — close it, or keep it if you're already in process.
          </span>
          {job.url && <a className="btn sm" href={job.url} target="_blank" rel="noreferrer">Verify yourself ↗</a>}
        </div>
      )}

      <Stepper job={job} onMove={onMove} />

      <div className="tabs">
        {TABS.map(([tid, label]) => (
          <button key={tid} className={tab === tid ? 'on' : ''} onClick={() => setTab(tid)}>{label}</button>
        ))}
      </div>

      <div className="pagefade" key={tab}>
        {tab === 'overview' && <Overview job={job} key={job.updated_at} />}
        {tab === 'tailor' && <TailorTab job={job} />}
        {tab === 'notes' && <Notes job={job} key={job.id} />}
        {tab === 'contacts' && <Contacts jobId={job.id} />}
        {tab === 'followups' && <FollowUps job={job} />}
        {tab === 'history' && <History jobId={job.id} />}
      </div>
    </>
  );
}
