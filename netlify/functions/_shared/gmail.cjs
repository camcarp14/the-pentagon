// ═══════════════════════════════════════════════════════════════════════════
// GMAIL — one implementation of "send a real email as Cameron".
//
// This was inline in send-email.js. It is extracted here because queue-execute
// now needs the same behaviour, and two copies of an email sender is exactly
// the kind of duplication that drifts until one of them quietly stops setting
// a threading header and replies start arriving as new conversations.
//
// CJS ON PURPOSE. send-email.js is CommonJS and cannot `require` an ES module,
// while the .mjs engines CAN import CommonJS through esbuild — verified with a
// bundle-and-run probe before this file was written, not assumed. CJS is
// therefore the only format both callers can share.
//
// Named throws, no silent nulls: a send that fails must be distinguishable from
// a send that succeeded, because the caller marks a database row as `sent` on
// the strength of the answer.
// ═══════════════════════════════════════════════════════════════════════════

const FROM = "Cameron | Clarify Paid Search <clarifypaidsearch@gmail.com>";

/** Exchange the long-lived refresh token for an access token. */
async function accessToken() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  const missing = [
    !GMAIL_CLIENT_ID && "GMAIL_CLIENT_ID",
    !GMAIL_CLIENT_SECRET && "GMAIL_CLIENT_SECRET",
    !GMAIL_REFRESH_TOKEN && "GMAIL_REFRESH_TOKEN",
  ].filter(Boolean);
  // These three had no missing-var guard anywhere before this: an unset value
  // surfaced as an opaque token-exchange failure at send time.
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
  if (!data.access_token) {
    throw new Error(`GMAIL_TOKEN_FAILED: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.access_token;
}

/**
 * Send one plain-text email.
 * @returns {Promise<{messageId: string, threadId: string, rfcMessageId: string|null}>}
 */
async function sendEmail({ to, subject, body, replyToMessageId, threadId }) {
  if (!to || !subject || !body) {
    throw new Error("GMAIL_MISSING_FIELDS: to, subject and body are all required");
  }
  // Header values go into a \r\n-joined RFC822 block, so a CR or LF inside one
  // does not escape a string — it starts a new header, or ends the header block
  // and rewrites the body. `to` comes from third-party prospecting data, not
  // from a validator, so it is checked here where the message is actually built
  // rather than trusted from each call site.
  if (/[\r\n]/.test(String(to)) || /[\r\n]/.test(String(replyToMessageId || ""))) {
    throw new Error("GMAIL_HEADER_INJECTION: newline in a header value");
  }
  const token = await accessToken();

  // Subject is base64'd because a non-ASCII character in a raw header is
  // silently mangled by some clients rather than rejected.
  const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`;
  const lines = [
    `From: ${FROM}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ];
  if (replyToMessageId) {
    lines.splice(3, 0, `In-Reply-To: ${replyToMessageId}`, `References: ${replyToMessageId}`);
  }

  const raw = Buffer.from(lines.join("\r\n")).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const payload = { raw };
  if (threadId) payload.threadId = threadId;

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GMAIL_SEND_FAILED: ${JSON.stringify(data).slice(0, 300)}`);

  // The RFC Message-ID is what a later reply must quote in In-Reply-To to land
  // in the same thread. Best-effort: failing to read it back is not a reason to
  // report the send itself as failed, since the message has already gone.
  let rfcMessageId = null;
  try {
    const metaRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${data.id}?format=metadata&metadataHeaders=Message-ID`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const meta = await metaRes.json();
    rfcMessageId = meta.payload?.headers?.find((h) => h.name === "Message-ID")?.value || null;
  } catch { /* non-fatal, see above */ }

  return { messageId: data.id, threadId: data.threadId, rfcMessageId };
}

module.exports = { sendEmail, FROM };
