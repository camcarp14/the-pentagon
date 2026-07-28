// @cc/mind — one federated mind for The Pentagon.
//
// Nodes are thoughts, synapses are weighted influence, REGIONS say what kind of
// thought a node is and DOMAINS say whose. compileMind() turns the graph
// deterministically into a system prompt — for one business or for all of them.
//
// Replaces two forked copies (apps/zts/src/dna/dna.js, apps/clarify/src/lib/dna.js)
// that had drifted apart in both data and behaviour. See domains.js for why the
// domain axis exists and what it buys.
export * from "./regions.js";
export * from "./domains.js";
export * from "./governance.js";
export * from "./graph.js";
export * from "./compile.js";
export * from "./seed.js";
