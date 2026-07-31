// The one-screen mind editor.
//
// The stake here is higher than usual. ZTS's and Clarify's loadGenome SILENTLY
// RE-SEED on any validation failure — no toast, no backup, no confirmation — so
// a genome this screen writes in a shape their validator rejects is destroyed on
// their next boot, taking every neuron the operator tuned with it. There are
// three of these graphs, they live only in localStorage, and no copy exists on a
// server.
//
// So the defence is not care, it is arithmetic: patchNode touches three fields
// and structurally cannot touch a fourth. These tests are that claim, checked.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Minds, { patchNode, addNode, removeNode, REGIONS } from "../Minds.jsx";

const G = () => ({
  version: 1,
  genome_key: "zts_core",
  updated_at: "2026-01-01T00:00:00.000Z",
  nodes: [
    { id: "a", label: "Tell the truth", region: "principle", weight: 0.9, text: "always", x: 10, y: 20, locked: true, source: "seed" },
    { id: "b", label: "Ship it", region: "skill", weight: 0.4, text: "often", x: 0, y: 0 },
  ],
  edges: [{ id: "e1", from: "a", to: "b", weight: 0.7, polarity: 1 }],
  mutations: [{ kind: "seed", at: 1 }],
});

describe("patchNode edits three fields and cannot reach a fourth", () => {
  it("changes weight, enabled and text", () => {
    expect(patchNode(G(), "a", { weight: 0.25 }).nodes[0].weight).toBe(0.25);
    expect(patchNode(G(), "a", { enabled: false }).nodes[0].enabled).toBe(false);
    expect(patchNode(G(), "a", { text: "new" }).nodes[0].text).toBe("new");
  });

  it("ignores every other field it is handed", () => {
    // The one that matters. A screen that could rewrite an id, a region or a
    // position could write a genome the owning app's validator rejects — and
    // that app deletes what it cannot validate.
    const out = patchNode(G(), "a", {
      id: "hacked", region: "not-a-region", x: 999, y: 999,
      locked: false, label: "renamed", source: "learned", weight: 0.3,
    });
    const n = out.nodes[0];
    expect(n.id).toBe("a");
    expect(n.region).toBe("principle");
    expect(n.x).toBe(10);
    expect(n.y).toBe(20);
    expect(n.locked).toBe(true);
    expect(n.label).toBe("Tell the truth");
    expect(n.source).toBe("seed");
    expect(n.weight).toBe(0.3);            // the one field that WAS asked for
  });

  it("never changes the node or edge count", () => {
    for (const patch of [{ weight: 1 }, { enabled: false }, { text: "" }]) {
      const out = patchNode(G(), "a", patch);
      expect(out.nodes).toHaveLength(2);
      expect(out.edges).toHaveLength(1);
    }
  });

  it("carries every top-level field through untouched", () => {
    const out = patchNode(G(), "a", { weight: 0.5 });
    expect(out.version).toBe(1);
    expect(out.genome_key).toBe("zts_core");
    expect(out.edges).toEqual(G().edges);
    expect(out.mutations).toEqual(G().mutations);
  });

  it("clamps weight into range rather than storing what was typed", () => {
    // A validator that requires 0 < weight <= 1 is the kind that re-seeds.
    for (const [input, want] of [[5, 1], [-3, 0.05], [0, 0.05], ["", 0.05], ["abc", 0.5], [NaN, 0.5], [undefined, 0.5]]) {
      expect(patchNode(G(), "a", { weight: input }).nodes[0].weight, String(input)).toBe(want);
    }
  });

  it("coerces text and enabled rather than storing a foreign type", () => {
    expect(patchNode(G(), "a", { text: null }).nodes[0].text).toBe("");
    expect(patchNode(G(), "a", { text: 42 }).nodes[0].text).toBe("42");
    expect(patchNode(G(), "a", { enabled: "yes" }).nodes[0].enabled).toBe(true);
    expect(patchNode(G(), "a", { enabled: 0 }).nodes[0].enabled).toBe(false);
  });

  it("does not mutate the genome it was given", () => {
    // The screen keeps the previous value in state; mutating in place would let
    // an edit leak into a snapshot something else is still rendering.
    const before = G();
    patchNode(before, "a", { weight: 0.1, text: "x" });
    expect(before.nodes[0].weight).toBe(0.9);
    expect(before.nodes[0].text).toBe("always");
  });

  it("returns the genome untouched for an unknown id or a broken shape", () => {
    const g = G();
    expect(patchNode(g, "nope", { weight: 0.1 })).toBe(g);
    for (const bad of [null, undefined, {}, { nodes: [] }, { nodes: null }]) {
      expect(() => patchNode(bad, "a", { weight: 1 })).not.toThrow();
    }
  });
});

