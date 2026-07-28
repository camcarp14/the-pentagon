// ═══════════════════════════════════════════════════════════════════════════
// @cc/mind/graph — the model. Nodes, synapses, and the operations on them.
//
// Merged from the two forked engines (apps/zts/src/dna/dna.js and
// apps/clarify/src/lib/dna.js), which were the same algorithm with different
// data. Everything load-bearing is carried over verbatim, because both copies
// had already been debugged in production and the merge is not the moment to
// re-derive them:
//
//   • `isAwake` is `!== false`, so a hand-authored genome that omits `enabled`
//     is awake. Compiler, propagator and stats MUST agree on this or an
//     imported mind renders fully lit and compiles to nothing.
//   • CRUD returns a NEW genome, and returns the SAME REFERENCE on a refusal,
//     so callers detect a no-op with `next === genome`.
//   • Locked nodes cannot be disabled, unlocked, or deleted. That is the
//     governance armour, and it is enforced here rather than in the UI.
//   • Removing a node cascades to its synapses. A dangling edge is the one
//     corruption that makes the compiler throw instead of degrade.
//
// What is NEW is the domain axis (domains.js) threaded through all of it:
// validation, stats, and the seed. Persistence is NOT here — the browser keeps
// this in localStorage and the server keeps it in Postgres, and a model that
// knows about either is a model that cannot run in both.
//
// Pure: no fetch, no Date.now() (every timestamp is injected), no database.
// ═══════════════════════════════════════════════════════════════════════════
import { REGIONS, isRegion, coerceRegion } from "./regions.js";
import { DOMAINS, SHARED, isDomain, normalizeDomains } from "./domains.js";

export const clamp01 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

/** A node is awake unless EXPLICITLY disabled. See the header — every consumer
 *  must use this one predicate. */
export const isAwake = (n) => !!n && n.enabled !== false;

/** djb2, 32-bit, unsigned hex. Dependency-free and stable across sessions and
 *  browsers, which is all a mind hash needs to be. */
