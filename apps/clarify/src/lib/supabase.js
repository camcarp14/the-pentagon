import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";
import { auth as shellAuth } from "@cc/supabase";

// ─── The one token seam ──────────────────────────────────────────────────────
// Every authed request in Clarify resolves its bearer HERE, at call time, from
// supabase-js — never from a localStorage mirror read synchronously.
//
// WHY THIS MATTERS, precisely. Supabase refresh tokens are SINGLE-USE: exchanging
// one revokes it. Clarify used to run its own 45-minute renewal timer against a
// mirrored `clarify_refresh` while supabase-js (the shell's session of record)
// ran its own. Whichever fired first revoked the other's token, and when
// supabase-js was the loser its next auto-refresh failed, it emitted SIGNED_OUT,
// and the shell dropped you out of EVERY Pentagon tool mid-session — not just
// Clarify. That timer is gone; supabase-js is now the only refresher.
//
// getSession() also refreshes on its own when the token is near expiry, so
// resolving here means a request can never carry a token that expired while the
// tab sat open. The localStorage mirror stays only as a fallback for a Clarify
// running without the shell.
export async function currentAccessToken() {
  try {
    const s = await shellAuth.getSession();
    if (s?.access_token) return s.access_token;
  } catch { /* not configured / standalone — fall through to the mirror */ }
  try { return localStorage.getItem("clarify_token"); } catch { return null; }
}

