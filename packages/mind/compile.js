// ═══════════════════════════════════════════════════════════════════════════
// @cc/mind/compile — THE GRAPH IS THE PROMPT.
//
// DETERMINISTIC: same mind + same domain ⇒ byte-identical string ⇒ same hash.
// Everything that could wobble is pinned — region order is REGION_ORDER,
// in-region order is weight desc then id asc, tension order is edge id asc, and
// domain lists are canonicalised by normalizeDomains before they are ever
// printed. Governance leads verbatim so no weight slider can out-rank the
// approval spine.
//
// THE DOMAIN FILTER IS THE WHOLE POINT. compile(mind) gives the entire
// federated mind; compile(mind, {domain:'zts'}) gives ZTS's mind — its own
// nodes plus every shared one — and nothing about cold email. That is what
// makes one graph safe to share across six businesses: the engine that drafts
// an article never sees Clarify's offer, even though they live in one file.
//
// A SYNAPSE SURVIVES ONLY IF BOTH ENDPOINTS DO. Anything else would print a
// tension referencing a node that is not in the prompt — the model would be
// told which of two impulses wins when it can only see one of them. The useful
// consequence: a shared principle tempering a ZTS skill appears in the ZTS
// compile, while a ZTS→Clarify synapse appears only in the whole-mind compile,
// so cross-business influence is visible exactly where it is real.
//
// Weight bands turn a slider into emphasis: ≥0.75 commands (PRIMARY), ≥0.4
// informs, <0.4 whispers. The two forks disagreed on the last label — ZTS wrote
// "Minor — " and Clarify "Minor consideration — ". Unified on the longer form,
// which is the one that reads as an instruction rather than a heading.
//
// Pure: no fetch, no Date.now(), no database.
// ═══════════════════════════════════════════════════════════════════════════
import { REGIONS, REGION_ORDER } from "./regions.js";
import { DOMAINS, SHARED, inDomain, normalizeDomains } from "./domains.js";
import { isAwake, djb2 } from "./graph.js";
import { charterFor, domainCharter } from "./governance.js";

/** Emphasis band for a weight. Exported so the inspector can show the operator
 *  which band a slider is about to cross before they let go of it. */
export function band(weight) {
  if (weight >= 0.75) return "primary";
  if (weight >= 0.4) return "standing";
  return "minor";
}

const render = (n) =>
  n.weight >= 0.75 ? `PRIMARY — ${n.text}`
    : n.weight >= 0.4 ? n.text
      : `Minor consideration — ${n.text}`;

/**
 * Compile the mind into a system prompt.
 *
 * @param {object}  mind
 * @param {object} [opts]
 * @param {string} [opts.domain]  compile as this business; omit for the whole mind
 * @param {string} [opts.lens]    'primary' | 'standing' | 'full' (default full)
 * @returns {{systemPrompt: string, sections: Array, hash: string, domain: string|null,
 *            nodeCount: number, includedIds: string[]}}
 *
 * The LENS tunes how much of the mind a surface reveals — the DNA view uses it
 * to show a summary. Workers must always run on `full`: a lens is a reading
 * aid, and compiling a worker on a partial mind would silently drop the
 * low-weight guardrails, which are exactly the ones nobody would notice
 * missing.
 */
export function compileMind(mind, { domain = null, lens = "full" } = {}) {
  const nodes = (mind?.nodes || []).filter((n) => isAwake(n) && inDomain(n.domains, domain));
  const included = new Set(nodes.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const minWeight = lens === "primary" ? 0.75 : lens === "standing" ? 0.4 : 0;

  const sections = [];
  for (const region of REGION_ORDER) {
    const lines = nodes
      .filter((n) => n.region === region && n.weight >= minWeight)
      .sort((a, b) => (b.weight - a.weight) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(render);
    if (lines.length) sections.push({ region, lines });
  }

  // Tensions: inhibitory synapses whose BOTH endpoints survived the filter.
  const tensions = (mind?.edges || [])
    .filter((e) => e.polarity === -1 && included.has(e.from) && included.has(e.to))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => `TENSION: ${byId.get(e.from).label} tempers ${byId.get(e.to).label} — when they conflict, ${byId.get(e.from).label} wins.`);

  // charterFor(), not the GOVERNANCE constant: a domain that ACTS rather than
  // drafts compiles under a different spine. See governance.js — handing an
  // acting tool the advisory charter tells it, in the section it may not
  // discount, that it must not do the thing it exists for.
  const parts = [charterFor(domain)];
  const charter = domainCharter(domain);
  if (charter) parts.push(charter);

  for (const s of sections) {
    parts.push(`${REGIONS[s.region].label.toUpperCase()} — ${REGIONS[s.region].desc}:\n${s.lines.map((l) => `- ${l}`).join("\n")}`);
  }
  if (tensions.length) {
    parts.push(`INTERNAL TENSIONS:\n${tensions.map((l) => `- ${l}`).join("\n")}`);
    sections.push({ region: "tension", lines: tensions }); // pseudo-section so UIs can render it too
  }

  const systemPrompt = parts.join("\n\n");
  return {
    systemPrompt,
    sections,
    hash: djb2(systemPrompt),
    domain: domain || null,
    nodeCount: nodes.length,
    includedIds: [...included].sort(),
  };
}

/**
 * Compile every domain in one pass.
 *
 * The surface that answers "what does each business actually believe right
 * now", and the thing that makes a single edit's blast radius visible: change
 * one shared principle and every hash here moves, which is the honest signal
 * that you just changed six prompts and not one.
 */
export function compileAll(mind, { lens = "full" } = {}) {
  const out = {};
  for (const d of Object.keys(DOMAINS)) {
    if (d === SHARED) continue; // the spine is not a business; it is in all of them
    out[d] = compileMind(mind, { domain: d, lens });
  }
  out.$all = compileMind(mind, { lens });
  return out;
}

/**
 * Which domains does this mind actually speak for?
 *
 * A domain with no non-shared awake nodes compiles to nothing but governance —
 * technically valid, and a lie if a UI lists it as configured. Surfaces use
 * this to show a domain as unpopulated rather than as an empty mind.
 */
export function activeDomains(mind) {
  const seen = new Set();
  for (const n of mind?.nodes || []) {
    if (!isAwake(n)) continue;
    for (const d of normalizeDomains(n.domains)) if (d !== SHARED) seen.add(d);
  }
  return [...seen];
}
