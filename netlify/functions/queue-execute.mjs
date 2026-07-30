// ═══════════════════════════════════════════════════════════════════════════
// QUEUE EXECUTE — the tier-2 boundary. Where a draft becomes a real thing.
//
// This is the only code path in the system that publishes to the storefront or
// sends an email, and it CANNOT be reached by a schedule. It is HTTP-only and
// requires a signed-in session, because everything it does is customer-visible
// and irreversible: you cannot un-send an email, and an unpublish still leaves
// whatever a crawler already saw.
//
// FOUR THINGS MUST BE TRUE before anything leaves the building:
//   1. A human is signed in (requireAuth).
//   2. The operator has not hit STOP (global paused_reason is null).
//   3. The draft is still in draft_ready — never a re-send of something sent.
//   4. The draft is not stale — see below.
//
// STALENESS IS ENFORCED HERE, NOT JUST DISPLAYED. An outbound draft cites the
// prospect's state at the time it was written. Sending a three-week-old "I
// noticed you just launched…" is worse than sending nothing: it tells the
// recipient this was automated and unread. The queue shows stale items greyed;
// this path refuses them outright, because a warning the operator can tap
// through is not a guard.
//
// NOT gated on `enabled`. That flag arms the autonomous engines. A human
// pressing approve is the human acting, not the machine, so requiring autonomy
// to be armed before a person may send their own email would be theatre. STOP
// is the control that stops this, and it does.
// ═══════════════════════════════════════════════════════════════════════════
import { requireAuth } from './_shared/requireAuth.cjs';
import { sendEmail } from './_shared/gmail.cjs';
import { adminClient, TIER } from './lib/ops-runtime.mjs';
import { STALE_AFTER_DAYS, KIND, OUTREACH_DRAFT_STATUSES } from '@cc/ops/queue.js';
import { normalizeDraft } from '@cc/ops/draft.js';

