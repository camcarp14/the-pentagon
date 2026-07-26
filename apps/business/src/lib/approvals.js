// ═══════════════════════════════════════════════════════════════════════════
// B2 — approvals cannot expire silently.
//
// `veto_until` is a deadline, not a reminder. When it passes with the row
// still `pending`, the agent proceeds — nobody writes anything, the row just
// ages. So "it went ahead without you" is not an event you can subscribe to;
// it is a shape in the data, and this module is where that shape is named.
//
// Three buckets, and the middle one is the whole point:
//
//   urgent   — pending, deadline inside the next 60 minutes. Pinned, counting
//              down live. These are the ones you can still stop.
//   expired  — pending, deadline gone. The agent ALREADY ACTED. These are not
//   unreviewed  history and must never be merged into it; history is a list of
//              decisions you made, and these are the ones you didn't.
//   decided  — you approved or vetoed. Ordinary history.
//
// "Since my last visit" is tracked client-side on purpose: the alternative is
// an `acknowledged_at` column, and writing it would be a fourth verb from the
// browser. B4 says three. A localStorage timestamp costs nothing and keeps the
// database read-only where it was promised to be.
// ═══════════════════════════════════════════════════════════════════════════

import { toMs } from "./format.js";

/** Deadline inside this window ⇒ pinned to the top with a live countdown. */
export const URGENT_WINDOW_MIN = 60;

export function partitionApprovals(rows, {
  now = Date.now(),
  lastVisitAt = null,
  urgentWindowMin = URGENT_WINDOW_MIN,
} = {}) {
  const urgentMs = urgentWindowMin * 60_000;
  const urgent = [];
  const pendingLater = [];
  const expiredUnreviewed = [];
  const decided = [];

  for (const raw of Array.isArray(rows) ? rows : []) {
    if (!raw) continue;
    const vetoAt = toMs(raw.veto_until);
    const row = {
      ...raw,
      vetoAtMs: vetoAt,
      msRemaining: vetoAt === null ? null : vetoAt - now,
    };

    if (row.decision && row.decision !== "pending") {
      decided.push(row);
      continue;
    }
    // A pending row with an unreadable deadline can't be proven to be safe, so
    // it is treated as urgent rather than filed away.
    if (vetoAt === null) { urgent.push({ ...row, deadlineUnknown: true }); continue; }

    if (row.msRemaining <= 0) expiredUnreviewed.push(row);
    else if (row.msRemaining <= urgentMs) urgent.push(row);
    else pendingLater.push(row);
  }

  // Soonest deadline first — the one you have the least time to stop is the
  // one your thumb should land on.
  urgent.sort((a, b) => (a.msRemaining ?? -Infinity) - (b.msRemaining ?? -Infinity));
  pendingLater.sort((a, b) => (a.msRemaining ?? Infinity) - (b.msRemaining ?? Infinity));
  // Most recently expired first: what it just did outranks what it did last week.
  expiredUnreviewed.sort((a, b) => (b.vetoAtMs ?? 0) - (a.vetoAtMs ?? 0));
  decided.sort((a, b) => (toMs(b.decided_at) ?? toMs(b.created_at) ?? 0) - (toMs(a.decided_at) ?? toMs(a.created_at) ?? 0));

  const visitMs = toMs(lastVisitAt);
  const sinceLastVisit = visitMs === null
    ? expiredUnreviewed
    : expiredUnreviewed.filter((r) => (r.vetoAtMs ?? 0) >= visitMs);

  return {
    urgent,
    pendingLater,
    pending: [...urgent, ...pendingLater],
    expiredUnreviewed,
    // The callout list. When we have no record of a last visit we show all of
    // them — over-reporting an auto-proceed is recoverable, under-reporting is
    // the failure this bucket exists to prevent.
    sinceLastVisit,
    earlierExpired: expiredUnreviewed.filter((r) => !sinceLastVisit.includes(r)),
    decided,
    counts: {
      urgent: urgent.length,
      pending: urgent.length + pendingLater.length,
      expiredUnreviewed: expiredUnreviewed.length,
      sinceLastVisit: sinceLastVisit.length,
    },
  };
}

/**
 * Can this row still be decided? The database says no once the window has
 * lapsed (the RLS policy checks `veto_until > now()`), and the UI must agree —
 * offering a button the database will refuse is how you get a tap that looks
 * like it worked.
 */
export function isDecidable(row, now = Date.now()) {
  if (!row || row.decision !== "pending") return false;
  const t = toMs(row.veto_until);
  return t !== null && t > now;
}

export const LAST_VISIT_KEY = "agent_business_last_visit";

export function readLastVisit(storage) {
  try {
    const s = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    const raw = s?.getItem(LAST_VISIT_KEY);
    return raw ? toMs(Number(raw)) : null;
  } catch { return null; }
}

export function writeLastVisit(at = Date.now(), storage) {
  try {
    const s = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    s?.setItem(LAST_VISIT_KEY, String(at));
  } catch { /* private mode — the callout just shows everything, which is the safe direction */ }
}
