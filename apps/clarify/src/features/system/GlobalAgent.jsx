import { useState, useEffect, useRef } from "react";
import { T } from "../../theme";
import { callClaude } from "../../lib/claudeApi.js";
import { GLOBAL_AGENT_PROMPT } from "../../lib/prompts.js";
import { sm } from "../../lib/store.js";
import { fetchPortfolioCounts } from "../../lib/supabase.js";

// The assistant's open panel. Exported and lifted out of GlobalAgent for the
// same reason QueueItem and InboundLeadRow are their own components: `open`
// starts false and only a click flips it, so a cold render of ANY route paints
// the closed "Ask Clarify" button and reaches none of this file's kit surfaces
// — the composer .field, the .t-call title, the .t-foot primer. Rendered
// directly, it reaches all three.
export function AgentPanel({ messages, input, sending, endRef, onInput, onSend, onClear, onClose }) {
  return (
    // Border dropped: shadowModal already lifts this off the canvas, and a
    // border plus a shadow on one element is the thing the language forbids.
    <div className="co-agent-panel" style={{ width: "380px", height: "520px", maxWidth: "calc(100vw - 24px)", background: T.surface, borderRadius: "16px", boxShadow: T.shadowModal, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${T.lineInk}`, display: "flex", alignItems: "center", justifyContent: "space-between", background: T.surface }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ color: T.gold, fontSize: "13px" }}>✦</span>
          <span className="t-call" style={{ fontWeight: 600 }}>Clarify Assistant</span>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          {messages.length > 0 && <button onClick={onClear} type="button" title="Clear conversation memory" className="btn sm plain" style={{ color: T.faint }}>Clear</button>}
          <button onClick={onClose} type="button" aria-label="Close assistant" className="icon-btn">×</button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: "10px" }}>
        {messages.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px 16px", color: T.muted }}>
            <div style={{ fontSize: "22px", marginBottom: "10px" }}>✦</div>
            <div className="t-foot" style={{ lineHeight: 1.6 }}>Ask about outreach pipeline status, client findings, or what to prioritize today. I read live state from across the app before answering.</div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{ maxWidth: "82%", padding: "9px 13px", background: m.role === "user" ? T.goldSoft : T.subtle, border: "none", borderRadius: m.role === "user" ? "12px 12px 3px 12px" : "12px 12px 12px 3px", fontSize: "13px", color: T.ink, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {m.content}
            </div>
          </div>
        ))}
        {sending && (
          <div style={{ display: "flex" }}>
            <div style={{ padding: "10px 14px", background: T.subtle, border: "none", borderRadius: "12px 12px 12px 3px" }}>
              {/* The kit's three-dot convening indicator. */}
              <span className="convene" aria-label="Thinking"><span className="cd" /><span className="cd" /><span className="cd" /></span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div style={{ padding: "12px 14px", borderTop: `1px solid ${T.lineInk}`, display: "flex", gap: "8px" }}>
        <input value={input} onChange={e => onInput(e.target.value)} onKeyDown={e => e.key === "Enter" && !e.shiftKey && onSend()}
          placeholder="Ask anything across Outreach, Analyst, Clients…"
          aria-label="Ask the Clarify assistant" className="field" style={{ flex: 1, width: "auto", minHeight: 38, padding: "9px 12px", fontSize: "13.5px" }} />
        <button onClick={onSend} type="button" disabled={!input.trim() || sending} className="btn sm primary">
          Send
        </button>
      </div>
    </div>
  );
}


// ─── Global Agent ──────────────────────────────────────────────────────────────
// Persistent across tabs. Remembers conversation via sessionMemory (survives
// reloads). Rebuilds a fresh context block from real state on every message —
// this is the dynamic-context half of context engineering; GOVERNANCE_RULES is
// the static half, cached on every call so it's cheap regardless of frequency.
export function GlobalAgent({ cards }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState(() => sm.get("agent_conversation") || []);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef(null);

  useEffect(() => { if (open) endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, open]);

  const clearMemory = () => {
    sm.del("agent_conversation");
    setMessages([]);
  };

  const send = async () => {
    if (!input.trim() || sending) return;
    const userMsg = { role: "user", content: input.trim() };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput("");
    setSending(true);

    try {
      const counts = await fetchPortfolioCounts();
      const analysisKeys = sm.keys("analysis_");
      const analysisSummaries = analysisKeys.map(k => sm.get(`analysis_${k}`)).filter(Boolean);
      const queueKeys = sm.keys("queue_");
      const pendingByClient = queueKeys.map(k => {
        const items = sm.get(`queue_${k}`) || [];
        const pending = items.filter(i => i.status === "pending").length;
        return pending > 0 ? `${k.replace(/_/g, " ")}: ${pending} pending` : null;
      }).filter(Boolean);
      const outreachCounts = cards ? {
        prospected: cards.filter(c => c.status === "prospected").length,
        draft: cards.filter(c => ["draft", "draft_ready"].includes(c.status)).length,
        sent: cards.filter(c => c.status === "sent").length,
        replied: cards.filter(c => c.status === "replied").length,
      } : null;

      const contextBlock = `CURRENT SYSTEM STATE (built fresh, just now)
Outreach pipeline: ${outreachCounts ? `${outreachCounts.prospected} prospected, ${outreachCounts.draft} draft${outreachCounts.draft !== 1 ? "s" : ""} ready, ${outreachCounts.sent} sent, ${outreachCounts.replied} replied` : "not loaded in this view"}
Clients (from Supabase, live): ${counts.activeClients} active, ${counts.criticalFindings} critical findings, ${counts.pendingActions} pending actions awaiting approval
Saved client analyses (from Analyst tab): ${analysisSummaries.length ? analysisSummaries.map(a => `${a.clientName} — ${a.signal} — ${a.topFinding}`).join(" | ") : "none yet"}
Local action queues with pending items: ${pendingByClient.length ? pendingByClient.join(", ") : "none pending"}`;

      const apiMessages = nextMessages.slice(-10).map(m => ({ role: m.role, content: m.content }));
      apiMessages[apiMessages.length - 1] = { role: "user", content: `${contextBlock}\n\nQuestion: ${userMsg.content}` };

      const r = await callClaude({ model: "claude-sonnet-4-6", max_tokens: 700, system: [{ type: "text", text: GLOBAL_AGENT_PROMPT, cache_control: { type: "ephemeral" } }], messages: apiMessages, fn: "global_agent" });

      const text = r.text || "I had trouble responding — try again.";
      const finalMessages = [...nextMessages, { role: "assistant", content: text }];
      setMessages(finalMessages);
      sm.set("agent_conversation", finalMessages.slice(-40));
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Something went wrong reaching the agent. Try again in a moment." }]);
    }
    setSending(false);
  };

  return (
    <div className="co-agent-root" style={{ position: "fixed", bottom: "20px", right: "20px", zIndex: 500 }}>
      {!open && (
        <button onClick={() => setOpen(true)}
          onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = T.shadowHover; }}
          onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = T.shadowFloat; }}
          type="button" className="btn md primary" style={{ borderRadius: "30px", boxShadow: T.shadowFloat }}>
          <span style={{ color: T.textOnBrand }}>✦</span> Ask Clarify
        </button>
      )}
      {open && (
        <AgentPanel messages={messages} input={input} sending={sending} endRef={endRef}
          onInput={setInput} onSend={send} onClear={clearMemory} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
