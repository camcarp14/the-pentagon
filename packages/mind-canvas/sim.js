// ═══════════════════════════════════════════════════════════════════════════
// @cc/mind-canvas/sim — THE FORCE SIMULATION, AS PURE FUNCTIONS.
//
// Link springs + pairwise repulsion + region anchors + mild centering. Extracted
// from the component for one reason: while it lived inside a 1,100-line JSX file
// it could not be tested, and this repo has no jsdom — so the physics, the
// camera maths and the colour parser were all equally unreachable. That is how a
// colour parser that threw on `undefined` reached production and blanked a whole
// tab. Everything here is a plain function over plain objects.
//
// Allocation-free in the hot path: indexed loops, scalars only, no closures per
// tick. O(n²) repulsion is the worst case and stays cheap at the ≤80-node
// contract the genome validator enforces.
// ═══════════════════════════════════════════════════════════════════════════

// ── Tuning — every number here is a feel decision, grouped so the whole
//    character of the mind can be adjusted from one block. ───────────────────
export const ZOOM_MIN = 0.35, ZOOM_MAX = 2.6;   // wheel/HUD zoom clamp
export const LABEL_ZOOM = 0.55;                 // labels hide below this zoom (they'd be soup)
export const RING_R = 320;                      // region anchor ring — matches the seed layout
export const ALPHA_SLEEP = 0.005;               // below this the sim is asleep (no writes)
export const ALPHA_DECAY = 0.985;               // cooling per tick
export const REHEAT = 0.5;                      // wake energy on genome change / drag / add
export const SPRING = 0.015;                    // link spring gain
export const REPULSE = 3400;                    // pairwise push ∝ 1/d², capped below
export const ANCHOR = 0.0045;                   // pull toward the node's region anchor
export const CENTER = 0.0009;                   // mild global centering so the mind never drifts off
export const FRICTION = 0.86;
export const BOW = 0.18;                        // bezier control offset ⟂ from midpoint, ∝ edge length
export const STEP_MS = 350;                     // activation wavefront: ms between propagate steps
export const PARTICLES = 28;                    // particle pool size (head+trail pairs), reused forever
export const SPECK_N = 40;                      // ambient drifting dust behind the mind
export const SPECK_BOUND = RING_R + 340;        // dust wraps inside this world-space box

export const POOL_IDX = Array.from({ length: PARTICLES }, (_, i) => i);
export const EMPTY_GENOME = Object.freeze({ nodes: [], edges: [] });

export const r1 = (v) => Math.round(v * 10) / 10;   // short attr strings, cheap
export const nodeR = (w) => 9 + 16 * (typeof w === "number" ? w : 0.5);

/**
 * Ring order for the region anchors. DO NOT "tidy" this into REGION_ORDER.
 *
 * Every copy of this canvas built its anchors from `Object.keys(REGIONS)` —
 * DECLARATION order — which is identity, principle, knowledge, signal, skill,
 * goal in all three apps and in @cc/mind. The compile order exported as
 * REGION_ORDER is a different sequence entirely (identity, principle, goal,
 * signal, knowledge, skill) because it is ordered by MEANING for the prompt.
 *
 * The two were never the same list, and the anchor ring is the one that decides
 * where a region physically sits. Swapping in REGION_ORDER here would rotate
 * four of the six regions to new coordinates and relayout the saved graph of
 * every existing user on the next load — silently, since positions are
 * persisted and the sim would simply drag every node to its new home.
 *
 * So the order is written out literally rather than derived, and pinned by a
 * test, because deriving it from an object's key order is exactly the kind of
 * implicit contract that does not survive a refactor.
 */
export const ANCHOR_ORDER = Object.freeze([
  "identity", "principle", "knowledge", "signal", "skill", "goal",
]);

/**
 * Region anchors — identity holds the centre; the other five sit on a hex ring
 * (centre + 5), mirroring the seed genome's layout so physics and persisted
 * positions agree on where each region "lives".
 */
export const ANCHORS = (() => {
  const out = { identity: { x: 0, y: 0 } };
  const ring = ANCHOR_ORDER.filter((k) => k !== "identity");
  ring.forEach((k, i) => {
    const th = (i / ring.length) * Math.PI * 2 - Math.PI / 2;
    out[k] = { x: Math.round(Math.cos(th) * RING_R), y: Math.round(Math.sin(th) * RING_R) };
  });
  return Object.freeze(out);
})();

/**
 * Build the sim, carrying positions/velocities over from the previous one so a
 * genome save never snaps the layout. Brand-new nodes seed from their persisted
 * x/y or, failing that, jitter around their region anchor.
 *
 * `rand` is injectable so tests get a deterministic layout — the only source of
 * nondeterminism in the whole module.
 */
