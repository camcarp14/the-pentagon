// ─── Auth guard for the operator-only Netlify functions ─────────────────────
// send-email / check-replies / read-emails / claude / prospect-proxy do real
// work (send email as Cameron, spend Anthropic/Places/Hunter/Firecrawl credit)
// and previously ran for ANY caller who found the URL, logged in or not. This
// requires a valid Supabase session token — the same one the app already
// gets on login — instead of a new secret: it calls Supabase's own
// /auth/v1/user with the caller's token, using the PUBLIC anon key (already
// shipped in the client bundle). Zero new env vars, zero new secret surface.
//
//   const { requireAuth } = require("./_shared/requireAuth.cjs");
//   exports.handler = async (event) => {
//     if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
//     const auth = await requireAuth(event);
//     if (!auth.ok) return { statusCode: auth.status, body: JSON.stringify({ error: auth.error }) };
//     // ...existing handler logic, unchanged
//   };
//
// AUTHENTICATED IS NOT THE SAME AS AUTHORISED. Verifying the token proves the
// caller holds a session on this Supabase project — it does not prove they are
// the operator. Sign-up on the project is one setting away from open, and these
// handlers send mail as Cameron and spend the Anthropic/Places/Hunter/Firecrawl
// budget, so a second signed-up account would inherit all of it. ALLOWED_EMAIL
// is already a documented, required deploy variable (docs/DEPLOY.md; env-check
// flags it missing) and netlify/functions/lib/auth.mjs has always pinned to it.
// This brings the other half of the function surface onto the same rule.
//
// Enforced only WHEN SET, on purpose: a deploy that has not configured the
// variable yet keeps today's behaviour rather than locking its own operator out
// of every tool at once. env-check is the surface that reports it missing.
const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = require("./supabaseRest.cjs");

async function requireAuth(event) {
  const header = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
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
    return { ok: true, user };
  } catch {
    return { ok: false, status: 401, error: "Couldn't verify session — try again." };
  }
}

module.exports = { requireAuth };
