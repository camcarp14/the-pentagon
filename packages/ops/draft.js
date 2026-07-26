// ═══════════════════════════════════════════════════════════════════════════
// @cc/ops/draft — NORMALISE A DRAFT BEFORE IT IS SHOWN OR SENT.
//
// Some drafts in this database do not contain an email body. They contain the
// model's entire JSON response as a string:
//
//   draft_body  = '{"subject": "Loop PT + Google Ads — missed appointments…",
//                   "body": "Chicagoans search \\"physical therapy near me\\"…"}'
//   draft_subject = 'Quick question about your Google Ads'   ← generic fallback
//
// Two of the three drafts on this store are in that state, and ONE OF THEM WAS
// SENT. A real prospect received a JSON blob. Clarify's UI has always hidden
// this at render time via lib/email.js — which is why it was never noticed and
// never fixed.
//
// WHY THIS LIVES HERE AND NOT IN THE CLARIFY APP. A display-time cleaner only
// protects the screen. The moment a second caller sends the same column —
// which queue-execute now does — the raw blob goes out over SMTP. This is the
// version the SEND path uses, so the guarantee is "what leaves the building is
// clean", not "what you happened to be looking at was clean".
//
// It is deliberately tolerant. A malformed draft must degrade to the best
// readable text available, never to an empty string: an empty body would be
// sent as a blank email, which is worse than a messy one.
//
// Pure: no fetch, no Date.now(), no database.
// ═══════════════════════════════════════════════════════════════════════════

const isWrapped = (s) => typeof s === "string" && s.trim().startsWith("{");

/**
 * Pull one string field out of a JSON-ish blob.
 *
 * Tries a real parse first. Falls back to a bounded scan, because the failure
 * that produced these rows also produces UNESCAPED inner quotes — the model
 * writing `"body": "they search "physical therapy near me" a lot"` — which is
 * not valid JSON and never will be. JSON.parse alone recovers nothing there.
 */
function extract(raw, key) {
  if (!isWrapped(raw)) return null;

  try {
    const parsed = JSON.parse(raw);
    const v = parsed && parsed[key];
    if (typeof v === "string" && v.trim()) return v;
  } catch {
    // fall through to the scan
  }

  const marker = `"${key}"`;
  const at = raw.indexOf(marker);
  if (at === -1) return null;

  // Step past `"key"` , optional whitespace, `:`, optional whitespace, opening quote.
  const after = raw.slice(at + marker.length).replace(/^\s*:\s*"/, "");
  if (after === raw.slice(at + marker.length)) return null; // no opening quote — not this shape

  // Take everything up to the last quote that closes the object, rather than
  // the first quote found: the first one is usually an unescaped quote INSIDE
  // the value, and cutting there truncates the email mid-sentence.
  const closed = after.replace(/"\s*[,}][\s\S]*$/, "").replace(/"\s*$/, "");
  const value = closed.trim();
  return value ? value : null;
}

/** `\n` written literally into the column, from a JSON string that was stored
 *  rather than parsed. Real newlines are left alone. */
const unescape = (s) => s.replace(/\\r\\n|\\n/g, "\n").replace(/\\"/g, '"').replace(/\\t/g, "  ");

/**
 * The body that should actually be sent.
 * Falls back to the raw text rather than to nothing.
 */
export function cleanBody(text) {
  if (typeof text !== "string" || !text.trim()) return "";
  const inner = extract(text, "body");
  return unescape(inner != null ? inner : text).trim();
}

/**
 * The subject that should actually be sent.
 *
 * `preferred` is the row's own draft_subject and wins when it is real. It is
 * ignored when it is one of the generic placeholders the broken path wrote for
 * every prospect — a subject line identical across an entire send is a
 * deliverability problem on its own.
 */
const GENERIC_SUBJECTS = new Set([
  "quick question about your google ads",
  "quick question",
  "",
]);

export function cleanSubject(text, preferred = null) {
  const embedded = typeof text === "string" ? extract(text, "subject") : null;
  const own = typeof preferred === "string" ? preferred.trim() : "";

  if (own && !GENERIC_SUBJECTS.has(own.toLowerCase()) ) return unescape(own).trim();
  if (embedded) return unescape(embedded).trim();
  if (own) return unescape(own).trim();

  if (typeof text === "string" && !isWrapped(text)) return unescape(text).trim();
  return "";
}

/**
 * Is this row one of the broken ones?
 *
 * Surfaced in the UI so the operator can see that a draft was repaired rather
 * than silently receiving different text than the engine wrote.
 */
export function isMalformed(text) {
  return isWrapped(text) && extract(text, "body") !== null;
}

/**
 * Everything the send path and the queue need, in one call.
 * `repaired` is true when the stored row needed rescuing.
 */
export function normalizeDraft({ subject, body } = {}) {
  const repaired = isMalformed(body);
  return {
    subject: cleanSubject(body, subject),
    body: cleanBody(body),
    repaired,
  };
}
