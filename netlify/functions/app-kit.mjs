// app-kit — the whole application, in one pass.
//
// WHAT CHANGED: the Tailor tab could draft a resume section, or a cover letter,
// or outreach — one kind per click, each its own round trip, each re-reading
// the same resume and the same posting from scratch. Then you still had six
// form boxes to fill by hand. An application took twenty minutes of writing
// after the drafting was "done".
//
// This generates the resume, the cover letter, and an answer to every open
// screening question in ONE model call. One call rather than eight is not just
// cheaper — it is the only way the pieces agree with each other. Generated
// separately, the cover letter claims a strength the resume de-emphasised and
// the "why us" answer tells a different story than both. Here the model sees
// the whole application at once and writes it as one submission.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
//   • It never invents experience, employers, dates, tools or metrics. The
//     master resume is the ground truth and the system prompt says so three
//     times because this is the failure that matters: a fabricated bullet is a
//     lie told in the user's name, to an employer, in writing.
//   • It never answers demographic self-identification. Those fields are
//     filtered out before the prompt is built (lib/appform.mjs) — the model is
//     not asked to decline them, it never sees them.
//   • It never submits anything. The output is a draft on a page.
//
// Structured output via forced tool use rather than "reply in JSON": the answer
// map has to key back to the ATS's own field names exactly, and a model
// free-writing JSON gets a key wrong often enough to matter.
import Anthropic from '@anthropic-ai/sdk';
import { requireUser, json, errorResponse } from './lib/auth.mjs';
import { openQuestions } from './lib/appform.mjs';

const MAX_QUESTIONS = 24;      // a form longer than this is a survey, not an application
const MAX_POSTING_CHARS = 24000;

const SYSTEM = `You prepare complete job applications for one candidate. You receive their MASTER RESUME (the ground truth), a TARGET POSTING, and the exact SCREENING QUESTIONS from that employer's application form.

You produce three things in a single tool call:

1. resume_markdown — the candidate's resume, tailored to this posting. Select and reorder their real experience, and rewrite bullets to mirror the posting's own language WHERE THAT IS HONEST. Output a complete, ready-to-send resume in clean markdown: name and contact line, a two-to-three sentence summary aimed at this role, a skills line, then each relevant role as "**Company** — Title *(dates)*" with 3-5 bullets. Lead every bullet with a verb and keep any real metric that exists in the master resume. Drop roles that add nothing here rather than padding.

2. cover_letter — 250-320 words, plain confident voice, no subject line and no address block. A specific opening tied to this company or role (not flattery), two short paragraphs mapping real experience to the posting's stated needs, a direct close. Never "I am writing to express my interest". Never "I hope this finds you well".

3. answers — one entry per screening question, keyed by the EXACT "key" value given for that question. Write the answer the candidate would write: first person, specific, grounded in the resume, no throat-clearing. Match the format the question asks for — a number for a number, a date for a date, one of the given options for a multiple-choice question (copy an option label verbatim), a short paragraph for an open prompt. Aim at 60-120 words for open prompts unless the question asks for more; a screening answer that runs long gets skimmed. If a question asks about salary expectations, give a range consistent with the posting and the candidate's level, phrased as flexible. If you genuinely cannot answer from the resume, write a short honest answer that says what they DO have — never invent, and never leave it blank.

HARD RULES, in order of importance:
- Never state an employer, title, date, degree, certification, tool, metric or achievement that is not in the master resume. Rewording is expected. Fabrication is not, under any circumstance, for any field, however small.
- Never claim years of experience the resume does not support.
- Write as the candidate, in their voice. Never imply anything has already been sent or submitted.
- If the posting requires something the candidate lacks, the honest move is adjacent evidence or a plain acknowledgement — never a false claim.`;

const KIT_TOOL = {
  name: 'application_kit',
  description: 'Return the tailored resume, cover letter, and one answer per screening question.',
  input_schema: {
    type: 'object',
    properties: {
      resume_markdown: { type: 'string', description: 'The complete tailored resume in markdown.' },
      cover_letter: { type: 'string', description: 'The cover letter body, plain prose, 250-320 words.' },
      answers: {
        type: 'array',
        description: 'One entry per screening question given, using the exact key supplied.',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The exact key of the question being answered.' },
            answer: { type: 'string', description: "The candidate's answer." },
          },
          required: ['key', 'answer'],
        },
      },
      lead_with: {
        type: 'array',
        description: '4-6 strengths this application leads with, drawn from the resume.',
        items: { type: 'string' },
      },
      honest_gaps: {
        type: 'array',
        description: 'Requirements in the posting the resume does not evidence. Empty if none. Plain statements, no spin.',
        items: { type: 'string' },
      },
    },
    required: ['resume_markdown', 'cover_letter', 'answers'],
  },
};

