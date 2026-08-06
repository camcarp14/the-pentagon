// Application forms, normalized. Pure functions — no network, no model calls —
// so the smoke test can plant real captured Greenhouse payloads against them.
//
// WHAT THIS IS FOR: the tailoring workspace produced a resume and a cover
// letter and then abandoned you at the actual form, which is where the time
// goes. A Greenhouse application is rarely two file uploads; it is two uploads
// plus six free-text boxes — "Why do you want to work here?", "Describe your
// experience with X", "What are your salary expectations?" — that you write
// from scratch, badly, at 11pm, for the fortieth time.
//
// Greenhouse publishes those boxes. `?questions=true` on the public job-board
// endpoint returns the real form: every field, its type, whether it is
// required, and the exact option labels for the dropdowns. So Runway can answer
// the actual questions rather than guessing at likely ones — and the UI is
// allowed to say which of those two things happened, because they are very
// different promises.
//
// ── THREE CLASSES OF FIELD, AND WHY THEY ARE HANDLED DIFFERENTLY ────────────
//
//   IDENTITY (name, email, phone, location, LinkedIn). Deterministic. These
//   come straight from the master resume's contact block. No model is involved
//   and none should be: a hallucinated phone number is worse than a blank one,
//   and there is nothing here to reason about.
//
//   SENSITIVE (gender, race, veteran status, disability). NEVER answered, by
//   anything, ever. These are EEO/legal self-identification questions. They are
//   the candidate's to answer or decline, they are voluntary by law, and a tool
//   that pre-fills them — even with "prefer not to say" — has made a personal
//   declaration on someone's behalf. They are surfaced in the list, marked, and
//   left empty.
//
//   OPEN (everything else). The model drafts these from the resume and the
//   posting. Drafts, editable, never submitted by us.

// Greenhouse's own field names for the standard identity block, plus the
// variants that show up on custom forms.
const IDENTITY_MAP = {
  first_name: 'contact.first_name',
  last_name: 'contact.last_name',
  name: 'contact.name',
  full_name: 'contact.name',
  email: 'contact.email',
  phone: 'contact.phone',
  location: 'contact.location',
  'job_application[location]': 'contact.location',
};

// Matched against the LABEL, lowercased. Deliberately broad: a false positive
// here means a box we decline to auto-answer, which is a fine failure. A false
// negative means a model writing a demographic self-identification, which is
// not.
const SENSITIVE_PATTERNS = [
  /\bgender\b/, /\brace\b/, /\bethnic/, /\bhispanic\b/, /\blatino\b/,
  /\bveteran\b/, /\bdisabilit/, /\bdisabled\b/, /\bpronoun/, /\bsexual orientation\b/,
  /\bage\b.*\b(range|bracket)\b/, /\bself[- ]identif/, /\bequal (employment )?opportunity\b/,
  /\beeo\b/, /\bprotected (veteran|class)\b/, /\bmilitary (status|service)\b/,
];

// Labels that ask for a link rather than prose. Answered from the resume's
// links when one obviously matches, never invented.
const LINK_PATTERNS = [
  [/\blinkedin\b/, 'linkedin'],
  [/\bgithub\b/, 'github'],
  [/\bportfolio\b|\bpersonal (web)?site\b|\bwebsite\b/, 'website'],
  [/\btwitter\b|\bx\.com\b/, 'twitter'],
];

const GREENHOUSE_TYPE = {
  input_text: 'text',
  textarea: 'long_text',
  input_file: 'file',
  input_hidden: 'hidden',
  multi_value_single_select: 'select',
  multi_value_multi_select: 'multi_select',
  boolean: 'select',
};

const isSensitive = (label) => SENSITIVE_PATTERNS.some((re) => re.test(String(label || '').toLowerCase()));

const linkKindFor = (label) => {
  const l = String(label || '').toLowerCase();
  for (const [re, kind] of LINK_PATTERNS) if (re.test(l)) return kind;
  return null;
};

/**
 * One normalized question:
 *   key        the ATS's own field name — what makes an edited answer
 *              re-attachable after the form is re-fetched in another order
 *   label      what the box says
 *   type       text | long_text | select | multi_select | file | hidden
 *   options    [{label, value}] for the select types
 *   required   the form's own flag
 *   kind       'identity' | 'sensitive' | 'link' | 'open'
 *   fill       for identity/link: which resume field supplies it
 *   note       why an unanswerable field is unanswerable, in plain words
 */
function normalize({ key, label, type, options = [], required = false, description = '' }) {
  const base = { key, label: String(label || key || '').trim(), type, options, required, description: String(description || '').trim() };

  if (type === 'file') {
    return { ...base, kind: 'upload', note: 'Upload — export the resume from this page and attach it yourself.' };
  }
  if (type === 'hidden') return { ...base, kind: 'hidden', note: 'Hidden form field — nothing to fill in.' };
  if (isSensitive(base.label)) {
    return { ...base, kind: 'sensitive', note: 'Voluntary self-identification. Runway never answers these — they are yours to answer or decline.' };
  }
  const identity = IDENTITY_MAP[String(key || '').toLowerCase()];
  if (identity) return { ...base, kind: 'identity', fill: identity };

  const link = linkKindFor(base.label);
  if (link) return { ...base, kind: 'link', fill: `links.${link}` };

  return { ...base, kind: 'open' };
}

/**
 * Greenhouse: GET /v1/boards/{board}/jobs/{id}?questions=true
 *
 * A "question" wraps one or more FIELDS, and it is the field that carries the
 * name the form submits under. Multi-field questions are rare (a location
 * autocomplete with a hidden id beside it) and each field becomes its own row
 * so nothing is silently dropped — the hidden ones are marked and ignored.
 */
