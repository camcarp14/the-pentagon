// ═══════════════════════════════════════════════════════════════════════════
// OPENAI BRIDGE — speaks Anthropic on both sides, OpenAI in the middle.
//
// WHY A TRANSLATION LAYER AND NOT A SECOND CLIENT. Every AI surface in this
// repo (SYNC's agent loop, Clarify, ZTS, Looper) already speaks one wire
// format: the Anthropic Messages shape — `{ model, system, messages, tools,
// max_tokens }` in, `{ content: [...blocks], stop_reason, usage }` or the
// Anthropic SSE event stream out. Nine call sites and their tests are built on
// it. Adding a second format would mean nine `if (provider === ...)` branches
// in the browser, and nine places to get wrong.
//
// So the format stays. This module makes GPT models *fit* it: request in →
// OpenAI Chat Completions; OpenAI response/stream → Anthropic blocks/events.
// The client cannot tell which vendor answered, which is the entire point —
// flipping the model picker changes one string and nothing else.
//
// WHAT DOES NOT SURVIVE THE ROUND TRIP, stated plainly rather than discovered:
//   • Anthropic *server* tools (web_search) have no OpenAI equivalent. They are
//     dropped, not faked — a stripped tool the model never calls is a feature
//     that quietly stops working, so `strippedServerTools` reports what went.
//   • `thinking` blocks are Anthropic-only. GPT reasoning tokens are billed but
//     not emitted; they show up in usage, never as content.
//   • Anthropic content blocks carry an index; OpenAI tool calls carry an index
//     too, but numbered separately from text. Text is always block 0 here and
//     tool calls start at 1, so the assembler's indices stay stable.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The GPT models this deployment will pay for. EDIT THIS LIST to add one —
 * it is the server-side ceiling, and unlike the browser's copy it cannot be
 * changed from devtools. Ids are passed through to OpenAI verbatim, so a typo
 * here surfaces as OpenAI's own "model not found", not as a silent fallback to
 * something more expensive.
 */
export const OPENAI_MODELS = new Set([
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
]);

export const isOpenAIModel = (model) => OPENAI_MODELS.has(model);

/** Anthropic stop_reason ← OpenAI finish_reason. `tool_calls` → `tool_use` is
 *  the load-bearing one: SYNC's agent loop keys its continue/stop decision off
 *  exactly that string. */
const STOP_REASON = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "stop_sequence",
};
const stopReason = (r) => STOP_REASON[r] || "end_turn";

/* ── request: Anthropic shape → OpenAI Chat Completions ───────────────────── */

