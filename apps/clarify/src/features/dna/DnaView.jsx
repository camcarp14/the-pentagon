import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { T, inputBase, selectBase } from "../../theme";
import { useToast } from "../../ui.jsx";
import {
  REGIONS, loadGenome, saveGenome, resetGenome, recordMutation,
  addNode, updateNode, removeNode, addEdge, updateEdge, removeEdge,
  validateGenome, compileGenome, propagate, dnaBus, genomeStats,
} from "../../lib/dna.js";
import { wk, worklog, suggestions, inShift, WORKER_DEFAULTS } from "../../lib/dnaWorker.js";
import { callClaude } from "../../lib/claudeApi.js";
import { MindCanvas } from "@cc/mind-canvas";
import { CLARIFY_MIND_PALETTE } from "./palette.js";

// ════════════════════════════════════════════════════════════════════════════
// DNA VIEW — the tab around the mind. The canvas IS the page; everything else
// floats over it in glass: header + stat pills, region legend, the inspector,
// the worker dock, the suggestions tray, the pulse popover and the ⋯ menu.
// One rule holds everywhere: every genome edit routes through a dna.js CRUD
// function and then saveGenome(), so the mutation history records it and the
// dnaBus "genome" event keeps every consumer (canvas, worker, pills) in sync.
// The view itself owns zero business logic — it's chrome around the genome.
// ════════════════════════════════════════════════════════════════════════════

// Glass recipe for every floating panel — spec'd once so the whole overlay
// layer reads as one material (midnight glass under the desk lamp).
const GLASS = {
  background: "rgba(13,18,31,0.85)",
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
  // No border. shadowPopover already ends in `0 0 0 1px rgba(255,255,255,0.06)`,
  // so the glass edge is drawn by the shadow — and this recipe is spread onto
  // every floating panel in the view, which meant one border-plus-shadow
  // violation was landing on the whole overlay layer at once.
  border: "none",
  boxShadow: T.shadowPopover,
  borderRadius: T.rLg,
};

// View-scoped CSS: the full-bleed height math (100dvh with a 100vh fallback —
// inline styles can't double-declare), the mobile override that defeats the
// generic `.co-viewwrap > div` padding (this view is edge-to-edge on purpose),
// and the glyph's slow rotation. App's global reduced-motion rule zeroes every
// animation-duration, so the glyph goes still for free.
const VIEW_CSS = `
.dna-view { position: relative; overflow: hidden; height: calc(100vh - 52px); height: calc(100dvh - 52px); }
.dna-scroll-x { scrollbar-width: none; }
.dna-scroll-x::-webkit-scrollbar { display: none; }
.dna-logrow { transition: background 0.15s ease; }
.dna-logrow:hover { background: rgba(255,255,255,0.05); }
.dna-menuitem:hover { background: rgba(255,255,255,0.06); }
.dna-view input[type="range"] { cursor: pointer; }
/* The App-level GlobalAgent launcher parks fixed at the viewport's bottom-right
   corner of every view; on this full-bleed page that's exactly where the
   canvas parks its zoom/fit HUD (the last div after the svg). Lift the HUD
   clear so both stay usable — !important because the HUD positions inline. */
.dna-view .dna-canvas ~ div:last-of-type { bottom: 78px !important; }
@keyframes dnaGlyph { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(180deg); } }
@media (max-width: 860px) {
  .co-viewwrap > .dna-view { padding: 0 !important; }
  .dna-view { height: calc(100vh - 112px); height: calc(100dvh - 112px - var(--safe-bottom)); }
  .dna-sub { display: none; }
}
`;

const xBtn = { background: "none", border: "none", color: T.faint, fontSize: "18px", cursor: "pointer", lineHeight: 1, padding: "0 2px" };

const TASK_TYPES = [
  ["draft", "Draft"], ["enrich", "Enrich"], ["classify", "Classify"],
  ["followup", "Follow-up"], ["strategy", "Strategy"], ["grow", "Grow"],
];
const LOG_DOT = { done: T.green, failed: T.red, skipped: T.faint };
const KIND_COLOR = { add_node: T.green, remove_node: T.red, update_node: T.blue, add_edge: T.green, remove_edge: T.red, update_edge: T.blue, reset: T.amber, import: T.violet };

// Words too common to mean anything when the pulse matches a query to nodes.
const STOP = new Set("the a an and or but for nor with that this these those what when where how why who are is was were be been do does did should would could can our your their its from into then than about have has had not you they i we it if of on in to as at by".split(" "));

const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const isToday = (iso) => new Date(iso).toDateString() === new Date().toDateString();

// wk.get() may be partial (an older stored ctrl, or nothing at all) — always
// re-hydrate against WORKER_DEFAULTS, nested objects included, so the dock
// never renders an undefined field.
const readCtrl = () => {
  const c = wk.get() || {};
  return {
    ...WORKER_DEFAULTS, ...c,
    eveningShift: { ...WORKER_DEFAULTS.eveningShift, ...(c.eveningShift || {}) },
    taskTypes: { ...WORKER_DEFAULTS.taskTypes, ...(c.taskTypes || {}) },
  };
};

// A suggestion counts as pending unless the worker's resolve() has marked it —
// tolerant of either a flag or a status field, and of removal-based stores.
const pendingSuggestions = () => {
  let all;
  try { all = suggestions.all() || []; } catch { all = []; }
  return all.filter((s) => s && !s.resolved && s.status !== "resolved");
};


// ─── Small primitives ─────────────────────────────────────────────────────────
// Pill lives at module scope on purpose: declared inside the view its function
// identity would change every render, and React would unmount/remount all five
// header pills' DOM on every 1.5s poll tick and every Pulse keystroke.
function Pill({ label, value, brass, title }) {
  return (
    <span title={title} style={{ ...GLASS, borderRadius: T.rPill, padding: "4px 11px", display: "inline-flex", alignItems: "baseline", gap: "6px", pointerEvents: "auto" }}>
      <span className="t-label" style={{ color: T.faint }}>{label}</span>
      <span style={{ fontSize: "11.5px", fontFamily: T.fontMono, color: brass ? T.gold : T.ink, fontWeight: brass ? 700 : 500 }}>{value}</span>
    </span>
  );
}

function Switch({ on, onClick, disabled, title }) {
  return (
    <div onClick={disabled ? undefined : onClick} title={title} role="switch" aria-checked={!!on}
      style={{ width: "34px", height: "20px", borderRadius: "12px", background: on ? T.green : "rgba(255,255,255,0.12)", position: "relative", flexShrink: 0, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1, transition: "background 0.15s" }}>
      <div style={{ position: "absolute", top: "2px", left: on ? "16px" : "2px", width: "16px", height: "16px", borderRadius: "50%", background: T.inkDeep, transition: "left 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,0.4)" }} />
    </div>
  );
}

// Directive textarea that grows with its content — a fixed rows count either
// wastes panel space or hides the second half of a principle.
function AutoTextarea({ value, onChange, onBlur, placeholder }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);
  return (
    <textarea ref={ref} rows={2} value={value} onChange={onChange} onBlur={onBlur} placeholder={placeholder}
      className="field" style={{ padding: "8px 11px", fontSize: "13px", lineHeight: 1.55, resize: "none", overflow: "hidden" }} />
  );
}