export function parseGreenhouseQuestions(payload) {
  const qs = Array.isArray(payload?.questions) ? payload.questions : [];
  const out = [];
  for (const q of qs) {
    const fields = Array.isArray(q?.fields) ? q.fields : [];
    for (const f of fields) {
      const type = GREENHOUSE_TYPE[String(f?.type || '')] || 'text';
      const options = Array.isArray(f?.values)
        ? f.values.map((v) => ({ label: String(v?.label ?? v?.value ?? ''), value: v?.value ?? v?.label })).filter((o) => o.label)
        : [];
      out.push(normalize({
        key: String(f?.name || ''),
        label: q?.label,
        description: q?.description,
        required: !!q?.required,
        type,
        options,
      }));
    }
  }
  // Greenhouse returns the EEOC block separately from `questions`. Surfacing it
  // (marked, never answered) is more honest than omitting it: the form has
  // those boxes and a checklist that pretends otherwise sends you into the tab
  // thinking you are done.
  const compliance = Array.isArray(payload?.compliance) ? payload.compliance : [];
  for (const c of compliance) {
    for (const q of Array.isArray(c?.questions) ? c.questions : []) {
      for (const f of Array.isArray(q?.fields) ? q.fields : []) {
        out.push(normalize({
          key: String(f?.name || ''),
          label: q?.label || c?.type || 'Voluntary self-identification',
          required: !!q?.required,
          type: GREENHOUSE_TYPE[String(f?.type || '')] || 'select',
          options: [],
        }));
      }
    }
  }
  return out.filter((q) => q.key);
}

/**
 * Any other ATS: the user pastes the form's questions, one per line (or as a
 * numbered/bulleted list). Heuristics only — this is a convenience, not a
 * parser, and every row lands editable.
 *
 * A line is treated as a question when it ends in "?" or reads like a prompt
 * ("Describe…", "Tell us…", "Why…"). Everything else that is long enough to be
 * a real label is kept too, because ATS forms are full of statements
 * ("Salary expectations") that are questions in every way but punctuation.
 */
export function parsePastedQuestions(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length >= 3 && l.length <= 400);

  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const k = line.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    // "* Required" markers and bare section headers are not questions
    if (/^\**\s*required\s*\**$/i.test(line)) continue;
    const required = /\*\s*$|\(required\)/i.test(line);
    const label = line.replace(/\s*\*\s*$/, '').replace(/\s*\(required\)\s*$/i, '').trim();
    // long free-text prompts get a textarea; short ones a single line
    const type = label.length > 60 || /\bdescribe\b|\bwhy\b|\btell us\b|\bexplain\b|\bwhat (would|do|are)\b/i.test(label)
      ? 'long_text' : 'text';
    out.push(normalize({ key: `pasted_${out.length + 1}`, label, required, type }));
  }
  return out;
}

/**
 * Deterministic answers — the ones that need no model at all. Returns
 * { key: value } for identity and link fields, taken straight from the master
 * resume's contact block. Anything the resume does not carry is simply absent,
 * never guessed.
 */
export function prefillFromResume(questions, resumeContent) {
  const contact = resumeContent?.contact || {};
  const links = Array.isArray(contact.links) ? contact.links : [];
  const name = String(contact.name || '').trim();
  const parts = name.split(/\s+/);

  const findLink = (kind) => {
    const needle = { linkedin: 'linkedin.', github: 'github.', twitter: 'twitter.', website: null }[kind];
    if (needle) return links.find((l) => String(l).toLowerCase().includes(needle)) || null;
    // "website" is whatever is left once the known networks are removed —
    // guessing beyond that would put a GitHub URL in a portfolio box.
    return links.find((l) => !/linkedin\.|github\.|twitter\.|x\.com/i.test(String(l))) || null;
  };

  const source = {
    'contact.name': name || null,
    'contact.first_name': parts.length ? parts[0] : null,
    'contact.last_name': parts.length > 1 ? parts.slice(1).join(' ') : null,
    'contact.email': contact.email || null,
    'contact.phone': contact.phone || null,
    'contact.location': contact.location || null,
    'links.linkedin': findLink('linkedin'),
    'links.github': findLink('github'),
    'links.twitter': findLink('twitter'),
    'links.website': findLink('website'),
  };

  const out = {};
  for (const q of questions || []) {
    if (!q.fill) continue;
    const v = source[q.fill];
    if (v) out[q.key] = String(v);
  }
  return out;
}

// The subset a model should be asked to write. Everything else is either
// deterministic, an upload, or nobody's business but the candidate's.
export const openQuestions = (questions) => (questions || []).filter((q) => q.kind === 'open');

// What the UI counts as "done": every required box that a human still has to
// deal with. Uploads count — the file is not attached by us and pretending
// otherwise would put a green tick on an unfinished application.
export function completion(questions, answers) {
  const a = answers || {};
  const rows = (questions || []).filter((q) => q.kind !== 'hidden');
  const required = rows.filter((q) => q.required);
  const filled = required.filter((q) => q.kind !== 'sensitive' && q.kind !== 'upload' && String(a[q.key] || '').trim());
  const manual = required.filter((q) => q.kind === 'sensitive' || q.kind === 'upload');
  return {
    total: rows.length,
    required: required.length,
    filled: filled.length,
    manual: manual.length,
    pct: required.length ? Math.round((filled.length / Math.max(1, required.length - manual.length)) * 100) : null,
  };
}
