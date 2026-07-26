// ═══════════════════════════════════════════════════════════════════════════
// @cc/ops/queue — ONE LIST, TWO ENGINES.
//
// Content drafts and outbound drafts live in different tables with different
// columns and different lifecycles. The operator should never have to know
// that. This module folds both into a single item shape, ranks them, and
// decides which ones have gone stale.
//
// WHY RANKING IS NOT "NEWEST FIRST". The queue is a work list, not a feed. It
// is ordered by what goes wrong if it is ignored:
//
//   1. Outbound before content. An outbound draft is written against a
//      prospect's current state — a recent post, a live ad, a job listing.
//      Content is evergreen; it is just as good tomorrow.
//   2. Oldest first within a kind, so nothing can be starved by newer arrivals.
//
// STALENESS IS A FEATURE. A three-week-old cold email that opens "I noticed you
// just launched…" is worse than no email — it tells the recipient this was
// automated and not read. Stale items are surfaced as stale and are refused by
// the execute path rather than quietly sent. Content ages far more slowly, so
// it gets a much longer window; the asymmetry is the whole point.
//
// Pure: no fetch, no Date.now(), no database.
// ═══════════════════════════════════════════════════════════════════════════

export const KIND = Object.freeze({
  CONTENT: "content",
  OUTBOUND: "outbound",
});

const DAY_MS = 86_400_000;

/** How long a prepared draft stays valid. Outbound is short because it cites
 *  the prospect's current state; content is long because it does not. */
export const STALE_AFTER_DAYS = Object.freeze({
  [KIND.OUTBOUND]: 7,
  [KIND.CONTENT]: 30,
});

const KIND_RANK = Object.freeze({ [KIND.OUTBOUND]: 0, [KIND.CONTENT]: 1 });

const str = (v) => (typeof v === "string" ? v.trim() : "");

/** Trim to a preview without cutting a word in half or leaving a dangling
 *  space before the ellipsis. */
export function excerpt(text, max = 180) {
  const s = str(text).replace(/\s+/g, " ");
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function ageDays(createdAt, now) {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

/** A content_drafts row → queue item. */
export function fromContentDraft(row, now) {
  const age = ageDays(row.created_at, now);
  return {
    id: row.id,
    kind: KIND.CONTENT,
    title: str(row.title) || "Untitled article",
    preview: excerpt(str(row.summary) || str(row.body_html).replace(/<[^>]*>/g, " ")),
    why: str(row.rationale),
    target: str(row.blog_handle) || "blog",
    createdAt: row.created_at,
    ageDays: age,
    stale: age != null && age > STALE_AFTER_DAYS[KIND.CONTENT],
    // Publishing to a live storefront is customer-visible: tier 2, always
    // approval-gated. Recorded on the item so the UI can say so rather than
    // the operator having to know the doctrine.
    tier: 2,
  };
}

/** An outreach row (joined to prospect/contact) → queue item. */
export function fromOutreachDraft(row, now) {
  const age = ageDays(row.created_at, now);
  const who = str(row.business_name) || str(row.contact_name) || str(row.contact_email) || "Unknown prospect";
  return {
    id: row.id,
    kind: KIND.OUTBOUND,
    title: str(row.draft_subject) || `Message to ${who}`,
    preview: excerpt(row.draft_body),
    why: str(row.brief_callouts) || str(row.prospect_brief),
    target: who,
    to: str(row.contact_email),
    createdAt: row.created_at,
    ageDays: age,
    stale: age != null && age > STALE_AFTER_DAYS[KIND.OUTBOUND],
    tier: 2,
  };
}

/**
 * Merge, rank, and mark the queue.
 *
 * Stale items sort to the BOTTOM regardless of kind. They still appear — a
 * silently vanishing draft is how work gets lost — but they must not sit above
 * live work competing for the operator's first glance.
 */
export function buildQueue({ contentDrafts = [], outreachDrafts = [], now } = {}) {
  const items = [
    ...contentDrafts.map((r) => fromContentDraft(r, now)),
    ...outreachDrafts.map((r) => fromOutreachDraft(r, now)),
  ];

  items.sort((a, b) => {
    if (a.stale !== b.stale) return a.stale ? 1 : -1;
    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    // Oldest first, so nothing starves. Unparseable dates sort last rather
    // than to the front, where a null would otherwise win every comparison.
    const at = Date.parse(a.createdAt), bt = Date.parse(b.createdAt);
    if (!Number.isFinite(at)) return 1;
    if (!Number.isFinite(bt)) return -1;
    return at - bt;
  });

  return items;
}

/** Headline counts for the UI, computed once here so three components cannot
 *  disagree about what "waiting" means. */
export function queueSummary(items) {
  const live = items.filter((i) => !i.stale);
  return {
    total: items.length,
    waiting: live.length,
    stale: items.length - live.length,
    content: live.filter((i) => i.kind === KIND.CONTENT).length,
    outbound: live.filter((i) => i.kind === KIND.OUTBOUND).length,
    oldestAgeDays: live.reduce((m, i) => Math.max(m, i.ageDays || 0), 0),
  };
}

/**
 * How many more items an engine may PREPARE today.
 *
 * Counts what already exists rather than what was sent, because the thing being
 * rationed is the operator's attention. Twenty unreviewed drafts is not a
 * productive day; it is a queue nobody will open.
 */
export function preparationBudget({ perDay, preparedToday = 0, pendingTotal = 0, maxPending = 25 }) {
  const cap = Number.isFinite(perDay) && perDay > 0 ? Math.floor(perDay) : 0;
  const byDay = Math.max(0, cap - Math.max(0, preparedToday));
  const byBacklog = Math.max(0, maxPending - Math.max(0, pendingTotal));
  return Math.min(byDay, byBacklog);
}
