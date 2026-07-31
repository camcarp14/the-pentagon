// ─── ZTS's mind palette ───────────────────────────────────────────────────────
// Transcribed VERBATIM from the token block that used to sit at the top of
// apps/zts/src/dna/MindCanvas.jsx, and from REGIONS[k].color in dna.js. Nothing
// here is computed or derived from @cc/design — the three apps' region hues were
// three hand-tuned tables (Clarify's are its signal tokens, ZTS's are brightened
// literals, SYNC's is a bespoke map), and deriving them would have changed all
// three on merge day. Transcription is the point.
//
// ZTS IS THE REASON THE ACCENT HAS TWO ROLES. Its canvas has always used
// emerald for ENERGY and amber for INTENT:
//
//   green / greenHi  → excitatory synapse, activation particles, firing flare
//   amber / amberLine → selection halo, focus ring, drop target, rubber band,
//                       link port, padlock, toast border, physics-on
//
// Clarify and SYNC happen to use one hue for both, so a palette with a single
// `accent` key would have compiled, rendered, passed every test, and silently
// turned this app's selection ring green.

export const ZTS_MIND_PALETTE = Object.freeze({
  bg: "#0B0F1A",
  surface: "#141B2C",
  glass: "rgba(20,27,44,0.88)",
  glassBorder: "rgba(255,255,255,0.07)",
  ink: "#E9EDF5",
  sub: "#94A1B5",
  faint: "#6B7789",
  line: "rgba(255,255,255,0.10)",
  lineSoft: "rgba(255,255,255,0.07)",
  nodeStroke: "rgba(255,255,255,0.20)",
  speckInk: "#8FA0B8",

  // ENERGY
  synapse: "#3ECF8E",
  synapseHi: "#5EE0A8",

  // INTENT
  select: "#E3B341",
  selectHi: "#E3B341",
  selectLine: "rgba(227,179,65,0.45)",
  focusRing: "rgba(227,179,65,0.34)",

  inhibit: "#F87171",

  shadow: "0 10px 30px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.45)",
  glow: "0 0 24px rgba(227,179,65,0.20)",

  // The two font slots, and ONLY the font slots, moved off the transcription.
  // App.jsx no longer loads Syne or DM Mono — the design language allows the
  // system stack and no decorative face — so these two names had nothing behind
  // them and already fell through to the next family in each list. Naming the
  // tokens instead removes a dangling reference that would silently take effect
  // again the day anything else on the page happened to load Syne. Every colour,
  // shadow, glow and region hue below is untouched: those are this canvas's
  // domain data, and the canvas itself is not this migration's to restyle.
  fontDisplay: "var(--font-display, ui-sans-serif, system-ui, sans-serif)",
  fontMono: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",

  // From REGIONS[k].color in apps/zts/src/dna/dna.js.
  region: {
    identity: "#2DD4A7",
    principle: "#A78BFA",
    knowledge: "#6EA8FE",
    signal: "#E3B341",
    skill: "#3ECF8E",
    goal: "#F472B6",
  },
});

/**
 * The non-colour differences. ZTS paints a node as a flat disc behind a blur
 * filter rather than the radial-gradient orb the dark apps use, has no centre
 * lamp, and has always run four constants slightly apart from the others.
 * Passing them keeps the merge visually invisible here.
 */
export const ZTS_MIND_LOOK = Object.freeze({
  nodePaint: "solid",
  centreLamp: false,
  containerWash: true,
  edgeOpacityBase: 0.22,
  edgeOpacityWeight: 0.28,
  disabledOpacity: 0.3,
  disabledSaturate: 0.3,
  glassBlur: 18,
});
