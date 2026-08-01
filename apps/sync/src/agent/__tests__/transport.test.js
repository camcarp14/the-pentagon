// The transport turns a byte stream back into the exact `content` array the
// Messages API expects to receive on the next turn. If block assembly is wrong,
// a turn either loses its tool call or loses its citations — both silently.
// This exercises it against a synthetic stream, with chunk boundaries in the
// worst possible places.

import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll } from "vitest";
import { installBrowserEnv } from "../../test/env.js";

installBrowserEnv();

const {
  parseSSE, makeAssembler, stream, MODELS, modelId, estimateCost, explain, TransportError,
} = await import("../transport.js");

/* ── the model registry ────────────────────────────────────────────────────── */
describe("the model registry", () => {
  // Not a count. The registry grew from three to five when the proxy learned to
  // speak OpenAI, and it will grow again — asserting a number just means editing
  // this line every time. What has to stay true is that every offered model is
  // fully specified: a row missing `id` picks nothing, and a row missing
  // `vendor` breaks the Settings sheet's per-vendor grouping silently.
  it("every offered model is complete", () =>
    MODELS.forEach((m) => {
      expect(typeof m.key).toBe("string");
      expect(typeof m.id).toBe("string");
      expect(typeof m.label).toBe("string");
      expect(["claude", "openai"]).toContain(m.vendor);
    }));
  it("picker keys are unique", () => expect(new Set(MODELS.map((m) => m.key)).size).toEqual(MODELS.length));
  // Every model must be priceable, or the spend meter reports a cross-vendor
  // total that quietly omits whichever one is missing.
  it("every model has a rate", () => MODELS.forEach((m) => expect(estimateCost(m.key, 1e6, 1e6) > 0).toBe(true)));
  it("both vendors are reachable from the picker", () => {
    const vendors = new Set(MODELS.map((m) => m.vendor));
    expect(vendors.has("claude")).toBe(true);
    expect(vendors.has("openai")).toBe(true);
  });
  it("sonnet is the default fallback", () => expect(modelId("nonsense")).toEqual("claude-sonnet-5"));
  it("haiku id", () => expect(modelId("haiku")).toEqual("claude-haiku-4-5"));
  it("opus id", () => expect(modelId("opus")).toEqual("claude-opus-5"));
  it("cost estimate is positive", () => expect(estimateCost("sonnet", 1e6, 1e6) > 0).toBe(true));
  it("cost of nothing is nothing", () => expect(estimateCost("sonnet", 0, 0)).toEqual(0));
});

