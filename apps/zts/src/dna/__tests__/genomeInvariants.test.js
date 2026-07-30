import { describe, it, expect } from "vitest";
import { seedGenome, validateGenome, addNode, updateNode } from "../dna.js";

// validateGenome gates loadGenome, and a genome that fails it is REPLACED by the
// seed — so any bound added to the validator is one step away from silently
// discarding the operator's real mind. Two invariants keep that honest, and both
// are cheap enough to assert forever:
//
//   1. the shipped seed must satisfy the validator, or "Reset to seed" hands back
//      something the next load rejects and re-seeds again;
//   2. anything the WRITE path can store must satisfy it too, or an operator
//      typing past a bound saves a genome that cannot be read back.
//
// The text bound was added after an import could pin a skill to an arbitrary
// model and token budget; these tests exist so the next bound cannot be added
// without a matching write-side clamp.
describe("genome invariants", () => {
  it("the shipped seed satisfies the validator", () => {
    const v = validateGenome(seedGenome());
    expect(v.ok, JSON.stringify(v.errors)).toBe(true);
  });

  it("addNode clamps text to something the validator accepts", () => {
    const seed = seedGenome();
    const { genome, node } = addNode(seed, {
      label: "probe", region: seed.nodes[0].region, text: "x".repeat(20000),
    });
    const v = validateGenome(genome);
    expect(v.ok, `stored ${node.text.length} chars; errors=${JSON.stringify(v.errors)}`).toBe(true);
  });

  it("updateNode clamps text to something the validator accepts", () => {
    const seed = seedGenome();
    const v = validateGenome(updateNode(seed, seed.nodes[0].id, { text: "y".repeat(20000) }));
    expect(v.ok, JSON.stringify(v.errors)).toBe(true);
  });
});
