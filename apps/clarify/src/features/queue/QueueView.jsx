// ─── Approval Queue — the product's spine ────────────────────────────────────
// Every outbound draft in the system converges here: sequence follow-ups,
// AI-suggested replies, manual drafts. Nothing leaves without a human pressing
// Approve & Send on this screen (or the card-level send buttons) — the engine
// only ever writes rows with status='draft'. Safe mode still applies on top:
// while safe, approved sends reroute to your own inbox.
import { useEffect, useMemo, useRef, useState } from "react";
import { T } from "../../theme.js";
import { EmptyState, SkeletonRows, useToast } from "../../ui.jsx";
import { seqDb } from "../../lib/sequenceDb.js";
import { db } from "../../lib/supabase.js";
import { sendEmail, cleanSubject, timeAgo } from "../../lib/email.js";
import { PUBLIC_SITE_URL } from "../../config.js";

const KIND_META = {
  followup: { label: "Sequence follow-up", color: T.blue },
  reply: { label: "Suggested reply", color: T.pink },
  initial: { label: "Initial outreach", color: T.amber },
  manual: { label: "Manual draft", color: T.muted },
};

// Wrap every http(s) URL in the body with a tracked short link. Best-effort:
// a tracking failure must never block a send — the raw URL stays in that case.
async function wrapLinks(messageId, body) {
  // Trailing sentence punctuation is NOT part of the URL — "…here: https://x.com/y."
  // must wrap x.com/y and keep the period in the text (else the redirect 404s
  // and the sentence loses its full stop).
  const raw = [...new Set(body.match(/https?:\/\/[^\s)>\]"']+/g) || [])];
  const urls = [...new Set(raw.map((u) => u.replace(/[.,;:!?]+$/, "")))];
  let out = body;
  for (const url of urls) {
    if (!url || url.startsWith(`${PUBLIC_SITE_URL}/r/`)) continue; // already wrapped
    try {
      const link = await seqDb.createTrackedLink(messageId, url);
      if (link?.id) out = out.split(url).join(`${PUBLIC_SITE_URL}/r/${link.id}`);
    } catch {}
  }
  return out;
}

// Exported so the render test can mount one with a draft row: QueueView itself
// only ever has rows after an async seqDb.getQueue(), so a cold render of the
// tab reaches the skeleton and nothing inside it.
export function QueueItem({ msg, onDone }) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [subject, setSubject] = useState(msg.subject || "");
  const [body, setBody] = useState(msg.body || "");
  const [busy, setBusy] = useState("");
  const kind = KIND_META[msg.kind] || KIND_META.manual;
  const prospect = msg.outreach?.prospect;
  const contact = msg.outreach?.contact;
  const dirty = subject !== (msg.subject || "") || body !== (msg.body || "");

  const approveAndSend = async () => {
    if (!contact?.email) { toast.push("No contact email on this thread — fix the contact first.", { tone: "error" }); return; }
    setBusy("sending");
    try {
      if (dirty) await seqDb.updateMessage(msg.id, { subject, body });
      const trackedBody = await wrapLinks(msg.id, body);
      const isThreaded = msg.kind === "followup" || msg.kind === "reply";
      const res = await sendEmail({
        to: contact.email,
        subject: cleanSubject(subject),
        body: trackedBody,
        replyToMessageId: isThreaded ? (msg.outreach?.reply_gmail_message_id || msg.outreach?.gmail_rfc_message_id || msg.outreach?.gmail_message_id) : undefined,
        threadId: isThreaded ? msg.outreach?.gmail_thread_id : undefined,
      });
      await seqDb.updateMessage(msg.id, {
        status: "sent",
        body: trackedBody,
        approved_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        gmail_message_id: res.messageId || null,
        gmail_thread_id: res.threadId || msg.outreach?.gmail_thread_id || null,
        gmail_rfc_message_id: res.rfcMessageId || null,
      });
      // Legacy dual-write so the Kanban/urgency lenses stay truthful — for
      // replies too, matching the card-level send (replied → sent), so an
      // answered thread stops nagging in DailyPlays/ReplyTriage.
      if ((msg.kind === "followup" || msg.kind === "reply" || msg.kind === "initial") && msg.outreach_id) {
        await db.markSent(msg.outreach_id, res.messageId, res.threadId, res.rfcMessageId).catch(() => {});
      }
      // Keep the stored enrollment pointer truthful when a sequence step ships
      // (the engine also derives progression from the ledger, so this is
      // belt-and-braces, not load-bearing).
      if (msg.enrollment_id && msg.meta?.step_order != null) {
        await seqDb.updateEnrollment(msg.enrollment_id, {
          current_step_order: msg.meta.step_order,
          last_decision: `${msg.meta.step_name || `Step ${msg.meta.step_order}`} approved & sent`,
        }).catch(() => {});
      }
      // Any sibling drafts for this thread are stale now.
      try {
        const siblings = await seqDb.getMessagesFor([msg.outreach_id]);
        for (const s of siblings || []) {
          if (s.id !== msg.id && s.direction === "outbound" && s.status === "draft") {
            await seqDb.updateMessage(s.id, { status: "superseded" });
          }
        }
      } catch {}
      toast.push(`Sent to ${contact.email}${res.method === "gmail_compose" ? " (opened in Gmail)" : ""}.`, { tone: "success" });
      onDone(msg.id, "sent");
    } catch (err) {
      toast.push("Send failed: " + err.message, { tone: "error" });
    }
    setBusy("");
  };

  const reject = async () => {
    setBusy("rejecting");
    try {
      await seqDb.updateMessage(msg.id, { status: "rejected" });
      onDone(msg.id, "rejected");
    } catch (err) {
      toast.push("Couldn't reject: " + err.message, { tone: "error" });
    }
    setBusy("");
  };

  return (
    <div className="card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <span className="cell-title" style={{ minWidth: 0, flex: "0 1 auto" }}>
          {prospect?.business_name || "Unknown prospect"}
        </span>
        {/* Uppercase lives on .t-label and nowhere else — this was a hand-rolled
            9.5px tracked capital run. */}
        <span className="t-label" style={{ color: kind.color, background: `${kind.color}1A`, borderRadius: T.rPill, padding: "3px 9px" }}>
          {msg.meta?.step_name || kind.label}
        </span>
        {msg.meta?.personalized && (
          <span title="AI-personalized from the prospect brief" className="t-cap" style={{ color: T.gold, background: T.goldSoft, borderRadius: T.rPill, padding: "2px 9px", fontWeight: 600 }}>✦ personalized</span>
        )}
        <span className="t-cap" style={{ marginLeft: "auto", color: T.faint, fontFamily: T.fontMono, flexShrink: 0 }}>{timeAgo(msg.created_at)}</span>
      </div>

      <div style={{ fontSize: "11px", color: T.muted }}>
        to <span style={{ color: T.ink, fontFamily: T.fontMono }}>{contact?.email || "—"}</span>
      </div>

      {expanded ? (
        <>
          {/* The kit's .field — one well, no outline, kit focus ring. */}
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject"
            className="field" style={{ fontWeight: 600 }} />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7} aria-label="Message body"
            className="field" style={{ fontSize: "13.5px", lineHeight: 1.6, resize: "vertical" }} />
        </>
      ) : (
        // The kit's .cell tappable — a full-width row that opens the editor in
        // place is that grammar exactly, and it brings the kit's press state and
        // 46px floor to what was a bare styled block.
        <button onClick={() => setExpanded(true)} type="button" title="Click to review and edit before sending"
          className="cell tappable" style={{ background: T.subtle, borderRadius: "12px", padding: "10px 12px", flexDirection: "column", alignItems: "stretch", gap: 0 }}>
          <div style={{ fontSize: "12.5px", fontWeight: 600, color: T.ink, marginBottom: "4px" }}>{subject || "(no subject)"}</div>
          <div style={{ fontSize: "12px", color: T.muted, lineHeight: 1.55, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden", whiteSpace: "pre-wrap" }}>{body}</div>
        </button>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <button onClick={approveAndSend} type="button" disabled={!!busy} className="btn md primary">
          {busy === "sending" ? "Sending…" : "✓ Approve & Send"}
        </button>
        {!expanded && (
          <button onClick={() => setExpanded(true)} type="button" className="btn md quiet">
            Edit first
          </button>
        )}
        <button onClick={reject} type="button" disabled={!!busy} className="btn md danger">
          {busy === "rejecting" ? "…" : "Reject"}
        </button>
        {dirty && <span className="t-cap" style={{ color: T.amber }}>edited — saves on send</span>}
      </div>
    </div>
  );
}

export function QueueView({ onNavigate }) {
  const [queue, setQueue] = useState(null);
  const toast = useToast();
  const aliveRef = useRef(true);

  const load = async () => {
    try {
      const rows = await seqDb.getQueue();
      if (aliveRef.current) setQueue(rows || []);
    } catch (err) {
      if (aliveRef.current) { setQueue([]); toast.push("Couldn't load the queue: " + err.message, { tone: "error" }); }
    }
  };
  useEffect(() => {
    aliveRef.current = true;
    load();
    const iv = setInterval(load, 60000); // engine may add drafts while you're here
    return () => { aliveRef.current = false; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDone = (id) => {
    setQueue((q) => (q || []).filter((m) => m.id !== id));
    load(); // superseded siblings drop out too
  };
  const counts = useMemo(() => {
    const c = { followup: 0, reply: 0, manual: 0, initial: 0 };
    (queue || []).forEach((m) => { c[m.kind] = (c[m.kind] || 0) + 1; });
    return c;
  }, [queue]);

  return (
    <div style={{ padding: "24px 28px", maxWidth: "760px", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "12px", marginBottom: "6px", flexWrap: "wrap" }}>
        <h2 className="t-title2" style={{ margin: 0 }}>Approval queue</h2>
        {queue && queue.length > 0 && (
          <span className="t-cap" style={{ color: T.faint, fontFamily: T.fontMono }}>
            {queue.length} waiting{counts.reply ? ` · ${counts.reply} repl${counts.reply === 1 ? "y" : "ies"}` : ""}{counts.followup ? ` · ${counts.followup} follow-up${counts.followup === 1 ? "" : "s"}` : ""}
          </span>
        )}
      </div>
      <div className="t-foot" style={{ marginBottom: "18px", lineHeight: 1.6 }}>
        Everything the engine and the AI want to send, held for your call. Nothing goes out without a click here.
      </div>

      {queue === null ? (
        <SkeletonRows count={3} />
      ) : queue.length === 0 ? (
        <EmptyState icon="check" tint={T.green} title="Queue clear"
          sub="No drafts waiting on you. Sequence steps land here when they come due; replies land here as suggested responses."
          action={<button onClick={() => onNavigate && onNavigate("sequences")} type="button" className="btn md tinted">Manage sequences →</button>}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {queue.map((m, i) => (
            <div key={m.id} style={{ animation: `cardIn 0.3s ${T.easeOut} both`, animationDelay: `${Math.min(i, 8) * 30}ms` }}>
              <QueueItem msg={m} onDone={onDone} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