// One overlay primitive for every takeover surface. Desktop: centered card, or
// a right-anchored drawer for the mutation history. Mobile inherits the app's
// bottom-sheet treatment for free via the .co-modal-* responsive classes.
function Overlay({ onClose, width = 560, side, children }) {
  const right = side === "right";
  return (
    <div className="co-modal-overlay" onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 320, display: "flex", alignItems: right ? "stretch" : "center", justifyContent: right ? "flex-end" : "center", padding: right ? 0 : "20px", animation: "fadein 0.15s ease both" }}>
      <div className="co-modal-sheet" onClick={(e) => e.stopPropagation()}
        style={{ background: T.surface, border: "none", borderRadius: right ? "16px 0 0 16px" : "16px", width: `${width}px`, maxWidth: "94vw", maxHeight: right ? "100vh" : "86vh", height: right ? "100%" : "auto", display: "flex", flexDirection: "column", boxShadow: T.shadowModal, overflow: "hidden" }}>
        {children}
      </div>
    </div>
  );
}


// ─── Inspector: node ──────────────────────────────────────────────────────────
// Text-ish fields hold a local draft and commit on blur; the weight slider
// holds a draft while dragging and commits on release. Both exist for the same
// reason: dna.js records a mutation-history line per update, and a line per
// keystroke would bury the history in noise. key={node.id} resets drafts.
function NodeInspector({ genome, node, apply, onSelect, onDeleted }) {
  const [label, setLabel] = useState(node.label);
  const [text, setText] = useState(node.text || "");
  const [w, setW] = useState(null);
  const conns = genome.edges.filter((e) => e.from === node.id || e.to === node.id);
  const wired = new Set(genome.edges.filter((e) => e.from === node.id).map((e) => e.to));
  const wireTargets = genome.nodes.filter((n) => n.id !== node.id && !wired.has(n.id));
  const liveW = w != null ? w : Math.round((node.weight || 0) * 100);

  const commitLabel = () => { const v = label.trim(); if (v && v !== node.label) apply(updateNode(genome, node.id, { label: v })); else setLabel(node.label); };
  const commitText = () => { if (text !== (node.text || "")) apply(updateNode(genome, node.id, { text })); };
  const commitW = () => { if (w == null) return; if (w / 100 !== node.weight) apply(updateNode(genome, node.id, { weight: w / 100 })); setW(null); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "13px" }}>
      <div>
        <div className="t-label" style={{ marginBottom: "6px" }}>Label</div>
        <input value={label} maxLength={28} onChange={(e) => setLabel(e.target.value)} onBlur={commitLabel} onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
          className="field" style={{ padding: "8px 11px", fontSize: "13px", fontWeight: 600 }} />
      </div>

      <div>
        <div className="t-label" style={{ marginBottom: "6px" }}>Region</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
          {Object.entries(REGIONS).map(([k, r]) => {
            const on = k === node.region;
            return (
              <button key={k} title={r.desc} onClick={() => !on && apply(updateNode(genome, node.id, { region: k }))}
                style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "4px 9px", borderRadius: T.rPill, cursor: "pointer", fontSize: "10.5px", fontWeight: 700, fontFamily: T.fontDisplay, background: on ? `${r.color}1F` : "transparent", border: `1px solid ${on ? `${r.color}66` : T.line}`, color: on ? r.color : T.muted }}>
                <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: r.color }} />{r.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="t-label" style={{ marginBottom: "6px", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span>Weight</span>
          <span style={{ fontFamily: T.fontMono, fontSize: "12px", color: T.gold, letterSpacing: 0, textTransform: "none" }}>{liveW}%</span>
        </div>
        <input type="range" min={0} max={100} value={liveW} onChange={(e) => setW(Number(e.target.value))} onPointerUp={commitW} onKeyUp={commitW} onBlur={commitW}
          style={{ width: "100%", accentColor: T.gold, display: "block" }} />
        {/* Instructional copy reads in T.muted — the AA floor. T.faint is for decoration only. */}
        <div style={{ fontSize: "10.5px", color: T.muted, marginTop: "4px" }}>
          {liveW >= 75 ? "Compiles as PRIMARY — a command" : liveW >= 40 ? "Compiles as a standing line" : "Compiles as a minor consideration"}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "12px", fontWeight: 600, color: T.ink }}>Awake</div>
          <div style={{ fontSize: "10.5px", color: T.muted }}>{node.enabled !== false ? "Compiling into the mind" : "Silenced — omitted from the prompt"}</div>
        </div>
        <Switch on={node.enabled !== false} disabled={node.locked} title={node.locked ? "Locked — governance nodes cannot be silenced" : undefined}
          onClick={() => apply(updateNode(genome, node.id, { enabled: node.enabled === false }))} />
      </div>

      <div>
        <div className="t-label" style={{ marginBottom: "6px" }}>Directive</div>
        <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} onBlur={commitText} placeholder="What this node tells the mind…" />
      </div>

      <div>
        <div className="t-label" style={{ marginBottom: "6px", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span>Synapses</span>
          <span style={{ fontFamily: T.fontMono, fontSize: "10.5px", color: T.faint, letterSpacing: 0 }}>{conns.length}</span>
        </div>
        {conns.length === 0 ? (
          <div style={{ fontSize: "10.5px", color: T.muted, lineHeight: 1.5 }}>No synapses yet — ⇧-drag from this node on the canvas, or wire one below.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            {conns.map((e) => {
              const out = e.from === node.id;
              const otherId = out ? e.to : e.from;
              const other = genome.nodes.find((n) => n.id === otherId);
              return (
                <div key={e.id} style={{ display: "flex", alignItems: "center", gap: "7px", padding: "6px 9px", background: T.subtle, borderRadius: "8px" }}>
                  <span title={e.polarity === -1 ? "Tempers" : "Excites"} style={{ fontSize: "10.5px", flexShrink: 0 }}>{e.polarity === -1 ? "⛔" : "⚡"}</span>
                  <button onClick={() => onSelect({ type: "edge", id: e.id })} title="Inspect this synapse"
                    style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", cursor: "pointer", color: T.ink, fontSize: "11px", padding: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {out ? "→ " : "← "}{other ? other.label : otherId}
                  </button>
                  <span style={{ fontFamily: T.fontMono, fontSize: "10.5px", color: T.muted, flexShrink: 0 }}>{(e.weight || 0).toFixed(2)}</span>
                  <button onClick={() => apply(removeEdge(genome, e.id))} title="Cut synapse" style={{ ...xBtn, fontSize: "12px", flexShrink: 0 }}>✕</button>
                </div>
              );
            })}
          </div>
        )}
        {/* The canvas's ⇧-drag/hover-port gesture needs a mouse; this select is
            the touch- and keyboard-reachable way to wire an edge. addEdge's own
            guards (self-loop, dupes) still apply via `apply`. */}
        {wireTargets.length > 0 && (
          <select value="" aria-label="Wire a synapse to another node"
            onChange={(e) => { if (e.target.value) apply(addEdge(genome, { from: node.id, to: e.target.value })); }}
            style={{ ...selectBase, width: "100%", marginTop: "6px", padding: "6px 9px", fontSize: "11px" }}>
            <option value="">＋ Wire a synapse to…</option>
            {wireTargets.map((n) => (
              <option key={n.id} value={n.id}>{n.label} · {(REGIONS[n.region] || REGIONS.knowledge).label}</option>
            ))}
          </select>
        )}
      </div>

      {node.locked ? (
        <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", padding: "9px 11px", background: T.goldSoft, border: `1px solid ${T.goldLine}`, borderRadius: "9px", fontSize: "10.5px", color: T.inkBrand, lineHeight: 1.5 }}>
          <span>🔒</span><span>Core governance — cannot be removed or silenced. Weight is still yours to tune.</span>
        </div>
      ) : (
        <button onClick={() => { apply(removeNode(genome, node.id)); onDeleted(); }}
          style={{ width: "100%", padding: "9px", background: `${T.red}14`, border: `1px solid ${T.red}40`, borderRadius: "9px", color: T.red, fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay }}>
          Delete node
        </button>
      )}

      <div style={{ fontSize: "10.5px", color: T.faint, fontFamily: T.fontMono }}>{node.source || "user"} · {node.id}</div>
    </div>
  );
}


