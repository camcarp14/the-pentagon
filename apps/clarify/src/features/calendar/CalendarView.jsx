import { useState, useMemo, useEffect } from "react";
import { T } from "../../theme";
import { DEFAULT_MEETING_MINUTES, SCHEDULING_LINK, SCHEDULING_LINK_CONFIGURED } from "../../config.js";
import { MonthCalendar } from "../mission/MissionControl.jsx";
import { createMeeting, suggestSlots } from "../../lib/meetings.js";
import { store } from "../../lib/store.js";
import { db } from "../../lib/supabase.js";
import { seqDb } from "../../lib/sequenceDb.js";

// ─── Calendar View — pipeline-aware booking + shareable link ──────────────────
export function BookingModal({ card, onClose, onBooked }) {
  const prospect = card.prospect || {};
  const contact = card.contact || {};
  const slots = useMemo(() => suggestSlots(new Date()), []);
  const [selectedSlot, setSelectedSlot] = useState(slots[0]);
  const [duration, setDuration] = useState(DEFAULT_MEETING_MINUTES);
  const [customTime, setCustomTime] = useState("");
  const [booking, setBooking] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const title = `${prospect.business_name || "Prospect"} <> Clarify Paid Search`;
  const details = `Intro call to walk through ${prospect.business_name || "your"} Google Ads — what's working, what's leaking, and where the quick wins are.\n\nBooked from Clarify.`;

  const book = async () => {
    setBooking(true); setError("");
    try {
      const start = customTime ? new Date(customTime) : selectedSlot;
      const res = await createMeeting({ title, details, start, durationMin: duration, guestEmail: contact.email, guestName: contact.name });
      setResult(res);
      onBooked && onBooked(card, start, res);
    } catch (e) {
      setError(e.message || "Booking failed");
    }
    setBooking(false);
  };

  const fmtSlot = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  return (
    <div className="co-modal-overlay" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadein 0.15s ease both" }}>
      <div className="co-modal-sheet" onClick={e => e.stopPropagation()} style={{ background: T.surface, borderRadius: "16px", padding: "24px 26px", width: "440px", maxWidth: "92vw", boxShadow: T.shadowModal }}>
        {!result ? (
          <>
            <div className="t-head" style={{ marginBottom: "3px" }}>Book a meeting</div>
            <div className="t-foot" style={{ marginBottom: "18px" }}>{prospect.business_name}{contact.name ? ` · ${contact.name}` : ""}{contact.email ? ` · ${contact.email}` : ""}</div>

            <div className="t-label" style={{ marginBottom: "8px" }}>Suggested times</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "14px" }}>
              {slots.map((s, i) => {
                const sel = !customTime && selectedSlot && s.getTime() === selectedSlot.getTime();
                return <button key={i} onClick={() => { setSelectedSlot(s); setCustomTime(""); }}
                  type="button" aria-pressed={sel} className={sel ? "btn md tinted" : "btn md quiet"} style={{ justifyContent: "flex-start", fontFamily: T.fontMono, fontWeight: sel ? 700 : 500 }}>
                  {fmtSlot(s)}
                </button>;
              })}
            </div>

            <div style={{ display: "flex", gap: "10px", marginBottom: "18px", alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <div className="t-label" style={{ marginBottom: "5px" }}>Or pick a time</div>
                <input type="datetime-local" value={customTime} onChange={e => setCustomTime(e.target.value)}
                  aria-label="Custom meeting time" className="field" style={{ fontFamily: T.fontMono }} />
              </div>
              <div style={{ width: "100px" }}>
                <div className="t-label" style={{ marginBottom: "5px" }}>Length</div>
                <select value={duration} onChange={e => setDuration(Number(e.target.value))}
                  aria-label="Meeting length" className="field" style={{ padding: "8px 10px", fontSize: "13px" }}>
                  <option value={15}>15 min</option>
                  <option value={30}>30 min</option>
                  <option value={45}>45 min</option>
                  <option value={60}>60 min</option>
                </select>
              </div>
            </div>

            {error && <div role="alert" className="t-cap" style={{ marginBottom: "12px", padding: "8px 12px", background: "rgba(248,113,113,0.10)", border: "none", borderRadius: "12px", color: T.red }}>{error} — adjust the time and try again.</div>}

            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={book} type="button" disabled={booking} className="btn md primary" style={{ flex: 1 }}>
                {booking ? "Opening…" : "📅 Create calendar invite"}
              </button>
              <button onClick={onClose} type="button" className="btn md quiet">Cancel</button>
            </div>
            <div className="t-cap" style={{ color: T.faint, marginTop: "10px", textAlign: "center" }}>Opens Google Calendar prefilled with the prospect as guest — confirm there to send the invite.</div>
          </>
        ) : (
          <div style={{ textAlign: "center", padding: "10px 0" }}>
            <div style={{ fontSize: "32px", marginBottom: "10px", color: T.green }}>✓</div>
            <div className="t-head" style={{ marginBottom: "6px" }}>Meeting created</div>
            <div className="t-foot" style={{ marginBottom: "16px" }}>Google Calendar opened in a new tab — confirm there to send the invite. The pipeline already shows it as booked.</div>
            {result.meetLink && <a href={result.meetLink} target="_blank" rel="noopener" style={{ display: "block", fontSize: "12px", color: T.blueDeep, marginBottom: "8px" }}>{result.meetLink}</a>}
            <button onClick={onClose} type="button" className="btn md primary">Done</button>
          </div>
        )}
      </div>
    </div>
  );
}


