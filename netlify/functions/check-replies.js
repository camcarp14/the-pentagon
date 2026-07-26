// netlify/functions/check-replies.js
// Manual "Check Replies" button in the Clarify toolbar.
//
// The polling itself now lives in _shared/replies.cjs so the SCHEDULED sweep
// (replies-cron.mjs) runs the identical logic. This handler stays because the
// operator sometimes wants to check right now rather than wait for the next
// pass — but it is no longer the only way a reply is ever noticed, which it was
// for the entire life of this system.

const { requireAuth } = require("./_shared/requireAuth.cjs");
const { pollReplies } = require("./_shared/replies.cjs");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const auth = await requireAuth(event);
  if (!auth.ok) return { statusCode: auth.status, body: JSON.stringify({ error: auth.error }) };

  let sentThreadIds;
  try {
    ({ sentThreadIds } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }
  if (!sentThreadIds || sentThreadIds.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ replies: [] }) };
  }

  try {
    const { replies, errors, checked } = await pollReplies(sentThreadIds);

    // Errors used to be swallowed per-thread, so a revoked token rendered as
    // "no replies" — good news, while blind. They are surfaced now; the shape
    // stays backward-compatible for the existing caller in lib/email.js, which
    // reads only `replies`.
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replies, errors, checked }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
