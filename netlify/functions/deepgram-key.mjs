// ─── Short-lived Deepgram key ────────────────────────────────────────────────
// SYNC's microphone talks to Deepgram over a WebSocket, and a WebSocket cannot
// be proxied through a Netlify function — so unlike the Anthropic route, the
// browser really does have to hold a credential. The answer is not to ship the
// account key: this mints a fresh key that lives for two minutes and can only
// spend usage, so the worst a leaked one buys is a couple of minutes of
// transcription on an already-authenticated session.
//
// Same auth pattern and same inlining rationale as claude-stream.mjs — see the
// comment there. If it changes in one, change it in the other.
const SUPABASE_URL = "https://nrzpinvyxxorxufadvyc.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_zDV3HpSChf0bZJ5nY09s3w_rNI3sZ1m";

const DEEPGRAM = "https://api.deepgram.com/v1";

// Two minutes: long enough to open the socket and start a conversation, short
// enough that a key scraped out of a tab is worthless by the time it is used.
// Deepgram keeps an open connection alive past its key's expiry, so this does
// not cut off a long dictation — it only bounds new connections.
const TTL_SECONDS = 120;

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

/** The project the parent key belongs to. Cached for the life of the container. */
let cachedProjectId = process.env.DEEPGRAM_PROJECT_ID || null;

async function projectId(key) {
  if (cachedProjectId) return cachedProjectId;
  const res = await fetch(`${DEEPGRAM}/projects`, { headers: { Authorization: `Token ${key}` } });
  if (!res.ok) throw new Error(`Deepgram rejected the account key (${res.status}).`);
  const body = await res.json();
  const id = body?.projects?.[0]?.project_id;
  if (!id) throw new Error("That Deepgram key has no projects on it.");
  cachedProjectId = id;
  return id;
}

export default async (req) => {
  if (req.method !== "POST") return fail(405, "POST only.");

  const auth = await checkSession(req);
  if (!auth.ok) return fail(auth.status, auth.error);

  // 503, not 500 — an unset variable is a configuration fact the operator can
  // fix in one place, not a bug to hunt for in the logs.
  const parent = process.env.DEEPGRAM_API_KEY;
  if (!parent) {
    return fail(503, "This deployment has no DEEPGRAM_API_KEY configured, so voice input can't start. Set it in the site's environment variables and redeploy.");
  }

  try {
    const project = await projectId(parent);
    const res = await fetch(`${DEEPGRAM}/projects/${project}/keys`, {
      method: "POST",
      headers: { Authorization: `Token ${parent}`, "content-type": "application/json" },
      body: JSON.stringify({
        comment: `SYNC voice · ${auth.email}`,
        // usage:write is the narrowest scope that can open a listen socket. It
        // cannot read transcripts, mint further keys, or see billing.
        scopes: ["usage:write"],
        time_to_live_in_seconds: TTL_SECONDS,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return fail(502, `Deepgram wouldn't issue a key (${res.status}). ${detail.slice(0, 200)}`);
    }

    const body = await res.json();
    if (!body?.key) return fail(502, "Deepgram returned no key.");

    return json(200, { key: body.key, expiresIn: TTL_SECONDS });
  } catch (e) {
    return fail(502, e?.message || "Couldn't reach Deepgram.");
  }
};
