import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { estimateCost } from "@cc/ai";
import { MindCanvas } from "@cc/mind-canvas";
import { ZTS_MIND_PALETTE, ZTS_MIND_LOOK } from "./palette.js";
import { supabase } from "../supabaseClient";
import {
  REGIONS, ZTS_GOVERNANCE,
  loadGenome, saveGenome, resetGenome, recordMutation,
  addNode, updateNode, removeNode, addEdge, updateEdge, removeEdge,
  validateGenome, compileGenome, propagate, dnaBus, genomeStats,
} from "./dna.js";
// The worker is a sibling module (built in parallel, spec §3). We import ONLY the
// stores + helpers the dock reads; the worker component itself mounts at App root.
import { wk, worklog, suggestions, inShift, WORKER_DEFAULTS } from "./dnaWorker.js";
import { useToast, M } from "../ui.jsx";

// ════════════════════════════════════════════════════════════════════════════
// ZTS DNA VIEW — the tab around the mind. The MindCanvas IS the page; everything
// else floats over it in LIGHT glass: the header + stat pills, the region legend,
// the node/edge inspector, the worker dock, the suggestions tray, the pulse
// popover and the ⋯ menu. One rule holds everywhere: every genome edit routes
// through a dna.js CRUD function and then saveGenome(), so the mutation history
// records it and the dnaBus "genome" event keeps every consumer (canvas, worker,
// pills) in sync. The view owns zero business logic — it is chrome around the
// genome + a thin dock over the worker's localStorage stores.
//
// LIGHT-THEME PORT of Clarify's proven dark DnaView. Structure, gestures, replay,
// pulse flow and the ⋯ menu are the same; only the paint changes — white glass on
// the ZTS canvas, ink text, a secure-green / brass accent family, ModalShell-feel
// bottom sheets on mobile. App.jsx keeps its `T`/`sm`/`callClaude` module-local
// and exports none of them, so — exactly like dna.js and the worker — this file
// re-declares the tiny primitives it needs against the same `zts_` namespace.
// ════════════════════════════════════════════════════════════════════════════

