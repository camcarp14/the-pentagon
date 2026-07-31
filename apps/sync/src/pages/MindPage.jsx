import { useMemo, useRef, useState } from "react";
import {
  REGIONS, REGION_ORDER, compileMind, mindStats,
  updateNode, updateEdge, addNode, removeNode, addEdge, removeEdge,
} from "@cc/mind";
import { MindCanvas } from "@cc/mind-canvas";
import { useSyncMindPalette } from "../mind/palette.js";
import { getMind, setMind, resetMind } from "../data/store.js";
import { useStore } from "../data/useStore.js";
import {
  Segmented, Field, TextArea, Button, Switch, Sheet, StatTile, useToast, useConfirm,
} from "../ui/kit.jsx";
import { IcTrash, IcAlert } from "../ui/icons.jsx";

// ─── Mind ────────────────────────────────────────────────────────────────────
// The same living canvas ZTS and Clarify have, over SYNC's genome.
//
// It is not a picture of the system prompt — it IS the system prompt.
// buildSystem() compiles this graph every turn, so silencing "Push back when the
// plan is bad" makes SYNC stop doing it on the next thing you say, with no
// deploy. Every neuron started as a line in a string literal only a developer
// could reach.
//
// The canvas is the page; the inspector floats over it as a sheet, because on a
// phone a side panel and a force-directed graph cannot both have the width they
// need. Everything below routes edits through @cc/mind's pure helpers, so the
// genome is validated on every write rather than trusted.

const BANDS = [
  [0.75, "primary"],
  [0.4, "standing"],
  [0, "minor"],
];
const band = (w) => (BANDS.find(([min]) => w >= min) || BANDS[2])[1];

