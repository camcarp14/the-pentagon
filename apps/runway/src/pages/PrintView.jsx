// Resume Studio — renders a saved tailored draft (resume bullets or cover
// letter) as a clean paper document: contact header from the master resume,
// then the draft body. Browser print → PDF → upload to the application.
// Nothing here is ever sent anywhere by the tool.
import { Fragment, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { useApp } from '../lib/store.jsx';
import { parseMarkdown, parseInline } from '../lib/markdown.js';
import { SkPage, EmptyState, ErrorState } from '../ui/primitives.jsx';

const KIND_LABEL = { resume_bullets: 'Tailored resume', cover_letter: 'Cover letter' };

function Inline({ text }) {
  return parseInline(text).map((seg, i) =>
    seg.t === 'b' ? <b key={i}>{seg.s}</b> : seg.t === 'i' ? <em key={i}>{seg.s}</em> : <Fragment key={i}>{seg.s}</Fragment>,
  );
}

function Markdown({ text }) {
  return parseMarkdown(text).map((b, i) => {
    if (b.type === 'h1') return <h1 key={i}><Inline text={b.text} /></h1>;
    if (b.type === 'h2') return <h2 key={i}><Inline text={b.text} /></h2>;
    if (b.type === 'h3') return <h3 key={i}><Inline text={b.text} /></h3>;
    if (b.type === 'hr') return <hr key={i} />;
    if (b.type === 'ul') return <ul key={i}>{b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}</ul>;
    return <p key={i}><Inline text={b.text} /></p>;
  });
}

export default function PrintView() {
  const { id, kind } = useParams();
  const { jobs, loading } = useApp();
  const [draft, setDraft] = useState(undefined); // undefined = loading, null = none
  const [contact, setContact] = useState(null);
  const [err, setErr] = useState(null);

  const load = async () => {
    setErr(null);
    const [d, r] = await Promise.all([
      supabase.from('drafts').select('*').eq('job_id', id).eq('type', kind).order('version', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('resume_master').select('content').maybeSingle(),
    ]);
    if (d.error || r.error) { setErr((d.error || r.error).message); return; }
    setDraft(d.data || null);
    setContact(r.data?.content?.contact || null);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id, kind]);

  const job = (jobs || []).find((j) => j.id === id);
  if (!KIND_LABEL[kind]) return <EmptyState title="Nothing to print" hint="Only resume and cover-letter drafts have a print view." cta="Back to the board" ctaTo="/" />;
  if (err) return <ErrorState msg={`Couldn't load the draft: ${err}`} onRetry={load} />;
  if (loading || jobs === null || draft === undefined) return <SkPage cards={1} />;
  if (!draft) {
    return (
      <EmptyState
        title={`No saved ${KIND_LABEL[kind].toLowerCase()} for this job yet`}
        hint="Generate and save a version on the Tailor tab first — the print view always renders the latest saved version."
        cta="Open the Tailor tab"
        ctaTo={`/jobs/${id}?tab=tailor`}
      />
    );
  }

  const contactLine = contact
    ? [contact.email, contact.phone, contact.location, ...(Array.isArray(contact.links) ? contact.links : [])].filter(Boolean).join('  ·  ')
    : null;

  return (
    <div className="studio">
      <div className="no-print studio-bar">
        <Link className="btn ghost sm" to={`/jobs/${id}?tab=tailor`}>← Back to Tailor</Link>
        <span className="sub">
          {KIND_LABEL[kind]} · {job ? `${job.company} — ${job.title}` : ''} · v{draft.version}
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
        {kind === 'cover_letter' && (
          <div className="paper-date">{new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
        )}
        <div className="paper-body">
          <Markdown text={draft.content} />
        </div>
      </div>
      <p className="sub no-print" style={{ textAlign: 'center' }}>
        Use your browser's print dialog → “Save as PDF”. Margins and page size come from the print settings.
      </p>
    </div>
  );
}