describe("addNode cannot produce a genome the owning app will reject", () => {
  // Their node contract: unique non-empty string id, region from the six,
  // finite weight in 0..1, non-empty label. Miss any one and the app does not
  // error — it re-seeds, and the operator's whole graph is gone.
  const valid = (g) => {
    const ids = new Set();
    for (const n of g.nodes) {
      expect(typeof n.id === "string" && n.id.length > 0, `bad id ${n.id}`).toBe(true);
      expect(ids.has(n.id), `duplicate id ${n.id}`).toBe(false);
      ids.add(n.id);
      expect(REGIONS, `bad region ${n.region}`).toContain(n.region);
      expect(Number.isFinite(n.weight) && n.weight >= 0 && n.weight <= 1, `bad weight ${n.weight}`).toBe(true);
      expect(typeof n.label === "string" && n.label.length > 0, `bad label`).toBe(true);
    }
    for (const e of g.edges || []) {
      expect(ids.has(e.from), `dangling from ${e.from}`).toBe(true);
      expect(ids.has(e.to), `dangling to ${e.to}`).toBe(true);
    }
  };

  it("adds a valid node", () => {
    const out = addNode(G(), { label: "Never book over lunch", text: "protect the hour", region: "principle" });
    expect(out.nodes).toHaveLength(3);
    valid(out);
  });

  it("stays valid for any input a text field can produce", () => {
    for (const label of ["milk", "  spaced  ", "!!!", "Ünïcødé", "a".repeat(300), "constructor", "__proto__"]) {
      const out = addNode(G(), { label, region: "skill" });
      expect(() => valid(out)).not.toThrow();
    }
  });

  it("refuses a node with no label rather than writing an invalid one", () => {
    // Empty is refused because an empty label fails the validator. 0 is NOT in
    // this list: it coerces to "0", which is a perfectly legal label, so
    // refusing it would be this test inventing a rule the apps do not have.
    for (const label of ["", "   ", null, undefined, "\t\n"]) {
      const g = G();
      expect(addNode(g, { label, region: "skill" }), String(label)).toBe(g);
    }
  });

  it("accepts a label that merely looks falsy", () => {
    const out = addNode(G(), { label: 0, region: "skill" });
    expect(out.nodes).toHaveLength(3);
    expect(out.nodes[2].label).toBe("0");
    expect(() => valid(out)).not.toThrow();
  });

  it("forces an unknown region to a real one", () => {
    for (const region of ["nonsense", "", null, undefined, 42]) {
      const out = addNode(G(), { label: "x", region });
      expect(REGIONS).toContain(out.nodes[2].region);
    }
  });

  it("never collides an id, even on the same label twice", () => {
    let g = G();
    for (let i = 0; i < 5; i++) g = addNode(g, { label: "Same name", region: "goal" });
    const ids = g.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    valid(g);
  });

  it("does not mutate what it was given, and keeps the edges", () => {
    const before = G();
    const out = addNode(before, { label: "x", region: "goal" });
    expect(before.nodes).toHaveLength(2);
    expect(out.edges).toEqual(before.edges);
  });
});

describe("removeNode cascades its synapses", () => {
  it("removes the node AND every edge that touched it", () => {
    // An edge pointing at a node that no longer exists is a "dangling" error in
    // the same validator — so removing a node without its edges produces exactly
    // the invalid genome that gets silently re-seeded.
    const out = removeNode(G(), "b");
    expect(out.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(out.edges).toEqual([]);
  });

  it("refuses a locked node", () => {
    const g = G();                       // node "a" is locked
    expect(removeNode(g, "a")).toBe(g);
  });

  it("refuses to empty a mind entirely", () => {
    const one = { ...G(), nodes: [{ id: "solo", label: "L", region: "goal", weight: 0.5 }], edges: [] };
    expect(removeNode(one, "solo")).toBe(one);
  });

  it("is a no-op for an unknown id or a broken genome", () => {
    const g = G();
    expect(removeNode(g, "ghost")).toBe(g);
    for (const bad of [null, undefined, {}, { nodes: [] }]) {
      expect(() => removeNode(bad, "a")).not.toThrow();
    }
  });
});

describe("the screen renders", () => {
  it("says what to do when there are no minds on the device", () => {
    // localStorage is empty under vitest, so this is the real cold path — and an
    // empty state that only says "nothing here" is one this language forbids.
    const html = renderToStaticMarkup(createElement(Minds, {}));
    expect(html).toMatch(/No minds on this device/);
    expect(html, "an empty state has to say what to do next").toMatch(/Open ZTS, Clarify or SYNC/);
  });

  it("renders without throwing or warning", () => {
    expect(() => renderToStaticMarkup(createElement(Minds, { isMobile: true }))).not.toThrow();
  });
});

describe("it reads and writes each mind where that mind already lives", () => {
  const src = (() => {
    const { readFileSync } = require("node:fs");
    const { fileURLToPath } = require("node:url");
    const { dirname, join } = require("node:path");
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "Minds.jsx"), "utf8");
  })();

  it("uses each app's own key, not a new unified one", () => {
    // Nothing is migrated. Three graphs, three homes, read and written exactly
    // as their own apps do it — which is why this screen cannot lose one.
    expect(src).toContain("zts_dna_genome");
    expect(src).toContain("sm_dna_genome");
    expect(src).toContain("sync.state.v1");
  });

  it("writes SYNC's mind back inside its state document, never as a bare key", () => {
    // SYNC keeps its mind inside one doc; writing it to its own key would strand
    // the edit somewhere SYNC never reads.
    expect(src).toMatch(/\.\.\.doc, mind: g/);
  });

  it("stamps updated_at the way ZTS and Clarify do", () => {
    expect(src).toMatch(/updated_at: new Date\(\)\.toISOString\(\)/);
  });

  it("does not import from another app's source tree", () => {
    // The shell reaching into apps/zts/src for a colour is how a shell stops
    // being a shell.
    expect(src).not.toMatch(/from "\.\.\/\.\.\/[a-z]+\/src/);
  });
});
