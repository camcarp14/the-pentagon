import { useState, useEffect, Fragment } from "react";
import { T } from "../../theme";
import { LeadJourney } from "../../components/LeadJourney.jsx";
import { callClaude } from "../../lib/claudeApi.js";
import { CADENCE, cadenceState, classifyReply, cleanBody, cleanReplyBody, cleanSubject, sendEmail, sendMode, timeAgo } from "../../lib/email.js";
import { draftAngle, estimateValue, fmtMoney, freshness, getProspectPriority, whyNow } from "../../lib/leads.js";
import { ANALYST_SYSTEM_PROMPT } from "../../lib/prompts.js";
import { generateDraft, generateFollowUpDraft } from "../../lib/prospecting.js";
import { sm } from "../../lib/store.js";
import { db } from "../../lib/supabase.js";

function ThreadModal({ card, onClose, onSendReply, toneMemory }) {
  const [replyBody, setReplyBody] = useState(cleanReplyBody(card.reply_draft || ""));
  const [replySubject, setReplySubject] = useState(card.reply_draft_subject || `Re: ${card.draft_subject || ""}`);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const contact = card.contact || {};

  const handleSend = async () => {
    setSending(true);
    try {
      await onSendReply(card, replySubject, replyBody);
      setStatus("✓ Reply sent!");
    } catch (err) {
      setStatus("Failed: " + err.message);
    }
    setSending(false);
  };

  return (
    <div className="co-modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="co-modal-sheet" style={{ background: T.surface, border: `1px solid ${T.lineInk}`, borderRadius: "12px", width: "100%", maxWidth: "600px", maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${T.lineSoft}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: "14px", fontWeight: 600, color: T.ink }}>{card.prospect?.business_name}</div>
            <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>{contact.email}</div>
          </div>
          <button onClick={onClose} className="co-modal-close" style={{ background: "none", border: "none", color: T.muted, fontSize: "20px", cursor: "pointer", padding: "4px 8px" }}>×</button>
        </div>
        <div style={{ padding: "10px 20px 0" }}><LeadJourney card={card} /></div>

        {/* Thread */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: "12px" }}>
          {/* Original outreach */}
          <div style={{ background: T.subtle, borderRadius: "8px", padding: "12px", borderLeft: `3px solid ${T.blue}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
              <span style={{ fontSize: "11px", fontWeight: 600, color: T.blue }}>You → {contact.email}</span>
              <span style={{ fontSize: "10px", color: T.faint }}>{timeAgo(card.sent_at)}</span>
            </div>
            <div style={{ fontSize: "12px", fontWeight: 600, color: T.muted, marginBottom: "6px" }}>{cleanSubject(card.draft_subject)}</div>
            <div style={{ fontSize: "13px", color: T.muted, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{cleanBody(card.draft_body)}</div>
          </div>

          {/* Pre-call brief — lazy generation on replied cards, stored in sessionMemory */}
          {card.status === "replied" && <PreCallBrief card={card} prospect={card.prospect || {}} />}

          {/* Their reply */}
          {card.reply_body && (
            <div style={{ background: `${T.pink}0D`, borderRadius: "8px", padding: "12px", borderLeft: `3px solid ${T.pink}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                <span style={{ fontSize: "11px", fontWeight: 600, color: T.pink }}>{card.reply_from?.split("<")[0].trim() || "Prospect"}</span>
                <span style={{ fontSize: "10px", color: T.faint }}>{timeAgo(card.replied_at)}</span>
              </div>
              <div style={{ fontSize: "13px", color: T.ink, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{cleanReplyBody(card.reply_body)}</div>
            </div>
          )}

          {/* Your reply draft */}
          <div style={{ background: T.goldSoft, borderRadius: "8px", padding: "12px", border: `1px dashed ${T.goldLine}` }}>
            <div style={{ fontSize: "11px", fontWeight: 600, color: T.goldHi, marginBottom: "8px" }}>✦ Your Reply Draft</div>
            <input
              value={replySubject}
              onChange={(e) => setReplySubject(e.target.value)}
              style={{ width: "100%", background: T.subtle, border: `1px solid ${T.line}`, borderRadius: "7px", padding: "7px 10px", fontSize: "12px", fontWeight: 600, color: T.ink, outline: "none", boxSizing: "border-box", marginBottom: "8px" }}
            />
            <textarea
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
              rows={6}
              placeholder="AI reply draft will appear here…"
              style={{ width: "100%", background: T.subtle, border: `1px solid ${T.line}`, borderRadius: "7px", padding: "8px 10px", fontSize: "13px", color: T.ink, lineHeight: 1.65, outline: "none", resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" }}
            />
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 20px", borderTop: `1px solid ${T.lineSoft}`, display: "flex", gap: "8px", alignItems: "center" }}>
          <button onClick={handleSend} disabled={sending || !replyBody} style={{ flex: 1, padding: "10px", background: sending ? T.raised : `${T.pink}18`, border: `1px solid ${T.pink}40`, borderRadius: "8px", color: sending ? T.muted : T.pink, fontSize: "13px", fontWeight: 600, cursor: sending ? "not-allowed" : "pointer" }}>
            {sending ? "Sending…" : "↗ Send Reply"}
          </button>
          <button onClick={onClose} style={{ padding: "10px 16px", background: "transparent", border: `1px solid ${T.lineSoft}`, borderRadius: "8px", color: T.muted, fontSize: "13px", cursor: "pointer" }}>
            Close
          </button>
          {status && <span style={{ fontSize: "12px", color: status.startsWith("✓") ? T.greenHi : T.red }}>{status}</span>}
        </div>
      </div>
    </div>
  );
}


export function StatusBadge({ status }) {
  const map = {
    prospected: { label: "Prospected", color: T.muted },
    draft: { label: "Draft", color: T.amberHi },
    draft_ready: { label: "Draft", color: T.amberHi },
    sent: { label: "Sent", color: T.blue },
    replied: { label: "Replied", color: T.pink },
    meeting: { label: "📅 Meeting", color: T.green },
    approved: { label: "Approved", color: T.green },
    rejected: { label: "Rejected", color: T.red },
    snoozed: { label: "Snoozed", color: T.violet },
  };
  const s = map[status] || map.prospected;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "10px", fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: s.color, background: "rgba(255,255,255,0.03)", border: `1px solid ${T.line}`, padding: "2px 8px 2px 6px", borderRadius: "20px", fontFamily: T.fontDisplay }}>
      <span style={{ width: "4px", height: "4px", borderRadius: "50%", background: s.color, flexShrink: 0, boxShadow: `0 0 4px ${s.color}` }} />
      {s.label}
    </span>
  );
}


