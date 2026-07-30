// ═══════════════════════════════════════════════════════════════════════════
// @cc/mind-canvas/css — ONE STYLESHEET, INJECTED ONCE, PALETTE-FREE.
//
// WHAT THIS REPLACES, AND WHY IT WAS A LIVE BUG.
//
// Each copy of the canvas built its CSS as a module-scope template literal with
// the app's palette interpolated straight into it —
//
//   .dna-canvas .dna-droptar .dna-core { stroke: ${T.goldHi} !important; }
//
// — and then, on EVERY mount, appended a fresh <style> to document.head. The
// selectors are document-global and identical in all three apps. Inside the
// Pentagon shell every tool shares one document, so two canvases alive at once
// meant two sheets, same selectors, later mount wins — for both. Which accent
// your drop target, firing node and focus ring wore was decided by the order
// you happened to open the tabs in. Nothing errored; ZTS's amber simply turned
// up in Clarify, or did not, depending on the afternoon.
//
// The fix is the ordinary one and it only becomes available once there is a
// single component: the sheet carries no colour at all, is injected once under
// a known id and reference-counted, and the palette arrives as custom
// properties set on each instance's own wrapper. Two canvases can then render
// side by side in different colours, which was never possible before.
//
// The keyframe is namespaced for the same reason. `fadein` was defined in ZTS's
// canvas, again in ZTS's App.jsx with a DIFFERENT animation (translateY(3px)
// versus plain opacity), again in macro's stylesheet, and NOT AT ALL in the
// Clarify and SYNC copies — which used it anyway and silently borrowed
// whichever definition the host happened to provide. `ccMindFadein` belongs to
// this component and cannot be shadowed.
// ═══════════════════════════════════════════════════════════════════════════

/** The id the singleton <style> is registered under. */
export const STYLE_ID = "cc-mind-canvas";

/**
 * Behaviour CSS. Hover dimming is ONE class toggle on the world group
 * ("dna-dim") plus a marked subset ("dna-hov"), never per-element React.
 *
 * Every colour here is a var(--mind-*) fed by paletteVars(). If you find
 * yourself adding a literal hex to this string, add a palette key instead —
 * a literal is how the three copies started.
 */
export const MIND_CSS = `
.dna-canvas { display: block; touch-action: none; cursor: grab; }
.dna-canvas.dna-grabbing { cursor: grabbing; }
.dna-canvas text { user-select: none; -webkit-user-select: none; }
.dna-canvas g[data-dna-node] { cursor: pointer; transition: opacity 0.18s ease; }
.dna-canvas g[data-dna-edge] { transition: opacity 0.18s ease; }
.dna-canvas .dna-label { transition: opacity 0.22s ease; }
.dna-canvas .dna-zoomout .dna-label { opacity: 0; }
.dna-canvas .dna-dim g[data-dna-node]:not(.dna-hov) { opacity: 0.35 !important; }
.dna-canvas .dna-dim g[data-dna-edge]:not(.dna-hov) { opacity: 0.35; }
/* The "+" link port is hover-revealed AND hover-armed: while invisible it must
   not hit-test, or a touch near a node's 3-o'clock edge (no hover on touch)
   silently hijacks the tap into a phantom link-drag. Touch wiring lives in the
   inspector's "wire a synapse" control instead. */
.dna-canvas .dna-port { opacity: 0; pointer-events: none; transition: opacity 0.15s ease; cursor: crosshair; }
.dna-canvas g[data-dna-node]:hover .dna-port { opacity: 1; pointer-events: auto; }
.dna-canvas .dna-droptar .dna-core { stroke: var(--mind-select-hi) !important; stroke-width: 2.5px !important; }
.dna-canvas g[data-dna-node].dna-fire .dna-core { stroke: var(--mind-synapse-hi) !important; }
.dna-canvas g[data-dna-edge].dna-fire .dna-evis { stroke: var(--mind-synapse-hi) !important; opacity: 0.95 !important; }
/* Keyboard path — nodes are tabbable; the ring only shows for keyboard focus
   (focus-visible); pointer selection keeps its own halo. */
.dna-canvas g[data-dna-node]:focus { outline: none; }
.dna-canvas g[data-dna-node]:focus-visible .dna-core { stroke: var(--mind-select) !important; stroke-width: 2.2px !important; }
/* The HUD focus indicator. ZTS was the only copy that had this rule; taking any
   other copy as the merge base would have deleted keyboard focus feedback from
   the HUD entirely, so it is kept and given to all three. */
.dna-hudbtn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--mind-focus-ring); }
.dna-hudbtn { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: 999px; color: var(--mind-sub); cursor: pointer; font-size: 13px; line-height: 1; padding: 0; }
.dna-hudbtn:hover { background: rgba(255,255,255,0.08); color: var(--mind-ink); }
.dna-hudbtn[aria-pressed="true"] { color: var(--mind-select); }
@media (max-width: 860px) {
  /* Touch-target floor. A miss on a 26px HUD button falls through to the svg
     and pans the viewport instead. 44px is the iOS guideline; the visual button
     stays 26px and the target grows around it. */
  .dna-hudbtn { min-width: 44px; min-height: 44px; }
}
@keyframes ccMindFadein { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .dna-canvas g[data-dna-node], .dna-canvas g[data-dna-edge], .dna-canvas .dna-label, .dna-canvas .dna-port { transition: none !important; }
  .dna-toast { animation: none !important; }
}
`;

/**
 * The palette as inline custom properties for one instance's wrapper.
 *
 * Only the tokens the STYLESHEET needs live here — everything else is applied
 * as ordinary inline style by the component, where a missing value is visible
 * rather than silently voiding a whole declaration.
 */
export function paletteVars(p) {
  return {
    "--mind-ink": p.ink,
    "--mind-sub": p.sub,
    "--mind-select": p.select,
    "--mind-select-hi": p.selectHi || p.select,
    "--mind-synapse-hi": p.synapseHi,
    "--mind-focus-ring": p.focusRing,
  };
}

// Reference count, so N canvases share one sheet and the last one out removes
// it. The old code removed its own tag on unmount, which was correct only
// because each instance had its own; with a singleton, unmounting one canvas
// must not strip the styling from another that is still on screen.
let refs = 0;

/**
 * Ensure the singleton sheet exists. Returns a release function.
 * Safe to call during SSR or in a test with no document — it no-ops.
 */
export function acquireStyle(doc) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d) return () => {};
  refs += 1;
  if (!d.getElementById(STYLE_ID)) {
    const el = d.createElement("style");
    el.id = STYLE_ID;
    el.textContent = MIND_CSS;
    d.head.appendChild(el);
  }
  let released = false;
  return () => {
    if (released) return;          // an effect cleanup that runs twice must not double-decrement
    released = true;
    refs -= 1;
    if (refs <= 0) {
      refs = 0;
      const el = d.getElementById(STYLE_ID);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
  };
}

/** Test seam — the ref count is module state and tests need a clean slate. */
export function __resetStyleRefs() { refs = 0; }
export function __styleRefs() { return refs; }
