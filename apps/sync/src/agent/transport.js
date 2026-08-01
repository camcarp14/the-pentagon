// ─── Transport ───────────────────────────────────────────────────────────────
// One function talks to the model: `stream()`. It resolves where to send the
// request, opens an SSE stream, assembles the content blocks as they arrive,
// and reports partial text to the caller so speech can begin before the
// sentence is finished.
//
// Routing, in order:
//   1. The Pentagon proxy → /.netlify/functions/claude-stream, same origin, with
//      the caller's Supabase session on the Authorization header. This is the
//      normal path: no browser ever holds an Anthropic key.
//   2. A key in this browser, on localhost only → api.anthropic.com direct.
//      A local-dev escape hatch for working without `netlify dev` running, not a
//      production route.
// That order is the inverse of what it used to be. Previously a key in
// localStorage won and the proxy was the fallback, which meant the secret sat in
// a place any script on the page could read. Now a signed-in user with no key at
// all is the ordinary case, not an error state.

// Two vendors, one list. The picker in Settings renders whatever is here, and
// the proxy accepts whatever it recognises — so adding a model is one line in
// this array plus one line in netlify/functions/lib/openai.mjs (which is the
// authority, since a browser list can be edited from devtools and the server's
// can't).
//
// GPT models reach the same /.netlify/functions/claude-stream endpoint and come
// back in the same Anthropic event shape; nothing downstream of `stream()`
// knows or cares which vendor answered. `vendor` here exists only so the UI can
// group and label them honestly.
//
// ONE CAPABILITY GAP, and it is worth knowing before you switch mid-task: the
// web_search server tool is Anthropic-only. On a GPT model it is dropped by the
// proxy rather than emulated, so the model answers from what it was given. Your
// own client-side tools work identically on both.
export const MODELS = [
  { key: "haiku", id: "claude-haiku-4-5", vendor: "claude", label: "Haiku", blurb: "Fastest. Best for a running conversation." },
  { key: "sonnet", id: "claude-sonnet-5", vendor: "claude", label: "Sonnet", blurb: "The daily driver — fast, and it plans well." },
  { key: "opus", id: "claude-opus-5", vendor: "claude", label: "Opus", blurb: "Deepest reasoning. Reach for it on hard calls." },
  { key: "gpt", id: "gpt-5", vendor: "openai", label: "GPT-5", blurb: "OpenAI's flagship — a second opinion on hard calls." },
  { key: "gpt-mini", id: "gpt-5-mini", vendor: "openai", label: "GPT-5 mini", blurb: "OpenAI, cheap and quick. No web search." },
];

export const modelId = (key) => (MODELS.find((m) => m.key === key) || MODELS[1]).id;

/** Which vendor a picker key lands on. Used for the Settings label, and for the
 *  one honest caveat the UI has to show (no web search off Anthropic). */
export const modelVendor = (key) => (MODELS.find((m) => m.key === key) || MODELS[1]).vendor;

// $ per million tokens. These drive the spend *estimate* on Settings only —
// nothing in the app depends on them being exact. One place to correct.
//
// Keep in step with packages/ai/pricing.js, which is the cross-tool table the
// System hub sums and the hourly cost cap is enforced against. This copy exists
// because SYNC keys spend by picker key, not model id.
export const RATES = {
  haiku: { in: 1, out: 5 },
  sonnet: { in: 3, out: 15 },
  opus: { in: 5, out: 25 },
  gpt: { in: 1.25, out: 10 },
  "gpt-mini": { in: 0.25, out: 2 },
};

export function estimateCost(modelKey, inTok, outTok) {
  const r = RATES[modelKey] || RATES.sonnet;
  return (inTok / 1e6) * r.in + (outTok / 1e6) * r.out;
}

// Relative on purpose: SYNC and the function ship from the same Netlify site,
// so the request is same-origin and there is no CORS preflight to survive.
export const PROXY_URL = "/.netlify/functions/claude-stream";
const DIRECT_URL = "https://api.anthropic.com/v1/messages";

// The test environment's window shim may have no `location`, and this module is
// imported by node-environment tests. Never touch it at module scope, and never
// assume the pieces exist.
function isLocalDev() {
  try {
    const host = (typeof window !== "undefined" && window.location && window.location.hostname) || "";
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".local");
  } catch {
    return false;
  }
}

// Imported lazily, inside the request path. @cc/supabase reads import.meta.env
// and builds a client the moment it is evaluated; a module-scope import would
// drag that into every node-environment test that merely imports this file.
async function sessionToken() {
  try {
    const { supabase } = await import("@cc/supabase");
    const { data } = (await supabase?.auth.getSession()) || { data: {} };
    return data?.session?.access_token || "";
  } catch {
    return "";   // no session, or no Supabase configured — the proxy will say so
  }
}

