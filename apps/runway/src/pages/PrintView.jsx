// Resume Studio — renders a saved draft as a clean paper document: contact
// header from the master resume, then the body. Browser print → PDF → upload
// to the application. Nothing here is ever sent anywhere by the tool.
//
// FOUR KINDS, TWO SOURCES. `resume_bullets` and `cover_letter` are Tailor-tab
// drafts (the `drafts` table, one type per row). `kit_resume` and `kit_cover`
// are halves of an Apply-desk application kit (the `app_kits` table, one row
// carrying both). They render identically on paper — the split is only about
// which table holds the latest version — so the loader branches and the
// document does not.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { useApp } from '../lib/store.jsx';
import Markdown from '../ui/Markdown.jsx';
import { SkPage, EmptyState, ErrorState } from '../ui/primitives.jsx';

const KINDS = {
  resume_bullets: { label: 'Tailored resume', table: 'drafts', back: 'tailor' },
  cover_letter: { label: 'Cover letter', table: 'drafts', back: 'tailor' },
  kit_resume: { label: 'Tailored resume', table: 'app_kits', field: 'resume_md', dated: false },
  kit_cover: { label: 'Cover letter', table: 'app_kits', field: 'cover_md', dated: true },
};
// A cover letter carries a date on paper; a resume does not.
const isDated = (kind) => kind === 'cover_letter' || KINDS[kind]?.dated;

export default function PrintView() {
  const { id, kind } = useParams();
  const { jobs, resume: master, loading } = useApp();
  const [doc, setDoc] = useState(undefined); // undefined = loading, null = none
  const [err, setErr] = useState(null);

  const spec = KINDS[kind];

  const load = async () => {
    setErr(null);
    if (!spec) return;
    if (spec.table === 'app_kits') {
      const { data, error } = await supabase
        .from('app_kits').select('version, resume_md, cover_md')
        .eq('job_id', id).order('version', { ascending: false }).limit(1).maybeSingle();
      if (error) { setErr(error.message); return; }
      const body = data?.[spec.field];
      setDoc(body ? { version: data.version, content: body } : null);
      return;
    }
    const { data, error } = await supabase
      .from('drafts').select('version, content')
      .eq('job_id', id).eq('type', kind).order('version', { ascending: false }).limit(1).maybeSingle();
    if (error) { setErr(error.message); return; }
    setDoc(data || null);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id, kind]);

  const job = (jobs || []).find((j) => j.id === id);
  const contact = master?.contact || null;
  const backTo = spec?.back === 'tailor' ? `/jobs/${id}?tab=tailor` : `/apply/${id}`;
  const backLabel = spec?.back === 'tailor' ? '← Back to Tailor' : '← Back to the apply desk';

  if (!spec) return <EmptyState title="Nothing to print" hint="Only resume and cover-letter documents have a print view." cta="Back to the board" ctaTo="/" />;
  if (err) return <ErrorState msg={`Couldn't load the document: ${err}`} onRetry={load} />;
  if (loading || jobs === null || doc === undefined) return <SkPage cards={1} />;
  if (!doc) {
    return (
      <EmptyState
        title={`No saved ${spec.label.toLowerCase()} for this job yet`}
        hint={spec.table === 'app_kits'
          ? 'Generate the application on the apply desk and save a version — the print view always renders the latest saved one.'
          : 'Generate and save a version on the Tailor tab first — the print view always renders the latest saved version.'}
        cta={spec.table === 'app_kits' ? 'Open the apply desk' : 'Open the Tailor tab'}
        ctaTo={backTo}
      />
    );
  }

  const contactLine = contact
    ? [contact.email, contact.phone, contact.location, ...(Array.isArray(contact.links) ? contact.links : [])].filter(Boolean).join('  ·  ')
    : null;

  return (
    <div className="studio">
      <div className="no-print studio-bar">
        <Link className="btn ghost sm" to={backTo}>{backLabel}</Link>
        <span className="sub">
          {spec.label} · {job ? `${job.company} — ${job.title}` : ''} · v{doc.version}
        </span>
        <button className="btn primary sm" onClick={() => window.print()}>Print / Save as PDF</button>
      </div>

      <div className="paper">
        {(contact?.name || contactLine) && (
          <header className="paper-head">
            {contact?.name && <div className="paper-name">{contact.name}</div>}
            {contactLine && <div className="paper-contact">{contactLine}</div>}
          </header>
        )}
        {isDated(kind) && (
          <div className="paper-date">{new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
        )}
        <div className="paper-body">
          <Markdown text={doc.content} />
        </div>
      </div>
      <p className="sub no-print" style={{ textAlign: 'center' }}>
        Use your browser's print dialog → “Save as PDF”. Margins and page size come from the print settings.
      </p>
    </div>
  );
}
