// netlify/functions/claude.js
// Proxy for Anthropic API calls - keeps key server-side

const { requireAuth } = require("./_shared/requireAuth.cjs");

// Pin the model list and the token ceiling on the server, exactly as the
// streaming sibling claude-stream.mjs does. A proxy that forwards whatever it
// is handed is a proxy that bills you for whatever it is handed — auth only
// proves the caller holds a session on this project, and ALLOWED_EMAIL is
// enforced only when set, so the body itself has to be constrained. The list is
// the union of every model the shipped callers ask for (ZTS, Clarify, Looper)
// plus the ids the streaming route accepts, so pinning here breaks nothing.
const ALLOWED_MODELS = new Set([
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-5",
]);
const MAX_TOKENS_CEILING = 8000;
const MAX_TOKENS_DEFAULT = 3000;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  // Open proxy otherwise — anyone with the URL could spend the Anthropic budget.
  const auth = await requireAuth(event);
  if (!auth.ok) return { statusCode: auth.status, body: JSON.stringify({ error: auth.error }) };

  try {
    const body = JSON.parse(event.body);

    if (!ALLOWED_MODELS.has(body?.model)) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: { message: `Unsupported model "${body?.model}".` } }),
      };
    }

    // A runaway max_tokens is the other way this gets expensive.
    if (typeof body.max_tokens !== "number" || body.max_tokens > MAX_TOKENS_CEILING) {
      body.max_tokens = MAX_TOKENS_DEFAULT;
    }

    // This route buffers the reply through res.json(), which cannot parse an
    // SSE body: a forwarded stream:true would 500 here after the completion had
    // already been paid for. Streaming callers have claude-stream.
    body.stream = false;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    return {
      statusCode: res.status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