export default function MindPage({ setPage }) {
  useStore();                                   // re-render when the genome changes
  // The canvas takes finished colours; SYNC's depend on whether it is standing
  // alone (Obsidian) or inside the Pentagon shell, so they are resolved against
  // this element after mount rather than read from a module constant.
  const stageRef = useRef(null);
  const palette = useSyncMindPalette(stageRef);
  const toast = useToast();
  const [confirmEl, confirm] = useConfirm();

  const [selection, setSelection] = useState(null);
  const [filter, setFilter] = useState(null);   // Set<region> | null
  const [draft, setDraft] = useState(null);     // {x, y} while adding
  const [showPrompt, setShowPrompt] = useState(false);

  const mind = getMind();
  const stats = useMemo(() => mindStats(mind), [mind]);
  const compiled = useMemo(() => compileMind(mind, { domain: "sync" }), [mind]);

  const node = selection?.type === "node" ? mind.nodes.find((n) => n.id === selection.id) : null;
  const edge = selection?.type === "edge" ? mind.edges.find((e) => e.id === selection.id) : null;

  const patch = (id, p) => setMind(updateNode(mind, id, p, { at: Date.now() }));

  const removeSelected = async () => {
    const label = node ? node.label : "this synapse";
    const ok = await confirm({
      title: `Remove ${node ? `"${label}"` : "this synapse"}?`,
      message: node
        ? "It stops shaping what SYNC says from the next turn. Reset brings back the originals, but not anything you wrote yourself."
        : "The two neurons stay; only the tension between them goes.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setMind(node
      ? removeNode(mind, node.id, { at: Date.now() })
      : removeEdge(mind, edge.id, { at: Date.now() }));
    setSelection(null);
    toast("Removed");
  };

  const create = () => {
    const label = draft?.label?.trim();
    const text = draft?.text?.trim();
    if (!label || !text) { toast("A neuron needs a name and a belief", { err: true }); return; }
    const next = addNode(mind, {
      label, text,
      region: draft.region || "principle",
      domains: ["sync"],
      weight: 0.6,
      x: draft.x || 0,
      y: draft.y || 0,
      at: Date.now(),
    });
    setMind(next);
    setDraft(null);
    toast("Neuron added — it's in the prompt already");
  };

  const doReset = async () => {
    const ok = await confirm({
      title: "Reset the mind?",
      message: "Every weight, silence, position and edit goes back to how SYNC shipped. Neurons you wrote yourself are lost.",
      confirmLabel: "Reset",
      destructive: true,
    });
    if (!ok) return;
    resetMind();
    setSelection(null);
    toast("Mind reset to seed");
  };

  return (
    <>
      {confirmEl}

      {/* The canvas IS the page. Everything else floats. */}
      <div className="mind-stage" ref={stageRef}>
        <MindCanvas
          genome={mind}
          palette={palette}
          label="SYNC — neural map"
          selection={selection}
          onSelect={setSelection}
          onNodeMove={(id, x, y) => patch(id, { x, y })}
          onAddNode={({ x, y }) => setDraft({ label: "", text: "", region: "principle", x, y })}
          onAddEdge={({ from, to }) => {
            setMind(addEdge(mind, { from, to, weight: 0.6, polarity: 1, at: Date.now() }));
            toast("Synapse added — reinforcing. Tap it to make it a tension.");
          }}
          regionFilter={filter}
          height="100%"
        />

        <div className="mind-hud">
          <div className="mind-hud-stats">
            <StatTile value={stats.nodes} label="neurons" onCanvas />
            <StatTile value={stats.edges} label="synapses" onCanvas />
            <StatTile value={`${(compiled.systemPrompt.length / 1000).toFixed(1)}k`} label="prompt" onCanvas />
          </div>
          <div className="mind-hud-row">
            <Button kind="quiet" size="sm" onClick={() => setShowPrompt(true)}>Prompt</Button>
            {/* Memory lost its dock slot to this page, but the facts, notes and
                action ledger in it are the operator's data — so the way in moved
                here rather than disappearing. */}
            {setPage && <Button kind="quiet" size="sm" onClick={() => setPage("memory")}>Knows</Button>}
            <Button kind="quiet" size="sm" onClick={doReset}>Reset</Button>
          </div>
        </div>

        {/* Region legend doubles as the filter — tap a region to isolate it. */}
        <div className="mind-legend">
          {REGION_ORDER.map((r) => {
            const on = !filter || filter.has(r);
            const count = mind.nodes.filter((n) => n.region === r).length;
            if (!count) return null;
            return (
              <button
                key={r}
                type="button"
                className={on ? "mind-chip on" : "mind-chip"}
                onClick={() => {
                  // Tapping the only-visible region clears the filter; otherwise
                  // it isolates. One control, both directions, no reset button.
                  if (filter && filter.size === 1 && filter.has(r)) setFilter(null);
                  else setFilter(new Set([r]));
                }}
              >
                <span className="dotstatus" style={{ background: REGIONS[r].tint }} />
                {REGIONS[r].label}
                <span className="mind-chip-n">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── the inspector ─────────────────────────────────────────────── */}
      {node && (
        <Sheet onClose={() => setSelection(null)} title={node.label}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="mind-insp-head">
              <span className="dotstatus" style={{ background: REGIONS[node.region].tint }} />
              <span className="t-label">{REGIONS[node.region].label}</span>
              {/* .t-label is the one route to uppercase in this language, and
                  it is the kit's. This chip used to roll its own 9.5px caps —
                  under the 10.5px floor, and doing by hand what .t-label does. */}
              {node.locked && <span className="t-label neuron-lock">locked</span>}
              <span style={{ marginLeft: "auto" }}>
                <Switch
                  on={node.enabled !== false}
                  onToggle={() => patch(node.id, { enabled: node.enabled === false })}
                  disabled={node.locked}
                  label="Active"
                />
              </span>
            </div>

            <TextArea
              value={node.text}
              rows={6}
              onChange={(e) => patch(node.id, { text: e.target.value })}
              aria-label="What this neuron believes"
            />

            <div>
              <div className="t-label" style={{ marginBottom: 6 }}>
                Weight · {node.weight.toFixed(2)}
                <span className="neuron-band">{band(node.weight)}</span>
              </div>
              <input
                type="range" min="0.05" max="1" step="0.05"
                value={node.weight}
                onChange={(e) => patch(node.id, { weight: Number(e.target.value) })}
                aria-label="Weight"
                style={{ width: "100%" }}
              />
              <div className="t-foot" style={{ marginTop: 6 }}>
                Weight is emphasis, not truth. It decides how the belief is announced
                in the prompt and which ones survive a partial read.
              </div>
            </div>

            <Segmented
              options={REGION_ORDER.map((r) => ({ key: r, label: REGIONS[r].label }))}
              value={node.region}
              onChange={(r) => patch(node.id, { region: r })}
            />

            {node.locked ? (
              <div className="t-foot">
                Locked. This one holds the line on honesty or reversibility — changing it
                is a code change with a diff, not a slider at seven in the morning.
              </div>
            ) : (
              <Button kind="quiet" size="md" onClick={removeSelected}>
                <IcTrash size={15} /> Remove neuron
              </Button>
            )}
          </div>
        </Sheet>
      )}

      {edge && (() => {
        const from = mind.nodes.find((n) => n.id === edge.from);
        const to = mind.nodes.find((n) => n.id === edge.to);
        if (!from || !to) return null;
        return (
          <Sheet onClose={() => setSelection(null)} title="Synapse">
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="t-body">
                <strong>{from.label}</strong>{" "}
                {edge.polarity < 0 ? "outranks" : "reinforces"}{" "}
                <strong>{to.label}</strong>
              </div>
              <Segmented
                options={[
                  { key: "1", label: "Reinforces" },
                  { key: "-1", label: "Outranks" },
                ]}
                value={String(edge.polarity < 0 ? -1 : 1)}
                onChange={(v) => setMind(updateEdge(mind, edge.id, { polarity: Number(v) }, { at: Date.now() }))}
              />
              <div className="t-foot">
                A tension — "outranks" — is the useful half of holding beliefs in a
                graph: it says which one loses when they disagree, and it compiles into
                the prompt as a sentence saying so.
              </div>
              <div>
                <div className="t-label" style={{ marginBottom: 6 }}>Strength · {edge.weight.toFixed(2)}</div>
                <input
                  type="range" min="0.05" max="1" step="0.05"
                  value={edge.weight}
                  onChange={(e) => setMind(updateEdge(mind, edge.id, { weight: Number(e.target.value) }, { at: Date.now() }))}
                  aria-label="Synapse strength"
                  style={{ width: "100%" }}
                />
              </div>
              <Button kind="quiet" size="md" onClick={removeSelected}>
                <IcTrash size={15} /> Remove synapse
              </Button>
            </div>
          </Sheet>
        );
      })()}

      {/* ── adding a neuron ───────────────────────────────────────────── */}
      {draft && (
        <Sheet onClose={() => setDraft(null)} title="New neuron">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field
              placeholder="Name it — e.g. Never book over lunch"
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
            <TextArea
              rows={4}
              placeholder="Write the belief the way you'd say it to a new assistant on their first morning."
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
            <Segmented
              options={REGION_ORDER.map((r) => ({ key: r, label: REGIONS[r].label }))}
              value={draft.region}
              onChange={(r) => setDraft({ ...draft, region: r })}
            />
            <Button kind="primary" size="lg" full onClick={create}>Add to the mind</Button>
          </div>
        </Sheet>
      )}

      {/* ── the compiled prompt ───────────────────────────────────────── */}
      {showPrompt && (
        <Sheet onClose={() => setShowPrompt(false)} title="What SYNC is told">
          <div className="t-foot" style={{ marginBottom: 10 }}>
            Exactly this, every turn, before the live context. Compiled from the canvas —
            move a weight and this changes.
          </div>
          <pre className="mind-prompt">{compiled.systemPrompt}</pre>
          <div className="act" style={{ marginTop: 12 }}>
            <span className="act-ic" style={{ color: "var(--amber)" }}><IcAlert size={15} /></span>
            <span className="act-body">
              <span className="act-detail">
                The charter at the top is not a neuron and cannot be edited here. It is
                what stops SYNC claiming it did something it did not, and what keeps
                anything irreversible behind a yes — the two things an operator should
                not be able to weaken by dragging a slider.
              </span>
            </span>
          </div>
        </Sheet>
      )}
    </>
  );
}
