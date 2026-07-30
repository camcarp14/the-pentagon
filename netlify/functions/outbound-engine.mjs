// ═══════════════════════════════════════════════════════════════════════════
// OUTBOUND ENGINE — drafts one personalised message per pass, for approval.
//
// Clarify's outbound pipeline has existed since it was built: prospects →
// contacts → outreach, with draft_subject/draft_body and a
// draft_ready → approved → sent lifecycle, plus sequences, open/click tracking
// and tone memory. Messages ever sent: zero. Nothing was missing except
// something to run it. This is that.
//
// IT DRAFTS, IT NEVER SENDS. Sending is tier 2 — a real message to a real
// person from the operator's own address — and lives behind human approval in
// queue-execute.mjs. This function cannot send. It has no Gmail credentials in
// scope and no code path to them.
//
// IT DOES NOT INVENT PROSPECTS EITHER. Discovery needs Google Places and Hunter
// and is a separate concern with a separate failure mode; this engine works
// from prospects that already exist. With an empty list it says so plainly
// rather than fabricating recipients, which is the one failure mode in outbound
// that is genuinely unrecoverable — you cannot un-email someone.
//
// TONE MEMORY IS READ. Rejections with feedback are what stop the second week
// reading exactly like the first. If the operator has ever explained why a
// draft was wrong, that explanation goes into the prompt.
// ═══════════════════════════════════════════════════════════════════════════
import {
  adminClient, loadGuardState, attempt, recordFailure,
  startRun, finishRun, registerSubsystem, MODE, TIER,
} from './lib/ops-runtime.mjs';
import { completeJSON, DEFAULT_MODEL } from './lib/anthropic.mjs';
import { estimateCost } from '@cc/ai';
import { resolveDirection, ENGINE, DIRECTION_KEY } from '@cc/ops/direction.js';
import { preparationBudget, OUTREACH_DRAFT_STATUSES } from '@cc/ops/queue.js';

const SUBSYSTEM = 'clarify.outbound';
const TRIGGER = 'netlify schedule 30 */2';
const MAX_TOKENS = 1200;

const COST_CEILING = estimateCost(DEFAULT_MODEL, 2500, MAX_TOKENS);

const SYSTEM_PROMPT = `You write short cold emails that a busy owner would actually reply to.

Hard rules:
- Never invent a fact about the recipient. Use ONLY what you are given. If the research is thin, write a shorter email rather than a padded one.
- No flattery openers, no "I hope this finds you well", no "I was browsing your website and was impressed".
- No fake urgency, no fake mutual connections, no pretending you have met.
- One specific, concrete observation about their business, then one sentence on what you do about it, then one low-friction question.
- Under 120 words. Plain text, no HTML, no links, no attachments, no signature block — the sending layer adds that.
- Subject line under 55 characters, lowercase, reads like a person wrote it, not a campaign.`;

function buildPrompt(direction, prospect, toneNotes) {
  const research = [
    prospect.website_context && `Website: ${prospect.website_context}`,
    prospect.prospect_brief && `Brief: ${prospect.prospect_brief}`,
    prospect.brief_callouts && `Specific callouts: ${prospect.brief_callouts}`,
    prospect.marketing_signals && `Marketing signals: ${prospect.marketing_signals}`,
    prospect.ads_detected != null && `Running paid ads: ${prospect.ads_detected ? 'yes' : 'no detected'}`,
    prospect.category && `Category: ${prospect.category}`,
    prospect.city && `City: ${prospect.city}`,
  ].filter(Boolean).join('\n');

  const tone = toneNotes.length
    ? `\n\nThe owner has previously rejected drafts for these reasons — do not repeat them:\n${toneNotes.map((t) => `- ${t}`).join('\n')}`
    : '';
  const voice = direction.voice ? `\nVoice notes from the owner: ${direction.voice}` : '';
  const avoid = direction.avoid.length ? `\nNever mention: ${direction.avoid.join('; ')}.` : '';

  return `Who we help: ${direction.icp}
What we offer: ${direction.offer}${direction.geography ? `\nGeography: ${direction.geography}` : ''}${voice}${avoid}

The business:
Name: ${prospect.business_name}
${research || '(no research available — keep it short and do not pretend otherwise)'}${tone}

Write the email. Return JSON with exactly these keys:
{
  "subject": "under 55 characters, lowercase",
  "body": "the email, plain text, under 120 words, no signature",
  "callout": "the one specific thing about them you used, in a few words",
  "confidence": "high | medium | low — low if the research was too thin to personalise honestly"
}`;
}

const clean = (v, max) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > max ? s.slice(0, max) : s;
};

