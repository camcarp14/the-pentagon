// THE APPLY DESK — one page, one application, done.
//
// The problem it exists for: tailoring produced prose and then left you at the
// form. A Greenhouse application is two uploads plus six free-text boxes, and
// those boxes are where the twenty minutes went — "Why do you want to work
// here?", "Describe your experience with X", "Salary expectations" — retyped
// from scratch for every posting, at declining quality, for the fortieth time.
//
// So this page fetches the REAL form (Greenhouse publishes it; everything else
// gets a ten-second paste), generates every answer in one pass alongside the
// resume and the letter, and then presents them in the order the form asks —
// each with its own Copy button. The loop becomes: copy, tab, paste, repeat.
//
// THREE THINGS IT DELIBERATELY WILL NOT DO:
//   • It does not submit. Ever. There is no code path to an employer.
//   • It does not answer demographic self-identification questions. Those are
//     filtered out server-side before the model sees them, and shown here
//     marked, empty, and explained.
//   • It does not fill your name and email with a model. Those come straight
//     out of the master resume, deterministically — a hallucinated phone
//     number is worse than an empty box.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { apiPost } from '../lib/api.js';
import { useApp, fmtComp } from '../lib/store.jsx';
import { useToast, SkPage, SkLine, EmptyState, ErrorState, Expand } from '../ui/primitives.jsx';
import Markdown from '../ui/Markdown.jsx';
import { fmtDateTime } from '../lib/dates.js';
import { useUnsavedGuard } from '../lib/unsaved.js';

// Mirrors netlify/functions/lib/appform.mjs. Duplicated on purpose and kept
// tiny: the server owns classification, the client only needs to know how to
// LABEL each class. A shared module here would drag the server's parser into
// the browser bundle for four strings.
const KIND_NOTE = {
  identity: 'From your master resume — nothing generated.',
  link: 'From your master resume — nothing generated.',
  sensitive: 'Voluntary self-identification. Runway never answers these; they are yours to answer or decline.',
  upload: 'Attach the file yourself — print the resume below to PDF first.',
};
const KIND_ORDER = { identity: 0, link: 1, open: 2, upload: 3, sensitive: 4 };

