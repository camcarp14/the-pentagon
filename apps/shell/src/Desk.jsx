// ═══════════════════════════════════════════════════════════════════════════
// DESK — the one surface where work gets approved.
//
// The brief: "turn key … my input driving the direction, but I don't want to be
// overwhelmed by input toggles, but still have strong visibility/control
// somewhere." Three rules came out of that, and they decided everything here.
//
//   • DIRECTION IS NOT SETTINGS. Five fields per engine, all of them things
//     only the operator knows — who this is for, what is being sold, what to
//     talk about. Cadence, retries, dedupe, tone calibration, model choice and
//     scheduling are the engine's problem and appear nowhere on this screen.
//   • ONE QUEUE, NOT TWO. Articles and emails land in the same list, ranked by
//     what goes wrong if ignored. The operator should never have to remember
//     which tool a piece of work came from.
//   • APPROVING IS ONE TAP, REJECTING ASKS WHY. The asymmetry is deliberate:
//     approval needs no explanation, and the reason for a rejection is the only
//     training signal the outbound engine ever receives.
//
// Direction collapses once it is filled in. On day one it is the only thing on
// screen, because an empty queue with no direction set is not a state to
// explain — it is a form to fill in.
// ═══════════════════════════════════════════════════════════════════════════
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@cc/supabase";
import { buildQueue, queueSummary, KIND, OUTREACH_DRAFT_STATUSES } from "@cc/ops/queue.js";
import { resolveDirection, ENGINE, DIRECTION_KEY, HARD_MAX } from "@cc/ops/direction.js";

const P = {
  bg: "#0A0E15", surface: "#131A24", surface2: "#0F151E", line: "rgba(255,255,255,0.08)",
  ink: "#E9EDF5", muted: "#93A1B5", faint: "#66748A",
  display: "'Syne', system-ui", mono: "'DM Mono', monospace",
  good: "#12A594", warn: "#D4930B", crit: "#E11D48", info: "#6EA8FE",
};

const KIND_META = {
  [KIND.CONTENT]: { label: "Article", tone: P.info, verb: "Publish" },
  [KIND.OUTBOUND]: { label: "Email", tone: P.good, verb: "Send" },
};

const ago = (ts) => {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

function Field({ label, hint, value, onChange, textarea, type = "text", min, max }) {
  const style = {
    width: "100%", background: P.surface2, border: `1px solid ${P.line}`, borderRadius: 10,
    color: P.ink, fontSize: 13, padding: "10px 12px", fontFamily: "inherit",
    lineHeight: 1.5, resize: textarea ? "vertical" : undefined, minHeight: textarea ? 64 : 42,
    boxSizing: "border-box",
  };
  return (
    <label style={{ display: "block", marginBottom: 13 }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: P.ink, marginBottom: 5, letterSpacing: "0.01em" }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: P.faint, marginBottom: 6, lineHeight: 1.45 }}>{hint}</div>}
      {textarea
        ? <textarea value={value} onChange={(e) => onChange(e.target.value)} style={style} rows={2} />
        : <input type={type} min={min} max={max} value={value} onChange={(e) => onChange(e.target.value)} style={style} />}
    </label>
  );
}

function Card({ children, style }) {
  return (
    <div style={{ background: P.surface, border: `1px solid ${P.line}`, borderRadius: 16, padding: 18, marginBottom: 14, ...style }}>
      {children}
    </div>
  );
}