export const handler = async () => {
  const now = Date.now();
  let sb, runId = null;

  try {
    sb = adminClient();
  } catch (ex) {
    console.error('[clarify.outbound] cannot start:', ex.message);
    return { statusCode: 500, body: JSON.stringify({ error: ex.message }) };
  }

  try {
    await registerSubsystem(sb, SUBSYSTEM);
    runId = await startRun(sb, SUBSYSTEM, 'schedule', now);

    const { data: settingRow, error: sErr } = await sb
      .from('app_settings').select('value').eq('key', DIRECTION_KEY[ENGINE.OUTBOUND]).maybeSingle();
    if (sErr) throw new Error(`OUTBOUND_DIRECTION_READ_FAILED: ${sErr.message}`);

    const { direction, ready, missing } = resolveDirection(ENGINE.OUTBOUND, settingRow?.value);
    if (!ready) {
      await finishRun(sb, runId, { ok: true, note: `no direction yet: ${missing.join(', ')}` }, Date.now());
      console.log('[clarify.outbound] waiting on direction:', missing.join(', '));
      return { statusCode: 200, body: JSON.stringify({ skipped: 'direction_incomplete', missing }) };
    }

    //
    // A FAILED COUNT IS NOT A COUNT OF ZERO — see the matching note in
    // content-engine.mjs. `count || 0` on an errored query read as "nothing
    // drafted today, nothing awaiting review", which is the most permissive
    // reading of the two numbers whose whole job is to say STOP. On this engine
    // that means writing cold emails past the daily cap.
    //
    // COUNTED ON updated_at, NOT created_at. This engine does not insert when it
    // drafts — it fills in a row Clarify created at PROSPECTING time (see the
    // note below), so created_at is the day the prospect was found, not the day
    // the draft was written. Counting it meant every prospect added before today
    // scored zero, preparedToday stayed at 0 forever against an existing
    // pipeline, and perDay never bound: twelve paid generations a day under a
    // cap of one, with the run note reporting "0 today". The draft write is what
    // sets updated_at and draft_subject, so that pair is what "drafted today"
    // actually means.
    //
    // AND NO STATUS FILTER, unlike the pending count below. Narrowing this one
    // to draft/draft_ready counted "drafts still sitting in the queue", not
    // "drafts written today": approving a draft (→ sent) or rejecting it took it
    // out of the count and handed the day's allowance straight back, so under a
    // cap of one, sending the morning's draft paid for another that afternoon.
    // pendingRes keeps the filter because it measures backlog, not spend.
    // replies-cron also bumps updated_at, so a reply recorded today spends one
    // of the day's allowance — over-counting is the safe side of a number whose
    // whole job is to say STOP.
    const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
    const [todayRes, pendingRes] = await Promise.all([
      sb.from('outreach').select('id', { count: 'exact', head: true })
        .not('draft_subject', 'is', null)
        .gte('updated_at', dayStart.toISOString()),
      sb.from('outreach').select('id', { count: 'exact', head: true }).in('status', OUTREACH_DRAFT_STATUSES),
    ]);
    const countErr = todayRes.error || pendingRes.error;
    if (countErr || !Number.isFinite(todayRes.count) || !Number.isFinite(pendingRes.count)) {
      const why = countErr?.message || 'count came back null';
      await finishRun(sb, runId, { ok: true, note: `budget unreadable, refusing to draft: ${why}` }, Date.now());
      console.warn(`[clarify.outbound] budget unreadable, skipping pass: ${why}`);
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
      return { statusCode: 200, body: JSON.stringify({ skipped: 'at_capacity' }) };
    }

    // ── Find someone to write to ────────────────────────────────────────────
    // Clarify creates the outreach row at PROSPECTING time, with status
    // 'prospected' and no draft. Writing a draft fills that row in; it does not
    // create a new one.
    //
    // An earlier version of this engine inserted instead, and skipped anyone
    // who already had an outreach row. Against the real pipeline — where all 41
    // prospects already had one — that meant it would have drafted precisely
    // nothing, forever, while reporting "no eligible prospects" as though the
    // list were empty. Selecting the row to FILL is the whole job.
    const { data: waiting, error: wErr } = await sb
      .from('outreach')
      .select('id, prospect_id, contact_id, created_at, prospects(business_name, website_context, prospect_brief, brief_callouts, marketing_signals, ads_detected, category, city), contacts(id, email, name)')
      .eq('status', 'prospected')
      .is('draft_subject', null)
      .order('created_at', { ascending: true })
      .limit(200);
    if (wErr) throw new Error(`OUTBOUND_PIPELINE_READ_FAILED: ${wErr.message}`);

    // A prospect with no contact email cannot be written to. Skipped rather
    // than drafted-and-stuck, so the queue never fills with messages that have
    // nowhere to go.
    const row = (waiting || []).find((r) => r.contacts?.email);

    if (!row) {
      const noEmail = (waiting || []).length;
      await finishRun(sb, runId, {
        ok: true,
        note: noEmail
          ? `${noEmail} prospect(s) waiting but none has a contact email`
          : 'no prospects waiting for a first draft',
      }, Date.now());
      console.log('[clarify.outbound] nothing to draft');
      return { statusCode: 200, body: JSON.stringify({ skipped: 'no_prospects', waitingWithoutEmail: noEmail }) };
    }

    const contact = row.contacts;
    const target = { ...(row.prospects || {}), id: row.prospect_id };

    // ── Permission ──────────────────────────────────────────────────────────
    const state = await loadGuardState(sb, SUBSYSTEM, now);
    const verdict = await attempt(sb, {
      subsystem: SUBSYSTEM,
      action: 'outbound.draft',
      tier: TIER.READ,
      state, now, runId,
      trigger: TRIGGER,
      rationale: `draft outreach to ${target.business_name}; ${pendingTotal || 0} already awaiting review`,
      costUsd: COST_CEILING,
    });

    if (!verdict.allow) {
      await finishRun(sb, runId, { ok: true, actions: 0, blocked: 1, note: `blocked: ${verdict.reason}` }, Date.now());
      console.log(`[clarify.outbound] blocked — ${verdict.reason}`);
      return { statusCode: 200, body: JSON.stringify({ mode: verdict.mode, reason: verdict.reason }) };
    }

    const { data: tone } = await sb
      .from('tone_memory').select('feedback_text').order('created_at', { ascending: false }).limit(10);
    const toneNotes = (tone || []).map((t) => t.feedback_text).filter(Boolean);

    let generated;
    try {
      generated = await completeJSON({
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(direction, target, toneNotes),
        maxTokens: MAX_TOKENS,
      });
    } catch (ex) {
      await recordFailure(sb, {
        subsystem: SUBSYSTEM, action: 'outbound.draft', tier: TIER.READ,
        error: ex, runId, trigger: TRIGGER, now: Date.now(),
      });
      throw ex;
    }

    const d = generated.data;
    const subject = clean(d.subject, 200);
    const body = clean(d.body, 8000);
    if (!subject || !body) {
      const ex = new Error(`OUTBOUND_DRAFT_INCOMPLETE: subject=${!!subject} body=${!!body}`);
      await recordFailure(sb, {
        subsystem: SUBSYSTEM, action: 'outbound.draft', tier: TIER.READ,
        error: ex, runId, trigger: TRIGGER, now: Date.now(),
      });
      throw ex;
    }

    // The model's own honesty check. If it says the research was too thin to
    // personalise truthfully, the draft is still queued but flagged — the
    // alternative is a generic email that reads as automated, which costs the
    // domain's reputation rather than just one reply.
    const thin = clean(d.confidence, 20).toLowerCase() === 'low';

    if (verdict.mode === MODE.DRY_RUN) {
      await finishRun(sb, runId, {
        ok: true, actions: 1, costUsd: generated.costUsd,
        note: `dry run — would have drafted to ${target.business_name}`,
      }, Date.now());
      console.log(`[clarify.outbound] dry run — "${subject}" to ${target.business_name}`);
      return { statusCode: 200, body: JSON.stringify({ mode: verdict.mode, subject, persisted: false }) };
    }

    // UPDATE, not insert — and re-checking `status`/`draft_subject` in the
    // WHERE clause, so two overlapping passes cannot both fill the same row and
    // produce two drafts for one prospect.
    const { data: updated, error: upErr } = await sb.from('outreach')
      .update({
        status: 'draft_ready',
        draft_subject: subject,
        draft_body: body,
        contact_id: row.contact_id || contact.id,
        tone_feedback: thin ? 'engine flagged: research too thin to personalise confidently' : null,
        updated_at: new Date(now).toISOString(),
      })
      .eq('id', row.id)
      .eq('status', 'prospected')
      .is('draft_subject', null)
      .select('id');

    if (upErr) {
      await recordFailure(sb, {
        subsystem: SUBSYSTEM, action: 'outbound.draft', tier: TIER.READ,
        error: upErr, runId, trigger: TRIGGER, now: Date.now(),
      });
      throw new Error(`OUTBOUND_DRAFT_WRITE_FAILED: ${upErr.message}`);
    }
    if (!updated || updated.length === 0) {
      // Another pass claimed it between the read and the write. Not an error —
      // the work simply belongs to that pass.
      await finishRun(sb, runId, { ok: true, actions: 0, note: 'row claimed by a concurrent pass' }, Date.now());
      return { statusCode: 200, body: JSON.stringify({ skipped: 'raced' }) };
    }
    const inserted = updated[0];

    await finishRun(sb, runId, {
      ok: true, actions: 1, costUsd: generated.costUsd,
      note: `drafted to ${target.business_name}${thin ? ' (thin research)' : ''} ($${generated.costUsd.toFixed(4)})`,
    }, Date.now());

    console.log(`[clarify.outbound] drafted "${subject}" to ${target.business_name} — awaiting approval`);
    return { statusCode: 200, body: JSON.stringify({ mode: verdict.mode, id: inserted.id, subject, to: contact.email }) };
  } catch (ex) {
    console.error('[clarify.outbound] failed:', ex.message);
    if (runId) {
      try { await finishRun(sb, runId, { ok: false, errors: 1, note: ex.message }, Date.now()); }
      catch (e2) { console.error('[clarify.outbound] could not close run:', e2.message); }
    }
    return { statusCode: 500, body: JSON.stringify({ error: ex.message }) };
  }
};
