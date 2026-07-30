import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { REGIONS } from "@cc/mind";
import { normalizePalette, lighten, rgba } from "./palette.js";
import { acquireStyle, paletteVars } from "./css.js";
import {
  ZOOM_MIN, ZOOM_MAX, LABEL_ZOOM, ALPHA_SLEEP, REHEAT, BOW, STEP_MS,
  PARTICLES, SPECK_N, SPECK_BOUND, POOL_IDX, EMPTY_GENOME,
  r1, buildSim, tick, edgeD, fitView, zoomAtView, wheelPixels,
} from "./sim.js";

// ════════════════════════════════════════════════════════════════════════════
// MIND CANVAS — the living picture of a genome. One <svg>, one rAF loop, zero
// per-frame React.
//
// The force sim (link springs + pairwise repulsion + region anchors + mild
// centering) lives entirely in refs and writes transforms imperatively to
// element refs kept in Maps — React re-renders only on coarse events
// (selection, genome edit, filter, toast). Activation pulses ride the same
// loop: bus events stage node flares and particles that travel each synapse's
// bezier by manual quadratic interpolation — no getPointAtLength in the hot
// path, no allocation storms (fixed particle pool, reused arrays).
// prefers-reduced-motion drops to a fully static render: synchronous settle,
// highlight-only pulses, no ambient dust, no rAF at all.
//
// ─── Why this file is in a package ──────────────────────────────────────────
//
// It used to be three files: apps/zts/src/dna/MindCanvas.jsx,
// apps/clarify/src/features/dna/MindCanvas.jsx and apps/sync/src/mind/
// MindCanvas.jsx — 3,236 lines expressing one component and three palettes.
// The SYNC copy's own header called the shot: "the honest consolidation is one
// themed component taking its palette as a prop — a move plus a prop rather
// than a rewrite." This is that pass.
//
// The fork was not free while it lasted. It cost, concretely:
//
//   · A crash. Clarify and ZTS still carried a one-line colour parser,
//     `hex.replace("#","")`, with no type guard. Reading a region hue off an
//     object that did not carry one returned undefined, and undefined has no
//     .replace — SYNC's Mind tab went white. Only SYNC got the hardened
//     parser; the other two were one missing key from the same white screen.
//   · Cross-app colour bleed. All three injected a <style> into document.head
//     with IDENTICAL global selectors and their own accent baked in. In the
//     shell, which shares one document, the later mount won for both — so
//     which accent Clarify's drop target wore depended on whether you had
//     opened ZTS first. See css.js.
//   · A shadow that never rendered. SYNC's shim had no `shadowPopover`; two
//     call sites read it, and one composed `${undefined}, var(--accent-a20)`,
//     an invalid shadow list, so the browser dropped the declaration whole.
//   · Bugs fixed once and left broken twice — and a keyboard focus ring that
//     existed only in ZTS.
//
// ─── The two things a host must get right ───────────────────────────────────
//
// PALETTE. Colour enters only through the `palette` prop, and the component
// never resolves anything itself — no getComputedStyle, no querySelector, no
// module cache. The accent is TWO roles, not one: `synapse*` is energy
// (synapses, particles, the firing flare) and `select*` is intent (selection
// halo, focus ring, drop target, rubber band). ZTS uses emerald and amber for
// those; Clarify and SYNC use one hue for both. A single `accent` key would
// compile, render, and quietly turn ZTS's selection ring green. See palette.js.
//
// LOOK. Residual visual divergence that is not colour — ZTS paints nodes as a
// solid disc with a blur filter and has no centre lamp, where Clarify and SYNC
// use a radial-gradient orb over a soft glow, and four opacity/blur constants
// differ. That is the `look` prop. It is fully defaulted: Clarify and SYNC
// pass nothing, ZTS passes one object, and nobody's canvas changed appearance
// on the day of the merge — which was the whole point.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Non-colour visual calibration. Every value is what Clarify and SYNC already
 * used; ZTS overrides the ones it always differed on, so the merge is visually
 * a no-op for all three.
 */
export const LOOK_DEFAULTS = Object.freeze({
  nodePaint: "orb",        // "orb" = radial gradient (clarify/sync) · "solid" = flat fill + blur (zts)
  centreLamp: true,        // the soft glow behind the middle of the graph
  containerWash: false,    // zts tints its container corners; the dark apps do not
  edgeOpacityBase: 0.25,   // zts: 0.22
  edgeOpacityWeight: 0.35, // zts: 0.28
  disabledOpacity: 0.25,   // zts: 0.3
  disabledSaturate: 0.2,   // zts: 0.3
  glassBlur: 14,           // zts: 18
});

const reduceMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** No activation worker in some hosts — a bus is optional, so this is the floor. */
const NULL_BUS = { on: () => () => {}, emit: () => {} };

