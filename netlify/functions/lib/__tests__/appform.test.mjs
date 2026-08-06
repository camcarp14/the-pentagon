// Planted problems for the application-form parser.
//
// The payload below is the real shape Greenhouse's public job-board API returns
// for `?questions=true` — the standard identity block, an upload, two custom
// questions, a dropdown, and the separate EEOC compliance section. Testing
// against the captured shape rather than a live fetch is this repo's house
// pattern (see providers.mjs) and the only way these run offline.
//
// The assertion that matters most is the one about demographic questions. A
// regression there is not a bug, it is a tool writing a legally-protected
// self-identification on a person's behalf.
import { describe, it, expect } from 'vitest';
import {
  parseGreenhouseQuestions, parsePastedQuestions, prefillFromResume,
  openQuestions, completion,
} from '../appform.mjs';

const GREENHOUSE = {
  id: 4012345,
  title: 'Senior Paid Search Manager',
  questions: [
    { label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text', values: [] }] },
    { label: 'Last Name', required: true, fields: [{ name: 'last_name', type: 'input_text', values: [] }] },
    { label: 'Email', required: true, fields: [{ name: 'email', type: 'input_text', values: [] }] },
    { label: 'Phone', required: false, fields: [{ name: 'phone', type: 'input_text', values: [] }] },
    { label: 'Resume/CV', required: true, fields: [{ name: 'resume', type: 'input_file', values: [] }] },
    { label: 'LinkedIn Profile', required: false, fields: [{ name: 'question_9001', type: 'input_text', values: [] }] },
    {
      label: 'Why do you want to work at Acme?', required: true, description: 'A few sentences is plenty.',
      fields: [{ name: 'question_9002', type: 'textarea', values: [] }],
    },
    {
      label: 'How many years have you managed paid search budgets?', required: true,
      fields: [{
        name: 'question_9003', type: 'multi_value_single_select',
        values: [{ label: '0-2', value: 1 }, { label: '3-5', value: 2 }, { label: '6+', value: 3 }],
      }],
    },
    { label: 'Internal tracking', required: false, fields: [{ name: 'source_id', type: 'input_hidden', values: [] }] },
  ],
  compliance: [{
    type: 'gender',
    questions: [{ label: 'Gender', required: false, fields: [{ name: 'gender', type: 'multi_value_single_select', values: [] }] }],
  }, {
    type: 'veteran_status',
    questions: [{ label: 'Veteran Status', required: false, fields: [{ name: 'veteran_status', type: 'multi_value_single_select', values: [] }] }],
  }],
};

const RESUME = {
  contact: {
    name: 'Cam Carpenter', email: 'cam@example.com', phone: '312-555-0134',
    location: 'Chicago, IL',
    links: ['linkedin.com/in/camcarp', 'github.com/camcarp', 'camcarp.dev'],
  },
};

const byKey = (qs, k) => qs.find((q) => q.key === k);

describe('parsing a Greenhouse form', () => {
  const qs = parseGreenhouseQuestions(GREENHOUSE);

  it('returns one row per FIELD, keyed by the name the form submits under', () => {
    expect(qs.length).toBe(11); // 9 questions + 2 compliance
    expect(byKey(qs, 'question_9002')).toBeTruthy();
  });

  it('classifies the identity block so it is filled from the resume, not a model', () => {
    for (const k of ['first_name', 'last_name', 'email', 'phone']) {
      expect(byKey(qs, k).kind, `${k} must be identity`).toBe('identity');
    }
  });

  it('NEVER classifies a demographic question as answerable', () => {
    for (const k of ['gender', 'veteran_status']) {
      const q = byKey(qs, k);
      expect(q, `${k} must still be listed`).toBeTruthy();
      expect(q.kind, `${k} must be sensitive`).toBe('sensitive');
    }
    // and none of them reach the model
    const open = openQuestions(qs).map((q) => q.key);
    expect(open).not.toContain('gender');
    expect(open).not.toContain('veteran_status');
  });

  it('surfaces the compliance block rather than omitting it', () => {
    // A checklist that hides the EEOC boxes sends you into the tab believing
    // you are finished.
    expect(qs.some((q) => q.kind === 'sensitive')).toBe(true);
  });

  it('marks the upload as yours to handle', () => {
    expect(byKey(qs, 'resume').kind).toBe('upload');
    expect(openQuestions(qs).map((q) => q.key)).not.toContain('resume');
  });

  it('recognises a link question by its label', () => {
    expect(byKey(qs, 'question_9001').kind).toBe('link');
    expect(byKey(qs, 'question_9001').fill).toBe('links.linkedin');
  });

  it('keeps a dropdown\'s exact option labels, which the model must copy verbatim', () => {
    const q = byKey(qs, 'question_9003');
    expect(q.type).toBe('select');
    expect(q.options.map((o) => o.label)).toEqual(['0-2', '3-5', '6+']);
  });

  it('carries required flags and help text through', () => {
    expect(byKey(qs, 'question_9002').required).toBe(true);
    expect(byKey(qs, 'question_9002').description).toBe('A few sentences is plenty.');
    expect(byKey(qs, 'phone').required).toBe(false);
  });

  it('marks hidden fields hidden and keeps them out of the model\'s work', () => {
    expect(byKey(qs, 'source_id').kind).toBe('hidden');
    expect(openQuestions(qs).map((q) => q.key)).not.toContain('source_id');
  });

  it('leaves exactly the two real free-text questions for the model', () => {
    expect(openQuestions(qs).map((q) => q.key).sort()).toEqual(['question_9002', 'question_9003']);
  });

  it('degrades on a malformed payload instead of throwing', () => {
    for (const junk of [null, {}, { questions: null }, { questions: [{}] }, { questions: [{ fields: 'nope' }] }]) {
      expect(() => parseGreenhouseQuestions(junk)).not.toThrow();
    }
    expect(parseGreenhouseQuestions({ questions: [{ label: 'x', fields: [{ name: '', type: 'input_text' }] }] })).toEqual([]);
  });
});

describe('parsing a pasted form', () => {
  it('handles bullets, numbers and bare lines alike', () => {
    const qs = parsePastedQuestions(`
      1. Why do you want to work here?
      - Describe your experience with SQL
      * What are your salary expectations? *
      Notice period
    `);
    expect(qs.map((q) => q.label)).toEqual([
      'Why do you want to work here?',
      'Describe your experience with SQL',
      'What are your salary expectations?',
      'Notice period',
    ]);
  });

  it('picks a textarea for a prompt and a single line for a short label', () => {
    const qs = parsePastedQuestions('Why do you want this role?\nNotice period');
    expect(qs[0].type).toBe('long_text');
    expect(qs[1].type).toBe('text');
  });

  it('reads a trailing asterisk as required', () => {
    expect(parsePastedQuestions('Salary expectations *')[0].required).toBe(true);
    expect(parsePastedQuestions('Salary expectations')[0].required).toBe(false);
  });

  it('de-duplicates and drops the "* Required" legend forms use', () => {
    const qs = parsePastedQuestions('Why us?\nWhy us?\n* Required\n**Required**');
    expect(qs.length).toBe(1);
  });

  it('still refuses to answer a demographic question someone pasted in', () => {
    const qs = parsePastedQuestions('Why us?\nWhat is your gender?\nAre you a protected veteran?');
    expect(qs.filter((q) => q.kind === 'sensitive').length).toBe(2);
    expect(openQuestions(qs).map((q) => q.label)).toEqual(['Why us?']);
  });

  it('returns nothing for junk rather than inventing questions', () => {
    expect(parsePastedQuestions('')).toEqual([]);
    expect(parsePastedQuestions(null)).toEqual([]);
    expect(parsePastedQuestions('ok')).toEqual([]); // under the 3-char floor
  });
});

describe('deterministic prefill', () => {
  const qs = parseGreenhouseQuestions(GREENHOUSE);
  const filled = prefillFromResume(qs, RESUME);

  it('splits a full name into the two boxes the form actually has', () => {
    expect(filled.first_name).toBe('Cam');
    expect(filled.last_name).toBe('Carpenter');
  });

  it('fills contact details verbatim from the resume', () => {
    expect(filled.email).toBe('cam@example.com');
    expect(filled.phone).toBe('312-555-0134');
  });

  it('picks the right link for the right box', () => {
    expect(filled.question_9001).toBe('linkedin.com/in/camcarp');
  });

  it('leaves a field blank rather than guessing when the resume lacks it', () => {
    const sparse = prefillFromResume(qs, { contact: { name: 'Solo' } });
    expect(sparse.first_name).toBe('Solo');
    expect(sparse.last_name).toBeUndefined();
    expect('email' in sparse).toBe(false);
  });

  it('never prefills a demographic or an upload', () => {
    expect('gender' in filled).toBe(false);
    expect('veteran_status' in filled).toBe(false);
    expect('resume' in filled).toBe(false);
  });

  it('survives no resume at all', () => {
    expect(() => prefillFromResume(qs, null)).not.toThrow();
    expect(prefillFromResume(qs, null)).toEqual({});
  });
});

describe('completion', () => {
  const qs = parseGreenhouseQuestions(GREENHOUSE);

  it('counts uploads as something YOU still have to do', () => {
    const c = completion(qs, {});
    expect(c.manual).toBeGreaterThan(0);
  });

  it('excludes hidden fields from the visible total', () => {
    expect(completion(qs, {}).total).toBe(qs.length - 1);
  });

  it('rises as required boxes get answers', () => {
    const empty = completion(qs, {});
    const some = completion(qs, { first_name: 'Cam', last_name: 'Carpenter', email: 'c@x.com', question_9002: 'Because…' });
    expect(some.filled).toBeGreaterThan(empty.filled);
  });

  it('does not count whitespace as an answer', () => {
    expect(completion(qs, { question_9002: '   ' }).filled).toBe(0);
  });
});