export function CalendarView({ cards, onStatusChange, onDataChange }) {
  const [bookingCard, setBookingCard] = useState(null);
  const [copied, setCopied] = useState(false);
  const [localMeetings, setLocalMeetings] = useState(() => store.get("meetings", []));
  const [schedulingLink, setSchedulingLink] = useState(SCHEDULING_LINK);

  // The scheduling link is a setting now (Settings tab); config is the fallback.
  useEffect(() => {
    seqDb.getSetting("scheduling_link").then((v) => { if (v?.url) setSchedulingLink(v.url); }).catch(() => {});
  }, []);
  const linkConfigured = SCHEDULING_LINK_CONFIGURED || schedulingLink !== SCHEDULING_LINK;

  // Meetings live on the outreach row (meeting_at/meeting_outcome — survives
  // any browser); the old localStorage array is merged in read-only so history
  // from before the migration still shows.
  const meetings = useMemo(() => {
    const fromCards = cards
      .filter((c) => c.meeting_at)
      .map((c) => ({ id: `db_${c.id}`, cardId: c.id, business: c.prospect?.business_name, email: c.contact?.email, start: c.meeting_at, outcome: c.meeting_outcome || "pending", db: true }));
    const dbCardIds = new Set(fromCards.map((m) => m.cardId));
    const legacy = localMeetings.filter((m) => !dbCardIds.has(m.cardId));
    return [...fromCards, ...legacy].sort((a, b) => new Date(a.start) - new Date(b.start));
  }, [cards, localMeetings]);

  // Pipeline-aware: prospects who replied (warmest, ready to book) + sent (in play)
  const readyToBook = cards.filter(c => c.status === "replied");
  const inPlay = cards.filter(c => c.status === "sent");

  const onBooked = async (card, start) => {
    // Persist on the pipeline row — the durable record.
    try {
      await db.updateOutreach(card.id, { meeting_at: start.toISOString(), meeting_outcome: "pending", status: "meeting" });
    } catch {}
    if (onStatusChange && card.id) onStatusChange(card.id, "meeting");
    // Refresh the shared cards cache so meeting_at shows up in 'Upcoming'
    // immediately — onStatusChange only patches `status` locally.
    if (onDataChange) await onDataChange();
  };

  // Record how a meeting went — closes the loop on the pipeline.
  const setOutcome = async (meetingId, outcome) => {
    const m = meetings.find((x) => x.id === meetingId);
    if (!m) return;
    if (m.db && m.cardId) {
      try { await db.updateOutreach(m.cardId, { meeting_outcome: outcome }); } catch {}
      // A won meeting flips back to replied (in play as a client conversation).
      if (onStatusChange && outcome === "won") onStatusChange(m.cardId, "replied");
      if (onDataChange) await onDataChange();
    } else {
      const next = localMeetings.map((x) => x.id === meetingId ? { ...x, outcome } : x);
      setLocalMeetings(next);
      store.set("meetings", next);
      if (onStatusChange && m.cardId && outcome === "won") onStatusChange(m.cardId, "replied");
    }
  };

  const copyLink = () => { try { navigator.clipboard.writeText(schedulingLink); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {} };
  const upcoming = meetings.filter(m => new Date(m.start) >= new Date(Date.now() - 3600000)).sort((a, b) => new Date(a.start) - new Date(b.start));
  const pastNeedsOutcome = meetings.filter(m => new Date(m.start) < new Date(Date.now() - 3600000) && (!m.outcome || m.outcome === "pending")).sort((a, b) => new Date(b.start) - new Date(a.start));
  const fmtSlot = (iso) => { const d = new Date(iso); return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); };

  // The kit's .card — this local one carried a border AND shadowCard, which is
  // the pairing the language forbids, on every surface in the tab.
  const Card = ({ children, style, className = "" }) => <div className={`card ${className}`.trim()} style={{ padding: "18px 20px", ...style }}>{children}</div>;

  return (
    <div style={{ minHeight: "calc(100vh - 48px)", background: "transparent", padding: "24px 28px" }}>
      <div style={{ marginBottom: "20px" }}>
        <h2 className="t-title2" style={{ margin: 0 }}>Calendar</h2>
        <div className="t-foot" style={{ marginTop: "2px" }}>Book meetings from your pipeline, or share a link that lets prospects pick a time.</div>
      </div>

      {/* Shareable booking link — the Settings-saved value wins; config is only the build-time fallback */}
      <Card style={{ marginBottom: "16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
        <div>
          <div className="t-label" style={{ marginBottom: "5px" }}>Your booking link</div>
          {linkConfigured
            ? <div className="t-call" style={{ fontFamily: T.fontMono, overflowWrap: "anywhere" }}>{schedulingLink}</div>
            : <div className="t-foot" style={{ color: T.amber }}>Not set up yet — add your Google/Calendly booking URL in System → Settings.</div>}
        </div>
        {linkConfigured && (
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={copyLink} type="button" className={copied ? "btn md quiet" : "btn md primary"} style={copied ? { color: T.green } : undefined}>{copied ? "✓ Copied" : "Copy link"}</button>
            <a href={schedulingLink} target="_blank" rel="noopener" className="btn md quiet" style={{ textDecoration: "none" }}>Open ›</a>
          </div>
        )}
      </Card>

      <div className="co-grid2" style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: "16px" }}>
        {/* Ready to book from pipeline */}
        <div>
          <div className="t-label" style={{ marginBottom: "12px" }}>Ready to book</div>
          {readyToBook.length === 0 && inPlay.length === 0 ? (
            <Card><div className="t-foot" style={{ textAlign: "center", padding: "20px 0" }}>No prospects in scheduling range yet — send outreach, and replies and sent threads land here ready to book.</div></Card>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {readyToBook.map(c => (
                // The pink rail is an inset shadow, not a borderLeft: a .card in
                // this language does not draw an edge.
                <Card key={c.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", boxShadow: `inset 3px 0 0 ${T.pink}, var(--shadow-card)` }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="cell-title">{c.prospect?.business_name}</div>
                    <div className="t-cap" style={{ color: T.faint, marginTop: "1px" }}>💬 Replied{c.contact?.name ? ` · ${c.contact.name}` : ""} · warmest — book now</div>
                  </div>
                  <button onClick={() => setBookingCard(c)} type="button" className="btn sm" style={{ background: T.pink, color: T.textOnBrand, flexShrink: 0 }}>📅 Book</button>
                </Card>
              ))}
              {inPlay.map(c => (
                <Card key={c.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="cell-title">{c.prospect?.business_name}</div>
                    <div className="t-cap" style={{ color: T.faint, marginTop: "1px" }}>Sent · propose a time to move it forward</div>
                  </div>
                  <button onClick={() => setBookingCard(c)} type="button" className="btn sm quiet" style={{ flexShrink: 0 }}>📅 Book</button>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Upcoming meetings */}
        <div>
          <div className="t-label" style={{ marginBottom: "12px" }}>Upcoming</div>
          {upcoming.length === 0 ? (
            <Card><div className="t-foot" style={{ textAlign: "center", padding: "20px 0" }}>No meetings booked yet — book one from a replied thread on the left.</div></Card>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {upcoming.map(m => (
                <Card key={m.id} style={{ boxShadow: `inset 3px 0 0 ${T.blueDeep}, var(--shadow-card)` }}>
                  <div className="cell-title">{m.business}</div>
                  <div className="t-cap" style={{ marginTop: "3px", fontFamily: T.fontMono }}>{fmtSlot(m.start)}</div>
                  {m.email && <div className="t-cap" style={{ color: T.faint, marginTop: "2px" }}>{m.email}</div>}
                  {m.link && <a href={m.link} target="_blank" rel="noopener" className="t-cap" style={{ color: T.blueDeep, marginTop: "4px", display: "inline-block" }}>View event ›</a>}
                </Card>
              ))}
            </div>
          )}

          {/* Past meetings awaiting an outcome — closes the loop */}
          {pastNeedsOutcome.length > 0 && (
            <div style={{ marginTop: "18px" }}>
              <div className="t-label" style={{ color: T.amber, marginBottom: "12px" }}>How'd it go?</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {pastNeedsOutcome.map(m => (
                  <Card key={m.id} style={{ boxShadow: `inset 3px 0 0 ${T.amber}, var(--shadow-card)` }}>
                    <div className="cell-title">{m.business}</div>
                    <div className="t-cap" style={{ color: T.faint, marginTop: "3px", fontFamily: T.fontMono }}>{fmtSlot(m.start)}</div>
                    <div style={{ display: "flex", gap: "6px", marginTop: "10px" }}>
                      {[["won","Won",T.green],["followup","Follow up",T.blue],["noshow","No-show",T.faint],["lost","Lost",T.red]].map(([k,l,col]) => (
                        <button key={k} type="button" onClick={() => setOutcome(m.id, k)} className="btn sm" style={{ flex: 1, padding: "0 4px", background: col + "18", color: col }}>{l}</button>
                      ))}
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Month grid — full view of booked meetings */}
      <MonthCalendar hideOpenLink cards={cards} />

      {bookingCard && <BookingModal card={bookingCard} onClose={() => setBookingCard(null)} onBooked={onBooked} />}
    </div>
  );
}
