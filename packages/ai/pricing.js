// ═══════════════════════════════════════════════════════════════════════════
// @cc/ai — the ONE model-pricing source for The Pentagon.
//
// WHY THIS PACKAGE EXISTS. Five copies of this table existed across the app
// (ZTS App.jsx, ZTS dnaWorker.js, ZTS DnaView.jsx, Clarify claudeApi.js, Looper
// App.jsx) and they disagreed in two ways that produced wrong money:
//
//   • Four fell back to Haiku for an unknown model; Clarify's fell back to
//     Sonnet. Same input, 3x different answer depending on which module logged.
//   • Looper knew claude-opus-5 at $15/$75. None of the other four did, so any
//     of them pricing that model reported Haiku's $1/$5 — off by 15x.
//
// Those numbers are summed by the System hub into a single cross-tool "Total
// spend", and they are what a hard hourly cost cap is enforced against. A table
// that under-reports does not just misinform — it lets a run blow through its
// own budget ceiling.
//
// THE FALLBACK RULE. An unknown model prices at the MOST EXPENSIVE known rate,
// never the cheapest. The two failure directions are not symmetric: over-
// reporting pauses a run early, which is recoverable and visible. Under-
// reporting spends real money past a cap that was supposed to stop it. When the
// table is wrong we want it wrong in the direction that costs nothing.
//
// Prices are $ per 1,000,000 tokens and are ESTIMATES for guardrail arithmetic.
// Every surface that displays them says so.
// ═══════════════════════════════════════════════════════════════════════════

/** @typedef {{ in: number, out: number, label: string }} ModelPrice */

/** $ per 1M tokens. Add a model here and every tool prices it correctly. */
export const MODEL_PRICING = Object.freeze({
  "claude-haiku-4-5-20251001": { in: 1, out: 5, label: "Haiku 4.5" },
  "claude-sonnet-4-6": { in: 3, out: 15, label: "Sonnet 4.6" },
  "claude-opus-4-8": { in: 15, out: 75, label: "Opus 4.8" },
  "claude-opus-5": { in: 15, out: 75, label: "Opus 5" },
});

/** The priciest known rate — the deliberate fallback. Derived, never hardcoded,
 *  so adding a more expensive model automatically raises the safe default. */
const WORST_CASE = Object.values(MODEL_PRICING).reduce(
  (worst, p) => (p.out > worst.out ? p : worst),
  { in: 0, out: 0, label: "unknown" },
);

/** Exact price for a known model, or null. Use when you need to KNOW rather
 *  than estimate — e.g. to warn that a model is unrecognised. */
export function priceFor(model) {
  return MODEL_PRICING[model] ?? null;
}

export function isKnownModel(model) {
  return Object.prototype.hasOwnProperty.call(MODEL_PRICING, model);
}

/**
 * Estimated USD for one call. Unknown models price at WORST_CASE (see the
 * fallback rule above). Non-finite or negative token counts contribute 0 rather
 * than producing NaN — a NaN here poisons every downstream sum, and a cap
 * compared against NaN is always false, which silently disables the cap.
 */
export function estimateCost(model, inputTokens = 0, outputTokens = 0) {
  const p = MODEL_PRICING[model] ?? WORST_CASE;
  const i = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const o = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  return (i / 1e6) * p.in + (o / 1e6) * p.out;
}

/** Human label for a model id, for UI that shouldn't print raw ids. */
export function modelLabel(model) {
  return MODEL_PRICING[model]?.label ?? model ?? "unknown";
}
