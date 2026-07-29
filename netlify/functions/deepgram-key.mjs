// ─── Short-lived Deepgram credential ─────────────────────────────────────────
// SYNC's microphone talks to Deepgram over a WebSocket, and a WebSocket cannot
// be proxied through a Netlify function — so unlike the Anthropic route, the
// browser really does have to hold a credential. This mints one that is worth
// almost nothing if it leaks.
//
// WHY /auth/grant AND NOT A MINTED API KEY. The first version of this called
// POST /v1/projects/{id}/keys to create a real, if short-lived, API key. That
// failed in production with 403 INSUFFICIENT_PERMISSIONS: creating a key needs
// the `keys:write` scope, and the operator's key — correctly — does not have
// it. The fix is not to hand the key more power. Deepgram built /v1/auth/grant
// for exactly this shape of problem: it returns a JWT carrying usage:write for
// the voice APIs only, and the calling key needs merely Member. Three things
// get better at once:
//
//   • the credential behind this endpoint no longer needs the authority to
//     create permanent API keys, which is the scariest scope on the account
//   • programmatic key creation is capped at 250/day, so the old design had a
//     hard ceiling of ~250 voice sessions per day waiting to be discovered
//   • minted keys are never garbage-collected — the old design quietly filled
//     the account's key list with dead entries that only `keys:write` could
//     remove
//
// The file keeps its name so the client's URL does not move. What it returns
// is a token, not a key.
//
// Same auth pattern and same inlining rationale as claude-stream.mjs — see the
// comment there. If it changes in one, change it in the other.
const SUPABASE_URL = "https://nrzpinvyxxorxufadvyc.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_zDV3HpSChf0bZJ5nY09s3w_rNI3sZ1m";

const GRANT_URL = "https://api.deepgram.com/v1/auth/grant";

// Deepgram checks the credential once, at the WebSocket handshake, and then
// leaves the connection alone — an open stream survives its token's expiry by
// design. So this number does not have to cover a long dictation; it only has
// to cover the hop from here to the phone and the upgrade request. Sixty
// seconds is generous for that on a bad mobile connection while leaving a
// scraped token useless within the minute. (Deepgram's own default is 30. The
// extra is slack for clock skew, which is unforgiving at that TTL.)
const TTL_SECONDS = 60;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const fail = (status, message) => json(status, { error: { message } });

async function checkSession(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, status: 401, error: "Sign in required — no session token on this request." };

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, status: 401, error: "Session expired or invalid — sign in again." };
    const user = await res.json();

    const allowed = process.env.ALLOWED_EMAIL;
    if (allowed && String(user?.email || "").toLowerCase() !== String(allowed).toLowerCase()) {
      return { ok: false, status: 403, error: "This account is not the allow-listed operator." };
    }
    return { ok: true, email: user?.email || "unknown" };
  } catch {
    return { ok: false, status: 401, error: "Couldn't verify session — try again." };
  }
}

/**
 * Turn Deepgram's error payload into a sentence someone can act on.
 *
 * Worth the effort because the previous version pasted the raw JSON into the
 * UI, and what the operator actually saw on their phone was an unterminated
 * blob of `{"category":"INSUFFICIENT_PERMISSIONS","message":...` — which names
 * the problem without saying what to do about it, in a box too small to finish
 * the sentence.
 */
function explainGrantFailure(status, body) {
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* not JSON; fall through to the raw tail */ }
  const category = parsed?.err_code || parsed?.category || "";

  if (status === 401) {
    return "Deepgram rejected the account key. Check that DEEPGRAM_API_KEY is a current key for the right project — a deleted or mistyped key lands here.";
  }
  if (status === 403 || /PERMISSION/i.test(category)) {
    return "That Deepgram key doesn't have permission to issue voice tokens. It needs the Member role (or higher). In the Deepgram console: API Keys → Create a New API Key → role Member, then set it as DEEPGRAM_API_KEY and redeploy.";
  }
  if (status === 404) {
    return "Deepgram doesn't recognise the token endpoint for this account. That usually means the account predates token-based auth — contact Deepgram support, or fall back to a Member-role key.";
  }
  const detail = (parsed?.message || body || "").toString().trim().slice(0, 160);
  return `Deepgram wouldn't issue a voice token (${status}).${detail ? ` ${detail}` : ""}`;
}

export default async (req) => {
  if (req.method !== "POST") return fail(405, "POST only.");

  const auth = await checkSession(req);
  if (!auth.ok) return fail(auth.status, auth.error);

  // 503, not 500 — an unset variable is a configuration fact the operator can
  // fix in one place, not a bug to hunt for in the logs. Netlify resolves
  // function environment at deploy time, so "set it" genuinely does mean "and
  // redeploy"; saying so here saves the round trip.
  const parent = process.env.DEEPGRAM_API_KEY;
  if (!parent) {
    return fail(503, "This deployment has no DEEPGRAM_API_KEY configured, so voice input can't start. Set it in the site's environment variables and redeploy — a variable added after the last build stays invisible to this function until one runs.");
  }

  try {
    const res = await fetch(GRANT_URL, {
      method: "POST",
      // `Token` for the account key, `Bearer` for the JWT it hands back. The
      // two schemes are not interchangeable and mixing them up is the most
      // common way to get a 401 out of this endpoint.
      headers: { Authorization: `Token ${parent}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl_seconds: TTL_SECONDS }),
    });

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      // 502: the failure is upstream, not in this request. Keeping Deepgram's
      // status out of our own means a 403 from them can't be misread as this
      // endpoint rejecting the user's session.
      return fail(502, explainGrantFailure(res.status, raw));
    }

    const body = await res.json();
    if (!body?.access_token) return fail(502, "Deepgram returned no token.");

    // expires_in is optional in Deepgram's schema — only access_token is
    // required — so fall back to what we asked for rather than shipping
    // undefined to the client.
    return json(200, { token: body.access_token, expiresIn: body.expires_in ?? TTL_SECONDS });
  } catch (e) {
    return fail(502, e?.message || "Couldn't reach Deepgram.");
  }
};