// The operator-only Netlify functions (send-email, check-replies, claude,
// prospect-proxy) require this — they check it server-side via requireAuth.cjs.
// Public functions (audit-lead, track-*) don't need it and shouldn't send it.
// ASYNC: resolving the token is the whole point (see above). Call sites await.
export async function functionAuthHeaders() {
  const token = await currentAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── Auth ────────────────────────────────────────────────────────────────────
export const sbAuth = {
  async signIn(email, password) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || "Login failed");
    return data;
  },
  async getUser(token) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json();
  },
  async signOut(token) {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: "POST",
      headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${token}` },
    });
  },
  // Silently renew an expired session with the stored refresh token — this is
  // what keeps the app signed in indefinitely without ever re-showing the
  // login screen, as long as the refresh token itself hasn't been revoked.
  async refresh(refreshToken) {
    if (!refreshToken) return null;
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token ? data : null;
  },
};


// ─── Supabase ────────────────────────────────────────────────────────────────
export async function sbFetch(path, options = {}) {
  // Send the signed-in session token, not the anon key. RLS on the core tables
  // (prospects/contacts/outreach/tone_memory) requires auth.role()='authenticated';
  // with the anon key PostgREST doesn't error — it just returns empty sets and
  // no-ops writes, which is how the deployed board silently broke. Same pattern
  // deleteInboundLead already uses. Falls back to the anon key pre-login for the
  // tables that allow it (inbound_leads count).
  const sessionToken = await currentAccessToken();
  // Destructure so a caller-supplied `headers` MERGES with the auth headers.
  // (The old `{ headers: {...}, ...options }` shape let options.headers replace
  // the whole object — silently dropping apikey/Authorization → gateway 401s.)
  const { headers: extraHeaders, prefer, ...rest } = options;
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...rest,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${sessionToken || SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: prefer || "return=representation",
      ...extraHeaders,
    },
  });
  if (!res.ok) throw new Error(await res.text());
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}


export const db = {
  async getOutreachBoard() {
    return sbFetch(`/outreach?select=*,prospect:prospects(*),contact:contacts(*)&order=created_at.desc`);
  },
  async deleteOutreach(id) {
    return sbFetch(`/outreach?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
  },
  async deleteInboundLead(id) {
    // Uses the signed-in session token, not just the anon key — if inbound_leads'
    // DELETE policy requires an authenticated role (unlike its SELECT/INSERT/UPDATE
    // policies, which the public form and status updates rely on via anon), the
    // anon key alone silently matches zero rows instead of failing outright.
    const token = await currentAccessToken();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/inbound_leads?id=eq.${id}`, {
      method: "DELETE",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
    });
    if (!res.ok) throw new Error(await res.text());
    const deleted = await res.json().catch(() => []);
    if (!Array.isArray(deleted) || deleted.length === 0) {
      // Postgres RLS makes rows invisible rather than raising an error — a DELETE
      // that matches nothing under the policy still returns 200 OK with an empty
      // array. Surface that plainly instead of pretending it worked.
      throw new Error("Nothing was deleted. Supabase's Row Level Security is likely blocking this — check that a DELETE policy exists for authenticated users on the inbound_leads table.");
    }
    return deleted;
  },
  // `initial` marks the FIRST send on a thread. sent_at is the thread's origin
  // timestamp — analytics (time-to-reply, weekly trend), the urgency pill and
  // cadenceState all measure from it. Follow-ups and replies used to overwrite
  // it, which made replied_at land before sent_at (negative reply times were
  // filtered out of the median entirely) and restarted the follow-up ladder.
  async markSent(id, gmailMessageId, gmailThreadId, rfcMessageId, { initial = true } = {}) {
    const patch = {
      status: "sent",
      gmail_message_id: gmailMessageId || null,
      gmail_thread_id: gmailThreadId || null,
      gmail_rfc_message_id: rfcMessageId || null,
    };
    // Only sent_at is gated. next_follow_up_at is the OPPOSITE kind of value —
    // a rolling clock that every send is supposed to push forward — and it has
    // a live reader: sync.pentagon() counts `next_follow_up_at <= now()` as
    // due_followups (20260729045140_create_sync_pentagon_reader.sql), which SYNC
    // renders as "N follow-ups due". Freezing it at the first send would leave
    // every thread ever sent permanently past-due, no matter how many follow-ups
    // actually went out.
    if (initial) patch.sent_at = new Date().toISOString();
    patch.next_follow_up_at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    return sbFetch(`/outreach?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  },
  async getToneMemory() {
    return sbFetch(`/tone_memory?order=created_at.desc&limit=20`);
  },
  async updateOutreach(id, updates) {
    return sbFetch(`/outreach?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(updates) });
  },
  async addToneMemory(feedback_text, outreach_id) {
    return sbFetch(`/tone_memory`, {
      method: "POST",
      body: JSON.stringify({ feedback_text, applied_to_outreach_id: outreach_id }),
    });
  },
  async markReplied(id, replyData) {
    return sbFetch(`/outreach?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "replied",
        replied_at: new Date().toISOString(),
        reply_body: replyData.body,
        reply_from: replyData.from,
        reply_subject: replyData.subject,
        reply_gmail_message_id: replyData.messageId,
      }),
    });
  },
  async saveReplyDraft(id, subject, body) {
    return sbFetch(`/outreach?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ reply_draft: body, reply_draft_subject: subject }),
    });
  },
  async deleteToneMemory(id) {
    return sbFetch(`/tone_memory?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
  },
  async insertProspect(data) {
    return sbFetch(`/prospects`, { method: "POST", body: JSON.stringify(data) });
  },
  async insertContact(data) {
    return sbFetch(`/contacts`, { method: "POST", body: JSON.stringify(data) });
  },
  async insertOutreach(data) {
    return sbFetch(`/outreach`, { method: "POST", body: JSON.stringify(data) });
  },
  async getInboundNewCount() {
    return sbFetch(`/inbound_leads?status=eq.new&select=id`);
  },
};


// ─── Lead lifecycle — the glue that makes Inbound, Outreach, and Clients one flow ──
export const normEmail = (e) => String(e || "").toLowerCase().trim();


// ─── Global Agent — portfolio counts fetch ────────────────────────────────────
export async function fetchPortfolioCounts() {
  try {
    const token = await currentAccessToken();
    const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const [cr, fr, ar] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/clients?select=id&status=eq.active`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/findings?select=id&status=eq.active&severity=eq.critical`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/action_queue?select=id&status=eq.pending`, { headers }),
    ]);
    const c = cr.ok ? await cr.json() : [];
    const f = fr.ok ? await fr.json() : [];
    const a = ar.ok ? await ar.json() : [];
    return { activeClients: c.length || 0, criticalFindings: f.length || 0, pendingActions: a.length || 0 };
  } catch {
    return { activeClients: 0, criticalFindings: 0, pendingActions: 0 };
  }
}
