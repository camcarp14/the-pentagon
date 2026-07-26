// ═══════════════════════════════════════════════════════════════════════════
// The env gate for the AI Business tab — B7, and the front half of B5.
//
// The agent lives in a DIFFERENT Supabase project from the Pentagon's. That
// separation is the whole security story: a compromise of the agent reaches
// spend and strategy and stops there. So this tab reads VITE_AGENT_* and never
// touches @cc/supabase. Importing the shared client here would quietly undo
// the isolation while every test still passed.
//
// B7's real target is not "did I set a key" — it is "is the key in the anon
// slot actually an anon key". A service key pasted there works perfectly:
// every query succeeds, RLS is bypassed, nothing looks wrong, and the browser
// bundle now ships a credential that can read and rewrite the whole business.
// That is the failure that looks like success, so this module refuses to hand
// out a URL/key pair it cannot positively classify as public.
// ═══════════════════════════════════════════════════════════════════════════

export const AGENT_URL = String(import.meta.env?.VITE_AGENT_SUPABASE_URL || "").trim().replace(/\/+$/, "");
export const AGENT_KEY = String(import.meta.env?.VITE_AGENT_SUPABASE_ANON_KEY || "").trim();

// base64url → utf8, without Buffer (this runs in a browser).
function decodeSegment(seg) {
  const b64 = String(seg).replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  // The JWT payload is ASCII JSON in practice, but decode as UTF-8 properly
  // rather than assuming — a non-ASCII byte would otherwise corrupt the parse
  // and turn "I can't classify this key" into "this key has no role claim",
  // which fails OPEN.
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

/** The `role` claim of a Supabase legacy JWT key, or null if it isn't one. */
export function jwtRole(key) {
  try {
    const parts = String(key).split(".");
    if (parts.length !== 3) return null;
    const claims = JSON.parse(decodeSegment(parts[1]));
    return typeof claims.role === "string" ? claims.role : null;
  } catch {
    return null;
  }
}

/**
 * Classify a Supabase API key by what it is ALLOWED to be in a browser bundle.
 *
 * Supabase ships two key generations and the check has to cover both, because
 * a validator that only understands JWTs would reject a perfectly good
 * `sb_publishable_…` key and get switched off — and a switched-off check is
 * how the service key gets in.
 *
 *   legacy JWT     role 'anon'          → publishable, safe
 *                  role 'service_role'  → SECRET, refuse
 *                  any other role       → unknown, refuse
 *   new format     sb_publishable_…     → publishable, safe
 *                  sb_secret_…          → SECRET, refuse
 *
 * Anything unrecognised is refused. Failing closed on an unknown key shape
 * costs a config error; failing open costs the business.
 */
export function classifyKey(key) {
  const k = String(key || "").trim();
  if (!k) return { kind: "missing", safe: false, reason: "VITE_AGENT_SUPABASE_ANON_KEY is not set." };

  if (k.startsWith("sb_secret_")) {
    return { kind: "secret", safe: false, reason: "That is a SECRET key (sb_secret_…). It bypasses RLS and must never reach the browser." };
  }
  if (k.startsWith("sb_publishable_")) {
    return { kind: "publishable", safe: true, reason: "Publishable key (sb_publishable_…)." };
  }

  const role = jwtRole(k);
  if (role === "anon") return { kind: "anon", safe: true, reason: "Legacy anon key (JWT role 'anon')." };
  if (role === "service_role") {
    return { kind: "service_role", safe: false, reason: "That is a SERVICE ROLE key in the anon slot. It bypasses RLS and every query would have silently succeeded." };
  }
  if (role) return { kind: "unknown", safe: false, reason: `Key decodes to an unexpected role: '${role}'.` };

  return { kind: "unknown", safe: false, reason: "Key is neither a decodable Supabase JWT nor an sb_publishable_ key." };
}

/** Hostname only — safe to render; never renders key material. */
export function urlHost(u) {
  try { return new URL(u).host; } catch { return null; }
}

export function isLoopback(u) {
  try {
    const h = new URL(u).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch { return false; }
}

/**
 * The single gate the tab boots through. `ok: false` means render the
 * misconfiguration screen and construct NO client at all — not a degraded one.
 */
export function checkAgentEnv(url = AGENT_URL, key = AGENT_KEY) {
  const problems = [];
  if (!url) problems.push("VITE_AGENT_SUPABASE_URL is not set.");
  // https everywhere except loopback. `supabase start` serves the local stack
  // over http://127.0.0.1:54321, and a rule that forbids it would force the
  // check to be disabled during local development — which is how a check stops
  // protecting the deploy it was written for.
  else if (!/^https:\/\//i.test(url) && !isLoopback(url)) {
    problems.push("VITE_AGENT_SUPABASE_URL must be an https:// URL (http is only allowed for a loopback address).");
  }

  const keyCheck = classifyKey(key);
  if (!keyCheck.safe) problems.push(keyCheck.reason);

  // The isolation check. If the agent project and the Pentagon project are the
  // same host, the separate-project guarantee is not being kept — and it would
  // read as working, because every query would succeed against a project that
  // does have these tables' names free.
  const pentagonUrl = String(import.meta.env?.VITE_SUPABASE_URL || "").trim();
  const sameProject = !!url && !!pentagonUrl && urlHost(url) === urlHost(pentagonUrl);
  if (sameProject) {
    problems.push("VITE_AGENT_SUPABASE_URL points at the SAME project as VITE_SUPABASE_URL. The agent must live in its own project — that isolation is the reason this tab has its own client.");
  }

  return {
    ok: problems.length === 0,
    problems,
    keyKind: keyCheck.kind,
    host: urlHost(url),
    sameProject,
  };
}
