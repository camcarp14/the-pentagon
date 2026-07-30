// The physics and camera, testable for the first time.
//
// While this lived inside an 1,100-line JSX file in a repo with no jsdom, none
// of it could be reached by a test — which is why a camera that could blank the
// entire graph shipped three times over.

import { describe, it, expect } from "vitest";
import {
  ANCHORS, ANCHOR_ORDER, buildSim, tick, edgeD, fitView, zoomAtView, wheelPixels,
  nodeR, RING_R, ZOOM_MIN, ZOOM_MAX, WHEEL_LINE_PX, pinchView, spanOf,
} from "../sim.js";

const seq = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };
const RECT = { width: 800, height: 600 };

describe("the anchor ring is pinned to declaration order", () => {
  it("is NOT the compile order", () => {
    // Every copy built anchors from `Object.keys(REGIONS)` — declaration order.
    // REGION_ORDER is a different sequence, ordered by meaning for the prompt.
    // Swapping one for the other rotates four of the six regions to new
    // coordinates and silently relayouts every saved graph on the next load.
    expect(ANCHOR_ORDER).toEqual(["identity", "principle", "knowledge", "signal", "skill", "goal"]);
    expect(ANCHOR_ORDER).not.toEqual(["identity", "principle", "goal", "signal", "knowledge", "skill"]);
  });

  it("puts identity at the origin and the rest on one ring", () => {
    expect(ANCHORS.identity).toEqual({ x: 0, y: 0 });
    for (const k of ANCHOR_ORDER.filter((r) => r !== "identity")) {
      const d = Math.hypot(ANCHORS[k].x, ANCHORS[k].y);
      expect(Math.abs(d - RING_R)).toBeLessThan(1.5);
    }
  });

  it("has not moved — these are the coordinates users' graphs settled into", () => {
    expect(ANCHORS.principle).toEqual({ x: 0, y: -320 });
    expect(ANCHORS.knowledge).toEqual({ x: 304, y: -99 });
    expect(ANCHORS.signal).toEqual({ x: 188, y: 259 });
    expect(ANCHORS.skill).toEqual({ x: -188, y: 259 });
    expect(ANCHORS.goal).toEqual({ x: -304, y: -99 });
  });
});

describe("fitView cannot blank the graph", () => {
  const N = (x, y, r = 10) => ({ x, y, r, region: "skill" });

  it("returns a finite view for ordinary input", () => {
    const v = fitView([N(0, 0), N(100, 100)], RECT, null);
    expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.k)).toBe(true);
  });

  it("ignores a non-finite node instead of losing the whole mind", () => {
    // THE BUG. `any = true` was set before the coordinates were checked, so one
    // NaN left minX at +Infinity and maxX at -Infinity while the code still
    // believed it had nodes. The centre became (Infinity + -Infinity) / 2 = NaN
    // and the component wrote transform="translate(NaN NaN)". SVG discards that
    // silently — the entire graph vanishes and nothing anywhere says why.
    const good = fitView([N(0, 0), N(100, 100)], RECT, null);
    const withNaN = fitView([N(0, 0), N(100, 100), N(NaN, NaN)], RECT, null);
    expect(withNaN).not.toBeNull();
    expect(Number.isFinite(withNaN.x)).toBe(true);
    expect(Number.isFinite(withNaN.y)).toBe(true);
    expect(withNaN).toEqual(good);           // the bad node is simply not framed

    for (const bad of [N(Infinity, 0), N(0, undefined), N("x", "y")]) {
      const v = fitView([N(0, 0), bad], RECT, null);
      expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true);
    }
  });

  it("returns null rather than a broken view when there is nothing to frame", () => {
    expect(fitView([], RECT, null)).toBeNull();
    expect(fitView(null, RECT, null)).toBeNull();
    expect(fitView([N(NaN, NaN)], RECT, null)).toBeNull();          // all bad → nothing, not NaN
    expect(fitView([N(0, 0)], { width: 0, height: 0 }, null)).toBeNull();
    expect(fitView([N(0, 0)], null, null)).toBeNull();
  });

  it("honours the region filter", () => {
    const a = { x: 0, y: 0, r: 5, region: "skill" };
    const b = { x: 5000, y: 5000, r: 5, region: "goal" };
    const only = fitView([a, b], RECT, (n) => n.region === "skill");
    expect(only).toEqual(fitView([a], RECT, null));
  });

  it("clamps zoom to the documented range", () => {
    const tiny = fitView([{ x: 0, y: 0, r: 1, region: "skill" }], RECT, null);
    expect(tiny.k).toBeLessThanOrEqual(ZOOM_MAX);
    const huge = fitView([{ x: -1e6, y: -1e6, r: 1, region: "skill" }, { x: 1e6, y: 1e6, r: 1, region: "skill" }], RECT, null);
    expect(huge.k).toBeGreaterThanOrEqual(ZOOM_MIN);
  });
});

