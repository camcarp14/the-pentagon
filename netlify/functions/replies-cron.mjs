// ═══════════════════════════════════════════════════════════════════════════
// REPLIES CRON — notice when a human answers.
//
// This is the highest-value function in the repo, and until now it did not
// exist. `check-replies.js` has always been auth-gated, so reply detection ran
// only when the operator clicked a button in the Clarify toolbar. One email has
// been sent, 27 days ago. If that prospect replied, nothing in this system
// knows.
//
// Everything else here manufactures outbound volume. This is the only thing
// that catches the return signal, and a reply is worth more than a hundred
// drafts: it is the single event in the whole pipeline that indicates real
// demand. Missing one costs a customer. Missing one for 27 days costs the
// relationship.
//
// TIER 1, NOT TIER 0. Reading Gmail changes nothing, but recording a reply
// flips outreach.status to 'replied' and stops any sequence enrolled against
// that prospect — a real state change in our own database. Reversible and
// internal, so tier 1, and it carries the undo descriptor the guard demands.
//
// IT NEVER REPLIES. It records that a reply exists. Composing or sending an
// answer is tier 2 and stays behind the operator, always.
// ═══════════════════════════════════════════════════════════════════════════
import {
  adminClient, loadGuardState, attempt, recordFailure,
  startRun, finishRun, registerSubsystem, MODE, TIER,
} from './lib/ops-runtime.mjs';
import { pollReplies } from './_shared/replies.cjs';

const SUBSYSTEM = 'clarify.replies';
const TRIGGER = 'netlify schedule */15';

// Gmail is polled per thread, one request each, inside a 30-second budget.
// Sixty threads is comfortably inside it and far beyond current volume.
const MAX_THREADS = 60;

// The cap used to be a fixed prefix: the 60 oldest open threads, ordered by
// sent_at. A thread only leaves that selection when a reply is recorded, and
// most cold emails never get one — so past 60 unanswered sends the tail was
// never polled at all, not "on the next pass", ever. The cap has to rotate.
// Rotating on the clock rather than on a per-row checked-at column keeps this
// to the function (a marker column would need a migration), and every 15-minute
// slot advances the window by one batch, so the whole set is covered within
// ceil(total / MAX_THREADS) passes.
const SLOT_MS = 15 * 60_000;