// ─── Claude call — re-declared from App.jsx lines 24-70 (verbatim shape) ───────
// The Pulse's "Think it through" runs the compiled mind exactly as the worker
// would. App.jsx exports nothing, so the call + its obs logging live here against
// the same `zts_` localStorage the app + Ops tab read. Returns raw text or null,
// never sends temperature/top_p, defaults to Haiku — the ZTS signature.
// localhost ONLY. Read unconditionally, this baked the key into the public
// bundle the moment VITE_ANTHROPIC_API_KEY was ever set in Netlify — deployed
// traffic rides /.netlify/functions/claude and never needs it. Matches the
// guard Clarify already had (apps/clarify/src/config.js).
// BUILD-TIME gate, not a runtime one. `import.meta.env.DEV` is statically
// replaced by Vite with the literal `false` in a production build, so the
// whole ternary folds to "" and the key is NEVER EMITTED into dist.
//
// A `window.location.hostname === "localhost"` check does NOT do this: the
// minifier cannot evaluate it, so it keeps both branches and the key survives
// as a string literal in the shipped JS — readable by anyone who opens
// devtools, even though the code would never USE it off localhost. Verified
// by building with a canary value and grepping dist.
const IS_LOCAL = typeof window !== "undefined" && window.location.hostname === "localhost";
const ANTHROPIC_API_KEY = import.meta.env.DEV ? (import.meta.env.VITE_ANTHROPIC_API_KEY || "") : "";
const sm = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(`zts_${k}`)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(`zts_${k}`, JSON.stringify(v)); } catch {} },
};
const obs = {
  log: (entry) => { const e = { id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ts: new Date().toISOString(), ...entry }; sm.set("obs_log", [e, ...(sm.get("obs_log") || [])].slice(0, 500)); },
};
async function callClaude({ system, messages, model = "claude-haiku-4-5-20251001", maxTokens = 1024, fn = "generate" }) {
  const t0 = Date.now();
  try {
    const isDeployed = window.location.hostname !== "localhost";
    const url = isDeployed ? "/.netlify/functions/claude" : "https://api.anthropic.com/v1/messages";
    let bearer = null;
    if (isDeployed) { try { bearer = (await supabase?.auth.getSession())?.data?.session?.access_token || null; } catch {} }
    const headers = isDeployed
      ? { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }
      : { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
    const body = { model, max_tokens: maxTokens, messages };
    if (system) body.system = system;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const data = await res.json();
    const text = data.content?.map(b => b.type === "text" ? b.text : "").join("") || "";
    const inTok = data.usage?.input_tokens || Math.round(JSON.stringify(messages).length / 4);
    const outTok = data.usage?.output_tokens || Math.round(text.length / 4);
    obs.log({ fn, model, inputTokens: inTok, outputTokens: outTok, costEstimate: estimateCost(model, inTok, outTok), latencyMs: Date.now() - t0, ok: !!text });
    return text;
  } catch {
    obs.log({ fn, model, ok: false, latencyMs: Date.now() - t0 });
    return null;
  }
}

// ─── Dark design tokens — the ZTS palette on the shared midnight canvas.
//    Every value reads on the #0B0F1A canvas / dark glass. The compiled-mind
//    "gold/brass" highlight family maps to ZTS's emerald accent so the DNA view
//    carries the same identity as the rest of the app. `muted` is the text
//    floor; `faint` is decoration only. ────────────────────────────────────────
const T = {
  ink: "#E9EDF5", inkDeep: "#F7F9FC", muted: "#94A1B5", faint: "#66738A",
  surface: "#141B2C", subtle: "#0F1626", raised: "#1B2438",
  line: "rgba(255,255,255,0.085)", lineSoft: "rgba(255,255,255,0.055)", lineInk: "rgba(255,255,255,0.07)",
  green: "#3ECF8E", greenHi: "#5EE0A8", red: "#F87171", blue: "#6EA8FE", violet: "#A78BFA", amber: "#F5B84D",
  // Accent family — ZTS emerald; the compiled-mind highlight (was brass on light).
  gold: "#3ECF8E", goldSoft: "rgba(62,207,142,0.12)", goldLine: "rgba(62,207,142,0.30)",
  goldGrad: "linear-gradient(135deg, #5EE0A8 0%, #0E9F6E 100%)", inkBrand: "#9BE3C0", textOnBrand: "#052B1C",
  focusRing: "rgba(62,207,142,0.34)", glowBrass: "0 0 24px rgba(62,207,142,0.20)",
  // Dark Card shadow (glass uses the app's cardShadow), plus modal lift.
  cardShadow: "0 1px 2px rgba(0,0,0,0.5), 0 8px 30px rgba(0,0,0,0.4)",
  shadowPopover: "0 10px 30px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.45)",
  shadowModal: "0 24px 70px rgba(0,0,0,0.65), 0 8px 24px rgba(0,0,0,0.5)",
  rPill: "999px", rLg: "16px", rMd: "12px", rSm: "9px",
  fontDisplay: "'Syne', system-ui", fontMono: "'DM Mono', monospace", fontBody: "'Inter', system-ui, sans-serif",
};

// Glass recipe for every floating panel — spec'd once so the whole overlay layer
// reads as one material (dark glass on the midnight canvas): the app's Card.
const GLASS = {
  background: "rgba(20,27,44,0.88)",
  backdropFilter: "blur(18px)",
  WebkitBackdropFilter: "blur(18px)",
  border: `1px solid ${T.lineSoft}`,
  boxShadow: T.cardShadow,
  borderRadius: T.rLg,
};

// Field/eyebrow label + input base styles (App.jsx keeps its theme.js-equivalents
// module-local; re-declared here for the ported inspector/dock chrome).
const sectionLabel = { fontSize: "10px", fontWeight: 700, color: T.faint, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: T.fontDisplay };
const inputBase = { width: "100%", background: T.surface, border: `1px solid ${T.line}`, borderRadius: T.rSm, color: T.ink, outline: "none", fontFamily: T.fontBody };
const selectBase = { ...inputBase, cursor: "pointer" };
const rowLabel = { fontSize: "9.5px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: T.fontDisplay, marginBottom: "6px" };
const xBtn = { background: "none", border: "none", color: T.faint, fontSize: "18px", cursor: "pointer", lineHeight: 1, padding: "0 2px" };

// The six ZTS worker skills the dock can arm — keys match the worker's taskTypes
// { short, article, pitch, scout, strategy, grow } (spec §3).
const TASK_TYPES = [
  ["short", "Short"], ["article", "Article"], ["pitch", "Pitch"],
  ["scout", "Scout"], ["strategy", "Strategy"], ["grow", "Grow"],
];
const LOG_DOT = { done: T.green, failed: T.red, skipped: T.faint };
const KIND_COLOR = { add_node: T.green, remove_node: T.red, update_node: T.blue, add_edge: T.green, remove_edge: T.red, update_edge: T.blue, reset: T.amber, import: T.violet };

// Skill-node execution defaults exposed in the inspector (the worker reads model
// + maxTokens off the node; Haiku-first per the doctrine, Sonnet for long-form).
const HAIKU = "claude-haiku-4-5-20251001";
const MODELS = [["claude-haiku-4-5-20251001", "Haiku · fast + cheap"], ["claude-sonnet-4-6", "Sonnet · deep + costly"]];

// Compile lens — how much of the deterministic compiled mind to reveal. The
// worker ALWAYS runs on the full prompt; this only tunes what the Pulse excerpt +
// the compiled-mind modal surface (PRIMARY = the loudest commands; Standing =
// everything but minor whispers; Full = the verbatim worker prompt).
const LEVELS = [["primary", "Primary"], ["standing", "Standing"], ["full", "Full"]];
const levelLines = (lines, level) =>
  level === "full" ? lines
    : level === "primary" ? lines.filter((l) => l.startsWith("PRIMARY"))
      : lines.filter((l) => !l.startsWith("Minor"));

// Words too common to mean anything when the pulse matches a query to nodes.
const STOP = new Set("the a an and or but for nor with that this these those what when where how why who are is was were be been do does did should would could can our your their its from into then than about have has had not you they i we it if of on in to as at by".split(" "));

const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const isToday = (iso) => new Date(iso).toDateString() === new Date().toDateString();

// wk.get() may be partial (older stored ctrl, or nothing) — always re-hydrate
// against WORKER_DEFAULTS, nested objects included, so the dock never renders an
// undefined field.
const readCtrl = () => {
  const c = wk.get() || {};
  return {
    ...WORKER_DEFAULTS, ...c,
    eveningShift: { ...WORKER_DEFAULTS.eveningShift, ...(c.eveningShift || {}) },
    taskTypes: { ...WORKER_DEFAULTS.taskTypes, ...(c.taskTypes || {}) },
  };
};

// A suggestion is pending unless the worker's resolve() has marked it — tolerant
// of a flag, a status field, or a removal-based store.
const pendingSuggestions = () => {
  let all;
  try { all = suggestions.all() || []; } catch { all = []; }
  return all.filter((s) => s && !s.resolved && s.status !== "resolved");
};

// View-scoped CSS: full-bleed height math (100dvh with a 100vh fallback — inline
// styles can't double-declare a property), the mobile height that also clears the
// 52px header + 60px bottom nav, and the header glyph's slow spin (the app's
// global reduced-motion rule zeroes the animation for free).
const VIEW_CSS = `
.dna-view { position: relative; overflow: hidden; height: calc(100vh - 52px); height: calc(100dvh - 52px); }
.dna-scroll-x { scrollbar-width: none; }
.dna-scroll-x::-webkit-scrollbar { display: none; }
.dna-logrow { transition: background 0.15s ease; }
.dna-logrow:hover { background: rgba(255,255,255,0.04); }
.dna-menuitem:hover { background: rgba(255,255,255,0.05); }
.dna-view input[type="range"] { cursor: pointer; }
@keyframes dnaGlyph { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(180deg); } }
@media (max-width: 680px) {
  .dna-view { height: calc(100vh - 112px); height: calc(100dvh - 112px - var(--safe-bottom)); }
  .dna-sub { display: none; }
}
`;


// ─── Small primitives ─────────────────────────────────────────────────────────
// Pill lives at module scope on purpose: declared inside the view its identity
// would change every render, and React would remount all header pills on every
// 1.5s poll tick and every Pulse keystroke.
function Pill({ label, value, brass, title }) {
  return (
    <span title={title} style={{ ...GLASS, borderRadius: T.rPill, padding: "4px 11px", display: "inline-flex", alignItems: "baseline", gap: "6px", pointerEvents: "auto" }}>
      <span style={{ fontSize: "8.5px", fontWeight: 700, color: T.faint, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: T.fontDisplay }}>{label}</span>
      <span style={{ fontSize: "11.5px", fontFamily: T.fontMono, color: brass ? T.gold : T.ink, fontWeight: brass ? 700 : 500 }}>{value}</span>
    </span>
  );
}

function Switch({ on, onClick, disabled, title }) {
  return (
    <div onClick={disabled ? undefined : onClick} title={title} role="switch" aria-checked={!!on}
      style={{ width: "34px", height: "20px", borderRadius: "12px", background: on ? T.green : "rgba(255,255,255,0.14)", position: "relative", flexShrink: 0, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1, transition: `background ${M.durFast} ${M.easeStd}` }}>
      <div style={{ position: "absolute", top: "2px", left: on ? "16px" : "2px", width: "16px", height: "16px", borderRadius: "50%", background: "#FFFFFF", transition: `left ${M.durFast} ${M.easeStd}`, boxShadow: "0 1px 3px rgba(0,0,0,0.4)" }} />
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
      style={{ ...inputBase, padding: "8px 11px", fontSize: "12px", lineHeight: 1.55, resize: "none", overflow: "hidden", fontFamily: T.fontBody }} />
  );
}

// One overlay primitive for every takeover surface — mirrors App.jsx's ModalShell
// feel (App.jsx keeps ModalShell module-local): centered card on desktop, an
// optional right drawer for the mutation history, and a bottom sheet with a
// grabber on mobile.
function ModalSheet({ mobile, onClose, width = 560, side, children }) {
  const right = side === "right" && !mobile;
  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(11,18,32,0.5)", zIndex: 320, display: "flex", alignItems: mobile ? "flex-end" : right ? "stretch" : "center", justifyContent: right ? "flex-end" : "center", padding: mobile || right ? 0 : "20px", animation: `${mobile ? "slideup" : "fadein"} 0.18s ease both` }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: T.surface, border: `1px solid ${T.lineInk}`, borderRadius: mobile ? "20px 20px 0 0" : right ? "16px 0 0 16px" : "18px", width: mobile ? "100%" : `${width}px`, maxWidth: mobile ? "100%" : "94vw", maxHeight: mobile ? "90vh" : right ? "100vh" : "88vh", height: right ? "100%" : "auto", display: "flex", flexDirection: "column", boxShadow: T.shadowModal, overflow: "hidden" }}>
        {mobile && <div style={{ width: "36px", height: "4px", borderRadius: "3px", background: "rgba(255,255,255,0.18)", margin: "10px auto -2px", flexShrink: 0 }} />}
        {children}
      </div>
    </div>
  );
}


// ─── Inspector: node ──────────────────────────────────────────────────────────
// Text-ish fields hold a local draft and commit on blur; the weight slider holds
// a draft while dragging and commits on release. Both exist for the same reason:
// dna.js records a mutation-history line per update, and a line per keystroke
// would bury the history in noise. key={node.id} resets drafts on selection.
function NodeInspector({ genome, node, apply, onSelect, onDeleted }) {
  const [label, setLabel] = useState(node.label);
  const [text, setText] = useState(node.text || "");
  const [w, setW] = useState(null);
  const [mt, setMt] = useState(node.maxTokens != null ? String(node.maxTokens) : "600");
  const conns = genome.edges.filter((e) => e.from === node.id || e.to === node.id);
  const wired = new Set(genome.edges.filter((e) => e.from === node.id).map((e) => e.to));
  const wireTargets = genome.nodes.filter((n) => n.id !== node.id && !wired.has(n.id));
  const liveW = w != null ? w : Math.round((node.weight || 0) * 100);
  const isSkill = node.region === "skill";

  const commitLabel = () => { const v = label.trim(); if (v && v !== node.label) apply(updateNode(genome, node.id, { label: v })); else setLabel(node.label); };
  const commitText = () => { if (text !== (node.text || "")) apply(updateNode(genome, node.id, { text })); };
  const commitW = () => { if (w == null) return; if (w / 100 !== node.weight) apply(updateNode(genome, node.id, { weight: w / 100 })); setW(null); };
  const commitMt = () => { const v = Math.max(64, Math.min(4000, parseInt(mt, 10) || 600)); if (v !== node.maxTokens) apply(updateNode(genome, node.id, { maxTokens: v })); setMt(String(v)); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "13px" }}>
      <div>
        <div style={rowLabel}>Label</div>
        <input value={label} maxLength={28} onChange={(e) => setLabel(e.target.value)} onBlur={commitLabel} onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
          style={{ ...inputBase, padding: "8px 11px", fontSize: "12.5px", fontWeight: 600, fontFamily: T.fontDisplay }} />
      </div>

      <div>
        <div style={rowLabel}>Region</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
          {Object.entries(REGIONS).map(([k, r]) => {
            const on = k === node.region;
            return (
              <button key={k} title={r.desc} onClick={() => !on && apply(updateNode(genome, node.id, { region: k }))}
                style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "4px 9px", borderRadius: T.rPill, cursor: "pointer", fontSize: "10px", fontWeight: 700, fontFamily: T.fontDisplay, background: on ? `${r.color}1F` : "transparent", border: `1px solid ${on ? `${r.color}66` : T.line}`, color: on ? r.color : T.muted }}>
                <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: r.color }} />{r.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div style={{ ...rowLabel, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span>Weight</span>
          <span style={{ fontFamily: T.fontMono, fontSize: "12px", color: T.gold, letterSpacing: 0, textTransform: "none" }}>{liveW}%</span>
        </div>
        <input type="range" min={0} max={100} value={liveW} onChange={(e) => setW(Number(e.target.value))} onPointerUp={commitW} onKeyUp={commitW} onBlur={commitW}
          style={{ width: "100%", accentColor: T.gold, display: "block" }} />
        {/* Instructional copy reads in T.muted — the AA floor. T.faint is decoration only. */}
        <div style={{ fontSize: "9px", color: T.muted, marginTop: "4px" }}>
          {liveW >= 75 ? "Compiles as PRIMARY — a command" : liveW >= 40 ? "Compiles as a standing line" : "Compiles as a minor consideration"}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "12px", fontWeight: 600, color: T.ink }}>Awake</div>
          <div style={{ fontSize: "9.5px", color: T.muted }}>{node.enabled !== false ? "Compiling into the mind" : "Silenced — omitted from the prompt"}</div>
        </div>
        <Switch on={node.enabled !== false} disabled={node.locked} title={node.locked ? "Locked — governance nodes cannot be silenced" : undefined}
          onClick={() => apply(updateNode(genome, node.id, { enabled: node.enabled === false }))} />
      </div>

      <div>
        <div style={rowLabel}>Directive</div>
        <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} onBlur={commitText} placeholder="What this node tells the mind…" />
      </div>

      {/* Skill execution settings — the worker reads model + maxTokens off the
          node when it turns this skill into a real callClaude(). These fields
          never touch compileGenome, so tuning them never perturbs the mind hash. */}
      {isSkill && (
        <div style={{ display: "flex", flexDirection: "column", gap: "11px", padding: "11px", background: T.subtle, borderRadius: T.rMd, border: `1px solid ${T.lineSoft}` }}>
          <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: T.fontDisplay }}>How this skill runs</div>
          <div>
            <div style={rowLabel}>Model</div>
            <select value={node.model || HAIKU} onChange={(e) => apply(updateNode(genome, node.id, { model: e.target.value }))}
              style={{ ...selectBase, padding: "7px 10px", fontSize: "11.5px" }}>
              {MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <div style={{ ...rowLabel, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span>Max tokens</span>
              <span style={{ fontFamily: T.fontMono, fontSize: "9.5px", color: T.faint, letterSpacing: 0, textTransform: "none" }}>output ceiling</span>
            </div>
            <input type="number" min={64} max={4000} step={32} value={mt} onChange={(e) => setMt(e.target.value)} onBlur={commitMt} onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
              style={{ ...inputBase, padding: "7px 10px", fontSize: "11.5px", fontFamily: T.fontMono }} />
          </div>
        </div>
      )}

      <div>
        <div style={{ ...rowLabel, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span>Synapses</span>
          <span style={{ fontFamily: T.fontMono, fontSize: "10px", color: T.faint, letterSpacing: 0 }}>{conns.length}</span>
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
                  <span title={e.polarity === -1 ? "Tempers" : "Excites"} style={{ fontSize: "10px", flexShrink: 0 }}>{e.polarity === -1 ? "⛔" : "⚡"}</span>
                  <button onClick={() => onSelect({ type: "edge", id: e.id })} title="Inspect this synapse"
                    style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", cursor: "pointer", color: T.ink, fontSize: "11px", padding: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {out ? "→ " : "← "}{other ? other.label : otherId}
                  </button>
                  <span style={{ fontFamily: T.fontMono, fontSize: "10px", color: T.muted, flexShrink: 0 }}>{(e.weight || 0).toFixed(2)}</span>
                  <button onClick={() => apply(removeEdge(genome, e.id))} title="Cut synapse" style={{ ...xBtn, fontSize: "12px", flexShrink: 0 }}>✕</button>
                </div>
              );
            })}
          </div>
        )}
        {/* The canvas's ⇧-drag/hover-port gesture needs a mouse; this select is the
            touch- and keyboard-reachable way to wire an edge. addEdge's own guards
            (self-loop, dupes) still apply via `apply`. */}
        {wireTargets.length > 0 && (
          <select value="" aria-label="Wire a synapse to another node"
            onChange={(e) => { if (e.target.value) apply(addEdge(genome, { from: node.id, to: e.target.value })); }}
            style={{ ...selectBase, marginTop: "6px", padding: "6px 9px", fontSize: "11px" }}>
            <option value="">＋ Wire a synapse to…</option>
            {wireTargets.map((n) => (
              <option key={n.id} value={n.id}>{n.label} · {(REGIONS[n.region] || REGIONS.knowledge).label}</option>
            ))}
          </select>
        )}
      </div>

      {node.locked ? (
        <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", padding: "9px 11px", background: T.goldSoft, border: `1px solid ${T.goldLine}`, borderRadius: "9px", fontSize: "10.5px", color: T.inkBrand, lineHeight: 1.5 }}>
          <span>🔒</span><span>Core doctrine — cannot be removed or silenced. Weight is still yours to tune.</span>
        </div>
      ) : (
        <button onClick={() => { apply(removeNode(genome, node.id)); onDeleted(); }}
          style={{ width: "100%", padding: "9px", background: `${T.red}14`, border: `1px solid ${T.red}40`, borderRadius: "9px", color: T.red, fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay }}>
          Delete node
        </button>
      )}

      <div style={{ fontSize: "9px", color: T.faint, fontFamily: T.fontMono }}>{node.source || "user"} · {node.id}</div>
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
        <div style={{ ...rowLabel, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span>Weight</span>
          <span style={{ fontFamily: T.fontMono, fontSize: "12px", color: T.gold, letterSpacing: 0, textTransform: "none" }}>{liveW}%</span>
        </div>
        <input type="range" min={0} max={100} value={liveW} onChange={(e) => setW(Number(e.target.value))} onPointerUp={commitW} onKeyUp={commitW} onBlur={commitW}
          style={{ width: "100%", accentColor: T.gold, display: "block" }} />
      </div>

      <div>
        <div style={rowLabel}>Polarity</div>
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
        <div style={{ fontSize: "9px", color: T.muted, marginTop: "5px", lineHeight: 1.5 }}>
          Tempers compiles into an INTERNAL TENSIONS line — when they conflict, the source node wins.
        </div>
      </div>

      <button onClick={() => { apply(removeEdge(genome, edge.id)); onDeleted(); }}
        style={{ width: "100%", padding: "9px", background: `${T.red}14`, border: `1px solid ${T.red}40`, borderRadius: "9px", color: T.red, fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay }}>
        Cut synapse
      </button>

      <div style={{ fontSize: "9px", color: T.faint, fontFamily: T.fontMono }}>{edge.id}</div>
    </div>
  );
}


