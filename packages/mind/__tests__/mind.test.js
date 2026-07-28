// The merged mind. Two properties carry everything else, and both are the kind
// that fail silently:
//
//   1. ISOLATION. compileMind(mind, {domain:'zts'}) must contain ZTS's nodes and
//      the shared spine and NOTHING from Clarify. A leak here doesn't throw — it
//      writes a self-custody article that mentions Google Ads, which reads as a
//      model quality problem rather than an architecture one.
//   2. DETERMINISM. Same mind + same domain ⇒ byte-identical prompt ⇒ same hash.
//      The hash is what the operator uses to know whether the mind changed, so a
//      hash that wobbles on its own makes the whole surface untrustworthy.
//
// Everything below either pins one of those or pins a rule the two forked
// engines had already learned the hard way.
import { describe, it, expect } from "vitest";
import {
  seedMind, validateMind, compileMind, compileAll, activeDomains, mindStats,
  addNode, updateNode, removeNode, addEdge, removeEdge, propagate,
  normalizeDomains, inDomain, domainAccent, domainLabel, DOMAINS, DOMAIN_ORDER, SHARED,
  REGIONS, REGION_ORDER, isAwake, band, GOVERNANCE, domainCharter,
} from "../index.js";

const mind = () => seedMind({ at: "2026-07-28T00:00:00.000Z" });

