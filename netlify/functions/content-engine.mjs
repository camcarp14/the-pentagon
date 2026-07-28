// ═══════════════════════════════════════════════════════════════════════════
// CONTENT ENGINE — writes one article per pass, for a human to approve.
//
// ZTS has published 13 articles in a year, in two bursts, and gets ~69 search
// sessions a quarter. That is not an SEO programme; it is an archive. This runs
// every four hours, and how many of those passes actually produce work is set
// by Direction, not by this file.
//
// ONE ARTICLE PER PASS, ON PURPOSE. Scheduled functions get 30 seconds. A
// generation call can take 20 of them, so batching two into one pass risks
// losing both plus the run-closing write the circuit breaker counts. Volume
// comes from frequency, which the platform handles reliably, not from a loop
// racing a timeout.
//
// TIER 0, NOT TIER 2. Writing a draft into our own table changes nothing a
// customer can see, so drafting is fully autonomous. PUBLISHING is the tier-2
// act, and it lives behind human approval in queue-execute.mjs. Splitting them
// is what lets the expensive, slow half run unattended while the consequential
// half stays a deliberate human decision.
//
// THE COST PASSED TO THE GUARD IS AN OVER-ESTIMATE. The spend cap has to be
// checked BEFORE the call that spends the money, so the guard is handed a
// worst-case figure computed from max_tokens. The real cost is recorded on the
// draft afterwards. Over-estimating pauses an engine early, which is visible
// and recoverable; under-estimating spends past a ceiling that was meant to
// stop it.
//
// Inert until SUPABASE_SERVICE_ROLE_KEY and ANTHROPIC_API_KEY are set, its
// control row is enabled, and Direction is filled in. Any of those missing is
// reported, not guessed around.
// ═══════════════════════════════════════════════════════════════════════════
import {
  adminClient, loadGuardState, attempt, recordFailure,
  startRun, finishRun, registerSubsystem, MODE, TIER,
} from './lib/ops-runtime.mjs';
import { completeJSON, DEFAULT_MODEL } from './lib/anthropic.mjs';
import { estimateCost } from '@cc/ai';
import { resolveDirection, ENGINE, DIRECTION_KEY } from '@cc/ops/direction.js';
import { preparationBudget } from '@cc/ops/queue.js';

const SUBSYSTEM = 'zts.content';
const TRIGGER = 'netlify schedule 0 */4';
const MAX_TOKENS = 4000;

/** Worst-case spend for one pass, for the pre-flight cap check. Assumes the
 *  model emits its full token allowance and the prompt is generous. */
const COST_CEILING = estimateCost(DEFAULT_MODEL, 3000, MAX_TOKENS);

const SYSTEM_PROMPT = `You write for a small, credible brand. You are not a content mill.

Rules that matter more than anything else:
- Never invent statistics, prices, dates, studies, or quotes. If a claim needs a number you do not have, write the sentence without the number.
- Never promise outcomes, guarantee security, or give individualised financial advice.
- Write like a knowledgeable person explaining something to someone smart who simply has not encountered it yet. No hype, no "in today's fast-paced world", no padding to hit a length.
- Short paragraphs. Concrete examples. Plain words over jargon, and when a technical term is unavoidable, define it once in line.
- The reader's problem is the subject. The product is mentioned only where it is genuinely the answer, and at most once.

Output valid HTML for the body: <p>, <h2>, <h3>, <ul>, <li>, <strong>, <a>. No <html>, <head>, <body>, <script>, or <style> tags. No markdown.`;

function buildPrompt(direction, recentTitles) {
  const avoid = direction.avoid.length ? `\nStay away from: ${direction.avoid.join('; ')}.` : '';
  const voice = direction.voice ? `\nVoice notes from the owner: ${direction.voice}` : '';
  const priorList = recentTitles.length
    ? `\n\nAlready published or drafted — pick a genuinely different angle, do NOT rewrite any of these:\n${recentTitles.map((t) => `- ${t}`).join('\n')}`
    : '';

  return `Audience: ${direction.audience}
What the brand sells: ${direction.product}
Topics in scope: ${direction.topics.join('; ')}${avoid}${voice}${priorList}

Choose ONE specific article to write now. Prefer a narrow, concrete question a real person would type into a search box over a broad overview — "overview" articles rank for nothing and help no one.

Return JSON with exactly these keys:
{
  "title": "under 65 characters, no clickbait, reads like a real answer",
  "summary": "one or two sentences, plain text, used as the article excerpt",
  "body_html": "the full article, 700-1200 words, valid HTML per the rules",
  "tags": "3-5 comma-separated tags",
  "handle": "url-slug-in-kebab-case",
  "topic": "which of the in-scope topics this belongs to",
  "rationale": "one sentence: what search intent this serves and why it is worth publishing"
}`;
}