// ─── Worker dock body — controls + work log ───────────────────────────────────
function DockBody({ ctrl, log, tasksToday, bump, replay, toast }) {
  const shift = ctrl.eveningShift;
  const numStyle = { ...inputBase, width: "58px", padding: "5px 8px", fontSize: "11px", fontFamily: T.fontMono, textAlign: "center" };
  const timeStyle = { ...inputBase, width: "102px", padding: "4px 7px", fontSize: "11px", fontFamily: T.fontMono };

  return (
    <div style={{ padding: "2px 14px 12px", display: "flex", flexDirection: "column", gap: "12px" }}>
      {/* Evening shift — schedule while you're at dinner; drafts wait for morning you. */}
      <div style={{ display: "flex", alignItems: "center", gap: "9px", flexWrap: "wrap" }}>
        <Switch on={!!shift.enabled} onClick={() => { wk.set({ eveningShift: { ...shift, enabled: !shift.enabled } }); bump(); }} />
        <span style={{ fontSize: "11.5px", fontWeight: 600, color: T.ink, flexShrink: 0 }}>Evening shift</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", opacity: shift.enabled ? 1 : 0.45 }}>
          <input type="time" value={shift.start} disabled={!shift.enabled} onChange={(e) => { wk.set({ eveningShift: { ...shift, start: e.target.value } }); bump(); }} style={timeStyle} />
          <span style={{ fontSize: "10px", color: T.faint }}>→</span>
          <input type="time" value={shift.end} disabled={!shift.enabled} onChange={(e) => { wk.set({ eveningShift: { ...shift, end: e.target.value } }); bump(); }} style={timeStyle} />
        </span>
      </div>

      {/* Task types — which skills the worker is allowed to exercise. Written as a
          full taskTypes object through wk.set (merge) so the dock never depends on
          a setTask helper existing in the parallel-built worker. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
        {TASK_TYPES.map(([k, label]) => {
          const on = ctrl.taskTypes[k] !== false;
          return (
            <button key={k} onClick={() => { wk.set({ taskTypes: { ...ctrl.taskTypes, [k]: !on } }); bump(); }}
              style={{ padding: "4px 10px", borderRadius: T.rPill, cursor: "pointer", fontSize: "10px", fontWeight: 700, fontFamily: T.fontDisplay, background: on ? T.goldSoft : "transparent", border: `1px solid ${on ? T.goldLine : T.line}`, color: on ? T.gold : T.faint }}>
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
      <div style={{ fontSize: "10px", color: T.muted, lineHeight: 1.5 }}>
        Runs while ZTS is open in a tab. Drafts land in your review queues — the worker never publishes.
      </div>

      {/* Work log — hover an entry and the canvas replays its activation trace. */}
      <div style={{ borderTop: `1px solid ${T.lineSoft}`, paddingTop: "10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "7px" }}>
          <span style={{ ...sectionLabel, fontSize: "9px" }}>Work log</span>
          <span style={{ fontFamily: T.fontMono, fontSize: "10px", color: T.faint }}>{tasksToday} task{tasksToday !== 1 ? "s" : ""} today</span>
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
                    <div style={{ fontSize: "9px", color: T.faint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.detail}</div>
                  ) : null}
                </div>
                <span style={{ fontSize: "8.5px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", fontFamily: T.fontDisplay, color: T.muted, background: "rgba(255,255,255,0.06)", borderRadius: T.rPill, padding: "1px 7px", flexShrink: 0 }}>{e.kind}</span>
                <span style={{ fontFamily: T.fontMono, fontSize: "9.5px", color: T.faint, flexShrink: 0 }}>{hhmm(e.ts)}</span>
                {e.cost > 0 && <span style={{ fontFamily: T.fontMono, fontSize: "9.5px", color: T.amber, flexShrink: 0 }}>${e.cost.toFixed(3)}</span>}
              </div>
            ))}
          </div>
        )}
        {log.length > 0 && (
          <button onClick={() => { try { worklog.clear(); } catch { /* store may not expose clear */ } bump(); toast.push("Work log cleared."); }}
            style={{ marginTop: "6px", background: "none", border: "none", color: T.faint, fontSize: "10px", cursor: "pointer", fontWeight: 600, padding: 0 }}>
            Clear log
          </button>
        )}
      </div>
    </div>
  );
}


