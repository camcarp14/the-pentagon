// Verb 3 of three — the goal.
//
// It sits directly under the fold rather than in a settings screen because the
// goal is the one piece of state that explains everything else on the page: a
// hypothesis queue only makes sense against what the agent is trying to do.
// Collapsed to a single line until tapped, so it costs one row of height.
//
// Like the halt path, it goes through halt.js and reports the SERVER's row.
// "Saved" means the database said so.
import { useEffect, useState } from "react";
import { setGoal } from "../lib/halt.js";
import { Btn, AlarmBlock } from "./primitives.jsx";

export default function GoalEditor({ cfg }) {
  const saved = cfg.row?.goal ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [justSaved, setJustSaved] = useState(false);

  // Adopt the server's value whenever we are not mid-edit. Without the guard, a
  // poll landing between keystrokes would overwrite what is being typed.
  useEffect(() => { if (!editing) setDraft(saved); }, [saved, editing]);

  const save = async () => {
    setBusy(true); setErr(null);
    const r = await setGoal(draft);
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    cfg.apply(r.row, r.at);
    setEditing(false);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2400);
  };

  if (!editing) {
    return (
      // The kit's pressable card: one material, no outline, and the press
      // physics come with it instead of being written out here.
      <button
        type="button"
        className="card pad-sm pressable biz-press"
        onClick={() => setEditing(true)}
        style={{
          display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left",
          padding: "11px 13px", minHeight: 44, cursor: "pointer", color: "var(--ink)",
        }}
      >
        {/* .t-label — 12px, tracked, uppercase. This was 9.5px, under the floor. */}
        <span className="t-label" style={{ color: "var(--faint)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>Goal</span>
        <span className="t-cap" style={{
          flex: 1, minWidth: 0, lineHeight: 1.45,
          color: saved ? "var(--ink)" : "var(--warn)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {/* An agent running with no stated goal is worth flagging, not
              rendering as a tidy blank. */}
          {saved || "No goal set — the agent is running without a stated objective."}
        </span>
        <span className="t-cap" style={{ color: justSaved ? "var(--good)" : "var(--faint)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
          {justSaved ? "saved" : "edit"}
        </span>
      </button>
    );
  }

  return (
    // The kit's card again. The "you are editing this" outline was a border next
    // to a card shadow; it is now the kit's own selection treatment — an inset
    // ring stacked on the card shadow, the same shape .stattile.selected uses.
    <div className="card" style={{ boxShadow: "inset 0 0 0 1.5px var(--accent-line), var(--shadow-card)", padding: 13 }}>
      <div className="t-label" style={{ color: "var(--faint)", fontFamily: "var(--font-mono)", marginBottom: 8 }}>Goal</div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        placeholder="What is this agent trying to achieve?"
        style={{ resize: "vertical", lineHeight: 1.55 }}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 11 }}>
        <Btn tone="accent" size="sm" busy={busy} onClick={save} style={{ flex: 1 }}>Save</Btn>
        <Btn tone="ghost" size="sm" disabled={busy} onClick={() => { setEditing(false); setDraft(saved); setErr(null); }}>Cancel</Btn>
      </div>
      {err && <div style={{ marginTop: 10 }}><AlarmBlock tone="error" headline="Not saved" detail={err} /></div>}
    </div>
  );
}
