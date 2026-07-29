// The voice path's contract with Deepgram.
//
// Every assertion here corresponds to a failure that actually happened in
// production, because none of them are catchable any other way: the whole path
// is a network call to a third party and a WebSocket handshake, so a wrong
// header scheme or a wrong parameter name compiles, deploys, and then fails
// silently on someone's phone with a 1006 close code and no explanation.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Source with its prose removed.
 *
 * The negative assertions below say "the code must not do this", and both
 * files explain at length what they used to do and why it was wrong. Scanning
 * raw text would make those explanations fail the tests they exist to justify
 * — and the obvious escape, deleting the explanation, is the worst outcome
 * available.
 *
 * Only whole-line comments are stripped. Chopping at the first `//` anywhere
 * would swallow every URL in the file from `https:` onward, which would let a
 * banned endpoint through by "removing" it.
 */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const clientSrc = readFileSync(join(here, "..", "deepgram.js"), "utf8");
const fnSrc = readFileSync(
  join(here, "..", "..", "..", "..", "..", "netlify", "functions", "deepgram-key.mjs"),
  "utf8",
);
const client = code(clientSrc);
const fn = code(fnSrc);

describe("the comment stripper itself", () => {
  // Every negative assertion below runs against `code()`'s output, so if it
  // ever over-strips they all pass by having nothing left to match — the exact
  // shape of a regression suite that proves nothing. These two checks make
  // that failure loud instead.
  it("leaves the code standing", () => {
    expect(fn).toContain("export default async (req)");
    expect(client).toContain("export function createDeepgramRecognizer");
    expect(fn.length).toBeGreaterThan(1200);
    expect(client.length).toBeGreaterThan(3000);
  });

  it("does not chop lines at the // inside a URL", () => {
    expect(fn).toContain("https://api.deepgram.com/v1/auth/grant");
    expect(client).toContain("wss://api.deepgram.com/v1/listen");
  });

  it("actually removes prose", () => {
    expect(clientSrc).toContain("Web Speech was never really an option on iOS");
    expect(client).not.toContain("Web Speech was never really an option on iOS");
  });
});

describe("credential minting (server)", () => {
  it("asks for a temporary token, not a new API key", () => {
    // The original design called POST /v1/projects/{id}/keys, which needs the
    // `keys:write` scope. A key holding that scope can mint permanent keys, so
    // the function was one bug away from being a key factory — and the
    // operator's key rightly didn't have it, which is how this surfaced: a 403
    // INSUFFICIENT_PERMISSIONS on every attempt to talk.
    expect(fn).toContain("https://api.deepgram.com/v1/auth/grant");
    expect(fn).not.toMatch(/projects\/\$\{[^}]+\}\/keys/);
    expect(fn).not.toContain("keys:write");
  });

  it("authenticates to the grant endpoint with Token, not Bearer", () => {
    // The two schemes are not interchangeable and this is the documented
    // trap: `Token` for the long-lived account key, `Bearer` for the JWT it
    // returns. Getting it backwards yields a 401 that reads exactly like a
    // wrong key.
    expect(fn).toMatch(/Authorization: `Token \$\{parent\}`/);
  });

  it("does not look up a project id", () => {
    // /auth/grant is account-wide — the token inherits the calling key's
    // project. The old GET /v1/projects lookup needed `project:read` on top of
    // everything else, so keeping it would have swapped one permission error
    // for another.
    expect(fn).not.toContain("/v1/projects");
  });

  it("survives a response with no expires_in", () => {
    // Deepgram's schema marks only access_token required. Reading expires_in
    // unguarded would ship `undefined` to the client as the expiry.
    expect(fn).toMatch(/expires_in \?\? TTL_SECONDS/);
  });

  it("keeps the token short-lived", () => {
    // Deepgram authenticates once, at the handshake, and lets an open stream
    // outlive its token — so a long TTL buys nothing and widens the window a
    // scraped token is useful in. If someone ever "fixes" a cut-off complaint
    // by raising this, they have misdiagnosed it.
    const ttl = /const TTL_SECONDS = (\d+);/.exec(fn);
    expect(ttl).not.toBeNull();
    expect(Number(ttl[1])).toBeLessThanOrEqual(120);
  });

  it("names the variable and the redeploy when it is unset", () => {
    // The 503 path is the operator's only signal, and "set it" alone is not
    // actionable: Netlify resolves function environment at deploy time, so a
    // variable added after the last build stays invisible until one runs.
    // That gap cost an afternoon.
    const unset = fn.slice(fn.indexOf("if (!parent)"), fn.indexOf("if (!parent)") + 600);
    expect(unset).toContain("DEEPGRAM_API_KEY");
    expect(unset).toMatch(/redeploy/i);
  });

  it("explains a permission refusal in console terms", () => {
    // What the operator saw on their phone was raw JSON, cut off mid-sentence
    // by the width of the error card. Naming the role and the console path is
    // the difference between a dead end and a fix.
    expect(fn).toMatch(/Member/);
    expect(fn).toMatch(/Deepgram console/i);
  });
});

describe("websocket authentication (client)", () => {
  it("never uses the subprotocol trick for the token", () => {
    // `new WebSocket(url, ["token", key])` is the documented way to pass an
    // API key from a browser, and it is reported broken for the short-lived
    // JWTs this path uses — same code, permanent key works, temporary token
    // 401s. Reaching for it again is the single most likely regression here,
    // because every Deepgram browser example on the internet shows it.
    expect(client).not.toMatch(/new WebSocket\([^)]*,\s*\[/);
  });

  it("puts the credential on the URL and can fall back to the other form", () => {
    // The reports disagree about the parameter name — `access_token` in the
    // fix for the failing handshake, `authorization` with a scheme prefix in
    // the query-parameter reference. Trying both costs one reconnect;
    // guessing wrong costs a dead microphone with no diagnosable symptom.
    expect(client).toContain("access_token: token");
    expect(client).toMatch(/authorization: `bearer \$\{token\}`/);
    expect(client).toContain("AUTH_FORMS");
  });

  it("remembers the form that worked", () => {
    expect(client).toMatch(/provenForm = ix/);
  });

  it("gives up rather than reconnecting forever on a refused handshake", () => {
    // Each attempt mints a token. An unbounded retry on a credential the
    // server will never accept is a loop that bills.
    expect(client).toMatch(/\+\+refusals >= 2/);
  });
});

describe("microphone lifetime", () => {
  it("builds the audio graph once, separately from the socket", () => {
    // Two bugs in one. The old code rebuilt the AudioContext and MediaStream
    // inside the reconnect path without stopping the previous ones, so every
    // reconnect leaked both — and iOS caps live contexts. Worse, a reconnect
    // fires on a timer with no user gesture in scope, and iOS will not let a
    // context created there leave the suspended state, so the reconnect that
    // was supposed to restore audio produced a silent one instead.
    expect(client).toMatch(/async function ensureAudio\(\)/);
    expect(client).toMatch(/if \(node\) return;/);
    // The socket teardown must not take the microphone with it.
    expect(client).toMatch(/function closeSocket\(\)/);
  });

  it("reads the live socket per frame rather than capturing one", () => {
    // The worklet handler outlives any single connection, so it has to consult
    // the current socket — a captured reference would send into a closed one
    // after the first reconnect.
    expect(client).toMatch(/socket\?\.readyState === WebSocket\.OPEN/);
  });

  it("asks for the microphone before spending a token", () => {
    const body = client.slice(client.indexOf("async function connect()"));
    expect(body.indexOf("await ensureAudio()")).toBeLessThan(body.indexOf("await mintToken()"));
  });
});
