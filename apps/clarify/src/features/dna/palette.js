// ─── Clarify's mind palette ───────────────────────────────────────────────────
// Built from apps/clarify/src/theme.js, the same tokens the canvas read directly
// when it was a copy. Region hues are Clarify's signal colours, transcribed from
// REGIONS[k].color in apps/clarify/src/lib/dna.js — the values, not the token
// names, because @cc/mind-canvas takes finished colours and resolves nothing.
//
// Clarify uses ONE hue for both accent roles: brass is both the energy of a
// firing synapse and the intent of a selection. That is a real property of this
// app's design, not an accident, so it is stated here rather than assumed by the
// component — ZTS deliberately splits them. See palette.js in @cc/mind-canvas.

import { T } from "../../theme.js";

export const CLARIFY_MIND_PALETTE = Object.freeze({
  bg: T.bg,
  surface: T.surface,
  // Its old copy built the HUD panel from the page colour, not a slate
  // token: rgba(T.bg, 0.8) where bg is #0B0F1A.
  glass: "rgba(11,15,26,0.8)",
  glassBorder: T.lineSoft,
  ink: T.ink,
  sub: T.muted,
  line: T.line,
  lineSoft: T.lineSoft,
  nodeStroke: "rgba(255,255,255,0.20)",
  speckInk: T.ink,          // Clarify drifted its dust in primary ink, not a dimmer grey

  // ENERGY and INTENT are the same brass here — said out loud, not defaulted.
  synapse: T.gold,
  synapseHi: T.goldHi,
  select: T.gold,
  selectHi: T.goldHi,
  selectLine: T.goldLine,
  focusRing: "rgba(201,165,87,0.34)",

  inhibit: T.red,

  shadow: T.shadowPopover,
  glow: "0 0 24px rgba(201,165,87,0.20)",

  fontDisplay: T.fontDisplay,
  fontMono: T.fontMono,

  // From REGIONS[k].color in apps/clarify/src/lib/dna.js.
  region: {
    identity: T.gold,
    principle: T.violet,
    knowledge: T.blue,
    signal: T.amber,
    skill: T.green,
    goal: T.pink,
  },
});
