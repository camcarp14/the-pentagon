// Tailoring workspace for one job: generate AI drafts (resume bullets, cover
// letter, outreach, interview prep), edit freely, save immutable versions,
// export yourself. Nothing here sends anything to an employer — export is
// copy/download/print only.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { apiPost } from '../lib/api.js';
import { useToast, ErrorState, SkLine } from './primitives.jsx';
import { fmtDateTime } from '../lib/dates.js';

const KINDS = [
  ['resume_bullets', 'Resume bullets'],
  ['cover_letter', 'Cover letter'],
  ['outreach_note', 'Outreach'],
  ['prep_brief', 'Prep brief'],
];
const KIND_NOUN = {
  resume_bullets: 'resume bullet', cover_letter: 'cover letter',
  outreach_note: 'outreach', prep_brief: 'prep brief',
};
const PRINTABLE = new Set(['resume_bullets', 'cover_letter']);
const BLANK_TEMPLATE = {
  resume_bullets: '**Lead with:** \n\n',
  cover_letter: 'Dear hiring team,\n\n',
  outreach_note: '## Email to the recruiter or hiring manager\n\n\n\n## LinkedIn connection note\n\n',
  prep_brief: '## Likely interview questions\n\n- \n\n## Your stories\n\n- \n\n## Questions to ask them\n\n- ',
};

export default function TailorTab({ job }) {
  const toast = useToast();
  const [kind, setKind] = useState('resume_bullets');
  const [drafts, setDrafts] = useState(null); // all drafts for this job
  const [loadErr, setLoadErr] = useState(null);
  const [genErr, setGenErr] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState('');
  const [viewingVersion, setViewingVersion] = useState(null); // null = unsaved working copy
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoadErr(null);
    const { data, error } = await supabase
      .from('drafts').select('*').eq('job_id', job.id)
      .order('version', { ascending: false });
    if (error) setLoadErr(error.message);
    else setDrafts(data);
  }, [job.id]);
  useEffect(() => { load(); }, [load]);

  const list = (drafts || []).filter((d) => d.type === kind);
  const latest = list[0] || null;

  // switching kind (or fresh data) shows the latest saved version
  useEffect(() => {
    setEditor(latest?.content || '');
    setViewingVersion(latest?.version ?? null);
    setDirty(false);
    setGenErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, drafts]);

  const generate = async () => {
    setGenerating(true);
    setGenErr(null);
    try {
      const res = await apiPost('/api/tailor', { job_id: job.id, kind });
      setEditor(res.content);
      setViewingVersion(null);
      setDirty(true);
      toast('Draft generated — edit it, then save a version');
    } catch (ex) {
      setGenErr(ex.message);
    } finally {
      setGenerating(false);
    }
  };

  const saveVersion = async () => {
    if (!editor.trim()) return;
    setSaving(true);
    try {
      const version = (list[0]?.version || 0) + 1;
      const { error } = await supabase.from('drafts').insert({ job_id: job.id, type: kind, content: editor, version });
      if (error) throw error;
      await load();
      toast(`Saved v${version}`);
    } catch (ex) {
      toast(`Couldn't save: ${ex.message}`, { err: true });
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(editor);
      toast('Copied ✓');
    } catch {
      toast("Couldn't copy — select and copy manually", { err: true });
    }
  };

  const download = () => {
    const blob = new Blob([editor], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(job.company || 'job').replace(/[^a-z0-9-]+/gi, '-')}-${kind}${viewingVersion ? `-v${viewingVersion}` : '-draft'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const viewVersion = (d) => {
    setEditor(d.content);
    setViewingVersion(d.version);
    setDirty(false);
  };

  if (loadErr) return <ErrorState msg={`Couldn't load drafts: ${loadErr}`} onRetry={load} />;
  if (drafts === null) return <div className="card pad-md"><SkLine w="w40" /><SkLine w="w80" /><SkLine w="w60" /></div>;

  return (
    <div className="card pad-md">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <div className="seg" role="radiogroup" aria-label="Draft type">
          {KINDS.map(([id, label]) => (
            <button key={id} type="button" className={kind === id ? 'seg-opt active' : 'seg-opt'} onClick={() => setKind(id)}>{label}</button>
          ))}
        </div>
        <button className="btn primary sm" onClick={generate} disabled={generating}>
          {generating ? 'Drafting…' : list.length ? 'Generate fresh draft' : 'Generate draft'}
        </button>
      </div>

      {genErr && (
        <div className="errbox" role="alert" style={{ marginBottom: 12 }}>
          <div className="m">{genErr}</div>
          <button className="btn sm" onClick={generate}>Retry</button>
        </div>
      )}

      {!editor && list.length === 0 ? (
        <div className="empty">
          <div className="empty-title">No {KIND_NOUN[kind]} drafts yet</div>
          <div className="empty-sub">
            {kind === 'prep_brief'
              ? 'Generate an interview prep brief — likely questions, STAR stories mapped from your resume, gap talking points, and questions to ask them.'
              : kind === 'outreach_note'
                ? 'Generate recruiter/hiring-manager outreach grounded in your resume — you send it yourself, always.'
                : 'Generate one from your master resume — it lands here as an editable draft, never sent anywhere.'}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="btn primary md" onClick={generate} disabled={generating}>{generating ? 'Drafting…' : 'Generate draft'}</button>
            <button className="btn quiet md" onClick={() => { setEditor(BLANK_TEMPLATE[kind]); setDirty(true); }}>Start blank</button>
          </div>
        </div>
      ) : (
        <>
          <div className="fld">
            <label className="f" htmlFor="tailor-editor">
              {viewingVersion ? `Viewing v${viewingVersion}` : 'Unsaved working copy'}{dirty ? ' — edited' : ''}
            </label>
            <textarea className="field" id="tailor-editor" rows={16} value={editor}
              onChange={(e) => { setEditor(e.target.value); setDirty(true); setViewingVersion(null); }} />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary sm" onClick={saveVersion} disabled={saving || !editor.trim() || (!dirty && viewingVersion != null)}>
              {saving ? 'Saving…' : `Save as v${(list[0]?.version || 0) + 1}`}
            </button>
            <button className="btn sm" onClick={copy} disabled={!editor.trim()}>Copy</button>
            <button className="btn sm" onClick={download} disabled={!editor.trim()}>Download .md</button>
            {PRINTABLE.has(kind) && list.length > 0 && (
              <Link className="btn sm" to={`/print/${job.id}/${kind}`} title="Paper-clean render of the latest saved version — print to PDF">
                Print view
              </Link>
            )}
          </div>
          {list.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <h2>Version history</h2>
              <ul className="timeline">
                {list.map((d) => (
                  <li key={d.id} style={{ alignItems: 'center' }}>
                    <span className="when">{fmtDateTime(d.created_at)}</span>
                    <span style={{ flex: 1 }}><b>v{d.version}</b> · {d.content.length.toLocaleString()} chars</span>
                    <button className="btn ghost sm" onClick={() => viewVersion(d)} disabled={viewingVersion === d.version && !dirty}>
                      {viewingVersion === d.version && !dirty ? 'Viewing' : 'View'}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
