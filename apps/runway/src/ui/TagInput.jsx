// Chip list + a field that turns what you type into a chip on Enter, comma, or
// blur. Extracted from ProfilePage when the hunt editor became the fourth
// caller.
//
// add/remove API rather than a whole-array onChange, so every parent can use a
// FUNCTIONAL state update. With `onChange(nextArray)` two rapid adds both
// compute their next array from the same stale render and the second silently
// clobbers the first — which, on a list of search terms, looks like the app
// forgetting what you typed.
import { useMemo, useState } from 'react';
import { suggestTerms } from '../lib/rolefamilies.js';

export default function TagInput({ id, value, onAdd, onRemove, placeholder, suggest = false }) {
  const [txt, setTxt] = useState('');
  const add = (raw) => {
    const v = String(raw ?? txt).trim().toLowerCase();
    if (v) onAdd(v);
    setTxt('');
  };
  // Role-term autocomplete, but only where it means something: the hunt editor
  // asks for role terms and the synonym graph already knows every phrasing the
  // matcher will expand to, so showing them is showing the user what the search
  // is about to do.
  const hints = useMemo(
    () => (suggest ? suggestTerms(txt).filter((h) => !value.includes(h.term)).slice(0, 6) : []),
    [suggest, txt, value],
  );

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
        onBlur={() => add()} />
      {hints.length > 0 && (
        <div className="chips" style={{ marginTop: 8 }}>
          {hints.map((h) => (
            // onMouseDown, not onClick: the input's onBlur fires first on a
            // click and would commit the half-typed text, so the suggestion
            // would land beside the fragment that summoned it.
            <button type="button" key={h.term} className="chip pick"
              onMouseDown={(e) => { e.preventDefault(); add(h.term); }}>
              + {h.term}<span className="dimtext"> · {h.family}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
