import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../lib/store.jsx';
import { supabase } from '../lib/supabase.js';
import { apiPost } from '../lib/api.js';
import { SENIORITY_LADDER } from '../lib/score.js';
import { useToast, SkPage, SkLine, ErrorState, Expand } from '../ui/primitives.jsx';

// ---------- master resume (feeds the Tailor drafts) ----------
const emptyRole = () => ({ company: '', title: '', dates: '', bullets: '' });

function ResumeCard() {
  const { session } = useApp();
  const toast = useToast();
  const emptyContact = { name: '', email: '', phone: '', location: '', links: '' };
  const [state, setState] = useState('loading'); // loading | error | ready
  const [loadErr, setLoadErr] = useState(null);
  const [contact, setContact] = useState(emptyContact);
  const [summary, setSummary] = useState('');
  const [skills, setSkills] = useState([]);
  const [roles, setRoles] = useState([emptyRole()]);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState(null);

  const load = useCallback(async () => {
    setState('loading'); setLoadErr(null);
    const { data, error } = await supabase.from('resume_master').select('content').maybeSingle();
    if (error) { setLoadErr(error.message); setState('error'); return; }
    const c = data?.content || {};
    const ct = c.contact || {};
    setContact({
      name: ct.name || '', email: ct.email || '', phone: ct.phone || '',
      location: ct.location || '', links: Array.isArray(ct.links) ? ct.links.join(', ') : '',
    });
    setSummary(c.summary || '');
    setSkills(Array.isArray(c.skills) ? c.skills : []);
    setRoles(
      Array.isArray(c.experience) && c.experience.length
        ? c.experience.map((r) => ({
            company: r.company || '', title: r.title || '', dates: r.dates || '',
            bullets: Array.isArray(r.bullets) ? r.bullets.join('\n') : '',
          }))
        : [emptyRole()],
    );
    setState('ready');
  }, []);
  useEffect(() => { load(); }, [load]);

  const setRole = (i, patch) => setRoles((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setSaveErr(null);
    try {
      const content = {
        contact: {
          name: contact.name.trim(), email: contact.email.trim(), phone: contact.phone.trim(),
          location: contact.location.trim(),
          links: contact.links.split(',').map((l) => l.trim()).filter(Boolean),
        },
        summary: summary.trim(),
        skills,
        experience: roles
          .map((r) => ({
            company: r.company.trim(), title: r.title.trim(), dates: r.dates.trim(),
            bullets: r.bullets.split('\n').map((b) => b.replace(/^[-•]\s*/, '').trim()).filter(Boolean),
          }))
          .filter((r) => r.company || r.title || r.bullets.length),
      };
      const { error } = await supabase
        .from('resume_master')
        .upsert({ user_id: session.user.id, content }, { onConflict: 'user_id' });
      if (error) throw error;
      toast('Master resume saved');
    } catch (ex) {
      setSaveErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  // paste a whole resume → AI structures it into the editor for review
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [importErr, setImportErr] = useState(null);
  const importResume = async () => {
    setImporting(true); setImportErr(null);
    try {
      const res = await apiPost('/api/parse-resume', { text: importText });
      const r = res.resume || {};
      const rc = r.contact || {};
      setContact({
        name: rc.name || '', email: rc.email || '', phone: rc.phone || '',
        location: rc.location || '', links: Array.isArray(rc.links) ? rc.links.join(', ') : '',
      });
      setSummary(r.summary || '');
      setSkills(Array.isArray(r.skills) ? [...new Set(r.skills.map((s) => String(s).toLowerCase().trim()).filter(Boolean))] : []);
      setRoles(
        Array.isArray(r.experience) && r.experience.length
          ? r.experience.map((x) => ({
              company: x.company || '', title: x.title || '', dates: x.dates || '',
              bullets: Array.isArray(x.bullets) ? x.bullets.join('\n') : '',
            }))
          : [emptyRole()],
      );
      setImportOpen(false);
      setImportText('');
      toast('Structured — review below, then Save resume');
    } catch (ex) { setImportErr(ex.message); } finally { setImporting(false); }
  };

  if (state === 'error') return <div className="section"><ErrorState msg={`Couldn't load your resume: ${loadErr}`} onRetry={load} /></div>;
  if (state === 'loading') return <div className="card pad-md section"><SkLine w="w40" /><SkLine w="w80" /><SkLine w="w60" /></div>;

  return (
    <form className="card pad-md section" onSubmit={save}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h2>Master resume</h2>
        <button type="button" className="btn ghost sm" onClick={() => setImportOpen((o) => !o)}>
          {importOpen ? 'Close import' : 'Import from pasted resume'}
        </button>
      </div>
      <p className="sub" style={{ marginTop: 0 }}>
        Stored once, structured — the Tailor tab on every job drafts from this. It never invents anything that isn’t here.
      </p>
      <Expand open={importOpen}>
        <div style={{ paddingBottom: 14 }}>
          <div className="fld">
            <label className="f" htmlFor="rm-import">Paste your whole resume</label>
            <textarea className="field" id="rm-import" rows={8} placeholder="Paste the full text of your resume — AI structures it into the editor below (nothing saves until you hit Save resume)."
              value={importText} onChange={(e) => setImportText(e.target.value)} />
          </div>
          {importErr && (
            <div className="errbox" role="alert" style={{ marginBottom: 10 }}>
              <div className="m">{importErr}</div>
              <button type="button" className="btn sm" onClick={importResume}>Retry</button>
            </div>
          )}
          <button type="button" className="btn primary sm" onClick={importResume} disabled={importing || importText.trim().length < 80}>
            {importing ? 'Structuring…' : 'Structure with AI'}
          </button>
        </div>
      </Expand>
      <div className="frow c2">
        <div>
          <label className="f" htmlFor="rm-name">Name</label>
          <input className="field" id="rm-name" placeholder="as it should appear on the resume" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
        </div>
        <div>
          <label className="f" htmlFor="rm-email">Email</label>
          <input className="field" id="rm-email" type="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
        </div>
      </div>
      <div className="frow c3">
        <div>
          <label className="f" htmlFor="rm-phone">Phone</label>
          <input className="field" id="rm-phone" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
        </div>
        <div>
          <label className="f" htmlFor="rm-loc">Location</label>
          <input className="field" id="rm-loc" placeholder="Chicago, IL" value={contact.location} onChange={(e) => setContact({ ...contact, location: e.target.value })} />
        </div>
        <div>
          <label className="f" htmlFor="rm-links">Links (comma-separated)</label>
          <input className="field" id="rm-links" placeholder="linkedin.com/in/…" value={contact.links} onChange={(e) => setContact({ ...contact, links: e.target.value })} />
        </div>
      </div>
      <div className="fld">
        <label className="f" htmlFor="rm-summary">Professional summary</label>
        <textarea className="field" id="rm-summary" rows={3} placeholder="Two or three sentences on who you are professionally…" value={summary} onChange={(e) => setSummary(e.target.value)} />
      </div>
      <div className="fld">
        <label className="f" htmlFor="rm-skills">Skills</label>
        <TagInput id="rm-skills" value={skills} placeholder="e.g. google ads, sa360, sql — press Enter to add"
          onAdd={(t) => setSkills((p) => (p.includes(t) ? p : [...p, t]))}
          onRemove={(t) => setSkills((p) => p.filter((x) => x !== t))} />
      </div>
      <label className="f">Experience</label>
      {roles.map((r, i) => (
        <div key={i} className="card pad-md" style={{ marginBottom: 10, background: 'rgba(255,255,255,0.02)' }}>
          <div className="frow c3">
            <div><label className="f" htmlFor={`rm-co-${i}`}>Company</label><input className="field" id={`rm-co-${i}`} value={r.company} onChange={(e) => setRole(i, { company: e.target.value })} /></div>
            <div><label className="f" htmlFor={`rm-ti-${i}`}>Title</label><input className="field" id={`rm-ti-${i}`} value={r.title} onChange={(e) => setRole(i, { title: e.target.value })} /></div>
            <div><label className="f" htmlFor={`rm-da-${i}`}>Dates</label><input className="field" id={`rm-da-${i}`} placeholder="2022 – present" value={r.dates} onChange={(e) => setRole(i, { dates: e.target.value })} /></div>
          </div>
          <div className="fld" style={{ marginBottom: 6 }}>
            <label className="f" htmlFor={`rm-bu-${i}`}>Bullets — one per line</label>
            <textarea className="field" id={`rm-bu-${i}`} rows={4} placeholder={'Managed $2.4M annual paid search budget across 12 healthcare clients\nCut CPA 31% by restructuring…'} value={r.bullets} onChange={(e) => setRole(i, { bullets: e.target.value })} />
          </div>
          {roles.length > 1 && (
            <button type="button" className="btn ghost sm" onClick={() => setRoles((rs) => rs.filter((_, idx) => idx !== i))}>Remove role</button>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn sm" onClick={() => setRoles((rs) => [...rs, emptyRole()])}>+ Add role</button>
        <button className="btn primary sm" disabled={busy}>{busy ? 'Saving…' : 'Save resume'}</button>
      </div>
      {saveErr && <p className="err-text" role="alert" style={{ marginTop: 8 }}>Couldn’t save: {saveErr} — try again.</p>}
    </form>
  );
}

function AccountCard() {
  const { session } = useApp();
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const change = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw error;
      setPw('');
      toast('Password changed');
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return (
    <form className="card pad-md section" onSubmit={change}>
      <h2>Account</h2>
      <p className="sub" style={{ marginTop: 0 }}>Signed in as {session?.user?.email}</p>
      <div className="frow c2">
        <div>
          <label className="f" htmlFor="ac-pw">New password</label>
          <input className="field" id="ac-pw" type="password" minLength={8} required autoComplete="new-password"
            value={pw} onChange={(e) => setPw(e.target.value)} />
        </div>
      </div>
      {err && <p className="err-text" role="alert">Couldn’t change it: {err} — try again.</p>}
      <button className="btn sm" disabled={busy || pw.length < 8}>{busy ? 'Changing…' : 'Change password'}</button>
    </form>
  );
}

// add/remove API (not a whole-array onChange) so parents can use functional
// state updates — rapid adds/removes can never clobber each other
function TagInput({ id, value, onAdd, onRemove, placeholder }) {
  const [txt, setTxt] = useState('');
  const add = () => {
    const v = txt.trim().toLowerCase();
    if (v) onAdd(v);
    setTxt('');
  };
  return (
    <div>
      <div className="chips" style={{ marginBottom: value.length ? 8 : 0 }}>
        {value.map((t) => (
          <span key={t} className="chip">
            {t}
            <button type="button" aria-label={`remove ${t}`} onClick={() => onRemove(t)}>×</button>
          </span>
        ))}
      </div>
      <input className="field" id={id} value={txt} placeholder={placeholder} onChange={(e) => setTxt(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
        onBlur={add} />
    </div>
  );
}

const fromProfile = (p) => ({
  title_keywords: p?.title_keywords || [],
  comp_floor: p?.comp_floor ?? '',
  remote_pref: p?.remote_pref || 'any',
  location_pref: p?.location_pref || '',
  seniority_band: p?.seniority_band || [],
  industries_in: p?.industries_in || [],
  industries_out: p?.industries_out || [],
  followup_days: p?.followup_days ?? 10,
});

export default function ProfilePage() {
  const { profile, jobs, loading, saveProfile, rescoreAll } = useApp();
  const toast = useToast();
  const [f, setF] = useState(() => fromProfile(profile));
  const [busy, setBusy] = useState(false);
  const [rescoring, setRescoring] = useState(false);
  const [offerRescore, setOfferRescore] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => { setF(fromProfile(profile)); }, [profile]);

  if (loading) return <SkPage cards={2} />;

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await saveProfile({
        ...f,
        comp_floor: f.comp_floor === '' ? null : Number(f.comp_floor),
        location_pref: f.location_pref.trim() || null,
        followup_days: Number(f.followup_days) || 10,
      });
      toast('Profile saved');
      if ((jobs || []).length > 0) setOfferRescore(true);
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };

  const rescore = async () => {
    setRescoring(true);
    try {
      const n = await rescoreAll();
      toast(`Re-scored ${n} job${n === 1 ? '' : 's'} against the new targets`);
      setOfferRescore(false);
    } catch (ex) { toast(`Re-score failed: ${ex.message}`, { err: true }); }
    finally { setRescoring(false); }
  };

  return (
    <>
      {/* "Profile & targets" under a lit Profile item. The half the rail does
          not say — that these are the criteria every captured role is scored
          against — is the sentence below, and it survives. */}
      <div className="page-head">
        <span className="sub">Every captured role is scored against these criteria.</span>
      </div>

      {offerRescore && (
        <div className="callout section">
          <span>Targets changed — existing fit scores are stale until you re-score.</span>
          <button className="btn sm" onClick={rescore} disabled={rescoring}>
            {rescoring ? 'Re-scoring…' : `Re-score ${(jobs || []).length} job${(jobs || []).length === 1 ? '' : 's'}`}
          </button>
        </div>
      )}

      <form className="card pad-md section" onSubmit={save}>
        <h2>What you're aiming at</h2>
        <div className="fld">
          <label className="f" htmlFor="tp-kw">Title keywords <span style={{ fontWeight: 400 }}>(any match counts — press Enter to add)</span></label>
          <TagInput id="tp-kw" value={f.title_keywords} placeholder="e.g. paid search, sem, performance marketing"
            onAdd={(t) => setF((p) => ({ ...p, title_keywords: p.title_keywords.includes(t) ? p.title_keywords : [...p.title_keywords, t] }))}
            onRemove={(t) => setF((p) => ({ ...p, title_keywords: p.title_keywords.filter((x) => x !== t) }))} />
        </div>
        <div className="frow c2">
          <div>
            <label className="f" htmlFor="tp-floor">Comp floor ($/yr)</label>
            <input className="field" id="tp-floor" type="number" min="0" step="5000" placeholder="120000" value={f.comp_floor} onChange={(e) => setF({ ...f, comp_floor: e.target.value })} />
          </div>
          <div>
            <label className="f" htmlFor="tp-loc">Location preference (note)</label>
            <input className="field" id="tp-loc" placeholder="e.g. Chicago or remote" value={f.location_pref} onChange={(e) => setF({ ...f, location_pref: e.target.value })} />
          </div>
        </div>
        <div className="fld">
          <label className="f">Remote preference</label>
          <div className="seg" role="radiogroup" aria-label="Remote preference">
            {['remote', 'hybrid', 'onsite', 'any'].map((r) => (
              <button key={r} type="button" className={f.remote_pref === r ? 'seg-opt active' : 'seg-opt'} onClick={() => setF((p) => ({ ...p, remote_pref: r }))}>{r}</button>
            ))}
          </div>
        </div>
        <div className="fld">
          <label className="f">Seniority band</label>
          <div className="chips">
            {SENIORITY_LADDER.map((s) => (
              <button key={s} type="button"
                className={`chip pick${f.seniority_band.includes(s) ? ' on' : ''}`}
                onClick={() => setF((p) => ({ ...p, seniority_band: p.seniority_band.includes(s) ? p.seniority_band.filter((x) => x !== s) : [...p.seniority_band, s] }))}>
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="frow c2">
          <div>
            <label className="f" htmlFor="tp-in">Industries in</label>
            <TagInput id="tp-in" value={f.industries_in} placeholder="e.g. healthcare, saas"
              onAdd={(t) => setF((p) => ({ ...p, industries_in: p.industries_in.includes(t) ? p.industries_in : [...p.industries_in, t] }))}
              onRemove={(t) => setF((p) => ({ ...p, industries_in: p.industries_in.filter((x) => x !== t) }))} />
          </div>
          <div>
            <label className="f" htmlFor="tp-out">Industries out</label>
            <TagInput id="tp-out" value={f.industries_out} placeholder="e.g. gambling, mlm"
              onAdd={(t) => setF((p) => ({ ...p, industries_out: p.industries_out.includes(t) ? p.industries_out : [...p.industries_out, t] }))}
              onRemove={(t) => setF((p) => ({ ...p, industries_out: p.industries_out.filter((x) => x !== t) }))} />
          </div>
        </div>
        <h2 style={{ marginTop: 20 }}>Cadence</h2>
        <div className="frow c2">
          <div>
            <label className="f" htmlFor="tp-fud">Follow-up window (business days)</label>
            <input className="field" id="tp-fud" type="number" min="1" max="60" value={f.followup_days} onChange={(e) => setF({ ...f, followup_days: e.target.value })} />
            <p className="sub" style={{ marginBottom: 0 }}>Anything sitting in Applied longer than this with no touch gets flagged on the board.</p>
          </div>
        </div>
        {err && <p className="err-text" role="alert">Couldn’t save: {err} — try again.</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save targets'}</button>
      </form>

      <ResumeCard />

      <AccountCard />
    </>
  );
}
