// Shared server-side helpers. Loud env guards: a misconfigured environment
// throws a NAMED error listing exactly what's missing — never a silent null
// that surfaces later as "not signed in".
import { createClient } from '@supabase/supabase-js';

export const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body, null, 2),
});

// VITE-first alignment: functions verify tokens against the SAME project the
// client bundles — the client mints the tokens, so anything else is a landmine.
export function env(...names) {
  const fallbacks = {
    VITE_SUPABASE_URL: 'SUPABASE_URL',
    VITE_SUPABASE_ANON_KEY: 'SUPABASE_ANON_KEY',
  };
  const vals = names.map((n) => process.env[n] || (fallbacks[n] && process.env[fallbacks[n]]) || null);
  const missing = names.filter((_, i) => !vals[i]);
  if (missing.length) {
    const err = new Error(`RUNWAY_ENV_MISSING: ${missing.join(', ')} — set in Netlify env vars and redeploy`);
    err.statusCode = 500;
    throw err;
  }
  return vals;
}

// Verifies the caller's JWT and pins it to the allow-listed email. Returns a
// user-scoped Supabase client (RLS applies) — functions never hold a service
// role key by design.
export async function requireUser(event) {
  // Header first, env second. Reading env up here meant an anonymous caller on a
  // deploy missing a variable got back RUNWAY_ENV_MISSING naming it — server
  // configuration state answered before the request was even authenticated.
  const auth = event.headers.authorization || event.headers.Authorization || '';
  if (!auth.startsWith('Bearer ')) {
    const err = new Error('Missing Authorization bearer token');
    err.statusCode = 401;
    throw err;
  }
  const [url, anon, allowed] = env('VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'ALLOWED_EMAIL');
  const token = auth.slice(7);
  const anonClient = createClient(url, anon, { auth: { persistSession: false } });
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data?.user) {
    const err = new Error(`Token rejected: ${error?.message || 'no user'}`);
    err.statusCode = 401;
    throw err;
  }
  if (String(data.user.email).toLowerCase() !== String(allowed).toLowerCase()) {
    const err = new Error('Caller is not the allow-listed user');
    err.statusCode = 403;
    throw err;
  }
  const supa = createClient(url, anon, {
    auth: { persistSession: false },
    db: { schema: 'runway' },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  return { user: data.user, token, supa };
}

export const errorResponse = (ex) =>
  json(ex.statusCode || 500, { error: String(ex.message || ex) });
