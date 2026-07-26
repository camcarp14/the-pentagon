import { SAFE_SEND_ADDRESS } from "../config.js";
import { T } from "../theme.js";
import { sm } from "./store.js";
import { callClaude } from "./claudeApi.js";
import { functionAuthHeaders } from "./supabase.js";

export const sendMode = {
  isLive: () => sm.get("live_sending") === true,
  setLive: (on) => sm.set("live_sending", on === true),
};


// ─── Text helpers ────────────────────────────────────────────────────────────
export function cleanBody(text) {
  if (!text) return "";
  if (text.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.body) return parsed.body.replace(/\\n/g, "\n");
    } catch {
      // JSON.parse failed — body likely contains unescaped inner quotes. Extract with regex.
      const bodyIdx = text.indexOf('"body"');
      if (bodyIdx !== -1) {
        const afterKey = text.slice(bodyIdx + 6).replace(/^\s*:\s*"/, "");
        const inner = afterKey.replace(/"\s*\}?\s*$/, "").replace(/\\n/g, "\n").trim();
        if (inner.length > 10) return inner;
      }
    }
  }
  return text.replace(/\\n/g, "\n");
}


export function cleanSubject(text) {
  if (!text) return "";
  if (text.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.subject) return parsed.subject;
    } catch {}
  }
  return text;
}


export function timeAgo(dateStr) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}


// ─── Components ──────────────────────────────────────────────────────────────
// ─── Thread helpers ──────────────────────────────────────────────────────────
export function cleanReplyBody(text) {
  if (!text) return "";
  // Remove quoted email lines (lines starting with >)
  const lines = text.split("\n");
  const cleaned = [];
  for (const line of lines) {
    if (line.trim().startsWith(">")) continue;
    if (line.trim().startsWith("On ") && line.includes("wrote:")) continue;
    cleaned.push(line);
  }
  // Trim trailing blank lines
  return cleaned.join("\n").trim();
}