export function buildSim(genome, prev, rand = Math.random) {
  const byId = new Map();
  const src = genome && Array.isArray(genome.nodes) ? genome.nodes : [];
  // The previous genome's STORED positions, to tell layout drift from intent:
  // carry-over is right for incremental edits (the sim's live position is the
  // truth), but a node whose persisted x/y CHANGED between genomes was placed
  // by something outside this sim — an Import JSON, a reset — and must land
  // where the incoming genome says, not where the old mind happened to drift.
  // (Drag-end persists the live position, so its "change" re-seeds to within
  // half a pixel of where the node already is — no snap.)
  const prevStored = prev && prev.genome && Array.isArray(prev.genome.nodes)
    ? new Map(prev.genome.nodes.map((n) => [n.id, n])) : null;
  const nodes = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const n = src[i];
    const old = prev ? prev.byId.get(n.id) : null;
    const anchor = ANCHORS[n.region] || ANCHORS.identity;
    // (0,0) outside identity means "never placed" — those get anchor + jitter.
    const seeded = Number.isFinite(n.x) && Number.isFinite(n.y) && (n.x !== 0 || n.y !== 0 || n.region === "identity");
    const ps = prevStored ? prevStored.get(n.id) : null;
    const placed = seeded && (!old || (ps && (ps.x !== n.x || ps.y !== n.y)));
    const sn = {
      id: n.id, region: n.region, r: nodeR(n.weight),
      x: placed ? n.x : old ? old.x : seeded ? n.x : anchor.x + (rand() - 0.5) * 110,
      y: placed ? n.y : old ? old.y : seeded ? n.y : anchor.y + (rand() - 0.5) * 110,
      vx: old ? old.vx : 0, vy: old ? old.vy : 0,
      fixed: old ? old.fixed : false,          // pinned to the pointer while dragged
      ax: anchor.x, ay: anchor.y,
    };
    nodes[i] = sn;
    byId.set(n.id, sn);
  }
  const edgeById = new Map();
  const edges = [];
  const esrc = genome && Array.isArray(genome.edges) ? genome.edges : [];
  for (let i = 0; i < esrc.length; i++) {
    const e = esrc[i];
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;                    // dangling edges never reach the sim
    const w = typeof e.weight === "number" ? e.weight : 0.5;
    const se = { id: e.id, a, b, w, rest: 120 * (1.6 - w) };  // heavy synapses pull tight
    edges.push(se);
    edgeById.set(e.id, se);
  }
  return { nodes, byId, edges, edgeById, alpha: prev ? Math.max(prev.alpha, REHEAT) : 1, genome: genome || EMPTY_GENOME };
}

/** One physics tick. Mutates `sim` in place; returns nothing. */
export function tick(sim, rand = Math.random) {
  const ns = sim.nodes, es = sim.edges, a = sim.alpha;
  // Link springs — rest length shrinks as weight rises.
  for (let i = 0; i < es.length; i++) {
    const e = es[i];
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - e.rest) * SPRING * a;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    if (!e.a.fixed) { e.a.vx += fx; e.a.vy += fy; }
    if (!e.b.fixed) { e.b.vx -= fx; e.b.vy -= fy; }
  }
  // Pairwise repulsion — capped so overlaps don't explode, range-limited so
  // distant pairs cost one compare and no sqrt.
  for (let i = 0; i < ns.length; i++) {
    const p = ns[i];
    for (let j = i + 1; j < ns.length; j++) {
      const q = ns[j];
      let dx = q.x - p.x, dy = q.y - p.y;
      let d2 = dx * dx + dy * dy;
      if (d2 > 96100) continue;                          // >310px apart — negligible
      if (d2 < 1) { dx = rand() - 0.5; dy = rand() - 0.5; d2 = 1; }  // unstick perfect overlaps
      const d = Math.sqrt(d2);
      let f = (REPULSE / d2) * a;
      if (f > 6) f = 6;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      if (!p.fixed) { p.vx -= fx; p.vy -= fy; }
      if (!q.fixed) { q.vx += fx; q.vy += fy; }
    }
  }
  // Region anchor + mild centering, then integrate.
  for (let i = 0; i < ns.length; i++) {
    const n = ns[i];
    if (n.fixed) { n.vx = 0; n.vy = 0; continue; }       // dragged node obeys the pointer only
    n.vx += (n.ax - n.x) * ANCHOR * a - n.x * CENTER * a;
    n.vy += (n.ay - n.y) * ANCHOR * a - n.y * CENTER * a;
    n.vx *= FRICTION; n.vy *= FRICTION;
    n.x += n.vx; n.y += n.vy;
  }
  sim.alpha *= ALPHA_DECAY;
}