// Anthropic puts tool results in a *user* message as `tool_result` blocks.
// OpenAI wants them as their own `role: "tool"` messages, one per result, each
// carrying the id of the call it answers. This is the single most common way a
// naive port breaks: fold the results into the user turn and the model sees a
// question it already answered, loops, and bills you twice.
function convertMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: "system", content: typeof system === "string" ? system : blocksToText(system) });

  for (const m of messages || []) {
    const content = m?.content;

    if (typeof content === "string") {
      out.push({ role: m.role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (m.role === "user") {
      const results = content.filter((b) => b?.type === "tool_result");
      for (const r of results) {
        out.push({
          role: "tool",
          tool_call_id: r.tool_use_id,
          content: typeof r.content === "string" ? r.content : blocksToText(r.content),
        });
      }
      const rest = content.filter((b) => b?.type !== "tool_result");
      if (rest.length) out.push({ role: "user", content: blocksToText(rest) });
      continue;
    }

    // assistant
    const text = blocksToText(content);
    const calls = content
      .filter((b) => b?.type === "tool_use")
      .map((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
    // An assistant turn with tool calls may legitimately have no text. OpenAI
    // rejects `content: ""` alongside tool_calls on some models, so send null.
    const msg = { role: "assistant", content: text || (calls.length ? null : "") };
    if (calls.length) msg.tool_calls = calls;
    out.push(msg);
  }
  return out;
}

/** Flatten a content-block array to plain text. Non-text blocks that have no
 *  OpenAI equivalent (images excepted below) are dropped rather than stringified
 *  — `[object Object]` in a prompt is worse than a missing sentence. */
function blocksToText(blocks) {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  return blocks.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n");
}

/**
 * @param {object} body Anthropic-shaped request body
 * @returns {{ request: object, strippedServerTools: string[] }}
 */
export function toOpenAIRequest(body) {
  const strippedServerTools = [];
  const tools = [];

  for (const t of body?.tools || []) {
    // Anthropic server tools arrive as `{ type: "web_search_20250305", name }`
    // with no input_schema. There is nothing to translate — OpenAI would have to
    // run them, and it can't.
    if (!t?.input_schema) { strippedServerTools.push(t?.name || t?.type || "unknown"); continue; }
    tools.push({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema,
      },
    });
  }

  const request = {
    model: body.model,
    messages: convertMessages(body.system, body.messages),
    // `max_tokens` is deprecated on the newer chat models in favour of
    // `max_completion_tokens`; the new name is accepted by all of them.
    max_completion_tokens: body.max_tokens || 3000,
    stream: !!body.stream,
  };
  if (tools.length) request.tools = tools;
  if (typeof body.temperature === "number") request.temperature = body.temperature;
  // Usage is not sent on streamed responses unless you ask for it, and the
  // spend meter in System depends on it.
  if (request.stream) request.stream_options = { include_usage: true };

  return { request, strippedServerTools };
}

/* ── response: OpenAI → Anthropic ─────────────────────────────────────────── */

/** Non-streaming. Returns the exact envelope `claude.js` callers already parse. */
export function toAnthropicResponse(json) {
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];

  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const c of msg.tool_calls || []) {
    let input = {};
    try { input = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; } catch { input = {}; }
    content.push({ type: "tool_use", id: c.id, name: c.function?.name, input });
  }

  return {
    id: json?.id,
    type: "message",
    role: "assistant",
    model: json?.model,
    content,
    stop_reason: stopReason(choice.finish_reason),
    usage: {
      input_tokens: json?.usage?.prompt_tokens || 0,
      output_tokens: json?.usage?.completion_tokens || 0,
    },
  };
}

/**
 * Streaming. Consumes OpenAI's SSE and emits Anthropic's, so the browser's
 * existing `parseSSE` + `makeAssembler` handle GPT output with no change at all.
 *
 * Block indices: text is always 0; each distinct tool call gets 1, 2, 3…
 * OpenAI numbers its tool_calls from 0 independently of text, so the +1 offset
 * is what keeps the two numbering schemes from colliding on index 0.
 *
 * @param {ReadableStream} upstream OpenAI response body
 * @param {string} model
 * @returns {ReadableStream} Anthropic-shaped SSE
 */
export function toAnthropicStream(upstream, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const send = (controller, obj) =>
    controller.enqueue(encoder.encode(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`));

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      let buffer = "";
      let textOpen = false;
      const tools = new Map(); // openai tool index → { blockIndex, id, name }
      let finish = "stop";
      let usage = { input_tokens: 0, output_tokens: 0 };

      send(controller, {
        type: "message_start",
        message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model, content: [], stop_reason: null, usage },
      });

      const closeBlocks = () => {
        if (textOpen) { send(controller, { type: "content_block_stop", index: 0 }); textOpen = false; }
        for (const t of tools.values()) send(controller, { type: "content_block_stop", index: t.blockIndex });
        tools.clear();
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let data = "";
            for (const line of raw.split("\n")) if (line.startsWith("data:")) data += line.slice(5).trim();
            if (!data || data === "[DONE]") continue;

            let ev;
            try { ev = JSON.parse(data); } catch { continue; }

            if (ev.usage) {
              usage = {
                input_tokens: ev.usage.prompt_tokens || 0,
                output_tokens: ev.usage.completion_tokens || 0,
              };
            }

            const choice = ev.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finish = choice.finish_reason;
            const delta = choice.delta || {};

            if (delta.content) {
              if (!textOpen) {
                send(controller, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
                textOpen = true;
              }
              send(controller, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta.content } });
            }

            for (const call of delta.tool_calls || []) {
              const key = call.index ?? 0;
              let t = tools.get(key);
              if (!t) {
                t = { blockIndex: key + 1, id: call.id || `call_${key}`, name: call.function?.name || "" };
                tools.set(key, t);
                send(controller, {
                  type: "content_block_start",
                  index: t.blockIndex,
                  content_block: { type: "tool_use", id: t.id, name: t.name, input: {} },
                });
              }
              if (call.function?.arguments) {
                send(controller, {
                  type: "content_block_delta",
                  index: t.blockIndex,
                  delta: { type: "input_json_delta", partial_json: call.function.arguments },
                });
              }
            }
          }
        }
      } catch (err) {
        // A stream that dies mid-flight must still terminate the blocks it
        // opened, or the client waits forever on a message that never stops.
        closeBlocks();
        send(controller, { type: "error", error: { type: "api_error", message: String(err?.message || err) } });
        controller.close();
        return;
      }

      closeBlocks();
      send(controller, {
        type: "message_delta",
        delta: { stop_reason: stopReason(finish) },
        usage: { output_tokens: usage.output_tokens },
      });
      send(controller, { type: "message_stop" });
      controller.close();
    },
  });
}