export function djb2(str) {
  let h = 5381;
  for (let i = 0; i < String(str).length; i++) h = (((h << 5) + h) + String(str).charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

const slugify = (label) =>
  String(label || "node").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "node";

// ─── validation ──────────────────────────────────────────────────────────────
/**
 * Guards imports and self-inflicted corruption. Entry guards run FIRST so
 * garbage returns `{ok:false}` rather than throwing — the load path and the
 * import toast both depend on that.
 *
 * Domains are validated but never rejected for absence: normalizeDomains falls
 * back to `shared`, so "no domains" is a widening, not an error. An UNKNOWN
 * domain string is a different matter and is reported — that is a typo, and a
 * typo'd domain silently drops the node out of the prompt it was written for.
 */
export function validateMind(g) {
  const errors = [];
  if (!g || typeof g !== "object") return { ok: false, errors: ["mind is not an object"] };
  if (!Array.isArray(g.nodes)) errors.push("nodes is not an array");
  if (!Array.isArray(g.edges)) errors.push("edges is not an array");
  if (errors.length) return { ok: false, errors };

  const ids = new Set();
  for (const n of g.nodes) {
    if (!n || typeof n !== "object") { errors.push("node is not an object"); continue; }
    if (!n.id || typeof n.id !== "string") errors.push("node with missing id");
    else if (ids.has(n.id)) errors.push(`duplicate node id ${n.id}`);
    else ids.add(n.id);
    if (!isRegion(n.region)) errors.push(`node ${n.id}: unknown region "${n.region}"`);
    if (typeof n.weight !== "number" || !Number.isFinite(n.weight) || n.weight < 0 || n.weight > 1) {
      errors.push(`node ${n.id}: weight out of 0..1`);
    }
    if (typeof n.label !== "string" || !n.label) errors.push(`node ${n.id}: missing label`);
    if (n.domains !== undefined) {
      const list = Array.isArray(n.domains) ? n.domains : [n.domains];
      for (const d of list) {
        if (!isDomain(typeof d === "string" ? d.trim().toLowerCase() : d)) {
          errors.push(`node ${n.id}: unknown domain "${d}"`);
        }
      }
    }
  }

  const eids = new Set();
  const pairs = new Set();
  for (const e of g.edges) {
    if (!e || typeof e !== "object") { errors.push("edge is not an object"); continue; }
    if (!e.id || eids.has(e.id)) errors.push(`edge with missing or duplicate id ${e.id || "?"}`);
    else eids.add(e.id);
    if (e.from === e.to) errors.push(`edge ${e.id}: self-loop on "${e.from}"`);
    else {
      const pair = `${e.from}->${e.to}`;
      if (pairs.has(pair)) errors.push(`edge ${e.id}: duplicate synapse ${pair}`);
      else pairs.add(pair);
    }
    if (!ids.has(e.from)) errors.push(`edge ${e.id}: dangling from "${e.from}"`);
    if (!ids.has(e.to)) errors.push(`edge ${e.id}: dangling to "${e.to}"`);
    if (typeof e.weight !== "number" || !Number.isFinite(e.weight) || e.weight < 0 || e.weight > 1) {
      errors.push(`edge ${e.id}: weight out of 0..1`);
    }
    if (e.polarity !== 1 && e.polarity !== -1) errors.push(`edge ${e.id}: polarity must be 1 or -1`);
  }
  return { ok: errors.length === 0, errors };
}

// ─── mutation history ────────────────────────────────────────────────────────
/** Reassigns a fresh array, so a prior snapshot sharing the old one is never
 *  touched. `at` and `id` are injected — this module reads no clock. */
export function recordMutation(mind, kind, summary, { at, id } = {}) {
  const entry = { id: id || `mut_${djb2(`${kind}${summary}${at || ""}`)}`, ts: at || null, kind, summary };
  mind.mutations = [entry, ...(mind.mutations || [])].slice(0, 200);
  return mind;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────
// Take a mind, return a NEW mind. A refusal returns the SAME reference so the
// caller can detect a no-op cheaply.

export function addNode(mind, { label, region, text, domains, weight = 0.6, x = 0, y = 0, source = "user", at = null }) {
  const reg = coerceRegion(region);
  const base = `n_${slugify(label)}`;
  let id = base, n = 2;
  while (mind.nodes.some((nd) => nd.id === id)) id = `${base}_${n++}`;
  const node = {
    id,
    label: String(label || "New node").slice(0, 28),
    region: reg,
    domains: normalizeDomains(domains),
    weight: clamp01(weight),
    enabled: true,
    locked: false,
    text: String(text || ""),
    x, y, source,
    created_at: at,
  };
  const next = recordMutation(
    { ...mind, nodes: [...mind.nodes, node] },
    "add_node",
    `Grew "${node.label}" in ${REGIONS[reg].label} (${node.domains.map((d) => DOMAINS[d].label).join(" + ")})`,
    { at },
  );
  return { mind: next, node };
}

export function updateNode(mind, id, patch, { at = null } = {}) {
  const node = mind.nodes.find((n) => n.id === id);
  if (!node) return mind;
  const p = { ...patch };
  if (node.locked) {
    // Governance armour: a locked node cannot be silenced or unlocked, and —
    // new here — cannot have its domains rewritten either. Re-domaining a
    // locked governance principle to a single business is functionally the
    // same as deleting it from the other five.
    if (p.enabled === false) delete p.enabled;
    if (p.locked === false) delete p.locked;
    if (p.domains !== undefined) delete p.domains;
  }
  if (p.weight !== undefined) p.weight = clamp01(p.weight);
  if (p.label !== undefined) p.label = String(p.label).slice(0, 28);
  if (p.domains !== undefined) p.domains = normalizeDomains(p.domains);
  if (p.region !== undefined) p.region = coerceRegion(p.region);
  if (Object.keys(p).length === 0) return mind;

  const next = { ...mind, nodes: mind.nodes.map((n) => (n.id === id ? { ...n, ...p } : n)) };
  // Position-only patches are layout, not thought — the canvas writes x,y on
  // every drag end and that must not flood the history.
  if (Object.keys(p).every((k) => k === "x" || k === "y")) return next;

  let summary;
  if (p.weight !== undefined && p.weight !== node.weight) {
    summary = `${p.weight > node.weight ? "Strengthened" : "Weakened"} "${node.label}" ${node.weight.toFixed(2)} → ${p.weight.toFixed(2)}`;
  } else if (p.domains !== undefined) {
    summary = `Re-homed "${node.label}" to ${p.domains.map((d) => DOMAINS[d].label).join(" + ")}`;
  } else if (p.enabled === false && isAwake(node)) summary = `Silenced "${node.label}"`;
  else if (p.enabled === true && !isAwake(node)) summary = `Awakened "${node.label}"`;
  else summary = `Rewrote "${p.label || node.label}"`;
  return recordMutation(next, "update_node", summary, { at });
}

export function removeNode(mind, id, { at = null } = {}) {
  const node = mind.nodes.find((n) => n.id === id);
  if (!node || node.locked) return mind;
  const cut = mind.edges.filter((e) => e.from === id || e.to === id).length;
  const next = {
    ...mind,
    nodes: mind.nodes.filter((n) => n.id !== id),
    edges: mind.edges.filter((e) => e.from !== id && e.to !== id), // cascade — no dangling synapses, ever
  };
  return recordMutation(next, "remove_node", `Removed "${node.label}"${cut ? ` and ${cut} synapse${cut !== 1 ? "s" : ""}` : ""}`, { at });
}

export function addEdge(mind, { from, to, weight = 0.6, polarity = 1, at = null }) {
  if (!from || !to || from === to) return mind;
  const a = mind.nodes.find((n) => n.id === from);
  const b = mind.nodes.find((n) => n.id === to);
  if (!a || !b) return mind;
  if (mind.edges.some((e) => e.from === from && e.to === to)) return mind;
  const edge = {
    id: `e_${from}_${to}`,
    from, to,
    weight: clamp01(weight),
    polarity: polarity === -1 ? -1 : 1,
  };
  return recordMutation(
    { ...mind, edges: [...mind.edges, edge] },
    "add_edge",
    `${polarity === -1 ? "Tempered" : "Wired"} "${a.label}" → "${b.label}"`,
    { at },
  );
}

export function updateEdge(mind, id, patch, { at = null } = {}) {
  const edge = mind.edges.find((e) => e.id === id);
  if (!edge) return mind;
  const p = {};
  if (patch.weight !== undefined) p.weight = clamp01(patch.weight);
  if (patch.polarity !== undefined) p.polarity = patch.polarity === -1 ? -1 : 1;
  if (Object.keys(p).length === 0) return mind;
  const next = { ...mind, edges: mind.edges.map((e) => (e.id === id ? { ...e, ...p } : e)) };
  return recordMutation(next, "update_edge", `Tuned synapse ${edge.from} → ${edge.to}`, { at });
}

export function removeEdge(mind, id, { at = null } = {}) {
  const edge = mind.edges.find((e) => e.id === id);
  if (!edge) return mind;
  return recordMutation(
    { ...mind, edges: mind.edges.filter((e) => e.id !== id) },
    "remove_edge",
    `Cut synapse ${edge.from} → ${edge.to}`,
    { at },
  );
}

// ─── activation spread ───────────────────────────────────────────────────────
/**
 * Carried over unchanged from both forks — they were byte-identical here.
 *
 * Seeds light at 1.0 and the wave rolls outward along edge direction. Per step
 * every edge reads its source's level FROM THE PREVIOUS STEP (synchronous
 * update, so within-step edge order can never change the result):
 *   excitatory:  target = max(target, source·weight·decay)   — order-free
 *   inhibitory:  target = max(0, target − source·weight·decay)
 * Excitation applies before inhibition inside a step, so tempering gets the
 * last word — the same rule the compiler states in its TENSION lines.
 */
export function propagate(mind, seedIds, { steps = 4, decay = 0.55 } = {}) {
  const EPS = 0.01;
  const enabled = new Set(mind.nodes.filter(isAwake).map((n) => n.id));
  const levels = {};
  for (const n of mind.nodes) levels[n.id] = 0;

  const step0 = [];
  for (const id of seedIds || []) {
    if (enabled.has(id) && levels[id] !== 1) { levels[id] = 1; step0.push(id); }
  }
  const order = [step0];
  const edgesFired = [];
  const firedSet = new Set();

  for (let s = 0; s < steps; s++) {
    const prev = { ...levels };
    for (const e of mind.edges) {
      if (e.polarity === -1 || !enabled.has(e.from) || !enabled.has(e.to)) continue;
      const src = prev[e.from];
      if (src <= EPS) continue;
      const push = src * e.weight * decay;
      if (push > levels[e.to]) {
        levels[e.to] = push;
        if (!firedSet.has(e.id)) { firedSet.add(e.id); edgesFired.push(e.id); }
      }
    }
    for (const e of mind.edges) {
      if (e.polarity !== -1 || !enabled.has(e.from) || !enabled.has(e.to)) continue;
      const src = prev[e.from];
      if (src <= EPS || levels[e.to] <= 0) continue;
      levels[e.to] = Math.max(0, levels[e.to] - src * e.weight * decay);
      if (!firedSet.has(e.id)) { firedSet.add(e.id); edgesFired.push(e.id); }
    }
    let changed = false;
    const newly = [];
    for (const n of mind.nodes) {
      if (levels[n.id] !== prev[n.id]) changed = true;
      if (prev[n.id] <= EPS && levels[n.id] > EPS) newly.push(n.id);
    }
    if (newly.length) order.push(newly);
    if (!changed) break; // fixpoint — the wave died before the step budget did
  }
  return { levels, order, edgesFired };
}

// ─── stats ───────────────────────────────────────────────────────────────────
/**
 * Header pills read this. `byDomain` is the number that makes the merge
 * legible: it answers "how much of this mind is actually ZTS?" without the
 * operator having to count nodes on a canvas.
 */
export function mindStats(mind) {
  const byRegion = {};
  for (const r of Object.keys(REGIONS)) byRegion[r] = 0;
  const byDomain = {};
  for (const d of Object.keys(DOMAINS)) byDomain[d] = 0;

  let enabled = 0;
  for (const n of mind.nodes || []) {
    byRegion[n.region] = (byRegion[n.region] || 0) + 1;
    for (const d of normalizeDomains(n.domains)) byDomain[d] += 1;
    if (isAwake(n)) enabled += 1;
  }

  // A synapse that crosses domains is the interesting one — it is where one
  // business's thinking reaches into another's, and it is invisible on a graph
  // that only counts nodes.
  const byId = new Map((mind.nodes || []).map((n) => [n.id, n]));
  let crossDomain = 0;
  for (const e of mind.edges || []) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const da = normalizeDomains(a.domains).filter((d) => d !== SHARED);
    const db = normalizeDomains(b.domains).filter((d) => d !== SHARED);
    if (da.length && db.length && !da.some((d) => db.includes(d))) crossDomain += 1;
  }

  return {
    nodes: (mind.nodes || []).length,
    edges: (mind.edges || []).length,
    enabled,
    byRegion,
    byDomain,
    crossDomain,
  };
}
