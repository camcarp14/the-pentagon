// ═══════════════════════════════════════════════════════════════════════════
// THE REVIEW QUEUE'S MEMORY — which repos you have already been through.
//
// Ideas stopped being a feed you scroll. The ranker picks the top ten out of
// everything you have not reviewed, those ten are all you see, and a button
// hands you the next ten. That only works if "already been through" is a fact
// the browser remembers, so this file owns it.
//
// ── WHAT THE BUTTON DOES, WHICH IS THE WHOLE DESIGN ────────────────────────
//
// Pressing it MARKS the ten on screen and moves on. It does not delete them,
// hide them permanently, or write anything to the server. Three properties fall
// out of that and all three are load-bearing:
//
//   · RECOVERABLE AS A GROUP. Every id is stamped with the round it was marked
//     in, so `undoLastRound` is exact — it takes back the ten you just marked
//     and nothing else. There is no timer on it; the last round stays undoable
//     until you open another one.
//   · RECOVERABLE ONE AT A TIME. `requeue` unmarks a single repo, which is what
//     the Reviewed list's per-row control calls. A queue that can only be
//     rewound in blocks of ten is a queue you stop trusting.
//   · NEVER LOST. Nothing here is a delete. The Reviewed list reads the same
//     rows out of the same feed; the only thing this file changes is which of
//     two lists a row is in.
//
// ── SURVIVING A SCAN ───────────────────────────────────────────────────────
//
// State is keyed by repo id and NOTHING ELSE — not by position, not by rank,
// not by a cursor into a list. That is what makes it survive the scanner adding
// forty rows at 04:00: the new rows are simply ids we have never stamped, so
// they enter the pool and get ranked with everything else, and the rows you
// already reviewed stay reviewed no matter where the ranker moves them. A
// design that stored "I am 40 rows deep" instead would silently skip or repeat
// forty repos every time the sweep landed.
//
// `at` — the clock when the last round was opened — exists only so the queue
// can say "3 of these arrived since your last round" by comparing it against
// each row's own first_seen. When it is 0 the screen says nothing rather than
// guessing.
//
// ── POSTURE ────────────────────────────────────────────────────────────────
//
// Same as apps/shell/src/tabPrefs.js, for the same reason: this is read on the
// render path from localStorage, which is a place other builds have written to.
// `normalizeQueue` takes anything — null, a string, an array of bare ids from
// an older build, an object with a half-written `reviewed` — and returns a
// usable shape. It never throws. There is no sensible error state for "your
// review history is malformed", so there is no error state.
//
// Pure except for the two explicit localStorage functions and the one default
// clock read in `markReviewed`, which is a click handler and not a render.
// ═══════════════════════════════════════════════════════════════════════════

export const QUEUE_KEY = "ideas_review_queue";

/** How many the ranker hands over at a time. */
export const BATCH = 10;

/**
 * A corruption guard, not a policy. The feed is capped at 500 rows, so reaching
 * this honestly would take 500 rounds against a table that cannot hold that
 * many distinct repos. If a bad write ever does inflate the map, the oldest
 * rounds are dropped first and those repos return to the pool — which is the
 * failure everyone would rather have than a localStorage quota exception on a
 * render path.
 */
export const MAX_REVIEWED = 5000;

export const emptyQueue = () => ({ reviewed: new Map(), round: 0, at: 0 });

const intAtLeast = (v, min) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min ? n : null;
};

/**
 * Fold whatever is in storage into `{ reviewed: Map<id, round>, round, at }`.
 *
 * Accepts, in order of how likely each is to actually turn up:
 *   · the shape this file writes
 *   · a state object it has already normalized (the Map passes straight back)
 *   · `{ reviewed: ["id", …] }` or a bare `["id", …]` — the obvious earlier
 *     shape, read as one round of history rather than thrown away
 *   · null, a string, a number, an object with junk in every field
 */
export function normalizeQueue(raw) {
  const src = Array.isArray(raw)
    ? { reviewed: raw }
    : raw && typeof raw === "object" ? raw : {};

  const rv = src.reviewed;
  const pairs = [];
  if (rv instanceof Map) for (const [id, r] of rv) pairs.push([id, r]);
  else if (Array.isArray(rv)) for (const id of rv) pairs.push([id, 1]);
  else if (rv && typeof rv === "object") for (const id of Object.keys(rv)) pairs.push([id, rv[id]]);

  const reviewed = new Map();
  let top = 0;
  for (const [id, r] of pairs) {
    if (typeof id !== "string" || !id) continue;
    // An unreadable round number still means "this repo was reviewed" — that is
    // the fact worth keeping. It joins round 1, the oldest history there is, so
    // it can never be swept up by an undo of a round it was not part of.
    const round = intAtLeast(r, 1) ?? 1;
    reviewed.set(id, round);
    if (round > top) top = round;
  }

  // MAX_REVIEWED, oldest rounds first. Sorted by round so a partial drop can
  // never leave half of one round behind — undo would then be a half-truth.
  if (reviewed.size > MAX_REVIEWED) {
    const byRound = [...reviewed.entries()].sort((a, b) => a[1] - b[1] || String(a[0]).localeCompare(String(b[0])));
    for (let i = 0; i < byRound.length - MAX_REVIEWED; i++) reviewed.delete(byRound[i][0]);
  }

  // `round` is ALWAYS the highest stamp still held — DERIVED, and `src.round`
  // is deliberately never read. A stored counter that ran ahead of the map,
  // because every row it named was requeued one at a time, would leave the undo
  // button pointing at an empty round and doing nothing when pressed. It is
  // still WRITTEN by serializeQueue, so the stored object reads sensibly on its
  // own; it is simply not trusted on the way back in.
  return { reviewed, round: top, at: intAtLeast(src.at, 1) ?? 0 };
}