function CopyBox({ label, value, onCopy, multiline, onChange, disabled, hint, required }) {
  return (
    <div className={`q${required ? ' req' : ''}`}>
      <div className="q-head">
        <label className="f" htmlFor={`q-${label}`}>
          {label}
          {required && <span className="q-req" title="required on the form"> ·  required</span>}
        </label>
        <button type="button" className="btn ghost sm" disabled={!String(value || '').trim()} onClick={onCopy}>Copy</button>
      </div>
      {hint && <p className="q-hint">{hint}</p>}
      {multiline ? (
        <textarea className="field" id={`q-${label}`} rows={Math.min(10, Math.max(3, Math.ceil(String(value || '').length / 90)))}
          value={value || ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="field" id={`q-${label}`} value={value || ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

export default function ApplyDesk() {
  const { id } = useParams();
  const { jobs, resume, loading } = useApp();
  const toast = useToast();

  const [kits, setKits] = useState(null);       // saved versions, newest first
  const [loadErr, setLoadErr] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [source, setSource] = useState('none'); // none | greenhouse | pasted | manual
  const [sourceNote, setSourceNote] = useState('');
  const [answers, setAnswers] = useState({});
  const [resumeMd, setResumeMd] = useState('');
  const [coverMd, setCoverMd] = useState('');
  const [leadWith, setLeadWith] = useState([]);
  const [gaps, setGaps] = useState([]);
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty);

  const [fetching, setFetching] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [genErr, setGenErr] = useState(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const job = (jobs || []).find((j) => j.id === id);

  const load = useCallback(async () => {
    setLoadErr(null);
    const { data, error } = await supabase.from('app_kits').select('*').eq('job_id', id).order('version', { ascending: false });
    if (error) { setLoadErr(error.message); return; }
    setKits(data || []);
    const latest = (data || [])[0];
    if (latest) {
      setQuestions(Array.isArray(latest.questions) ? latest.questions : []);
      setAnswers(latest.answers && typeof latest.answers === 'object' ? latest.answers : {});
      setResumeMd(latest.resume_md || '');
      setCoverMd(latest.cover_md || '');
      setSource(latest.question_source || 'none');
      setDirty(false);
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  // ---- fetch the real form
  const fetchForm = async (pasted) => {
    setFetching(true); setGenErr(null);
    try {
      const res = await apiPost('/api/app-questions', { job_id: id, ...(pasted ? { pasted } : {}) });
      if (!res.supported) {
        setSourceNote(res.reason || '');
        setPasteOpen(true);
        toast("Couldn't read the form automatically — paste the questions", { ms: 4200 });
        return;
      }
      setQuestions(res.questions || []);
      setSource(res.source);
      setSourceNote('');
      // Deterministic prefill lands immediately: name, email, phone, LinkedIn
      // are known facts and there is no reason to wait for a model to restate
      // them. Never overwrites something already typed.
      setAnswers((a) => ({ ...(res.prefill || {}), ...a }));
      setDirty(true);
      setPasteOpen(false);
      setPasteText('');
      toast(res.source === 'greenhouse'
        ? `Read the real form — ${res.questions.length} field${res.questions.length === 1 ? '' : 's'}`
        : `${res.questions.length} question${res.questions.length === 1 ? '' : 's'} parsed`);
    } catch (ex) {
      setGenErr(ex.message);
    } finally {
      setFetching(false);
    }
  };

  // ---- generate everything in one pass
  const generate = async () => {
    setGenerating(true); setGenErr(null);
    try {
      const res = await apiPost('/api/app-kit', { job_id: id, questions });
      setResumeMd(res.resume_md || '');
      setCoverMd(res.cover_md || '');
      setAnswers((a) => ({ ...a, ...(res.answers || {}) }));
      setLeadWith(res.lead_with || []);
      setGaps(res.honest_gaps || []);
      setDirty(true);
      if (res.unanswered?.length) {
        toast(`${res.unanswered.length} question${res.unanswered.length === 1 ? '' : 's'} came back blank — they're marked below`, { err: true, ms: 5000 });
      } else {
        toast(`Application drafted — ${res.answered} of ${res.asked} question${res.asked === 1 ? '' : 's'} answered`);
      }
    } catch (ex) {
      setGenErr(ex.message);
    } finally {
      setGenerating(false);
    }
  };

  const saveVersion = async () => {
    setSaving(true);
    try {
      const version = ((kits || [])[0]?.version || 0) + 1;
      const { error } = await supabase.from('app_kits').insert({
        job_id: id, version, questions, answers,
        resume_md: resumeMd || null, cover_md: coverMd || null,
        question_source: source,
      });
      if (error) throw error;
      await load();
      toast(`Saved v${version}`);
    } catch (ex) {
      toast(`Couldn't save: ${ex.message}`, { err: true });
    } finally {
      setSaving(false);
    }
  };

  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(String(text || '')); toast(`${what} copied ✓`); }
    catch { toast("Couldn't copy — select and copy manually", { err: true }); }
  };

  const copyAll = () => {
    const lines = [];
    for (const q of ordered) {
      if (q.kind === 'sensitive' || q.kind === 'upload' || q.kind === 'hidden') continue;
      const v = answers[q.key];
      if (!String(v || '').trim()) continue;
      lines.push(`${q.label}\n${v}\n`);
    }
    copy(lines.join('\n'), 'Every answer');
  };

  const ordered = useMemo(
    () => [...(questions || [])]
      .filter((q) => q.kind !== 'hidden')
      .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)),
    [questions],
  );

  // Progress counts only what a human still has to deal with. Uploads and
  // self-identification boxes are excluded from the denominator rather than
  // counted as done — a green bar over an unfinished application is a lie you
  // find out about in the tab.
  const progress = useMemo(() => {
    const rows = ordered.filter((q) => q.kind !== 'sensitive' && q.kind !== 'upload');
    const filled = rows.filter((q) => String(answers[q.key] || '').trim()).length;
    return { total: rows.length, filled, manual: ordered.length - rows.length };
  }, [ordered, answers]);

  if (loading || jobs === null) return <SkPage cards={1} />;
  if (!job) return <EmptyState title="Job not found" hint="It may have been deleted." cta="Back to the board" ctaTo="/" />;
  if (loadErr) return <ErrorState msg={`Couldn't load saved applications: ${loadErr}`} onRetry={load} />;
  if (kits === null) return <div className="card pad-md"><SkLine w="w40" /><SkLine w="w80" /><SkLine w="w60" /></div>;

  const noResume = !resume || !Object.keys(resume).length;

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <Link to={`/jobs/${job.id}`} className="sub">← {job.company || 'Job'}</Link>
          <h1 className="t-title2" style={{ marginTop: 4 }}>Apply — {job.title || 'Untitled role'}</h1>
          <div className="sub" style={{ marginTop: 4 }}>
            {[fmtComp(job.comp_min, job.comp_max), job.location, job.remote_type !== 'unknown' ? job.remote_type : null].filter(Boolean).join(' · ') || 'No details yet'}
            {job.url && <> · <a href={job.url} target="_blank" rel="noreferrer">Open the posting ↗</a></>}
          </div>
        </div>
      </div>

      {noResume ? (
        <EmptyState
          title="Add your master resume first"
          hint="Every word this page produces is grounded in it — the resume, the letter and each answer. Nothing is invented, so there has to be something to draw from."
          cta="Open profile"
          ctaTo="/profile"
        />
      ) : (
        <>
          <div className="card pad-md section applybar">
            <div className="applybar-main">
              <div>
                <div className="t-label">The form</div>
                <div className="applybar-src">
                  {source === 'greenhouse' && <><b>Read from Greenhouse</b> — these are the real boxes on the real application.</>}
                  {source === 'pasted' && <><b>From your paste</b> — {questions.length} question{questions.length === 1 ? '' : 's'}.</>}
                  {source === 'manual' && <><b>Entered by hand.</b></>}
                  {source === 'none' && (questions.length
                    ? <>{questions.length} question{questions.length === 1 ? '' : 's'} loaded.</>
                    : <>No form loaded yet. Fetch it and every screening question gets answered too, not just the resume and letter.</>)}
                </div>
                {sourceNote && <p className="q-hint" style={{ marginTop: 6 }}>{sourceNote}</p>}
              </div>
              <div className="applybar-actions">
                <button className="btn sm" onClick={() => fetchForm()} disabled={fetching}>
                  {fetching ? 'Reading…' : questions.length ? 'Re-read the form' : 'Fetch the form'}
                </button>
                <button type="button" className="btn ghost sm" onClick={() => setPasteOpen((o) => !o)}>
                  {pasteOpen ? 'Close paste' : 'Paste questions'}
                </button>
                <button className="btn primary sm" onClick={generate} disabled={generating}>
                  {generating ? 'Drafting the application…' : resumeMd ? 'Regenerate everything' : 'Generate the application'}
                </button>
              </div>
            </div>

            {progress.total > 0 && (
              <div className="applyprog" title={`${progress.filled} of ${progress.total} fillable boxes have an answer`}>
                <div className="bar"><i style={{ width: `${Math.round((progress.filled / Math.max(1, progress.total)) * 100)}%` }} /></div>
                <span className="sub">
                  {progress.filled}/{progress.total} answered
                  {progress.manual > 0 && ` · ${progress.manual} you handle yourself`}
                </span>
                <button type="button" className="btn ghost sm" onClick={copyAll} disabled={!progress.filled}>Copy every answer</button>
              </div>
            )}

            <Expand open={pasteOpen}>
              <div style={{ paddingTop: 12 }}>
                <div className="fld">
                  <label className="f" htmlFor="ad-paste">Paste the form's questions — one per line</label>
                  <textarea className="field" id="ad-paste" rows={6}
                    placeholder={'Why do you want to work at Acme?\nDescribe your experience managing paid search budgets.\nWhat are your salary expectations?'}
                    value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
                </div>
                <button type="button" className="btn primary sm" disabled={fetching || pasteText.trim().length < 8} onClick={() => fetchForm(pasteText)}>
                  {fetching ? 'Parsing…' : 'Use these questions'}
                </button>
              </div>
            </Expand>
          </div>

          {genErr && (
            <div className="errbox section" role="alert">
              <div className="m">{genErr}</div>
              <button className="btn sm" onClick={generate}>Retry</button>
            </div>
          )}

          {(leadWith.length > 0 || gaps.length > 0) && (
            <div className="card pad-md section">
              {leadWith.length > 0 && (
                <>
                  <h2>This application leads with</h2>
                  <div className="chips">{leadWith.map((s, i) => <span className="chip" key={i}>{s}</span>)}</div>
                </>
              )}
              {gaps.length > 0 && (
                <>
                  <h2 style={{ marginTop: leadWith.length ? 18 : 0 }}>Stated honestly, not papered over</h2>
                  <ul className="timeline" style={{ marginBottom: 0 }}>
                    {gaps.map((g, i) => <li key={i}><span className="when">gap</span><span>{g}</span></li>)}
                  </ul>
                  <p className="sub" style={{ marginBottom: 0 }}>
                    Nothing above was claimed on your behalf. A gap is a talking point, not a disqualifier.
                  </p>
                </>
              )}
            </div>
          )}

          <div className="apply-grid">
            <div>
              {ordered.length === 0 ? (
                <div className="card pad-md section">
                  <h2>The form</h2>
                  <EmptyState
                    title="No questions loaded"
                    hint="Fetch the form (Greenhouse publishes it) or paste the questions. Without them you still get a tailored resume and cover letter — you just fill the boxes yourself."
                    cta="Fetch the form"
                    onCta={() => fetchForm()}
                  />
                </div>
              ) : (
                <div className="card pad-md section">
                  <h2>The form — in the order it asks</h2>
                  <p className="sub" style={{ marginTop: 0 }}>
                    Copy each answer straight into the box beside it. Everything here is editable, and nothing is submitted by Runway.
                  </p>
                  {ordered.map((q) => {
                    const locked = q.kind === 'sensitive' || q.kind === 'upload';
                    return (
                      <div key={q.key} className={`qwrap k-${q.kind}`}>
                        <CopyBox
                          label={q.label}
                          required={q.required}
                          value={locked ? '' : answers[q.key] || ''}
                          disabled={locked}
                          multiline={q.type === 'long_text'}
                          hint={KIND_NOTE[q.kind] || (q.options?.length ? `Pick one: ${q.options.map((o) => o.label).join(' · ')}` : q.description || null)}
                          onChange={(v) => { setAnswers((a) => ({ ...a, [q.key]: v })); setDirty(true); }}
                          onCopy={() => copy(answers[q.key], q.label)}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <div className="card pad-md section">
                <div className="doc-head">
                  <h2 style={{ margin: 0 }}>Tailored resume</h2>
                  <div className="doc-actions">
                    <button className="btn ghost sm" disabled={!resumeMd} onClick={() => copy(resumeMd, 'Resume')}>Copy</button>
                    {kits?.length > 0 && <Link className="btn ghost sm" to={`/print/${job.id}/kit_resume`}>Print view</Link>}
                  </div>
                </div>
                {resumeMd ? (
                  <>
                    <div className="doc">
                      <Markdown text={resumeMd} />
                    </div>
                    <details className="doc-edit">
                      <summary className="sub">Edit the markdown</summary>
                      <textarea className="field" rows={14} value={resumeMd}
                        onChange={(e) => { setResumeMd(e.target.value); setDirty(true); }} />
                    </details>
                  </>
                ) : (
                  <p className="sub" style={{ marginBottom: 0 }}>Not generated yet — the whole application comes out of one pass.</p>
                )}
              </div>

              <div className="card pad-md section">
                <div className="doc-head">
                  <h2 style={{ margin: 0 }}>Cover letter</h2>
                  <div className="doc-actions">
                    <button className="btn ghost sm" disabled={!coverMd} onClick={() => copy(coverMd, 'Cover letter')}>Copy</button>
                    {kits?.length > 0 && <Link className="btn ghost sm" to={`/print/${job.id}/kit_cover`}>Print view</Link>}
                  </div>
                </div>
                {coverMd ? (
                  <>
                    <div className="doc">
                      <Markdown text={coverMd} />
                    </div>
                    <details className="doc-edit">
                      <summary className="sub">Edit the text</summary>
                      <textarea className="field" rows={12} value={coverMd}
                        onChange={(e) => { setCoverMd(e.target.value); setDirty(true); }} />
                    </details>
                  </>
                ) : (
                  <p className="sub" style={{ marginBottom: 0 }}>Not generated yet.</p>
                )}
              </div>
            </div>
          </div>

          <div className="card pad-md section">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn primary sm" onClick={saveVersion} disabled={saving || (!resumeMd && !Object.keys(answers).length)}>
                {saving ? 'Saving…' : `Save as v${((kits || [])[0]?.version || 0) + 1}`}
              </button>
              <span className="sub">{dirty ? 'Unsaved changes' : kits?.length ? `Last saved v${kits[0].version}` : 'Nothing saved yet'}</span>
            </div>
            {kits?.length > 0 && (
              <ul className="timeline" style={{ marginTop: 14, marginBottom: 0 }}>
                {kits.map((k) => (
                  <li key={k.id} style={{ alignItems: 'center' }}>
                    <span className="when">{fmtDateTime(k.created_at)}</span>
                    <span style={{ flex: 1 }}>
                      <b>v{k.version}</b> · {Object.keys(k.answers || {}).length} answer{Object.keys(k.answers || {}).length === 1 ? '' : 's'}
                      {k.question_source !== 'none' && ` · form from ${k.question_source}`}
                    </span>
                    <button className="btn ghost sm" onClick={() => {
                      setQuestions(Array.isArray(k.questions) ? k.questions : []);
                      setAnswers(k.answers || {});
                      setResumeMd(k.resume_md || '');
                      setCoverMd(k.cover_md || '');
                      setSource(k.question_source || 'none');
                      setDirty(false);
                      toast(`Loaded v${k.version}`);
                    }}>Load</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </>
  );
}