export function ToneMemoryPanel({ toneMemory, onAdd, onDelete }) {
  const [input, setInput] = useState("");
  const handleAdd = async () => {
    if (!input.trim()) return;
    await onAdd(input.trim());
    setInput("");
  };
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.lineInk}`, borderRadius: "12px", padding: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
        <span style={{ fontSize: "14px" }}>🧠</span>
        <span style={{ fontSize: "13px", fontWeight: 600, color: T.ink }}>Tone Memory</span>
        <span style={{ fontSize: "11px", color: T.muted, marginLeft: "auto" }}>{toneMemory.length} rule{toneMemory.length !== 1 ? "s" : ""}</span>
      </div>
      <p style={{ fontSize: "11px", color: T.faint, margin: "0 0 12px", lineHeight: 1.5 }}>
        Rules here get injected into every future draft. The agent learns as you go.
      </p>
      {toneMemory.length > 0 && (
        <ul style={{ margin: "0 0 12px", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "6px" }}>
          {toneMemory.map((t) => (
            <li key={t.id} style={{ fontSize: "12px", color: T.muted, padding: "8px 11px", background: T.subtle, borderRadius: "7px", borderLeft: `2px solid ${T.goldLine}`, display: "flex", alignItems: "flex-start", gap: "8px" }}>
              <span style={{ flex: 1, lineHeight: 1.5 }}>{t.feedback_text}</span>
              <button
                onClick={() => onDelete(t.id)}
                style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: "14px", lineHeight: 1, padding: "0", flexShrink: 0 }}
                title="Remove rule"
              >×</button>
            </li>
          ))}
        </ul>
      )}
      {toneMemory.length === 0 && (
        <p style={{ fontSize: "12px", color: T.faint, margin: "0 0 12px", fontStyle: "italic" }}>No rules yet.</p>
      )}
      <div style={{ display: "flex", gap: "8px" }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder='e.g. Never start with "I"'
          style={{ flex: 1, background: T.subtle, border: `1px solid ${T.lineSoft}`, borderRadius: "6px", padding: "7px 10px", fontSize: "12px", color: T.ink, outline: "none" }}
        />
        <button onClick={handleAdd} style={{ background: T.gold, border: "none", borderRadius: "6px", padding: "7px 14px", fontSize: "12px", fontWeight: 600, color: T.textOnBrand, cursor: "pointer" }}>
          Add
        </button>
      </div>
    </div>
  );
}


export function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={handleCopy} style={{ padding: "5px 10px", background: "transparent", border: `1px solid ${T.line}`, borderRadius: "5px", color: copied ? T.greenHi : T.muted, fontSize: "11px", cursor: "pointer" }}>
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}


// ─── Quick Send Strip ─────────────────────────────────────────────────────────
// Extracted as its own component so its useState is unconditional — fixes
// the "hooks called conditionally" bug from the inline IIFE version.
// onQuickSend runs the card's REAL send flow (sendEmail + mark sent). The old
// wiring passed onMarkSent(card) — the card object where an id belongs, and no
// actual email send — so the "✓ Yes" button had never worked.
export function QuickSendStrip({ subject, contact, card, onQuickSend, body }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const angle = draftAngle(body);
  return (
    <div style={{ borderTop: `1px solid ${T.lineSoft}`, padding: "6px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", background: `${T.amberHi}08` }}>
      <span style={{ display: "flex", alignItems: "center", gap: "7px", overflow: "hidden", maxWidth: "62%" }}>
        {angle && <span title="Angle this draft took" style={{ fontSize: "8px", fontWeight: 700, color: angle.color, background: angle.color + "14", padding: "1px 6px", borderRadius: "10px", textTransform: "uppercase", letterSpacing: "0.05em", flexShrink: 0, fontFamily: T.fontDisplay }}>{angle.label}</span>}
        <span style={{ fontSize: "10px", color: T.faint, fontFamily: T.fontMono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cleanSubject(subject) || "Draft ready"}</span>
      </span>
      {!confirmOpen ? (
        <button onClick={e => { e.stopPropagation(); setConfirmOpen(true); }}
          style={{ fontSize: "10px", fontWeight: 700, color: T.amber, background: `${T.amber}14`, border: `1px solid ${T.amber}33`, borderRadius: "6px", padding: "3px 10px", cursor: "pointer", fontFamily: T.fontDisplay, letterSpacing: "0.04em", flexShrink: 0 }}>
          → Send
        </button>
      ) : (
        <div style={{ display: "flex", gap: "5px", alignItems: "center", flexShrink: 0 }} onClick={e => e.stopPropagation()}>
          <span style={{ fontSize: "10px", color: T.muted }}>Send to {(contact.email || "").split("@")[0]}?</span>
          <button onClick={async e => { e.stopPropagation(); setConfirmOpen(false); await onQuickSend(); }}
            style={{ fontSize: "10px", fontWeight: 700, color: T.textOnBrand, background: T.green, border: "none", borderRadius: "6px", padding: "3px 10px", cursor: "pointer" }}>✓ Yes</button>
          <button onClick={e => { e.stopPropagation(); setConfirmOpen(false); }}
            style={{ fontSize: "10px", color: T.faint, background: "none", border: "none", cursor: "pointer" }}>✗</button>
        </div>
      )}
    </div>
  );
}


// ─── Pre-Call Brief ───────────────────────────────────────────────────────────
// Extracted as its own component — same hooks-rule fix as QuickSendStrip above.
export function PreCallBrief({ card, prospect }) {
  const briefKey = `brief_${card.id}`;
  const [brief, setBrief] = useState(() => sm.get(briefKey));
  const [gen, setGen] = useState(false);

  const generate = async () => {
    setGen(true);
    try {
      const nk = (prospect.business_name || "").toLowerCase().replace(/\s+/g, "_");
      const la = sm.get(`analysis_${nk}`);
      const p = `Pre-call brief for paid search sales call.\nProspect: ${prospect.business_name} (${prospect.category})\n${la ? `Account intel: ${la.signal} — ${la.topFinding}\n` : ""}Email sent: ${card.draft_subject}\nReply: ${(card.reply_body || "").slice(0, 250)}\nReturn JSON only: {"bullets":["specific point 1","specific point 2","specific point 3"],"angle":"one sentence call angle"}`;
      const r = await callClaude({ model: "claude-haiku-4-5-20251001", max_tokens: 400, system: [{ type: "text", text: ANALYST_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: p }], fn: "pre_call_brief", promptChars: p.length });
      const parsed = JSON.parse((r.text || "{}").replace(/```json|```/g, "").trim());
      sm.set(briefKey, parsed);
      setBrief(parsed);
    } catch {}
    setGen(false);
  };

  const regenerate = () => { sm.del(briefKey); setBrief(null); };

  return (
    <div style={{ marginBottom: "12px", background: `${T.pink}0A`, border: `1px solid ${T.pink}26`, borderRadius: "8px", padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: brief ? "10px" : 0 }}>
        <span style={{ fontSize: "9px", fontWeight: 700, color: T.pink, textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: T.fontDisplay }}>Pre-Call Brief</span>
        {!brief && <button onClick={generate} disabled={gen} style={{ fontSize: "10px", fontWeight: 600, color: T.pink, background: `${T.pink}10`, border: `1px solid ${T.pink}30`, borderRadius: "4px", padding: "3px 8px", cursor: gen ? "not-allowed" : "pointer" }}>{gen ? "Generating…" : "✦ Generate"}</button>}
      </div>
      {brief && (<div>
        {brief.angle && <div style={{ fontSize: "11px", fontWeight: 600, color: T.ink, marginBottom: "8px" }}>{brief.angle}</div>}
        {(brief.bullets || []).map((b, i) => <div key={i} style={{ display: "flex", gap: "7px", marginBottom: "5px" }}><span style={{ color: T.pink, fontWeight: 700, fontSize: "10px", flexShrink: 0 }}>→</span><span style={{ fontSize: "11px", color: T.muted, lineHeight: 1.55 }}>{b}</span></div>)}
        <button onClick={regenerate} style={{ marginTop: "6px", fontSize: "9px", color: T.faint, background: "none", border: "none", cursor: "pointer", padding: 0 }}>↻ Regenerate</button>
      </div>)}
    </div>
  );
}


export function OutreachCard({ card, toneMemory, onStatusChange, onDraftRegenerate, onToneFeedback, onEnrich, onMarkSent, isDupeName, isDupeEmail, isSelected, onToggleSelect }) {
  const [expanded, setExpanded] = useState(false);
  const [editingDraft, setEditingDraft] = useState(false);
  const [subject, setSubject] = useState(cleanSubject(card.draft_subject || ""));
  const [body, setBody] = useState(cleanBody(card.draft_body || ""));
  const [feedbackInput, setFeedbackInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState("");
  const [error, setError] = useState("");
  const [replySubject, setReplySubject] = useState(card.reply_draft_subject || "");
  const [replyBody, setReplyBody] = useState(card.reply_draft || "");
  const [sendingReply, setSendingReply] = useState(false);
  const [replyStatus, setReplyStatus] = useState("");
  const [showThread, setShowThread] = useState(false);
  const [showIntel, setShowIntel] = useState(false);

  useEffect(() => {
    setSubject(cleanSubject(card.draft_subject || ""));
    setBody(cleanBody(card.draft_body || ""));
  }, [card.draft_subject, card.draft_body]);

  useEffect(() => {
    setReplySubject(card.reply_draft_subject || "");
    setReplyBody(cleanBody(card.reply_draft || ""));
  }, [card.reply_draft_subject, card.reply_draft]);

  const prospect = card.prospect || {};
  const contact = card.contact || {};
  const hasDraft = !!(subject || body);
  // isSent: first email has gone out; switch to follow-up mode
  const isSent = !!card.sent_at;

  const handleGenerate = async () => {
    setGenerating(true);
    setError("");
    try {
      let draft;
      if (isSent) {
        // Generate a follow-up in the same thread
        draft = await generateFollowUpDraft(prospect, contact, cleanSubject(card.draft_subject), cleanBody(card.draft_body), toneMemory);
      } else {
        draft = await generateDraft(prospect, contact, toneMemory);
      }
      const s = draft.subject || "";
      const b = draft.body || "";
      setSubject(s);
      setBody(b);
      await onDraftRegenerate(card.id, s, b);
    } catch (err) {
      setError("Generation failed. Check your API key.");
      console.error(err);
    }
    setGenerating(false);
  };

  const handleFeedbackSubmit = async () => {
    if (!feedbackInput.trim()) return;
    await onToneFeedback(feedbackInput.trim(), card.id);
    setFeedbackInput("");
  };

  const handleSaveDraft = async () => {
    await onDraftRegenerate(card.id, subject, body);
    setEditingDraft(false);
  };

  const handleGenerateFollowUp = async () => {
    setGenerating(true);
    setError("");
    try {
      const draft = await generateFollowUpDraft(
        prospect, contact,
        cleanSubject(card.draft_subject),
        cleanBody(card.draft_body),
        toneMemory
      );
      const s = draft.subject || `Re: ${cleanSubject(card.draft_subject)}`;
      const b = draft.body || "";
      setReplySubject(s);
      setReplyBody(b);
      await db.saveReplyDraft(card.id, s, b);
    } catch (err) {
      setError("Follow-up generation failed.");
      console.error(err);
    }
    setGenerating(false);
  };

  const handleSendFollowUp = async () => {
    if (!replyBody) return;
    setSending(true);
    setSendStatus("");
    try {
      const fuSubject = replySubject || `Re: ${cleanSubject(card.draft_subject)}`;
      const fuBody = cleanBody(replyBody);
      const result = await sendEmail({
        to: contact.email,
        subject: fuSubject,
        body: fuBody,
        replyToMessageId: card.gmail_rfc_message_id || card.gmail_message_id,
        threadId: card.gmail_thread_id,
      });
      await onMarkSent(card.id, result.messageId, result.threadId, result.rfcMessageId, { kind: "followup", subject: fuSubject, body: fuBody });
      setSendStatus(result.method === "gmail_compose" ? "✓ Opened follow-up in Gmail" : `✓ Follow-up sent${sendMode.isLive() ? "" : " (safe mode)"}`);
    } catch (err) {
      setSendStatus("Send failed: " + err.message);
    }
    setSending(false);
  };

  const handleSendReply = async () => {
    if (!replyBody) return;
    setSendingReply(true);
    try {
      const rSubject = replySubject || `Re: ${cleanSubject(subject)}`;
      const rBody = cleanBody(replyBody);
      const result = await sendEmail({
        to: contact.email,
        subject: rSubject,
        body: rBody,
        replyToMessageId: card.reply_gmail_message_id || card.gmail_rfc_message_id,
        threadId: card.gmail_thread_id,
      });
      setReplyStatus(result.method === "gmail_compose" ? "✓ Opened in Gmail" : "✓ Reply sent!");
      // Route through onMarkSent so the ledger records the reply, gmail ids
      // stay current, stale queue drafts get superseded, and status flips to
      // sent — the same transition the old onStatusChange path made.
      await onMarkSent(card.id, result.messageId, result.threadId, result.rfcMessageId, { kind: "reply", subject: rSubject, body: rBody });
    } catch (err) {
      setReplyStatus("Failed: " + err.message);
    }
    setSendingReply(false);
  };

  const handleSend = async () => {
    if (!contact.email) { setSendStatus("No email address on file"); return; }
    if (!subject || !body) { setSendStatus("Draft is empty — generate one first"); return; }
    setSending(true);
    setSendStatus("");
    try {
      // If already sent, reply in the same thread as follow-up
      const isFollowUp = !!card.sent_at;
      const result = await sendEmail({
        to: contact.email,
        subject: cleanSubject(subject),
        body: cleanBody(body),
        replyToMessageId: isFollowUp ? (card.gmail_rfc_message_id || card.gmail_message_id) : undefined,
        threadId: isFollowUp ? card.gmail_thread_id : undefined,
      });
      await onMarkSent(card.id, result.messageId, result.threadId, result.rfcMessageId, { kind: isFollowUp ? "followup" : "initial", subject: cleanSubject(subject), body: cleanBody(body) });
      if (result.method === "gmail_compose") {
        setSendStatus(isFollowUp ? "✓ Opened follow-up in Gmail" : "✓ Opened in Gmail — mark as sent when you send it");
      } else {
        setSendStatus(isFollowUp ? `✓ Follow-up sent${sendMode.isLive() ? "" : " (safe mode)"}` : `✓ Sent${sendMode.isLive() ? "" : " (safe mode)"}`);
      }
    } catch (err) {
      setSendStatus("Send failed: " + err.message);
    }
    setSending(false);
  };

  const STATUS_COLORS = {
    prospected: T.muted, draft: T.amberHi, draft_ready: T.amberHi,
    sent: T.blue, replied: T.pink, meeting: T.green, approved: T.green,
    snoozed: T.violet, rejected: T.red,
  };
  const statusColor = STATUS_COLORS[card.status] || T.muted;
  const confidenceColor = contact.email_confidence_score > 70 ? T.greenHi : contact.email_confidence_score > 50 ? T.amberHi : T.red;

  // Urgency: time since last outbound contact
  const lastContactDate = card.replied_at || card.sent_at;
  const urgency = (() => {
    if (!lastContactDate) return null;
    const days = Math.floor((Date.now() - new Date(lastContactDate).getTime()) / 86400000);
    if (days >= 7) return { label: `${days}d overdue`, color: T.red, bg: `${T.red}15`, dot: "●" };
    if (days >= 3) return { label: `${days}d ago`, color: T.amberHi, bg: `${T.amberHi}15`, dot: "●" };
    if (days === 0) return { label: "Today", color: T.greenHi, bg: `${T.greenHi}15`, dot: "●" };
    return { label: `${days}d ago`, color: T.greenHi, bg: `${T.greenHi}15`, dot: "●" };
  })();

  // Parse callouts — structured columns first, fallback to parsing website_context
  const callouts = (() => {
    try {
      const parsed = JSON.parse(prospect.brief_callouts || "[]");
      if (parsed.length > 0) return parsed;
    } catch {}
    // Fallback: extract KEY CALLOUTS block from website_context
    const ctx = prospect.website_context || "";
    const match = ctx.match(/KEY CALLOUTS:\n([\s\S]+?)(?:\n\nWEBSITE CONTENT|$)/);
    if (match) return match[1].split("\n").filter(l => l.startsWith("- ")).map(l => l.slice(2).trim());
    return [];
  })();
  const linkedinUrl = prospect.linkedin_url || null;
  const prospectBriefSummary = prospect.prospect_brief || (() => {
    // Fallback: extract RESEARCH BRIEF block from website_context
    const ctx = prospect.website_context || "";
    const match = ctx.match(/RESEARCH BRIEF:\n([\s\S]+?)(?:\n\nKEY CALLOUTS|\n\nWEBSITE CONTENT|$)/);
    return match ? match[1].trim() : null;
  })();
  // Thread is visible whenever a reply exists, regardless of current status
  const hasThread = !!card.reply_body;

  return (
    <>
    <div style={{
      background: isSelected ? T.goldSoft : T.surface,
      border: `1px solid ${isSelected ? T.goldLine : T.lineInk}`,
      borderLeft: (() => {
        if (isSelected) return `3px solid ${T.gold}`;
        if (["prospected","draft"].includes(card.status)) {
          const pri = getProspectPriority(card);
          if (pri.tier === "Hot") return `3px solid ${T.red}`;
          if (pri.tier === "Warm") return `3px solid ${T.amber}`;
        }
        return `3px solid ${statusColor}`;
      })(),
      borderRadius: "11px",
      overflow: "hidden",
      boxShadow: T.shadowCard,
      transition: `box-shadow ${T.durBase} ${T.easeOut}, transform ${T.durBase} ${T.easeOut}`,
    }}
      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = T.shadowHover; e.currentTarget.style.transform = "translateY(-1px)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = T.shadowCard; e.currentTarget.style.transform = "none"; }}
    >
      {/* Header */}
      <div style={{ padding: "14px 16px 12px", cursor: "pointer" }}
        onClick={() => setExpanded(!expanded)}
        onDoubleClick={() => hasThread && setShowThread(true)}
      >
        {/* Top row: name + urgency pill */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", marginBottom: "6px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap" }}>
              <span style={{ fontSize: "13px", fontWeight: 600, color: T.ink, letterSpacing: "-0.01em", fontFamily: T.fontDisplay }}>{prospect.business_name || "Unknown"}</span>
              <StatusBadge status={card.status} />
              {["prospected","draft"].includes(card.status) && (() => {
                const pri = getProspectPriority(card);
                if (pri.tier === "Cold") return null;
                return <span style={{ fontSize: "9px", fontWeight: 700, color: pri.color, background: pri.bg, border: `1px solid ${pri.border}`, padding: "1px 7px", borderRadius: "20px", letterSpacing: "0.07em", textTransform: "uppercase", fontFamily: T.fontDisplay }}>{pri.tier}</span>;
              })()}
              {card.status === "replied" && card.reply_body && (() => {
                const cls = classifyReply(card.reply_body);
                return <span title="Reply sentiment (auto-classified)" style={{ fontSize: "9px", fontWeight: 700, color: cls.color, background: cls.bg, padding: "1px 7px", borderRadius: "20px", letterSpacing: "0.05em", textTransform: "uppercase", fontFamily: T.fontDisplay }}>{cls.label}</span>;
              })()}
              {isDupeName && (
                <span title="Another business with this name" style={{ fontSize: "10px", fontWeight: 600, color: T.amberHi, background: `${T.amberHi}15`, padding: "2px 6px", borderRadius: "4px" }}>⚠ MULTI</span>
              )}
              {isDupeEmail && (
                <span title="Email used by another prospect" style={{ fontSize: "10px", fontWeight: 600, color: T.red, background: `${T.red}15`, padding: "2px 6px", borderRadius: "4px" }}>⚠ DUPE</span>
              )}
              {hasThread && (
                <span onClick={(e) => { e.stopPropagation(); setShowThread(true); }} style={{ fontSize: "10px", fontWeight: 600, color: T.pink, background: `${T.pink}18`, padding: "2px 6px", borderRadius: "4px", cursor: "pointer" }}>
                  💬 Thread
                </span>
              )}
              {!!(prospectBriefSummary || callouts.length > 0 || linkedinUrl || prospect.website_context) && (
                <span onClick={(e) => { e.stopPropagation(); setShowIntel(!showIntel); }} style={{ fontSize: "10px", fontWeight: 600, color: showIntel ? T.goldHi : T.gold, background: showIntel ? `${T.gold}18` : `${T.gold}0C`, padding: "2px 6px", borderRadius: "4px", cursor: "pointer", border: `1px solid ${showIntel ? `${T.gold}30` : `${T.gold}2E`}` }}>
                  ✦ Intel
                </span>
              )}
            </div>
          </div>
          {/* Urgency pill */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
            {urgency && (
              <span style={{ fontSize: "10px", fontWeight: 500, color: urgency.color, background: "rgba(255,255,255,0.03)", border: `1px solid ${urgency.color}30`, padding: "3px 9px", borderRadius: "20px", letterSpacing: "0.03em", fontFamily: T.fontMono }}>
                {urgency.dot} {urgency.label}
              </span>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {onToggleSelect && (
                <span onClick={(e) => { e.stopPropagation(); onToggleSelect(card.id); }}
                  style={{ width: "16px", height: "16px", borderRadius: "4px", border: `1.5px solid ${isSelected ? T.gold : T.line}`, background: isSelected ? T.gold : "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, fontSize: "10px", color: T.textOnBrand }}>
                  {isSelected ? "✓" : ""}
                </span>
              )}
              <span style={{ color: T.faint, fontSize: "10px" }}>{expanded ? "▲" : "▼"}</span>
            </div>
          </div>
        </div>

        {/* Compact info row */}
        <div style={{ fontSize: "11px", color: T.muted, display: "flex", alignItems: "center", gap: "5px", flexWrap: "wrap", marginTop: "4px" }}>
          {prospect.category && <span>{prospect.category}</span>}
          {contact.name && <><span style={{ color: T.ghost }}>·</span><span style={{ color: T.muted }}>{contact.name}</span></>}
          {contact.email && <><span style={{ color: T.ghost }}>·</span><span style={{ color: T.faint }}>{contact.email}</span></>}
          {contact.email_confidence_score && (
            <span style={{ color: confidenceColor, fontWeight: 700, fontSize: "10px" }}>{contact.email_confidence_score}%</span>
          )}
          {prospect.ads_detected === true && (
            <span title="Running Google Ads right now — already spending, highest buying intent" style={{ fontSize: "10px", fontWeight: 700, color: T.red, background: `${T.red}15`, border: `1px solid ${T.red}35`, padding: "1px 7px", borderRadius: "4px", marginLeft: "2px" }}>
              ⚡ Ads Live
            </span>
          )}
          {prospect.ads_detected === false && prospect.website_context && (
            <span title="No Google Ads tracking detected on their site" style={{ fontSize: "10px", color: T.faint, background: T.subtle, border: `1px solid ${T.lineSoft}`, padding: "1px 6px", borderRadius: "4px", marginLeft: "2px" }}>
              No Ads
            </span>
          )}
          {(() => {
            // Richer marketing signals from the deeper scrape — quick read on sophistication.
            let sig = {}; try { sig = JSON.parse(prospect.marketing_signals || "{}"); } catch {}
            const chips = [
              sig.meta_pixel && { l: "Meta Pixel", c: T.blueDeep },
              sig.conversion_tracking && { l: "Conv. Tracking", c: T.green },
              sig.call_tracking && { l: "Call Tracking", c: T.violet },
              sig.booking_widget && { l: "Booking", c: T.amber },
            ].filter(Boolean);
            return chips.map((ch, i) => (
              <span key={i} title={`${ch.l} detected on their site`} style={{ fontSize: "9px", fontWeight: 600, color: ch.c, background: ch.c + "12", border: `1px solid ${ch.c}25`, padding: "1px 6px", borderRadius: "4px", marginLeft: "2px" }}>{ch.l}</span>
            ));
          })()}
          {prospect.screenshot_url && (
            <a href={prospect.screenshot_url} target="_blank" rel="noopener" title="View their landing page screenshot" style={{ fontSize: "9px", fontWeight: 600, color: T.muted, background: T.subtle, border: `1px solid ${T.line}`, padding: "1px 6px", borderRadius: "4px", marginLeft: "2px", textDecoration: "none" }}>📷 Page</a>
          )}
        </div>

        {/* Round 5: why-now reason line on prospect & draft cards */}
        {["prospected","draft","draft_ready"].includes(card.status) && <WhyNowLine card={card} />}

        {/* Fix 2: Quick-send strip — only on Draft cards with a generated email */}
        {(card.status === "draft" || card.status === "draft_ready") && hasDraft && !expanded && (
          <QuickSendStrip subject={subject} contact={contact} card={card} onQuickSend={handleSend} body={body} />
        )}
      </div>

      {/* Intel drawer — toggled by badge, sits between header and expanded body */}
      {showIntel && (
        <div style={{ borderTop: `1px solid ${T.lineSoft}`, background: T.subtle, padding: "14px 16px" }}>
          {prospectBriefSummary && (
            <p style={{ fontSize: "12px", color: T.muted, lineHeight: 1.65, margin: "0 0 10px" }}>{prospectBriefSummary}</p>
          )}
          {callouts.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "5px", marginBottom: linkedinUrl ? "10px" : "0" }}>
              {callouts.map((c, i) => (
                <div key={i} style={{ display: "flex", gap: "7px", alignItems: "flex-start" }}>
                  <span style={{ color: T.gold, fontSize: "10px", marginTop: "3px", flexShrink: 0 }}>✦</span>
                  <span style={{ fontSize: "12px", color: T.muted, lineHeight: 1.5 }}>{c}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: callouts.length > 0 ? "10px" : "0" }}>
            {linkedinUrl && (
              <a href={linkedinUrl} target="_blank" rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", fontWeight: 600, color: T.blue, background: `${T.blue}10`, border: `1px solid ${T.blue}25`, borderRadius: "6px", padding: "4px 10px", textDecoration: "none" }}>
                in Company →
              </a>
            )}
            {contact.name && (
              <a href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(contact.name + " " + prospect.business_name)}`}
                target="_blank" rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", fontWeight: 600, color: T.blueDeep, background: `${T.blueDeep}10`, border: `1px solid ${T.blueDeep}25`, borderRadius: "6px", padding: "4px 10px", textDecoration: "none" }}>
                in Find {contact.name} →
              </a>
            )}
          </div>
        </div>
      )}

      {/* Expanded body */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${T.lineSoft}`, padding: "16px" }}>

          {/* Follow-up cadence — only for sent threads awaiting reply */}
          {isSent && card.status !== "replied" && (
            <div style={{ marginBottom: "12px" }}>
              <CadenceBar card={card} onGenerateFollowUp={handleGenerate} />
            </div>
          )}

          {/* Cross-tab intelligence bridge — reads sessionMemory, zero API cost */}
          {(() => {
            const nameKey = (prospect.business_name || "").toLowerCase().replace(/\s+/g, "_");
            const lastAnalysis = sm.get(`analysis_${nameKey}`);
            if (!lastAnalysis) return null;
            const SC = { needs_attention: T.red, stable: T.amber, performing: T.green };
            const sc = SC[lastAnalysis.signal] || T.muted;
            const ago = (() => { const d = Date.now() - new Date(lastAnalysis.date).getTime(); const h = Math.floor(d/3600000); return h < 24 ? `${h}h ago` : `${Math.floor(h/24)}d ago`; })();
            return (
              <div style={{ marginBottom: "12px", padding: "10px 12px", background: `${sc}08`, border: `1px solid ${sc}22`, borderRadius: "8px", display: "flex", gap: "10px", alignItems: "flex-start" }}>
                <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: sc, flexShrink: 0, marginTop: "4px", boxShadow: `0 0 5px ${sc}80` }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "9px", fontWeight: 700, color: sc, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: T.fontDisplay, marginBottom: "3px" }}>Last Analysis · {ago}</div>
                  <div style={{ fontSize: "11px", color: T.muted, lineHeight: 1.5 }}>{lastAnalysis.topFinding || (lastAnalysis.summary || "").slice(0, 100)}</div>
                </div>
              </div>
            );
          })()}

          {/* Inline thread view — visible whenever email has been sent */}
          {card.sent_at && (
            <div style={{ marginBottom: "14px" }}>
              <div style={{ fontSize: "10px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontFamily: T.fontDisplay, letterSpacing: "0.08em" }}>Conversation</span>
                <button onClick={() => setShowThread(true)} style={{ fontSize: "10px", fontWeight: 600, color: T.pink, background: `${T.pink}10`, border: `1px solid ${T.pink}30`, borderRadius: "4px", padding: "2px 8px", cursor: "pointer" }}>
                  Open full thread
                </button>
              </div>
              {/* Their original email */}
              <div style={{ background: `${T.blue}0A`, borderLeft: `2px solid ${T.blue}99`, borderRadius: "0 6px 6px 0", padding: "10px 12px", marginBottom: "6px" }}>
                <div style={{ fontSize: "10px", fontWeight: 600, color: T.blue, marginBottom: "5px" }}>
                  You → {contact.email} · {timeAgo(card.sent_at)}
                </div>
                <div style={{ fontSize: "11px", fontWeight: 600, color: T.muted, marginBottom: "4px" }}>{cleanSubject(card.draft_subject)}</div>
                <div style={{ fontSize: "12px", color: T.muted, lineHeight: 1.6, whiteSpace: "pre-wrap", maxHeight: "80px", overflow: "hidden", maskImage: "linear-gradient(to bottom, black 60%, transparent 100%)" }}>{cleanBody(card.draft_body)}</div>
              </div>
              {/* Their reply */}
              {card.reply_body && (
                <div style={{ background: `${T.pink}0D`, borderLeft: `2px solid ${T.pink}99`, borderRadius: "0 6px 6px 0", padding: "10px 12px", marginBottom: "6px" }}>
                  <div style={{ fontSize: "10px", fontWeight: 600, color: T.pink, marginBottom: "5px" }}>
                    {card.reply_from?.split("<")[0].trim() || "Prospect"} · {timeAgo(card.replied_at)}
                  </div>
                  <div style={{ fontSize: "12px", color: T.ink, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{cleanReplyBody(card.reply_body)}</div>
                </div>
              )}
              {/* Follow-up sent indicator */}
              {card.status === "sent" && card.replied_at && (
                <div style={{ fontSize: "10px", color: T.blue, background: `${T.blue}10`, border: `1px solid ${T.blue}20`, borderRadius: "6px", padding: "6px 10px" }}>
                  ↗ Follow-up sent · waiting for response
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{ padding: "8px 12px", background: `${T.red}18`, border: `1px solid ${T.red}40`, borderRadius: "6px", color: T.red, fontSize: "12px", marginBottom: "12px" }}>
              {error}
            </div>
          )}

          {/* Draft section — initial outreach OR follow-up depending on send state */}
          {!isSent && !hasDraft && (
            <button onClick={handleGenerate} disabled={generating} style={{ width: "100%", padding: "10px", marginBottom: "14px", background: generating ? T.subtle : `${T.gold}12`, border: `1px solid ${T.gold}33`, borderRadius: "8px", color: generating ? T.faint : T.gold, fontSize: "12px", fontWeight: 600, cursor: generating ? "not-allowed" : "pointer", letterSpacing: "0.02em" }}>
              {generating ? "Writing draft…" : "✦ Generate Draft"}
            </button>
          )}

          {/* Initial outreach draft — only before sending */}
          {!isSent && hasDraft && (
            <div style={{ marginBottom: "14px" }}>
              <div style={{ fontSize: "11px", color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "8px" }}>Draft</div>
              {editingDraft ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject line"
                    style={{ background: T.subtle, border: `1px solid ${T.line}`, borderRadius: "7px", padding: "8px 10px", fontSize: "13px", fontWeight: 600, color: T.ink, outline: "none", width: "100%", boxSizing: "border-box" }} />
                  <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8}
                    style={{ background: T.subtle, border: `1px solid ${T.line}`, borderRadius: "7px", padding: "8px 10px", fontSize: "13px", color: T.faint, lineHeight: 1.65, outline: "none", resize: "vertical", fontFamily: "inherit", width: "100%", boxSizing: "border-box" }} />
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button onClick={handleSaveDraft} style={{ flex: 1, padding: "8px", background: `${T.greenHi}18`, border: `1px solid ${T.greenHi}40`, borderRadius: "6px", color: T.greenHi, fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>Save</button>
                    <button onClick={() => { setEditingDraft(false); setSubject(cleanSubject(card.draft_subject || "")); setBody(cleanBody(card.draft_body || "")); }} style={{ flex: 1, padding: "8px", background: "rgba(255,255,255,0.04)", border: `1px solid ${T.line}`, borderRadius: "6px", color: T.muted, fontSize: "12px", cursor: "pointer" }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div style={{ background: T.subtle, borderRadius: "8px", padding: "12px", border: `1px solid ${T.lineInk}` }}>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: T.ink, marginBottom: "10px" }}>{subject}</div>
                  <div style={{ fontSize: "13px", color: T.muted, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{body}</div>
                  <div style={{ display: "flex", gap: "8px", marginTop: "12px", borderTop: `1px solid ${T.lineSoft}`, paddingTop: "10px" }}>
                    <button onClick={() => setEditingDraft(true)} style={{ padding: "5px 10px", background: "transparent", border: `1px solid ${T.line}`, borderRadius: "5px", color: T.muted, fontSize: "11px", cursor: "pointer" }}>Edit</button>
                    <button onClick={handleGenerate} disabled={generating} style={{ padding: "5px 10px", background: "transparent", border: `1px solid ${T.line}`, borderRadius: "5px", color: generating ? T.faint : T.muted, fontSize: "11px", cursor: generating ? "not-allowed" : "pointer" }}>
                      {generating ? "Writing…" : "Regenerate"}
                    </button>
                    <CopyButton text={`Subject: ${subject}

${body}`} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Follow-up draft — shown after first email sent, no reply yet */}
          {isSent && !hasThread && (
            <div style={{ marginBottom: "14px" }}>
              <div style={{ fontSize: "11px", color: T.blue, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "8px" }}>↩ Follow-up Draft</div>
              {!replyBody ? (
                <button onClick={handleGenerateFollowUp} disabled={generating} style={{ width: "100%", padding: "10px", background: generating ? T.raised : `${T.blue}18`, border: `1px solid ${T.blue}40`, borderRadius: "8px", color: generating ? T.muted : T.blue, fontSize: "13px", fontWeight: 600, cursor: generating ? "not-allowed" : "pointer" }}>
                  {generating ? "Writing follow-up…" : "↩ Generate Follow-up"}
                </button>
              ) : (
                <div style={{ background: `${T.blue}0D`, borderRadius: "8px", padding: "12px", border: `1px solid ${T.blue}26` }}>
                  <div style={{ fontSize: "11px", color: `${T.blue}50`, marginBottom: "6px" }}>replies in original thread · {contact.email}</div>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: T.ink, marginBottom: "8px" }}>{replySubject}</div>
                  <textarea value={replyBody} onChange={(e) => setReplyBody(e.target.value)} rows={5}
                    style={{ width: "100%", background: "transparent", border: "none", fontSize: "13px", color: T.muted, lineHeight: 1.7, outline: "none", resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" }} />
                  <div style={{ display: "flex", gap: "8px", marginTop: "8px", borderTop: `1px solid ${T.lineSoft}`, paddingTop: "10px" }}>
                    <button onClick={handleGenerateFollowUp} disabled={generating} style={{ padding: "5px 10px", background: "transparent", border: `1px solid ${T.line}`, borderRadius: "5px", color: generating ? T.faint : T.muted, fontSize: "11px", cursor: generating ? "not-allowed" : "pointer" }}>
                      {generating ? "Writing…" : "Regenerate"}
                    </button>
                    <CopyButton text={replyBody} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Reply-to-reply — when they replied back */}
          {hasThread && card.reply_body && (
            <div style={{ marginBottom: "14px" }}>
              <div style={{ fontSize: "11px", color: T.pink, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "8px" }}>Your Reply</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <textarea value={replyBody} onChange={(e) => setReplyBody(e.target.value)} rows={4}
                  placeholder="Write your reply…"
                  style={{ background: T.subtle, border: `1px solid ${T.line}`, borderRadius: "7px", padding: "8px 10px", fontSize: "13px", color: T.faint, lineHeight: 1.65, outline: "none", resize: "vertical", fontFamily: "inherit" }}
                />
                <button onClick={handleSendReply} disabled={sendingReply || !replyBody}
                  style={{ padding: "9px 12px", background: sendingReply ? T.raised : `${T.pink}18`, border: `1px solid ${T.pink}40`, borderRadius: "8px", color: sendingReply ? T.muted : T.pink, fontSize: "13px", fontWeight: 600, cursor: sendingReply ? "not-allowed" : "pointer" }}>
                  {sendingReply ? "Sending…" : "↗ Send Reply"}
                </button>
                {replyStatus && <div style={{ fontSize: "12px", color: replyStatus.startsWith("✓") ? T.greenHi : T.red }}>{replyStatus}</div>}
              </div>
            </div>
          )}

          {/* Tone feedback */}
          <div style={{ marginBottom: "12px" }}>
            <div style={{ fontSize: "11px", color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>Tone Feedback</div>
            <div style={{ display: "flex", gap: "8px" }}>
              <input value={feedbackInput} onChange={(e) => setFeedbackInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleFeedbackSubmit()}
                placeholder="e.g. Too long, cut it in half"
                style={{ flex: 1, background: T.subtle, border: `1px solid ${T.lineSoft}`, borderRadius: "6px", padding: "7px 10px", fontSize: "12px", color: T.ink, outline: "none" }} />
              <button onClick={handleFeedbackSubmit} style={{ padding: "7px 12px", background: "rgba(255,255,255,0.04)", border: `1px solid ${T.line}`, borderRadius: "6px", color: T.muted, fontSize: "12px", cursor: "pointer" }}>Save</button>
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {!isSent && hasDraft && card.status !== "rejected" && (
              <button onClick={handleSend} disabled={sending}
                style={{ flex: 1, padding: "9px 12px", background: sending ? T.raised : T.goldGrad, border: sending ? `1px solid ${T.lineSoft}` : "none", borderRadius: "8px", color: sending ? T.faint : T.textOnBrand, fontSize: "12px", fontWeight: 700, letterSpacing: "0.03em", fontFamily: T.fontDisplay, cursor: sending ? "not-allowed" : "pointer", boxShadow: sending ? "none" : T.glowBrass }}>
                {sending ? "Sending…" : "✓ Approve & Send"}
              </button>
            )}
            {isSent && replyBody && !hasThread && (
              <button onClick={handleSendFollowUp} disabled={sending}
                style={{ flex: 1, padding: "9px 12px", background: sending ? T.raised : `${T.blue}18`, border: `1px solid ${T.blue}40`, borderRadius: "8px", color: sending ? T.faint : T.blue, fontSize: "13px", fontWeight: 600, cursor: sending ? "not-allowed" : "pointer" }}>
                {sending ? "Sending…" : "↩ Send Follow-up"}
              </button>
            )}
            {card.status !== "rejected" && (
              <button onClick={() => onStatusChange(card.id, "rejected")}
                style={{ padding: "9px 12px", background: `${T.red}0F`, border: `1px solid ${T.red}2E`, borderRadius: "8px", color: T.red, fontSize: "12px", fontWeight: 600, cursor: "pointer", letterSpacing: "0.02em" }}>
                ✕ Reject
              </button>
            )}
            {card.status !== "snoozed" && (
              <button onClick={() => onStatusChange(card.id, "snoozed")}
                style={{ padding: "9px 12px", background: "#A78BFA0F", border: "1px solid #A78BFA2E", borderRadius: "8px", color: T.violet, fontSize: "12px", cursor: "pointer" }}>
                Snooze
              </button>
            )}
          </div>

                    {/* Send status */}
          {sendStatus && (
            <div style={{ marginTop: "10px", fontSize: "12px", color: sendStatus.startsWith("✓") ? T.greenHi : T.red, padding: "6px 10px", background: sendStatus.startsWith("✓") ? `${T.greenHi}10` : `${T.red}10`, borderRadius: "6px" }}>
              {sendStatus}
            </div>
          )}
        </div>
      )}
    </div>
    {showThread && (
      <ThreadModal
        card={{ ...card, reply_draft: replyBody, reply_draft_subject: replySubject }}
        toneMemory={toneMemory}
        onClose={() => setShowThread(false)}
        onSendReply={async (c, subject, body) => {
          setSendingReply(true);
          // finally, not a trailing reset: ThreadModal catches the rejection and
          // shows its own error, so without this the latch stayed true and the
          // card's Send Reply button was stuck on "Sending…" until unmount.
          try {
            const result = await sendEmail({
              to: contact.email,
              subject,
              body: cleanBody(body),
              replyToMessageId: card.reply_gmail_message_id || card.gmail_rfc_message_id,
              threadId: card.gmail_thread_id,
            });
            await onMarkSent(card.id, result.messageId, result.threadId, result.rfcMessageId, { kind: "reply", subject, body: cleanBody(body) });
            setShowThread(false);
          } finally {
            setSendingReply(false);
          }
        }}
      />
    )}
    </>
  );
}


// Compact inline reason line for prospect cards
export function WhyNowLine({ card }) {
  const wn = whyNow(card);
  const fr = freshness(card);
  const val = estimateValue(card);
  if (!wn && !fr) return val ? (
    <div style={{ marginTop: "7px" }}>
      <span title={`Est. ${val.label} retainer if won`} style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "10px", color: T.green, background: `${T.green}14`, padding: "2px 8px", borderRadius: "6px", fontWeight: 700, fontFamily: T.fontMono }}>{fmtMoney(val.monthly)}/mo · {val.label}</span>
    </div>
  ) : null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginTop: "7px" }}>
      <span title={`Est. ${val.label} retainer if won`} style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "10px", color: T.green, background: `${T.green}14`, padding: "2px 8px", borderRadius: "6px", fontWeight: 700, fontFamily: T.fontMono, flexShrink: 0 }}>{fmtMoney(val.monthly)}/mo</span>
      {wn && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "10px", color: wn.color, background: wn.color + "0F", padding: "2px 8px", borderRadius: "6px", fontWeight: 600, lineHeight: 1.4 }}>
          <span style={{ fontSize: "9px" }}>{wn.icon}</span>{wn.text}
        </span>
      )}
      {fr && (
        <span title="How long this prospect has waited" style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "10px", color: fr.color, fontWeight: 600 }}>
          {fr.warn && <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: fr.color }} />}{fr.label}
        </span>
      )}
    </div>
  );
}


// Compact cadence indicator for a sent card
export function CadenceBar({ card, onGenerateFollowUp }) {
  const st = cadenceState(card);
  if (!st) return null;
  if (st.done) {
    return <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 12px", background: "rgba(255,255,255,0.03)", borderRadius: "8px", fontSize: "11px", color: st.color, fontWeight: 600 }}>
      <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: st.color }} />{st.label}
    </div>;
  }
  return (
    <div style={{ padding: "10px 12px", background: st.due ? `${T.amber}0F` : "rgba(255,255,255,0.03)", border: `1px solid ${st.due ? `${T.amber}33` : T.lineSoft}`, borderRadius: "8px" }}>
      {/* Cadence dots */}
      <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" }}>
        {CADENCE.map((c, i) => {
          const reached = i < st.touches;
          const isNext = i === st.touches;
          return <Fragment key={i}>
            <span title={c.label} style={{ width: "7px", height: "7px", borderRadius: "50%", background: reached ? T.blue : isNext && st.due ? T.amber : "rgba(255,255,255,0.14)", flexShrink: 0, animation: isNext && st.due ? "pulse 1.8s infinite" : "none" }} />
            {i < CADENCE.length - 1 && <span style={{ flex: 1, height: "1px", background: reached ? T.blue : T.lineSoft }} />}
          </Fragment>;
        })}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: st.due ? T.amber : T.muted, fontFamily: T.fontDisplay }}>
            {st.due ? `${st.nextLabel} due now` : `${st.nextLabel} in ${st.dueInDays}d`}
          </div>
          <div style={{ fontSize: "10px", color: T.faint, marginTop: "1px" }}>Touch {st.touches} sent · {st.daysSince}d ago{st.nextHint ? ` · ${st.nextHint}` : ""}</div>
        </div>
        {st.due && onGenerateFollowUp && (
          <button onClick={(e) => { e.stopPropagation(); onGenerateFollowUp(); }} style={{ padding: "5px 11px", background: T.amber, border: "none", borderRadius: "7px", color: "#1A1206", fontSize: "10px", fontWeight: 700, cursor: "pointer", flexShrink: 0, fontFamily: T.fontDisplay }}>✦ Draft {st.nextLabel}</button>
        )}
      </div>
    </div>
  );
}
