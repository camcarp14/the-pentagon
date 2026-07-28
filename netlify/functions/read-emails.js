// netlify/functions/read-emails.js
// Reads emails from Gmail inbox, filtered to outreach thread replies

const { requireAuth } = require("./_shared/requireAuth.cjs");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const auth = await requireAuth(event);
  if (!auth.ok) return { statusCode: auth.status, body: JSON.stringify({ error: auth.error }) };

  try {
    // Get fresh access token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GMAIL_CLIENT_ID,
        client_secret: process.env.GMAIL_CLIENT_SECRET,
        refresh_token: process.env.GMAIL_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });

    // A revoked or rotated refresh token answers 400 with an error body and no
    // access_token. Unchecked, the Gmail calls below then went out with
    // "Bearer undefined", came back 401, and `listData.messages || []` turned
    // that into an empty inbox — good news reported while completely blind.
    // _shared/replies.cjs already refuses to make that trade; so does this now.
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenData.access_token) {
      throw new Error(`GMAIL_TOKEN_FAILED: ${JSON.stringify(tokenData).slice(0, 300)}`);
    }
    const access_token = tokenData.access_token;

    // List recent messages in inbox (replies to our outreach)
    const listRes = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=in:inbox",
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const listData = await listRes.json().catch(() => ({}));
    if (!listRes.ok) {
      throw new Error(`GMAIL_LIST_FAILED: HTTP ${listRes.status} ${JSON.stringify(listData).slice(0, 300)}`);
    }
    const messages = listData.messages || [];

    // Fetch details for each message
    const details = await Promise.all(
      messages.map(async (msg) => {
        const detailRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject,From,Date,In-Reply-To`,
          { headers: { Authorization: `Bearer ${access_token}` } }
        );
        const detail = await detailRes.json();
        const headers = detail.payload?.headers || [];
        const get = (name) => headers.find((h) => h.name === name)?.value || "";

        return {
          id: msg.id,
          threadId: msg.threadId,
          subject: get("Subject"),
          from: get("From"),
          date: get("Date"),
          inReplyTo: get("In-Reply-To"),
          snippet: detail.snippet,
          unread: detail.labelIds?.includes("UNREAD"),
        };
      })
    );

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: details }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