function MindCanvasImpl({
  genome,                    // current genome object (§1)
  selection,                 // {type:"node"|"edge", id} | null
  onSelect,                  // (selection|null) => void
  onNodeMove,                // (id, x, y) => void        — fired on drag END (persist positions)
  onAddNode,                 // ({x, y}) => void          — double-click empty canvas
  onAddEdge,                 // ({from, to}) => void      — completed link-drag gesture
  regionFilter,              // Set<regionKey> | null     — null = all visible
  height = "calc(100vh - 150px)",
  toastTop = 62,             // px offset for the activation toast — clears the host view's header band
  apiRef,                    // optional ref — exposes {centerWorld} so the host can spawn nodes in-view
  palette: paletteIn,        // REQUIRED — see palette.js. Colour enters only here.
  look: lookIn,              // optional non-colour calibration — see LOOK_DEFAULTS
  bus,                       // optional {on, emit} — activation pulses; omit for a still mind
  label = "Mind — neural map",   // accessible name; hosts say whose mind this is
}) {
  const g = genome && Array.isArray(genome.nodes) ? genome : EMPTY_GENOME;

  // Every derived colour is memoized on the palette, never computed at module
  // scope. Two of the three old copies evaluated their CSS template at import
  // time, so the canvas could not follow a runtime theme change — survivable
  // while each app had exactly one theme, wrong the moment one component serves
  // SYNC, which legitimately renders two (standalone Obsidian vs. in-shell).
  const T = useMemo(() => normalizePalette(paletteIn), [paletteIn]);
  const LOOK = useMemo(() => ({ ...LOOK_DEFAULTS, ...(lookIn || null) }), [lookIn]);
  const dnaBus = bus || NULL_BUS;

  // Unique per instance, so two canvases on one page cannot steal each other's
  // paint. The gradient ids used to be document-global literals (`dnaGrad_skill`,
  // `dnaCenterGlow`), and `url(#…)` resolves by document order — whichever
  // canvas mounted first supplied the region hues for every canvas after it.
  const uid = useId().replace(/[^\w-]/g, "");
  const gradId = (k) => `mg-${uid}-${k}`;
  const lampId = `ml-${uid}`;
  const glowId = `mo-${uid}`;

  // Re-read on change rather than sampled once at mount. Someone who switches
  // Reduce Motion on mid-session was previously left with a canvas that kept
  // animating until they reloaded the whole app.
  const [RM, setRM] = useState(reduceMotion);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setRM(mq.matches);
    if (mq.addEventListener) mq.addEventListener("change", on); else mq.addListener(on);
    return () => { if (mq.removeEventListener) mq.removeEventListener("change", on); else mq.removeListener(on); };
  }, []);

  // ── The mutable world — everything the rAF loop touches lives on one ref so
  //    stale closures are impossible (handlers registered once only read S). ──
  const st = useRef(null);
  if (!st.current) {
    const specks = [];
    for (let i = 0; i < SPECK_N; i++) {
      specks.push({
        x: (Math.random() * 2 - 1) * SPECK_BOUND, y: (Math.random() * 2 - 1) * SPECK_BOUND,
        vx: (Math.random() - 0.5) * 0.18, vy: (Math.random() - 0.5) * 0.18,
        r: 0.5 + Math.random(), o: 0.05 + Math.random() * 0.07,
      });
    }
    const S0 = {
      sim: null,
      view: { x: 0, y: 0, k: 1 },
      rect: null,                                        // cached svg bbox — measured on mount + ResizeObserver, so fit() never forces layout per frame
      nodeEls: new Map(), flareEls: new Map(), edgeEls: new Map(),
      selEdge: null,                                     // {el, id} for the selected-edge halo path
      specks, speckEls: [],
      pool: POOL_IDX.map(() => ({ active: false, e: null, born: 0, dur: 0 })),
      poolH: [], poolT: [],
      pulses: [],                                        // staged activations, pruned by swap-pop
      glows: new Map(),                                  // nodeId → {start, dur, level}
      marked: [], hover: null,                           // hover-dim bookkeeping
      fireEls: [], fireT: 0,                             // reduced-motion static highlight
      gesture: { mode: null, pointerId: null, id: null, from: null, drop: null, edge: null, startX: 0, startY: 0, vx0: 0, vy0: 0, moved: false },
      paused: false,
      raf: 0, toastT: 0,
      userView: false,                                   // true after the first pan/zoom/drag — auto-fit stands down
      fitFn: null,                                       // latest fit() closure, for the loop (registered once at mount)
      // Ref-callback caches — one stable function per element, forever. A fresh
      // closure per render makes React detach (null) and re-attach EVERY node/
      // edge/flare/speck ref on each render — hundreds of Map churns per tick.
      refCbs: { node: new Map(), flare: new Map(), edge: new Map(), selEdge: new Map() },
    };
    S0.speckRefCbs = specks.map((_, i) => (el) => { S0.speckEls[i] = el; });
    S0.poolTRefCbs = POOL_IDX.map((i) => (el) => { S0.poolT[i] = el; });
    S0.poolHRefCbs = POOL_IDX.map((i) => (el) => { S0.poolH[i] = el; });
    st.current = S0;
  }
  const S = st.current;

  // Rebuild the sim during render (not an effect) so ref callbacks in THIS
  // commit already see fresh positions — no first-frame flash at (0,0).
  if (!S.sim || S.sim.genome !== g) S.sim = buildSim(g, S.sim);

  const [toast, setToast] = useState(null);              // activation label — set per event, never per frame
  const [physOn, setPhysOn] = useState(true);

  const svgRef = useRef(null);
  const worldRef = useRef(null);
  const bandRef = useRef(null);
  const zoomTextRef = useRef(null);

  // Render-scope derivations (cheap, coarse-grained — never in the rAF loop).
  const visSet = regionFilter
    ? new Set(g.nodes.filter((n) => regionFilter.has(n.region)).map((n) => n.id))
    : null;
  const enabledOf = {};
  for (let i = 0; i < g.nodes.length; i++) enabledOf[g.nodes[i].id] = g.nodes[i].enabled !== false;

  // ── View: pan/zoom applied imperatively; label visibility + HUD readout ride
  //    the same call so they can never drift out of sync. ─────────────────────
  const applyView = () => {
    const v = S.view, w = worldRef.current;
    if (w) {
      w.setAttribute("transform", "translate(" + v.x + " " + v.y + ") scale(" + v.k + ")");
      w.classList.toggle("dna-zoomout", v.k < LABEL_ZOOM);
    }
    if (zoomTextRef.current) zoomTextRef.current.textContent = Math.round(v.k * 100) + "%";
  };

  const zoomAt = (sx, sy, k2) => {                       // zoom keeping (sx,sy) fixed on screen
    const next = zoomAtView(S.view, sx, sy, k2);
    S.view.x = next.x; S.view.y = next.y; S.view.k = next.k;
    applyView();
  };

  const zoomBy = (f) => {
    const svg = svgRef.current;
    if (!svg) return;
    S.userView = true;                                   // explicit zoom — auto-fit stands down
    const rect = svg.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, S.view.k * f);
  };

  const fit = () => {                                    // frame every visible node with padding
    const svg = svgRef.current, sim = S.sim;
    if (!svg || !sim) return;
    // Cached measure — fit() runs per frame while the sim settles, right after
    // writePositions' attribute writes; a live getBoundingClientRect here is a
    // forced synchronous layout every hot frame. The ResizeObserver keeps the
    // cache honest.
    const rect = S.rect || (S.rect = svg.getBoundingClientRect());
    // The maths lives in sim.js so the NaN case can be tested. It returns null
    // rather than a half-computed view: one non-finite node coordinate used to
    // produce transform="translate(NaN NaN)", which SVG discards silently —
    // the whole graph vanished and nothing anywhere said why.
    const next = fitView(sim.nodes, rect, regionFilter ? (n) => regionFilter.has(n.region) : null);
    if (!next) return;
    S.view.k = next.k; S.view.x = next.x; S.view.y = next.y;
    applyView();
  };

  // The loop reads the LATEST fit closure (it captures regionFilter) — refreshed
  // every render so auto-fit never frames against a stale filter.
  S.fitFn = fit;

  // What world point sits at the viewport's center right now — the host's
  // "＋ Node" uses this so a grown node lands in view, not at world origin
  // (which any pan/zoom may have pushed far off-screen).
  const centerWorld = () => {
    const svg = svgRef.current;
    const rect = svg ? (S.rect || svg.getBoundingClientRect()) : null;
    if (!rect || rect.width < 10) return { x: 0, y: 0 };
    const v = S.view;
    return { x: (rect.width / 2 - v.x) / v.k, y: (rect.height / 2 - v.y) / v.k };
  };
  if (apiRef) apiRef.current = { centerWorld };

  const toWorld = (clientX, clientY) => {
    const rect = svgRef.current.getBoundingClientRect();
    const v = S.view;
    return { x: (clientX - rect.left - v.x) / v.k, y: (clientY - rect.top - v.y) / v.k };
  };

  // ── Imperative position pass — node transforms + edge paths. Called by the
  //    loop while the sim is hot, and once after settles/rebuilds. ────────────
  const writePositions = () => {
    const sim = S.sim;
    if (!sim) return;
    const ns = sim.nodes;
    for (let i = 0; i < ns.length; i++) {
      const el = S.nodeEls.get(ns[i].id);
      if (el) el.setAttribute("transform", "translate(" + r1(ns[i].x) + " " + r1(ns[i].y) + ")");
    }
    const es = sim.edges;
    for (let i = 0; i < es.length; i++) {
      const rec = S.edgeEls.get(es[i].id);
      if (rec && rec.vis) {
        const d = edgeD(es[i]);
        rec.vis.setAttribute("d", d);
        if (rec.hit) rec.hit.setAttribute("d", d);
      }
    }
    if (S.selEdge && S.selEdge.el) {
      const se = sim.edgeById.get(S.selEdge.id);
      if (se) S.selEdge.el.setAttribute("d", edgeD(se));
    }
  };

  // Reduced-motion "physics": run the sim to convergence synchronously, paint
  // once. The layout is identical — it just arrives without the animation.
  const settle = () => {
    const sim = S.sim;
    if (!sim) return;
    if (!S.paused) { let i = 0; while (sim.alpha > ALPHA_SLEEP && i < 400) { tick(sim); i++; } }
    writePositions();
  };

  // ── Hover dimming — one class on the world group; the hovered node, its
  //    synapses, and their far endpoints get marked so CSS can exempt them. ───
  const setHover = (id) => {
    if (S.hover === id) return;
    S.hover = id;
    for (let i = 0; i < S.marked.length; i++) S.marked[i].classList.remove("dna-hov");
    S.marked.length = 0;
    const world = worldRef.current;
    if (!world) return;
    if (!id) { world.classList.remove("dna-dim"); return; }
    world.classList.add("dna-dim");
    const mark = (el) => { if (el) { el.classList.add("dna-hov"); S.marked.push(el); } };
    mark(S.nodeEls.get(id));
    const es = S.sim.edges;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.a.id !== id && e.b.id !== id) continue;
      const rec = S.edgeEls.get(e.id);
      mark(rec && rec.g);
      mark(S.nodeEls.get(e.a.id === id ? e.b.id : e.a.id));  // far endpoint stays lit so edges don't dangle
    }
  };

  // ── Activation pulses — one dnaBus event becomes a time-staged schedule of
  //    particle spawns + node glows consumed by the loop with index pointers
  //    (no shift/splice, no per-frame allocation). ─────────────────────────────
  const spawnParticle = (sp, now) => {
    const e = S.sim && S.sim.edgeById.get(sp.eid);       // re-resolve — genome may have changed mid-pulse
    if (!e) return;
    for (let i = 0; i < PARTICLES; i++) {
      const rec = S.pool[i];
      if (rec.active) continue;
      rec.active = true; rec.e = e; rec.born = now; rec.dur = sp.dur;
      return;
    }                                                    // pool exhausted → drop the particle, never allocate
  };

  const stepPulses = (now) => {
    const ps = S.pulses;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      while (p.si < p.spawns.length && now >= p.spawns[p.si].at) { spawnParticle(p.spawns[p.si], now); p.si++; }
      while (p.gi < p.glows.length && now >= p.glows[p.gi].at) {
        const gl = p.glows[p.gi];
        S.glows.set(gl.id, { start: now, dur: gl.dur, level: gl.level });
        p.gi++;
      }
      if (p.si >= p.spawns.length && p.gi >= p.glows.length && now > p.end) { ps[i] = ps[ps.length - 1]; ps.pop(); }
    }
    // Particles — manual quadratic interpolation along the live bezier (the
    // endpoints may still be moving; the charge follows the wire).
    for (let i = 0; i < PARTICLES; i++) {
      const pt = S.pool[i];
      if (!pt.active) continue;
      const h = S.poolH[i], tr = S.poolT[i];
      if (!h || !pt.e) { pt.active = false; pt.e = null; continue; }
      const t = (now - pt.born) / pt.dur;
      if (t >= 1) {
        pt.active = false; pt.e = null;
        h.setAttribute("opacity", "0");
        if (tr) tr.setAttribute("opacity", "0");
        continue;
      }
      const e = pt.e;
      const x1 = e.a.x, y1 = e.a.y, x2 = e.b.x, y2 = e.b.y;
      const cx = (x1 + x2) / 2 - (y2 - y1) * BOW;
      const cy = (y1 + y2) / 2 + (x2 - x1) * BOW;
      const u = 1 - t;
      h.setAttribute("cx", r1(u * u * x1 + 2 * u * t * cx + t * t * x2));
      h.setAttribute("cy", r1(u * u * y1 + 2 * u * t * cy + t * t * y2));
      h.setAttribute("opacity", 0.95 * (1 - t * 0.35));
      if (tr) {
        const t2 = t < 0.12 ? 0 : t - 0.12;              // the trail lags the head — a comet, not a dot
        const u2 = 1 - t2;
        tr.setAttribute("cx", r1(u2 * u2 * x1 + 2 * u2 * t2 * cx + t2 * t2 * x2));
        tr.setAttribute("cy", r1(u2 * u2 * y1 + 2 * u2 * t2 * cy + t2 * t2 * y2));
        tr.setAttribute("opacity", 0.4 * (1 - t));
      }
    }
    // Node glows — flare ring expands and fades, brightness ∝ activation level.
    for (const [id, gl] of S.glows) {
      const el = S.flareEls.get(id);
      const sn = S.sim ? S.sim.byId.get(id) : null;
      const pr = (now - gl.start) / gl.dur;
      if (pr >= 1 || !el || !sn) {
        if (el) el.setAttribute("opacity", "0");
        S.glows.delete(id);
        continue;
      }
      el.setAttribute("r", r1(sn.r + 3 + 12 * pr));
      el.setAttribute("opacity", Math.max(0, gl.level * (1 - pr) * 0.9));
    }
  };

  const stepSpecks = () => {
    const sp = S.specks;
    for (let i = 0; i < sp.length; i++) {
      const p = sp[i], el = S.speckEls[i];
      p.x += p.vx; p.y += p.vy;
      p.vx += (Math.random() - 0.5) * 0.006;             // brownian wander so the drift never reads as linear
      p.vy += (Math.random() - 0.5) * 0.006;
      if (p.vx > 0.22) p.vx = 0.22; else if (p.vx < -0.22) p.vx = -0.22;
      if (p.vy > 0.22) p.vy = 0.22; else if (p.vy < -0.22) p.vy = -0.22;
      if (p.x > SPECK_BOUND) p.x = -SPECK_BOUND; else if (p.x < -SPECK_BOUND) p.x = SPECK_BOUND;
      if (p.y > SPECK_BOUND) p.y = -SPECK_BOUND; else if (p.y < -SPECK_BOUND) p.y = SPECK_BOUND;
      if (el) { el.setAttribute("cx", r1(p.x)); el.setAttribute("cy", r1(p.y)); }
    }
  };

  // The frame loop. Physics only runs while hot — asleep, a frame is two
  // comparisons plus the ambient dust. Never touches React state.
  const loop = (now) => {
    S.raf = requestAnimationFrame(loop);
    const sim = S.sim;
    if (sim && !S.paused && sim.alpha > ALPHA_SLEEP) {
      tick(sim);
      writePositions();
      // Camera tracks the settling mind — the sim contracts from the seeded
      // ring toward equilibrium, and without this the mount-time fit() leaves
      // the graph small and off-frame. Stands down forever at the user's first
      // pan/zoom/drag (userView) — never fight a human for the viewport.
      if (!S.userView && S.fitFn) S.fitFn();
    }
    else if (S.gesture.mode === "drag") writePositions(); // pinned node tracks the pointer even when paused
    stepSpecks();
    stepPulses(now);
  };

  // Reduced-motion activation: no particles — a 1.2s static highlight of the
  // affected path (nodes + fired synapses go brass), then everything resets.
  const staticFire = (seeds, order, edgesFired) => {
    clearTimeout(S.fireT);
    for (let i = 0; i < S.fireEls.length; i++) S.fireEls[i].classList.remove("dna-fire");
    S.fireEls.length = 0;
    const mark = (el) => { if (el) { el.classList.add("dna-fire"); S.fireEls.push(el); } };
    const ids = new Set(seeds);
    order.forEach((step) => (step || []).forEach((id) => ids.add(id)));
    ids.forEach((id) => {
      mark(S.nodeEls.get(id));
      const f = S.flareEls.get(id), sn = S.sim ? S.sim.byId.get(id) : null;
      if (f && sn) { f.setAttribute("r", r1(sn.r + 6)); f.setAttribute("opacity", "0.7"); }
    });
    edgesFired.forEach((eid) => { const rec = S.edgeEls.get(eid); mark(rec && rec.g); });
    S.fireT = setTimeout(() => {
      for (let i = 0; i < S.fireEls.length; i++) S.fireEls[i].classList.remove("dna-fire");
      S.fireEls.length = 0;
      S.flareEls.forEach((f) => f && f.setAttribute("opacity", "0"));
    }, 1200);
  };

  // dnaBus → staged pulse. All allocation happens HERE, once per event; the
  // loop only walks index pointers through the sorted schedules.
  const onBus = (evt) => {
    if (!evt || evt.type !== "activation") return;
    setToast("⚡ " + (evt.label || "The mind fires"));
    clearTimeout(S.toastT);
    S.toastT = setTimeout(() => setToast(null), 2600);
    const trace = evt.trace || {};
    const order = Array.isArray(trace.order) ? trace.order : [];
    const seeds = Array.isArray(evt.seeds) && evt.seeds.length ? evt.seeds : order[0] || [];
    const edgesFired = Array.isArray(trace.edgesFired) ? trace.edgesFired : [];
    const levels = trace.levels || {};
    if (RM) { staticFire(seeds, order, edgesFired); return; }
    const sim = S.sim;
    if (!sim) return;
    const t0 = performance.now() + 60;                   // small lead so frame 1 catches step 0 cleanly
    const stepOf = {};
    seeds.forEach((id) => { stepOf[id] = 0; });
    order.forEach((ids, s) => (ids || []).forEach((id) => { if (!(id in stepOf)) stepOf[id] = s; }));
    const spawns = [], glows = [];
    seeds.forEach((id) => glows.push({ id, at: t0, dur: 950, level: 1 }));   // seed flare first…
    edgesFired.forEach((eid) => {
      const e = sim.edgeById.get(eid);
      if (!e) return;
      const s = stepOf[e.a.id] || 0;
      const at = t0 + 220 + s * STEP_MS;                 // …then the wavefront, step by step
      const count = e.w > 0.55 ? 2 : 1;                  // heavier synapses carry more charge
      for (let k = 0; k < count; k++) spawns.push({ eid, at: at + k * 140, dur: 560 + Math.random() * 240 });
    });
    order.forEach((ids, s) => {
      if (s === 0) return;
      (ids || []).forEach((id) => glows.push({ id, at: t0 + 220 + s * STEP_MS + 380, dur: 800, level: Math.max(0.25, levels[id] || 0.4) }));
    });
    spawns.sort((a, b) => a.at - b.at);
    glows.sort((a, b) => a.at - b.at);
    S.pulses.push({ spawns, si: 0, glows, gi: 0, end: t0 + (order.length + 1) * STEP_MS + 1400 });
  };

  // ── Gestures — one pointer state machine covers pan, node drag, link-drag,
  //    and click-selection (a "click" is a gesture that never moved >4px). ────
  const cancelLink = () => {
    const gs = S.gesture;
    if (bandRef.current) bandRef.current.style.display = "none";
    if (gs.drop) {
      const el = S.nodeEls.get(gs.drop);
      if (el) el.classList.remove("dna-droptar");
      gs.drop = null;
    }
  };

  const updateBand = (e) => {
    const gs = S.gesture;
    const src = S.sim.byId.get(gs.from);
    const band = bandRef.current;
    if (!src || !band) return;
    const w = toWorld(e.clientX, e.clientY);
    band.setAttribute("d", "M" + r1(src.x) + " " + r1(src.y) + " L" + r1(w.x) + " " + r1(w.y));
    // Manual drop-target hit test — pointer capture means pointerover won't fire.
    let hit = null;
    const ns = S.sim.nodes;
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      if (n.id === gs.from) continue;
      if (visSet && !visSet.has(n.id)) continue;
      const dx = w.x - n.x, dy = w.y - n.y, rr = n.r + 8;
      if (dx * dx + dy * dy <= rr * rr) { hit = n.id; break; }
    }
    if (hit !== gs.drop) {
      if (gs.drop) { const el = S.nodeEls.get(gs.drop); if (el) el.classList.remove("dna-droptar"); }
      if (hit) { const el = S.nodeEls.get(hit); if (el) el.classList.add("dna-droptar"); }
      gs.drop = hit;
    }
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 || S.gesture.mode) return;
    const svg = svgRef.current, t = e.target;
    const closest = (sel) => (t.closest ? t.closest(sel) : null);
    const portG = closest("[data-dna-port]");
    const nodeG = closest("[data-dna-node]");
    const gs = S.gesture;
    S.userView = true;                                   // human touched the canvas — auto-fit stands down
    // Own the gesture to ONE pointer. The state machine used to key off
    // `mode` alone, so a second finger landing anywhere sent its own
    // pointerup — which ended the first finger's drag, persisted a position
    // mid-motion, and left the node wherever it happened to be. On a phone
    // that is not an edge case; it is what a thumb resting on the screen does.
    gs.pointerId = e.pointerId;
    gs.startX = e.clientX; gs.startY = e.clientY; gs.moved = false;
    try { svg.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
    if (nodeG && (e.shiftKey || portG)) {
      gs.mode = "link"; gs.from = nodeG.dataset.id; gs.drop = null;
      if (bandRef.current) bandRef.current.style.display = "";
      updateBand(e);
    } else if (nodeG) {
      gs.mode = "drag"; gs.id = nodeG.dataset.id;
      const sn = S.sim.byId.get(gs.id);
      if (sn) { sn.fixed = true; sn.vx = 0; sn.vy = 0; }
      if (!S.paused) S.sim.alpha = Math.max(S.sim.alpha, REHEAT);
      svg.classList.add("dna-grabbing");
    } else {
      gs.mode = "pan";
      const edgeG = closest("[data-dna-edge]");
      gs.edge = edgeG ? edgeG.dataset.id : null;         // pressed an edge? a still pointer selects it on release
      gs.vx0 = S.view.x; gs.vy0 = S.view.y;
      svg.classList.add("dna-grabbing");
    }
    e.preventDefault();
  };

  const onPointerMove = (e) => {
    const gs = S.gesture;
    if (!gs.mode || e.pointerId !== gs.pointerId) return;
    const dx = e.clientX - gs.startX, dy = e.clientY - gs.startY;
    if (!gs.moved && dx * dx + dy * dy > 16) gs.moved = true;
    if (gs.mode === "pan") {
      S.view.x = gs.vx0 + dx; S.view.y = gs.vy0 + dy;
      applyView();
    } else if (gs.mode === "drag") {
      const sn = S.sim.byId.get(gs.id);
      if (!sn) return;
      const w = toWorld(e.clientX, e.clientY);
      sn.x = w.x; sn.y = w.y;
      if (!S.paused) S.sim.alpha = Math.max(S.sim.alpha, REHEAT);
      if (RM) writePositions();                          // no loop under reduced motion — paint directly
    } else if (gs.mode === "link") {
      updateBand(e);
    }
  };

  const onPointerUp = (e) => {
    const gs = S.gesture;
    if (!gs.mode || (e && e.pointerId !== gs.pointerId)) return;
    if (svgRef.current) svgRef.current.classList.remove("dna-grabbing");
    if (gs.mode === "drag") {
      const sn = S.sim.byId.get(gs.id);
      if (sn) sn.fixed = false;
      if (gs.moved && sn) {
        if (onNodeMove) onNodeMove(gs.id, Math.round(sn.x), Math.round(sn.y));
        if (!S.paused) S.sim.alpha = Math.max(S.sim.alpha, REHEAT);   // let the web relax around the new pin
        if (RM) settle();
      } else if (onSelect) {
        onSelect({ type: "node", id: gs.id });
      }
    } else if (gs.mode === "pan") {
      if (!gs.moved && onSelect) onSelect(gs.edge ? { type: "edge", id: gs.edge } : null);
    } else if (gs.mode === "link") {
      if (gs.drop && gs.drop !== gs.from && onAddEdge) onAddEdge({ from: gs.from, to: gs.drop });
      cancelLink();
    }
    gs.mode = null; gs.pointerId = null;
  };

  const onPointerCancel = (e) => {
    const gs = S.gesture;
    if (!gs.mode || (e && e.pointerId !== gs.pointerId)) return;
    if (gs.mode === "drag") {
      const sn = S.sim.byId.get(gs.id);
      if (sn) {
        sn.fixed = false;
        // A cancelled drag used to drop the node's new position on the floor:
        // the sim kept the moved coordinates, nothing persisted them, and the
        // next genome rebuild snapped the node back. iOS cancels pointers for
        // ordinary reasons — an incoming call, the app switcher, a palm — so
        // this is the common ending for a drag on a phone, not a rare one.
        if (gs.moved && onNodeMove) onNodeMove(gs.id, Math.round(sn.x), Math.round(sn.y));
      }
    }
    if (gs.mode === "link") cancelLink();
    if (svgRef.current) svgRef.current.classList.remove("dna-grabbing");
    gs.mode = null; gs.pointerId = null;
  };

  const onDblClick = (e) => {
    const t = e.target;
    if (t.closest && (t.closest("[data-dna-node]") || t.closest("[data-dna-edge]"))) return;
    const w = toWorld(e.clientX, e.clientY);
    if (onAddNode) onAddNode({ x: Math.round(w.x), y: Math.round(w.y) });
  };

  const onPointerOver = (e) => {                         // delegated hover — one listener, not n
    if (S.gesture.mode) return;
    const nodeG = e.target.closest ? e.target.closest("[data-dna-node]") : null;
    setHover(nodeG ? nodeG.dataset.id : null);
  };

  const onSvgLeave = () => { if (!S.gesture.mode) setHover(null); };

  const onSvgKeyDown = (e) => {                          // delegated, like hover — nodes are tabbable buttons
    if (e.key !== "Enter" && e.key !== " ") return;
    const nodeG = e.target.closest ? e.target.closest("[data-dna-node]") : null;
    if (nodeG && onSelect) { e.preventDefault(); onSelect({ type: "node", id: nodeG.dataset.id }); }
  };

  const togglePhysics = () => {
    const next = !physOn;
    setPhysOn(next);
    S.paused = !next;
    if (next && S.sim) {
      S.sim.alpha = Math.max(S.sim.alpha, REHEAT);
      if (RM) settle();
    }
  };

  // ── Element ref plumbing — Maps of id → element the loop writes into. Every
  //    factory memoizes per id in S.refCbs so the callback identity is stable
  //    across renders — otherwise React tears down and re-attaches every ref
  //    (a null call + a Map delete/set + a setAttribute apiece) on each render.
  //    Stale ids from removed nodes stay cached; bounded and inert. ───────────
  const cached = (map, key, make) => {
    let f = map.get(key);
    if (!f) { f = make(); map.set(key, f); }
    return f;
  };
  const nodeRefCb = (id) => cached(S.refCbs.node, id, () => (el) => {
    if (el) {
      S.nodeEls.set(id, el);
      const sn = S.sim.byId.get(id);
      if (sn) el.setAttribute("transform", "translate(" + r1(sn.x) + " " + r1(sn.y) + ")");
    } else {
      S.nodeEls.delete(id);
    }
  });
  const flareRefCb = (id) => cached(S.refCbs.flare, id, () => (el) => { if (el) S.flareEls.set(id, el); else S.flareEls.delete(id); });
  // The cache key separator is a NUL written as the ESCAPE \u0000, not as a
  // literal NUL byte in the source. It was a raw byte, which made this
  // 1060-line file read as `binary` to grep/ripgrep: every repo-wide search
  // silently skipped the whole file, so a rename or a sweep for a call site
  // inside it reported clean while having looked at none of it. Same
  // separator, same runtime string; the file is plain text again.
  const edgeRefCb = (id, key) => cached(S.refCbs.edge, `${id}\u0000${key}`, () => (el) => {
    let rec = S.edgeEls.get(id);
    if (!rec) { rec = { g: null, vis: null, hit: null }; S.edgeEls.set(id, rec); }
    rec[key] = el;
    if (el && key !== "g") {
      const se = S.sim.edgeById.get(id);
      if (se) el.setAttribute("d", edgeD(se));
    }
  });
  const selEdgeRefCb = (id) => cached(S.refCbs.selEdge, id, () => (el) => {
    if (el) {
      S.selEdge = { el, id };
      const se = S.sim.edgeById.get(id);
      if (se) el.setAttribute("d", edgeD(se));
    } else if (S.selEdge && S.selEdge.id === id) {
      S.selEdge = null;
    }
  });

  // ── Lifecycle. Layout effect so the first paint is already framed (fit) and
  //    positioned — no flash of an unzoomed corner. Everything registered here
  //    is torn down on unmount: rAF, bus sub, listeners, style tag, timers. ────
  useLayoutEffect(() => {
    // One shared, palette-free sheet, reference-counted — not a per-instance
    // tag with this app's accent baked into globally-scoped selectors. See css.js.
    const releaseStyle = acquireStyle();
    // Measure once, then only when the box actually changes — the per-frame
    // auto-fit reads S.rect instead of forcing layout with a live measure.
    const svg = svgRef.current;
    const measure = () => {
      S.rect = svg.getBoundingClientRect();
      // Re-frame, don't just re-measure. The observer used to refresh the cached
      // rect and stop, so rotating the phone or opening the keyboard left the
      // graph framed for the old viewport — off-screen, with the canvas looking
      // empty. Only while auto-fit is still in charge: once someone has panned
      // or zoomed, moving their viewport out from under them is worse.
      if (!S.userView) fit();
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(svg);
    if (RM) settle();
    fit();
    const unsub = dnaBus.on(onBus);
    const onKey = (e) => {
      if (e.key === "Escape" && S.gesture.mode === "link") { cancelLink(); S.gesture.mode = null; }
    };
    window.addEventListener("keydown", onKey);
    // Wheel must be non-passive to preventDefault page scroll — React can't do that.
    const onWheel = (e) => {
      e.preventDefault();
      S.userView = true;                                 // wheel zoom — auto-fit stands down
      const rect = svg.getBoundingClientRect();          // live — needs left/top, and wheel is not per-frame
      // deltaMode was ignored, so a wheel reporting LINE units (Firefox, and
      // some mice everywhere) sent deltas of ±3 — exp(-3 * 0.0016) is 0.995,
      // a half-percent zoom. The wheel appeared to do nothing at all on that
      // hardware. wheelPixels normalises it.
      const dy = wheelPixels(e.deltaY, e.deltaMode);
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, S.view.k * Math.exp(-dy * 0.0016));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });

    // Stop the loop while the page is hidden. The ambient dust animates forever
    // by design, which means that without this the canvas held a 60fps rAF for
    // as long as the tab existed — including backgrounded on a phone, where it
    // is pure battery cost for pixels nobody can see.
    //
    // The cancel-before-schedule is the whole safety of it: a sibling component
    // in this repo resumed by calling loop() directly, and because backgrounding
    // stops rAF firing without cancelling the queued callback, every app switch
    // left one more loop running and the animation ran a little faster each time.
    const startLoop = () => {
      if (RM) return;
      cancelAnimationFrame(S.raf);
      S.raf = requestAnimationFrame(loop);
    };
    const onVis = () => {
      if (typeof document !== "undefined" && document.hidden) cancelAnimationFrame(S.raf);
      else startLoop();
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
    startLoop();
    return () => {
      cancelAnimationFrame(S.raf);
      unsub && unsub();
      window.removeEventListener("keydown", onKey);
      svg.removeEventListener("wheel", onWheel);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
      if (ro) ro.disconnect();
      clearTimeout(S.toastT);
      clearTimeout(S.fireT);
      releaseStyle();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Genome changed (buildSim already ran in render and reheated alpha) — make
  // sure any freshly mounted elements get positions, and settle statically
  // under reduced motion since there's no loop to do it.
  useEffect(() => {
    writePositions();
    if (RM) { settle(); if (!S.userView) fit(); }        // no loop under reduced motion — reframe here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g]);

  // ZTS used an opaque slate panel with its own border token; the dark apps
  // derive theirs from the page colour. Both are palette values now — the
  // component does not decide, it reads.
  const glass = {
    background: T.glass,
    backdropFilter: `blur(${LOOK.glassBlur}px)`,
    WebkitBackdropFilter: `blur(${LOOK.glassBlur}px)`,
    border: `1px solid ${T.glassBorder}`,
    boxShadow: T.shadow,
  };

  return (
    <div style={{
      position: "relative", width: "100%", height, overflow: "hidden", ...paletteVars(T),
      // ZTS tints the container's corners; the dark apps leave it plain.
      ...(LOOK.containerWash ? {
        background: `radial-gradient(120% 90% at 0% 0%, ${rgba(T.synapse, 0.05)} 0%, transparent 55%), radial-gradient(120% 90% at 100% 0%, ${rgba(T.region.principle, 0.05)} 0%, transparent 55%)`,
      } : null),
    }}>
      <svg
        ref={svgRef}
        className="dna-canvas"
        width="100%"
        height="100%"
        role="application"
        aria-label={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerOver={onPointerOver}
        onPointerLeave={onSvgLeave}
        onDoubleClick={onDblClick}
        onKeyDown={onSvgKeyDown}
      >
        <defs>
          {/* Glow orbs — center lightened region color → region color → transparent
              rim. Off-center focus gives each node a specular "lit sphere" read. */}
          {Object.keys(T.region).map((k) => {
            const c = T.region[k];
            return (
              <radialGradient key={k} id={gradId(k)} cx="38%" cy="35%" r="72%">
                <stop offset="0%" stopColor={lighten(c, 0.55)} />
                <stop offset="55%" stopColor={c} stopOpacity="0.92" />
                <stop offset="100%" stopColor={c} stopOpacity="0" />
              </radialGradient>
            );
          })}
          {/* Only the "solid" treatment blurs; an unused filter still costs a
              rasterised surface on some engines, so it is not always emitted. */}
          {LOOK.nodePaint === "solid" && (
            <filter id={glowId} x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="5" />
            </filter>
          )}
          <radialGradient id={lampId}>
            <stop offset="0%" stopColor={T.select} stopOpacity="0.08" />
            <stop offset="100%" stopColor={T.select} stopOpacity="0" />
          </radialGradient>
        </defs>

        <g ref={worldRef} className="dna-world">
          {/* The one extra lamp — a faint brass pool under the mind's center. */}
          {LOOK.centreLamp && <circle cx="0" cy="0" r="480" fill={`url(#${lampId})`} style={{ pointerEvents: "none" }} />}

          {/* Ambient dust — skipped entirely under reduced motion. */}
          {!RM && (
            <g style={{ pointerEvents: "none" }}>
              {S.specks.map((p, i) => (
                <circle key={i} ref={S.speckRefCbs[i]} cx={r1(p.x)} cy={r1(p.y)} r={r1(p.r)} fill={T.speckInk} opacity={p.o} />
              ))}
            </g>
          )}

          {/* Synapses — brass excitatory, red dashed inhibitory; width + opacity
              carry the weight. Each gets an invisible fat twin for hit testing. */}
          {g.edges.map((e) => {
            const w = typeof e.weight === "number" ? e.weight : 0.5;
            const inhib = e.polarity === -1;
            const sw = 0.8 + 2.6 * w;
            const bothOn = enabledOf[e.from] !== false && enabledOf[e.to] !== false;
            const op = (LOOK.edgeOpacityBase + LOOK.edgeOpacityWeight * w) * (bothOn ? 1 : LOOK.disabledOpacity);
            const hidden = visSet ? !(visSet.has(e.from) && visSet.has(e.to)) : false;
            const selE = selection && selection.type === "edge" && selection.id === e.id;
            return (
              <g key={e.id} data-dna-edge="" data-id={e.id} ref={edgeRefCb(e.id, "g")} style={{ display: hidden ? "none" : undefined }}>
                {selE && (
                  <path ref={selEdgeRefCb(e.id)} fill="none" stroke={T.selectHi} strokeWidth={sw + 3.5} opacity="0.3" strokeLinecap="round" style={{ pointerEvents: "none" }} />
                )}
                <path
                  className="dna-evis"
                  ref={edgeRefCb(e.id, "vis")}
                  fill="none"
                  stroke={inhib ? T.inhibit : T.synapse}
                  strokeWidth={sw}
                  opacity={op}
                  strokeDasharray={inhib ? "6 5" : undefined}
                  strokeLinecap="round"
                />
                <path ref={edgeRefCb(e.id, "hit")} fill="none" stroke="rgba(0,0,0,0)" strokeWidth="11" style={{ pointerEvents: "stroke", cursor: "pointer" }} />
              </g>
            );
          })}

          {/* Link-drag rubber band — shown/positioned imperatively by the gesture. */}
          <path
            ref={bandRef}
            fill="none"
            stroke={T.select}
            strokeWidth="1.5"
            strokeDasharray="7 6"
            opacity="0.85"
            style={{ display: "none", pointerEvents: "none" }}
          />

          {/* Nodes — glow orb, flare ring (pulse-driven), selection halo, padlock
              for locked governance, hover "+" port, label. */}
          {g.nodes.map((n) => {
            const hidden = visSet ? !visSet.has(n.id) : false;
            const r = nodeR(n.weight);
            const regKey = REGIONS[n.region] ? n.region : "identity";
            const selN = selection && selection.type === "node" && selection.id === n.id;
            const disabled = n.enabled === false;
            return (
              <g
                key={n.id}
                data-dna-node=""
                data-id={n.id}
                ref={nodeRefCb(n.id)}
                tabIndex={0}
                role="button"
                aria-label={`${n.label} — ${REGIONS[regKey].label}, weight ${Math.round((typeof n.weight === "number" ? n.weight : 0) * 100)}%${disabled ? ", silenced" : ""}`}
                style={{
                  display: hidden ? "none" : undefined,
                  opacity: disabled ? 0.25 : 1,
                  filter: disabled ? `saturate(${LOOK.disabledSaturate})` : undefined,
                }}
              >
                <title>{n.label}{n.text ? ` — ${n.text}` : ""}</title>
                {/* The soft outer glow only exists in the "solid" treatment —
                    the orb carries its own falloff in the gradient's outer stop. */}
                {LOOK.nodePaint === "solid" && (
                  <circle r={r} fill={T.region[regKey]} opacity={disabled ? 0 : 0.32} filter={`url(#${glowId})`} style={{ pointerEvents: "none" }} />
                )}
                <circle className="dna-flare" ref={flareRefCb(n.id)} r={r + 4} fill="none" stroke={T.synapseHi} strokeWidth="2" opacity="0" style={{ pointerEvents: "none" }} />
                {selN && (
                  <>
                    <circle r={r + 9} fill="none" stroke={T.select} strokeWidth="5" opacity="0.16" style={{ pointerEvents: "none" }} />
                    <circle r={r + 5.5} fill="none" stroke={T.select} strokeWidth="1.4" opacity="0.95" style={{ pointerEvents: "none" }} />
                  </>
                )}
                {LOOK.nodePaint === "solid"
                  ? <circle className="dna-core" r={r} fill={T.region[regKey]} stroke={T.nodeStroke} strokeWidth="1" />
                  : <circle className="dna-core" r={r} fill={`url(#${gradId(regKey)})`} stroke={T.nodeStroke} strokeWidth="1" />}
                {n.locked && (
                  <g transform={`translate(${r1(r * 0.72)} ${r1(-r * 0.72)})`} style={{ pointerEvents: "none" }}>
                    <circle r="5.4" fill={rgba(T.bg, 0.9)} stroke={T.selectLine} strokeWidth="0.8" />
                    <path d="M -1.7 -0.4 v -0.9 a 1.7 1.7 0 0 1 3.4 0 v 0.9" fill="none" stroke={T.select} strokeWidth="1.1" strokeLinecap="round" />
                    <rect x="-2.3" y="-0.5" width="4.6" height="3.5" rx="0.9" fill={T.select} />
                  </g>
                )}
                <circle className="dna-port" data-dna-port="" data-id={n.id} cx={r1(r + 7)} cy="0" r="5.5" fill={T.surface} stroke={T.selectLine} strokeWidth="1" />
                <path className="dna-port" d={`M ${r1(r + 4.5)} 0 h 5 M ${r1(r + 7)} -2.5 v 5`} fill="none" stroke={T.select} strokeWidth="1.2" style={{ pointerEvents: "none" }} />
                <text
                  className="dna-label"
                  y={r1(r + 15)}
                  textAnchor="middle"
                  style={{ fontFamily: T.fontDisplay, fontSize: "10px", fontWeight: 600, fill: T.sub, pointerEvents: "none", paintOrder: "stroke", stroke: rgba(T.bg, 0.85), strokeWidth: "3px", strokeLinejoin: "round" }}
                >
                  {n.label}
                </text>
              </g>
            );
          })}

          {/* Particle pool — fixed set of comet pairs, recycled across pulses. */}
          {!RM && (
            <g style={{ pointerEvents: "none" }}>
              {POOL_IDX.map((i) => (
                <g key={i}>
                  <circle ref={S.poolTRefCbs[i]} r="1.6" fill={T.synapseHi} opacity="0" />
                  <circle ref={S.poolHRefCbs[i]} r="2.5" fill={T.synapseHi} opacity="0" />
                </g>
              ))}
            </g>
          )}
        </g>
      </svg>

      {/* Activation toast — floats top-center while the mind works. Offset below
          the host view's header band (its stat pills paint at a higher z and
          were truncating a top:14 toast mid-word); long labels ellipsize
          instead of running under whatever floats nearby. */}
      {toast && (
        <div
          style={{
            ...glass,
            position: "absolute", top: `${toastTop}px`, left: "50%", transform: "translateX(-50%)",
            zIndex: 12,   // above the header band and suggestions tray — it's transient and pointer-events:none, so it can never block a click
            maxWidth: "clamp(240px, 52vw, 560px)", overflow: "hidden", textOverflow: "ellipsis",
            padding: "7px 16px", borderRadius: "999px", border: `1px solid ${T.selectLine}`,
            color: T.ink, fontFamily: T.fontDisplay, fontSize: "12px", fontWeight: 700,
            letterSpacing: "0.02em", whiteSpace: "nowrap", pointerEvents: "none",
            boxShadow: `${T.shadow}, ${T.glow}`,
            animation: RM ? "none" : "ccMindFadein 0.25s",
          }}
        >
          {toast}
        </div>
      )}

      {/* HUD — glassy pill cluster, bottom-right. Small enough to never block gestures. */}
      <div
        style={{
          ...glass,
          position: "absolute", right: "14px", bottom: "14px",
          display: "flex", alignItems: "center", gap: "2px",
          padding: "4px 6px", borderRadius: "999px",
        }}
      >
        <button className="dna-hudbtn" title="Zoom out" onClick={() => zoomBy(1 / 1.28)}>−</button>
        <span ref={zoomTextRef} style={{ fontFamily: T.fontMono, fontSize: "10px", color: T.sub, minWidth: "38px", textAlign: "center" }}>
          {Math.round(S.view.k * 100)}%
        </span>
        <button className="dna-hudbtn" title="Zoom in" onClick={() => zoomBy(1.28)}>+</button>
        <span style={{ width: "1px", height: "16px", background: T.line, margin: "0 4px" }} />
        <button
          className="dna-hudbtn"
          title="Fit the whole mind in view"
          onClick={fit}
          style={{ width: "auto", padding: "0 10px", fontSize: "9px", fontWeight: 700, letterSpacing: "0.1em", fontFamily: T.fontDisplay }}
        >
          FIT
        </button>
        <button
          className="dna-hudbtn"
          title={physOn ? "Pause layout physics" : "Resume layout physics"}
          aria-pressed={physOn}
          onClick={togglePhysics}
          style={{ color: physOn ? T.select : T.sub, fontSize: "10px" }}
        >
          {physOn ? "❚❚" : "▶"}
        </button>
      </div>
    </div>
  );
}

// memo so the host view's 1.5s worker poll (and every keystroke in its Pulse
// input) never re-reconciles the ~650-element SVG tree — with the host's
// callbacks stable, this component re-renders only on genome/selection/filter
// changes and its own toast. Bus-driven animation bypasses React entirely.
export const MindCanvas = memo(MindCanvasImpl);
