import { useState, useEffect } from "react";
import { T } from "../../theme";
import { OutreachCard } from "./OutreachCard.jsx";
import { classifyReply } from "../../lib/email.js";
import { TIER_FALLBACK_MAP } from "../../lib/classify.js";
import { fmtMoney, getProspectPriority, pipelineValue } from "../../lib/leads.js";

export function KanbanColumn({ title, count, color, children, onBatchGenerate, batchGenerating, batchProgress, batchLabel, bgTint, emptyNote }) {
  return (
    <div className="co-kcol" style={{ flex: 1, minWidth: "260px", maxWidth: "400px", background: bgTint || "transparent", borderRadius: bgTint ? "14px" : 0, padding: bgTint ? "12px" : 0, margin: bgTint ? "-12px" : 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px", padding: "0 1px" }}>
        <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: color, boxShadow: `0 0 8px ${color}70`, flexShrink: 0 }} />
        {/* .t-label is the one place uppercase lives in this language, and it
            is 12px — the hand-rolled version here was 10px and tracked. */}
        <span className="t-label">{title}</span>
        <span className="t-num" style={{ fontSize: "11px", color: color, background: color + "15", padding: "1px 8px", borderRadius: "20px", fontFamily: T.fontMono }}>{count}</span>
        {onBatchGenerate && (
          <button onClick={onBatchGenerate} type="button" disabled={batchGenerating} className="btn sm quiet" style={{ marginLeft: "auto" }}>
            {batchGenerating ? batchProgress : batchLabel || "Generate All"}
          </button>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {children}
        {(Array.isArray(children) ? children.filter(Boolean).length === 0 : !children) && emptyNote && (
          <div style={{ padding: "16px 14px", background: T.subtle, borderRadius: "10px", border: `1px dashed ${T.line}`, textAlign: "center" }}>
            <div style={{ fontSize: "11px", color: T.faint, lineHeight: 1.65 }}>{emptyNote}</div>
          </div>
        )}
      </div>
    </div>
  );
}


// ─── Round 4: Bulk actions bar — appears when cards are selected ──────────────
export function BulkActionsBar({ count, onSnooze, onReject, onGenerate, onClear, generating }) {
  if (count === 0) return null;
  return (
    // The kit's .toast — glass, spring in, no outline. This bar used to carry a
    // 1px border AND shadowFloat, which the language forbids on one element.
    // `animation` stays the app's own `fadeup` and is NOT the kit's `toastin`:
    // this bar is centred with translateX(-50%), and toastin's final keyframe is
    // `transform: none` with fill-mode both, which would drop the centring the
    // moment the animation landed. fadeup carries the -50% through every frame.
    <div className="co-bulkbar toast" style={{ position: "fixed", bottom: "24px", left: "50%", transform: "translateX(-50%)", zIndex: 200, gap: "6px", padding: "8px 10px", borderRadius: "16px", animation: "fadeup 0.2s ease both" }}>
      <span className="t-foot" style={{ color: T.ink, fontWeight: 600, padding: "0 8px" }}>{count} selected</span>
      <div style={{ width: "1px", height: "20px", background: T.line }} />
      <button onClick={onGenerate} type="button" disabled={generating} className="btn sm primary">✦ Generate</button>
      <button onClick={onSnooze} type="button" className="btn sm quiet">Snooze</button>
      <button onClick={onReject} type="button" className="btn sm danger">Reject</button>
      <div style={{ width: "1px", height: "20px", background: T.line }} />
      <button onClick={onClear} type="button" className="btn sm plain" style={{ color: T.muted }}>Clear</button>
    </div>
  );
}


// Undo toast — last destructive action can be reversed
export function UndoToast({ message, onUndo, onDismiss }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [message, onDismiss]);
  return (
    // Also the kit's .toast, for the same reason: it was a border and a
    // shadowFloat on the same element.
    <div className="co-undo toast" style={{ position: "fixed", bottom: "24px", left: "24px", zIndex: 200, gap: "12px" }}>
      <span className="t-foot" style={{ color: T.ink }}>{message}</span>
      <button onClick={onUndo} type="button" className="btn sm tinted">↩ Undo</button>
    </div>
  );
}


// Keyboard shortcut help overlay
export function ShortcutHelp({ onClose }) {
  const shortcuts = [
    ["?", "Toggle this help"],
    ["Esc", "Clear selection / close"],
  ];
  return (
    <div className="co-modal-overlay" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadein 0.15s ease both" }}>
      <div className="co-modal-sheet" onClick={e => e.stopPropagation()} style={{ background: T.surface, borderRadius: "16px", padding: "24px 28px", width: "380px", boxShadow: T.shadowModal }}>
        <div className="t-head" style={{ color: T.inkDeep, marginBottom: "16px" }}>Keyboard shortcuts</div>
        {shortcuts.map(([k, d], i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: i < shortcuts.length - 1 ? `1px solid ${T.lineSoft}` : "none" }}>
            <span style={{ fontSize: "12px", color: T.muted }}>{d}</span>
            <kbd style={{ color: T.ink }}>{k}</kbd>
          </div>
        ))}
        <div className="t-cap" style={{ color: T.faint, marginTop: "14px", textAlign: "center" }}>Press ? anytime to toggle</div>
      </div>
    </div>
  );
}