/** Trim and bound a model-supplied string so a runaway generation cannot write
 *  a megabyte into a text column or an empty string past a NOT NULL check. */
const clean = (v, max) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > max ? s.slice(0, max) : s;
};

const slugify = (v) =>
  clean(v, 120).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const handler = async () => {
  const now = Date.now();
  let sb, runId = null;

  try {
    sb = adminClient();
  } catch (ex) {
    console.error('[zts.content] cannot start:', ex.message);
    return { statusCode: 500, body: JSON.stringify({ error: ex.message }) };
  }

  try {
    await registerSubsystem(sb, SUBSYSTEM);
    runId = await startRun(sb, SUBSYSTEM, 'schedule', now);

    // ── Direction ───────────────────────────────────────────────────────────
    // An unconfigured engine is the normal day-one state, not a failure. It
    // closes its run ok:true and says exactly which fields are missing, so the
    // circuit breaker is not tripped by the operator simply not having filled
    // the form in yet.
    const { data: settingRow, error: sErr } = await sb
      .from('app_settings').select('value').eq('key', DIRECTION_KEY[ENGINE.CONTENT]).maybeSingle();
    if (sErr) throw new Error(`CONTENT_DIRECTION_READ_FAILED: ${sErr.message}`);

    const { direction, ready, missing } = resolveDirection(ENGINE.CONTENT, settingRow?.value);
    if (!ready) {
      await finishRun(sb, runId, { ok: true, note: `no direction yet: ${missing.join(', ')}` }, Date.now());
      console.log('[zts.content] waiting on direction:', missing.join(', '));
      return { statusCode: 200, body: JSON.stringify({ skipped: 'direction_incomplete', missing }) };
    }

    // ── Budget ──────────────────────────────────────────────────────────────
    // Two ceilings: how many to write per day, and how deep the unreviewed
    // backlog may get. The second matters more — a queue of thirty unread
    // drafts is not productivity, it is a queue nobody will ever open.
    //
    // A FAILED COUNT IS NOT A COUNT OF ZERO. PostgREST returns `count: null`
    // alongside an error, and `count || 0` turned that into "nothing prepared
    // today, nothing awaiting review" — which is the most permissive possible
    // reading of the two numbers that exist to say STOP. One unreadable count
    // and the per-day cap and the backlog ceiling both vanish for that pass.
    // The pass is skipped instead, ok:true so a transient blip does not walk
    // the circuit breaker toward tripping on a healthy engine, and the next
    // pass retries in four hours.
    const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
    const [todayRes, pendingRes] = await Promise.all([
      sb.from('content_drafts').select('id', { count: 'exact', head: true }).gte('created_at', dayStart.toISOString()),
      sb.from('content_drafts').select('id', { count: 'exact', head: true }).eq('status', 'draft_ready'),
    ]);
    const countErr = todayRes.error || pendingRes.error;
    if (countErr || !Number.isFinite(todayRes.count) || !Number.isFinite(pendingRes.count)) {
      const why = countErr?.message || 'count came back null';
      await finishRun(sb, runId, { ok: true, note: `budget unreadable, refusing to draft: ${why}` }, Date.now());
      console.warn(`[zts.content] budget unreadable, skipping pass: ${why}`);
      return { statusCode: 200, body: JSON.stringify({ skipped: 'budget_unreadable', error: why }) };
    }
    const preparedToday = todayRes.count;
    const pendingTotal = pendingRes.count;

    const budget = preparationBudget({
      perDay: direction.perDay,
      preparedToday,
      pendingTotal,
    });
    if (budget < 1) {
      await finishRun(sb, runId, {
        ok: true,
        note: `at capacity: ${preparedToday} today (cap ${direction.perDay}), ${pendingTotal} awaiting review`,
      }, Date.now());
      console.log('[zts.content] at capacity, nothing to do');
      return { statusCode: 200, body: JSON.stringify({ skipped: 'at_capacity' }) };
    }

    // ── Permission ──────────────────────────────────────────────────────────
    const state = await loadGuardState(sb, SUBSYSTEM, now);
    const verdict = await attempt(sb, {
      subsystem: SUBSYSTEM,
      action: 'content.draft',
      tier: TIER.READ,
      state, now, runId,
      trigger: TRIGGER,
      rationale: `draft 1 article for ${direction.audience}; ${pendingTotal || 0} already awaiting review`,
      costUsd: COST_CEILING,
    });

    if (!verdict.allow) {
      await finishRun(sb, runId, { ok: true, actions: 0, blocked: 1, note: `blocked: ${verdict.reason}` }, Date.now());
      console.log(`[zts.content] blocked — ${verdict.reason}`);
      return { statusCode: 200, body: JSON.stringify({ mode: verdict.mode, reason: verdict.reason }) };
    }

    // ── Write ───────────────────────────────────────────────────────────────
    // Recent titles go into the prompt so the model does not re-tread ground.
    // The unique index on title is the backstop for when it does anyway.
    const { data: recent } = await sb
      .from('content_drafts').select('title').order('created_at', { ascending: false }).limit(30);
    const recentTitles = (recent || []).map((r) => r.title).filter(Boolean);

    let generated;
    try {
      generated = await completeJSON({
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(direction, recentTitles),
        maxTokens: MAX_TOKENS,
      });
    } catch (ex) {
      await recordFailure(sb, {
        subsystem: SUBSYSTEM, action: 'content.draft', tier: TIER.READ,
        error: ex, runId, trigger: TRIGGER, now: Date.now(),
      });
      throw ex;
    }

    const a = generated.data;
    const title = clean(a.title, 200);
    const bodyHtml = clean(a.body_html, 120_000);
    if (!title || !bodyHtml) {
      const ex = new Error(`CONTENT_DRAFT_INCOMPLETE: title=${!!title} body=${!!bodyHtml}`);
      await recordFailure(sb, {
        subsystem: SUBSYSTEM, action: 'content.draft', tier: TIER.READ,
        error: ex, runId, trigger: TRIGGER, now: Date.now(),
      });
      throw ex;
    }

    // A dry run does everything except keep the result. That is a real
    // rehearsal — it proves the key works, the prompt returns usable JSON, and
    // the shape fits — rather than a no-op that proves nothing.
    if (verdict.mode === MODE.DRY_RUN) {
      await finishRun(sb, runId, {
        ok: true, actions: 1, costUsd: generated.costUsd,
        note: `dry run — would have drafted "${title}"`,
      }, Date.now());
      console.log(`[zts.content] dry run — "${title}"`);
      return { statusCode: 200, body: JSON.stringify({ mode: verdict.mode, title, persisted: false }) };
    }

    const { data: inserted, error: insErr } = await sb.from('content_drafts').insert({
      title,
      summary: clean(a.summary, 1000) || null,
      body_html: bodyHtml,
      tags: clean(a.tags, 300) || null,
      handle: slugify(a.handle || title) || null,
      blog_handle: direction.blogHandle || null,
      rationale: clean(a.rationale, 1000) || null,
      topic: clean(a.topic, 200) || null,
      model: generated.model,
      cost_usd: generated.costUsd,
    }).select('id').single();

    if (insErr) {
      // 23505 is the unique-title index doing its job: the model repeated
      // itself. That is a normal, non-fatal outcome — the next pass will pick a
      // different angle — so the run closes ok rather than advancing the
      // circuit breaker toward tripping on a healthy engine.
      if (insErr.code === '23505') {
        await finishRun(sb, runId, { ok: true, actions: 0, note: `duplicate title skipped: "${title}"` }, Date.now());
        console.warn(`[zts.content] duplicate title, skipped: "${title}"`);
        return { statusCode: 200, body: JSON.stringify({ skipped: 'duplicate_title', title }) };
      }
      await recordFailure(sb, {
        subsystem: SUBSYSTEM, action: 'content.draft', tier: TIER.READ,
        error: insErr, runId, trigger: TRIGGER, now: Date.now(),
      });
      throw new Error(`CONTENT_DRAFT_WRITE_FAILED: ${insErr.message}`);
    }

    // costUsd is deliberately NOT repeated on the run here. The same figure is
    // already stored on the draft row above, and any surface summing both —
    // which a spend tile naturally would — reported exactly 2x. The run's cost
    // column stays 0 for passes whose cost is attributable to a persisted
    // artifact; the artifact is the single source.
    await finishRun(sb, runId, {
      ok: true, actions: 1,
      note: `drafted "${title}" ($${generated.costUsd.toFixed(4)})`,
    }, Date.now());

    console.log(`[zts.content] drafted "${title}" — awaiting approval`);
    return { statusCode: 200, body: JSON.stringify({ mode: verdict.mode, id: inserted.id, title }) };
  } catch (ex) {
    console.error('[zts.content] failed:', ex.message);
    if (runId) {
      try { await finishRun(sb, runId, { ok: false, errors: 1, note: ex.message }, Date.now()); }
      catch (e2) { console.error('[zts.content] could not close run:', e2.message); }
    }
    return { statusCode: 500, body: JSON.stringify({ error: ex.message }) };
  }
};
