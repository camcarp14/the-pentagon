// env-check — deployment self-diagnosis endpoint, deployed on day one.
// Safe to leave up: returns booleans, hostnames, and role claims — never key
// material. `commit` answers "which build is actually live?" directly
// (stamped at build time by scripts/stamp-build.mjs).
import buildInfo from './lib/build-info.json';

const host = (u) => { try { return new URL(u).host; } catch { return null; } };
const jwtRole = (k) => {
  try { return JSON.parse(Buffer.from(String(k).split('.')[1], 'base64url').toString('utf8')).role || null; }
  catch { return null; }
};
// Supabase ships two key generations. jwtRole only understands the legacy one,
// so it reports null for a perfectly good `sb_publishable_…` key — and a field
// that reads null when nothing is wrong is a field the reader learns to skip.
// Returns one of: anon | publishable | service_role | secret | unknown | missing.
// Mirrors classifyKey() in apps/business/src/lib/env.js — keep the two in step.
const keyKind = (k) => {
  const s = String(k || '').trim();
  if (!s) return 'missing';
  if (s.startsWith('sb_secret_')) return 'secret';
  if (s.startsWith('sb_publishable_')) return 'publishable';
  const role = jwtRole(s);
  if (role === 'anon') return 'anon';
  if (role === 'service_role') return 'service_role';
  return 'unknown'; // unrecognised shape: refuse to call it safe
};

export const handler = async () => {
  const SUPA_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SUPA_ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  // The AI Business tab talks to a SEPARATE Supabase project. Its isolation is
  // the security story, so it gets checked here too — not just in the browser.
  const AGENT_URL = process.env.VITE_AGENT_SUPABASE_URL;
  const AGENT_KEY = process.env.VITE_AGENT_SUPABASE_ANON_KEY;
  const AGENT_KIND = keyKind(AGENT_KEY);
  const out = {
    context: buildInfo.context || process.env.CONTEXT || null,
    commit: buildInfo.commit || (process.env.COMMIT_REF ? String(process.env.COMMIT_REF).slice(0, 7) : null),
    built_at: buildInfo.built_at,
    supabase_url_host: host(SUPA_URL),
    anon_key_present: !!SUPA_ANON,
    anon_key_role: jwtRole(SUPA_ANON), // expect 'anon'
    anthropic_key_present: !!process.env.ANTHROPIC_API_KEY,
    allowed_email_present: !!process.env.ALLOWED_EMAIL,
    // optional: powers scheduled scans only. The role decode catches the
    // silent killer — an anon key pasted into the service slot.
    service_key_present: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    service_key_role: jwtRole(process.env.SUPABASE_SERVICE_ROLE_KEY), // must be 'service_role'
    service_slot_holds_anon_key: jwtRole(process.env.SUPABASE_SERVICE_ROLE_KEY) === 'anon',
    // AI Business tab (B7). The mirror image of the check above: here the
    // silent killer is a SECRET key pasted into the anon slot — it works, it
    // bypasses RLS, and it ships in the public bundle.
    agent_supabase_url_host: host(AGENT_URL),
    agent_key_present: !!AGENT_KEY,
    agent_key_kind: AGENT_KIND, // expect 'anon' or 'publishable'
    agent_anon_slot_holds_secret: AGENT_KIND === 'service_role' || AGENT_KIND === 'secret',
    // false is a REAL failure, not a missing nicety: the agent lives in its own
    // project so a compromise of it cannot reach the Pentagon's data. Both
    // hosts must be known and different — an unset URL can't be called separate.
    agent_project_is_separate: !!host(AGENT_URL) && !!host(SUPA_URL) && host(AGENT_URL) !== host(SUPA_URL),
    missing: [
      !SUPA_URL && 'VITE_SUPABASE_URL',
      !SUPA_ANON && 'VITE_SUPABASE_ANON_KEY',
      !AGENT_URL && 'VITE_AGENT_SUPABASE_URL',
      !AGENT_KEY && 'VITE_AGENT_SUPABASE_ANON_KEY',
      !process.env.ANTHROPIC_API_KEY && 'ANTHROPIC_API_KEY',
      !process.env.ALLOWED_EMAIL && 'ALLOWED_EMAIL',
    ].filter(Boolean),
  };
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out, null, 2) };
};
