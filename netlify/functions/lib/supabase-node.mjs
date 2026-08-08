// The Supabase client, constructed for a serverless function.
//
// THE OUTAGE THIS FIXES: `createClient()` eagerly builds a RealtimeClient, and
// RealtimeClient's constructor resolves a WebSocket implementation before it
// knows whether anyone will ever open a channel. When the runtime has no global
// WebSocket it does not degrade — it THROWS:
//
//   Node.js detected but native WebSocket not found.
//   Suggested solution: Ensure you are running Node.js 22+ ...
//
// Node 20 has no global WebSocket (it landed unflagged in 22), so on a Node 20
// runtime that throw happens inside requireUser(), before any handler logic —
// which means EVERY authenticated endpoint returns it, and the user sees a
// WebSocket error while pasting a job URL. Nothing in the message points at the
// real cause, and nothing in the app is actually using realtime.
//
// THE FIX IS TO STOP ASKING. A serverless function never opens a realtime
// channel: it answers one request and exits. So we hand realtime a transport
// explicitly and the factory is never consulted. That is not a workaround for a
// stale runtime — it is the truthful declaration, and it makes every function
// immune to what the runtime does or does not put on globalThis.
//
// Every server-side Supabase client goes through here for exactly that reason:
// six call sites across four files each got to decide this independently, which
// is five more chances to get it wrong than the problem deserves.
import { createClient } from '@supabase/supabase-js';

// Never constructed — realtime only needs the constructor to EXIST. If some
// future code path does try to open a channel, this throws a sentence that says
// what happened instead of a WebSocket error that does not.
class NoRealtimeTransport {
  constructor() {
    throw new Error('Realtime is not available in a serverless function — it answers one request and exits.');
  }
}

/**
 * @param url  Supabase project URL
 * @param key  anon or service-role key — this helper does not care which
 * @param opts normal supabase-js options; `realtime` is filled in and anything
 *             else passes straight through
 */
export const serverClient = (url, key, opts = {}) =>
  createClient(url, key, { ...opts, realtime: { transport: NoRealtimeTransport, ...(opts.realtime || {}) } });
