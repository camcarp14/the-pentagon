import { useEffect, useMemo, useState } from "react";
import { MindCanvas, PALETTE_DEFAULTS, REGION_KEYS } from "@cc/mind-canvas";
import { appMeta } from "@cc/design";

// ─── One screen, every mind ──────────────────────────────────────────────────
//
// Three tools each grew a mind, and each grew its own screen to edit it: ZTS's
// DNA tab, Clarify's DNA tab, SYNC's Mind tab. Same graph, same six regions,
// three places to go and three sets of controls to relearn. This is the one
// screen, and it lives in System because a mind is a setting — it is what a
// tool believes, not something you do inside the tool.
//
// WHAT THIS DELIBERATELY IS NOT: a merge. Each mind stays in its own storage,
// in its own shape, read and written exactly as its own app reads and writes it.
// Nothing is migrated, so nothing can be lost. That matters more than it might
// sound: ZTS's and Clarify's loadGenome SILENTLY RE-SEED on any validation
// failure — no toast, no backup — so a genome this screen wrote in a shape their
// validator rejects would be destroyed on their next boot, taking every neuron
// the operator had tuned with it.
//
// The defence is to make an invalid write impossible by construction rather than
// by care. This screen edits three fields and no others:
//
//   · weight   — a number it clamps to 0.05–1
//   · enabled  — a boolean
//   · text     — a string
//
// It never adds a node, never removes one, never touches an id, a region, an
// edge or a position. Every other field is carried through untouched. A genome
// that was valid going in is valid coming out, whatever is typed here.
//
// Adding and removing neurons stays where the graph is authored. That is the
// honest split: this screen is for tuning what a mind believes and how loudly,
// which is the thing you actually want to do across three tools at once.

const SOURCES = [
  // key            label      where it lives                       shape
  { app: "zts", read: () => lsGet("zts_dna_genome"), write: (g) => lsSet("zts_dna_genome", stampISO(g)) },
  { app: "clarify", read: () => lsGet("sm_dna_genome"), write: (g) => lsSet("sm_dna_genome", stampISO(g)) },
  {
    app: "sync",
    // SYNC keeps its mind inside one state document rather than its own key, so
    // it is read and written through that document and never around it.
    read: () => lsGet("sync.state.v1")?.mind || null,
    write: (g) => {
      const doc = lsGet("sync.state.v1");
      if (!doc || typeof doc !== "object") return false;
      return lsSet("sync.state.v1", { ...doc, mind: g });
    },
  },
];

function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
/** ZTS and Clarify both stamp an ISO updated_at on save; match them exactly. */
function stampISO(g) {
  return { ...g, updated_at: new Date().toISOString() };
}

const isGenome = (g) => !!g && Array.isArray(g.nodes) && g.nodes.length > 0;

/** A canvas palette for a tool, from its accent. No cross-app imports: the shell
 *  should not reach into apps/zts/src to find out what colour ZTS is. */
function paletteFor(app) {
  const accent = appMeta(app).accent;
  return {
    ...PALETTE_DEFAULTS,
    synapse: accent, synapseHi: accent,
    select: accent, selectHi: accent,
    glow: `0 0 24px ${accent}33`,
    region: Object.fromEntries(REGION_KEYS.map((k) => [k, PALETTE_DEFAULTS.region?.[k] || accent])),
  };
}

const clampWeight = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0.05, n)) : 0.5;
};

/**
 * Apply one field change to one node. Pure, and the only way this screen edits
 * anything — which is what makes "a valid genome stays valid" a property of the
 * code rather than a promise in a comment.
 */
export function patchNode(genome, id, patch) {
  if (!isGenome(genome)) return genome;
  let hit = false;
  const nodes = genome.nodes.map((n) => {
    if (n.id !== id) return n;
    hit = true;
    const next = { ...n };
    if ("weight" in patch) next.weight = clampWeight(patch.weight);
    if ("enabled" in patch) next.enabled = !!patch.enabled;
    if ("text" in patch) next.text = String(patch.text ?? "");
    return next;
  });
  return hit ? { ...genome, nodes } : genome;
}

