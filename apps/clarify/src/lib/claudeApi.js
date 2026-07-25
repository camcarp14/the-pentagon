import { ANTHROPIC_API_KEY } from "../config.js";
import { obs } from "./store.js";
import { functionAuthHeaders } from "./supabase.js";
// Pricing moved to @cc/ai. This file's copy fell back to Sonnet for an unknown
// model while ZTS's three copies fell back to Haiku — the same call logged a 3x
// different cost depending on which module happened to make it, and neither knew
// Opus at all (15x). Re-exported so existing importers keep working.
import { MODEL_PRICING, estimateCost } from "@cc/ai";

export { MODEL_PRICING, estimateCost };

// ─── Observability — every Claude call in this system logs here ──────────────
// No backend yet, so this lives client-side. Once Langfuse or similar is wired
// to a deployed agent backend, this same log shape carries over directly.

// ─── callClaude — the ONE seam every Claude request flows through ────────────
// Deployed traffic always rides the Netlify proxy (server-side key); the raw
// VITE_ANTHROPIC_API_KEY is only ever touched on localhost. Routing, headers,
// and observability logging live here and nowhere else. Returns { ok, data,
// text, error } and never throws — call sites keep their own parsing/fallbacks.
export async function callClaude({ model, max_tokens, system, messages, fn, promptChars = 0 }) {
  const deployed = window.location.hostname !== "localhost";
  const url = deployed ? "/.netlify/functions/claude" : "https://api.anthropic.com/v1/messages";
  const headers = deployed
    ? { "Content-Type": "application/json", ...(await functionAuthHeaders()) }
    : {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        ...(Array.isArray(system) ? { "anthropic-beta": "prompt-caching-2024-07-31" } : {}),
        "anthropic-dangerous-direct-browser-access": "true",
      };
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST", headers,
      body: JSON.stringify({ model, max_tokens, ...(system ? { system } : {}), messages }),
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || null;
    const inTok = data.usage?.input_tokens || Math.round(promptChars / 4);
    const outTok = data.usage?.output_tokens || (text ? Math.round(text.length / 4) : 0);
    obs.log({ fn, model, inputTokens: inTok, outputTokens: outTok, costEstimate: estimateCost(model, inTok, outTok), latencyMs: Date.now() - t0, ok: res.ok && !!text });
    return { ok: res.ok, data, text, error: res.ok ? null : (data.error?.message || "API error") };
  } catch (e) {
    obs.log({ fn, model, ok: false, latencyMs: Date.now() - t0 });
    return { ok: false, data: null, text: null, error: e.message || "Network error" };
  }
}
