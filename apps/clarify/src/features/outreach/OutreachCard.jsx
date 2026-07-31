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

// Exported so the render test can mount it: it is opened by component state
// (`showThread`) on a card that already has a reply, which no cold paint of any
// route produces — and an unmounted component's body is never executed, so
// nothing in it can fail a test.
export function ThreadModal({ card, onClose, onSendReply, toneMemory }) {
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
          <button onClick={onClose} type="button" aria-label="Close thread" className="co-modal-close icon-btn">×</button>
        </div>
        <div style={{ padding: "10px 20px 0" }}><LeadJourney card={card} /></div>

        {/* Thread */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: "12px" }}>
          {/* Original outreach */}
          <div style={{ background: T.subtle, borderRadius: "8px", padding: "12px", borderLeft: `3px solid ${T.blue}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
              <span style={{ fontSize: "11px", fontWeight: 600, color: T.blue }}>You → {contact.email}</span>
              <span style={{ fontSize: "10.5px", color: T.faint }}>{timeAgo(card.sent_at)}</span>
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
                <span style={{ fontSize: "10.5px", color: T.faint }}>{timeAgo(card.replied_at)}</span>
              </div>
              <div style={{ fontSize: "13px", color: T.ink, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{cleanReplyBody(card.reply_body)}</div>
            </div>
          )}

          {/* Your reply draft */}
          <div style={{ background: T.goldSoft, borderRadius: "8px", padding: "12px", border: `1px dashed ${T.goldLine}` }}>
            <div className="t-label" style={{ color: T.goldHi, marginBottom: "8px" }}>✦ Your reply draft</div>
            <input
              value={replySubject}
              onChange={(e) => setReplySubject(e.target.value)}
              aria-label="Reply subject"
              className="field on-well" style={{ fontWeight: 600, marginBottom: "8px" }}
            />
            <textarea
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
              rows={6}
              aria-label="Reply body"
              placeholder="AI reply draft will appear here…"
              className="field on-well" style={{ lineHeight: 1.65, resize: "vertical" }}
            />
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 20px", borderTop: `1px solid ${T.lineSoft}`, display: "flex", gap: "8px", alignItems: "center" }}>
          <button onClick={handleSend} type="button" disabled={sending || !replyBody} className="btn md" style={{ flex: 1, background: `${T.pink}1F`, color: T.pink }}>
            {sending ? "Sending…" : "↗ Send reply"}
          </button>
          <button onClick={onClose} type="button" className="btn md quiet">
            Close
          </button>
          {status && <span role="status" className="t-foot" style={{ color: status.startsWith("✓") ? T.greenHi : T.red }}>{status}{status.startsWith("✓") ? "" : " — try Send reply again."}</span>}
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
    // .t-label is the language's one uppercase. The status word is always
    // spelled out next to the dot, so status is never colour alone.
    <span className="t-label" style={{ display: "inline-flex", alignItems: "center", gap: "5px", color: s.color, background: "rgba(255,255,255,0.05)", padding: "3px 9px 3px 7px", borderRadius: "20px" }}>
      <span className="dotstatus" style={{ width: "5px", height: "5px", background: s.color }} />
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
    <div className="card pad-md">
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
        <span style={{ fontSize: "14px" }}>🧠</span>
        <span className="t-call" style={{ fontWeight: 600 }}>Tone memory</span>
        <span className="t-cap" style={{ marginLeft: "auto" }}>{toneMemory.length} rule{toneMemory.length !== 1 ? "s" : ""}</span>
      </div>
      <p className="t-cap" style={{ color: T.faint, margin: "0 0 12px", lineHeight: 1.5 }}>
        Rules here get injected into every future draft. The agent learns as you go.
      </p>
      {toneMemory.length > 0 && (
        <ul style={{ margin: "0 0 12px", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "6px" }}>
          {toneMemory.map((t) => (
            <li key={t.id} style={{ fontSize: "12px", color: T.muted, padding: "8px 11px", background: T.subtle, borderRadius: "7px", borderLeft: `2px solid ${T.goldLine}`, display: "flex", alignItems: "flex-start", gap: "8px" }}>
              <span style={{ flex: 1, lineHeight: 1.5 }}>{t.feedback_text}</span>
              <button
                onClick={() => onDelete(t.id)}
                type="button" className="icon-btn" style={{ width: 28, height: 28, flexShrink: 0 }}
                title="Remove rule" aria-label="Remove rule"
              >×</button>
            </li>
          ))}
        </ul>
      )}
      {toneMemory.length === 0 && (
        <p className="t-foot" style={{ color: T.faint, margin: "0 0 12px" }}>No rules yet — add one below and every future draft is written against it.</p>
      )}
      <div style={{ display: "flex", gap: "8px" }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder='e.g. Never start with "I"'
          aria-label="New tone rule" className="field" style={{ flex: 1, width: "auto", minHeight: 34, padding: "7px 10px", fontSize: "13px" }}
        />
        <button onClick={handleAdd} type="button" className="btn sm primary">
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
    <button onClick={handleCopy} type="button" className="btn sm quiet" style={{ color: copied ? T.greenHi : T.muted }}>
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
        {angle && <span title="Angle this draft took" className="t-label" style={{ color: angle.color, background: angle.color + "14", padding: "2px 7px", borderRadius: "10px", flexShrink: 0 }}>{angle.label}</span>}
        <span className="t-cap" style={{ color: T.faint, fontFamily: T.fontMono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cleanSubject(subject) || "Draft ready"}</span>
      </span>
      {!confirmOpen ? (
        <button onClick={e => { e.stopPropagation(); setConfirmOpen(true); }} type="button"
          className="btn sm" style={{ background: `${T.amber}1F`, color: T.amber, flexShrink: 0, height: 28 }}>
          → Send
        </button>
      ) : (
        <div style={{ display: "flex", gap: "5px", alignItems: "center", flexShrink: 0 }} onClick={e => e.stopPropagation()}>
          <span className="t-cap">Send to {(contact.email || "").split("@")[0]}?</span>
          <button onClick={async e => { e.stopPropagation(); setConfirmOpen(false); await onQuickSend(); }} type="button"
            className="btn sm" style={{ background: T.green, color: T.textOnBrand, height: 28 }}>✓ Yes</button>
          <button onClick={e => { e.stopPropagation(); setConfirmOpen(false); }} type="button"
            aria-label="Cancel send" className="btn sm plain" style={{ color: T.faint, height: 28 }}>✗</button>
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
        <span className="t-label" style={{ color: T.pink }}>Pre-call brief</span>
        {!brief && <button onClick={generate} type="button" disabled={gen} className="btn sm" style={{ background: `${T.pink}18`, color: T.pink, height: 28 }}>{gen ? "Generating…" : "✦ Generate"}</button>}
      </div>
      {brief && (<div>
        {brief.angle && <div style={{ fontSize: "11px", fontWeight: 600, color: T.ink, marginBottom: "8px" }}>{brief.angle}</div>}
        {(brief.bullets || []).map((b, i) => <div key={i} style={{ display: "flex", gap: "7px", marginBottom: "5px" }}><span style={{ color: T.pink, fontWeight: 700, fontSize: "10.5px", flexShrink: 0 }}>→</span><span className="t-cap" style={{ lineHeight: 1.55 }}>{b}</span></div>)}
        <button onClick={regenerate} type="button" className="btn sm plain" style={{ marginTop: "6px", color: T.faint, padding: 0 }}>↻ Regenerate</button>
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

  // The status rail used to be a `borderLeft`, on an element that also carried
  // shadowCard — a border and a box-shadow on one element, which the language
  // forbids, on every card on the board. It rides along as an INSET shadow now,
  // so the kit's .card keeps its one material and still shows the rail. Both
  // hover states re-state the rail for the same reason.
  const rail = (() => {
    if (isSelected) return T.gold;
    if (["prospected","draft"].includes(card.status)) {
      const pri = getProspectPriority(card);
      if (pri.tier === "Hot") return T.red;
      if (pri.tier === "Warm") return T.amber;
    }
    return statusColor;
  })();
  const railed = (depth) => `inset 3px 0 0 ${rail}, ${depth}`;

  return (
    <>
    <div className="card" style={{
      background: isSelected ? T.goldSoft : undefined,
      overflow: "hidden",
      boxShadow: railed(T.shadowCard),
      transition: `box-shadow ${T.durBase} ${T.easeOut}, transform ${T.durBase} ${T.easeOut}`,
    }}
      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = railed(T.shadowHover); e.currentTarget.style.transform = "translateY(-1px)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = railed(T.shadowCard); e.currentTarget.style.transform = "none"; }}
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
              <span className="t-call" style={{ fontWeight: 600 }}>{prospect.business_name || "Unknown"}</span>
              <StatusBadge status={card.status} />
              {["prospected","draft"].includes(card.status) && (() => {
                const pri = getProspectPriority(card);
                if (pri.tier === "Cold") return null;
                return <span className="t-label" style={{ color: pri.color, background: pri.bg, padding: "2px 8px", borderRadius: "20px" }}>{pri.tier}</span>;
              })()}
              {card.status === "replied" && card.reply_body && (() => {
                const cls = classifyReply(card.reply_body);
                return <span title="Reply sentiment (auto-classified)" className="t-label" style={{ color: cls.color, background: cls.bg, padding: "2px 8px", borderRadius: "20px" }}>{cls.label}</span>;
              })()}
              {isDupeName && (
                <span title="Another business with this name" className="t-cap" style={{ fontWeight: 600, color: T.amberHi, background: `${T.amberHi}15`, padding: "2px 7px", borderRadius: "6px" }}>⚠ Multi</span>
              )}
              {isDupeEmail && (
                <span title="Email used by another prospect" className="t-cap" style={{ fontWeight: 600, color: T.red, background: `${T.red}15`, padding: "2px 7px", borderRadius: "6px" }}>⚠ Duplicate</span>
              )}
              {hasThread && (
                <span onClick={(e) => { e.stopPropagation(); setShowThread(true); }} className="t-cap" style={{ fontWeight: 600, color: T.pink, background: `${T.pink}18`, padding: "2px 7px", borderRadius: "6px", cursor: "pointer" }}>
                  💬 Thread
                </span>
              )}
              {!!(prospectBriefSummary || callouts.length > 0 || linkedinUrl || prospect.website_context) && (
                <span onClick={(e) => { e.stopPropagation(); setShowIntel(!showIntel); }} className="t-cap" style={{ fontWeight: 600, color: showIntel ? T.goldHi : T.gold, background: showIntel ? `${T.gold}24` : `${T.gold}12`, padding: "2px 7px", borderRadius: "6px", cursor: "pointer" }}>
                  ✦ Intel
                </span>
              )}
            </div>
          </div>
          {/* Urgency pill */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
            {urgency && (
              <span className="t-cap" style={{ color: urgency.color, background: `${urgency.color}14`, padding: "3px 9px", borderRadius: "20px", fontFamily: T.fontMono }}>
                {urgency.dot} {urgency.label}
              </span>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {onToggleSelect && (
                <span onClick={(e) => { e.stopPropagation(); onToggleSelect(card.id); }}
                  style={{ width: "16px", height: "16px", borderRadius: "4px", border: `1.5px solid ${isSelected ? T.gold : T.line}`, background: isSelected ? T.gold : "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, fontSize: "10.5px", color: T.textOnBrand }}>
                  {isSelected ? "✓" : ""}
                </span>
              )}
              <span style={{ color: T.faint, fontSize: "10.5px" }}>{expanded ? "▲" : "▼"}</span>
            </div>
          </div>
        </div>

        {/* Compact info row */}
        <div style={{ fontSize: "11px", color: T.muted, display: "flex", alignItems: "center", gap: "5px", flexWrap: "wrap", marginTop: "4px" }}>
          {prospect.category && <span>{prospect.category}</span>}
          {contact.name && <><span style={{ color: T.ghost }}>·</span><span style={{ color: T.muted }}>{contact.name}</span></>}
          {contact.email && <><span style={{ color: T.ghost }}>·</span><span style={{ color: T.faint }}>{contact.email}</span></>}
          {contact.email_confidence_score && (
            <span style={{ color: confidenceColor, fontWeight: 700, fontSize: "10.5px" }}>{contact.email_confidence_score}%</span>
          )}
          {prospect.ads_detected === true && (
            <span title="Running Google Ads right now — already spending, highest buying intent" className="t-cap" style={{ fontWeight: 600, color: T.red, background: `${T.red}1C`, padding: "2px 7px", borderRadius: "6px", marginLeft: "2px" }}>
              ⚡ Ads Live
            </span>
          )}
          {prospect.ads_detected === false && prospect.website_context && (
            <span title="No Google Ads tracking detected on their site" className="t-cap" style={{ color: T.faint, background: T.subtle, padding: "2px 7px", borderRadius: "6px", marginLeft: "2px" }}>
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
              <span key={i} title={`${ch.l} detected on their site`} className="t-cap" style={{ fontWeight: 600, color: ch.c, background: ch.c + "1C", padding: "2px 7px", borderRadius: "6px", marginLeft: "2px" }}>{ch.l}</span>
            ));
          })()}
          {prospect.screenshot_url && (
            <a href={prospect.screenshot_url} target="_blank" rel="noopener" title="View their landing page screenshot" className="t-cap" style={{ fontWeight: 600, color: T.muted, background: T.subtle, padding: "2px 7px", borderRadius: "6px", marginLeft: "2px", textDecoration: "none" }}>📷 Page</a>
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
                  <span style={{ color: T.gold, fontSize: "10.5px", marginTop: "3px", flexShrink: 0 }}>✦</span>
                  <span style={{ fontSize: "12px", color: T.muted, lineHeight: 1.5 }}>{c}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: callouts.length > 0 ? "10px" : "0" }}>
            {linkedinUrl && (
              <a href={linkedinUrl} target="_blank" rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="btn sm" style={{ background: `${T.blue}18`, color: T.blue, textDecoration: "none" }}>
                in Company →
              </a>
            )}
            {contact.name && (
              <a href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(contact.name + " " + prospect.business_name)}`}
                target="_blank" rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="btn sm" style={{ background: `${T.blueDeep}18`, color: T.blueDeep, textDecoration: "none" }}>
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
                  <div className="t-label" style={{ color: sc, marginBottom: "3px" }}>Last analysis · {ago}</div>
                  <div className="t-cap" style={{ lineHeight: 1.5 }}>{lastAnalysis.topFinding || (lastAnalysis.summary || "").slice(0, 100)}</div>
                </div>
              </div>
            );
          })()}

          {/* Inline thread view — visible whenever email has been sent */}
          {card.sent_at && (
            <div style={{ marginBottom: "14px" }}>
              <div style={{ marginBottom: "8px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                <span className="t-label">Conversation</span>
                <button onClick={() => setShowThread(true)} type="button" className="btn sm" style={{ background: `${T.pink}18`, color: T.pink, height: 28 }}>
                  Open full thread
                </button>
              </div>
              {/* Their original email */}
              <div style={{ background: `${T.blue}0A`, borderLeft: `2px solid ${T.blue}99`, borderRadius: "0 6px 6px 0", padding: "10px 12px", marginBottom: "6px" }}>
                <div style={{ fontSize: "10.5px", fontWeight: 600, color: T.blue, marginBottom: "5px" }}>
                  You → {contact.email} · {timeAgo(card.sent_at)}
                </div>
                <div style={{ fontSize: "11px", fontWeight: 600, color: T.muted, marginBottom: "4px" }}>{cleanSubject(card.draft_subject)}</div>
                <div style={{ fontSize: "12px", color: T.muted, lineHeight: 1.6, whiteSpace: "pre-wrap", maxHeight: "80px", overflow: "hidden", maskImage: "linear-gradient(to bottom, black 60%, transparent 100%)" }}>{cleanBody(card.draft_body)}</div>
              </div>
              {/* Their reply */}
              {card.reply_body && (
                <div style={{ background: `${T.pink}0D`, borderLeft: `2px solid ${T.pink}99`, borderRadius: "0 6px 6px 0", padding: "10px 12px", marginBottom: "6px" }}>
                  <div style={{ fontSize: "10.5px", fontWeight: 600, color: T.pink, marginBottom: "5px" }}>
                    {card.reply_from?.split("<")[0].trim() || "Prospect"} · {timeAgo(card.replied_at)}
                  </div>
                  <div style={{ fontSize: "12px", color: T.ink, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{cleanReplyBody(card.reply_body)}</div>
                </div>
              )}
              {/* Follow-up sent indicator */}
              {card.status === "sent" && card.replied_at && (
                <div style={{ fontSize: "10.5px", color: T.blue, background: `${T.blue}10`, border: `1px solid ${T.blue}20`, borderRadius: "6px", padding: "6px 10px" }}>
                  ↗ Follow-up sent · waiting for response
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div role="alert" className="t-foot" style={{ padding: "9px 12px", background: `${T.red}18`, border: "none", borderRadius: "10px", color: T.red, marginBottom: "12px" }}>
              {error} Press Generate Draft to try again.
            </div>
          )}

          {/* Draft section — initial outreach OR follow-up depending on send state */}
          {!isSent && !hasDraft && (
            <button onClick={handleGenerate} type="button" disabled={generating} className="btn md tinted full" style={{ marginBottom: "14px" }}>
              {generating ? "Writing draft…" : "✦ Generate Draft"}
            </button>
          )}

          {/* Initial outreach draft — only before sending */}
          {!isSent && hasDraft && (
            <div style={{ marginBottom: "14px" }}>
              <div className="t-label" style={{ marginBottom: "8px" }}>Draft</div>
              {editingDraft ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject line" aria-label="Subject line"
                    className="field" style={{ fontWeight: 600, fontSize: "13.5px" }} />
                  <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} aria-label="Draft body"
                    className="field" style={{ fontSize: "13.5px", lineHeight: 1.65, resize: "vertical" }} />
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button onClick={handleSaveDraft} type="button" className="btn sm" style={{ flex: 1, background: `${T.greenHi}1F`, color: T.greenHi }}>Save</button>
                    <button onClick={() => { setEditingDraft(false); setSubject(cleanSubject(card.draft_subject || "")); setBody(cleanBody(card.draft_body || "")); }} type="button" className="btn sm quiet" style={{ flex: 1 }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div style={{ background: T.subtle, borderRadius: "12px", padding: "12px", border: "none" }}>
                  <div className="t-call" style={{ fontWeight: 600, marginBottom: "10px" }}>{subject}</div>
                  <div className="t-call" style={{ color: T.muted, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{body}</div>
                  <div style={{ display: "flex", gap: "8px", marginTop: "12px", borderTop: `1px solid ${T.lineSoft}`, paddingTop: "10px" }}>
                    <button onClick={() => setEditingDraft(true)} type="button" className="btn sm quiet">Edit</button>
                    <button onClick={handleGenerate} type="button" disabled={generating} className="btn sm quiet">
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
              <div className="t-label" style={{ color: T.blue, marginBottom: "8px" }}>↩ Follow-up draft</div>
              {!replyBody ? (
                <button onClick={handleGenerateFollowUp} type="button" disabled={generating} className="btn md full" style={{ background: `${T.blue}1F`, color: T.blue }}>
                  {generating ? "Writing follow-up…" : "↩ Generate Follow-up"}
                </button>
              ) : (
                <div style={{ background: `${T.blue}0D`, borderRadius: "12px", padding: "12px", border: "none" }}>
                  <div className="t-cap" style={{ color: T.blue, marginBottom: "6px" }}>replies in original thread · {contact.email}</div>
                  <div className="t-call" style={{ fontWeight: 600, marginBottom: "8px" }}>{replySubject}</div>
                  <textarea value={replyBody} onChange={(e) => setReplyBody(e.target.value)} rows={5} aria-label="Follow-up body"
                    style={{ width: "100%", background: "transparent", border: "none", fontSize: "13.5px", color: T.muted, lineHeight: 1.7, outline: "none", resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" }} />
                  <div style={{ display: "flex", gap: "8px", marginTop: "8px", borderTop: `1px solid ${T.lineSoft}`, paddingTop: "10px" }}>
                    <button onClick={handleGenerateFollowUp} type="button" disabled={generating} className="btn sm quiet">
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
              <div className="t-label" style={{ color: T.pink, marginBottom: "8px" }}>Your reply</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <textarea value={replyBody} onChange={(e) => setReplyBody(e.target.value)} rows={4}
                  placeholder="Write your reply…" aria-label="Your reply"
                  className="field" style={{ fontSize: "13.5px", lineHeight: 1.65, resize: "vertical" }}
                />
                <button onClick={handleSendReply} type="button" disabled={sendingReply || !replyBody}
                  className="btn md" style={{ background: `${T.pink}1F`, color: T.pink }}>
                  {sendingReply ? "Sending…" : "↗ Send reply"}
                </button>
                {replyStatus && <div role="status" className="t-foot" style={{ color: replyStatus.startsWith("✓") ? T.greenHi : T.red }}>{replyStatus}{replyStatus.startsWith("✓") ? "" : " — fix it and press Send reply again."}</div>}
              </div>
            </div>
          )}

          {/* Tone feedback */}
          <div style={{ marginBottom: "12px" }}>
            <div className="t-label" style={{ marginBottom: "6px" }}>Tone feedback</div>
            <div style={{ display: "flex", gap: "8px" }}>
              <input value={feedbackInput} onChange={(e) => setFeedbackInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleFeedbackSubmit()}
                placeholder="e.g. Too long, cut it in half" aria-label="Tone feedback"
                className="field" style={{ flex: 1, width: "auto", minHeight: 34, padding: "7px 10px", fontSize: "13px" }} />
              <button onClick={handleFeedbackSubmit} type="button" className="btn sm quiet">Save</button>
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {!isSent && hasDraft && card.status !== "rejected" && (
              <button onClick={handleSend} type="button" disabled={sending} className="btn md primary" style={{ flex: 1 }}>
                {sending ? "Sending…" : "✓ Approve & Send"}
              </button>
            )}
            {isSent && replyBody && !hasThread && (
              <button onClick={handleSendFollowUp} type="button" disabled={sending} className="btn md" style={{ flex: 1, background: `${T.blue}1F`, color: T.blue }}>
                {sending ? "Sending…" : "↩ Send follow-up"}
              </button>
            )}
            {card.status !== "rejected" && (
              <button onClick={() => onStatusChange(card.id, "rejected")} type="button" className="btn md danger">
                ✕ Reject
              </button>
            )}
            {card.status !== "snoozed" && (
              <button onClick={() => onStatusChange(card.id, "snoozed")} type="button" className="btn md" style={{ background: "#A78BFA1C", color: T.violet }}>
                Snooze
              </button>
            )}
          </div>

                    {/* Send status */}
          {sendStatus && (
            <div role="status" className="t-foot" style={{ marginTop: "10px", color: sendStatus.startsWith("✓") ? T.greenHi : T.red, padding: "7px 11px", background: sendStatus.startsWith("✓") ? `${T.greenHi}10` : `${T.red}10`, borderRadius: "10px" }}>
              {sendStatus}{sendStatus.startsWith("✓") ? "" : " — fix it and press Approve & Send again."}
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
          const result = await sendEmail({
            to: contact.email,
            subject,
            body: cleanBody(body),
            replyToMessageId: card.reply_gmail_message_id || card.gmail_rfc_message_id,
            threadId: card.gmail_thread_id,
          });
          await onMarkSent(card.id, result.messageId, result.threadId, result.rfcMessageId, { kind: "reply", subject, body: cleanBody(body) });
          setShowThread(false);
          setSendingReply(false);
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
      <span title={`Est. ${val.label} retainer if won`} style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "10.5px", color: T.green, background: `${T.green}14`, padding: "2px 8px", borderRadius: "6px", fontWeight: 700, fontFamily: T.fontMono }}>{fmtMoney(val.monthly)}/mo · {val.label}</span>
    </div>
  ) : null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginTop: "7px" }}>
      <span title={`Est. ${val.label} retainer if won`} style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "10.5px", color: T.green, background: `${T.green}14`, padding: "2px 8px", borderRadius: "6px", fontWeight: 700, fontFamily: T.fontMono, flexShrink: 0 }}>{fmtMoney(val.monthly)}/mo</span>
      {wn && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "10.5px", color: wn.color, background: wn.color + "0F", padding: "2px 8px", borderRadius: "6px", fontWeight: 600, lineHeight: 1.4 }}>
          <span style={{ fontSize: "10.5px" }}>{wn.icon}</span>{wn.text}
        </span>
      )}
      {fr && (
        <span title="How long this prospect has waited" style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "10.5px", color: fr.color, fontWeight: 600 }}>
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
          <div className="t-foot" style={{ fontWeight: 600, color: st.due ? T.amber : T.muted }}>
            {st.due ? `${st.nextLabel} due now` : `${st.nextLabel} in ${st.dueInDays}d`}
          </div>
          <div className="t-cap" style={{ color: T.faint, marginTop: "1px" }}>Touch {st.touches} sent · {st.daysSince}d ago{st.nextHint ? ` · ${st.nextHint}` : ""}</div>
        </div>
        {st.due && onGenerateFollowUp && (
          <button onClick={(e) => { e.stopPropagation(); onGenerateFollowUp(); }} type="button" className="btn sm" style={{ background: T.amber, color: "#1A1206", flexShrink: 0 }}>✦ Draft {st.nextLabel}</button>
        )}
      </div>
    </div>
  );
}