export class TransportError extends Error {
  constructor(message, { kind = "unknown", status = 0, retryable = false } = {}) {
    super(message);
    this.name = "TransportError";
    // "session" | "forbidden" | "noproxy" | "auth" | "rate" | "overloaded"
    // | "server" | "network" | "badrequest" | "unknown"
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
  }
}

function classify(status, message = "", { viaProxy = false, errorType = "" } = {}) {
  const m = message.toLowerCase();
  const t = String(errorType || "").toLowerCase();

  if (viaProxy) {
    // With a proxy in front, the browser holds no key at all, so none of these
    // can mean "your API key is wrong". 401 is the Pentagon SESSION, 403 is the
    // account, 503 is the deploy's missing key. And no substring matching here:
    // the proxy forwards Anthropic's body verbatim, so a phrase like "api key"
    // in an upstream message describes the SERVER's key and would otherwise send
    // the user to Settings to fix something they don't own.
    if (status === 401) return { kind: "session", retryable: false };
    if (status === 403) return { kind: "forbidden", retryable: false };
    // Anthropic signals overload with 529; a 503 with its overload type is the
    // only way that status arrives from upstream rather than from our function.
    if (status === 503 && t !== "overloaded_error") return { kind: "noproxy", retryable: false };
  } else if (status === 401 || status === 403 || m.includes("api key") || m.includes("authentication")) {
    // Direct to Anthropic, the key IS the credential, so the old reading holds.
    return { kind: "auth", retryable: false };
  }

  if (status === 429) return { kind: "rate", retryable: true };
  if (status === 529 || status === 503 || m.includes("overloaded") || t === "overloaded_error") {
    return { kind: "overloaded", retryable: true };
  }
  if (status >= 500) return { kind: "server", retryable: true };
  if (status === 400) return { kind: "badrequest", retryable: false };
  return { kind: "unknown", retryable: false };
}

/** A short, human sentence for each failure — shown next to a working retry. */
export function explain(err) {
  if (!(err instanceof TransportError)) return err?.message || "Something went wrong.";
  switch (err.kind) {
    // Every sentence below names something the reader can actually do. The
    // three proxy kinds are each a different person's job to fix, which is the
    // reason they are separate kinds at all.
    case "session": return "Your Pentagon session expired. Sign in again, then send it once more — the message is still here.";
    case "forbidden": return "This account isn't allowed to use SYNC. Sign in with the operator account.";
    case "noproxy": return err.message || "This deployment has no Anthropic key configured, so SYNC can't reach Claude. Set ANTHROPIC_API_KEY in the site's environment variables and redeploy.";
    case "auth": return "That API key was rejected. Check it in Settings — keys start with sk-ant-.";
    case "rate": return "Rate limited by the API. Give it a few seconds.";
    case "overloaded": return "The model is overloaded right now. Worth another try.";
    case "server": return "The API had a server error. Not your side.";
    case "network": return "Couldn't reach the API. Check the connection.";
    case "badrequest": return err.message || "The request was rejected.";
    default: return err.message || "Something went wrong.";
  }
}

/* ── SSE line parsing ──────────────────────────────────────────────────────── */
// Anthropic sends `event: <name>` / `data: <json>` pairs separated by blank
// lines. Chunk boundaries land anywhere, so the buffer is carried across reads.
// Exported for scripts/stream-smoke.mjs — the assembler is the one piece of
// this file that can be tested without a network, and it is also the piece
// most likely to break silently.
export function* parseSSE(buffer) {
  let idx;
  while ((idx = buffer.value.indexOf("\n\n")) !== -1) {
    const raw = buffer.value.slice(0, idx);
    buffer.value = buffer.value.slice(idx + 2);
    let data = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data || data === "[DONE]") continue;
    try { yield JSON.parse(data); } catch { /* a partial frame; the API doesn't send them, but never throw on one */ }
  }
}

/* ── block assembly ────────────────────────────────────────────────────────── */
// Turns the delta stream back into the `content` array the Messages API expects
// to receive on the next turn. Every block type survives the round trip —
// including server-side ones like web_search_tool_result, which must be echoed
// back verbatim or the model loses its own citations.
export function makeAssembler() {
  const blocks = [];
  return {
    start(index, block) {
      blocks[index] = { ...block };
      if (block.type === "text") blocks[index].text = block.text || "";
      if (block.type === "thinking") blocks[index].thinking = block.thinking || "";
      if (block.type === "tool_use" || block.type === "server_tool_use") blocks[index]._json = "";
    },
    delta(index, delta) {
      const b = blocks[index];
      if (!b) return "";
      switch (delta.type) {
        case "text_delta": b.text = (b.text || "") + delta.text; return delta.text;
        case "input_json_delta": b._json += delta.partial_json; return "";
        case "thinking_delta": b.thinking = (b.thinking || "") + delta.thinking; return "";
        case "signature_delta": b.signature = delta.signature; return "";
        default: return "";
      }
    },
    stop(index) {
      const b = blocks[index];
      if (!b) return;
      if (b._json !== undefined) {
        try { b.input = b._json ? JSON.parse(b._json) : {}; }
        catch { b.input = {}; b._parseFailed = true; }
        delete b._json;
      }
    },
    content() {
      return blocks.filter(Boolean).map(({ _json, _parseFailed, ...b }) => b);
    },
    failures() {
      return blocks.filter((b) => b && b._parseFailed).map((b) => b.name);
    },
  };
}

