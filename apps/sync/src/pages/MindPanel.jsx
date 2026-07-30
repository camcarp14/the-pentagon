import { useMemo, useState } from "react";
import {
  REGIONS, REGION_ORDER, compileMind, mindStats,
  updateNode, addNode, removeNode,
} from "@cc/mind";
import { getMind, setMind, resetMind } from "../data/store.js";
import { useStore } from "../data/useStore.js";
import {
  Segmented, Field, TextArea, Button, Switch, SectionHeader, StatTile, useToast, useConfirm,
} from "../ui/kit.jsx";
import { IcPlus, IcTrash, IcAlert } from "../ui/icons.jsx";

// ─── The mind ────────────────────────────────────────────────────────────────
// SYNC's doctrine, editable.
//
// This is not a visualisation of the system prompt — it IS the system prompt.
// buildSystem() compiles this graph every turn, so silencing "Push back when the
// plan is bad" makes SYNC stop doing it on the next thing you say, with no
// deploy. Every neuron here started as a line in a string literal that only a
// developer could reach.
//
// Deliberately a list and not the force-directed canvas the other tools use.
// SYNC is phone-first and driven by voice; a canvas you pinch-zoom to read is the
// wrong shape for the one surface this is used from. The graph is still a graph —
// the synapses are shown as tensions, which is the part of a graph that actually
// changes the prompt.

