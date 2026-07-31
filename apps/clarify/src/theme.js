// ─── Clarify design tokens — "Brass on midnight" ─────────────────────────────
// The dark rebuild keeps every token NAME and its meaning (ink = primary text,
// surface = card, line = hairline) and flips the VALUES, so call sites already
// on T.* converted for free. Direction: a night trading-desk — deep blue-black
// canvas, the brand's brass re-cut brighter for dark contrast, signal colors
// at 400-series so they read without glare. The brass identity and the dual
// "desk lamp" radial glow are the signature carried over from the light era.
//
// Contrast floor (AA, verified): ink ≈14:1 on surface · muted ≈6:1 · gold ≈7:1
// · signal badges ≥4.5:1 · textOnBrand ≈8:1 on the CTA gradient.
export const T = {
  // brand — brass
  gold: "#C9A557",
  goldHi: "#E3C27E",
  goldDeep: "#8F7434",
  goldGrad: "linear-gradient(135deg, #E3C27E 0%, #A9853C 100%)",
  goldSoft: "rgba(201,165,87,0.10)",
  goldLine: "rgba(201,165,87,0.30)",
  textOnBrand: "#151005",           // dark text on brass CTAs (white-on-gold died with the light theme)

  // ink & text (ink = primary text color)
  ink: "#E9EDF5",
  inkDeep: "#F7F9FC",
  inkBrand: "#F3E9D2",
  muted: "#94A1B5",
  faint: "#66738A",
  ghost: "#525E74",
  placeholder: "#5A6780",

  // canvas
  bg: "#0B0F1A",
  surface: "#141B2C",
  subtle: "#0F1626",                // wells & inputs sit BELOW surface on dark
  raised: "#1B2438",                // hover/raised layer above surface
  line: "rgba(255,255,255,0.085)",
  lineSoft: "rgba(255,255,255,0.055)",
  lineInk: "rgba(255,255,255,0.07)",

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

  // elevation — on dark, height = lighter surface + hairline + true shadow depth
  shadowCard: "0 1px 2px rgba(0,0,0,0.45), 0 6px 20px rgba(0,0,0,0.30), 0 0 0 1px rgba(255,255,255,0.045)",
  shadowTab: "0 1px 2px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.35)",
  shadowHover: "0 6px 16px rgba(0,0,0,0.45), 0 16px 40px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.07)",
  shadowPopover: "0 10px 28px rgba(0,0,0,0.55), 0 2px 10px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.06)",
  shadowModal: "0 32px 90px rgba(0,0,0,0.7), 0 8px 28px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)",
  shadowFloat: "0 12px 44px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)",
  glowBrass: "0 0 28px rgba(201,165,87,0.14)",   // the lamp glow — hero moments only
  focusRing: "0 0 0 3px rgba(201,165,87,0.45)",

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
