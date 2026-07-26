// netlify/functions/send-email.js
// Sends email via Gmail API using OAuth2
// Requires GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN env vars

const { requireAuth } = require("./_shared/requireAuth.cjs");
// The send itself lives in _shared/gmail.cjs so this handler and the Desk's
// approve path cannot drift apart on headers, threading, or encoding.
const { sendEmail } = require("./_shared/gmail.cjs");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  // This sends real email as Cameron — require a signed-in caller.
  const auth = await requireAuth(event);
  if (!auth.ok) return { statusCode: auth.status, body: JSON.stringify({ error: auth.error }) };

  const { to, subject, body, replyToMessageId, threadId } = JSON.parse(event.body);

  if (!to || !subject || !body) {
    return { statusCode: 400, body: "Missing required fields: to, subject, body" };
  }

  try {
    const { messageId, threadId: sentThreadId, rfcMessageId } = await sendEmail({
      to, subject, body, replyToMessageId, threadId,
    });
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, messageId, threadId: sentThreadId, rfcMessageId }),
    };
  } catch (err) {
    console.error("Send email error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
