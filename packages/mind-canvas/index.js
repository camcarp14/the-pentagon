// ═══════════════════════════════════════════════════════════════════════════
// @cc/mind-canvas — one force-directed mind graph, three palettes.
//
// Replaces apps/zts/src/dna/MindCanvas.jsx,
// apps/clarify/src/features/dna/MindCanvas.jsx and
// apps/sync/src/mind/MindCanvas.jsx — 3,236 lines of the same component.
//
// Not in @cc/ui, which is a barrel of small primitives every app imports: a
// re-export there would pull the whole canvas, its physics and its stylesheet
// into the bundle of every tool that wanted a Skeleton. Not in @cc/mind either,
// whose header is explicit that it is pure data with no dependencies — adding
// React to it would be the thing it warns against.
//
// Usage:
//
//   import { MindCanvas } from "@cc/mind-canvas";
//   <MindCanvas genome={mind} palette={MY_PALETTE} label="SYNC — neural map" … />
//
// The palette is required and its shape is documented in palette.js. The
// component resolves no colours of its own.
// ═══════════════════════════════════════════════════════════════════════════

export { MindCanvas, LOOK_DEFAULTS } from "./MindCanvas.jsx";
export {
  normalizePalette, resolveVars, chan, lighten, rgba,
  PALETTE_KEYS, PALETTE_DEFAULTS, REGION_KEYS, FALLBACK_HEX,
} from "./palette.js";
export {
  ANCHORS, ANCHOR_ORDER, buildSim, tick, edgeD, fitView, zoomAtView, wheelPixels,
  nodeR, RING_R, ZOOM_MIN, ZOOM_MAX,
} from "./sim.js";
export { MIND_CSS, STYLE_ID, paletteVars, acquireStyle } from "./css.js";
