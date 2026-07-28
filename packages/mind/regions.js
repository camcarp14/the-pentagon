// ═══════════════════════════════════════════════════════════════════════════
// @cc/mind/regions — WHAT KIND OF THOUGHT A NODE IS.
//
// Orthogonal to domain (see domains.js): a region says what kind of thought
// this is, a domain says whose. Every node carries both.
//
// Both forked graphs already agreed on this vocabulary exactly — same six keys,
// same compile order — so the merge inherits it unchanged. Only the colours
// differed, because each app tinted them to its own canvas. They are neutral
// here: on the unified canvas HUE CARRIES DOMAIN, and region is carried by
// shape and grouping. Two encodings competing for the same channel is how a
// graph stops being readable at a glance.
// ═══════════════════════════════════════════════════════════════════════════

export const REGIONS = Object.freeze({
  identity: { label: "Identity", tint: "#E9EDF5", desc: "Who this is" },
  principle: { label: "Principles", tint: "#C9CEDA", desc: "Rules that govern every action" },
  knowledge: { label: "Knowledge", tint: "#A9B2C4", desc: "What it knows" },
  signal: { label: "Signals", tint: "#93A1B5", desc: "Inputs it weighs when deciding" },
  skill: { label: "Skills", tint: "#7C8CA4", desc: "Actions it can take" },
  goal: { label: "Goals", tint: "#66748A", desc: "What it is driving toward" },
});

// Compile order is MEANING, not alphabet: who you are → what you must never do
// → what you want → what you're seeing → what you know → what you can do.
// Governance always precedes all of it. Both forks already used this exact
// order; it is preserved so a merged genome compiles into prose that reads the
// way each app's did.
export const REGION_ORDER = Object.freeze([
  "identity", "principle", "goal", "signal", "knowledge", "skill",
]);

export const isRegion = (r) => Object.prototype.hasOwnProperty.call(REGIONS, r);

/** Unknown regions land in `knowledge` — the least presumptuous home, and the
 *  same fallback both forks used for an unrecognised region on add. */
export const coerceRegion = (r) => (isRegion(r) ? r : "knowledge");