export async function sendEmail({ to, subject, body, replyToMessageId, threadId }) {
  // ── Last line of defence, at the choke point ──────────────────────────────
  // Some drafts hold the model's entire JSON response instead of an email
  // body — two of the three on this account do, and ONE OF THEM WAS SENT that
  // way to a real prospect. Every call site is supposed to pass cleaned text,
  // but QueueView imported cleanSubject and NOT cleanBody, which is how the
  // workaround silently half-applied itself.
  //
  // Cleaning here means no future call site can forget. Both helpers are
  // idempotent — text that is already clean does not start with '{' and passes
  // through untouched — so double-cleaning is free.
  subject = cleanSubject(subject);
  body = cleanBody(body);
  if (!String(body || "").trim()) {
    throw new Error("Refusing to send an empty body — the draft has no readable text.");
  }

  // Safe mode (the default) reroutes every send to your own inbox.
  const live = sendMode.isLive();
  const actualTo = live ? to : SAFE_SEND_ADDRESS;
  const safePrefix = live ? "" : `[SAFE MODE — would send to: ${to}]\n\n`;

  // For local dev, open in Gmail compose (no backend needed yet)
  // When deployed to Netlify, this will call the serverless function
  const isDeployed = window.location.hostname !== "localhost";

  if (isDeployed) {
    const res = await fetch("/.netlify/functions/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await functionAuthHeaders()) },
      body: JSON.stringify({ to: actualTo, subject, body: safePrefix + body, replyToMessageId, ...(live && threadId ? { threadId } : {}) }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || "Send failed");
    return data;
  } else {
    // Local dev: open Gmail compose in new tab
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(actualTo)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(safePrefix + body)}`;
    window.open(gmailUrl, "_blank");
    return { success: true, method: "gmail_compose" };
  }
}


// ─── Reply Detection ─────────────────────────────────────────────────────────
export async function checkForReplies(sentCards) {
  const threadIds = sentCards
    .filter((c) => c.gmail_thread_id)
    .map((c) => c.gmail_thread_id);

  if (threadIds.length === 0) return [];

  const isDeployed = window.location.hostname !== "localhost";
  if (!isDeployed) return []; // Only works on deployed version

  try {
    const res = await fetch("/.netlify/functions/check-replies", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await functionAuthHeaders()) },
      body: JSON.stringify({ sentThreadIds: threadIds }),
    });
    const data = await res.json();
    return data.replies || [];
  } catch {
    return [];
  }
}


export async function generateReplyDraft(originalEmail, replyEmail, prospect, toneMemory) {
  const toneInstructions = toneMemory.length
    ? `\n\nTone instructions:\n${toneMemory.map((t) => `- ${t.feedback_text}`).join("\n")}`
    : "";

  const prompt = `You are Cameron from Clarify Paid Search, a boutique Google Ads agency in Chicago.

You sent this outreach email:
Subject: ${originalEmail.subject}
Body: ${originalEmail.body}

The prospect replied:
From: ${replyEmail.from}
Message: ${replyEmail.body}

Write a concise, natural reply that:
- Acknowledges what they said specifically
- Moves toward booking a 15-minute call if they're interested
- Handles objections warmly if they pushed back
- Stays under 100 words
- Signs off as: Cameron | Clarify Paid Search${toneInstructions}

Return ONLY valid JSON, no markdown:
{"subject": "Re: ${originalEmail.subject}", "body": "..."}`;

  const r = await callClaude({ model: "claude-haiku-4-5-20251001", max_tokens: 500, messages: [{ role: "user", content: prompt }], fn: "reply_draft", promptChars: prompt.length });
  const text = r.text || "{}";
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return { subject: `Re: ${originalEmail.subject}`, body: text };
  }
}


// ─── Round 3: Follow-up cadence engine ───────────────────────────────────────
// A disciplined outreach cadence: initial → +3d bump → +7d value-add → +14d
// break-up. Derives the current step from sent_at and any logged follow-ups,
// and tells the operator what's due now. No emails fire automatically — it
// surfaces the next move and lets the human pull the trigger.
export const CADENCE = [
  { step: 0, label: "Initial sent", offsetDays: 0 },
  { step: 1, label: "Bump", offsetDays: 3, hint: "Short nudge — 'wanted to make sure this didn't get buried'" },
  { step: 2, label: "Value-add", offsetDays: 7, hint: "Lead with an insight, not a check-in" },
  { step: 3, label: "Break-up", offsetDays: 14, hint: "Last touch — 'I'll close the loop unless I hear back'" },
];


export function cadenceState(card) {
  if (!card.sent_at) return null;
  if (card.status === "replied") return { done: true, label: "Replied", color: T.green };
  const sentMs = new Date(card.sent_at).getTime();
  const daysSince = Math.floor((Date.now() - sentMs) / 86400000);
  // touches sent so far (initial = 1; each logged follow-up adds one)
  const touches = 1 + (card.followups?.length || 0);
  const currentStep = Math.min(touches - 1, CADENCE.length - 1);
  const next = CADENCE[currentStep + 1];
  if (!next) {
    return { done: true, label: "Cadence complete", color: T.faint, daysSince, touches };
  }
  const dueInDays = next.offsetDays - daysSince;
  const due = dueInDays <= 0;
  return {
    done: false, daysSince, touches,
    currentLabel: CADENCE[currentStep].label,
    nextLabel: next.label, nextHint: next.hint,
    due, dueInDays,
    color: due ? T.amber : T.faint,
  };
}


// ─── Round 2: Reply triage — classify reply sentiment for fast prioritization ─
// Heuristic classifier — runs locally, no API cost. Catches the common cases an
// outreach operator triages by hand: eager yes, objection, not-now, hard no.
export function classifyReply(text) {
  if (!text) return { tier: "neutral", label: "Reply", color: T.muted, bg: "rgba(148,161,181,0.12)", priority: 2 };
  const t = text.toLowerCase();
  // Hard no / unsubscribe — handle with care, lowest priority to chase
  if (/\b(unsubscribe|remove me|not interested|no thanks|no thank you|stop emailing|take me off|do not contact|fuck off|leave me alone)\b/.test(t))
    return { tier: "pass", label: "Not Interested", color: T.red, bg: "rgba(248,113,113,0.12)", priority: 0 };
  // Eager / interested — book it
  if (/\b(yes|interested|sounds good|let'?s talk|happy to|book|schedule|call me|set up|tell me more|how much|pricing|when can|i'?d like|sign me up|let'?s do)\b/.test(t))
    return { tier: "hot", label: "Interested", color: T.green, bg: "rgba(62,207,142,0.12)", priority: 4 };
  // Objection / question — needs a real answer
  if (/\b(but|however|already have|too expensive|not sure|concern|worried|why|what about|how do you|don'?t think|currently use|we use|skeptical)\b/.test(t))
    return { tier: "objection", label: "Has Questions", color: T.amber, bg: "rgba(245,184,77,0.12)", priority: 3 };
  // Not now / later
  if (/\b(later|next quarter|next year|busy right now|circle back|not right now|reach out in|check back|maybe in|down the road|q[1-4])\b/.test(t))
    return { tier: "later", label: "Not Now", color: T.blue, bg: "rgba(110,168,254,0.12)", priority: 1 };
  return { tier: "neutral", label: "Reply", color: T.muted, bg: "rgba(148,161,181,0.12)", priority: 2 };
}