// ─── Inspector: edge ──────────────────────────────────────────────────────────
function EdgeInspector({ genome, edge, apply, onSelect, onDeleted }) {
  const [w, setW] = useState(null);
  const from = genome.nodes.find((n) => n.id === edge.from);
  const to = genome.nodes.find((n) => n.id === edge.to);
  const liveW = w != null ? w : Math.round((edge.weight || 0) * 100);
  const inhib = edge.polarity === -1;
  const commitW = () => { if (w == null) return; if (w / 100 !== edge.weight) apply(updateEdge(genome, edge.id, { weight: w / 100 })); setW(null); };
  const jump = (id, label) => (
    <button onClick={() => onSelect({ type: "node", id })} title={`Inspect "${label}"`}
      style={{ flex: 1, minWidth: 0, background: "none", border: "none", cursor: "pointer", color: T.ink, fontSize: "11.5px", fontWeight: 600, fontFamily: T.fontDisplay, padding: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
      {label}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "13px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "10px 12px", background: T.subtle, borderRadius: "10px" }}>
        {jump(edge.from, from ? from.label : edge.from)}
        <span style={{ fontSize: "13px", color: inhib ? T.red : T.gold, flexShrink: 0 }}>{inhib ? "⊣" : "→"}</span>
        {jump(edge.to, to ? to.label : edge.to)}
      </div>

      <div>
        <div className="t-label" style={{ marginBottom: "6px", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span>Weight</span>
          <span style={{ fontFamily: T.fontMono, fontSize: "12px", color: T.gold, letterSpacing: 0, textTransform: "none" }}>{liveW}%</span>
        </div>
        <input type="range" min={0} max={100} value={liveW} onChange={(e) => setW(Number(e.target.value))} onPointerUp={commitW} onKeyUp={commitW} onBlur={commitW}
          style={{ width: "100%", accentColor: T.gold, display: "block" }} />
      </div>

      <div>
        <div className="t-label" style={{ marginBottom: "6px" }}>Polarity</div>
        <div style={{ display: "flex", border: `1px solid ${T.line}`, borderRadius: "9px", overflow: "hidden" }}>
          <button onClick={() => inhib && apply(updateEdge(genome, edge.id, { polarity: 1 }))}
            style={{ flex: 1, padding: "8px", background: !inhib ? T.goldSoft : "transparent", border: "none", cursor: "pointer", color: !inhib ? T.gold : T.muted, fontSize: "11px", fontWeight: 700, fontFamily: T.fontDisplay }}>
            ⚡ Excites
          </button>
          <button onClick={() => !inhib && apply(updateEdge(genome, edge.id, { polarity: -1 }))}
            style={{ flex: 1, padding: "8px", background: inhib ? `${T.red}14` : "transparent", border: "none", borderLeft: `1px solid ${T.line}`, cursor: "pointer", color: inhib ? T.red : T.muted, fontSize: "11px", fontWeight: 700, fontFamily: T.fontDisplay }}>
            ⛔ Tempers
          </button>
        </div>
        <div style={{ fontSize: "10.5px", color: T.muted, marginTop: "5px", lineHeight: 1.5 }}>
          Tempers compiles into an INTERNAL TENSIONS line — when they conflict, the source node wins.
        </div>
      </div>

      <button onClick={() => { apply(removeEdge(genome, edge.id)); onDeleted(); }}
        style={{ width: "100%", padding: "9px", background: `${T.red}14`, border: `1px solid ${T.red}40`, borderRadius: "9px", color: T.red, fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay }}>
        Cut synapse
      </button>

      <div style={{ fontSize: "10.5px", color: T.faint, fontFamily: T.fontMono }}>{edge.id}</div>
    </div>
  );
}


// ─── Worker dock body — controls + work log ───────────────────────────────────
function DockBody({ ctrl, log, tasksToday, bump, replay, toast }) {
  const shift = ctrl.eveningShift;
  const numStyle = { ...inputBase, width: "58px", padding: "5px 8px", fontSize: "11px", fontFamily: T.fontMono, textAlign: "center" };
  const timeStyle = { ...inputBase, width: "102px", padding: "4px 7px", fontSize: "11px", fontFamily: T.fontMono }; // wide enough for "06:00 PM" — Chromium clips the meridiem otherwise

  return (
    <div style={{ padding: "2px 14px 12px", display: "flex", flexDirection: "column", gap: "12px" }}>
      {/* Evening shift — schedule while you're at dinner; drafts wait for morning you. */}
      <div style={{ display: "flex", alignItems: "center", gap: "9px", flexWrap: "wrap" }}>
        <Switch on={!!shift.enabled} onClick={() => { wk.set({ eveningShift: { ...shift, enabled: !shift.enabled } }); bump(); }} />
        <span style={{ fontSize: "11.5px", fontWeight: 600, color: T.ink, flexShrink: 0 }}>Evening shift</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", opacity: shift.enabled ? 1 : 0.45 }}>
          <input type="time" value={shift.start} disabled={!shift.enabled} onChange={(e) => { wk.set({ eveningShift: { ...shift, start: e.target.value } }); bump(); }} style={timeStyle} />
          <span style={{ fontSize: "10.5px", color: T.faint }}>→</span>
          <input type="time" value={shift.end} disabled={!shift.enabled} onChange={(e) => { wk.set({ eveningShift: { ...shift, end: e.target.value } }); bump(); }} style={timeStyle} />
        </span>
      </div>

      {/* Task types — which skills the worker is allowed to exercise. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
        {TASK_TYPES.map(([k, label]) => {
          const on = ctrl.taskTypes[k] !== false;
          return (
            <button key={k} onClick={() => { wk.setTask(k, !on); bump(); }}
              style={{ padding: "4px 10px", borderRadius: T.rPill, cursor: "pointer", fontSize: "10.5px", fontWeight: 700, fontFamily: T.fontDisplay, background: on ? T.goldSoft : "transparent", border: `1px solid ${on ? T.goldLine : T.line}`, color: on ? T.gold : T.faint }}>
              {label}
            </button>
          );
        })}
      </div>

      {/* Caps — the honesty levers. */}
      <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: "7px", fontSize: "10.5px", color: T.muted }}>
          Tasks/hr
          <input type="number" min={1} max={30} value={ctrl.maxTasksPerHour}
            onChange={(e) => { wk.set({ maxTasksPerHour: Math.max(1, Math.min(30, Number(e.target.value) || 1)) }); bump(); }} style={numStyle} />
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: "7px", fontSize: "10.5px", color: T.muted }}>
          $/hr
          <input type="number" min={0} max={5} step={0.05} value={ctrl.hourlyCostCap}
            onChange={(e) => { wk.set({ hourlyCostCap: Math.max(0, Math.min(5, Number(e.target.value) || 0)) }); bump(); }} style={numStyle} />
        </label>
      </div>

      {/* Must-read honesty note — T.muted for AA contrast, not decorative faint. */}
      <div style={{ fontSize: "10.5px", color: T.muted, lineHeight: 1.5 }}>
        Runs while Clarify is open in a tab. Drafts always land in the Queue for your approval — the worker never sends.
      </div>

      {/* Work log — hover an entry and the canvas replays its activation trace. */}
      <div style={{ borderTop: `1px solid ${T.lineSoft}`, paddingTop: "10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "7px" }}>
          <span className="t-label">Work log</span>
          <span style={{ fontFamily: T.fontMono, fontSize: "10.5px", color: T.faint }}>{tasksToday} task{tasksToday !== 1 ? "s" : ""} today</span>
        </div>
        {log.length === 0 ? (
          <div style={{ fontSize: "11px", color: T.muted, padding: "10px 0", lineHeight: 1.5 }}>
            No tasks yet — flip the switch and the mind gets to work.
          </div>
        ) : (
          <div style={{ maxHeight: "260px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "2px", margin: "0 -6px" }}>
            {log.slice(0, 80).map((e) => (
              <div key={e.id} className="dna-logrow" onMouseEnter={() => replay(e)} title="Hover replays this task's activation on the canvas"
                style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 8px", borderRadius: "8px", cursor: "default" }}>
                <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: LOG_DOT[e.status] || T.faint, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "11px", color: e.status === "failed" ? T.red : T.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.title}</div>
                  {e.status === "failed" && e.detail ? (
                    <div style={{ fontSize: "10.5px", color: T.faint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.detail}</div>
                  ) : null}
                </div>
                <span className="t-label" style={{ color: T.muted, background: "rgba(255,255,255,0.06)", borderRadius: T.rPill, padding: "1px 7px", flexShrink: 0 }}>{e.kind}</span>
                <span style={{ fontFamily: T.fontMono, fontSize: "10.5px", color: T.faint, flexShrink: 0 }}>{hhmm(e.ts)}</span>
                {e.cost > 0 && <span style={{ fontFamily: T.fontMono, fontSize: "10.5px", color: T.amber, flexShrink: 0 }}>${e.cost.toFixed(3)}</span>}
              </div>
            ))}
          </div>
        )}
        {log.length > 0 && (
          <button onClick={() => { worklog.clear(); bump(); toast.push("Work log cleared."); }}
            style={{ marginTop: "6px", background: "none", border: "none", color: T.faint, fontSize: "10.5px", cursor: "pointer", fontWeight: 600, padding: 0 }}>
            Clear log
          </button>
        )}
      </div>
    </div>
  );
}


// ─── The view ─────────────────────────────────────────────────────────────────
export function DnaView({ cards, toneMemory }) { // eslint-disable-line no-unused-vars — props flow per contract; the Worker itself mounts at App root
  const toast = useToast();
  const [genome, setGenome] = useState(() => loadGenome());
  const [selection, setSelection] = useState(null);
  const [regionFilter, setRegionFilter] = useState(null);   // Set<regionKey> | null (null = all)
  const [panel, setPanel] = useState(null);                 // "pulse" | "menu" | null
  const [modal, setModal] = useState(null);                 // "compiled" | "history" | null
  const [trayOpen, setTrayOpen] = useState(false);
  const [dockOpen, setDockOpen] = useState(true);           // desktop collapse
  const [dockSheet, setDockSheet] = useState(false);        // mobile bottom sheet
  const [pulseCount, setPulseCount] = useState(0);          // session activation counter
  const [confirmReset, setConfirmReset] = useState(false);
  // Worker-side stores (ctrl, log, suggestions) are localStorage JSON — a
  // mature 300-entry log with traces is a several-hundred-KB parse. Read them
  // into state ONCE per poll tick / local mutation, never in the render body,
  // where every Pulse keystroke and activation event would pay the parse again.
  const readWorker = () => {
    let log; try { log = worklog.all() || []; } catch { log = []; }
    return { ctrl: readCtrl(), log, pending: pendingSuggestions() };
  };
  const [wkState, setWkState] = useState(readWorker);
  const bump = () => setWkState(readWorker());
  const fileRef = useRef(null);
  const canvasApi = useRef(null);                           // MindCanvas exposes {centerWorld} here
  const replayRef = useRef({ id: null, ts: 0 });

  // Pulse state
  const [pq, setPq] = useState("");
  const [pulseRes, setPulseRes] = useState(null);           // { q, seedLabels, excerpt }
  const [thinking, setThinking] = useState(false);
  const [answer, setAnswer] = useState(null);

  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(max-width: 860px)").matches);

  // View CSS + breakpoint listener + 1.5s poll (worker writes to sm from its
  // own loop — same live-refresh pattern as AgentsView) + bus subscription.
  useEffect(() => {
    const styleEl = document.createElement("style");
    styleEl.textContent = VIEW_CSS;
    document.head.appendChild(styleEl);
    const mq = window.matchMedia("(max-width: 860px)");
    const onMq = (e) => setMobile(e.matches);
    mq.addEventListener ? mq.addEventListener("change", onMq) : mq.addListener(onMq);
    const iv = setInterval(bump, 1500);
    return () => {
      styleEl.remove();
      mq.removeEventListener ? mq.removeEventListener("change", onMq) : mq.removeListener(onMq);
      clearInterval(iv);
    };
  }, []);

  useEffect(() => dnaBus.on((evt) => {
    if (evt.type === "genome") setGenome(evt.genome);       // worker-side growth arrives here
    else if (evt.type === "activation") setPulseCount((c) => c + 1);
  }), []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { setPanel(null); setModal(null); setTrayOpen(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The genome, readable from stable callbacks: the canvas is memo'd, so its
  // callback props must keep their identity across the 1.5s poll re-renders.
  const genomeRef = useRef(genome);
  genomeRef.current = genome;

  // THE seam: every edit is CRUD → saveGenome (history + bus) → state. dna.js
  // refusals (locked delete, dupe edge…) return the same reference — no-op.
  const apply = useCallback((next) => { if (next && next !== genomeRef.current) setGenome(saveGenome(next)); }, []);

  // Worker-side numbers come from wkState (refreshed by the 1.5s poll + bump).
  const { ctrl, log, pending } = wkState;
  const stats = genomeStats(genome);
  const compiled = useMemo(() => compileGenome(genome), [genome]);
  const tasksToday = useMemo(() => log.filter((e) => isToday(e.ts)).length, [log]);

  const selNode = selection && selection.type === "node" ? genome.nodes.find((n) => n.id === selection.id) : null;
  const selEdge = selection && selection.type === "edge" ? genome.edges.find((e) => e.id === selection.id) : null;

  // Worker status line — ● idle/working, ◐ armed. "Current task" is inferred
  // from the freshest log entry (the worker runs serially, one task per pass).
  const shiftLive = !!ctrl.eveningShift.enabled && inShift(ctrl.eveningShift);
  const workerActive = !!ctrl.running || shiftLive;
  const lastEntry = log[0];
  const lastFresh = lastEntry && Date.now() - new Date(lastEntry.ts).getTime() < 90000;
  const statusDot = workerActive ? T.green : ctrl.eveningShift.enabled ? T.violet : T.faint;
  const statusGlyph = workerActive ? "●" : ctrl.eveningShift.enabled ? "◐" : "●";
  const statusText = workerActive
    ? `Working — ${lastFresh ? lastEntry.title : "watching the pipeline"}${shiftLive && !ctrl.running ? " (evening shift)" : ""}`
    : ctrl.eveningShift.enabled ? `Evening shift armed — starts ${ctrl.eveningShift.start}` : "Idle";

  // ── Canvas callbacks — all identity-stable (genome via ref) so the memo'd
  //    canvas only re-renders on real prop changes, never on the poll tick. ──
  const handleNodeMove = useCallback((id, x, y) => apply(updateNode(genomeRef.current, id, { x, y })), [apply]); // position-only: layout, not history
  const handleAddNodeAt = useCallback(({ x, y }) => {
    const res = addNode(genomeRef.current, { label: "New node", region: "knowledge", text: "", x, y });
    setGenome(saveGenome(res.genome));
    setSelection({ type: "node", id: res.node.id });
    toast.push("Node grown — name it in the inspector.", { tone: "success" });
  }, [toast]);
  const handleAddEdge = useCallback(({ from, to }) => {
    const g = genomeRef.current;
    const next = addEdge(g, { from, to });
    if (next === g) { toast.push("Those nodes are already wired.", { tone: "warning" }); return; }
    setGenome(saveGenome(next));
    setSelection({ type: "edge", id: next.edges[next.edges.length - 1].id });
  }, [toast]);
  // "＋ Node" plants at the CURRENT viewport's center (the canvas owns the view
  // transform and exposes the math via canvasApi) with a little scatter —
  // after any pan/zoom, world origin can be far off-screen and a node grown
  // there would be invisible until the user guessed to press FIT.
  const growNode = () => {
    const c = (canvasApi.current && canvasApi.current.centerWorld()) || { x: 0, y: 0 };
    handleAddNodeAt({ x: Math.round(c.x + (Math.random() - 0.5) * 160), y: Math.round(c.y + (Math.random() - 0.5) * 160) });
  };

  const toggleRegion = (r) => setRegionFilter((prev) => {
    if (!prev) return new Set([r]);                          // from "all" → isolate the clicked region
    const next = new Set(prev);
    next.has(r) ? next.delete(r) : next.add(r);
    return next.size === 0 || next.size === Object.keys(REGIONS).length ? null : next;
  });

  // ── Work-log replay — re-propagate from the stored seeds so the wave is
  //    computed against the CURRENT genome (weights may have changed since). ──
  const replay = (entry) => {
    const seeds = entry && entry.trace && Array.isArray(entry.trace.seeds) ? entry.trace.seeds : null;
    if (!seeds || seeds.length === 0) return;
    const now = Date.now();
    // Throttle globally, not just per entry: sweeping the cursor down the list
    // must not fire one propagate + full canvas re-render per row crossed. Same
    // entry holds longer so hover jitter doesn't restrobe it.
    if (now - replayRef.current.ts < (replayRef.current.id === entry.id ? 2600 : 700)) return;
    replayRef.current = { id: entry.id, ts: now };
    dnaBus.emit({ type: "activation", seeds, trace: propagate(genome, seeds), label: `Replay — ${entry.title}` });
  };

  // ── Pulse — keyword-match the query to nodes, fire the wave, and show the
  //    PRIMARY compiled lines of the regions it lit. The demo that the graph
  //    IS the prompt: what fires visually is what the worker reads verbatim. ──
  const firePulse = () => {
    const q = pq.trim();
    if (!q) return;
    const words = [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)))];
    const scored = [];
    genome.nodes.forEach((n) => {
      if (n.enabled === false) return;
      const lab = n.label.toLowerCase(), txt = (n.text || "").toLowerCase();
      let s = 0;
      words.forEach((w) => { if (lab.includes(w)) s += 2; if (txt.includes(w)) s += 1; });
      if (s > 0) scored.push({ id: n.id, label: n.label, s, w: n.weight || 0 });
    });
    scored.sort((a, b) => (b.s - a.s) || (b.w - a.w));
    const seeds = scored.slice(0, 5);
    if (seeds.length === 0) {
      setPulseRes(null); setAnswer(null);
      toast.push("No nodes matched — try words the mind actually knows.", { tone: "warning" });
      return;
    }
    const seedIds = seeds.map((x) => x.id);
    const trace = propagate(genome, seedIds);
    dnaBus.emit({ type: "activation", seeds: seedIds, trace, label: `Pulse — ${q.slice(0, 40)}` });
    const fired = new Set();
    genome.nodes.forEach((n) => { if ((trace.levels[n.id] || 0) > 0.05) fired.add(n.region); });
    const excerpt = compiled.sections
      .filter((s) => fired.has(s.region))
      .flatMap((s) => s.lines.filter((l) => l.startsWith("PRIMARY")))
      .slice(0, 6);
    setPulseRes({ q, seedLabels: seeds.map((x) => x.label), excerpt });
    setAnswer(null);
  };

  const think = async () => {
    if (!pulseRes || thinking) return;
    setThinking(true);
    const sys = compiled.systemPrompt; // the compiled mind, verbatim — no side prompt
    const res = await callClaude({
      model: "claude-haiku-4-5-20251001", max_tokens: 220, system: sys,
      messages: [{ role: "user", content: pulseRes.q }],
      fn: "dna_pulse", promptChars: sys.length + pulseRes.q.length,
    });
    if (res.ok && res.text) setAnswer(res.text.trim());
    else toast.push(`The mind couldn't think it through: ${res.error || "no answer"}`, { tone: "error" });
    setThinking(false);
  };

  // ── Mind menu actions ──
  const copyMind = async () => {
    try { await navigator.clipboard.writeText(compiled.systemPrompt); toast.push("Compiled mind copied.", { tone: "success" }); }
    catch { toast.push("Couldn't copy — clipboard blocked.", { tone: "error" }); }
  };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(genome, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `clarify-dna-${genome.genome_key || "genome"}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setPanel(null);
  };
  const importJson = async (file) => {
    try {
      const parsed = JSON.parse(await file.text());
      const v = validateGenome(parsed);
      if (!v.ok) {
        toast.push(`Import rejected — ${v.errors[0]}${v.errors.length > 1 ? ` (+${v.errors.length - 1} more)` : ""}`, { tone: "error" });
        return;
      }
      // Normalize the envelope so loadGenome() accepts it on the next boot.
      const next = { ...parsed, version: 1, genome_key: parsed.genome_key || "clarify_core", mutations: Array.isArray(parsed.mutations) ? parsed.mutations : [] };
      recordMutation(next, "import", `Imported genome "${next.genome_key}" — ${next.nodes.length} nodes / ${next.edges.length} synapses`);
      setGenome(saveGenome(next));
      setSelection(null);
      setPanel(null);
      toast.push("Genome imported — the mind has been replaced.", { tone: "success" });
    } catch {
      toast.push("Import rejected — not valid JSON.", { tone: "error" });
    }
  };
  const doReset = () => {
    if (!confirmReset) { setConfirmReset(true); setTimeout(() => setConfirmReset(false), 4000); return; }
    setConfirmReset(false);
    setGenome(resetGenome());
    setSelection(null);
    setPanel(null);
    toast.push("Genome reset to seed — the mind is factory-fresh.", { tone: "warning" });
  };

  const acceptSuggestion = (s) => {
    const res = addNode(genome, { label: s.label, region: REGIONS[s.region] ? s.region : "knowledge", text: s.text, source: "learned" });
    setGenome(saveGenome(res.genome));
    try { suggestions.resolve(s.id, true); } catch { /* store missing the row — nothing to resolve */ }
    bump();
    toast.push(`"${res.node.label}" grown into the mind.`, { tone: "success" });
  };
  const dismissSuggestion = (s) => { try { suggestions.resolve(s.id, false); } catch {} bump(); };

  // ── Shared render fragments ──
  const legendRow = (k) => {
    const r = REGIONS[k];
    const active = !regionFilter || regionFilter.has(k);
    return (
      <button key={k} onClick={() => toggleRegion(k)} title={r.desc}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: "8px", padding: "5px 7px", borderRadius: "8px", border: "none", background: "transparent", cursor: "pointer", opacity: active ? 1 : 0.38, transition: "opacity 0.15s" }}>
        <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: r.color, boxShadow: `0 0 6px ${r.color}66`, flexShrink: 0 }} />
        <span style={{ flex: 1, textAlign: "left", fontSize: "11px", fontWeight: 600, color: T.ink, fontFamily: T.fontDisplay }}>{r.label}</span>
        <span style={{ fontSize: "10.5px", fontFamily: T.fontMono, color: T.faint }}>{stats.byRegion[k] || 0}</span>
      </button>
    );
  };

  const legendChip = (k) => {
    const r = REGIONS[k];
    const active = !regionFilter || regionFilter.has(k);
    return (
      <button key={k} onClick={() => toggleRegion(k)}
        style={{ ...GLASS, pointerEvents: "auto", display: "inline-flex", alignItems: "center", gap: "6px", padding: "5px 11px", borderRadius: T.rPill, cursor: "pointer", flexShrink: 0, opacity: active ? 1 : 0.45, color: T.ink, fontSize: "10.5px", fontWeight: 600, fontFamily: T.fontDisplay }}>
        <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: r.color }} />{r.label}
      </button>
    );
  };

  const suggestTray = pending.length > 0 && (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", pointerEvents: "none" }}>
      <button onClick={() => setTrayOpen(!trayOpen)}
        style={{ ...GLASS, pointerEvents: "auto", borderRadius: T.rPill, padding: "6px 15px", color: T.inkBrand, fontFamily: T.fontDisplay, fontSize: "11px", fontWeight: 700, cursor: "pointer", boxShadow: `inset 0 0 0 1px ${T.goldLine}, ${T.shadowPopover}, ${T.glowBrass}`, whiteSpace: "nowrap" }}>
        🧠 The mind wants to grow — {pending.length} new node{pending.length !== 1 ? "s" : ""} proposed {trayOpen ? "▴" : "▾"}
      </button>
      {trayOpen && (
        <div style={{ ...GLASS, pointerEvents: "auto", marginTop: "8px", width: mobile ? "calc(100vw - 24px)" : "430px", maxWidth: "calc(100vw - 24px)", maxHeight: "300px", overflowY: "auto", padding: "10px" }}>
          {pending.map((s) => (
            <div key={s.id} style={{ padding: "10px 12px", borderRadius: "10px", background: T.subtle, marginBottom: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                <span style={{ fontSize: "12px", fontWeight: 700, color: T.ink, fontFamily: T.fontDisplay }}>{s.label}</span>
                <span style={{ fontSize: "10.5px", fontWeight: 700, fontFamily: T.fontDisplay, color: (REGIONS[s.region] || REGIONS.knowledge).color, background: `${(REGIONS[s.region] || REGIONS.knowledge).color}14`, padding: "2px 8px", borderRadius: T.rPill, flexShrink: 0 }}>
                  {(REGIONS[s.region] || REGIONS.knowledge).label}
                </span>
              </div>
              <div style={{ fontSize: "11px", color: T.muted, lineHeight: 1.55, margin: "5px 0 9px" }}>{s.text}</div>
              <div style={{ display: "flex", gap: "6px" }}>
                <button onClick={() => acceptSuggestion(s)}
                  style={{ padding: "5px 12px", background: `${T.green}14`, border: `1px solid ${T.green}40`, borderRadius: "8px", color: T.green, fontSize: "10.5px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay }}>
                  Accept — grow it
                </button>
                <button onClick={() => dismissSuggestion(s)}
                  style={{ padding: "5px 12px", background: "transparent", border: `1px solid ${T.line}`, borderRadius: "8px", color: T.muted, fontSize: "10.5px", fontWeight: 600, cursor: "pointer" }}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const inspectorBody = selNode
    ? <NodeInspector key={selNode.id} genome={genome} node={selNode} apply={apply} onSelect={setSelection} onDeleted={() => setSelection(null)} />
    : selEdge
      ? <EdgeInspector key={selEdge.id} genome={genome} edge={selEdge} apply={apply} onSelect={setSelection} onDeleted={() => setSelection(null)} />
      : null;

  const playBtn = (
    <button onClick={(e) => { e.stopPropagation(); wk.set({ running: !ctrl.running }); bump(); toast.push(ctrl.running ? "Worker paused." : "Worker running — one task per pass, drafts only.", { tone: ctrl.running ? "default" : "success" }); }}
      title={ctrl.running ? "Pause the worker" : "Start the worker"}
      style={{ width: "36px", height: "36px", borderRadius: "50%", border: "none", background: ctrl.running ? T.goldGrad : T.raised, color: ctrl.running ? T.textOnBrand : T.ink, fontSize: "13px", cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: ctrl.running ? `0 0 0 4px ${T.goldSoft}, ${T.glowBrass}` : "none" }}>
      {ctrl.running ? "⏸" : "▶"}
    </button>
  );

  const dockStatus = (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: "12px", fontWeight: 800, color: T.ink, fontFamily: T.fontDisplay, letterSpacing: "0.02em" }}>Worker</div>
      <div style={{ fontSize: "10.5px", color: workerActive ? T.greenHi : T.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        <span style={{ color: statusDot }}>{statusGlyph}</span> {statusText}
      </div>
    </div>
  );

  const menuItems = [
    { icon: "🧠", label: "View compiled mind", run: () => { setModal("compiled"); setPanel(null); } },
    { icon: "⇩", label: "Export JSON", run: exportJson },
    { icon: "⇪", label: "Import JSON", run: () => fileRef.current && fileRef.current.click() },
    { icon: "≣", label: "Mutation history", run: () => { setModal("history"); setPanel(null); } },
    { icon: "↺", label: confirmReset ? "Really reset the mind?" : "Reset to seed", danger: true, run: doReset },
  ];

  return (
    <div className="dna-view">
      {/* The mind itself — full-bleed beneath every overlay. */}
      <div style={{ position: "absolute", inset: 0 }}>
        <MindCanvas
          genome={genome}
          bus={dnaBus}
          palette={CLARIFY_MIND_PALETTE}
          label="Clarify DNA — neural map"
          selection={selection}
          onSelect={setSelection}
          onNodeMove={handleNodeMove}
          onAddNode={handleAddNodeAt}
          onAddEdge={handleAddEdge}
          regionFilter={regionFilter}
          height="100%"
          toastTop={mobile ? 104 : 62}
          apiRef={canvasApi}
        />
      </div>

      {/* Top layer: header strip (+ legend/tray in-flow on mobile). The center
          stays clear on purpose — the canvas floats its activation toast there. */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 6, pointerEvents: "none", display: "flex", flexDirection: "column", gap: "8px", padding: mobile ? "10px 12px 0" : "12px 16px 0" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "11px", pointerEvents: "auto" }}>
            <span aria-hidden style={{ display: "inline-flex", fontSize: "21px", lineHeight: 1, color: T.gold, textShadow: `0 0 14px ${T.goldLine}`, animation: "dnaGlyph 9s ease-in-out infinite" }}>⌬</span>
            <div>
              <div style={{ fontSize: "16px", fontWeight: 800, color: T.inkDeep, fontFamily: T.fontDisplay, letterSpacing: "0.01em" }}>Clarify DNA</div>
              <div className="dna-sub" style={{ fontSize: "11px", color: T.muted, marginTop: "1px" }}>The living mind behind the machine — every node compiles into how it thinks.</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end", pointerEvents: "auto" }}>
            <Pill label="nodes" value={stats.nodes} title={`${stats.enabled} awake`} />
            <Pill label="synapses" value={stats.edges} />
            <Pill label="mind" value={`#${compiled.hash.slice(0, 6)}`} brass title="Hash of the compiled system prompt — changes when the mind does" />
            <Pill label="tasks" value={tasksToday} title="Worker tasks today" />
            <Pill label="fired" value={pulseCount} title="Activations this session" />
            <button onClick={() => setPanel(panel === "pulse" ? null : "pulse")}
              style={{ ...GLASS, borderRadius: T.rPill, padding: "5px 13px", color: T.gold, fontFamily: T.fontDisplay, fontSize: "11px", fontWeight: 700, cursor: "pointer", boxShadow: `inset 0 0 0 1px ${T.goldLine}, ${T.shadowPopover}` }}>
              ⚡ Pulse
            </button>
            <button onClick={() => setPanel(panel === "menu" ? null : "menu")} title="Mind menu" aria-label="Mind menu"
              style={{ ...GLASS, borderRadius: T.rPill, padding: "5px 12px", color: T.muted, fontSize: "13px", fontWeight: 700, cursor: "pointer", lineHeight: 1.2 }}>
              ⋯
            </button>
          </div>
        </div>

        {/* Mobile: legend collapses to one scrolling chip row; tray joins the flow. */}
        {mobile && (
          <div className="dna-scroll-x" style={{ display: "flex", gap: "6px", overflowX: "auto", pointerEvents: "auto", paddingBottom: "2px" }}>
            {regionFilter && (
              <button onClick={() => setRegionFilter(null)} style={{ ...GLASS, pointerEvents: "auto", flexShrink: 0, padding: "5px 11px", borderRadius: T.rPill, cursor: "pointer", color: T.gold, fontSize: "10.5px", fontWeight: 700, fontFamily: T.fontDisplay }}>All</button>
            )}
            {Object.keys(REGIONS).map(legendChip)}
            <button onClick={growNode} style={{ ...GLASS, pointerEvents: "auto", flexShrink: 0, padding: "5px 11px", borderRadius: T.rPill, cursor: "pointer", color: T.gold, fontSize: "10.5px", fontWeight: 700, fontFamily: T.fontDisplay, boxShadow: `inset 0 0 0 1px ${T.goldLine}, ${T.shadowPopover}` }}>＋ Node</button>
          </div>
        )}
        {mobile && suggestTray}
      </div>

      {/* Desktop: floating legend, top-left. */}
      {!mobile && (
        <div style={{ ...GLASS, position: "absolute", top: "76px", left: "14px", zIndex: 6, padding: "10px 10px 9px", width: "176px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "6px", padding: "0 7px" }}>
            <span className="t-label">Regions</span>
            {regionFilter && (
              <button onClick={() => setRegionFilter(null)} style={{ background: "none", border: "none", color: T.gold, fontSize: "10.5px", fontWeight: 700, cursor: "pointer", padding: 0, fontFamily: T.fontDisplay }}>all</button>
            )}
          </div>
          {Object.keys(REGIONS).map(legendRow)}
          <div style={{ height: "1px", background: T.lineSoft, margin: "8px 0" }} />
          <button onClick={growNode}
            style={{ width: "100%", padding: "7px", background: T.goldSoft, border: `1px solid ${T.goldLine}`, borderRadius: "9px", color: T.gold, fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay }}>
            ＋ Node
          </button>
          <div style={{ fontSize: "10.5px", color: T.muted, lineHeight: 1.6, marginTop: "8px", padding: "0 2px" }}>
            dbl-click canvas — new node<br />⇧-drag node — wire synapse
          </div>
        </div>
      )}

      {/* Desktop: suggestions tray floats top-center, under the header. */}
      {!mobile && pending.length > 0 && (
        <div style={{ position: "absolute", top: "64px", left: 0, right: 0, zIndex: 10, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
          {suggestTray}
        </div>
      )}

      {/* Pulse popover — ask the mind; watch it fire; read what compiled. When
          the desktop inspector is open (select node → Pulse is THE demo flow)
          the popover steps left of it instead of stacking on top — stacked, the
          inspector's un-confirmable Delete button sat hidden right under the
          popover's CTA. */}
      {panel === "pulse" && (
        <div style={{ ...GLASS, position: "absolute", top: mobile ? "104px" : "58px", right: mobile ? "10px" : inspectorBody ? "346px" : "14px", left: mobile ? "10px" : "auto", width: mobile ? "auto" : "348px", zIndex: 30, padding: "13px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "9px" }}>
            <span className="t-label">Pulse the mind</span>
            <button onClick={() => setPanel(null)} className="co-modal-close icon-btn" aria-label="Close">×</button>
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            <input value={pq} onChange={(e) => setPq(e.target.value)} onKeyDown={(e) => e.key === "Enter" && firePulse()} placeholder="Ask the mind…"
              className="field" style={{ padding: "8px 11px", fontSize: "13px" }} />
            <button onClick={firePulse}
              style={{ padding: "8px 14px", background: T.goldGrad, border: "none", borderRadius: T.rSm, color: T.textOnBrand, fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay, flexShrink: 0 }}>
              Fire
            </button>
          </div>
          {pulseRes && (
            <div style={{ marginTop: "11px" }}>
              <div style={{ fontSize: "10.5px", color: T.muted, lineHeight: 1.5 }}>
                ⚡ Fired <span style={{ color: T.inkBrand, fontWeight: 600 }}>{pulseRes.seedLabels.join(" · ")}</span>
              </div>
              {pulseRes.excerpt.length > 0 && (
                <div style={{ marginTop: "9px" }}>
                  <div className="t-label" style={{ marginBottom: "5px" }}>From the compiled mind</div>
                  <div style={{ maxHeight: "140px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "4px" }}>
                    {pulseRes.excerpt.map((l, i) => (
                      <div key={i} style={{ fontFamily: T.fontMono, fontSize: "10.5px", color: T.muted, lineHeight: 1.5, borderLeft: `2px solid ${T.goldLine}`, paddingLeft: "8px" }}>{l}</div>
                    ))}
                  </div>
                </div>
              )}
              <button onClick={think} disabled={thinking}
                style={{ marginTop: "10px", width: "100%", padding: "8px", background: thinking ? T.subtle : T.goldSoft, border: `1px solid ${T.goldLine}`, borderRadius: "9px", color: thinking ? T.faint : T.gold, fontSize: "11px", fontWeight: 700, cursor: thinking ? "wait" : "pointer", fontFamily: T.fontDisplay }}>
                {thinking ? "Thinking…" : "✦ Think it through (Haiku)"}
              </button>
              {answer && (
                <div style={{ marginTop: "9px", padding: "10px 11px", background: T.subtle, borderRadius: "9px", fontSize: "12px", color: T.ink, lineHeight: 1.6, maxHeight: "180px", overflowY: "auto" }}>
                  {answer}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ⋯ menu */}
      {panel === "menu" && (
        <div style={{ ...GLASS, position: "absolute", top: mobile ? "104px" : "58px", right: mobile ? "10px" : "14px", width: "236px", zIndex: 30, padding: "5px", borderRadius: T.rMd }}>
          {menuItems.map((it) => (
            <button key={it.label} className="dna-menuitem" onClick={it.run}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: "10px", padding: "9px 10px", background: "transparent", border: "none", borderRadius: "8px", cursor: "pointer", color: it.danger ? T.red : T.ink, fontSize: "12px", fontWeight: 600, textAlign: "left" }}>
              <span style={{ width: "18px", textAlign: "center", fontSize: "12px", color: it.danger ? T.red : T.muted, flexShrink: 0 }}>{it.icon}</span>
              {it.label}
            </button>
          ))}
        </div>
      )}
      <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) importJson(f); }} />

      {/* Inspector — right panel on desktop, bottom sheet on mobile. */}
      {inspectorBody && (mobile ? (
        <div className="co-modal-overlay" onClick={() => setSelection(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadein 0.15s ease both" }}>
          <div className="co-modal-sheet" onClick={(e) => e.stopPropagation()}
            style={{ background: T.surface, border: "none", borderRadius: "16px", width: "520px", maxWidth: "94vw", maxHeight: "86vh", overflowY: "auto", boxShadow: T.shadowModal, padding: "16px 18px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "12px" }}>
              <span className="t-label">{selNode ? "Node" : "Synapse"}</span>
              <button onClick={() => setSelection(null)} className="co-modal-close icon-btn" aria-label="Close">×</button>
            </div>
            {inspectorBody}
          </div>
        </div>
      ) : (
        <div style={{ ...GLASS, position: "absolute", top: "76px", right: "14px", width: "320px", maxHeight: "calc(100% - 100px)", zIndex: 9, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "12px 14px 0", flexShrink: 0 }}>
            <span className="t-label">{selNode ? "Node" : "Synapse"}</span>
            <button onClick={() => setSelection(null)} className="icon-btn" aria-label="Close inspector">×</button>
          </div>
          <div style={{ overflowY: "auto", padding: "9px 14px 14px" }}>{inspectorBody}</div>
        </div>
      ))}

      {/* Worker dock — floating panel on desktop, status pill → sheet on mobile. */}
      {mobile ? (
        <>
          <button onClick={() => setDockSheet(true)}
            style={{ ...GLASS, position: "absolute", left: "12px", bottom: "12px", zIndex: 8, borderRadius: T.rPill, padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: "8px", color: T.ink, fontFamily: T.fontDisplay, fontSize: "11px", fontWeight: 700, cursor: "pointer" }}>
            <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: statusDot, animation: workerActive ? "pulse 2s infinite" : "none" }} />
            Worker{workerActive ? " · on" : ""}
          </button>
          {dockSheet && (
            <div className="co-modal-overlay" onClick={() => setDockSheet(false)}
              style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadein 0.15s ease both" }}>
              <div className="co-modal-sheet" onClick={(e) => e.stopPropagation()}
                style={{ background: T.surface, border: "none", borderRadius: "16px", width: "520px", maxWidth: "94vw", maxHeight: "86vh", overflowY: "auto", boxShadow: T.shadowModal }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "14px 16px 10px" }}>
                  {playBtn}
                  {dockStatus}
                  <button onClick={() => setDockSheet(false)} className="co-modal-close icon-btn" aria-label="Close">×</button>
                </div>
                <DockBody ctrl={ctrl} log={log} tasksToday={tasksToday} bump={bump} replay={replay} toast={toast} />
              </div>
            </div>
          )}
        </>
      ) : (
        // Capped so an expanded dock with a full log scrolls INSIDE itself on
        // short viewports instead of climbing over the region legend (top 76 →
        // ~356px, same left edge, lower z) and click-blocking its controls. The
        // 380px headroom keeps the dock's top edge below the legend on any
        // reasonable desktop height; the 280px floor keeps it usable.
        <div style={{ ...GLASS, position: "absolute", left: "14px", bottom: "14px", width: "360px", maxWidth: "calc(100vw - 220px)", maxHeight: "max(280px, calc(100% - 380px))", zIndex: 8, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div onClick={() => setDockOpen((o) => !o)} title={dockOpen ? "Collapse the dock" : "Expand the dock"}
            style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 14px", cursor: "pointer", flexShrink: 0 }}>
            {playBtn}
            {dockStatus}
            <span style={{ color: T.faint, fontSize: "11px", flexShrink: 0 }}>{dockOpen ? "▾" : "▴"}</span>
          </div>
          {dockOpen && (
            <div style={{ overflowY: "auto", minHeight: 0 }}>
              <DockBody ctrl={ctrl} log={log} tasksToday={tasksToday} bump={bump} replay={replay} toast={toast} />
            </div>
          )}
        </div>
      )}

      {/* Compiled-mind modal — the deterministic artifact, verbatim. */}
      {modal === "compiled" && (
        <Overlay onClose={() => setModal(null)} width={720}>
          <div style={{ padding: "18px 22px 14px", borderBottom: `1px solid ${T.lineInk}`, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexShrink: 0 }}>
            <div>
              <div style={{ fontSize: "15px", fontWeight: 700, color: T.ink, fontFamily: T.fontDisplay }}>Compiled mind</div>
              <div style={{ fontSize: "10.5px", color: T.faint, marginTop: "3px", fontFamily: T.fontMono }}>
                #{compiled.hash} · {compiled.systemPrompt.length.toLocaleString()} chars — this exact string is the worker's system prompt
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
              <button onClick={copyMind}
                style={{ padding: "6px 13px", background: T.goldSoft, border: `1px solid ${T.goldLine}`, borderRadius: "8px", color: T.gold, fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay }}>
                ⧉ Copy
              </button>
              <button onClick={() => setModal(null)} className="co-modal-close icon-btn" style={{ fontSize: "20px" }} aria-label="Close">×</button>
            </div>
          </div>
          <div style={{ overflowY: "auto", padding: "16px 22px" }}>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: T.fontMono, fontSize: "11px", lineHeight: 1.7, color: T.muted }}>{compiled.systemPrompt}</pre>
          </div>
        </Overlay>
      )}

      {/* Mutation history — every change the mind has lived through. */}
      {modal === "history" && (
        <Overlay onClose={() => setModal(null)} width={400} side="right">
          <div style={{ padding: "18px 20px 12px", borderBottom: `1px solid ${T.lineInk}`, display: "flex", alignItems: "baseline", justifyContent: "space-between", flexShrink: 0 }}>
            <div>
              <div style={{ fontSize: "15px", fontWeight: 700, color: T.ink, fontFamily: T.fontDisplay }}>Mutation history</div>
              <div style={{ fontSize: "10.5px", color: T.faint, marginTop: "2px" }}>{(genome.mutations || []).length} recorded · newest first · capped at 200</div>
            </div>
            <button onClick={() => setModal(null)} className="co-modal-close icon-btn" style={{ fontSize: "20px" }} aria-label="Close">×</button>
          </div>
          <div style={{ overflowY: "auto", padding: "12px 16px", flex: 1 }}>
            {(genome.mutations || []).length === 0 ? (
              <div style={{ fontSize: "12px", color: T.faint, textAlign: "center", padding: "24px 0" }}>No mutations yet — the mind is untouched seed.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
                {(genome.mutations || []).map((m) => (
                  <div key={m.id} style={{ display: "flex", gap: "10px", padding: "9px 11px", background: T.subtle, borderRadius: "9px", borderLeft: `3px solid ${KIND_COLOR[m.kind] || T.faint}` }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "11.5px", color: T.ink, lineHeight: 1.5 }}>{m.summary}</div>
                      <div style={{ fontSize: "10.5px", color: T.faint, marginTop: "3px", fontFamily: T.fontMono }}>{m.kind} · {new Date(m.ts).toLocaleString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Overlay>
      )}
    </div>
  );
}
