// ─── Sequences — ordered steps with signal gates ─────────────────────────────
// The builder for the ladder model (PLAN.md AD-3): each step waits N days
// after the previous SEND, then its gate is checked against real thread
// signals (reply / click; open-gates are labeled dormant until sends go HTML).
// A failed gate skips the step. Steps draft into the approval queue — the
// sequence never sends anything itself.
import { useEffect, useMemo, useState } from "react";
import { T, selectBase } from "../../theme.js";
import { EmptyState, SkeletonRows, useToast } from "../../ui.jsx";
import { seqDb } from "../../lib/sequenceDb.js";
import { GATE_LABELS, OPEN_TRACKING_LIVE, effectiveGate } from "../../lib/sequences.js";

const GATE_OPTIONS = Object.entries(GATE_LABELS).map(([value, label]) => {
  const dormant = !OPEN_TRACKING_LIVE && effectiveGate(value) !== value;
  return { value, label: dormant ? `${label} (acts as "If no reply" until opens are tracked)` : label };
});

// StepEditor and SequenceCard are exported so the render test can mount them.
// SequencesView holds `sequences` at null until an async seqDb.getSequences()
// lands, and renderToStaticMarkup does not run effects — so a cold paint of
// #/sequences is the skeleton and neither of these bodies ever executes.
export function StepEditor({ step, index, count, onChange, onDelete, onMove }) {
  const set = (patch) => onChange({ ...step, ...patch });
  return (
    <div style={{ background: T.subtle, border: "none", borderRadius: "12px", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <span style={{ width: "22px", height: "22px", borderRadius: "7px", background: T.goldSoft, border: `1px solid ${T.goldLine}`, color: T.gold, fontSize: "11px", fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: T.fontMono, flexShrink: 0 }}>{step.step_order}</span>
        <input value={step.name} onChange={(e) => set({ name: e.target.value })} placeholder="Step name"
          style={{ flex: 1, minWidth: "120px", background: "transparent", border: "none", outline: "none", fontSize: "13px", fontWeight: 700, color: T.ink, fontFamily: T.fontDisplay }} />
        <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
          <button title="Move up" aria-label="Move step up" type="button" disabled={index === 0} onClick={() => onMove(-1)} className="co-icon-btn btn sm quiet">↑</button>
          <button title="Move down" aria-label="Move step down" type="button" disabled={index === count - 1} onClick={() => onMove(1)} className="co-icon-btn btn sm quiet">↓</button>
          <button title="Delete step" aria-label="Delete step" type="button" onClick={onDelete} className="co-icon-btn btn sm danger">✕</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11px", color: T.muted }}>
          wait
          <input type="number" min={0} max={60} value={step.wait_days}
            onChange={(e) => set({ wait_days: Math.max(0, Number(e.target.value) || 0) })}
            className="field on-well" style={{ width: "52px", minHeight: 30, padding: "4px 8px", fontSize: "12px", fontFamily: T.fontMono }} />
          day{step.wait_days === 1 ? "" : "s"} after previous send, then
        </label>
        <select value={step.send_condition} onChange={(e) => set({ send_condition: e.target.value })}
          style={{ ...selectBase, color: T.ink, maxWidth: "100%" }}>
          {GATE_OPTIONS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
        </select>
        <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11px", color: step.ai_personalize ? T.gold : T.muted, cursor: "pointer" }}>
          <input type="checkbox" checked={!!step.ai_personalize} onChange={(e) => set({ ai_personalize: e.target.checked })} />
          ✦ AI-personalize from prospect brief
        </label>
      </div>

      <textarea value={step.body_template || ""} onChange={(e) => set({ body_template: e.target.value })} rows={2}
        placeholder={"Direction for this touch. Merge vars: {{business_name}} {{first_name}} {{city}} {{category}} {{website}}"}
        className="field on-well" style={{ padding: "9px 11px", fontSize: "13px", lineHeight: 1.55, resize: "vertical" }} />
    </div>
  );
}

export function SequenceCard({ seq, steps, enrolledCount, onSave, onDelete }) {
  const toast = useToast();
  const [draft, setDraft] = useState({ ...seq });
  const [stepDrafts, setStepDrafts] = useState(steps);
  const [busy, setBusy] = useState(false);
  // Both mirrored pieces of state resync when the server truth changes —
  // otherwise an untouched card's stale `draft` could overwrite concurrent edits.
  useEffect(() => setStepDrafts(steps), [steps]);
  useEffect(() => setDraft({ ...seq }), [seq]);

  const dirty = JSON.stringify({ a: draft, b: stepDrafts }) !== JSON.stringify({ a: seq, b: steps });

  const changeStep = (i, next) => setStepDrafts((s) => s.map((x, idx) => (idx === i ? next : x)));
  const moveStep = (i, dir) => setStepDrafts((s) => {
    const next = [...s];
    const j = i + dir;
    if (j < 0 || j >= next.length) return s;
    [next[i], next[j]] = [next[j], next[i]];
    return next.map((st, idx) => ({ ...st, step_order: idx + 1 }));
  });
  const deleteStep = (i) => setStepDrafts((s) => s.filter((_, idx) => idx !== i).map((st, idx) => ({ ...st, step_order: idx + 1 })));
  const addStep = () => setStepDrafts((s) => [...s, {
    id: `new-${Date.now()}`, sequence_id: seq.id, step_order: s.length + 1, name: `Touch ${s.length + 1}`,
    wait_days: 4, send_condition: "no_reply", body_template: "", ai_personalize: true, _new: true,
  }]);

  const save = async () => {
    setBusy(true);
    try {
      await onSave(draft, stepDrafts);
      toast.push("Sequence saved.", { tone: "success" });
    } catch (err) {
      toast.push("Save failed: " + err.message, { tone: "error" });
    }
    setBusy(false);
  };

  return (
    <div className="card" style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          style={{ flex: 1, minWidth: "150px", background: "transparent", border: "none", outline: "none", fontSize: "15px", fontWeight: 800, color: T.ink, fontFamily: T.fontDisplay }} />
        <span style={{ fontSize: "10.5px", color: T.faint, fontFamily: T.fontMono, flexShrink: 0 }}>{enrolledCount} enrolled</span>
        <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11px", color: draft.is_active ? T.green : T.muted, cursor: "pointer", flexShrink: 0 }}>
          <input type="checkbox" checked={!!draft.is_active} onChange={(e) => setDraft((d) => ({ ...d, is_active: e.target.checked }))} />
          active
        </label>
        <label title="When a prospect replies, the sequence stops and the thread is yours." style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11px", color: T.muted, cursor: "pointer", flexShrink: 0 }}>
          <input type="checkbox" checked={!!draft.stop_on_reply} onChange={(e) => setDraft((d) => ({ ...d, stop_on_reply: e.target.checked }))} />
          stop on reply
        </label>
      </div>

      <input value={draft.description || ""} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} placeholder="What this sequence is for"
        style={{ width: "100%", background: "transparent", border: "none", outline: "none", fontSize: "12px", color: T.muted }} />

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {stepDrafts.map((st, i) => (
          <StepEditor key={st.id} step={st} index={i} count={stepDrafts.length}
            onChange={(next) => changeStep(i, next)} onDelete={() => deleteStep(i)} onMove={(dir) => moveStep(i, dir)} />
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <button onClick={addStep} type="button" className="btn sm quiet">+ Add step</button>
        <div style={{ flex: 1 }} />
        <button onClick={() => onDelete(seq.id)} type="button" className="btn sm danger">Delete</button>
        <button onClick={save} type="button" disabled={!dirty || busy} className={dirty ? "btn sm primary" : "btn sm quiet"}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

export function SequencesView() {
  const [sequences, setSequences] = useState(null);
  const [steps, setSteps] = useState([]);
  const [enrollments, setEnrollments] = useState([]);
  const toast = useToast();

  const load = async () => {
    try {
      const [seqs, allSteps, enr] = await Promise.all([
        seqDb.getSequences(), seqDb.getSteps(), seqDb.getAllEnrollments(),
      ]);
      setSequences(seqs || []);
      setSteps(allSteps || []);
      setEnrollments(enr || []);
    } catch (err) {
      setSequences([]);
      toast.push("Couldn't load sequences: " + err.message, { tone: "error" });
    }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const enrolledBySeq = useMemo(() => {
    const m = {};
    enrollments.forEach((e) => { if (["active", "paused"].includes(e.status)) m[e.sequence_id] = (m[e.sequence_id] || 0) + 1; });
    return m;
  }, [enrollments]);

  const saveSequence = async (seqDraft, stepDrafts) => {
    await seqDb.updateSequence(seqDraft.id, {
      name: seqDraft.name, description: seqDraft.description,
      is_active: seqDraft.is_active, stop_on_reply: seqDraft.stop_on_reply,
    });
    const existing = steps.filter((s) => s.sequence_id === seqDraft.id);
    const keptIds = new Set(stepDrafts.filter((s) => !s._new).map((s) => s.id));
    for (const gone of existing.filter((s) => !keptIds.has(s.id))) await seqDb.deleteStep(gone.id);
    // Park kept steps on temp negative orders ONLY when an order actually
    // changed — reorders can trip the UNIQUE (sequence_id, step_order)
    // constraint, but text/toggle edits (the common case) must not risk the
    // parked state: if the second pass dies mid-way, negative orders would
    // make the engine read the ladder as exhausted and complete enrollments.
    const kept = stepDrafts.filter((s) => !s._new);
    const orderById = new Map(existing.map((s) => [s.id, s.step_order]));
    const orderChanged = kept.some((s) => orderById.get(s.id) !== s.step_order);
    if (orderChanged) {
      for (let i = 0; i < kept.length; i++) await seqDb.updateStep(kept[i].id, { step_order: -(i + 1) });
    }
    for (const st of stepDrafts) {
      const fields = { name: st.name, wait_days: st.wait_days, send_condition: st.send_condition, body_template: st.body_template, subject_template: st.subject_template || null, ai_personalize: st.ai_personalize, step_order: st.step_order };
      if (st._new) await seqDb.createStep({ ...fields, sequence_id: seqDraft.id });
      else await seqDb.updateStep(st.id, fields);
    }
    await load();
  };

  const createSequence = async () => {
    try {
      const seq = await seqDb.createSequence({ name: "New sequence", description: "", is_active: false, stop_on_reply: true });
      if (seq) await seqDb.createStep({ sequence_id: seq.id, step_order: 1, name: "Bump", wait_days: 3, send_condition: "no_reply", body_template: "Short nudge — make sure the first note didn't get buried.", ai_personalize: true });
      await load();
    } catch (err) {
      toast.push("Couldn't create sequence: " + err.message, { tone: "error" });
    }
  };

  const deleteSequence = async (id) => {
    const enrolled = enrolledBySeq[id] || 0;
    if (enrolled > 0) { toast.push(`${enrolled} thread${enrolled === 1 ? " is" : "s are"} enrolled — pause or finish them first.`, { tone: "warning" }); return; }
    try { await seqDb.deleteSequence(id); await load(); } catch (err) { toast.push("Delete failed: " + err.message, { tone: "error" }); }
  };

  return (
    <div style={{ padding: "24px 28px", maxWidth: "860px", margin: "0 auto" }}>
      {/* The Sequences pill is lit above this row; the title said it again. The
          action stays and keeps the row, so this reclaims the title's line only
          where the row had nothing else in it — here it does. */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "6px" }}>
        <div style={{ flex: 1 }} />
        <button onClick={createSequence} type="button" className="btn sm primary">+ New sequence</button>
      </div>
      <div className="t-foot" style={{ marginBottom: "18px", lineHeight: 1.6, maxWidth: "620px" }}>
        Steps wait, check their gate against real signals (replies and link clicks{OPEN_TRACKING_LIVE ? ", opens" : " — opens come online when sends go HTML"}), then draft into the approval queue. A failed gate skips the step. Nothing here ever sends on its own.
      </div>

      {sequences === null ? (
        <SkeletonRows count={2} />
      ) : sequences.length === 0 ? (
        <EmptyState icon="spark" title="No sequences yet" sub="Create one to put your follow-up ladder on rails — drafts still wait for your approval." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {sequences.map((s) => (
            <SequenceCard key={s.id} seq={s}
              steps={steps.filter((st) => st.sequence_id === s.id).sort((a, b) => a.step_order - b.step_order)}
              enrolledCount={enrolledBySeq[s.id] || 0}
              onSave={saveSequence} onDelete={deleteSequence} />
          ))}
        </div>
      )}
    </div>
  );
}