// Triage summary banner shown atop the Replied column. Uses the STORED AI
// classification when a card has one (written by the check-replies pipeline);
// the legacy keyword classifier is only the fallback for pre-AI replies.
export function ReplyTriageSummary({ cards, onJumpToCard }) {
  const replies = cards.filter(c => c.status === "replied" && c.reply_body);
  if (replies.length === 0) return null;
  const classified = replies.map(c => ({
    card: c,
    key: c.reply_classification || TIER_FALLBACK_MAP[classifyReply(c.reply_body).tier] || "neutral",
  }));
  const buckets = {};
  classified.forEach(({ key }) => { buckets[key] = (buckets[key] || 0) + 1; });
  const order = [
    { key: "scheduling", label: "Want to meet", color: T.green },
    { key: "interested", label: "Interested", color: T.greenHi },
    { key: "question", label: "Questions", color: T.blue },
    { key: "objection", label: "Objections", color: T.amber },
    { key: "neutral", label: "Neutral", color: T.muted },
    { key: "not_interested", label: "Passed", color: T.red },
  ].filter(o => buckets[o.key]);
  const hot = (buckets.scheduling || 0) + (buckets.interested || 0);
  return (
    <div style={{ marginBottom: "12px", padding: "12px 14px", background: hot > 0 ? `${T.green}0F` : T.surface, border: `1px solid ${hot > 0 ? `${T.green}33` : T.line}`, borderRadius: "10px" }}>
      <div className="t-label" style={{ marginBottom: "8px" }}>Reply triage</div>
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
        {order.map(o => (
          <span key={o.key} style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", color: T.muted, background: o.color + "12", padding: "3px 9px", borderRadius: "20px", fontWeight: 600 }}>
            <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: o.color }} />
            {buckets[o.key]} {o.label}
          </span>
        ))}
      </div>
      {buckets.scheduling > 0 && <div style={{ fontSize: "11px", color: T.green, marginTop: "8px", fontWeight: 600 }}>◆ {buckets.scheduling} want{buckets.scheduling === 1 ? "s" : ""} to meet — book from the Calendar tab.</div>}
      {!buckets.scheduling && hot > 0 && <div style={{ fontSize: "11px", color: T.green, marginTop: "8px", fontWeight: 600 }}>→ {hot} ready to convert — answer these first.</div>}
    </div>
  );
}


