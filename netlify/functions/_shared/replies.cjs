// ═══════════════════════════════════════════════════════════════════════════
// REPLIES — poll Gmail threads for inbound replies.
//
// Extracted from check-replies.js so a SCHEDULE can run it. The handler it came
// from calls requireAuth, which means reply detection only ever happened when
// the operator clicked a button — so the warmest signal this business produces,
// a human answering a cold email, was invisible until someone went looking for
// it. One email has been sent, 27 days ago. Nobody has looked since.
//
// CJS because the caller set includes a CommonJS handler that cannot `require`
// an ES module, while the .mjs scheduled function can import CommonJS through
// esbuild. Same reasoning as _shared/gmail.cjs.
//
// THREE DEFECTS FROM THE ORIGINAL ARE FIXED HERE, not carried over:
//
//   1. `catch {}` around each thread swallowed every failure. A revoked token
//      or a 429 looked exactly like "no replies" — the single most dangerous
//      false negative available, because it reports good news while blind.
//      Errors are now collected and returned.
//   2. Only top-level `payload.parts` was searched for the text body. Gmail
//      nests multipart/alternative inside multipart/mixed whenever there is an
//      attachment or a rich-text client on the other end, so real replies
//      arrived with an empty body. The walk is now recursive.
//   3. The sender address was hardcoded, so a reply from our own address was
//      only filtered for one specific mailbox. It now comes from the same
//      constant the send path uses.
// ═══════════════════════════════════════════════════════════════════════════
const { FROM } = require("./gmail.cjs");

/** The bare address out of a `Name <addr@host>` header. */
function bareAddress(header) {
  const m = /<([^>]+)>/.exec(header || "");
  return (m ? m[1] : header || "").trim().toLowerCase();
}

const OUR_ADDRESS = bareAddress(FROM);

async function accessToken() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  const missing = [
    !GMAIL_CLIENT_ID && "GMAIL_CLIENT_ID",
    !GMAIL_CLIENT_SECRET && "GMAIL_CLIENT_SECRET",
    !GMAIL_REFRESH_TOKEN && "GMAIL_REFRESH_TOKEN",
  ].filter(Boolean);
  if (missing.length) throw new Error(`GMAIL_ENV_MISSING: ${missing.join(", ")}`);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`GMAIL_TOKEN_FAILED: ${JSON.stringify(data).slice(0, 200)}`);
  return data.access_token;
}

/**
 * Depth-first search for a readable body.
 *
 * Prefers text/plain anywhere in the tree. Falls back to text/html with tags
 * stripped, because a reply that only exists as HTML is still a reply and
 * returning "" for it loses the customer, not just the formatting.
 */
function extractBody(payload) {
  if (!payload) return "";
  const decode = (d) => Buffer.from(String(d).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");

  const walk = (node, mime) => {
    if (!node) return "";
    if (node.mimeType === mime && node.body?.data) return decode(node.body.data);
    for (const child of node.parts || []) {
      const found = walk(child, mime);
      if (found) return found;
    }
    return "";
  };

  const plain = walk(payload, "text/plain");
  if (plain) return plain;

  const html = walk(payload, "text/html");
  if (html) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }
  return "";
}

/**
 * Poll the given Gmail thread ids for a reply from anyone but us.
 *
 * @returns {Promise<{replies: Array, errors: Array<{threadId: string, error: string}>, checked: number}>}
 *
 * Errors are RETURNED rather than thrown or swallowed: one dead thread must not
 * abort the sweep, and it must not silently look like "no reply".
 */
async function pollReplies(sentThreadIds, { token, limit = 100 } = {}) {
  const ids = (sentThreadIds || []).filter(Boolean).slice(0, limit);
  if (!ids.length) return { replies: [], errors: [], checked: 0 };

  const access = token || (await accessToken());
  const replies = [];
  const errors = [];

  for (const threadId of ids) {
    try {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
        { headers: { Authorization: `Bearer ${access}` } },
      );
      if (!res.ok) {
        // 404 means the thread is gone (deleted). Not an error worth alarming
        // on, but recorded so a sweep of all-404s does not read as "all clear".
        errors.push({ threadId, error: `HTTP ${res.status}` });
        continue;
      }
      const thread = await res.json();
      const messages = thread.messages || [];
      if (messages.length < 2) continue;

      const latest = messages[messages.length - 1];
      const headers = latest.payload?.headers || [];
      const get = (n) => headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value || "";
      const from = get("From");

      if (bareAddress(from) === OUR_ADDRESS) continue; // our own follow-up

      replies.push({
        threadId,
        messageId: latest.id,
        rfcMessageId: get("Message-ID") || null,
        from,
        fromAddress: bareAddress(from),
        subject: get("Subject"),
        date: get("Date"),
        body: extractBody(latest.payload).slice(0, 4000),
        snippet: thread.snippet || latest.snippet || "",
      });
    } catch (ex) {
      errors.push({ threadId, error: ex.message });
    }
  }

  return { replies, errors, checked: ids.length };
}

module.exports = { pollReplies, accessToken, extractBody, bareAddress, OUR_ADDRESS };
