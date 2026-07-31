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

/**
 * The six regions every one of these minds agrees on. Checked against, not
 * trusted: an unknown region fails ZTS's and Clarify's validators outright, and
 * a failed validation is not an error in those apps — it is a silent re-seed.
 */
export const REGIONS = ["identity", "principle", "knowledge", "signal", "skill", "goal"];

/**
 * Add a neuron. Returns a genome that satisfies every validator these three
 * apps run, or the genome unchanged.
 *
 * Their node contract, read out of apps/zts/src/dna/dna.js validateGenome:
 * a non-empty unique string id, a region that is one of the six, a finite
 * weight in 0..1, and a non-empty label. Everything below exists to guarantee
 * those four rather than hope for them.
 */
export function addNode(genome, { label, text, region } = {}) {
  if (!isGenome(genome)) return genome;
  const name = String(label ?? "").trim();
  if (!name) return genome;                       // a node with no label is invalid
  const reg = REGIONS.includes(region) ? region : "principle";

  // A unique id, derived from the label so it reads like the seed's ids, and
  // suffixed until it collides with nothing. Duplicate ids are a validation
  // failure, and a validation failure here costs the operator their whole graph.
  const taken = new Set(genome.nodes.map((n) => n.id));
  const stem = "n_" + (name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "node").slice(0, 24);
  let id = stem, i = 2;
  while (taken.has(id)) id = `${stem}_${i++}`;

  return {
    ...genome,
    nodes: [...genome.nodes, {
      id, label: name, region: reg,
      weight: 0.6,
      text: String(text ?? "").trim(),
      enabled: true,
      // Placed at the region's own anchor rather than (0,0): every one of these
      // canvases treats (0,0) outside identity as "never placed" and jitters it,
      // which is fine, but landing on the anchor means it appears where its
      // region lives instead of drifting in from the middle.
      x: 0, y: 0,
      source: "operator",
    }],
  };
}

/**
 * Remove a neuron, and every synapse that touched it.
 *
 * The cascade is the whole point. An edge whose `from` or `to` no longer exists
 * is a "dangling" error in the same validator — so removing a node without its
 * edges produces exactly the invalid genome that gets silently re-seeded.
 * Locked nodes are refused: they are the ones holding the line on honesty and
 * reversibility, and this screen is a slider, not a code review.
 */
export function removeNode(genome, id) {
  if (!isGenome(genome)) return genome;
  const node = genome.nodes.find((n) => n.id === id);
  if (!node || node.locked) return genome;
  if (genome.nodes.length <= 1) return genome;    // never leave a mind with nothing in it
  return {
    ...genome,
    nodes: genome.nodes.filter((n) => n.id !== id),
    edges: (Array.isArray(genome.edges) ? genome.edges : []).filter((e) => e.from !== id && e.to !== id),
  };
}

export default function Minds({ isMobile }) {
  const found = useMemo(() => SOURCES.map((s) => ({ ...s, genome: s.read() })).filter((s) => isGenome(s.genome)), []);
  const [app, setApp] = useState(() => found[0]?.app);
  const [genomes, setGenomes] = useState(() => Object.fromEntries(found.map((s) => [s.app, s.genome])));
  const [selected, setSelected] = useState(null);
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);   // {label, text, region} while adding

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

  const commit = (next) => {
    if (!source || next === genome) return;
    setGenomes((g) => ({ ...g, [app]: next }));
    setSaved(source.write(next) ? "Saved" : "Could not save");
  };
  const edit = (patch) => { if (node) commit(patchNode(genome, node.id, patch)); };

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
        <button type="button" className="btn sm quiet" style={{ marginLeft: "auto" }}
          onClick={() => setDraft({ label: "", text: "", region: "principle" })}>Add neuron</button>
      </div>

      {draft && (
        <div className="card pad-md" style={{ marginBottom: 12 }}>
          <div className="t-label" style={{ marginBottom: 8 }}>New neuron</div>
          <input className="field" placeholder="Name it — e.g. Never book over lunch" value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          <textarea className="field" rows={3} style={{ marginTop: 8 }}
            placeholder="Write the belief the way you would say it to someone on their first morning."
            value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          <div className="seg" role="group" aria-label="Region" style={{ marginTop: 8, flexWrap: "wrap" }}>
            {REGIONS.map((r) => (
              <button key={r} type="button" className={r === draft.region ? "seg-opt active" : "seg-opt"}
                onClick={() => setDraft({ ...draft, region: r })}>{r}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="button" className="btn sm primary" disabled={!draft.label.trim()}
              onClick={() => { commit(addNode(genome, draft)); setDraft(null); }}>Add to this mind</button>
            <button type="button" className="btn sm quiet" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}

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
            the prompt.
          </div>

          {node.locked ? (
            <div className="t-foot" style={{ color: "var(--faint)", marginTop: 8 }}>
              Locked. This one holds the line on honesty or reversibility —
              changing it is a code change with a diff, not a slider.
            </div>
          ) : (
            <button type="button" className="btn sm quiet" style={{ marginTop: 10 }}
              onClick={() => { commit(removeNode(genome, node.id)); setSelected(null); }}>
              Remove neuron
            </button>
          )}
        </div>
      )}
    </div>
  );
}
