// Shared job field grid — used by Capture and by JobDetail's edit panel so
// the same field always reads the same way everywhere.
import { REMOTE_TYPES } from '../lib/store.jsx';
import { SENIORITY_LADDER, FLAG_DEFS } from '../lib/score.js';

const MANUAL_FLAGS = ['buzzword_heavy', 'unreasonable_requirements'];

export const emptyJobForm = {
  company: '', title: '', url: '', location: '', remote_type: 'unknown',
  seniority: 'unknown', industry: '', comp_min: '', comp_max: '', raw_description: '',
};

export const fromJob = (job) => ({
  company: job.company || '', title: job.title || '', url: job.url || '',
  location: job.location || '', remote_type: job.remote_type || 'unknown',
  seniority: job.seniority || 'unknown', industry: job.industry || '',
  comp_min: job.comp_min ?? '', comp_max: job.comp_max ?? '',
  raw_description: job.raw_description || '',
});

export const toJobShape = (f, flags) => ({
  company: f.company.trim(), title: f.title.trim(), url: f.url.trim() || null,
  location: f.location.trim() || null, remote_type: f.remote_type, seniority: f.seniority,
  industry: f.industry.trim() || null,
  comp_min: f.comp_min === '' ? null : Number(f.comp_min),
  comp_max: f.comp_max === '' ? null : Number(f.comp_max),
  raw_description: f.raw_description || null,
  flags,
});

export default function JobForm({ value, onChange, flags, onFlags, idPrefix = 'jf' }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  const toggleFlag = (id) => onFlags(flags.includes(id) ? flags.filter((x) => x !== id) : [...flags, id]);
  return (
    <>
      <div className="frow c2">
        <div>
          <label className="f" htmlFor={`${idPrefix}-company`}>Company *</label>
          <input className="field" id={`${idPrefix}-company`} required value={value.company} onChange={set('company')} />
        </div>
        <div>
          <label className="f" htmlFor={`${idPrefix}-title`}>Title *</label>
          <input className="field" id={`${idPrefix}-title`} required value={value.title} onChange={set('title')} />
        </div>
      </div>
      <div className="frow c2">
        <div>
          <label className="f" htmlFor={`${idPrefix}-url`}>Posting URL</label>
          <input className="field" id={`${idPrefix}-url`} type="url" placeholder="https://…" value={value.url} onChange={set('url')} />
        </div>
        <div>
          <label className="f" htmlFor={`${idPrefix}-location`}>Location</label>
          <input className="field" id={`${idPrefix}-location`} placeholder="e.g. Chicago, IL" value={value.location} onChange={set('location')} />
        </div>
      </div>
      <div className="frow c3">
        <div>
          <label className="f" htmlFor={`${idPrefix}-remote`}>Remote</label>
          <select className="field" id={`${idPrefix}-remote`} value={value.remote_type} onChange={set('remote_type')}>
            {REMOTE_TYPES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label className="f" htmlFor={`${idPrefix}-seniority`}>Seniority</label>
          <select className="field" id={`${idPrefix}-seniority`} value={value.seniority} onChange={set('seniority')}>
            <option value="unknown">unknown</option>
            {SENIORITY_LADDER.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="f" htmlFor={`${idPrefix}-industry`}>Industry</label>
          <input className="field" id={`${idPrefix}-industry`} placeholder="e.g. healthcare" value={value.industry} onChange={set('industry')} />
        </div>
      </div>
      <div className="frow c2">
        <div>
          <label className="f" htmlFor={`${idPrefix}-cmin`}>Comp min ($/yr)</label>
          <input className="field" id={`${idPrefix}-cmin`} type="number" min="0" step="1000" placeholder="120000" value={value.comp_min} onChange={set('comp_min')} />
        </div>
        <div>
          <label className="f" htmlFor={`${idPrefix}-cmax`}>Comp max ($/yr)</label>
          <input className="field" id={`${idPrefix}-cmax`} type="number" min="0" step="1000" placeholder="150000" value={value.comp_max} onChange={set('comp_max')} />
        </div>
      </div>
      <div className="fld">
        <label className="f" htmlFor={`${idPrefix}-desc`}>Job description</label>
        <textarea className="field" id={`${idPrefix}-desc`} rows={7} placeholder="Paste the posting text — scoring reads it for industry and keyword signals." value={value.raw_description} onChange={set('raw_description')} />
      </div>
      <div className="fld">
        <label className="f">Red flags you spotted</label>
        <div className="chips">
          {MANUAL_FLAGS.map((id) => (
            <button key={id} type="button" title={FLAG_DEFS[id].hint}
              className={`chip pick${flags.includes(id) ? ' on' : ''}`}
              onClick={() => toggleFlag(id)}>
              ⚑ {FLAG_DEFS[id].label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
