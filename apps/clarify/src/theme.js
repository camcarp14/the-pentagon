// ─── Clarify design tokens — Board Room slate ─────────────────────────────────
// Clarify retains its token names so its operational UI stays stable, but the
// material now matches the Pentagon's shared Board Room room: cool slate canvas,
// quiet lifted cards, and blue reserved for direction and action. Signal colors
// remain semantic, deliberately softer than the old neon set.
export const T = {
  // brand — shared blue steel (legacy names avoid a broad call-site rewrite)
  gold: "#87B4E3",
  goldHi: "#B1CEED",
  goldDeep: "#4D8FD5",
  goldGrad: "linear-gradient(135deg, #B1CEED 0%, #4D8FD5 100%)",
  goldSoft: "rgba(135,180,227,0.12)",
  goldLine: "rgba(135,180,227,0.30)",
  textOnBrand: "#111922",

  // ink & text (ink = primary text color)
  ink: "#E8EAED",
  inkDeep: "#F7F9FC",
  inkBrand: "#DCEAF7",
  muted: "#ABB2BA",
  faint: "#89909A",
  ghost: "#68737E",
  placeholder: "#707C89",

  // canvas
  bg: "#1F2329",
  surface: "#2D343C",
  subtle: "#252C33",                // wells & inputs sit BELOW surface on dark
  raised: "#3A434D",                // hover/raised layer above surface
  line: "rgba(232,234,237,0.085)",
  lineSoft: "rgba(232,234,237,0.055)",
  lineInk: "rgba(232,234,237,0.07)",

  // signals — 400-series tuned for dark
  pink: "#F472B6",
  blue: "#6EA8FE",
  blueDeep: "#4C8DFF",
  red: "#F87171",
  amber: "#F5B84D",
  amberHi: "#FFC96B",
  green: "#3ECF8E",
  greenHi: "#5EE0A8",
  violet: "#A78BFA",                // snoozed / call-tracking accents

  // type — the platform stack, not a face of our own.
  //
  // These three keys used to name 'Syne' (display) and 'DM Mono'. SESSION's
  // rule is a system stack with no decorative face: hierarchy comes from size
  // and weight, not from a second typeface. Every one of the ~190 call sites
  // already reads T.fontDisplay / T.fontBody / T.fontMono, so pointing the
  // three keys at the platform variables retires Syne everywhere at once and
  // keeps Clarify on exactly the family the shell sets for itself.
  //
  // fontDisplay resolves to the BODY variable deliberately — there is no
  // second face to promote to, and --font-display is where a decorative one
  // would come back in.
  fontDisplay: "var(--font-body)",
  fontBody: "var(--font-body)",
  fontMono: "var(--font-mono)",

  // radii
  rSm: "8px",
  rMd: "10px",
  rLg: "14px",
  rPill: "999px",

  // elevation — Board Room cards float by material and soft depth, never an outline
  shadowCard: "0 2px 10px rgba(11,17,24,0.18), 0 12px 28px rgba(11,17,24,0.12)",
  shadowTab: "0 1px 2px rgba(11,17,24,0.28), 0 4px 12px rgba(11,17,24,0.16)",
  shadowHover: "0 8px 20px rgba(11,17,24,0.22), 0 20px 44px rgba(11,17,24,0.16)",
  shadowPopover: "0 12px 30px rgba(11,17,24,0.30), 0 3px 12px rgba(11,17,24,0.20)",
  shadowModal: "0 34px 90px rgba(11,17,24,0.48), 0 10px 30px rgba(11,17,24,0.26)",
  shadowFloat: "0 14px 46px rgba(11,17,24,0.36)",
  glowBrass: "0 0 28px rgba(135,180,227,0.14)",
  focusRing: "0 0 0 3px rgba(135,180,227,0.45)",

  // motion — one vocabulary for every transition in the app
  easeOut: "cubic-bezier(0.16, 1, 0.3, 1)",
  easeSpring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  easeStd: "cubic-bezier(0.4, 0, 0.2, 1)",
  durFast: "0.12s",
  durBase: "0.2s",
  durSlow: "0.32s",
};

// ── Shared style fragments — spread these, then override locally as needed ──
//
// The `card` and `sectionLabel` fragments that used to live here are GONE, not
// rewritten: `card` put a 1px border AND shadowCard on ~forty surfaces at once
// (the language forbids a border and a box-shadow on the same element), and
// `sectionLabel` was a hand-rolled 11px uppercase run. Both are the kit's now —
// `className="card"` and `className="t-label"` — so there is no local copy left
// for either violation to drift back into.

// The kit's .field: one well, no outline, 12px radius, 44px minimum. Call sites
// render `className="field"`; what stays here is the same material for the few
// inputs that need a non-standard footprint (the DNA numeric spinners, the
// time pickers) and would look wrong at 44px.
export const inputBase = {
  width: "100%",
  padding: "10px 14px",
  background: T.subtle,
  border: "none",
  borderRadius: "12px",
  fontSize: "14px",
  color: T.ink,
  outline: "none",
  boxSizing: "border-box",
};

// Selects have no kit primitive of their own — .field's 44px floor would double
// the height of the outreach toolbar, which is a one-line scroller on a phone.
// They take the kit's field MATERIAL (well, no outline, 12px radius) at the
// compact footprint the toolbar was built around.
export const selectBase = {
  background: T.subtle,
  border: "none",
  borderRadius: "12px",
  padding: "7px 11px",
  fontSize: "12px",
  color: T.muted,
  cursor: "pointer",
  outline: "none",
  fontFamily: T.fontBody,
};

// One severity vocabulary for BOTH domains — analyst findings and outreach
// signals read the same colors for the same meanings.
export const SEV = {
  critical: T.red,
  warning: T.amber,
  info: T.muted,
  pass: T.green,
};