/**
 * Synapse path — quadratic bezier bowed ⟂ from the midpoint. The SAME control
 * point feeds the particle interpolation in the component, so pulses ride the
 * drawn curve.
 */
export function edgeD(e) {
  const x1 = e.a.x, y1 = e.a.y, x2 = e.b.x, y2 = e.b.y;
  const cx = (x1 + x2) / 2 - (y2 - y1) * BOW;
  const cy = (y1 + y2) / 2 + (x2 - x1) * BOW;
  return "M" + r1(x1) + " " + r1(y1) + " Q" + r1(cx) + " " + r1(cy) + " " + r1(x2) + " " + r1(y2);
}

/**
 * The camera that frames every visible node — pure, so the NaN case is testable.
 *
 * THE BUG THIS FIXES. The original set `any = true` before testing whether the
 * node's coordinates were finite. One NaN x — from a corrupt persisted position,
 * an import, or a drag that divided by a zero-width rect — left minX at
 * +Infinity and maxX at -Infinity while `any` still said "there are nodes here".
 * The centre then computed (Infinity + -Infinity) / 2 = NaN, and the component
 * wrote transform="translate(NaN NaN)". SVG discards that attribute silently:
 * the entire graph vanishes, nothing throws, nothing logs, and the tab looks
 * like it simply has no data. Counting only finite nodes makes the bad node
 * invisible instead of the whole mind.
 *
 * @returns {{x:number,y:number,k:number}|null} null when there is nothing to frame
 */
export function fitView(nodes, rect, isVisible, pad = 70) {
  if (!rect || !(rect.width >= 10) || !(rect.height >= 10)) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  for (let i = 0; i < (nodes ? nodes.length : 0); i++) {
    const n = nodes[i];
    if (isVisible && !isVisible(n)) continue;
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;   // ← the fix
    const r = Number.isFinite(n.r) ? n.r : 0;
    any = true;
    if (n.x - r < minX) minX = n.x - r;
    if (n.x + r > maxX) maxX = n.x + r;
    if (n.y - r < minY) minY = n.y - r;
    if (n.y + r > maxY) maxY = n.y + r;
  }
  if (!any) return null;
  const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(
    rect.width / (maxX - minX + pad * 2),
    rect.height / (maxY - minY + pad * 2),
  )));
  const view = {
    k,
    x: rect.width / 2 - ((minX + maxX) / 2) * k,
    y: rect.height / 2 - ((minY + maxY) / 2) * k,
  };
  // Belt and braces: a rect with a NaN dimension would still get here.
  if (!Number.isFinite(view.x) || !Number.isFinite(view.y) || !Number.isFinite(view.k)) return null;
  return view;
}

/** Zoom keeping the screen point (sx, sy) fixed. Pure. */
export function zoomAtView(view, sx, sy, k2) {
  const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k2));
  return {
    k,
    x: sx - ((sx - view.x) / view.k) * k,
    y: sy - ((sy - view.y) / view.k) * k,
  };
}

/**
 * Normalise a wheel event's delta to pixels.
 *
 * deltaMode was ignored in all three copies, so a Firefox mouse reporting
 * DOM_DELTA_LINE (mode 1, deltas of ±3) produced a zoom factor indistinguishable
 * from no zoom at all — the wheel simply did nothing on that hardware.
 */
/**
 * Where a two-finger pinch should put the camera.
 *
 * Pure so the geometry is testable: the component only has to decide WHEN a
 * pinch is happening, not what it means. Scale comes from the ratio of finger
 * separation to the separation at the moment the second finger landed; the
 * midpoint between the fingers is the fixed screen point, so the graph zooms
 * around the gesture rather than around the viewport centre.
 *
 * Degenerate separations (both fingers on the same pixel) return the view
 * unchanged rather than dividing by zero into a NaN transform.
 */
export function pinchView(view, start, now) {
  if (!start || !now || !(start.dist > 0) || !(now.dist > 0)) return view;
  const k = start.k * (now.dist / start.dist);
  if (!Number.isFinite(k)) return view;
  return zoomAtView(view, now.x, now.y, k);
}

/** Separation and midpoint of two screen points. */
export function spanOf(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return { dist: Math.hypot(dx, dy), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export const WHEEL_LINE_PX = 16, WHEEL_PAGE_PX = 400;
export function wheelPixels(deltaY, deltaMode) {
  const d = Number.isFinite(deltaY) ? deltaY : 0;
  if (deltaMode === 1) return d * WHEEL_LINE_PX;
  if (deltaMode === 2) return d * WHEEL_PAGE_PX;
  return d;
}
