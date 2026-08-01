// The bridge's contract in one file: a GPT request must come back looking
// exactly like a Claude one, because nine call sites parse only that shape.
// Each test below is a way the translation can be wrong while still "working".
import { describe, it, expect } from "vitest";
import {
  isOpenAIModel,
  toOpenAIRequest,
  toAnthropicResponse,
  toAnthropicStream,
} from "../openai.mjs";

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

/** Feed an OpenAI SSE script through the translator and collect the Anthropic
 *  events a browser would parse out the other side. */
async function translate(chunks, model = "gpt-5") {
  const enc = new TextEncoder();
  const upstream = new ReadableStream({
    start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); },
  });
  const out = toAnthropicStream(upstream, model);
  const reader = out.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.split("\n").find((l) => l.startsWith("data:")).slice(5)));
}

describe("model routing", () => {
  it("recognises GPT ids", () => expect(isOpenAIModel("gpt-5")).toBe(true));
  it("leaves Claude ids to the Anthropic path", () => expect(isOpenAIModel("claude-opus-5")).toBe(false));
  it("an unlisted id is not silently accepted", () => expect(isOpenAIModel("gpt-9-turbo")).toBe(false));
});

describe("request translation", () => {
  it("system prompt becomes the first message", () => {
    const { request } = toOpenAIRequest({ model: "gpt-5", system: "be terse", messages: [] });
    expect(request.messages[0]).toEqual({ role: "system", content: "be terse" });
  });

  // The mistake this exists to catch: folding tool results into the user turn.
  // The model then sees a question it already answered, calls the tool again,
  // and bills twice per turn.
  it("tool results become their own tool messages, keyed to the call", () => {
    const { request } = toOpenAIRequest({
      model: "gpt-5",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "lookup", input: { q: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }] },
      ],
    });
    expect(request.messages[0].tool_calls[0].id).toEqual("t1");
    expect(request.messages[0].tool_calls[0].function.arguments).toEqual('{"q":"x"}');
    expect(request.messages[1]).toEqual({ role: "tool", tool_call_id: "t1", content: "42" });
  });

  it("an assistant turn that is only tool calls sends null, not empty string", () => {
    const { request } = toOpenAIRequest({
      model: "gpt-5",
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "n", input: {} }] }],
    });
    expect(request.messages[0].content).toBeNull();
  });

  it("client tools translate; server tools are reported, not faked", () => {
    const { request, strippedServerTools } = toOpenAIRequest({
      model: "gpt-5",
      messages: [],
      tools: [
        { name: "lookup", description: "d", input_schema: { type: "object" } },
        { type: "web_search_20250305", name: "web_search" },
      ],
    });
    expect(request.tools).toHaveLength(1);
    expect(request.tools[0].function.name).toEqual("lookup");
    expect(strippedServerTools).toEqual(["web_search"]);
  });

  it("asks for usage on streams, since the spend meter depends on it", () => {
    const { request } = toOpenAIRequest({ model: "gpt-5", messages: [], stream: true });
    expect(request.stream_options).toEqual({ include_usage: true });
  });
});

describe("buffered response translation", () => {
  it("text and tool calls arrive as Anthropic blocks", () => {
    const out = toAnthropicResponse({
      id: "x", model: "gpt-5",
      choices: [{ finish_reason: "tool_calls", message: { content: "hi", tool_calls: [{ id: "c1", function: { name: "lookup", arguments: '{"q":1}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    });
    expect(out.content).toEqual([
      { type: "text", text: "hi" },
      { type: "tool_use", id: "c1", name: "lookup", input: { q: 1 } },
    ]);
    // The agent loop keys continue-vs-stop off exactly this string.
    expect(out.stop_reason).toEqual("tool_use");
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
  });

  it("malformed tool arguments degrade to {} rather than throwing", () => {
    const out = toAnthropicResponse({
      choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "c1", function: { name: "n", arguments: "{oops" } }] } }],
    });
    expect(out.content[0].input).toEqual({});
  });
});

describe("stream translation", () => {
  it("emits a well-formed Anthropic message envelope", async () => {
    const events = await translate([
      sse({ choices: [{ delta: { content: "he" } }] }),
      sse({ choices: [{ delta: { content: "llo" } }] }),
      sse({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      "data: [DONE]\n\n",
    ]);
    const types = events.map((e) => e.type);
    expect(types[0]).toEqual("message_start");
    expect(types.at(-1)).toEqual("message_stop");
    expect(types).toContain("content_block_start");
    expect(types).toContain("content_block_stop");
    const text = events.filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("");
    expect(text).toEqual("hello");
    expect(events.find((e) => e.type === "message_delta").delta.stop_reason).toEqual("end_turn");
  });

  // Text is block 0 and tool calls start at 1. If a tool call landed on 0 it
  // would overwrite the text block in the client's assembler and the reply would
  // vanish.
  it("tool calls never collide with the text block index", async () => {
    const events = await translate([
      sse({ choices: [{ delta: { content: "thinking" } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "lookup", arguments: '{"q"' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] }),
      sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ]);
    const start = events.find((e) => e.type === "content_block_start" && e.content_block.type === "tool_use");
    expect(start.index).toEqual(1);
    expect(start.content_block.name).toEqual("lookup");
    const json = events.filter((e) => e.delta?.type === "input_json_delta").map((e) => e.delta.partial_json).join("");
    expect(JSON.parse(json)).toEqual({ q: 1 });
    expect(events.find((e) => e.type === "message_delta").delta.stop_reason).toEqual("tool_use");
  });

  it("a half-written frame does not throw", async () => {
    const events = await translate(['data: {"choices":[{"delta"', sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })]);
    expect(events.at(-1).type).toEqual("message_stop");
  });
});
