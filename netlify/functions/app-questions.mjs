// app-questions — fetch the REAL application form for a job.
//
// Greenhouse's public job-board API takes `?questions=true` and returns the
// actual form: every field, its submitted name, its type, whether it is
// required, and the exact option labels on each dropdown. That is published for
// public consumption (it is what powers embedded job boards), it is the same
// endpoint the scanner already reads, and it turns "here are some questions
// they'll probably ask" into "here are the boxes on the form".
//
// Everything else answers { supported: false } with a reason and a one-line
// instruction, because the honest fallback — paste the questions — takes ten
// seconds and works on every ATS in existence. Lever and Ashby publish the
// posting but not the application form; Workday's form is behind a session. No
// scraping is attempted for any of them.
import { requireUser, json, errorResponse } from './lib/auth.mjs';
import { classifyJobUrl } from '../../apps/runway/src/lib/jobsource.js';
import { parseGreenhouseQuestions, parsePastedQuestions, prefillFromResume } from './lib/appform.mjs';

const TIMEOUT_MS = 12000;

const REASON = {
  lever: 'Lever publishes the posting but not the application form. Open the job, copy the questions, and paste them below — it takes ten seconds and works the same from there.',
  ashby: 'Ashby publishes the posting but not the application form. Open the job, copy the questions, and paste them below.',
  generic: 'This ATS does not publish its application form. Open the job, copy the questions, and paste them below.',
  none: 'No posting URL saved for this job — add one on the Overview tab, or paste the questions below.',
};

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
    const { supa } = await requireUser(event);

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* handled below */ }
    const jobId = String(body.job_id || '');
    if (!jobId) return json(400, { error: 'job_id is required' });
    const pasted = typeof body.pasted === 'string' ? body.pasted : null;

    const [{ data: job, error: jobErr }, { data: resume }] = await Promise.all([
      supa.from('jobs').select('id, url, company, title').eq('id', jobId).maybeSingle(),
      supa.from('resume_master').select('content').maybeSingle(),
    ]);
    if (jobErr) return json(500, { error: `Couldn't load the job: ${jobErr.message}` });
    if (!job) return json(404, { error: 'Job not found' });

    // The paste path never touches the network. It is also the path that
    // ALWAYS works, so it is checked first — a user who has already pasted the
    // form should not have a failed Greenhouse probe overwrite it.
    if (pasted && pasted.trim()) {
      const questions = parsePastedQuestions(pasted);
      if (!questions.length) return json(422, { error: 'Nothing in that paste looked like a form question — one question per line.' });
      return json(200, {
        supported: true, source: 'pasted', questions,
        prefill: prefillFromResume(questions, resume?.content),
      });
    }

    if (!job.url) return json(200, { supported: false, source: 'none', reason: REASON.none, questions: [] });

    const cls = classifyJobUrl(job.url);
    if (cls.kind !== 'greenhouse' || !cls.board || !cls.jobId) {
      const reason = REASON[cls.kind] || REASON.generic;
      return json(200, { supported: false, source: cls.kind, reason, questions: [] });
    }

    let payload;
    try {
      const res = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(cls.board)}/jobs/${encodeURIComponent(cls.jobId)}?questions=true`,
        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (!res.ok) {
        // 404 here usually means the posting came down, which is worth saying
        // precisely — it is the same fact the liveness sweep reports.
        return json(200, {
          supported: false, source: 'greenhouse', questions: [],
          reason: res.status === 404
            ? 'Greenhouse returned 404 for this posting — it may have been taken down. Verify the link, or paste the questions below.'
            : `Greenhouse answered HTTP ${res.status}. Try again, or paste the questions below.`,
        });
      }
      payload = await res.json();
    } catch (ex) {
      return json(200, {
        supported: false, source: 'greenhouse', questions: [],
        reason: `Couldn't reach Greenhouse (${String(ex.message || ex)}). Paste the questions below instead.`,
      });
    }

    const questions = parseGreenhouseQuestions(payload);
    if (!questions.length) {
      return json(200, {
        supported: false, source: 'greenhouse', questions: [],
        reason: 'Greenhouse returned no form fields for this posting — paste the questions below.',
      });
    }

    return json(200, {
      supported: true,
      source: 'greenhouse',
      questions,
      prefill: prefillFromResume(questions, resume?.content),
      posting_title: payload?.title || job.title,
    });
  } catch (ex) {
    return errorResponse(ex);
  }
};
