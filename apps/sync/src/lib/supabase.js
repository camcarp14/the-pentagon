// ─── SYNC's view of the Pentagon database ────────────────────────────────────
// Standalone SYNC built its own Supabase client: its own GoTrue instance, its
// own storageKey, its own sign-in form, its own hardcoded project URL. Inside
// the monorepo all of that is someone else's job — @cc/supabase owns the one
// client and the one session, and the shell will not mount this tool until
// there IS a session. Two clients against one project meant two token refresh
// loops and two places to be signed out of; now there is one.
//
// What survives is the part that was actually SYNC's: which schema its rows
// live in, and turning a PostgREST error into a sentence worth saying out loud.

import { supabase, isConfigured } from "@cc/supabase";

export { supabase };

export const CONFIGURED = isConfigured();

/**
 * SYNC's own schema. The shared client defaults to `public` (Clarify + auth),
 * so every SYNC row goes through here — exactly as ZTS uses zts() and Runway
 * uses runway().
 */
export const sync = () => supabase?.schema("sync");

/** The Board Room personal tables — the real calendar, notes, birthdays, upkeep. */
export const boardroom = () => supabase?.schema("boardroom");

/**
 * Turn a Supabase error into something worth saying out loud. PostgREST codes
 * are precise but unreadable, and the handful that actually happen in practice
 * deserve an answer that says what to do rather than what went wrong.
 */
export function readableError(error) {
  if (!error) return "";
  const code = error.code || "";
  if (code === "PGRST106") return "The `sync` schema isn't exposed over the API yet — add it under Settings → API → Exposed schemas in Supabase.";
  if (code === "42501") return "This account isn't the Pentagon owner, so the business data stays hidden.";
  if (code === "28000" || code === "PGRST301" || error.status === 401) return "The session expired — reload to sign in again.";
  if (/Failed to fetch|NetworkError/i.test(error.message || "")) return "Couldn't reach the Pentagon — check the connection.";
  return error.message || "Something went wrong talking to the Pentagon.";
}
