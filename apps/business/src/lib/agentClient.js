// ═══════════════════════════════════════════════════════════════════════════
// The agent project's Supabase client — a SECOND client, deliberately.
//
// @cc/supabase is the Pentagon's: one project, one GoTrue, one session, shared
// by every other tool. This tab must not touch it. The agent runs in its own
// project so that a compromise of the agent reaches spend and strategy and
// nothing else, and reusing the existing client would dissolve that boundary
// while every screen still looked right.
//
// Two clients in one page share one localStorage, so `storageKey` is not a
// nicety: without it, supabase-js writes both sessions to the same default
// slot and the second client to initialise silently evicts the first. The
// symptom is the Pentagon logging itself out whenever you open this tab.
//
// Reads and realtime go through here. The halt button does NOT — see halt.js.
// ═══════════════════════════════════════════════════════════════════════════
import { createClient } from "@supabase/supabase-js";
import { AGENT_URL, AGENT_KEY, checkAgentEnv } from "./env.js";
import { primeHaltToken, HALT_STORAGE_KEY } from "./halt.js";

export const envCheck = checkAgentEnv();

// No client at all when the environment is unsafe. A degraded client would let
// a service-role key in the anon slot keep working perfectly — which is
// precisely the failure B7 is about.
export const agentSb = envCheck.ok
  ? createClient(AGENT_URL, AGENT_KEY, {
      auth: {
        storageKey: HALT_STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        // This tab is mounted inside the Pentagon shell, which owns the URL.
        // Letting a second client parse the address bar for auth fragments
        // means two clients racing over the same hash.
        detectSessionInUrl: false,
      },
      // One socket, and only for the two tables that change while you watch.
      realtime: { params: { eventsPerSecond: 4 } },
      global: { headers: { "x-client-info": "pentagon-business-tab" } },
    })
  : null;

export const isAgentConfigured = () => !!agentSb;

// ─── auth (B5: mandatory, single user, fails closed) ─────────────────────────
export const agentAuth = {
  async getSession() {
    if (!agentSb) return null;
    const { data } = await agentSb.auth.getSession();
    const session = data?.session || null;
    primeHaltToken(session?.access_token || null);
    return session;
  },
  async signIn(email, password) {
    if (!agentSb) throw new Error("The agent project is not configured in this build.");
    const { data, error } = await agentSb.auth.signInWithPassword({ email: String(email).trim(), password });
    if (error) throw error;
    primeHaltToken(data?.session?.access_token || null);
    return data;
  },
  async signOut() {
    primeHaltToken(null);
    await agentSb?.auth.signOut();
  },
  /** Subscribe to session changes; returns an unsubscribe fn. */
  onChange(cb) {
    if (!agentSb) return () => {};
    const { data } = agentSb.auth.onAuthStateChange((_event, session) => {
      // Keep the halt path's token current on every transition, including the
      // silent refreshes — a halt attempted on an hour-old access token is a
      // halt that 401s at the worst possible moment.
      primeHaltToken(session?.access_token || null);
      cb(session || null);
    });
    return () => data?.subscription?.unsubscribe();
  },
};

// ─── fault injection (the B1/B3 checks, and honest prod diagnostics) ─────────
// B3's check is "point the client at a dead URL — nothing renders as a calm
// zero", and B1's is "break the main data loader deliberately". Both need a
// way to break things on demand, and a broken build is not one. These are
// opt-in per page load via the query string and announce themselves loudly, so
// an injected fault can never be mistaken for a real outage:
//
//   ?fault=db      every shared read fails    (B3)
//   ?fault=loader  the shared loader throws   (B1)
//   ?fault=stale   rows arrive back-dated 3h  (B3, the stale-vs-empty split)
//
// They only ever make things WORSE. Nothing here can mask a real failure.
export function activeFault() {
  try {
    const v = new URLSearchParams(window.location.search).get("fault");
    return ["db", "loader", "stale"].includes(v) ? v : null;
  } catch { return null; }
}
