// ═══════════════════════════════════════════════════════════════════════════
// ANTHROPIC — the server-side model call for scheduled engines.
//
// NOT the same path as netlify/functions/claude.js. That one is a proxy for the
// browser and gates on a signed-in session, which is correct for it and useless
// here: a scheduled engine has no session and never will. This calls the API
// directly with the server key, and is only ever reached from a function that
// has already passed the containment guard.
//
// COST IS RETURNED, NOT ESTIMATED LATER. Every call hands back the real token
// usage priced through @cc/ai, so the caller can pass an accurate figure to the
// audit log and the hourly spend cap. A cap fed a guess is a cap that does not
// hold.
//
// TIMEOUT IS A HARD ARCHITECTURAL CONSTRAINT. Scheduled functions get 30
// seconds total. A generation call that hangs takes the whole pass down with it,
// including the run-closing write the circuit breaker counts.
// ═══════════════════════════════════════════════════════════════════════════
import { estimateCost, isKnownModel } from '@cc/ai';

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

// Leaves ~8s of the 30s budget for the audit write, the draft insert, and
// closing the run — all of which must still happen if this returns slowly.
const TIMEOUT_MS = 22_000;

/** Sonnet is the default: the work is long-form drafting where quality matters
 *  and volume is a few calls a day, so the cheaper tier is a false economy. */
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

export function anthropicKey() {
  const key = process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_ENV_MISSING: ANTHROPIC_API_KEY — engines stay off until set');
  return key;
}

/**
 * One completion. Returns { text, model, usage, costUsd }.
 *
 * Named throws for every failure class — an engine that cannot tell "rate
 * limited" from "bad key" from "overloaded" cannot decide whether retrying is
 * sane, and will either hammer a dead key or give up on a transient blip.
 */
export async function complete({
  system, prompt, model = DEFAULT_MODEL, maxTokens = 4000, temperature = 1,
}, key = anthropicKey()) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('ANTHROPIC_PROMPT_EMPTY');
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': VERSION },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctl.signal,
    });
  } catch (ex) {
    if (ex.name === 'AbortError') throw new Error(`ANTHROPIC_TIMEOUT: no response in ${TIMEOUT_MS}ms`);
    throw new Error(`ANTHROPIC_UNREACHABLE: ${ex.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) throw new Error('ANTHROPIC_UNAUTHORIZED: key rejected');
  if (res.status === 429) throw new Error('ANTHROPIC_RATE_LIMITED');
  if (res.status === 529) throw new Error('ANTHROPIC_OVERLOADED');
  if (!res.ok) throw new Error(`ANTHROPIC_HTTP_${res.status}: ${(await res.text()).slice(0, 300)}`);

  const body = await res.json();
  const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new Error('ANTHROPIC_EMPTY_RESPONSE');

  const usage = body.usage || {};
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;

  // An unrecognised model still gets priced — at the worst-case rate, per the
  // @cc/ai fallback rule — so a model id typo cannot make spend invisible.
  if (!isKnownModel(model)) {
    console.warn(`[anthropic] unpriced model "${model}" — charging worst-case rate`);
  }

  return {
    text,
    model: body.model || model,
    usage: { inputTokens: inTok, outputTokens: outTok },
    costUsd: estimateCost(model, inTok, outTok),
  };
}

/**
 * A completion constrained to one JSON object.
 *
 * Models wrap JSON in prose and fences no matter how firmly they are asked not
 * to, so rather than trusting the instruction this extracts the outermost
 * braces and parses that. Throws a named error on failure instead of returning
 * a half-parsed object, because a silently-empty draft is worse than a failed
 * pass — it looks like the engine ran.
 */
export async function completeJSON(opts, key = anthropicKey()) {
  const result = await complete({
    ...opts,
    prompt: `${opts.prompt}\n\nRespond with a single valid JSON object and nothing else. No markdown fence, no commentary.`,
  }, key);

  const raw = result.text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(`ANTHROPIC_JSON_MISSING: no object in ${raw.length} chars`);
  }

  let data;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch (ex) {
    throw new Error(`ANTHROPIC_JSON_INVALID: ${ex.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('ANTHROPIC_JSON_NOT_OBJECT');
  }
  return { ...result, data };
}
