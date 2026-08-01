// ═══════════════════════════════════════════════════════════════════════════
// WHEN THE NEXT SCAN IS DUE — measured off the scans that already ran.
//
// A review queue has an answer it owes the operator that a feed never did: you
// have reached the end, so WHEN IS THERE MORE. "Four times a day" is written in
// the scanner's repo and in a comment at the top of Root.jsx, and neither of
// those is data — the schedule can change, a run can fail, and a sentence on
// screen that says "in 6 hours" because a comment said so is exactly the shape
// this repo has already been burned by.
//
// So the interval is MEASURED: read the last N rows of ideafeed_runs, take the
// gaps between consecutive ran_at values, and use the median. Median rather
// than mean because one failed cron leaves a double-length gap that drags an
// average by hours while leaving a median untouched.
//
// Every refusal names what was missing. With one run on record there is no
// interval; with none there is nothing at all; if every recorded run shares a
// timestamp the gaps are zero and there is still nothing to say. None of those
// degrade to "about 6 hours" — they degrade to a sentence saying which input
// was absent, and the caller prints it unchanged.
//
// Pure: `now` is passed in and only defaults to the clock at the outermost call.
// ═══════════════════════════════════════════════════════════════════════════

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

/* The two conversions below are the ones rank.js's header warns about, and both
 * of them shipped broken in the first draft of this file — caught by the tests
 * named for them, which is the only reason they are not in the built artifact.
 *
 *   Number(null) is 0 and passes Number.isFinite, so fmtSpan(null) printed
 *     "1m" — a duration, out of no input at all.
 *   new Date(null).getTime() is 0, i.e. 1 Jan 1970, so a runs row with a null
 *     ran_at became a real timestamp 56 years in the past. It survived the
 *     isFinite filter, made the list length 1, and turned "no usable scan
 *     timestamps" into "only one scan is on record" — a different, wrong reason.
 *
 * Both are rejected BEFORE the conversion, never after. */
const strictNum = (v) => {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const stamp = (ts) => {
  if (!ts || typeof ts !== "string") return null;
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : null;
};

/** A duration in the largest unit that keeps it readable, never rounded to 0. */
export function fmtSpan(ms) {
  const n = strictNum(ms);
  if (n === null) return "—";
  const v = Math.abs(n);
  if (v < HOUR) return `${Math.max(1, Math.round(v / MIN))}m`;
  if (v < DAY) {
    const h = v / HOUR;
    return `${h < 10 ? Math.round(h * 10) / 10 : Math.round(h)}h`;
  }
  const d = v / DAY;
  return `${d < 10 ? Math.round(d * 10) / 10 : Math.round(d)}d`;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * @param {{ran_at:string}[]} runs  ideafeed_runs rows, any order
 * @param {number} [now]            ms epoch
 * @returns {{
 *   ok: boolean, everyMs: number|null, nextAt: number|null, samples: number,
 *   text: string,
 * }}  `text` is a full sentence either way — a cadence or the reason there is none.
 */
export function scanCadence(runs, now = Date.now()) {
  const t = (Array.isArray(runs) ? runs : [])
    .map((r) => stamp(r?.ran_at))
    .filter((n) => n !== null)
    .sort((a, b) => b - a);

  const none = (text) => ({ ok: false, everyMs: null, nextAt: null, samples: 0, text });

  if (!t.length) return none("No scan is on record, so there is nothing to time the next one from.");
  if (t.length < 2) return none("Only one scan is on record, so there is no interval to work out when the next one lands.");

  const gaps = [];
  for (let i = 0; i < t.length - 1; i++) gaps.push(t[i] - t[i + 1]);
  const everyMs = median(gaps);
  if (!(everyMs > 0)) {
    return { ...none(`The ${t.length} recorded scans share a timestamp, so there is no interval between them.`), samples: gaps.length };
  }

  const nextAt = t[0] + everyMs;
  const due = nextAt - now;
  const when = due > 0
    ? `the next is due in about ${fmtSpan(due)}`
    : `the next is about ${fmtSpan(-due)} overdue`;
  return {
    ok: true,
    everyMs,
    nextAt,
    samples: gaps.length,
    text: `Scans land about every ${fmtSpan(everyMs)} — the median of the last ${gaps.length} gap${gaps.length === 1 ? "" : "s"} — so ${when}.`,
  };
}