function Neuron({ node, onPatch, onDelete, accent }) {
  const [open, setOpen] = useState(false);
  const tint = REGIONS[node.region]?.tint || "#A9B2C4";

  return (
    <div className={node.enabled === false ? "neuron off" : "neuron"}>
      <div className="neuron-head">
        <span className="neuron-dot" style={{ background: node.enabled === false ? "var(--faint)" : tint }} />
        <button type="button" className="neuron-label" onClick={() => setOpen((v) => !v)}>
          {node.label}
          {node.locked && <span className="neuron-lock" title="Locked — a code change, not a slider">locked</span>}
        </button>
        <span className="neuron-weight">{Math.round(node.weight * 100)}</span>
        <Switch
          on={node.enabled !== false}
          onToggle={() => onPatch({ enabled: node.enabled === false })}
          small
          disabled={node.locked}
          label={`${node.label} active`}
        />
      </div>

      {open && (
        <div className="neuron-body">
          <TextArea
            value={node.text}
            rows={4}
            onChange={(e) => onPatch({ text: e.target.value })}
            aria-label={`${node.label} text`}
          />
          <div className="neuron-tools">
            <div style={{ flex: 1 }}>
              <div className="t-label" style={{ marginBottom: 5 }}>
                Weight · {node.weight.toFixed(2)}
                <span className="neuron-band">
                  {node.weight >= 0.75 ? "primary" : node.weight >= 0.4 ? "standing" : "minor"}
                </span>
              </div>
              <input
                type="range" min="0.05" max="1" step="0.05"
                value={node.weight}
                onChange={(e) => onPatch({ weight: Number(e.target.value) })}
                aria-label={`${node.label} weight`}
                style={{ width: "100%", accentColor: accent }}
              />
            </div>
            {!node.locked && (
              <Button kind="quiet" size="sm" onClick={onDelete} title="Remove this neuron">
                <IcTrash size={14} />
              </Button>
            )}
          </div>
          {node.locked && (
            <div className="t-foot" style={{ marginTop: 8 }}>
              Locked. This one holds the line on honesty or reversibility — changing it
              is a code change with a diff, not a slider at seven in the morning.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function MindPanel({ accent = "#C36BFF" }) {
  useStore();                                  // re-render when the genome changes
  const toast = useToast();
  const [confirmEl, confirm] = useConfirm();
  const [view, setView] = useState("neurons");
  const [draft, setDraft] = useState(null);

  const mind = getMind();
  const stats = useMemo(() => mindStats(mind), [mind]);
  const compiled = useMemo(() => compileMind(mind, { domain: "sync" }), [mind]);

  const patch = (id, p) => setMind(updateNode(mind, id, p, { at: Date.now() }));

  const remove = async (node) => {
    const ok = await confirm({
      title: `Remove "${node.label}"?`,
      message: "It stops shaping what SYNC says from the next turn. Reset to seed brings back the originals, but not anything you wrote yourself.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setMind(removeNode(mind, node.id, { at: Date.now() }));
    toast("Neuron removed");
  };

  const create = () => {
    const label = draft?.label?.trim();
    const text = draft?.text?.trim();
    if (!label || !text) { toast("A neuron needs a name and a belief", { err: true }); return; }
    setMind(addNode(mind, {
      label, text,
      region: draft.region || "principle",
      domains: ["sync"],
      weight: 0.6,
      at: Date.now(),
    }));
    setDraft(null);
    toast("Neuron added — it's in the prompt already");
  };

  const doReset = async () => {
    const ok = await confirm({
      title: "Reset the mind?",
      message: "Every weight, silence and edit goes back to how SYNC shipped. Neurons you wrote yourself are lost.",
      confirmLabel: "Reset",
      destructive: true,
    });
    if (!ok) return;
    resetMind();
    toast("Mind reset to seed");
  };

  const byRegion = REGION_ORDER
    .map((r) => ({ region: r, nodes: mind.nodes.filter((n) => n.region === r) }))
    .filter((g) => g.nodes.length);

  return (
    <>
      {confirmEl}

      <div className="stats-3" style={{ marginBottom: 12 }}>
        <StatTile value={stats.nodes} label="neurons" />
        <StatTile value={stats.edges} label="synapses" />
        <StatTile value={`${(compiled.systemPrompt.length / 1000).toFixed(1)}k`} label="prompt chars" />
      </div>

      <Segmented
        options={[
          { key: "neurons", label: "Neurons", sub: String(stats.nodes) },
          { key: "tensions", label: "Tensions", sub: String(stats.edges) },
          { key: "prompt", label: "Prompt" },
        ]}
        value={view}
        onChange={setView}
        style={{ marginBottom: 14 }}
      />

      <div className="pagefade" key={view}>
        {view === "neurons" && (
          <>
            {byRegion.map(({ region, nodes }) => (
              <div key={region} style={{ marginBottom: 6 }}>
                <SectionHeader title={REGIONS[region].label} trailing={REGIONS[region].desc} />
                {nodes
                  .slice()
                  .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1))
                  .map((n) => (
                    <Neuron
                      key={n.id}
                      node={n}
                      accent={accent}
                      onPatch={(p) => patch(n.id, p)}
                      onDelete={() => remove(n)}
                    />
                  ))}
              </div>
            ))}

            {draft ? (
              <div className="card pad-lg" style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                <Field
                  placeholder="Name it — e.g. Never book over lunch"
                  value={draft.label}
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                />
                <TextArea
                  rows={3}
                  placeholder="Write the belief the way you'd say it to a new assistant on their first morning."
                  value={draft.text}
                  onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                />
                <Segmented
                  options={REGION_ORDER.map((r) => ({ key: r, label: REGIONS[r].label }))}
                  value={draft.region}
                  onChange={(r) => setDraft({ ...draft, region: r })}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <Button kind="primary" size="md" onClick={create}>Add neuron</Button>
                  <Button kind="quiet" size="md" onClick={() => setDraft(null)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <Button kind="quiet" size="md" onClick={() => setDraft({ label: "", text: "", region: "principle" })}>
                  <IcPlus size={15} /> Add a neuron
                </Button>
                <Button kind="quiet" size="md" onClick={doReset}>Reset to seed</Button>
              </div>
            )}
          </>
        )}

        {view === "tensions" && (
          <>
            <div className="t-foot" style={{ marginBottom: 12 }}>
              A tension is two beliefs that disagree, and which one wins when they do.
              These are the arguments SYNC has with itself — the useful part of holding
              beliefs in a graph rather than a list.
            </div>
            {mind.edges.length === 0
              ? <div className="t-foot">No tensions.</div>
              : mind.edges.map((e) => {
                const from = mind.nodes.find((n) => n.id === e.from);
                const to = mind.nodes.find((n) => n.id === e.to);
                if (!from || !to) return null;
                return (
                  <div key={e.id} className="tension">
                    <span className="tension-from">{from.label}</span>
                    <span className="tension-verb">{e.polarity < 0 ? "outranks" : "reinforces"}</span>
                    <span className="tension-to">{to.label}</span>
                    <span className="tension-w">{Math.round(e.weight * 100)}</span>
                  </div>
                );
              })}
          </>
        )}

        {view === "prompt" && (
          <>
            <div className="t-foot" style={{ marginBottom: 10 }}>
              Exactly what SYNC is told, every turn, before the live context. Compiled
              from the neurons above — edit one and this changes.
            </div>
            <div className="card pad-lg">
              <pre className="mind-prompt">{compiled.systemPrompt}</pre>
            </div>
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
          </>
        )}
      </div>
    </>
  );
}