export const handler = async () => {
  const now = Date.now();
  let sb, runId = null;

  try {
    sb = adminClient();
  } catch (ex) {
    console.error('[clarify.replies] cannot start:', ex.message);
    return { statusCode: 500, body: JSON.stringify({ error: ex.message }) };
  }

  try {
    await registerSubsystem(sb, SUBSYSTEM);
    runId = await startRun(sb, SUBSYSTEM, 'schedule', now);

    // Threads we sent on and have not yet seen an answer to. Ordered oldest
    // first so a long pipeline cannot starve the earliest sends.
    const openQuery = (select, opts) => sb
      .from('outreach')
      .select(select, opts)
      .eq('status', 'sent')
      .not('gmail_thread_id', 'is', null)
      .is('replied_at', null);

    const { count: openCount, error: cErr } = await openQuery('id', { count: 'exact', head: true });
    if (cErr) throw new Error(`REPLIES_OPEN_COUNT_FAILED: ${cErr.message}`);

    // Which slice of the open set this pass takes. One batch per 15-minute slot,
    // wrapping — so a set larger than MAX_THREADS is polled round-robin instead
    // of the oldest 60 being re-polled forever while the rest are never seen.
    const batches = Math.max(1, Math.ceil((openCount || 0) / MAX_THREADS));
    const offset = (Math.floor(now / SLOT_MS) % batches) * MAX_THREADS;

    const { data: open, error: oErr } = await openQuery('id, gmail_thread_id, sent_at, contacts(email), prospects(business_name)')
      .order('sent_at', { ascending: true })
      .range(offset, offset + MAX_THREADS - 1);
    if (oErr) throw new Error(`REPLIES_OPEN_READ_FAILED: ${oErr.message}`);

    const threads = (open || []).filter((r) => r.gmail_thread_id);
    if (!threads.length) {
      await finishRun(sb, runId, { ok: true, note: 'no open threads to check' }, Date.now());
      return { statusCode: 200, body: JSON.stringify({ skipped: 'no_open_threads' }) };
    }

    const state = await loadGuardState(sb, SUBSYSTEM, now);
    const byThread = new Map(threads.map((r) => [r.gmail_thread_id, r]));

    const verdict = await attempt(sb, {
      subsystem: SUBSYSTEM,
      action: 'replies.poll',
      tier: TIER.REVERSIBLE,
      state, now, runId,
      trigger: TRIGGER,
      rationale: `check ${threads.length} sent thread(s) for a reply`,
      // Recording a reply is undone by clearing the reply columns; the next
      // pass would simply find it again. A genuine, complete reversal.
      undo: { op: 'clear_reply_fields', table: 'outreach', threads: threads.map((t) => t.id) },
      costUsd: 0,
    });

    if (!verdict.allow) {
      await finishRun(sb, runId, { ok: true, actions: 0, blocked: 1, note: `blocked: ${verdict.reason}` }, Date.now());
      console.log(`[clarify.replies] blocked — ${verdict.reason}`);
      return { statusCode: 200, body: JSON.stringify({ mode: verdict.mode, reason: verdict.reason }) };
    }

    let poll;
    try {
      poll = await pollReplies(threads.map((t) => t.gmail_thread_id));
    } catch (ex) {
      await recordFailure(sb, {
        subsystem: SUBSYSTEM, action: 'replies.poll', tier: TIER.REVERSIBLE,
        error: ex, runId, trigger: TRIGGER, now: Date.now(),
      });
      throw ex;
    }

    // A sweep where EVERY thread errored is not "no replies" — it is a blind
    // pass, and reporting it as healthy is the exact false negative this
    // rewrite exists to remove.
    if (poll.errors.length && poll.errors.length === poll.checked) {
      const detail = poll.errors.slice(0, 3).map((e) => e.error).join('; ');
      await recordFailure(sb, {
        subsystem: SUBSYSTEM, action: 'replies.poll', tier: TIER.REVERSIBLE,
        error: new Error(`REPLIES_ALL_THREADS_FAILED: ${detail}`), runId, trigger: TRIGGER, now: Date.now(),
      });
      throw new Error(`REPLIES_ALL_THREADS_FAILED: ${poll.checked} thread(s), all failed — ${detail}`);
    }

    if (verdict.mode === MODE.DRY_RUN) {
      await finishRun(sb, runId, {
        ok: true, actions: poll.replies.length,
        note: `dry run — found ${poll.replies.length} reply/replies across ${poll.checked} thread(s), recorded none`,
      }, Date.now());
      console.log(`[clarify.replies] dry run — ${poll.replies.length} found, none recorded`);
      return { statusCode: 200, body: JSON.stringify({ mode: verdict.mode, found: poll.replies.length, recorded: 0 }) };
    }

    let recorded = 0;
    const names = [];
    for (const reply of poll.replies) {
      const row = byThread.get(reply.threadId);
      if (!row) continue;

      const { error: upErr } = await sb.from('outreach').update({
        status: 'replied',
        replied_at: new Date(now).toISOString(),
        reply_body: reply.body || null,
        reply_from: reply.from || null,
        reply_subject: reply.subject || null,
        reply_snippet: reply.snippet || null,
        reply_gmail_message_id: reply.messageId || null,
        updated_at: new Date(now).toISOString(),
      })
        .eq('id', row.id)
        // Re-checked so a concurrent pass cannot overwrite a reply that was
        // already recorded, and cannot resurrect one the operator advanced to
        // 'meeting' in between.
        .eq('status', 'sent');

      if (upErr) {
        console.error(`[clarify.replies] could not record reply on ${row.id}:`, upErr.message);
        continue;
      }
      recorded += 1;
      names.push(row.prospects?.business_name || reply.fromAddress);

      // Stop any live sequence for this prospect. A follow-up that lands after
      // someone has already answered is the single most damaging thing an
      // outbound system does — it proves nobody read the reply.
      const { error: seqErr } = await sb.from('sequence_enrollments')
        .update({ status: 'stopped_reply', completed_at: new Date(now).toISOString(), last_decision: 'reply received' })
        .eq('outreach_id', row.id).eq('status', 'active');
      if (seqErr) console.error('[clarify.replies] could not stop sequence:', seqErr.message);
    }

    const note = recorded
      ? `RECORDED ${recorded} REPLY/REPLIES: ${names.join(', ')}`
      : `no replies across ${poll.checked} thread(s)${poll.errors.length ? ` (${poll.errors.length} thread error(s))` : ''}`;

    await finishRun(sb, runId, {
      ok: true, actions: recorded, errors: poll.errors.length ? 1 : 0, note,
    }, Date.now());

    if (recorded) console.log(`[clarify.replies] ${note}`);
    return { statusCode: 200, body: JSON.stringify({ mode: verdict.mode, checked: poll.checked, found: poll.replies.length, recorded, errors: poll.errors }) };
  } catch (ex) {
    console.error('[clarify.replies] failed:', ex.message);
    if (runId) {
      try { await finishRun(sb, runId, { ok: false, errors: 1, note: ex.message }, Date.now()); }
      catch (e2) { console.error('[clarify.replies] could not close run:', e2.message); }
    }
    return { statusCode: 500, body: JSON.stringify({ error: ex.message }) };
  }
};
