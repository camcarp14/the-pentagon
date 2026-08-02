// ─── Minimal PostgREST client for Netlify functions ─────────────────────────
// Uses the project's public URL + publishable key. They are deliberately read
// from the deployment environment instead of duplicated in server source: that
// keeps a key rotation from leaving a stale second copy behind and lets Netlify
// secret scanning stay enabled.
function supabaseConfig() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "";
  const missing = [!url && "VITE_SUPABASE_URL", !key && "VITE_SUPABASE_ANON_KEY"].filter(Boolean);
  if (missing.length) {
    const err = new Error(`SUPABASE_ENV_MISSING: ${missing.join(", ")}`);
    err.statusCode = 503;
    throw err;
  }
  return { url, key };
}

async function sbRest(path, { method = "GET", body, prefer } = {}) {
  const { url, key } = supabaseConfig();
  const res = await fetch(`${url}/rest/v1${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: prefer || "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PostgREST ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = { sbRest, supabaseConfig, UUID_RE };