describe("the seed", () => {
  it("validates", () => {
    const v = validateMind(mind());
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("carries every domain, and the shared spine is populated", () => {
    const s = mindStats(mind());
    for (const d of DOMAIN_ORDER) expect(s.byDomain[d]).toBeGreaterThan(0);
    expect(s.byDomain.shared).toBeGreaterThanOrEqual(5);
  });

  it("has no dangling or duplicated synapses", () => {
    const m = mind();
    const ids = new Set(m.nodes.map((n) => n.id));
    const pairs = new Set();
    for (const e of m.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
      expect(pairs.has(`${e.from}->${e.to}`)).toBe(false);
      pairs.add(`${e.from}->${e.to}`);
    }
  });

  it("locks the governance principles that must not be weakened from a canvas", () => {
    const locked = mind().nodes.filter((n) => n.locked).map((n) => n.id);
    expect(locked).toContain("n_sh_draft");   // draft, never send
    expect(locked).toContain("n_sh_cite");    // cite the signal
    expect(locked).toContain("n_bz_halt");    // halt outranks the goal
  });
});

describe("domain isolation — the property the merge had to preserve", () => {
  const zts = () => compileMind(mind(), { domain: "zts" }).systemPrompt;
  const clarify = () => compileMind(mind(), { domain: "clarify" }).systemPrompt;

  it("keeps Clarify's business out of ZTS's prompt", () => {
    const p = zts();
    for (const leak of ["Google Ads", "Chicago", "prospect", "cold email", "HVAC", "orthodontic"]) {
      expect(p).not.toContain(leak);
    }
  });

  it("keeps ZTS's business out of Clarify's prompt", () => {
    const p = clarify();
    for (const leak of ["self-custody", "seed phrase", "hardware wallet", "Bitcoin"]) {
      expect(p).not.toContain(leak);
    }
  });

  it("compiles the shared spine into BOTH", () => {
    const shared = "Everything you produce is a draft in a review queue";
    expect(zts()).toContain(shared);
    expect(clarify()).toContain(shared);
    // …and into every other domain too — that is what `shared` means.
    for (const d of DOMAIN_ORDER.filter((x) => x !== SHARED)) {
      expect(compileMind(mind(), { domain: d }).systemPrompt).toContain(shared);
    }
  });

  it("leads with the charter, then the domain clause, before any node", () => {
    const p = zts();
    expect(p.startsWith(GOVERNANCE)).toBe(true);
    expect(p.indexOf("ZERO TO SECURE — DOMAIN CLAUSE")).toBeLessThan(p.indexOf("IDENTITY —"));
  });

  it("omits the per-domain clause from the whole-mind compile", () => {
    const all = compileMind(mind()).systemPrompt;
    expect(all).toContain(GOVERNANCE);
    expect(all).not.toContain("DOMAIN CLAUSE");
  });

  it("gives each domain its own node count and its own hash", () => {
    const all = compileAll(mind());
    const hashes = Object.values(all).map((c) => c.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(all.zts.nodeCount).toBeLessThan(all.$all.nodeCount);
  });

  it("the whole-mind compile is a superset of every domain compile", () => {
    const all = compileMind(mind()).includedIds;
    for (const d of DOMAIN_ORDER.filter((x) => x !== SHARED)) {
      for (const id of compileMind(mind(), { domain: d }).includedIds) {
        expect(all).toContain(id);
      }
    }
  });
});

describe("synapses respect the domain filter", () => {
  // A tension whose other end was filtered out would tell the model which of
  // two impulses wins when it can only see one of them.
  it("only prints a tension when BOTH endpoints survived", () => {
    const m = mind();
    const zts = compileMind(m, { domain: "zts" });
    const included = new Set(zts.includedIds);
    const tension = zts.sections.find((s) => s.region === "tension");
    const inhibitoryVisible = m.edges.filter(
      (e) => e.polarity === -1 && included.has(e.from) && included.has(e.to),
    );
    expect(tension?.lines.length ?? 0).toBe(inhibitoryVisible.length);
  });

  it("renders the shared-vs-ZTS tension inside ZTS", () => {
    // "Accuracy protects the reader" tempers "Published beats perfect" — one
    // node is ZTS's, the other is shared, so the pair only holds because
    // shared nodes compile into every domain.
    const p = compileMind(mind(), { domain: "zts" }).systemPrompt;
    expect(p).toContain("tempers Published beats perfect");
  });

  it("hides a cross-business synapse from both single-domain compiles", () => {
    // n_zts_grow → n_cl_specific exists, but neither domain contains both ends.
    const inZts = new Set(compileMind(mind(), { domain: "zts" }).includedIds);
    const inClarify = new Set(compileMind(mind(), { domain: "clarify" }).includedIds);
    expect(inZts.has("n_zts_grow") && inZts.has("n_cl_specific")).toBe(false);
    expect(inClarify.has("n_zts_grow") && inClarify.has("n_cl_specific")).toBe(false);
    expect(mindStats(mind()).crossDomain).toBeGreaterThan(0);
  });
});

describe("determinism", () => {
  it("compiles byte-identically across calls", () => {
    const a = compileMind(mind(), { domain: "zts" });
    const b = compileMind(mind(), { domain: "zts" });
    expect(a.systemPrompt).toBe(b.systemPrompt);
    expect(a.hash).toBe(b.hash);
  });

  it("does not depend on node or edge array order", () => {
    const base = compileMind(mind(), { domain: "clarify" });
    const shuffled = mind();
    shuffled.nodes.reverse();
    shuffled.edges.reverse();
    expect(compileMind(shuffled, { domain: "clarify" }).systemPrompt).toBe(base.systemPrompt);
  });

  it("does not depend on the order domains were written on a node", () => {
    const a = mind();
    const b = mind();
    const i = b.nodes.findIndex((n) => n.id === "n_sh_draft");
    b.nodes[i] = { ...b.nodes[i], domains: ["clarify", "zts", "shared"] };
    // normalizeDomains canonicalises to DOMAIN_ORDER, so this is still shared.
    expect(compileMind(b, { domain: "zts" }).systemPrompt)
      .toBe(compileMind(a, { domain: "zts" }).systemPrompt);
  });

  it("moves the hash when a weight moves", () => {
    const before = compileMind(mind(), { domain: "zts" }).hash;
    const after = compileMind(
      updateNode(mind(), "n_zts_voice", { weight: 0.95 }), { domain: "zts" },
    ).hash;
    expect(after).not.toBe(before);
  });

  it("moves EVERY domain's hash when a shared node changes — the blast radius is the point", () => {
    const before = compileAll(mind());
    const after = compileAll(updateNode(mind(), "n_sh_ship", { weight: 0.2 }));
    for (const d of ["zts", "clarify", "runway", "macro"]) {
      expect(after[d].hash).not.toBe(before[d].hash);
    }
  });
});

describe("weight bands", () => {
  it("bands at the documented thresholds", () => {
    expect(band(0.75)).toBe("primary");
    expect(band(0.749)).toBe("standing");
    expect(band(0.4)).toBe("standing");
    expect(band(0.399)).toBe("minor");
  });

  it("uses one label for a low-weight node — the forks disagreed on this", () => {
    // ZTS emitted "Minor — ", Clarify "Minor consideration — ". Unified.
    const m = updateNode(mind(), "n_zts_voice", { weight: 0.2 });
    const p = compileMind(m, { domain: "zts" }).systemPrompt;
    expect(p).toContain("Minor consideration — ");
    expect(p).not.toMatch(/- Minor — /);
  });

  it("marks a high-weight node PRIMARY", () => {
    expect(compileMind(mind(), { domain: "zts" }).systemPrompt).toContain("PRIMARY — ");
  });
});

describe("the lens", () => {
  it("narrows monotonically and never widens", () => {
    const full = compileMind(mind(), { domain: "zts", lens: "full" });
    const standing = compileMind(mind(), { domain: "zts", lens: "standing" });
    const primary = compileMind(mind(), { domain: "zts", lens: "primary" });
    expect(primary.nodeCount).toBeLessThanOrEqual(standing.nodeCount);
    expect(standing.nodeCount).toBeLessThanOrEqual(full.nodeCount);
  });

  it("keeps governance under every lens — a lens must not drop the spine", () => {
    for (const lens of ["primary", "standing", "full"]) {
      expect(compileMind(mind(), { domain: "zts", lens }).systemPrompt).toContain(GOVERNANCE);
    }
  });
});

describe("disabled nodes", () => {
  it("do not exist to the compiler", () => {
    const m = updateNode(mind(), "n_zts_voice", { enabled: false });
    expect(compileMind(m, { domain: "zts" }).systemPrompt).not.toContain("no fear-mongering");
  });

  it("a node with `enabled` absent is awake — imported minds omit the field", () => {
    const m = mind();
    const i = m.nodes.findIndex((n) => n.id === "n_zts_voice");
    delete m.nodes[i].enabled;
    expect(isAwake(m.nodes[i])).toBe(true);
    expect(compileMind(m, { domain: "zts" }).systemPrompt).toContain("no fear-mongering");
  });
});

describe("normalizeDomains", () => {
  it("falls back to shared rather than to nothing", () => {
    // Nowhere is invisible; everywhere is visible and correctable.
    for (const bad of [undefined, null, [], "", 0, {}, ["nope"]]) {
      expect(normalizeDomains(bad)).toEqual([SHARED]);
    }
  });

  it("canonicalises order, case and duplicates", () => {
    expect(normalizeDomains(["clarify", "ZTS", "clarify", " zts "])).toEqual(["zts", "clarify"]);
    expect(normalizeDomains("zts")).toEqual(["zts"]);
  });

  it("drops unknown domains but keeps the known ones beside them", () => {
    expect(normalizeDomains(["zts", "atlantis"])).toEqual(["zts"]);
  });
});

describe("inDomain", () => {
  it("passes everything when no domain is asked for", () => {
    expect(inDomain(["zts"], null)).toBe(true);
    expect(inDomain(["clarify"], undefined)).toBe(true);
  });

  it("admits shared nodes into every business", () => {
    expect(inDomain([SHARED], "zts")).toBe(true);
    expect(inDomain([SHARED], "macro")).toBe(true);
  });

  it("asking for `shared` returns ONLY the spine", () => {
    expect(inDomain([SHARED], SHARED)).toBe(true);
    expect(inDomain(["zts"], SHARED)).toBe(false);
  });

  it("lets one node serve several businesses without duplication", () => {
    expect(inDomain(["zts", "clarify"], "zts")).toBe(true);
    expect(inDomain(["zts", "clarify"], "clarify")).toBe(true);
    expect(inDomain(["zts", "clarify"], "macro")).toBe(false);
  });
});

describe("domain presentation", () => {
  it("paints a node with its business accent, not the shared grey", () => {
    expect(domainAccent(["shared", "zts"])).toBe(DOMAINS.zts.accent);
    expect(domainAccent([SHARED])).toBe(DOMAINS.shared.accent);
  });

  it("labels a multi-domain node with both businesses", () => {
    expect(domainLabel(["clarify", "zts"])).toBe("ZTS + Clarify");
  });

  it("accents match the tool accents in @cc/design", async () => {
    // A neuron's colour has to be the colour of the tool it drives, or the
    // canvas teaches the operator a second, wrong colour vocabulary.
    const design = await import("@cc/design");
    for (const app of design.APPS) {
      if (!DOMAINS[app]) continue;
      expect(DOMAINS[app].accent).toBe(design.appMeta(app).accent);
    }
  });
});

describe("CRUD", () => {
  it("returns the SAME reference on a refusal, so a no-op is cheap to detect", () => {
    const m = mind();
    expect(updateNode(m, "does_not_exist", { weight: 1 })).toBe(m);
    expect(removeNode(m, "does_not_exist")).toBe(m);
    expect(removeEdge(m, "does_not_exist")).toBe(m);
    expect(addEdge(m, { from: "n_sh_draft", to: "n_sh_draft" })).toBe(m); // self-loop
    expect(addEdge(m, { from: "n_sh_draft", to: "n_zts_article" })).toBe(m); // already exists
  });

  it("refuses to delete, silence, unlock or re-home a locked node", () => {
    const m = mind();
    expect(removeNode(m, "n_sh_draft")).toBe(m);
    const patched = updateNode(m, "n_sh_draft", { enabled: false, locked: false, domains: ["zts"] });
    const node = patched.nodes.find((n) => n.id === "n_sh_draft");
    expect(node.enabled).not.toBe(false);
    expect(node.locked).toBe(true);
    expect(node.domains).toEqual([SHARED]);
  });

  it("cascades edge removal so a deleted node leaves no dangling synapse", () => {
    const m = removeNode(mind(), "n_zts_voice");
    expect(m.nodes.some((n) => n.id === "n_zts_voice")).toBe(false);
    expect(m.edges.some((e) => e.from === "n_zts_voice" || e.to === "n_zts_voice")).toBe(false);
    expect(validateMind(m).ok).toBe(true);
  });

  it("adds a node into the domain it was asked for, and compiles it there only", () => {
    const { mind: next, node } = addNode(mind(), {
      label: "Test belief", region: "knowledge", domains: ["macro"], text: "A macro-only fact.", weight: 0.6,
    });
    expect(node.domains).toEqual(["macro"]);
    expect(compileMind(next, { domain: "macro" }).systemPrompt).toContain("A macro-only fact.");
    expect(compileMind(next, { domain: "zts" }).systemPrompt).not.toContain("A macro-only fact.");
  });

  it("an added node with no domain lands in shared and reaches every business", () => {
    const { mind: next } = addNode(mind(), { label: "Universal", region: "principle", text: "Applies to all." });
    for (const d of ["zts", "clarify", "macro"]) {
      expect(compileMind(next, { domain: d }).systemPrompt).toContain("Applies to all.");
    }
  });

  it("clamps weights instead of storing an out-of-range one", () => {
    const { node: hi } = addNode(mind(), { label: "Hi", region: "goal", weight: 9 });
    const { node: lo } = addNode(mind(), { label: "Lo", region: "goal", weight: -3 });
    expect(hi.weight).toBe(1);
    expect(lo.weight).toBe(0);
  });

  it("records position-only edits as layout, not as thought", () => {
    const before = mind();
    const after = updateNode(before, "n_zts_voice", { x: 10, y: 20 });
    expect(after).not.toBe(before);
    expect(after.mutations.length).toBe(before.mutations.length);
  });

  it("records a re-home in the history, naming both businesses", () => {
    const m = updateNode(mind(), "n_zts_voice", { domains: ["zts", "clarify"] });
    expect(m.mutations[0].summary).toMatch(/Re-homed .*ZTS \+ Clarify/);
  });
});

describe("validateMind", () => {
  it("rejects garbage without throwing", () => {
    for (const bad of [null, undefined, 42, "mind", [], {}]) {
      expect(() => validateMind(bad)).not.toThrow();
      expect(validateMind(bad).ok).toBe(false);
    }
  });

  it("catches a typo'd domain — it would silently drop the node from its prompt", () => {
    const m = mind();
    m.nodes[0] = { ...m.nodes[0], domains: ["ztsss"] };
    const v = validateMind(m);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/unknown domain "ztsss"/);
  });

  it("catches dangling edges, self-loops, duplicate ids and bad polarity", () => {
    const m = mind();
    m.edges.push({ id: "e_bad", from: "nope", to: "n_sh_draft", weight: 0.5, polarity: 1 });
    m.edges.push({ id: "e_loop", from: "n_sh_draft", to: "n_sh_draft", weight: 0.5, polarity: 1 });
    m.edges.push({ id: "e_pol", from: "n_sh_cite", to: "n_sh_draft", weight: 0.5, polarity: 0 });
    m.nodes.push({ ...m.nodes[0] });
    const errors = validateMind(m).errors.join(" ");
    expect(errors).toMatch(/dangling from/);
    expect(errors).toMatch(/self-loop/);
    expect(errors).toMatch(/polarity/);
    expect(errors).toMatch(/duplicate node id/);
  });
});

describe("propagate", () => {
  it("lights the seed and reaches its excitatory neighbours", () => {
    const { levels } = propagate(mind(), ["n_zts_grow"]);
    expect(levels.n_zts_grow).toBe(1);
    expect(levels.n_zts_article).toBeGreaterThan(0);
  });

  it("never relays through a disabled node", () => {
    const m = updateNode(mind(), "n_zts_article", { enabled: false });
    const { levels } = propagate(m, ["n_zts_grow"]);
    expect(levels.n_zts_article).toBe(0);
  });

  it("terminates — the wave is monotone-bounded and dies", () => {
    const { order } = propagate(mind(), ["n_sh_draft"], { steps: 50 });
    expect(order.length).toBeLessThanOrEqual(51);
  });

  it("ignores unknown seed ids rather than throwing", () => {
    expect(() => propagate(mind(), ["nope", null, undefined])).not.toThrow();
  });
});

describe("region + charter surface", () => {
  it("orders regions by meaning, not alphabet", () => {
    expect(REGION_ORDER[0]).toBe("identity");
    expect(REGION_ORDER[1]).toBe("principle");
    expect(new Set(REGION_ORDER)).toEqual(new Set(Object.keys(REGIONS)));
  });

  it("gives every business a charter clause and the whole mind none", () => {
    for (const d of DOMAIN_ORDER.filter((x) => x !== SHARED)) {
      expect(domainCharter(d).length).toBeGreaterThan(0);
    }
    expect(domainCharter(null)).toBe("");
    expect(domainCharter("atlantis")).toBe("");
  });

  it("activeDomains reports the businesses the mind actually speaks for", () => {
    expect(activeDomains(mind()).sort()).toEqual(
      DOMAIN_ORDER.filter((d) => d !== SHARED).sort(),
    );
    expect(activeDomains({ nodes: [], edges: [] })).toEqual([]);
  });
});
