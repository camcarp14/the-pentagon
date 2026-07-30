// ═══════════════════════════════════════════════════════════════════════════
// @cc/mind/domains — THE AXIS THAT LETS ONE MIND STAY LEGIBLE.
//
// The Pentagon had TWO minds: apps/zts/src/dna/dna.js and
// apps/clarify/src/lib/dna.js. Same engine, same six regions, same compiler —
// forked and drifted. 644 lines vs 573 with 388 in common; the workers 649 vs
// 550 with 270. They had also drifted in behaviour: ZTS emitted "Minor — " for
// a low-weight node and Clarify emitted "Minor consideration — ". Neither was
// reachable from the server-side engines, which wrote their prompts as
// hardcoded template strings instead.
//
// Merging them into one graph is the easy half. The hard half is not losing
// the thing the split gave you for free: knowing which neuron belongs to which
// business. A single undifferentiated blob would compile ZTS's self-custody
// voice into a cold email about Google Ads.
//
// So every node and every synapse carries DOMAINS — the businesses or
// interests it belongs to. One mind, still legible:
//
//   • `shared` is the spine. It applies everywhere and compiles into every
//     domain's prompt. The approval doctrine lives here.
//   • A node can belong to SEVERAL domains without being duplicated. "Cite the
//     signal behind every claim" is one neuron in two businesses, not two
//     neurons that drift apart — which is exactly how the fork happened.
//   • The canvas colours by domain, filters by domain, and counts by domain,
//     so the graph reads as a federation rather than a soup.
//
// Accents are the SAME hexes @cc/design gives each tool, so a neuron's colour
// on the canvas matches the tool it drives. Domain is not a region: a region is
// what KIND of thought a node is (identity/principle/skill…), a domain is WHOSE
// thought it is. The two are orthogonal and every node has both.
//
// Pure: no fetch, no Date.now(), no database, no imports.
// ═══════════════════════════════════════════════════════════════════════════

/** The one shared domain. Nodes here compile into EVERY domain's prompt. */
export const SHARED = "shared";

/**
 * Every domain the mind can speak for. Keys match the tool ids in @cc/design's
 * APPS list (plus `shared`), so a domain maps 1:1 onto a tool where one exists.
 * Accents are copied from @cc/design rather than imported: this package is pure
 * data with no dependencies, and the two are checked against each other by a
 * test rather than by a coupling.
 */
export const DOMAINS = Object.freeze({
  shared: { label: "Shared", accent: "#AAB6C6", desc: "True everywhere — the spine every business inherits" },
  zts: { label: "ZTS", accent: "#3ECF8E", desc: "Zero To Secure — Bitcoin self-custody education" },
  clarify: { label: "Clarify", accent: "#C9A557", desc: "Clarify Paid Search — outreach and pipeline" },
  runway: { label: "Runway", accent: "#8B7CFF", desc: "The job search" },
  macro: { label: "Macro", accent: "#FFB224", desc: "The trading account" },
  looper: { label: "Looper", accent: "#38D9F0", desc: "Browser-driven mission loops" },
  business: { label: "Business", accent: "#F45CA7", desc: "The autonomous SaaS agent" },
  sync: { label: "SYNC", accent: "#C36BFF", desc: "The workday layer — spoken aloud, and it acts" },
});

/** Stable display order: shared first (it governs the rest), then the tools in
 *  the shell's own toggle order so the UI never has to re-sort. */
export const DOMAIN_ORDER = Object.freeze([
  "shared", "zts", "clarify", "runway", "macro", "looper", "business", "sync",
]);

export const isDomain = (d) => Object.prototype.hasOwnProperty.call(DOMAINS, d);

/**
 * Coerce whatever is on a node into a clean, ordered, deduped domain list.
 *
 * FALLS BACK TO `shared`, NOT TO EMPTY. A node with no domains is a node that
 * compiles into nothing and silently disappears from every prompt — the exact
 * failure mode this file exists to make impossible. A hand-authored or imported
 * genome that omits the field gets the widest, safest reading instead: it
 * applies everywhere, which is visible and correctable, rather than nowhere,
 * which is not.
 */
export function normalizeDomains(value) {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const seen = new Set();
  const out = [];
  for (const d of raw) {
    const key = typeof d === "string" ? d.trim().toLowerCase() : "";
    if (!isDomain(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  if (!out.length) return [SHARED];
  // Ordered by DOMAIN_ORDER so two genomes listing the same domains in
  // different orders hash identically — the compiler's determinism depends on
  // every derived value being canonical, not merely equal.
  return DOMAIN_ORDER.filter((d) => seen.has(d));
}

/**
 * Does this node participate in `domain`?
 *
 * `shared` nodes answer true for every domain — that is what makes them the
 * spine. Asking for the domain `shared` itself returns ONLY shared nodes, which
 * is how you read the governance layer on its own.
 */
export function inDomain(domains, domain) {
  const list = normalizeDomains(domains);
  if (!domain) return true;                 // no filter → the whole mind
  if (domain === SHARED) return list.includes(SHARED);
  return list.includes(domain) || list.includes(SHARED);
}

/** Human label for a domain list: "Shared", "ZTS + Clarify". */
export function domainLabel(domains) {
  return normalizeDomains(domains).map((d) => DOMAINS[d].label).join(" + ");
}

/** The colour a node should paint. A multi-domain node takes the first
 *  NON-shared domain's accent — its shared-ness is already implied by the
 *  company it keeps, and painting it grey would hide the business it serves. */
export function domainAccent(domains) {
  const list = normalizeDomains(domains);
  const own = list.find((d) => d !== SHARED);
  return DOMAINS[own || SHARED].accent;
}