// ─── The view ─────────────────────────────────────────────────────────────────
// Props flow per the contract (App.jsx passes creators/shorts/articles/
// onArticleDraft for symmetry); the WORKER that consumes them is <DnaWorker>,
// mounted at App root. The view itself only reads the compiled genome + the
// worker's stores.
export function DnaView({ creators, shorts, articles, onArticleDraft }) { // eslint-disable-line no-unused-vars
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
  const [level, setLevel] = useState("standing");           // compile lens (Pulse excerpt + compiled modal)

  // Worker-side stores (ctrl, log, suggestions) are localStorage JSON — read them
  // into state ONCE per poll tick / local mutation, never in the render body,
  // where every Pulse keystroke would pay the parse again.
  const readWorker = () => {
    let log; try { log = worklog.all() || []; } catch { log = []; }
    return { ctrl: readCtrl(), log, pending: pendingSuggestions() };
  };
  const [wkState, setWkState] = useState(readWorker);
  const bump = () => setWkState(readWorker());
  const fileRef = useRef(null);
  const replayRef = useRef({ id: null, ts: 0 });

  // Pulse state
  const [pq, setPq] = useState("");
  const [pulseRes, setPulseRes] = useState(null);           // { q, seedLabels, excerpt }
  const [thinking, setThinking] = useState(false);
  const [answer, setAnswer] = useState(null);

  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(max-width: 680px)").matches);

  // View CSS + breakpoint listener + 1.5s poll (the worker writes to its stores
  // from its own loop — same live-refresh cadence as AgentsView) + bus sub.
  useEffect(() => {
    const styleEl = document.createElement("style");
    styleEl.textContent = VIEW_CSS;
    document.head.appendChild(styleEl);
    const mq = window.matchMedia("(max-width: 680px)");
    const onMq = (e) => setMobile(e.matches);
    mq.addEventListener ? mq.addEventListener("change", onMq) : mq.addListener(onMq);
    const iv = setInterval(bump, 1500);
    return () => {
      styleEl.remove();
      mq.removeEventListener ? mq.removeEventListener("change", onMq) : mq.removeListener(onMq);
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // callback props must keep identity across the 1.5s poll re-renders.
  const genomeRef = useRef(genome);
  genomeRef.current = genome;

  // THE seam: every edit is CRUD → saveGenome (history + bus) → state. dna.js
  // refusals (locked delete, dupe edge…) return the same reference — a no-op.
  const apply = useCallback((next) => { if (next && next !== genomeRef.current) setGenome(saveGenome(next)); }, []);

  const { ctrl, log, pending } = wkState;
  const stats = genomeStats(genome);
  const compiled = useMemo(() => compileGenome(genome), [genome]);
  const tasksToday = useMemo(() => log.filter((e) => isToday(e.ts)).length, [log]);
  const levelLabel = (LEVELS.find(([v]) => v === level) || LEVELS[1])[1];

  // The compiled-mind text shown in the modal — Full is the verbatim worker
  // prompt; Primary/Standing are a lens rebuilt from the deterministic sections
  // (the worker still runs on the full prompt; Copy always grabs the full one).
  const filteredMind = useMemo(() => {
    if (level === "full") return compiled.systemPrompt;
    const parts = [ZTS_GOVERNANCE];
    compiled.sections.forEach((s) => {
      if (s.region === "tension") {
        if (level === "primary") return;                    // tensions are hushed at the loudest lens
        parts.push(`INTERNAL TENSIONS:\n${s.lines.map((l) => `- ${l}`).join("\n")}`);
        return;
      }
      const reg = REGIONS[s.region];
      if (!reg) return;
      const keep = levelLines(s.lines, level);
      if (keep.length) parts.push(`${reg.label.toUpperCase()} — ${reg.desc}:\n${keep.map((l) => `- ${l}`).join("\n")}`);
    });
    return parts.join("\n\n");
  }, [compiled, level]);

  const selNode = selection && selection.type === "node" ? genome.nodes.find((n) => n.id === selection.id) : null;
  const selEdge = selection && selection.type === "edge" ? genome.edges.find((e) => e.id === selection.id) : null;

  // Worker status line — ● idle/working, ◐ armed. "Current task" is inferred from
  // the freshest log entry (the worker runs serially, one task per pass).
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
  //    canvas re-renders only on real prop changes, never on the poll tick. ──
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
  // "＋ Node" plants near the mind's centre (identity is at world origin) with a
  // little scatter. The ZTS MindCanvas exposes no viewport-centre API, so origin
  // is the honest, always-visible home — the settling camera keeps it in frame.
  const growNode = () => {
    handleAddNodeAt({ x: Math.round((Math.random() - 0.5) * 220), y: Math.round((Math.random() - 0.5) * 220) });
  };

  const toggleRegion = (r) => setRegionFilter((prev) => {
    if (!prev) return new Set([r]);                          // from "all" → isolate the clicked region
    const next = new Set(prev);
    next.has(r) ? next.delete(r) : next.add(r);
    return next.size === 0 || next.size === Object.keys(REGIONS).length ? null : next;
  });

  // ── Work-log replay — re-propagate from the stored seeds so the wave is
  //    computed against the CURRENT genome (weights may have moved since). ──
  const replay = (entry) => {
    const seeds = entry && entry.trace && Array.isArray(entry.trace.seeds) ? entry.trace.seeds : null;
    if (!seeds || seeds.length === 0) return;
    const now = Date.now();
    // Throttle globally, not per entry: sweeping the cursor down the list must
    // not fire one propagate + canvas re-render per row crossed.
    if (now - replayRef.current.ts < (replayRef.current.id === entry.id ? 2600 : 700)) return;
    replayRef.current = { id: entry.id, ts: now };
    dnaBus.emit({ type: "activation", seeds, trace: propagate(genome, seeds), label: `Replay — ${entry.title}` });
  };

  // ── Pulse — keyword-match the query to nodes, fire the wave, and show the
  //    compiled lines of the regions it lit (filtered by the compile lens). The
  //    demo that the graph IS the prompt: what fires visually is what the worker
  //    reads verbatim. ──
  const firePulse = () => {
    const q = pq.trim();
    if (!q) return;
    const words = [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((wd) => wd.length > 2 && !STOP.has(wd)))];
    const scored = [];
    genome.nodes.forEach((n) => {
      if (n.enabled === false) return;
      const lab = n.label.toLowerCase(), txt = (n.text || "").toLowerCase();
      let s = 0;
      words.forEach((wd) => { if (lab.includes(wd)) s += 2; if (txt.includes(wd)) s += 1; });
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
      .flatMap((s) => levelLines(s.lines, level))
      .slice(0, 6);
    setPulseRes({ q, seedLabels: seeds.map((x) => x.label), excerpt });
    setAnswer(null);
  };

  const think = async () => {
    if (!pulseRes || thinking) return;
    setThinking(true);
    const sys = compiled.systemPrompt; // the compiled mind, verbatim — no side prompt
    const text = await callClaude({
      system: sys, messages: [{ role: "user", content: pulseRes.q }],
      model: "claude-haiku-4-5-20251001", maxTokens: 220, fn: "dna_pulse",
    });
    if (text) setAnswer(text.trim());
    else toast.push("The mind couldn't think it through — no answer.", { tone: "error" });
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
    a.download = `zts-dna-${genome.genome_key || "genome"}-${new Date().toISOString().slice(0, 10)}.json`;
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
      const next = { ...parsed, version: 1, genome_key: parsed.genome_key || "zts_core", mutations: Array.isArray(parsed.mutations) ? parsed.mutations : [] };
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
        style={{ width: "100%", display: "flex", alignItems: "center", gap: "8px", padding: "5px 7px", borderRadius: "8px", border: "none", background: "transparent", cursor: "pointer", opacity: active ? 1 : 0.38, transition: `opacity ${M.durBase} ${M.easeStd}` }}>
        <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: r.color, boxShadow: `0 0 6px ${r.color}66`, flexShrink: 0 }} />
        <span style={{ flex: 1, textAlign: "left", fontSize: "11px", fontWeight: 600, color: T.ink, fontFamily: T.fontDisplay }}>{r.label}</span>
        <span style={{ fontSize: "10px", fontFamily: T.fontMono, color: T.faint }}>{stats.byRegion[k] || 0}</span>
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
        style={{ ...GLASS, pointerEvents: "auto", borderRadius: T.rPill, border: `1px solid ${T.goldLine}`, padding: "6px 15px", color: T.inkBrand, fontFamily: T.fontDisplay, fontSize: "11px", fontWeight: 700, cursor: "pointer", boxShadow: `${T.shadowPopover}, ${T.glowBrass}`, whiteSpace: "nowrap" }}>
        🧠 The mind wants to grow — {pending.length} proposed {trayOpen ? "▴" : "▾"}
      </button>
      {trayOpen && (
        <div style={{ ...GLASS, pointerEvents: "auto", marginTop: "8px", width: mobile ? "calc(100vw - 24px)" : "430px", maxWidth: "calc(100vw - 24px)", maxHeight: "300px", overflowY: "auto", padding: "10px" }}>
          {pending.map((s) => (
            <div key={s.id} style={{ padding: "10px 12px", borderRadius: "10px", background: T.subtle, marginBottom: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                <span style={{ fontSize: "12px", fontWeight: 700, color: T.ink, fontFamily: T.fontDisplay }}>{s.label}</span>
                <span style={{ fontSize: "9px", fontWeight: 700, fontFamily: T.fontDisplay, color: (REGIONS[s.region] || REGIONS.knowledge).color, background: `${(REGIONS[s.region] || REGIONS.knowledge).color}14`, padding: "2px 8px", borderRadius: T.rPill, flexShrink: 0 }}>
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
      <div style={{ fontSize: "10px", color: workerActive ? T.green : T.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
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
          palette={ZTS_MIND_PALETTE}
          look={ZTS_MIND_LOOK}
          label="ZTS DNA — neural map"
          selection={selection}
          onSelect={setSelection}
          onNodeMove={handleNodeMove}
          onAddNode={handleAddNodeAt}
          onAddEdge={handleAddEdge}
          regionFilter={regionFilter}
          height="100%"
        />
      </div>

      {/* Top layer: header strip (+ legend/tray in-flow on mobile). The centre
          stays clear on purpose — the canvas floats its activation toast there. */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 6, pointerEvents: "none", display: "flex", flexDirection: "column", gap: "8px", padding: mobile ? "10px 12px 0" : "12px 16px 0" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "11px", pointerEvents: "auto" }}>
            <span aria-hidden style={{ display: "inline-flex", fontSize: "21px", lineHeight: 1, color: T.green, textShadow: "0 0 14px rgba(14,159,110,0.4)", animation: "dnaGlyph 9s ease-in-out infinite" }}>⌬</span>
            <div>
              <div style={{ fontSize: "16px", fontWeight: 800, color: T.inkDeep, fontFamily: T.fontDisplay, letterSpacing: "0.01em" }}>ZTS DNA</div>
              <div className="dna-sub" style={{ fontSize: "11px", color: T.muted, marginTop: "1px" }}>The living mind behind the machine — every node compiles into how it thinks.</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end", pointerEvents: "auto" }}>
            <Pill label="nodes" value={stats.nodes} title={`${stats.enabled} awake`} />
            <Pill label="synapses" value={stats.edges} />
            <Pill label="mind" value={`#${compiled.hash.slice(0, 6)}`} brass title="Hash of the compiled system prompt — changes when the mind does" />
            <Pill label="tasks" value={tasksToday} title="Worker tasks today" />
            <Pill label="fired" value={pulseCount} title="Activations this session" />
            <select value={level} onChange={(e) => setLevel(e.target.value)} title="Compile lens — how much of the mind to reveal (the worker always runs on the full prompt)"
              style={{ ...GLASS, borderRadius: T.rPill, padding: "4px 10px", fontSize: "10px", fontWeight: 700, fontFamily: T.fontMono, color: T.muted, cursor: "pointer", pointerEvents: "auto" }}>
              {LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button onClick={() => setPanel(panel === "pulse" ? null : "pulse")}
              style={{ ...GLASS, borderRadius: T.rPill, border: `1px solid ${T.goldLine}`, padding: "5px 13px", color: T.gold, fontFamily: T.fontDisplay, fontSize: "11px", fontWeight: 700, cursor: "pointer", pointerEvents: "auto" }}>
              ⚡ Pulse
            </button>
            <button onClick={() => setPanel(panel === "menu" ? null : "menu")} title="Mind menu" aria-label="Mind menu"
              style={{ ...GLASS, borderRadius: T.rPill, padding: "5px 12px", color: T.muted, fontSize: "13px", fontWeight: 700, cursor: "pointer", lineHeight: 1.2, pointerEvents: "auto" }}>
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
            <button onClick={growNode} style={{ ...GLASS, pointerEvents: "auto", flexShrink: 0, padding: "5px 11px", borderRadius: T.rPill, border: `1px solid ${T.goldLine}`, cursor: "pointer", color: T.gold, fontSize: "10.5px", fontWeight: 700, fontFamily: T.fontDisplay }}>＋ Node</button>
          </div>
        )}
        {mobile && suggestTray}
      </div>

      {/* Desktop: floating legend, top-left. */}
      {!mobile && (
        <div style={{ ...GLASS, position: "absolute", top: "76px", left: "14px", zIndex: 6, padding: "10px 10px 9px", width: "176px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "6px", padding: "0 7px" }}>
            <span style={{ ...sectionLabel, fontSize: "9px" }}>Regions</span>
            {regionFilter && (
              <button onClick={() => setRegionFilter(null)} style={{ background: "none", border: "none", color: T.gold, fontSize: "9.5px", fontWeight: 700, cursor: "pointer", padding: 0, fontFamily: T.fontDisplay }}>all</button>
            )}
          </div>
          {Object.keys(REGIONS).map(legendRow)}
          <div style={{ height: "1px", background: T.lineSoft, margin: "8px 0" }} />
          <button onClick={growNode}
            style={{ width: "100%", padding: "7px", background: T.goldSoft, border: `1px solid ${T.goldLine}`, borderRadius: "9px", color: T.gold, fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay }}>
            ＋ Node
          </button>
          <div style={{ fontSize: "9px", color: T.muted, lineHeight: 1.6, marginTop: "8px", padding: "0 2px" }}>
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

      {/* Pulse popover — ask the mind; watch it fire; read what compiled. Steps
          left of the inspector when it's open (select node → Pulse is THE demo
          flow) so it never buries the inspector's controls. */}
      {panel === "pulse" && (
        <div style={{ ...GLASS, position: "absolute", top: mobile ? "104px" : "58px", right: mobile ? "10px" : inspectorBody ? "346px" : "14px", left: mobile ? "10px" : "auto", width: mobile ? "auto" : "348px", zIndex: 30, padding: "13px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "9px" }}>
            <span style={{ ...sectionLabel, fontSize: "9px" }}>Pulse the mind</span>
            <button onClick={() => setPanel(null)} style={xBtn} aria-label="Close">×</button>
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            <input value={pq} onChange={(e) => setPq(e.target.value)} onKeyDown={(e) => e.key === "Enter" && firePulse()} placeholder="Ask the mind…"
              style={{ ...inputBase, padding: "8px 11px", fontSize: "12px" }} />
            <button onClick={firePulse}
              style={{ padding: "8px 14px", background: T.goldGrad, border: "none", borderRadius: T.rSm, color: T.textOnBrand, fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay, flexShrink: 0 }}>
              Fire
            </button>
          </div>
          {pulseRes && (
            <div style={{ marginTop: "11px" }}>
              <div style={{ fontSize: "10px", color: T.muted, lineHeight: 1.5 }}>
                ⚡ Fired <span style={{ color: T.inkBrand, fontWeight: 600 }}>{pulseRes.seedLabels.join(" · ")}</span>
              </div>
              {pulseRes.excerpt.length > 0 && (
                <div style={{ marginTop: "9px" }}>
                  <div style={{ ...sectionLabel, fontSize: "8.5px", marginBottom: "5px" }}>From the compiled mind · {levelLabel}</div>
                  <div style={{ maxHeight: "140px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "4px" }}>
                    {pulseRes.excerpt.map((l, i) => (
                      <div key={i} style={{ fontFamily: T.fontMono, fontSize: "10px", color: T.muted, lineHeight: 1.5, borderLeft: `2px solid ${T.goldLine}`, paddingLeft: "8px" }}>{l}</div>
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
        <ModalSheet mobile onClose={() => setSelection(null)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "14px 18px 0" }}>
            <span style={{ ...sectionLabel, fontSize: "9.5px" }}>{selNode ? "Node" : "Synapse"}</span>
            <button onClick={() => setSelection(null)} style={xBtn} aria-label="Close">×</button>
          </div>
          <div style={{ overflowY: "auto", padding: "12px 18px 18px" }}>{inspectorBody}</div>
        </ModalSheet>
      ) : (
        <div style={{ ...GLASS, position: "absolute", top: "76px", right: "14px", width: "320px", maxHeight: "calc(100% - 100px)", zIndex: 9, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "12px 14px 0", flexShrink: 0 }}>
            <span style={{ ...sectionLabel, fontSize: "9.5px" }}>{selNode ? "Node" : "Synapse"}</span>
            <button onClick={() => setSelection(null)} style={xBtn} aria-label="Close inspector">×</button>
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
            <ModalSheet mobile onClose={() => setDockSheet(false)}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "12px 16px 10px" }}>
                {playBtn}
                {dockStatus}
                <button onClick={() => setDockSheet(false)} style={xBtn} aria-label="Close">×</button>
              </div>
              <div style={{ overflowY: "auto" }}>
                <DockBody ctrl={ctrl} log={log} tasksToday={tasksToday} bump={bump} replay={replay} toast={toast} />
              </div>
            </ModalSheet>
          )}
        </>
      ) : (
        // Capped so an expanded dock with a full log scrolls INSIDE itself on short
        // viewports instead of climbing over the region legend and blocking it.
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

      {/* Compiled-mind modal — the deterministic artifact. Full is the verbatim
          worker prompt; the lens rebuilds a filtered view (Copy always grabs the
          full prompt). */}
      {modal === "compiled" && (
        <ModalSheet mobile={mobile} onClose={() => setModal(null)} width={720}>
          <div style={{ padding: "18px 22px 14px", borderBottom: `1px solid ${T.lineInk}`, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexShrink: 0 }}>
            <div>
              <div style={{ fontSize: "15px", fontWeight: 700, color: T.ink, fontFamily: T.fontDisplay }}>Compiled mind</div>
              <div style={{ fontSize: "10.5px", color: T.faint, marginTop: "3px", fontFamily: T.fontMono }}>
                {level === "full"
                  ? `#${compiled.hash} · ${compiled.systemPrompt.length.toLocaleString()} chars — this exact string is the worker's system prompt`
                  : `Lens: ${levelLabel} · the worker runs on the full compiled mind — Copy grabs the full ${compiled.systemPrompt.length.toLocaleString()}-char prompt`}
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
              <button onClick={copyMind}
                style={{ padding: "6px 13px", background: T.goldSoft, border: `1px solid ${T.goldLine}`, borderRadius: "8px", color: T.gold, fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: T.fontDisplay }}>
                ⧉ Copy
              </button>
              <button onClick={() => setModal(null)} style={{ ...xBtn, fontSize: "20px" }} aria-label="Close">×</button>
            </div>
          </div>
          <div style={{ overflowY: "auto", padding: "16px 22px" }}>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: T.fontMono, fontSize: "11px", lineHeight: 1.7, color: T.muted }}>{filteredMind}</pre>
          </div>
        </ModalSheet>
      )}

      {/* Mutation history — every change the mind has lived through. */}
      {modal === "history" && (
        <ModalSheet mobile={mobile} onClose={() => setModal(null)} width={400} side="right">
          <div style={{ padding: "18px 20px 12px", borderBottom: `1px solid ${T.lineInk}`, display: "flex", alignItems: "baseline", justifyContent: "space-between", flexShrink: 0 }}>
            <div>
              <div style={{ fontSize: "15px", fontWeight: 700, color: T.ink, fontFamily: T.fontDisplay }}>Mutation history</div>
              <div style={{ fontSize: "10.5px", color: T.faint, marginTop: "2px" }}>{(genome.mutations || []).length} recorded · newest first · capped at 200</div>
            </div>
            <button onClick={() => setModal(null)} style={{ ...xBtn, fontSize: "20px" }} aria-label="Close">×</button>
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
                      <div style={{ fontSize: "9px", color: T.faint, marginTop: "3px", fontFamily: T.fontMono }}>{m.kind} · {new Date(m.ts).toLocaleString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ModalSheet>
      )}
    </div>
  );
}
