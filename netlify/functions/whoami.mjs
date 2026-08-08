// whoami — walks the server auth chain with the caller's REAL token and names
// the broken step. Run from the signed-in app's console; the no-token response
// includes the one-liner.
import { serverClient } from './lib/supabase-node.mjs';
import { json } from './lib/auth.mjs';

export const handler = async (event) => {
  const SUPA_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SUPA_ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!SUPA_URL || !SUPA_ANON) {
    return json(500, { error: `RUNWAY_ENV_MISSING: ${[!SUPA_URL && 'VITE_SUPABASE_URL', !SUPA_ANON && 'VITE_SUPABASE_ANON_KEY'].filter(Boolean).join(', ')}` });
  }
  const out = { effective_url: SUPA_URL };
  const auth = event.headers.authorization || event.headers.Authorization || '';
  out.step1_auth_header_present = auth.startsWith('Bearer ');
  const token = out.step1_auth_header_present ? auth.slice(7) : null;
  if (!token) {
    return json(200, {
      ...out,
      how_to_run: "F12 console on the signed-in app: fetch('/api/whoami',{headers:{Authorization:'Bearer '+JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.includes('auth-token')))).access_token}}).then(r=>r.json()).then(console.log)",
    });
  }

  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    out.token_issuer = p.iss || null;
    out.token_subject = p.sub || null;
    out.token_expired = p.exp ? p.exp * 1000 < Date.now() : null;
    out.issuer_matches_effective_url = p.iss ? String(p.iss).startsWith(String(SUPA_URL)) : null;
  } catch { out.token_decode = 'failed — not a JWT?'; }

  const anon = serverClient(SUPA_URL, SUPA_ANON, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.getUser(token);
  out.step2_getUser_ok = !error && !!data?.user;
  if (error) out.step2_getUser_error = error.message;

  if (data?.user) {
    out.user_id = data.user.id;
    out.user_email = data.user.email;
    out.step3_email_allowlisted = process.env.ALLOWED_EMAIL
      ? String(data.user.email).toLowerCase() === String(process.env.ALLOWED_EMAIL).toLowerCase()
      : 'ALLOWED_EMAIL not set';
    // prove the RLS path with the caller's own token (no service key exists here)
    const scoped = serverClient(SUPA_URL, SUPA_ANON, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { error: rlsErr, count } = await scoped.from('jobs').select('id', { count: 'exact', head: true });
    out.step4_rls_read_ok = !rlsErr;
    if (rlsErr) out.step4_rls_error = rlsErr.message;
    else out.step4_visible_jobs = count;
  }

  out.conclusion = !out.step1_auth_header_present ? 'no Authorization header reached the function'
    : !out.step2_getUser_ok ? 'token rejected — check step2 error + issuer vs effective_url (wrong project or stale anon key)'
    : out.step3_email_allowlisted !== true ? 'signed in but NOT the allow-listed email'
    : !out.step4_rls_read_ok ? 'auth ok but RLS read failed — check policies/migration'
    : 'everything passes';
  return json(200, out);
};