describe("zoomAtView keeps the anchor point still", () => {
  it("holds the cursor position fixed while scaling", () => {
    const v = { x: 10, y: 20, k: 1 };
    const next = zoomAtView(v, 400, 300, 2);
    // The world point under (400,300) must be the same before and after.
    const before = { x: (400 - v.x) / v.k, y: (300 - v.y) / v.k };
    const after = { x: (400 - next.x) / next.k, y: (300 - next.y) / next.k };
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("clamps rather than letting zoom run away", () => {
    expect(zoomAtView({ x: 0, y: 0, k: 1 }, 0, 0, 999).k).toBe(ZOOM_MAX);
    expect(zoomAtView({ x: 0, y: 0, k: 1 }, 0, 0, 0.001).k).toBe(ZOOM_MIN);
  });
});

describe("wheelPixels normalises the delta", () => {
  it("passes pixel mode through", () => {
    expect(wheelPixels(120, 0)).toBe(120);
    expect(wheelPixels(-40, undefined)).toBe(-40);
  });

  it("scales line mode, which was previously a dead wheel", () => {
    // Firefox and some mice report DOM_DELTA_LINE with deltas of ±3.
    // exp(-3 * 0.0016) is 0.995 — a half-percent zoom, i.e. nothing happened.
    expect(wheelPixels(3, 1)).toBe(3 * WHEEL_LINE_PX);
    expect(Math.abs(wheelPixels(3, 1))).toBeGreaterThan(30);
  });

  it("scales page mode and survives garbage", () => {
    expect(wheelPixels(1, 2)).toBeGreaterThan(100);
    expect(wheelPixels(undefined, 0)).toBe(0);
    expect(wheelPixels(NaN, 1)).toBe(0);
  });
});

describe("pinch geometry", () => {
  const V = { x: 0, y: 0, k: 1 };

  it("scales by the ratio of finger separation", () => {
    const start = { dist: 100, x: 400, y: 300, k: 1 };
    expect(pinchView(V, start, { dist: 200, x: 400, y: 300 }).k).toBeCloseTo(2, 6);
    expect(pinchView(V, start, { dist: 50, x: 400, y: 300 }).k).toBeCloseTo(0.5, 6);
  });

  it("zooms around the midpoint between the fingers, not the viewport", () => {
    // The world point under the fingers must not move while they spread.
    const start = { dist: 100, x: 200, y: 150, k: 1 };
    const before = { x: (200 - V.x) / V.k, y: (150 - V.y) / V.k };
    const next = pinchView(V, start, { dist: 180, x: 200, y: 150 });
    const after = { x: (200 - next.x) / next.k, y: (150 - next.y) / next.k };
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("clamps to the same range as every other zoom path", () => {
    expect(pinchView(V, { dist: 10, x: 0, y: 0, k: 1 }, { dist: 9999, x: 0, y: 0 }).k).toBe(ZOOM_MAX);
    expect(pinchView(V, { dist: 9999, x: 0, y: 0, k: 1 }, { dist: 1, x: 0, y: 0 }).k).toBe(ZOOM_MIN);
  });

  it("returns the view untouched rather than NaN on a degenerate span", () => {
    // Two fingers reported at the same pixel: dist 0, and dividing by it would
    // put NaN straight into the transform, which blanks the graph silently.
    for (const bad of [null, undefined, { dist: 0, x: 0, y: 0 }, { dist: NaN, x: 0, y: 0 }]) {
      expect(pinchView(V, { dist: 100, x: 0, y: 0, k: 1 }, bad)).toBe(V);
      expect(pinchView(V, bad, { dist: 100, x: 0, y: 0 })).toBe(V);
    }
    const out = pinchView(V, { dist: 100, x: 0, y: 0, k: 1 }, { dist: 120, x: 0, y: 0 });
    expect(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.k)).toBe(true);
  });

  it("spanOf measures separation and midpoint", () => {
    const s = spanOf({ x: 0, y: 0 }, { x: 6, y: 8 });
    expect(s.dist).toBe(10);
    expect(s.x).toBe(3);
    expect(s.y).toBe(4);
    expect(spanOf({ x: 5, y: 5 }, { x: 5, y: 5 }).dist).toBe(0);
  });
});

describe("buildSim carries the layout across a save", () => {
  const g = (nodes, edges = []) => ({ nodes, edges });

  it("keeps live positions when a genome is edited in place", () => {
    const first = buildSim(g([{ id: "a", region: "skill", weight: 0.5, x: 10, y: 10 }]), null, () => 0.5);
    first.nodes[0].x = 999; first.nodes[0].y = 888;          // the sim drifted
    const second = buildSim(g([{ id: "a", region: "skill", weight: 0.5, x: 10, y: 10 }]), first, () => 0.5);
    expect(second.nodes[0].x).toBe(999);                     // drift is the truth
  });

  it("obeys the genome when a position was changed from outside", () => {
    // An import or a reset sets new persisted coordinates; those must win over
    // wherever the running sim happened to drift to.
    const first = buildSim(g([{ id: "a", region: "skill", weight: 0.5, x: 10, y: 10 }]), null, () => 0.5);
    first.nodes[0].x = 999;
    const second = buildSim(g([{ id: "a", region: "skill", weight: 0.5, x: 42, y: 43 }]), first, () => 0.5);
    expect(second.nodes[0].x).toBe(42);
    expect(second.nodes[0].y).toBe(43);
  });

  it("drops dangling edges rather than crashing on them", () => {
    const s = buildSim(g([{ id: "a", region: "skill", weight: 0.5, x: 1, y: 1 }], [{ id: "e", from: "a", to: "ghost", weight: 0.5 }]), null, () => 0.5);
    expect(s.edges).toEqual([]);
  });

  it("survives a malformed genome", () => {
    for (const bad of [null, undefined, {}, { nodes: null }, { nodes: [], edges: null }]) {
      expect(() => buildSim(bad, null, () => 0.5)).not.toThrow();
    }
  });

  it("is deterministic when randomness is injected", () => {
    const mk = () => buildSim(g([{ id: "a", region: "skill", weight: 0.5, x: 0, y: 0 }]), null, seq([0.25]));
    expect(mk().nodes[0].x).toBe(mk().nodes[0].x);
  });
});

describe("tick", () => {
  const sim = () => buildSim({
    nodes: [
      { id: "a", region: "skill", weight: 0.5, x: -50, y: 0 },
      { id: "b", region: "skill", weight: 0.5, x: 50, y: 0 },
    ],
    edges: [{ id: "e", from: "a", to: "b", weight: 0.5 }],
  }, null, () => 0.5);

  it("cools toward sleep", () => {
    const s = sim();
    const a0 = s.alpha;
    tick(s, () => 0.5);
    expect(s.alpha).toBeLessThan(a0);
  });

  it("never produces a non-finite coordinate from finite input", () => {
    const s = sim();
    for (let i = 0; i < 500; i++) tick(s, () => 0.5);
    for (const n of s.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("leaves a dragged node exactly where the pointer put it", () => {
    const s = sim();
    s.nodes[0].fixed = true;
    s.nodes[0].x = 123; s.nodes[0].y = 456;
    tick(s, () => 0.5);
    expect(s.nodes[0].x).toBe(123);
    expect(s.nodes[0].y).toBe(456);
  });

  it("separates two nodes sitting exactly on top of each other", () => {
    const s = buildSim({
      nodes: [{ id: "a", region: "skill", weight: 0.5, x: 7, y: 7 }, { id: "b", region: "skill", weight: 0.5, x: 7, y: 7 }],
      edges: [],
    }, null, () => 0.5);
    for (let i = 0; i < 40; i++) tick(s, seq([0.9, 0.1]));
    expect(Math.hypot(s.nodes[0].x - s.nodes[1].x, s.nodes[0].y - s.nodes[1].y)).toBeGreaterThan(0);
  });
});

describe("edgeD", () => {
  it("emits a quadratic bezier with finite control points", () => {
    const d = edgeD({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } });
    expect(d).toMatch(/^M[-\d. ]+Q[-\d. ]+$/);
    expect(d).not.toContain("NaN");
  });
});

describe("nodeR", () => {
  it("scales with weight and defaults sanely", () => {
    expect(nodeR(0)).toBeLessThan(nodeR(1));
    expect(nodeR(undefined)).toBe(nodeR(0.5));
    expect(Number.isFinite(nodeR("nonsense"))).toBe(true);
  });
});