const describeQuestion = (q) => {
  const bits = [`key: ${q.key}`, `question: ${q.label}`];
  if (q.description) bits.push(`help text: ${q.description}`);
  bits.push(`type: ${q.type}`, q.required ? 'required: yes' : 'required: no');
  if (q.options?.length) bits.push(`choose exactly one of: ${q.options.map((o) => o.label).join(' | ')}`);
  return `- ${bits.join('; ')}`;
};

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
    const { supa } = await requireUser(event);

    if (!process.env.ANTHROPIC_API_KEY) {
      return json(503, { error: 'RUNWAY_ENV_MISSING: ANTHROPIC_API_KEY — set it in Netlify env vars and redeploy' });
    }

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* handled below */ }
    const jobId = String(body.job_id || '');
    if (!jobId) return json(400, { error: 'job_id is required' });

    const questions = Array.isArray(body.questions) ? body.questions : [];
    const open = openQuestions(questions).slice(0, MAX_QUESTIONS);

    const [{ data: job, error: jobErr }, { data: resume, error: resErr }] = await Promise.all([
      supa.from('jobs').select('*').eq('id', jobId).maybeSingle(),
      supa.from('resume_master').select('content').maybeSingle(),
    ]);
    if (jobErr) return json(500, { error: `Couldn't load the job: ${jobErr.message}` });
    if (resErr) return json(500, { error: `Couldn't load the resume: ${resErr.message}` });
    if (!job) return json(404, { error: 'Job not found' });
    if (!resume?.content || Object.keys(resume.content).length === 0) {
      return json(422, { error: 'No master resume yet — add it on the Profile page first. Everything here is grounded in it.' });
    }

    const posting = [
      `Company: ${job.company}`,
      `Title: ${job.title}`,
      job.location && `Location: ${job.location}`,
      job.remote_type && job.remote_type !== 'unknown' && `Work mode: ${job.remote_type}`,
      job.seniority && job.seniority !== 'unknown' && `Level: ${job.seniority}`,
      job.industry && `Industry: ${job.industry}`,
      (job.comp_min != null || job.comp_max != null) && `Stated comp: ${job.comp_min ?? '?'} – ${job.comp_max ?? '?'}`,
      Array.isArray(job.requirements) && job.requirements.length ? `Core requirements: ${job.requirements.join('; ')}` : null,
      '',
      job.raw_description ? `Full posting:\n${String(job.raw_description).slice(0, MAX_POSTING_CHARS)}` : '(no full posting text captured — work from the fields above)',
    ].filter(Boolean).join('\n');

    const questionBlock = open.length
      ? `SCREENING QUESTIONS ON THIS EMPLOYER'S FORM — answer every one, keyed exactly:\n${open.map(describeQuestion).join('\n')}`
      : 'SCREENING QUESTIONS: none supplied. Return an empty answers array.';

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
      // Enough for a full resume, a letter, and up to two dozen answers. The
      // resume alone can run 900 tokens; under-budgeting truncates the answers
      // array, which fails validation and wastes the whole call.
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      tools: [KIT_TOOL],
      tool_choice: { type: 'tool', name: 'application_kit' },
      messages: [{
        role: 'user',
        content: `MASTER RESUME (ground truth — never claim anything outside this):\n${JSON.stringify(resume.content, null, 2)}\n\n---\n\nTARGET POSTING:\n${posting}\n\n---\n\n${questionBlock}`,
      }],
    });

    const use = msg.content.find((b) => b.type === 'tool_use' && b.name === 'application_kit');
    if (!use?.input) return json(502, { error: 'The draft came back malformed — try again.' });

    const out = use.input;
    // Keep only answers that key back to a question we actually asked about.
    // A model-invented key would land in the answers map, be saved, and then
    // never render against any box — a silent hole in the application.
    const validKeys = new Set(open.map((q) => q.key));
    const answers = {};
    for (const a of Array.isArray(out.answers) ? out.answers : []) {
      if (a && typeof a.key === 'string' && validKeys.has(a.key) && typeof a.answer === 'string') {
        answers[a.key] = a.answer.trim();
      }
    }
    const missing = open.filter((q) => !(q.key in answers)).map((q) => q.label);

    return json(200, {
      resume_md: String(out.resume_markdown || '').trim(),
      cover_md: String(out.cover_letter || '').trim(),
      answers,
      lead_with: (Array.isArray(out.lead_with) ? out.lead_with : []).map(String).slice(0, 8),
      honest_gaps: (Array.isArray(out.honest_gaps) ? out.honest_gaps : []).map(String).slice(0, 8),
      // Surfaced rather than swallowed: a question the model skipped is a box
      // you will hit in the tab, and you should hear it from us first.
      unanswered: missing,
      answered: Object.keys(answers).length,
      asked: open.length,
    });
  } catch (ex) {
    return errorResponse(ex);
  }
};