export const isReviewed = (state, id) =>
  state?.reviewed instanceof Map ? state.reviewed.has(id) : false;

export const roundOf = (state, id) =>
  state?.reviewed instanceof Map ? state.reviewed.get(id) ?? null : null;

export const reviewedCount = (state) =>
  state?.reviewed instanceof Map ? state.reviewed.size : 0;

/** The ids stamped with the current round — exactly what `undoLastRound` takes back. */
export function lastRoundIds(state) {
  const cur = normalizeQueue(state);
  if (!cur.round) return [];
  return [...cur.reviewed.entries()].filter(([, r]) => r === cur.round).map(([id]) => id);
}

/**
 * Open a new round over `ids`.
 *
 * `ids` is what was ON SCREEN when the button was pressed, passed in by the
 * caller rather than recomputed here. The queue is a live view — a refresh
 * mid-round can change which ten the ranker offers — so the only defensible
 * thing to mark is the ten the operator actually looked at.
 *
 * An empty or all-junk list returns the state untouched. Opening a round that
 * marks nothing would leave an undo button that undoes nothing.
 */
export function markReviewed(state, ids, { now = Date.now() } = {}) {
  const cur = normalizeQueue(state);
  const fresh = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id))];
  if (!fresh.length) return cur;

  const round = cur.round + 1;
  const reviewed = new Map(cur.reviewed);
  // Re-stamping an already-reviewed id is deliberate: it was requeued, looked
  // at again, and belongs to THIS round now, so undoing this round returns it.
  for (const id of fresh) reviewed.set(id, round);
  return normalizeQueue({ reviewed, round, at: intAtLeast(now, 1) ?? cur.at });
}

/**
 * Take back the whole of the most recent round.
 *
 * `at` goes to 0 rather than to the previous round's clock, because we do not
 * keep a timestamp per round and there is nothing true to put there. The screen
 * then drops the "arrived since your last round" line instead of printing a
 * number measured against a round that no longer exists.
 */
export function undoLastRound(state) {
  const cur = normalizeQueue(state);
  if (!cur.round) return cur;
  const reviewed = new Map();
  for (const [id, r] of cur.reviewed) if (r < cur.round) reviewed.set(id, r);
  return normalizeQueue({ reviewed, at: 0 });
}

/** Unmark one repo. It rejoins the pool and gets ranked with everything else. */
export function requeue(state, id) {
  const cur = normalizeQueue(state);
  if (!cur.reviewed.has(id)) return cur;
  const reviewed = new Map(cur.reviewed);
  reviewed.delete(id);
  return normalizeQueue({ reviewed, at: cur.at });
}

/** Every round back. Offered where the history is shown, never on the queue. */
export const clearReviewed = () => emptyQueue();

/**
 * Split an already-ranked, already-filtered list into what to show now, what is
 * still waiting, and what has been seen.
 *
 * Pure and clock-free: the ORDER is the caller's (whatever sort is selected),
 * and this only cuts it. That is what makes "filtering re-ranks inside the
 * queue" a property of the caller's sort rather than a second ranking here.
 */
export function splitQueue(list, state, size = BATCH) {
  const rows = Array.isArray(list) ? list : [];
  const n = intAtLeast(size, 0) ?? BATCH;
  const pool = [];
  const done = [];
  for (const r of rows) (isReviewed(state, r?.id) ? done : pool).push(r);
  const queue = pool.slice(0, n);
  return { queue, pool, done, waiting: pool.length - queue.length, total: rows.length };
}

/**
 * Reviewed rows, most recent round first, ties broken by the caller's order.
 * Index-keyed rather than sorted in place so the tiebreak is the incoming rank
 * and the result is a total order — the same rule the feed's sorts follow.
 */
export function sortReviewed(list, state) {
  const rows = Array.isArray(list) ? list : [];
  const at = new Map(rows.map((r, i) => [r, i]));
  return [...rows].sort((a, b) => (roundOf(state, b?.id) ?? 0) - (roundOf(state, a?.id) ?? 0) || at.get(a) - at.get(b));
}

/** How many rows in `list` the scanner first saw after the last round opened. */
export function arrivedSince(list, state) {
  const cur = normalizeQueue(state);
  if (!cur.at) return null; // no round has been opened, so there is no "since"
  let n = 0;
  for (const r of Array.isArray(list) ? list : []) {
    const t = new Date(r?.first_seen).getTime();
    if (Number.isFinite(t) && t > cur.at) n++;
  }
  return n;
}

/* ── storage ─────────────────────────────────────────────────────────────── */

export function serializeQueue(state) {
  const cur = normalizeQueue(state);
  const reviewed = {};
  for (const [id, r] of cur.reviewed) reviewed[id] = r;
  return { v: 1, round: cur.round, at: cur.at, reviewed };
}

export function loadQueue() {
  try {
    return normalizeQueue(JSON.parse(localStorage.getItem(QUEUE_KEY)));
  } catch {
    return emptyQueue();
  }
}

export function saveQueue(state) {
  const next = normalizeQueue(state);
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(serializeQueue(next))); } catch { /* private mode; the session still works */ }
  return next;
}