/* ── every failure has a sentence a person can act on ──────────────────────── */
describe("every failure has a sentence a person can act on", () => {
  // `nokey` was dropped in the move: with the key server-side, "you have no
  // key" stopped being a thing that can happen. It was left in this loop and
  // still passed — explain() has no case for it, so it fell through to the
  // default and the assertion (a non-empty string) was satisfied by a sentence
  // that answers a different question. A check that cannot fail is worse than
  // no check, so the dead kind is out and the three real new ones are in.
  const KINDS = ["session", "forbidden", "noproxy", "auth", "rate", "overloaded", "server", "network", "badrequest"];

  for (const kind of KINDS) {
    it(`${kind} explains itself`, () => {
      const msg = explain(new TransportError("the raw detail from the API", { kind }));
      expect(typeof msg === "string" && msg.length > 10).toBe(true);
    });
  }

  it("every kind explain() knows about is covered here", () => {
    // The loop above only proves the kinds it names. This proves the list is
    // the whole list: any future kind added to explain() without a sentence
    // here fails, instead of quietly inheriting the default.
    const src = readFileSync(new URL("../transport.js", import.meta.url), "utf8");
    const cases = [...src.matchAll(/case "([a-z]+)": return "|case "([a-z]+)": return err\.message/g)]
      .map((m) => m[1] || m[2]);
    const explained = cases.filter((k) => !["text_delta", "input_json_delta", "thinking_delta", "signature_delta"].includes(k));
    for (const k of explained) expect(KINDS).toContain(k);
  });

  it("a kind explain() does not know falls back rather than throwing", () => {
    expect(() => explain(new TransportError("x", { kind: "not-a-real-kind" }))).not.toThrow();
  });
});

/* ── SSE framing ───────────────────────────────────────────────────────────── */
describe("SSE framing", () => {
  const buf = { value: "event: a\ndata: {\"type\":\"one\"}\n\nevent: b\ndata: {\"type\":\"two\"}\n\ndata: {\"type\":\"par" };
  let events;

  beforeAll(() => { events = [...parseSSE(buf)]; });

  it("two whole frames parsed", () => expect(events.map((e) => e.type)).toEqual(["one", "two"]));
  it("the partial frame stayed in the buffer", () => expect(buf.value).toEqual("data: {\"type\":\"par"));

  // A frame that arrives split across reads must survive being reassembled.
  describe("a frame split across reads", () => {
    let completed;

    beforeAll(() => {
      buf.value += "tial\"}\n\n";
      completed = [...parseSSE(buf)].map((e) => e.type);
    });

    it("the split frame completes", () => expect(completed).toEqual(["partial"]));
  });

  // Malformed JSON must never throw — it would take the whole turn down.
  describe("malformed JSON", () => {
    const bad = { value: "data: {not json}\n\ndata: {\"type\":\"fine\"}\n\n" };

    it("malformed frames are skipped, not thrown", () => expect([...parseSSE(bad)].map((e) => e.type)).toEqual(["fine"]));
  });
});

/* ── block assembly ────────────────────────────────────────────────────────── */
describe("block assembly", () => {
  const asm = makeAssembler();
  let content;

  beforeAll(() => {
    asm.start(0, { type: "text", text: "" });
    asm.delta(0, { type: "text_delta", text: "Booked. " });
    asm.delta(0, { type: "text_delta", text: "Two till four." });
    asm.stop(0);

    asm.start(1, { type: "tool_use", id: "tu_1", name: "schedule_block", input: {} });
    // Tool arguments arrive as JSON fragments that are individually invalid.
    asm.delta(1, { type: "input_json_delta", partial_json: '{"title":"Cl' });
    asm.delta(1, { type: "input_json_delta", partial_json: 'ient call","st' });
    asm.delta(1, { type: "input_json_delta", partial_json: 'art":"14:00"}' });
    asm.stop(1);

    asm.start(2, { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://example.com", title: "A source" }] });
    asm.stop(2);

    content = asm.content();
  });

  it("three blocks assembled", () => expect(content.length).toEqual(3));
  it("text was concatenated", () => expect(content[0].text).toEqual("Booked. Two till four."));
  it("tool input parsed from fragments", () => expect(content[1].input).toEqual({ title: "Client call", start: "14:00" }));
  it("the tool id survived", () => expect(content[1].id).toEqual("tu_1"));
  it("the server-tool block survived verbatim", () => expect(content[2].content[0].url).toEqual("https://example.com"));
  it("internal scratch fields are stripped", () => expect(!("_json" in content[1])).toBe(true));
  it("nothing was flagged malformed", () => expect(asm.failures()).toEqual([]));

  // Truncated tool JSON must degrade to an empty object and be reported, not
  // crash the turn.
  describe("truncated tool JSON", () => {
    const broken = makeAssembler();

    beforeAll(() => {
      broken.start(0, { type: "tool_use", id: "tu_2", name: "add_tasks", input: {} });
      broken.delta(0, { type: "input_json_delta", partial_json: '{"tasks":[{"tit' });
      broken.stop(0);
    });

    it("truncated tool input becomes an empty object", () => expect(broken.content()[0].input).toEqual({}));
    it("the failure is reported", () => expect(broken.failures()).toEqual(["add_tasks"]));
  });

  // Thinking blocks pass through with their signature intact.
  describe("thinking blocks", () => {
    const thinking = makeAssembler();

    beforeAll(() => {
      thinking.start(0, { type: "thinking", thinking: "" });
      thinking.delta(0, { type: "thinking_delta", thinking: "weighing it" });
      thinking.delta(0, { type: "signature_delta", signature: "sig123" });
      thinking.stop(0);
    });

    it("thinking text assembled", () => expect(thinking.content()[0].thinking).toEqual("weighing it"));
    it("thinking signature kept", () => expect(thinking.content()[0].signature).toEqual("sig123"));
  });

  // A delta for a block that never opened must be ignored rather than throw.
  describe("a delta for a block that never opened", () => {
    const orphan = makeAssembler();

    it("an orphan delta is ignored", () => expect(orphan.delta(9, { type: "text_delta", text: "x" })).toEqual(""));
    it("an orphan stop is ignored", () => expect(orphan.stop(9)).toEqual(undefined));
  });
});

/* ── the whole call, against a fake API ────────────────────────────────────── */
const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done. "}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Two till four."}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

function sseResponse(text, { chunkSize = 7 } = {}) {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) { controller.close(); return; }
      // Deliberately tiny chunks: every frame is split, most mid-token.
      controller.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let seenRequest = null;

describe("the whole call, against a fake API", () => {
  const chunks = [];
  let result;
  let sent;

  beforeAll(async () => {
    globalThis.fetch = async (url, init) => {
      seenRequest = { url, init };
      return sseResponse(SSE);
    };

    result = await stream({
      system: "sys",
      messages: [{ role: "user", content: "book it" }],
      tools: [{ name: "schedule_block", description: "d", input_schema: { type: "object" } }],
      modelKey: "sonnet",
      apiKey: "sk-ant-test",
      onText: (chunk) => chunks.push(chunk),
    });

    sent = JSON.parse(seenRequest.init.body);
  });

  it("the streamed text is complete", () => expect(result.content[0].text).toEqual("Done. Two till four."));
  it("stop reason captured", () => expect(result.stopReason).toEqual("end_turn"));
  it("input tokens captured", () => expect(result.usage.input_tokens).toEqual(120));
  it("output tokens captured", () => expect(result.usage.output_tokens).toEqual(42));
  it("text arrived incrementally", () => expect(chunks.join("")).toEqual("Done. Two till four."));
  it("more than one chunk was delivered", () => expect(chunks.length >= 2).toBe(true));

  it("a local key routes direct to Anthropic", () => expect(seenRequest.url.startsWith("https://api.anthropic.com")).toBe(true));
  it("the browser-access header is set", () => expect(seenRequest.init.headers["anthropic-dangerous-direct-browser-access"]).toEqual("true"));
  it("the key is sent", () => expect(seenRequest.init.headers["x-api-key"]).toEqual("sk-ant-test"));

  it("streaming was requested", () => expect(sent.stream).toEqual(true));
  it("the model id was resolved", () => expect(sent.model).toEqual("claude-sonnet-5"));
  it("tools were sent", () => expect(sent.tools.length).toEqual(1));
});

/* ── no key routes to the proxy ────────────────────────────────────────────── */
describe("no key routes to the proxy", () => {
  beforeAll(async () => {
    globalThis.fetch = async (url, init) => { seenRequest = { url, init }; return sseResponse(SSE); };
    await stream({ messages: [{ role: "user", content: "x" }], apiKey: "" });
  });

  // PORT NOTE — the only assertion in these six suites whose expected VALUE had
  // to change. The original asserted "/.netlify/functions/claude"; the Pentagon
  // build of transport.js renamed the proxy to `claude-stream` and made it the
  // primary route rather than the fallback. The property being tested — a
  // request with no local key goes to the same-origin proxy, not to Anthropic —
  // is unchanged, so the check is kept under its original name.
  it("no key routes to the proxy", () => expect(seenRequest.url).toEqual("/.netlify/functions/claude-stream"));
  it("the proxy request carries no key header", () => expect(!("x-api-key" in seenRequest.init.headers)).toBe(true));
});

/* ── a buffering proxy that returns plain JSON still works ─────────────────── */
describe("a buffering proxy that returns plain JSON still works", () => {
  let buffered;

  beforeAll(async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "buffered reply" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    buffered = await stream({ messages: [{ role: "user", content: "x" }], apiKey: "k" });
  });

  it("a non-streamed response is handled", () => expect(buffered.content[0].text).toEqual("buffered reply"));
  it("its stop reason is read", () => expect(buffered.stopReason).toEqual("end_turn"));
});

/* ── errors are typed, not swallowed ───────────────────────────────────────── */
describe("errors are typed, not swallowed", () => {
  let caught = null;

  describe("a 401", () => {
    beforeAll(async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401, headers: { "content-type": "application/json" } });
      caught = null;
      try { await stream({ messages: [], apiKey: "bad" }); } catch (e) { caught = e; }
    });

    it("a 401 is classified as auth", () => expect(caught?.kind).toEqual("auth"));
    it("an auth error is not retryable", () => expect(caught.retryable).toEqual(false));
    it("the auth explanation points at Settings", () => expect(/Settings/.test(explain(caught))).toBe(true));
  });

  describe("a 429", () => {
    beforeAll(async () => {
      globalThis.fetch = async () => new Response("{}", { status: 429, headers: { "content-type": "application/json" } });
      caught = null;
      try { await stream({ messages: [], apiKey: "k" }); } catch (e) { caught = e; }
    });

    it("a 429 is classified as rate", () => expect(caught?.kind).toEqual("rate"));
    it("a rate limit is retryable", () => expect(caught.retryable).toEqual(true));
  });

  // A missing proxy, when we chose the proxy because there was no key, is a
  // "you need a key" problem — not a mysterious 404.
  describe("a missing proxy", () => {
    beforeAll(async () => {
      globalThis.fetch = async () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
      caught = null;
      try { await stream({ messages: [], apiKey: "" }); } catch (e) { caught = e; }
    });

    // PORT NOTE — same cause as the proxy-URL note above. In SYNC a 404 from the
    // proxy meant "you have no key", kind "nokey". The Pentagon build holds the
    // key server-side, so a 404 there means the function isn't deployed, and the
    // kind was renamed to "noproxy" with a message naming the fix. `nokey` is
    // now a dead kind: explain() has no case for it and falls to the default.
    it("a missing proxy reads as noproxy", () => expect(caught?.kind).toEqual("noproxy"));
  });

  describe("a dead connection", () => {
    beforeAll(async () => {
      globalThis.fetch = async () => { throw new Error("boom"); };
      caught = null;
      try { await stream({ messages: [], apiKey: "k" }); } catch (e) { caught = e; }
    });

    it("a dead connection is classified as network", () => expect(caught?.kind).toEqual("network"));
  });
});
