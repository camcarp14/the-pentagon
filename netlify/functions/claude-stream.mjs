// ─── Streaming Anthropic proxy ───────────────────────────────────────────────
// SYNC used to reach api.anthropic.com from the browser with a key out of
// localStorage. That key is readable by anything running on the page, so this
// route exists to take it off the client entirely: the browser sends its
// Pentagon session, the server holds ANTHROPIC_API_KEY, and nothing secret ever
// lands in a tab.
//
// This is a SECOND function, not a change to claude.js. claude.js is a
// Functions v1 handler that buffers the whole reply through res.json(), and
// eight call sites depend on that JSON contract. Streaming needs a Response
// object, which is a v2-only shape — so the two live side by side and the
// non-streaming callers keep the endpoint they already have.
//
// Netlify routes a function at /.netlify/functions/<filename> by default, so
// there is deliberately no `export const config = { path: ... }` here: a custom
// path under the reserved /.netlify/ prefix is rejected at deploy time.
//
// Same-origin only (SYNC ships from this same site), so no CORS preamble.

// The house auth pattern, inlined. netlify/shared/util.mjs already exports a
// checkAuth(req) with exactly this Request-shaped signature, but that module
// imports @netlify/blobs at module scope — importing it here would pull the
// Blobs client into this function's bundle for nothing, on the one route where
// cold-start latency is felt as a pause before the first spoken word. The
// sibling _shared/requireAuth.cjs is the other copy; it takes a v1 `event`
// with plain-object headers, which a v2 Request is not. Fifteen lines duplicated
// beats either. Behaviour is identical to both — if it changes there, change it
// here.
//
// These two values are public by design: they are the same URL + publishable key
// already baked into the client bundle. Verifying against them proves the caller
// holds a session on this Supabase project; it costs no new secret.
const SUPABASE_URL = "https://nrzpinvyxxorxufadvyc.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_zDV3HpSChf0bZJ5nY09s3w_rNI3sZ1m";

// Two vendors, one endpoint. The name still says `claude-stream` because eight
// call sites and a test assert that path, and the wire format the client parses
// is Anthropic's either way — see lib/openai.mjs for why the translation lives
// on the server rather than as a second client in the browser. Adding a route
// would have split the model picker into "which button do I press" instead of
// "which model do I want".
import { isOpenAIModel, toOpenAIRequest, toAnthropicStream } from "./lib/openai.mjs";

// Pin the model list on the server too. A proxy that forwards whatever it is
// handed is a proxy that bills you for whatever it is handed — and unlike the
// client's copy of this list, this one can't be edited from devtools.
const ALLOWED_MODELS = new Set([
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "claude-opus-5",
]);

const isAllowed = (model) => ALLOWED_MODELS.has(model) || isOpenAIModel(model);

// Anthropic's own error envelope. Using the same shape for our own failures
// means the client parses one thing, not two.
const json = (status, message, extra = {}) =>
  new Response(JSON.stringify({ type: "error", error: { message, ...extra } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// AUTHENTICATED IS NOT AUTHORISED. A valid token proves the caller signed in on
// this project, not that they are the operator, and this route spends the
// Anthropic budget. ALLOWED_EMAIL is enforced only when set, matching every
// other function here: an unconfigured deploy keeps working rather than locking
// its own operator out.
async function checkSession(req) {
  const header = req.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, status: 401, error: "Sign in required — no session token on this request." };

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, status: 401, error: "Session expired or invalid — sign in again." };
    const user = await res.json();

    const allowed = process.env.ALLOWED_EMAIL;
    if (allowed && String(user?.email || "").toLowerCase() !== String(allowed).toLowerCase()) {
      // 403, not 401: the session is fine, the account is not the operator's.
      // Re-signing in would not change the answer, so do not invite it.
      return { ok: false, status: 403, error: "This account is not the allow-listed operator." };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 401, error: "Couldn't verify session — try again." };
  }
}

export default async (req) => {
  if (req.method !== "POST") return json(405, "POST only.");

  // Open proxy otherwise — anyone with the URL could spend the Anthropic budget.
  const auth = await checkSession(req);
  if (!auth.ok) return json(auth.status, auth.error);

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, "Body was not JSON.");
  }

  if (!isAllowed(body?.model)) {
    return json(400, `Unsupported model "${body?.model}".`);
  }

  // A runaway max_tokens is the other way this gets expensive.
  if (typeof body.max_tokens !== "number" || body.max_tokens > 8000) body.max_tokens = 3000;

  // 503, not 500. "The deploy has no key" is a configuration fact the operator
  // can fix in one place; a 500 would send them hunting through logs for a bug
  // that isn't there. The client keys off this status to say so plainly. The
  // check moved below the model check on purpose: which key is even needed
  // depends on which vendor was asked for, and a deploy with only one of the
  // two keys must still work for that vendor's models.
  const gpt = isOpenAIModel(body.model);
  const key = gpt ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const name = gpt ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    const vendor = gpt ? "OpenAI" : "Claude";
    return json(503, `This deployment has no ${name} configured, so it can't reach ${vendor}. Set it in the site's environment variables and redeploy, or pick a model from the other provider.`);
  }

  // This route only streams — that is its whole reason to exist next to
  // claude.js, and labelling a buffered reply as text/event-stream below would
  // hand the client something it can't parse. Callers that want one JSON blob
  // have the other endpoint.
  body.stream = true;

  const upstreamUrl = gpt
    ? "https://api.openai.com/v1/chat/completions"
    : "https://api.anthropic.com/v1/messages";

  const upstreamHeaders = gpt
    ? { "content-type": "application/json", authorization: `Bearer ${key}` }
    : { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };

  const upstreamBody = gpt ? toOpenAIRequest(body).request : body;

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamBody),
    });
  } catch (err) {
    return json(502, `Couldn't reach ${gpt ? "OpenAI" : "Anthropic"}: ${err?.message || err}`);
  }

  // Forward Anthropic's own error body verbatim and unbuffered, so the client's
  // classification sees the real status and the real message rather than
  // something this function paraphrased.
  if (!upstream.ok) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
      },
    });
  }

  // The point of the whole file: hand back upstream.body itself. No .json(), no
  // .text(), no await on the last token — the first sentence reaches the user
  // (and the speech synth) while the model is still writing the rest. The GPT
  // path pipes through a transform rather than a buffer, so it keeps that same
  // property: translation happens chunk by chunk, not at the end.
  return new Response(gpt ? toAnthropicStream(upstream.body, body.model) : upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
};
