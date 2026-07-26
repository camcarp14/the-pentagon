// ═══════════════════════════════════════════════════════════════════════════
// @cc/ops/direction — WHAT THE ENGINES ARE POINTED AT.
//
// The brief was "my input driving the direction, but don't overwhelm me with
// toggles." This module is the line between those two things.
//
// DIRECTION IS NOT SETTINGS. A setting is a knob you have to understand to
// operate the machine. Direction is the small set of facts only the operator
// knows — who this is for, what is being sold, what to talk about, how much per
// day. Everything downstream (tone calibration, topic selection, personalisation,
// scheduling, retries, dedupe) is the engine's job to figure out, not a field.
//
// So the rule for adding anything here: if the engine could work it out, or if a
// sensible default would be right 90% of the time, it does NOT belong in
// direction. That rule is what keeps this from becoming a settings page.
//
// FAIL SAFE, NOT FAIL LOUD. Unlike the guard, a missing or malformed direction
// must not throw — it means "not configured yet", which is the normal state on
// day one. Instead `ready` comes back false with a specific list of what is
// missing, and the engines decline to run and say why. An engine that ran
// against a half-filled direction would produce plausible-looking content aimed
// at nobody.
//
// Pure: no fetch, no Date.now(), no database.
// ═══════════════════════════════════════════════════════════════════════════

export const ENGINE = Object.freeze({
  CONTENT: "content",
  OUTBOUND: "outbound",
});

/** Settings keys these objects live under in app_settings. */
export const DIRECTION_KEY = Object.freeze({
  [ENGINE.CONTENT]: "direction.content",
  [ENGINE.OUTBOUND]: "direction.outbound",
});

// Caps that exist to stop a runaway from being expensive or reputation-damaging
// before anyone notices. These are ceilings on what direction may request — the
// operator can ask for less, never more.
export const HARD_MAX = Object.freeze({
  contentPerDay: 5,
  outboundPerDay: 40,
});

const str = (v) => (typeof v === "string" ? v.trim() : "");
const strList = (v) => {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\n,]/) : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const s = str(item);
    // Case-insensitive dedupe: "Seed phrases" and "seed phrases" are one topic,
    // and letting both through means the engine writes the same article twice.
    const k = s.toLowerCase();
    if (s && !seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out;
};

/** Clamp to [1, max]. A non-number, zero, or negative becomes the fallback
 *  rather than silently disabling the engine or, worse, becoming NaN — which
 *  compares false against every cap and would remove the ceiling entirely. */
function perDay(v, fallback, max) {
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

export const DEFAULT_CONTENT = Object.freeze({
  audience: "",
  product: "",
  topics: [],
  avoid: [],
  voice: "",
  perDay: 1,
  blogHandle: "",
});

export const DEFAULT_OUTBOUND = Object.freeze({
  icp: "",
  offer: "",
  geography: "",
  avoid: [],
  voice: "",
  perDay: 10,
});

/**
 * Normalise a stored direction object into the exact shape engines consume.
 *
 * Never throws and never returns null — a missing row is the same as an empty
 * one, because "not configured" and "configured with nothing" should behave
 * identically rather than being two code paths that drift apart.
 */
export function normalizeContent(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  return {
    audience: str(d.audience),
    product: str(d.product),
    topics: strList(d.topics),
    avoid: strList(d.avoid),
    voice: str(d.voice),
    perDay: perDay(d.perDay, DEFAULT_CONTENT.perDay, HARD_MAX.contentPerDay),
    blogHandle: str(d.blogHandle),
  };
}

export function normalizeOutbound(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  return {
    icp: str(d.icp),
    offer: str(d.offer),
    geography: str(d.geography),
    avoid: strList(d.avoid),
    voice: str(d.voice),
    perDay: perDay(d.perDay, DEFAULT_OUTBOUND.perDay, HARD_MAX.outboundPerDay),
  };
}

// The fields an engine genuinely cannot substitute a default for. Kept
// deliberately short — each entry is a question only the operator can answer,
// and every one added is another thing standing between them and output.
const REQUIRED = Object.freeze({
  [ENGINE.CONTENT]: [
    ["audience", "who the writing is for"],
    ["product", "what is being sold"],
    ["topics", "at least one topic to write about"],
  ],
  [ENGINE.OUTBOUND]: [
    ["icp", "the kind of business to contact"],
    ["offer", "what is being offered to them"],
  ],
});

/**
 * Is this direction complete enough to run on?
 *
 * Returns the missing pieces in plain English rather than a boolean, because
 * the UI shows this text directly and "direction incomplete" is not an
 * actionable thing to read at 7am.
 */
export function readiness(engine, direction) {
  const spec = REQUIRED[engine];
  if (!spec) return { ready: false, missing: [`unknown engine "${engine}"`] };

  const missing = [];
  for (const [field, label] of spec) {
    const v = direction ? direction[field] : undefined;
    const empty = Array.isArray(v) ? v.length === 0 : !str(v);
    if (empty) missing.push(label);
  }
  return { ready: missing.length === 0, missing };
}

/** Load + normalise + check in one call, since every engine does all three. */
export function resolveDirection(engine, raw) {
  const direction = engine === ENGINE.CONTENT ? normalizeContent(raw)
    : engine === ENGINE.OUTBOUND ? normalizeOutbound(raw)
    : null;
  if (!direction) return { direction: null, ready: false, missing: [`unknown engine "${engine}"`] };
  return { direction, ...readiness(engine, direction) };
}