export default function Desk({ isMobile }) {
  const [contentDir, setContentDir] = useState(null);
  const [outboundDir, setOutboundDir] = useState(null);
  const [contentDrafts, setContentDrafts] = useState([]);
  const [outreachDrafts, setOutreachDrafts] = useState([]);
  const [err, setErr] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [showDirection, setShowDirection] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    if (!supabase) { setErr("Supabase isn't configured — the Desk can't read anything."); setLoaded(true); return; }
    setErr("");
    try {
      const [dc, dob, cd, od] = await Promise.all([
        supabase.from("app_settings").select("value").eq("key", DIRECTION_KEY[ENGINE.CONTENT]).maybeSingle(),
        supabase.from("app_settings").select("value").eq("key", DIRECTION_KEY[ENGINE.OUTBOUND]).maybeSingle(),
        supabase.from("content_drafts").select("*").eq("status", "draft_ready").order("created_at"),
        supabase.from("outreach")
          .select("*, contacts(email, name), prospects(business_name, prospect_brief, brief_callouts)")
          .in("status", OUTREACH_DRAFT_STATUSES).order("created_at"),
      ]);

      // Applied independently, same reasoning as the Ops console: one failed
      // read must not discard three good ones and render an empty Desk that
      // looks like "no work waiting".
      const errs = [];
      if (dc.error) errs.push(`content direction: ${dc.error.message}`);
      else setContentDir(resolveDirection(ENGINE.CONTENT, dc.data?.value).direction);
      if (dob.error) errs.push(`outbound direction: ${dob.error.message}`);
      else setOutboundDir(resolveDirection(ENGINE.OUTBOUND, dob.data?.value).direction);
      if (cd.error) errs.push(`articles: ${cd.error.message}`); else setContentDrafts(cd.data || []);
      if (od.error) errs.push(`emails: ${od.error.message}`); else setOutreachDrafts(od.data || []);
      if (errs.length) setErr(errs.join(" · "));
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Flatten the PostgREST embeds into the flat shape the pure queue module
  // expects, so the ranking logic never has to know about join syntax.
  const flatOutreach = useMemo(() => outreachDrafts.map((r) => ({
    ...r,
    contact_email: r.contacts?.email,
    contact_name: r.contacts?.name,
    business_name: r.prospects?.business_name,
    prospect_brief: r.prospects?.prospect_brief,
    brief_callouts: r.prospects?.brief_callouts,
  })), [outreachDrafts]);

  const queue = useMemo(
    () => buildQueue({ contentDrafts, outreachDrafts: flatOutreach, now: Date.now() }),
    [contentDrafts, flatOutreach],
  );
  const summary = useMemo(() => queueSummary(queue), [queue]);

  const contentReady = contentDir ? resolveDirection(ENGINE.CONTENT, contentDir).ready : false;
  const outboundReady = outboundDir ? resolveDirection(ENGINE.OUTBOUND, outboundDir).ready : false;
  const anyDirection = contentReady || outboundReady;

  // Open Direction automatically when nothing is configured. On day one the
  // form IS the screen; there is nothing else to look at.
  useEffect(() => {
    if (loaded && !anyDirection) setShowDirection(true);
  }, [loaded, anyDirection]);

  // Outbound bodies come off the queue item, which normalised them — the same
  // text queue-execute will transmit. Reading draft_body raw here would show a
  // JSON blob for the rows that have one.
  const bodyOf = (item) => {
    if (item.kind === KIND.CONTENT) return contentDrafts.find((d) => d.id === item.id)?.body_html || "";
    return item.body || "";
  };

  const saveDirection = async (engine, value) => {
    setSaving(true); setErr(""); setNote("");
    try {
      const { error } = await supabase.from("app_settings")
        .upsert({ key: DIRECTION_KEY[engine], value, updated_at: new Date().toISOString() }, { onConflict: "key" });
      if (error) throw new Error(error.message);
      setNote("Direction saved. The engines pick it up on their next pass.");
      await load();
    } catch (e) { setErr(`Couldn't save direction: ${e.message}`); }
    finally { setSaving(false); }
  };

  const act = async (item, action) => {
    let reason = null;
    if (action === "reject") {
      // Asking why is the only training signal the outbound engine gets, so
      // the prompt is not skippable-by-default — but an empty answer is still
      // accepted, because forcing prose to reject something is how a queue
      // stops getting triaged.
      reason = window.prompt(
        item.kind === KIND.OUTBOUND
          ? "What was wrong with this one? (fed back into future drafts)"
          : "Why reject this article? (optional)",
        "",
      );
      if (reason === null) return; // cancelled
    }

    setBusyId(item.id); setErr(""); setNote("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/.netlify/functions/queue-execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ kind: item.kind, id: item.id, action, reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setNote(
        data.status === "published" ? `Published — ${data.url}`
          : data.status === "sent" ? `Sent to ${data.to}`
          : "Rejected.",
      );
      setOpenId(null);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ fontSize: 20, fontWeight: 800, color: P.ink, fontFamily: P.display, margin: 0 }}>Desk</h2>
        <p style={{ fontSize: 12.5, color: P.muted, margin: "5px 0 0", lineHeight: 1.5 }}>
          The engines write. You decide. Nothing here reaches a customer without your tap.
        </p>
      </div>

      {err && (
        <div role="alert" style={{ background: "rgba(225,29,72,0.12)", border: `1px solid ${P.crit}55`, color: "#FF8DA6", borderRadius: 12, padding: "11px 13px", fontSize: 12.5, marginBottom: 14, lineHeight: 1.5 }}>
          {err}
        </div>
      )}
      {note && (
        <div style={{ background: "rgba(18,165,148,0.12)", border: `1px solid ${P.good}55`, color: "#7FE3D4", borderRadius: 12, padding: "11px 13px", fontSize: 12.5, marginBottom: 14, lineHeight: 1.5, wordBreak: "break-word" }}>
          {note}
        </div>
      )}

      {/* ── the queue ────────────────────────────────────────────────────── */}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "15px 18px", borderBottom: `1px solid ${P.line}`, display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 15.5, fontWeight: 800, color: P.ink, fontFamily: P.display }}>
            {summary.waiting > 0
              ? `${summary.waiting} waiting on you`
              : summary.stale > 0
                // "Nothing waiting" rendered directly above two visible drafts,
                // because `waiting` counts only live items. Stale work is still
                // work — it needs rejecting so a fresh one gets written.
                ? `${summary.stale} stale — needs clearing`
                : "Nothing waiting"}
          </span>
          {summary.waiting > 0 && (
            <span style={{ fontSize: 11.5, color: P.muted }}>
              {summary.outbound} email{summary.outbound === 1 ? "" : "s"} · {summary.content} article{summary.content === 1 ? "" : "s"}
              {summary.oldestAgeDays > 0 && ` · oldest ${summary.oldestAgeDays}d`}
            </span>
          )}
          {summary.stale > 0 && (
            <span style={{ fontSize: 11.5, color: P.warn }}>{summary.stale} stale</span>
          )}
        </div>

        {!loaded && <div style={{ padding: 18, fontSize: 12.5, color: P.muted }}>Reading the queue…</div>}

        {loaded && queue.length === 0 && (
          <div style={{ padding: "18px", fontSize: 12.5, color: P.muted, lineHeight: 1.6 }}>
            {!anyDirection
              ? "No direction set yet, so the engines have nothing to work from. Fill in Direction below and the first drafts appear within a few hours."
              : "The engines have nothing queued. They run on a schedule and will fill this in — nothing is stuck."}
          </div>
        )}

        {loaded && queue.map((item) => {
          const meta = KIND_META[item.kind];
          const open = openId === item.id;
          const busy = busyId === item.id;
          return (
            <div key={item.id} style={{ borderBottom: `1px solid ${P.line}`, opacity: item.stale ? 0.6 : 1 }}>
              <button
                onClick={() => setOpenId(open ? null : item.id)}
                style={{
                  width: "100%", background: "none", border: "none", textAlign: "left",
                  padding: "14px 18px", cursor: "pointer", color: "inherit", display: "block",
                }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: meta.tone, border: `1px solid ${meta.tone}55`, borderRadius: 5, padding: "2px 6px" }}>
                    {meta.label}
                  </span>
                  <span style={{ fontSize: 11, color: P.faint }}>{item.target}</span>
                  <span style={{ fontSize: 11, color: P.faint, marginLeft: "auto" }}>{ago(item.createdAt)}</span>
                  {item.stale && <span style={{ fontSize: 10, fontWeight: 700, color: P.warn }}>STALE</span>}
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: P.ink, lineHeight: 1.4, marginBottom: 4 }}>
                  {item.title}
                </div>
                <div style={{ fontSize: 12, color: P.muted, lineHeight: 1.5 }}>{item.preview}</div>
              </button>

              {open && (
                <div style={{ padding: "0 18px 16px" }}>
                  {item.why && (
                    <div style={{ fontSize: 11.5, color: P.muted, lineHeight: 1.55, borderLeft: `2px solid ${P.line}`, paddingLeft: 10, marginBottom: 12 }}>
                      <strong style={{ color: P.ink, fontWeight: 700 }}>Why this:</strong> {item.why}
                    </div>
                  )}
                  <div style={{
                    background: P.surface2, border: `1px solid ${P.line}`, borderRadius: 10, padding: 13,
                    fontSize: 12.5, color: P.ink, lineHeight: 1.65, maxHeight: 340, overflowY: "auto",
                    whiteSpace: item.kind === KIND.OUTBOUND ? "pre-wrap" : "normal", marginBottom: 12,
                    wordBreak: "break-word",
                  }}>
                    {item.kind === KIND.OUTBOUND
                      ? bodyOf(item)
                      // The article body is engine-authored HTML that never
                      // leaves this system before an operator reads it, and it
                      // is the actual artifact being approved — rendering the
                      // raw tags instead would make the review meaningless.
                      : <div dangerouslySetInnerHTML={{ __html: bodyOf(item) }} />}
                  </div>

                  {item.stale && (
                    <div style={{ fontSize: 11.5, color: P.warn, lineHeight: 1.5, marginBottom: 10 }}>
                      This was written {item.ageDays} days ago and describes the recipient as they were then. Sending is refused — reject it and a fresh one gets written.
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                    <button
                      onClick={() => act(item, "approve")}
                      disabled={busy || item.stale}
                      style={{
                        minHeight: 42, padding: "0 18px", borderRadius: 10,
                        border: `1px solid ${item.stale ? P.line : meta.tone}`,
                        background: item.stale ? "transparent" : `${meta.tone}22`,
                        color: item.stale ? P.faint : P.ink,
                        fontSize: 13, fontWeight: 800, fontFamily: P.display,
                        cursor: busy || item.stale ? "default" : "pointer", opacity: busy ? 0.55 : 1,
                      }}>
                      {busy ? "…" : meta.verb}
                    </button>
                    <button
                      onClick={() => act(item, "reject")}
                      disabled={busy}
                      style={{
                        minHeight: 42, padding: "0 18px", borderRadius: 10,
                        border: `1px solid ${P.line}`, background: "transparent", color: P.muted,
                        fontSize: 13, fontWeight: 700, fontFamily: P.display,
                        cursor: busy ? "default" : "pointer", opacity: busy ? 0.55 : 1,
                      }}>
                      Reject
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </Card>

      {/* ── direction ────────────────────────────────────────────────────── */}
      <button
        onClick={() => setShowDirection((v) => !v)}
        style={{
          width: "100%", background: P.surface, border: `1px solid ${P.line}`, borderRadius: 16,
          padding: "14px 18px", cursor: "pointer", textAlign: "left", marginBottom: showDirection ? 14 : 0,
          display: "flex", alignItems: "center", gap: 10,
        }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 800, color: P.ink, fontFamily: P.display }}>Direction</div>
          <div style={{ fontSize: 11.5, color: P.muted, marginTop: 3, lineHeight: 1.5 }}>
            {contentReady && outboundReady ? "Both engines pointed. Change it any time."
              : contentReady ? "Articles pointed · outbound still needs who and what"
              : outboundReady ? "Outbound pointed · articles still need audience and topics"
              : "Not set — the engines are idle until this is filled in"}
          </div>
        </div>
        <span style={{ fontSize: 18, color: P.faint, lineHeight: 1 }}>{showDirection ? "–" : "+"}</span>
      </button>

      {showDirection && (
        <>
          <DirectionForm
            title="Articles"
            subtitle="What the content engine writes about, and for whom."
            engine={ENGINE.CONTENT}
            value={contentDir}
            saving={saving}
            onSave={saveDirection}
            fields={[
              ["audience", "Who is this for?", "The person reading. e.g. people new to self-custody who just bought their first hardware wallet."],
              ["product", "What are you selling?", "One line. Used sparingly — at most one mention per article."],
              ["topics", "Topics", "One per line, or comma-separated. The engine picks a specific angle within these."],
              ["voice", "Voice notes", "Optional. Anything about how it should sound."],
              ["avoid", "Never mention", "Optional. Claims or subjects to stay away from."],
            ]}
            numField={["perDay", "Articles per day", HARD_MAX.contentPerDay]}
          />
          <DirectionForm
            title="Outbound"
            subtitle="Who gets contacted, and what they're offered."
            engine={ENGINE.OUTBOUND}
            value={outboundDir}
            saving={saving}
            onSave={saveDirection}
            fields={[
              ["icp", "Who do you want to reach?", "The kind of business. e.g. dental practices spending on Google Ads."],
              ["offer", "What are you offering them?", "The thing that would make them reply. Be specific."],
              ["geography", "Where", "Optional. e.g. Chicago metro."],
              ["voice", "Voice notes", "Optional. How the emails should sound."],
              ["avoid", "Never mention", "Optional."],
            ]}
            numField={["perDay", "Emails per day", HARD_MAX.outboundPerDay]}
          />
        </>
      )}
    </div>
  );
}

function DirectionForm({ title, subtitle, engine, value, fields, numField, saving, onSave }) {
  const [draft, setDraft] = useState(null);

  // Re-seed from props whenever the saved value changes, but never while the
  // operator is mid-edit — clobbering a half-typed field on a background
  // refresh is the fastest way to make a form feel broken.
  useEffect(() => { setDraft(null); }, [value]);
  const current = draft ?? {
    ...(value || {}),
    topics: Array.isArray(value?.topics) ? value.topics.join("\n") : value?.topics || "",
    avoid: Array.isArray(value?.avoid) ? value.avoid.join("\n") : value?.avoid || "",
  };
  const set = (k, v) => setDraft({ ...current, [k]: v });

  const [numKey, numLabel, numMax] = numField;

  return (
    <Card>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 14.5, fontWeight: 800, color: P.ink, fontFamily: P.display }}>{title}</div>
        <div style={{ fontSize: 11.5, color: P.muted, marginTop: 3, lineHeight: 1.5 }}>{subtitle}</div>
      </div>

      {fields.map(([key, label, hint]) => (
        <Field
          key={key}
          label={label}
          hint={hint}
          value={current[key] || ""}
          onChange={(v) => set(key, v)}
          textarea={key === "topics" || key === "avoid" || key === "voice" || key === "offer"}
        />
      ))}

      <Field
        label={numLabel}
        hint={`Ceiling is ${numMax}. The engine also stops on its own if the queue backs up.`}
        type="number" min={1} max={numMax}
        value={current[numKey] ?? ""}
        onChange={(v) => set(numKey, v)}
      />

      <button
        onClick={() => onSave(engine, {
          ...current,
          topics: typeof current.topics === "string" ? current.topics.split("\n").filter((s) => s.trim()) : current.topics,
          avoid: typeof current.avoid === "string" ? current.avoid.split("\n").filter((s) => s.trim()) : current.avoid,
          perDay: Number(current[numKey]) || undefined,
        })}
        disabled={saving}
        style={{
          minHeight: 42, padding: "0 20px", borderRadius: 10, border: `1px solid ${P.good}`,
          background: "rgba(18,165,148,0.16)", color: "#7FE3D4",
          fontSize: 13, fontWeight: 800, fontFamily: P.display,
          cursor: saving ? "default" : "pointer", opacity: saving ? 0.55 : 1,
        }}>
        {saving ? "Saving…" : `Save ${title.toLowerCase()} direction`}
      </button>
    </Card>
  );
}