/* ── the call ──────────────────────────────────────────────────────────────── */
/**
 * @param {object}   o
 * @param {string}   o.system         system prompt
 * @param {Array}    o.messages       Messages API message list
 * @param {Array}    o.tools          tool definitions (client + server)
 * @param {string}   o.modelKey       "haiku" | "sonnet" | "opus"
 * @param {number}   o.maxTokens
 * @param {string}   o.apiKey         local-dev escape hatch only; ignored off localhost
 * @param {function} o.onText         (chunk, fullText) => void, called as text streams
 * @param {function} o.onToolStart    (name) => void, called when a tool block opens
 * @param {AbortSignal} o.signal
 * @returns {Promise<{content: Array, stopReason: string, usage: object}>}
 */
export async function stream({
  system, messages, tools = [], modelKey = "sonnet", maxTokens = 2048,
  apiKey = "", onText, onToolStart, signal,
}) {
  // A key only wins on localhost. In production the proxy is the path, whether
  // or not someone once pasted a key into Settings — shipping a key to the
  // browser is the exact thing this rewrite removed.
  const direct = !!apiKey && isLocalDev();
  const url = direct ? DIRECT_URL : PROXY_URL;

  const headers = { "content-type": "application/json" };
  if (direct) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    // Anthropic requires this header to opt in to browser-origin requests.
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else {
    // The proxy's credential is the user's Pentagon session, not a key. Sending
    // nothing when there's no session is deliberate: the 401 that comes back is
    // more honest than a request this client refused to make.
    const token = await sessionToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }

  const body = { model: modelId(modelKey), max_tokens: maxTokens, messages, stream: true };
  if (system) body.system = system;
  if (tools.length) body.tools = tools;

  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new TransportError("Network request failed", { kind: "network", retryable: true });
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    let errorType = "";
    try {
      const j = await res.json();
      detail = j?.error?.message || j?.message || detail;
      errorType = j?.error?.type || "";
    } catch { /* non-JSON error body; the status is the whole story */ }
    // Nothing answering at that path means the function isn't deployed — the
    // same dead end as a deploy with no key, and the same person fixes it.
    if (!direct && (res.status === 404 || res.status === 405)) {
      throw new TransportError(`No streaming proxy is deployed at ${PROXY_URL}. Deploy the site's Netlify functions, or run against localhost with a key in Settings.`, { kind: "noproxy", status: res.status });
    }
    const c = classify(res.status, detail, { viaProxy: !direct, errorType });
    throw new TransportError(detail, { ...c, status: res.status });
  }

  const asm = makeAssembler();
  let stopReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let full = "";

  // A proxy that buffers the stream hands back plain JSON. Handle that shape
  // rather than failing — the turn still completes, it just arrives at once.
  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("event-stream") || !res.body) {
    const j = await res.json();
    if (j?.error) throw new TransportError(j.error.message || "Request failed", classify(200, j.error.message || "", { viaProxy: !direct, errorType: j.error.type || "" }));
    const content = j.content || [];
    const text = content.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (text && onText) onText(text, text);
    return { content, stopReason: j.stop_reason || "end_turn", usage: j.usage || usage };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const buffer = { value: "" };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer.value += decoder.decode(value, { stream: true });
    for (const ev of parseSSE(buffer)) {
      switch (ev.type) {
        case "message_start":
          usage = { ...usage, ...(ev.message?.usage || {}) };
          break;
        case "content_block_start":
          asm.start(ev.index, ev.content_block);
          if (ev.content_block?.type === "tool_use") onToolStart?.(ev.content_block.name);
          if (ev.content_block?.type === "server_tool_use") onToolStart?.(ev.content_block.name || "web_search");
          break;
        case "content_block_delta": {
          const chunk = asm.delta(ev.index, ev.delta || {});
          if (chunk) { full += chunk; onText?.(chunk, full); }
          break;
        }
        case "content_block_stop":
          asm.stop(ev.index);
          break;
        case "message_delta":
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          if (ev.usage) usage = { ...usage, ...ev.usage };
          break;
        case "error":
          throw new TransportError(ev.error?.message || "Stream error", classify(500, ev.error?.message || "", { viaProxy: !direct, errorType: ev.error?.type || "" }));
        default:
          break;
      }
    }
  }

  return { content: asm.content(), stopReason: stopReason || "end_turn", usage, malformedTools: asm.failures() };
}