const DAY_MS = 86_400_000;
const json = (statusCode, body) => ({
  statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** Audit every tier-2 act, successful or not. Best-effort: a logging failure
 *  must not mask the outcome of the thing being logged. */
async function audit(sb, row) {
  try {
    const { error } = await sb.from('ops_audit_log').insert({ cost_usd: 0, ...row });
    if (error) console.error('[queue-execute] audit write failed:', error.message);
  } catch (ex) {
    console.error('[queue-execute] audit threw:', ex.message);
  }
}

function ageDays(createdAt, now) {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) ? Math.floor((now - t) / DAY_MS) : null;
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = await requireAuth(event);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const { kind, id, action, reason } = payload;
  if (![KIND.CONTENT, KIND.OUTBOUND].includes(kind)) return json(400, { error: `Unknown kind "${kind}"` });
  if (!['approve', 'reject'].includes(action)) return json(400, { error: `Unknown action "${action}"` });
  if (!id) return json(400, { error: 'Missing id' });

  const now = Date.now();
  const actor = auth.user?.email || auth.user?.id || 'operator';

  let sb;
  try { sb = adminClient(); }
  catch (ex) { return json(500, { error: ex.message }); }

  // ── The hard stop ─────────────────────────────────────────────────────────
  const { data: globalRow, error: gErr } = await sb
    .from('ops_control').select('paused_reason').eq('key', 'global').maybeSingle();
  if (gErr) return json(500, { error: `Could not read the kill switch: ${gErr.message}` });
  if (!globalRow) return json(503, { error: 'Kill switch row missing — refusing to act' });
  if (globalRow.paused_reason) {
    return json(423, { error: `Stopped: ${globalRow.paused_reason}. Clear it in Ops to continue.` });
  }

  try {
    // ═══ CONTENT ═══════════════════════════════════════════════════════════
    if (kind === KIND.CONTENT) {
      const { data: draft, error } = await sb
        .from('content_drafts').select('*').eq('id', id).maybeSingle();
      if (error) return json(500, { error: error.message });
      if (!draft) return json(404, { error: 'Draft not found' });
      if (draft.status !== 'draft_ready') {
        return json(409, { error: `Already ${draft.status} — nothing to do` });
      }

      if (action === 'reject') {
        const { error: rejErr } = await sb.from('content_drafts').update({
          status: 'rejected', rejected_at: new Date(now).toISOString(),
          rejection_reason: typeof reason === 'string' ? reason.slice(0, 2000) : null,
        }).eq('id', id);
        // Reporting a rejection that did not persist puts the item back in the
        // queue with the operator believing they already dealt with it.
        if (rejErr) return json(500, { error: `Could not record the rejection: ${rejErr.message}` });
        await audit(sb, {
          subsystem: 'zts.content', action: 'content.reject', tier: TIER.READ, status: 'executed',
          trigger: `operator:${actor}`, rationale: reason || 'rejected by operator',
          target_table: 'content_drafts', target_id: id,
        });
        return json(200, { ok: true, status: 'rejected' });
      }

      const { SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN, SHOPIFY_BLOG_ID } = process.env;
      if (!SHOPIFY_STORE || !SHOPIFY_ADMIN_TOKEN || !SHOPIFY_BLOG_ID) {
        return json(500, { error: 'Missing SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN / SHOPIFY_BLOG_ID' });
      }
      const host = String(SHOPIFY_STORE).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');

      // CLAIM BEFORE PUBLISHING. The status write used to happen only after the
      // POST, so two approves for the same id could both pass the read above and
      // both publish the article. 'approved' is the constrained-in status that
      // means "taken, not yet live"; whoever loses the claim gets a 409 and
      // posts nothing.
      const { data: claimed, error: claimErr } = await sb.from('content_drafts')
        .update({ status: 'approved', approved_at: new Date(now).toISOString(), approved_by: actor })
        .eq('id', id).eq('status', 'draft_ready').select('id');
      if (claimErr) return json(500, { error: `Could not claim the draft before publishing: ${claimErr.message}` });
      if (!claimed || claimed.length === 0) return json(409, { error: 'Another approve already claimed this draft — nothing published' });

      // Releasing the claim is the whole reason 'a failed publish is a retryable
      // state' is true, so it has to survive a THROW as well as a rejection.
      // Reaching Shopify can fail with no response at all (DNS, TLS, timeout),
      // and a gateway that answers 502 with an HTML body makes res.json() throw
      // a SyntaxError — neither reaches the !res.ok branch below. Without this,
      // the row stays 'approved': nothing was published, the next approve hits
      // the draft_ready guard and 409s, and the Desk only lists draft_ready, so
      // the draft is unrecoverable and invisible at the same time.
      const releaseClaim = async (detail) => {
        const { error: relErr } = await sb.from('content_drafts')
          .update({ status: 'draft_ready', approved_at: null, approved_by: null, error: detail })
          .eq('id', id).eq('status', 'approved');
        if (relErr) console.error('[queue-execute] could not release the content claim:', relErr.message);
      };

      let res, data;
      try {
        res = await fetch(`https://${host}/admin/api/2024-01/blogs/${SHOPIFY_BLOG_ID}/articles.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN },
          body: JSON.stringify({
            article: {
              title: draft.title,
              body_html: draft.body_html,
              summary_html: draft.summary || '',
              tags: draft.tags || '',
              handle: draft.handle || undefined,
              published: true,
            },
          }),
        });
        data = await res.json();
      } catch (ex) {
        const detail = `Could not reach Shopify: ${ex.message}`.slice(0, 500);
        await releaseClaim(detail);
        await audit(sb, {
          subsystem: 'zts.content', action: 'content.publish', tier: TIER.APPROVAL, status: 'failed',
          trigger: `operator:${actor}`, target_table: 'content_drafts', target_id: id, error: detail,
        });
        return json(502, { error: detail });
      }

      if (!res.ok || !data.article) {
        const detail = JSON.stringify(data.errors || data).slice(0, 500);
        // Handed back to draft_ready deliberately: a failed publish is a
        // retryable state, and marking it 'failed' would drop it out of the
        // queue and out of sight. The claim above has to be released for that
        // to be true.
        await releaseClaim(detail);
        await audit(sb, {
          subsystem: 'zts.content', action: 'content.publish', tier: TIER.APPROVAL, status: 'failed',
          trigger: `operator:${actor}`, target_table: 'content_drafts', target_id: id, error: detail,
        });
        return json(502, { error: `Shopify rejected the article: ${detail}` });
      }

      const url = `https://${host.replace('.myshopify.com', '')}.com/blogs/${draft.blog_handle || 'news'}/${data.article.handle}`;
      const { error: finErr } = await sb.from('content_drafts').update({
        status: 'published',
        published_at: new Date(now).toISOString(),
        shopify_article_id: String(data.article.id),
        published_url: url,
        error: null,
      }).eq('id', id);
      // The article is live either way. An unreported failure here used to
      // answer {ok:true} over a row that still said draft_ready, which put the
      // same article back in the queue to be published a second time.
      if (finErr) {
        console.error('[queue-execute] published but could not record it:', finErr.message);
      }

      await audit(sb, {
        subsystem: 'zts.content', action: 'content.publish', tier: TIER.APPROVAL, status: 'executed',
        trigger: `operator:${actor}`, rationale: draft.rationale,
        target_table: 'content_drafts', target_id: id,
        after_data: { title: draft.title, url },
        // Unpublishing does not undo a crawl, so this is honest about what it
        // can and cannot reverse rather than promising a clean rollback.
        undo: { op: 'shopify_article_unpublish', articleId: String(data.article.id), note: 'removes the page; does not undo indexing' },
      });

      if (finErr) {
        return json(502, { error: `Published at ${url}, but recording it failed: ${finErr.message}. The row is held at 'approved' so it cannot publish twice — fix it by hand.`, url });
      }
      return json(200, { ok: true, status: 'published', url });
    }

    // ═══ OUTBOUND ══════════════════════════════════════════════════════════
    const { data: draft, error } = await sb
      .from('outreach')
      .select('*, contacts(email, name), prospects(business_name)')
      .eq('id', id).maybeSingle();
    if (error) return json(500, { error: error.message });
    if (!draft) return json(404, { error: 'Draft not found' });
    if (!OUTREACH_DRAFT_STATUSES.includes(draft.status)) {
      return json(409, { error: `Already ${draft.status} — nothing to do` });
    }

    if (action === 'reject') {
      const { error: rejErr } = await sb.from('outreach').update({
        status: 'rejected', rejected_at: new Date(now).toISOString(),
        rejection_reason: typeof reason === 'string' ? reason.slice(0, 2000) : null,
      }).eq('id', id);
      if (rejErr) return json(500, { error: `Could not record the rejection: ${rejErr.message}` });

      // A rejection with a stated reason is the only training signal this
      // system gets. Storing it is what stops next week's drafts repeating
      // exactly the mistake that got this one killed.
      if (typeof reason === 'string' && reason.trim()) {
        await sb.from('tone_memory').insert({
          feedback_text: reason.trim().slice(0, 2000), applied_to_outreach_id: id,
        });
      }
      await audit(sb, {
        subsystem: 'clarify.outbound', action: 'outbound.reject', tier: TIER.READ, status: 'executed',
        trigger: `operator:${actor}`, rationale: reason || 'rejected by operator',
        target_table: 'outreach', target_id: id,
      });
      return json(200, { ok: true, status: 'rejected' });
    }

    const age = ageDays(draft.created_at, now);
    if (age != null && age > STALE_AFTER_DAYS[KIND.OUTBOUND]) {
      await audit(sb, {
        subsystem: 'clarify.outbound', action: 'outbound.send', tier: TIER.APPROVAL, status: 'blocked',
        blocked_by: `draft is ${age} days old — stale`, trigger: `operator:${actor}`,
        target_table: 'outreach', target_id: id,
      });
      return json(409, {
        error: `This draft is ${age} days old and references the prospect as they were then. Reject it and let the engine write a fresh one.`,
      });
    }

    const to = draft.contacts?.email;
    if (!to) return json(400, { error: 'No contact email on this prospect' });

    // NORMALISE BEFORE SENDING. Some rows store the model's whole JSON response
    // in draft_body instead of an email. Clarify's UI has always hidden that at
    // render time, so it was never fixed — and one such row was already SENT to
    // a real prospect as a raw JSON blob. Sending draft_body verbatim would do
    // it again, silently, on the operator's first tap.
    const clean = normalizeDraft({ subject: draft.draft_subject, body: draft.draft_body });
    if (!clean.body.trim()) {
      return json(422, { error: 'This draft has no readable body. Reject it and let the engine rewrite it.' });
    }

    // CLAIM BEFORE SENDING. The status write used to happen after sendEmail and
    // its error was thrown away: Gmail accepts the message, the PostgREST update
    // fails, the handler still answers {ok:true}, and the row is left in
    // draft_ready — back in the Desk queue, where the next approve sends the same
    // cold email to the same prospect again. Two overlapping approves did the
    // same thing, both passing the status read above before either sent. Moving
    // the transition in front of the send, conditioned on the row still being a
    // draft, is what makes rule 3 in this file's header true.
    const { data: claimed, error: claimErr } = await sb.from('outreach')
      .update({
        status: 'sent',
        approved_at: new Date(now).toISOString(),
        sent_at: new Date(now).toISOString(),
      })
      .eq('id', id)
      .in('status', OUTREACH_DRAFT_STATUSES)
      .select('id');
    if (claimErr) return json(500, { error: `Could not claim the draft before sending: ${claimErr.message}` });
    if (!claimed || claimed.length === 0) return json(409, { error: 'Another approve already claimed this draft — nothing sent' });

    let sent;
    try {
      sent = await sendEmail({ to, subject: clean.subject, body: clean.body });
    } catch (ex) {
      // Nothing left the building, so hand the draft back rather than stranding
      // it at 'sent' where neither the queue nor the reply poller would see it.
      // Guarded on gmail_message_id so this can only ever release a claim whose
      // send genuinely failed.
      const { error: revertErr } = await sb.from('outreach')
        .update({ status: draft.status, approved_at: null, sent_at: null })
        .eq('id', id).eq('status', 'sent').is('gmail_message_id', null);
      if (revertErr) console.error('[queue-execute] could not release the outbound claim:', revertErr.message);
      await audit(sb, {
        subsystem: 'clarify.outbound', action: 'outbound.send', tier: TIER.APPROVAL, status: 'failed',
        trigger: `operator:${actor}`, target_table: 'outreach', target_id: id, error: ex.message,
      });
      return json(502, { error: ex.message });
    }

    const { error: finErr } = await sb.from('outreach').update({
      gmail_message_id: sent.messageId,
      gmail_thread_id: sent.threadId,
      gmail_rfc_message_id: sent.rfcMessageId,
    }).eq('id', id);
    // The email is gone; only the Gmail ids are missing. Say so — without the
    // thread id, replies-cron cannot see an answer to this thread, and a silent
    // {ok:true} would leave that permanently invisible.
    if (finErr) console.error('[queue-execute] sent but could not record the gmail ids:', finErr.message);

    await audit(sb, {
      subsystem: 'clarify.outbound', action: 'outbound.send', tier: TIER.APPROVAL, status: 'executed',
      trigger: `operator:${actor}`,
      rationale: `approved and sent to ${draft.prospects?.business_name || to}`,
      target_table: 'outreach', target_id: id,
      after_data: { to, subject: clean.subject, messageId: sent.messageId, repairedBeforeSend: clean.repaired },
      // No undo. Stated explicitly rather than left absent, so the log does not
      // read as though someone forgot to fill it in.
      undo: null,
    });

    if (finErr) {
      return json(502, {
        error: `Sent to ${to} (message ${sent.messageId}), but recording the Gmail ids failed: ${finErr.message}. Replies on this thread will not be detected until it is fixed by hand.`,
        messageId: sent.messageId,
      });
    }
    return json(200, { ok: true, status: 'sent', to, messageId: sent.messageId });
  } catch (ex) {
    console.error('[queue-execute] failed:', ex.message);
    return json(500, { error: ex.message });
  }
};