// ─── Round 1: Daily Plays — guided daily workflow + pipeline funnel ───────────
export function DailyPlays({ cards, onFilter, onJumpToCard }) {
  const now = Date.now();
  const day = 86400000;

  // The plays an outreach operator should run today, in priority order
  const replies = cards.filter(c => c.status === "replied");
  const draftsReady = cards.filter(c => ["draft","draft_ready"].includes(c.status));
  const hotProspects = cards.filter(c => c.status === "prospected" && getProspectPriority(c).tier === "Hot");
  const staleSent = cards.filter(c => c.status === "sent" && c.sent_at && (now - new Date(c.sent_at).getTime()) > 3 * day && (now - new Date(c.sent_at).getTime()) < 14 * day);
  const coldProspects = cards.filter(c => c.status === "prospected" && !["draft","draft_ready"].includes(c.status));

  const plays = [
    replies.length > 0 && { id: "reply", icon: "💬", color: T.pink, title: `Respond to ${replies.length} repl${replies.length !== 1 ? "ies" : "y"}`, sub: "Warmest signal you have — answer first", filter: "replied", weight: 4 },
    draftsReady.length > 0 && { id: "send", icon: "→", color: T.amber, title: `Send ${draftsReady.length} ready draft${draftsReady.length !== 1 ? "s" : ""}`, sub: "Already written, just needs your eyes", filter: "draft", weight: 3 },
    staleSent.length > 0 && { id: "followup", icon: "↻", color: T.blue, title: `Follow up on ${staleSent.length} silent thread${staleSent.length !== 1 ? "s" : ""}`, sub: "Sent 3+ days ago, no reply — bump them", filter: "sent", weight: 2 },
    hotProspects.length > 0 && { id: "hot", icon: "🔥", color: T.red, title: `Draft ${hotProspects.length} hot prospect${hotProspects.length !== 1 ? "s" : ""}`, sub: "Already running ads — highest intent", filter: "prospected", weight: 2 },
    coldProspects.length > 0 && { id: "draft", icon: "✦", color: T.gold, title: `Work the prospect queue (${coldProspects.length})`, sub: "Generate drafts to keep the pipeline moving", filter: "prospected", weight: 1 },
  ].filter(Boolean).sort((a, b) => b.weight - a.weight);

  const done = plays.length === 0;

  return (
    // The kit's .card. It was surface + a 1px border + shadowCard (+ the brass
    // glow when there is work) — a border and a shadow on one element. The card
    // separates by tone and shadow; the glow rides on as a second shadow, which
    // is not an outline.
    <div className="card pad-lg" style={{ marginBottom: "16px", background: done ? undefined : T.raised, boxShadow: done ? undefined : `var(--shadow-card), ${T.glowBrass}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginBottom: done ? 0 : "14px" }}>
        <div className="t-label" style={{ color: done ? T.muted : T.gold }}>Today's plays</div>
        {!done && <div className="t-cap">{plays.length} thing{plays.length !== 1 ? "s" : ""} worth doing, in order</div>}
      </div>
      {done ? (
        <div style={{ fontSize: "13px", color: T.muted, fontWeight: 500, marginTop: "10px" }}>✓ Pipeline's clear — nothing urgent. Find new prospects or let sent threads breathe.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {plays.map((p, i) => (
            <div key={p.id} onClick={() => onFilter(p.filter)} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "10px 12px", background: "rgba(255,255,255,0.04)", borderRadius: "9px", cursor: "pointer", transition: "background 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.08)"}
              onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.04)"}>
              <span style={{ width: "26px", height: "26px", borderRadius: "8px", background: p.color + "26", color: p.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px", fontWeight: 700, flexShrink: 0 }}>{i + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "13px", color: T.ink, fontWeight: 600 }}>{p.title}</div>
                <div style={{ fontSize: "11px", color: T.muted, marginTop: "1px" }}>{p.sub}</div>
              </div>
              <span style={{ fontSize: "16px", color: T.muted }}>›</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// Pipeline funnel — conversion at a glance
export function PipelineFunnel({ cards }) {
  const stages = [
    { key: "prospected", label: "Prospected", color: T.muted },
    { key: "draft", label: "Drafted", color: T.amber },
    { key: "sent", label: "Sent", color: T.blue },
    { key: "replied", label: "Replied", color: T.pink },
  ];
  // Cumulative: a sent card also "passed through" draft+prospected historically.
  const counts = {
    prospected: cards.length,
    draft: cards.filter(c => ["draft","draft_ready","sent","replied"].includes(c.status)).length,
    sent: cards.filter(c => ["sent","replied"].includes(c.status)).length,
    replied: cards.filter(c => c.status === "replied").length,
  };
  const max = counts.prospected || 1;
  // Value at stake: monthly revenue represented by prospects still in play.
  const activeCards = cards.filter(c => !["rejected","snoozed"].includes(c.status));
  const totalValue = pipelineValue(activeCards);
  const warmValue = pipelineValue(cards.filter(c => ["sent","replied"].includes(c.status)));
  // Response numbers, folded in from the old metrics strip so one component owns the story.
  const sentAll = cards.filter(c => c.sent_at);
  const repliedAll = cards.filter(c => c.replied_at);
  const replyRate = sentAll.length > 0 ? Math.round(repliedAll.length / sentAll.length * 100) : null;
  const sentThisWeek = sentAll.filter(c => Date.now() - new Date(c.sent_at).getTime() < 7 * 86400000).length;
  return (
    <div style={{ marginBottom: "16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "12px", marginBottom: "8px", padding: "0 2px", flexWrap: "wrap" }}>
        <span className="t-label">Pipeline value</span>
        <span style={{ fontSize: "15px", fontWeight: 600, color: T.inkDeep, fontFamily: T.fontMono }}>{fmtMoney(totalValue)}<span style={{ fontSize: "11px", color: T.faint }}>/mo at stake</span></span>
        {warmValue > 0 && <span style={{ fontSize: "11px", color: T.green, fontFamily: T.fontMono }}>· {fmtMoney(warmValue)}/mo warm</span>}
        <span style={{ flex: 1 }} />
        {replyRate != null && <span style={{ fontSize: "11px", color: replyRate >= 15 ? T.green : T.faint, fontFamily: T.fontMono }}>{replyRate}% reply rate</span>}
        <span style={{ fontSize: "11px", color: T.faint, fontFamily: T.fontMono }}>{sentThisWeek} sent this week</span>
      </div>
    <div className="co-funnel" style={{ display: "flex", gap: "8px" }}>
      {stages.map((s, i) => {
        const count = counts[s.key];
        const prevCount = i > 0 ? counts[stages[i-1].key] : count;
        const convRate = prevCount > 0 ? Math.round((count / prevCount) * 100) : 0;
        const widthPct = Math.max(8, (count / max) * 100);
        return (
          // The kit's stat tile on the canvas: a hero number with a caption over
          // it. It was a hand-rolled tile with a border AND a shadow.
          <div key={s.key} className="stattile on-canvas" style={{ flex: 1, padding: "12px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px", marginBottom: "4px" }}>
              <span className="stattile-label">{s.label}</span>
              {i > 0 && <span className="stattile-delta" style={{ color: convRate >= 50 ? T.green : convRate >= 25 ? T.amber : T.faint }}>{convRate}%</span>}
            </div>
            <div className="stattile-value" style={{ color: T.inkDeep, marginBottom: "8px" }}>{count}</div>
            <div style={{ height: "4px", background: "rgba(255,255,255,0.06)", borderRadius: "2px", overflow: "hidden" }}>
              <div style={{ width: `${widthPct}%`, height: "100%", background: s.color, borderRadius: "2px" }} />
            </div>
          </div>
        );
      })}
    </div>
    </div>
  );
}


const CHAIN_STATUS_COLORS = { prospected: T.muted, draft: T.amberHi, draft_ready: T.amberHi, sent: T.blue, replied: T.pink, meeting: T.green, approved: T.green, rejected: T.red, snoozed: T.violet };

// One sibling location under a chain's primary card. Lifted out of ChainGroup
// so it is reachable on its own: it renders only once the group is expanded,
// which is component state no cold render can reach.
export function ChainLocationRow({ card, onStatusChange }) {
  const col = CHAIN_STATUS_COLORS[card.status] || T.muted;
  return (
    <div style={{ marginTop: "4px", background: T.surface, border: `1px solid ${T.line}`, borderLeft: `3px solid ${col}`, borderRadius: "8px", padding: "8px 12px", display: "flex", alignItems: "center", gap: "10px" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "12px", fontWeight: 600, color: T.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.prospect?.business_name}</div>
        <div style={{ fontSize: "10.5px", color: T.faint, marginTop: "2px" }}>{card.prospect?.address?.split(",")[0]}</div>
      </div>
      <span style={{ fontSize: "10.5px", fontWeight: 600, color: col, background: col + "20", padding: "2px 6px", borderRadius: "4px", flexShrink: 0 }}>
        {card.status}
      </span>
      {/* The kit's .icon-btn — this was a 1px-outlined glyph at 2px/6px padding,
          well under a thumb. */}
      <button onClick={() => onStatusChange(card.id, "rejected")} type="button" title="Reject this location" aria-label="Reject this location"
        className="icon-btn" style={{ width: 28, height: 28, fontSize: "12px" }}>✕</button>
    </div>
  );
}

export function ChainGroup({ primary, rest, chainName, toneMemory, onStatusChange, onDraftRegenerate, onToneFeedback, onEnrich, onMarkSent, isSelected, onToggleSelect }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      {/* Chain header */}
      <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px", padding: "3px 6px" }}>
        <span style={{ fontSize: "11px", color: T.gold, fontWeight: 700 }}>⑂</span>
        <span style={{ fontSize: "10.5px", color: T.muted, fontWeight: 600 }}>{chainName} chain · {rest.length + 1} locations</span>
        {/* The kit's .btn — a 10.5px text run with no background was neither a
            target nor a control anyone could see. */}
        <button onClick={() => setExpanded(!expanded)} type="button" aria-expanded={expanded}
          className="btn sm quiet" style={{ marginLeft: "auto", padding: "0 10px" }}>
          {expanded ? "↑ collapse" : `+ ${rest.length} more`}
        </button>
      </div>
      {/* Primary card */}
      <OutreachCard card={primary} toneMemory={toneMemory} onStatusChange={onStatusChange} onDraftRegenerate={onDraftRegenerate}
        onToneFeedback={onToneFeedback} onEnrich={onEnrich} onMarkSent={onMarkSent}
        isDupeName={false} isDupeEmail={false} isSelected={isSelected} onToggleSelect={onToggleSelect} />
      {/* Other locations — collapsed by default */}
      {expanded && rest.map(card => (
        <ChainLocationRow key={card.id} card={card} onStatusChange={onStatusChange} />
      ))}
    </div>
  );
}
