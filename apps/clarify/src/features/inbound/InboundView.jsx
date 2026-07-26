import { useState, useEffect, useMemo } from "react";
import { T, card as cardBase, sectionLabel as sectionLabelBase, inputBase } from "../../theme";
import { EmptyState, SkeletonLine, SkeletonRows } from "../../ui.jsx";
import { LeadJourney } from "../../components/LeadJourney.jsx";
import { cleanBody, cleanReplyBody, cleanSubject, sendEmail, timeAgo } from "../../lib/email.js";
import { budgetMidpoint, createCardFromInbound, draftInboundReply, inboundBiz, inboundBudget, inboundMessage, inboundPerson, inboundService } from "../../lib/leads.js";
import { sm } from "../../lib/store.js";
import { db, normEmail, sbAuth, sbFetch, currentAccessToken } from "../../lib/supabase.js";

// ─── Inbound — native view. One lens over inbound_leads + their pipeline cards. ─
// The old separate InboundLeads.jsx is replaced: same table, same statuses, but the
// conversation now lives HERE — form message, your reply, their reply, next reply —
// and replying auto-promotes a lead into the pipeline so nothing needs re-entering.
export function InboundView({ cards, onNavigate, onCardsChange, toneMemory }) {
  const [leads, setLeads] = useState(null);
  const [filter, setFilter] = useState("active");
  const [selId, setSelId] = useState(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  const load = async () => {
    try { setLeads(await sbFetch(`/inbound_leads?order=created_at.desc&limit=200`) || []); }
    catch (e) { setLeads([]); setNote("Couldn't load inbound leads: " + e.message); }
  };
  useEffect(() => { load(); }, []);

  // Card linkage by email — self-healing, no schema change needed.
  const cardByEmail = useMemo(() => {
    const m = {};
    for (const c of cards || []) { const e = normEmail(c.contact?.email); if (e && !m[e]) m[e] = c; }
    return m;
  }, [cards]);

  // Cross-tab focus handoff (e.g. "view conversation" from a client's origin line)
  useEffect(() => {
    if (!leads) return;
    const focus = sm.get("inbound_focus");
    if (focus) {
      const hit = leads.find(l => normEmail(l.email) === normEmail(focus));
      if (hit) setSelId(hit.id);
      sm.del("inbound_focus");
    }
  }, [leads]);

  if (leads === null) return (
    <div style={{ padding: "24px 28px", maxWidth: "1240px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "10px" }}>
      <SkeletonLine width="220px" height="22px" style={{ marginBottom: "6px" }} />
      <SkeletonRows count={3} />
    </div>
  );

  const enrich = (l) => ({ ...l, card: cardByEmail[normEmail(l.email)] || null });
  const all = leads.map(enrich);
  const shown = all.filter(l =>
    filter === "active" ? l.status !== "archived"
    : filter === "new" ? l.status === "new"
    : filter === "reviewed" ? l.status === "reviewed"
    : l.status === "archived");
  const sel = all.find(l => l.id === selId) || null;
  const newCount = all.filter(l => l.status === "new").length;

  const patchLead = async (id, updates) => {
    await sbFetch(`/inbound_leads?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(updates) });
    await load();
  };

  const deleteLead = async (l) => {
    if (!window.confirm(`Delete the lead from ${inboundBiz(l)}? This can't be undone. Their pipeline card (if any) stays intact.`)) return;
    setBusy("delete"); setNote("");
    try {
      await db.deleteInboundLead(l.id);
      if (selId === l.id) setSelId(null);
      await load();
    } catch (e) { setNote("Couldn't delete: " + e.message); }
    setBusy("");
  };

  const selectLead = (l) => {
    setSelId(l.id); setNote("");
    const c = l.card;
    setSubject(c?.reply_subject ? (c.reply_subject.startsWith("Re:") ? c.reply_subject : `Re: ${c.reply_subject}`)
      : c?.draft_subject ? `Re: ${cleanSubject(c.draft_subject)}`
      : `Re: your Clarify inquiry`);
    setBody("");
  };

  const addToPipeline = async (l) => {
    setBusy("pipeline"); setNote("");
    try {
      await createCardFromInbound(l);
      if (l.status === "new") await patchLead(l.id, { status: "reviewed" }); else await load();
      await onCardsChange();
      setNote("✓ In pipeline — it's now a live outreach card.");
    } catch (e) { setNote("Failed: " + e.message); }
    setBusy("");
  };

  const draftAI = async (l) => {
    setBusy("draft"); setNote("");
    const d = await draftInboundReply(l, l.card);
    if (d.subject) setSubject(d.subject);
    setBody(d.body || "");
    setBusy("");
  };

  const sendReply = async (l) => {
    if (!body.trim() || !l.email) return;
    setBusy("send"); setNote("");
    try {
      const c = l.card;
      if (c && c.sent_at) {
        // Existing thread — reply into it so Gmail threading + reply detection hold.
        const result = await sendEmail({
          to: l.email, subject, body,
          replyToMessageId: c.reply_gmail_message_id || c.gmail_rfc_message_id,
          threadId: c.gmail_thread_id,
        });
        await db.updateOutreach(c.id, { status: "sent" });
        setNote(result.method === "gmail_compose" ? "✓ Opened in Gmail" : "✓ Reply sent — thread continues in Outreach too.");
      } else {
        // First touch — send, then birth the pipeline card already wired to this thread.
        const result = await sendEmail({ to: l.email, subject, body });
        await createCardFromInbound(l, { subject, body, ...result });
        setNote(result.method === "gmail_compose" ? "✓ Opened in Gmail — card created as draft." : "✓ Sent — lead is now in your pipeline, reply detection is watching.");
      }
      if (l.status === "new") await patchLead(l.id, { status: "reviewed" });
      await onCardsChange(); await load();
      setBody("");
    } catch (e) { setNote("Failed: " + e.message); }
    setBusy("");
  };

  const convertToClient = async (l) => {
    setBusy("client"); setNote("");
    try {
      const token = await currentAccessToken();
      const user = token ? await sbAuth.getUser(token) : null;
      if (!user?.id) throw new Error("Couldn't confirm your account — refresh and retry.");
      const [row] = await sbFetch(`/clients`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: inboundBiz(l), industry: inboundService(l),
          monthly_budget: budgetMidpoint(inboundBudget(l)),
          status: "active", user_id: user.id,
        }),
      });
      if (row?.id) sm.set(`client_origin_${row.id}`, { email: normEmail(l.email), business: inboundBiz(l), source: "inbound form" });
      setNote(`✓ ${inboundBiz(l)} is now a client — full account page is live in Clients.`);
    } catch (e) { setNote("Failed: " + e.message); }
    setBusy("");
  };

  const chip = (bg, color, text) => <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: T.rPill, background: bg, color, letterSpacing: "0.05em", textTransform: "uppercase", fontFamily: T.fontDisplay }}>{text}</span>;
  const statusChip = (l) => l.card ? chip(`${T.green}1A`, T.green, l.card.status === "replied" ? "replied" : l.card.status === "meeting" ? "meeting" : "in pipeline")
    : l.status === "new" ? chip(`${T.blue}1A`, T.blue, "new")
    : l.status === "archived" ? chip("rgba(255,255,255,0.06)", T.faint, "archived")
    : chip(`${T.amber}1A`, T.amber, "reviewed");

  const Bubble = ({ who, when, color, subjectLine, bg = T.subtle, children }) => (
    <div style={{ background: bg, borderRadius: T.rSm, padding: "12px 14px", borderLeft: `3px solid ${color}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
        <span style={{ fontSize: "11px", fontWeight: 700, color }}>{who}</span>
        <span style={{ fontSize: "10px", color: T.faint }}>{when}</span>
      </div>
      {subjectLine && <div style={{ fontSize: "12px", fontWeight: 600, color: T.muted, marginBottom: "5px" }}>{subjectLine}</div>}
      <div style={{ fontSize: "13px", color: T.ink, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{children}</div>
    </div>
  );

  return (
    <div style={{ padding: "24px 28px", maxWidth: "1240px", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "4px" }}>
        <h1 style={{ fontSize: "24px", fontWeight: 800, fontFamily: T.fontDisplay, color: T.ink, margin: 0 }}>Inbound Leads</h1>
        {newCount > 0 && chip(`${T.blue}1A`, T.blue, `${newCount} new`)}
      </div>
      <div style={{ fontSize: "13px", color: T.muted, marginBottom: "16px" }}>Audit requests from the Clarify Paid Search site — reply right here; replying puts them in the pipeline automatically.</div>

      <div style={{ display: "flex", gap: "6px", marginBottom: "16px" }}>
        {["active", "new", "reviewed", "archived"].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{ padding: "6px 14px", borderRadius: T.rPill, border: `1px solid ${filter === f ? "rgba(255,255,255,0.2)" : T.line}`, background: filter === f ? T.surface : "transparent", color: filter === f ? T.ink : T.muted, fontSize: "12px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize" }}>{f}</button>
        ))}
      </div>

      {/* Page-level feedback — visible whether or not a lead is open, so a delete
          triggered straight from the list (no panel open) isn't silently swallowed. */}
      {note && (
        <div style={{ marginBottom: "14px", padding: "10px 14px", borderRadius: T.rSm, background: note.startsWith("✓") ? T.green + "14" : T.red + "12", border: `1px solid ${note.startsWith("✓") ? T.green + "40" : T.red + "33"}`, fontSize: "12.5px", color: note.startsWith("✓") ? T.green : T.red }}>
          {note}
        </div>
      )}

      <div className="co-inbound-grid" style={{ display: "grid", gridTemplateColumns: sel ? "340px 1fr" : "1fr", gap: "16px", alignItems: "start" }}>
        {/* List — hidden on mobile once a lead is open, so the conversation replaces it instead of stacking beneath it */}
        <div className={sel ? "co-hide-when-detail" : ""} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {shown.length === 0 && (
            <EmptyState icon="inbox" title={`No ${filter === "active" ? "active" : filter} leads`} sub="Inquiries from the Clarify Paid Search site will show up here as they come in." />
          )}
          {shown.map(l => (
            <div key={l.id} onClick={() => selectLead(l)} style={{ ...cardBase, padding: "14px 16px", cursor: "pointer", border: `1px solid ${T.lineSoft}`, background: sel?.id === l.id ? `linear-gradient(rgba(255,255,255,0.05), rgba(255,255,255,0.05)), ${T.surface}` : T.surface, outline: sel?.id === l.id ? `2px solid ${T.gold}` : "none", position: "relative" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "15px", fontWeight: 800, fontFamily: T.fontDisplay, color: T.ink, display: "flex", alignItems: "center", gap: "6px" }}>
                  {l.status === "new" && <span aria-hidden="true" title="Unread" style={{ width: "6px", height: "6px", borderRadius: "50%", background: T.pink, flexShrink: 0 }} />}
                  {inboundBiz(l)}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  {statusChip(l)}
                  <button onClick={(e) => { e.stopPropagation(); deleteLead(l); }} title="Delete lead" aria-label="Delete lead" className="co-icon-btn"
                    style={{ background: "none", border: "none", color: T.faint, fontSize: "13px", cursor: "pointer", padding: "2px 4px", lineHeight: 1 }}>🗑</button>
                </div>
              </div>
              <div style={{ fontSize: "11.5px", color: T.muted, marginTop: "3px" }}>
                {[inboundPerson(l), inboundBudget(l) && `${inboundBudget(l)} / mo`, timeAgo(l.created_at)].filter(Boolean).join(" · ")}
              </div>
              {!sel && inboundMessage(l) && <div style={{ fontSize: "12.5px", color: T.muted, marginTop: "8px" }}>{inboundMessage(l).slice(0, 140)}</div>}
            </div>
          ))}
        </div>

        {/* Conversation panel */}
        {sel && (
          <div style={{ ...cardBase, padding: "18px 20px" }}>
            {/* Mobile-only: explicit way back to the list, since it's hidden (not stacked) while a lead is open */}
            <button onClick={() => setSelId(null)} className="co-mobile-only" style={{ display: "none", alignItems: "center", gap: "5px", background: "none", border: "none", color: T.muted, fontSize: "12px", fontWeight: 700, cursor: "pointer", padding: "0 0 12px", fontFamily: T.fontDisplay }}>← All leads</button>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: "17px", fontWeight: 800, fontFamily: T.fontDisplay, color: T.ink }}>{inboundBiz(sel)}</div>
                <div style={{ fontSize: "12px", color: T.muted, marginTop: "2px" }}>
                  {[inboundPerson(sel), sel.email, inboundService(sel), inboundBudget(sel) && `${inboundBudget(sel)}/mo`].filter(Boolean).join(" · ")}
                  {sel.website && <> · <a href={sel.website.startsWith("http") ? sel.website : `https://${sel.website}`} target="_blank" rel="noreferrer" style={{ color: T.blue }}>{sel.website} ↗</a></>}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <button onClick={() => deleteLead(sel)} title="Delete lead" style={{ background: "none", border: `1px solid ${T.red}40`, borderRadius: "7px", color: T.red, fontSize: "11px", fontWeight: 700, cursor: "pointer", padding: "5px 10px" }}>🗑 Delete</button>
                <button onClick={() => setSelId(null)} title="Close" className="co-icon-btn co-desktop-only" style={{ background: "none", border: "none", color: T.muted, fontSize: "18px", cursor: "pointer" }}>×</button>
              </div>
            </div>
            <div style={{ margin: "12px 0 14px" }}><LeadJourney card={sel.card} hasInbound={true} /></div>

            {/* Actions — contextual to where the lead stands */}
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "16px" }}>
              {!sel.card && <button disabled={!!busy} onClick={() => addToPipeline(sel)} style={{ padding: "6px 14px", background: T.gold, border: "none", borderRadius: T.rSm, color: T.textOnBrand, fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay }}>{busy === "pipeline" ? "Adding…" : "+ Add to pipeline"}</button>}
              {sel.card && <button onClick={() => { sm.set("outreach_focus", sel.card.prospect?.business_name || sel.email); onNavigate("outreach"); }} style={{ padding: "6px 14px", background: "transparent", border: `1px solid ${T.goldLine}`, borderRadius: T.rSm, color: T.gold, fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay }}>View in Outreach →</button>}
              {sel.card && ["replied", "meeting"].includes(sel.card.status) && <button disabled={!!busy} onClick={() => convertToClient(sel)} style={{ padding: "6px 14px", background: T.green, border: "none", borderRadius: T.rSm, color: "#0A1B12", fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay }}>{busy === "client" ? "Converting…" : "★ Convert to client"}</button>}
              {sel.status !== "archived" && sel.status === "new" && <button onClick={() => patchLead(sel.id, { status: "reviewed" })} style={{ padding: "6px 14px", background: "transparent", border: `1px solid ${T.line}`, borderRadius: T.rSm, color: T.muted, fontSize: "11px", fontWeight: 600, cursor: "pointer" }}>Mark reviewed</button>}
              {sel.status !== "archived"
                ? <button onClick={() => patchLead(sel.id, { status: "archived" })} style={{ padding: "6px 14px", background: "transparent", border: `1px solid ${T.line}`, borderRadius: T.rSm, color: T.muted, fontSize: "11px", fontWeight: 600, cursor: "pointer" }}>Archive</button>
                : <button onClick={() => patchLead(sel.id, { status: "reviewed" })} style={{ padding: "6px 14px", background: "transparent", border: `1px solid ${T.line}`, borderRadius: T.rSm, color: T.muted, fontSize: "11px", fontWeight: 600, cursor: "pointer" }}>Restore</button>}
            </div>

            {/* The conversation — form message + full email thread */}
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <Bubble who={`${inboundPerson(sel) || inboundBiz(sel)} — via clarifypaidsearch.com`} when={timeAgo(sel.created_at)} color={T.blue}>
                {inboundMessage(sel) || "(submitted the form without a message)"}
              </Bubble>
              {sel.card?.sent_at && (
                <Bubble who={`You → ${sel.email}`} when={timeAgo(sel.card.sent_at)} color={T.gold} bg={T.goldSoft} subjectLine={cleanSubject(sel.card.draft_subject)}>
                  {cleanBody(sel.card.draft_body)}
                </Bubble>
              )}
              {sel.card?.reply_body && (
                <Bubble who={sel.card.reply_from?.split("<")[0].trim() || inboundPerson(sel) || "Them"} when={timeAgo(sel.card.replied_at)} color={T.pink}>
                  {cleanReplyBody(sel.card.reply_body)}
                </Bubble>
              )}
              {sel.card?.sent_at && !sel.card?.reply_body && (
                <div style={{ fontSize: "11px", color: T.faint, paddingLeft: "4px" }}>Sent {timeAgo(sel.card.sent_at)} — reply detection is watching this thread.</div>
              )}
            </div>

            {/* Composer */}
            <div style={{ marginTop: "16px", borderTop: `1px solid ${T.lineInk}`, paddingTop: "14px" }}>
              <div style={{ ...sectionLabelBase, fontSize: "10px", marginBottom: "8px" }}>{sel.card?.sent_at ? "Reply" : "First reply — sending creates the pipeline card"}</div>
              <input value={subject} onChange={e => setSubject(e.target.value)} style={{ ...inputBase, fontSize: "12.5px", fontWeight: 600, marginBottom: "8px" }} />
              <textarea value={body} onChange={e => setBody(e.target.value)} rows={6} placeholder={`Hi ${inboundPerson(sel) || "there"} — thanks for reaching out about ${inboundService(sel) || "your search program"}…`} style={{ ...inputBase, fontSize: "13px", lineHeight: 1.6, resize: "vertical" }} />
              <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
                <button disabled={!!busy || !body.trim()} onClick={() => sendReply(sel)} style={{ padding: "8px 18px", background: busy || !body.trim() ? "rgba(255,255,255,0.06)" : T.ink, border: "none", borderRadius: T.rSm, color: busy || !body.trim() ? T.muted : T.textOnBrand, fontSize: "12px", fontWeight: 700, cursor: busy || !body.trim() ? "not-allowed" : "pointer", fontFamily: T.fontDisplay }}>{busy === "send" ? "Sending…" : "Send reply"}</button>
                <button disabled={!!busy} onClick={() => draftAI(sel)} style={{ padding: "8px 14px", background: T.goldSoft, border: `1px solid ${T.goldLine}`, borderRadius: T.rSm, color: T.gold, fontSize: "12px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay }}>{busy === "draft" ? "Drafting…" : "✦ Draft with AI"}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
