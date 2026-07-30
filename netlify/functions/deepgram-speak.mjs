// ─── Aura text-to-speech, proxied ────────────────────────────────────────────
// SYNC's replies, in a voice that doesn't sound like a 2009 satnav.
//
// WHY THIS IS A PROXY AND THE MICROPHONE IS NOT. The listen socket connects
// straight from the browser, because a WebSocket handshake is exempt from CORS.
// Deepgram's REST API is not: it sends no Access-Control-Allow-Origin, so a
// fetch to /v1/speak from a page dies in preflight before the credential is even
// looked at. That is origin-level, so no kind of token fixes it — Deepgram's own
// JS SDK says REST from a browser needs a proxy, and their own browser TTS
// example routes through one. So this function is the proxy.
//
// A consequence worth stating: because the account key never leaves the server
// here, this route needs no /v1/auth/grant token at all. The token dance exists
// only for the socket, which the browser must open itself.
//
// The other reason not to speak in the browser: window.speechSynthesis on iOS
// runs an AVSpeechSynthesizer in the UI process on its own audio session, which
// puts it outside the page's echo canceller entirely, and it has a reported
// habit of muting a live getUserMedia track. For a conversation that has to keep
// listening while it talks, that is disqualifying on both counts.
//
// Same auth pattern as claude-stream.mjs and deepgram-key.mjs.
const SUPABASE_URL = "https://nrzpinvyxxorxufadvyc.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_zDV3HpSChf0bZJ5nY09s3w_rNI3sZ1m";

const SPEAK = "https://api.deepgram.com/v1/speak";

// An allow-list, not a passthrough. `model` arrives from the client, and it
// lands in a URL we sign with the account key — so it is exactly the kind of
// parameter that must not be forwarded on trust.
const VOICES = new Set([
  "aura-2-thalia-en",
  "aura-2-andromeda-en",
  "aura-2-helena-en",
  "aura-2-apollo-en",
  "aura-2-arcas-en",
  "aura-2-aries-en",
  "aura-asteria-en",
  "aura-orion-en",
  "aura-luna-en",
  "aura-stella-en",
]);
const DEFAULT_VOICE = "aura-2-thalia-en";

// One sentence at a time is the intended usage — the caller streams a reply
// sentence by sentence so speech starts before the model has finished writing.
// The cap is here so a runaway reply cannot turn into one enormous billed
// request.
const MAX_CHARS = 1800;

const fail = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

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
    return { ok: true };
  } catch {
    return { ok: false, status: 401, error: "Couldn't verify session — try again." };
  }
}

export default async (req) => {
  if (req.method !== "POST") return fail(405, "POST only.");

  const auth = await checkSession(req);
  if (!auth.ok) return fail(auth.status, auth.error);

  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    return fail(503, "This deployment has no DEEPGRAM_API_KEY configured, so SYNC can't speak. Set it in the site's environment variables and redeploy.");
  }

  let body;
  try { body = await req.json(); } catch { return fail(400, "Expected a JSON body."); }

  const text = String(body?.text || "").trim();
  if (!text) return fail(400, "Nothing to say.");
  if (text.length > MAX_CHARS) return fail(400, `That's ${text.length} characters; the cap is ${MAX_CHARS}.`);

  const model = VOICES.has(body?.model) ? body.model : DEFAULT_VOICE;

  try {
    // mp3, not linear16. The caller plays this through an <audio> element, which
    // can start on a partial container and needs no decoding code — where raw
    // PCM would mean hand-rolling playback in Web Audio for no benefit here.
    const url = `${SPEAK}?model=${encodeURIComponent(model)}&encoding=mp3`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      if (res.status === 403 || /PERMISSION/i.test(detail)) {
        return fail(502, "That Deepgram key isn't allowed to generate speech. It needs the Member role or higher.");
      }
      return fail(502, `Deepgram wouldn't generate speech (${res.status}). ${detail.slice(0, 160)}`);
    }

    // Streamed straight through rather than buffered, so the first audio reaches
    // the phone while Deepgram is still producing the rest. In a conversation the
    // gap between "you stopped talking" and "it started talking" is the whole
    // feel of the thing, and this is most of it.
    return new Response(res.body, {
      status: 200,
      headers: {
        "content-type": "audio/mpeg",
        // Replies are one-shot and personal. Never let one sit in a shared cache.
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return fail(502, e?.message || "Couldn't reach Deepgram.");
  }
};