export default function Minds({ isMobile }) {
  const found = useMemo(() => SOURCES.map((s) => ({ ...s, genome: s.read() })).filter((s) => isGenome(s.genome)), []);
  const [app, setApp] = useState(() => found[0]?.app);
  const [genomes, setGenomes] = useState(() => Object.fromEntries(found.map((s) => [s.app, s.genome])));
  const [selected, setSelected] = useState(null);
  const [saved, setSaved] = useState(null);

  const source = found.find((s) => s.app === app);
  const genome = genomes[app];
  const palette = useMemo(() => (app ? paletteFor(app) : null), [app]);
  const node = selected?.type === "node" && genome ? genome.nodes.find((n) => n.id === selected.id) : null;

  // A save confirmation that clears itself. Silence after a write reads exactly
  // like a write that did not happen.
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), 2200);
    return () => clearTimeout(t);
  }, [saved]);

  const edit = (patch) => {
    if (!node || !source) return;
    const next = patchNode(genome, node.id, patch);
    setGenomes((g) => ({ ...g, [app]: next }));
    setSaved(source.write(next) ? "Saved" : "Could not save");
  };

  if (!found.length) {
    return (
      <div className="t-body" style={{ color: "var(--sub)", padding: "28px 4px" }}>
        No minds on this device yet. Open ZTS, Clarify or SYNC once and their mind seeds itself.
      </div>
    );
  }

  return (
    <div data-kit>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div className="seg" role="tablist" aria-label="Which mind">
          {found.map((s) => (
            <button key={s.app} type="button" role="tab" aria-selected={s.app === app}
              className={s.app === app ? "seg-opt active" : "seg-opt"}
              onClick={() => { setApp(s.app); setSelected(null); }}>
              {appMeta(s.app).label}
            </button>
          ))}
        </div>
        <span className="t-foot" style={{ color: "var(--faint)" }}>
          {genome ? `${genome.nodes.length} neurons · ${Array.isArray(genome.edges) ? genome.edges.length : 0} synapses` : ""}
        </span>
        {saved && <span className="t-cap" style={{ color: saved === "Saved" ? "var(--accent)" : "var(--red)" }}>{saved}</span>}
      </div>

      <div style={{ position: "relative", borderRadius: 18, overflow: "hidden", background: "var(--surface)" }}>
        <MindCanvas
          key={app}
          genome={genome}
          palette={palette}
          label={`${appMeta(app).label} — neural map`}
          selection={selected}
          onSelect={setSelected}
          height={isMobile ? "58vh" : "62vh"}
          toastTop={16}
        />
      </div>

      {node && (
        <div className="card pad-md" style={{ marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <span className="t-head" style={{ flex: 1, minWidth: 0 }}>{node.label}</span>
            <label className="t-cap" style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--sub)" }}>
              <input type="checkbox" checked={node.enabled !== false} onChange={(e) => edit({ enabled: e.target.checked })} />
              Active
            </label>
          </div>

          <div className="t-label" style={{ marginBottom: 6 }}>Weight · {clampWeight(node.weight).toFixed(2)}</div>
          <input type="range" min="0.05" max="1" step="0.05" style={{ width: "100%" }}
            value={clampWeight(node.weight)} aria-label="Weight"
            onChange={(e) => edit({ weight: e.target.value })} />

          <textarea className="field" rows={5} style={{ marginTop: 10 }} value={node.text || ""}
            aria-label="What this neuron believes"
            onChange={(e) => edit({ text: e.target.value })} />

          <div className="t-foot" style={{ color: "var(--faint)", marginTop: 8 }}>
            Weight is emphasis, not truth — it decides how loudly this is said in
            the prompt. Adding and removing neurons stays in the tool itself.
          </div>
        </div>
      )}
    </div>
  );
}
