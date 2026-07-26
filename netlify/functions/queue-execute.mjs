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
        await sb.from('content_drafts').update({
          status: 'rejected', rejected_at: new Date(now).toISOString(),
          rejection_reason: typeof reason === 'string' ? reason.slice(0, 2000) : null,
        }).eq('id', id);
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

      const res = await fetch(`https://${host}/admin/api/2024-01/blogs/${SHOPIFY_BLOG_ID}/articles.json`, {
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
      const data = await res.json();

      if (!res.ok || !data.article) {
        const detail = JSON.stringify(data.errors || data).slice(0, 500);
        // Left in draft_ready deliberately: a failed publish is a retryable
        // state, and marking it 'failed' would drop it out of the queue and
        // out of sight.
        await sb.from('content_drafts').update({ error: detail }).eq('id', id);
        await audit(sb, {
          subsystem: 'zts.content', action: 'content.publish', tier: TIER.APPROVAL, status: 'failed',
          trigger: `operator:${actor}`, target_table: 'content_drafts', target_id: id, error: detail,
        });
        return json(502, { error: `Shopify rejected the article: ${detail}` });
      }

      const url = `https://${host.replace('.myshopify.com', '')}.com/blogs/${draft.blog_handle || 'news'}/${data.article.handle}`;
      await sb.from('content_drafts').update({
        status: 'published',
        approved_at: new Date(now).toISOString(),
        approved_by: actor,
        published_at: new Date(now).toISOString(),
        shopify_article_id: String(data.article.id),
        published_url: url,
        error: null,
      }).eq('id', id);

      await audit(sb, {
        subsystem: 'zts.content', action: 'content.publish', tier: TIER.APPROVAL, status: 'executed',
        trigger: `operator:${actor}`, rationale: draft.rationale,
        target_table: 'content_drafts', target_id: id,
        after_data: { title: draft.title, url },
        // Unpublishing does not undo a crawl, so this is honest about what it
        // can and cannot reverse rather than promising a clean rollback.
        undo: { op: 'shopify_article_unpublish', articleId: String(data.article.id), note: 'removes the page; does not undo indexing' },
      });

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
      await sb.from('outreach').update({
        status: 'rejected', rejected_at: new Date(now).toISOString(),
        rejection_reason: typeof reason === 'string' ? reason.slice(0, 2000) : null,
      }).eq('id', id);

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

    let sent;
    try {
      sent = await sendEmail({ to, subject: clean.subject, body: clean.body });
    } catch (ex) {
      await audit(sb, {
        subsystem: 'clarify.outbound', action: 'outbound.send', tier: TIER.APPROVAL, status: 'failed',
        trigger: `operator:${actor}`, target_table: 'outreach', target_id: id, error: ex.message,
      });
      return json(502, { error: ex.message });
    }

    await sb.from('outreach').update({
      status: 'sent',
      approved_at: new Date(now).toISOString(),
      sent_at: new Date(now).toISOString(),
      gmail_message_id: sent.messageId,
      gmail_thread_id: sent.threadId,
      gmail_rfc_message_id: sent.rfcMessageId,
    }).eq('id', id);

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

    return json(200, { ok: true, status: 'sent', to, messageId: sent.messageId });
  } catch (ex) {
    console.error('[queue-execute] failed:', ex.message);
    return json(500, { error: ex.message });
  }
};
