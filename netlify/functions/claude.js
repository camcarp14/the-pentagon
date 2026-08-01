// netlify/functions/claude.js
// Buffered LLM proxy - keeps vendor keys server-side.
//
// Despite the filename this now routes to either Anthropic or OpenAI, chosen by
// the `model` field on the request. The name stays because eight call sites and
// their tests post to /.netlify/functions/claude and expect one JSON envelope
// back — the Anthropic Messages shape. That envelope is what every caller in
// this repo parses, so the GPT path is translated into it rather than exposing a
// second response format. See lib/openai.mjs.
//
// This is a v1 CommonJS handler, unlike the v2 claude-stream.mjs next door,
// which is why the ESM bridge is loaded with a dynamic import inside the
// handler: a top-level `require` of an .mjs file throws under CJS.

const { requireAuth } = require("./_shared/requireAuth.cjs");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  // Open proxy otherwise — anyone with the URL could spend the model budget.
  const auth = await requireAuth(event);
  if (!auth.ok) return { statusCode: auth.status, body: JSON.stringify({ error: auth.error }) };

  try {
    const body = JSON.parse(event.body);
    const { isOpenAIModel, toOpenAIRequest, toAnthropicResponse } = await import("./lib/openai.mjs");
    const gpt = isOpenAIModel(body?.model);

    // 503, not 500: "this deploy has no key for that vendor" is a configuration
    // fact with one fix, and the message has to name the variable to set. A
    // deploy holding only one of the two keys still serves that vendor normally.
    const key = gpt
      ? process.env.OPENAI_API_KEY
      : process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY;
    if (!key) {
      const name = gpt ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
      return {
        statusCode: 503,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: {
            type: "config_error",
            message: `This deployment has no ${name} configured. Set it in the site's environment variables and redeploy, or pick a model from the other provider.`,
          },
        }),
      };
    }

    const res = await fetch(
      gpt ? "https://api.openai.com/v1/chat/completions" : "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: gpt
          ? { "Content-Type": "application/json", Authorization: `Bearer ${key}` }
          : { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(gpt ? toOpenAIRequest(body).request : body),
      },
    );

    const data = await res.json();
    return {
      statusCode: res.status,
      headers: { "Content-Type": "application/json" },
      // Errors pass through untranslated — both vendors use `{ error: { message } }`,
      // and paraphrasing an upstream failure is how the real cause gets lost.
      body: JSON.stringify(gpt && res.ok ? toAnthropicResponse(data) : data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
