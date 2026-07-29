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
  it("never pairs the API-key scheme word with a JWT", () => {
    // `["token", key]` is the documented subprotocol form for a permanent API
    // key, and it is what every Deepgram browser example on the internet
    // shows. Handing it a temporary JWT instead is the single likeliest
    // explanation for the 401s people report with temporary tokens — the
    // scheme word has to match the kind of credential. This is the one form
    // that must never appear.
    expect(client).not.toMatch(/\[\s*["']token["']\s*,/);
  });

  it("offers all three documented forms, SDK-proven one first", () => {
    // Order is evidence, not taste. ["bearer", jwt] is what Deepgram's own JS
    // SDK emits (src/CustomClient.ts), so it leads; the two query-parameter
    // forms are documented fallbacks. A browser reports a refused handshake
    // and a dropped connection identically — both 1006, no status — so there
    // is no way to diagnose the wrong choice from the client. Trying all three
    // costs a reconnect; guessing once costs a dead microphone.
    const forms = client.slice(client.indexOf("const AUTH_FORMS"), client.indexOf("let provenForm"));
    expect(forms).toMatch(/protocols: \["bearer", token\]/);
    expect(forms).toMatch(/access_token: token/);
    expect(forms).toMatch(/authorization: `bearer \$\{token\}`/);
    expect(forms.indexOf("protocols:")).toBeLessThan(forms.indexOf("access_token:"));
  });

  it("spells the subprotocol scheme in lowercase", () => {
    // The case flips between the two places it appears, and subprotocol
    // entries are matched as exact strings: the HTTP header is `Bearer` with
    // a capital B, the WebSocket subprotocol is lowercase `bearer`. Writing
    // the header spelling here fails the handshake with no usable error.
    expect(client).not.toMatch(/\[\s*["']Bearer["']/);
  });

  it("only passes a protocols argument for the form that has one", () => {
    // `new WebSocket(url, undefined)` is not reliably the same as
    // `new WebSocket(url)`, so the two calls stay separate.
    expect(client).toMatch(/auth\.protocols \? new WebSocket\(url, auth\.protocols\) : new WebSocket\(url\)/);
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

describe("interface parity with the Web Speech recognizer", () => {
  // The bug this exists to prevent, in full: createDeepgramRecognizer's
  // docstring said "same shape as createRecognizer()" and was wrong — it had no
  // mode(). VoiceProvider.talk() opens with `if (rec.mode() === "capturing")`,
  // so every tap on the orb threw TypeError before reaching capture(), inside a
  // click handler with no error boundary. Nothing was logged, nothing was
  // rendered, the button just did nothing. It read as a dead microphone and
  // cost a full round of debugging in the wrong place.
  //
  // A comment claiming two objects match is not a contract. This is.
  const iface = (src) => {
    const body = src.slice(src.lastIndexOf("return {"));
    const names = new Set();
    // `foo() {`, `foo: () =>`, `foo: value`
    for (const m of body.matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*)\s*(\(|:)/gm)) names.add(m[1]);
    return names;
  };

  const speech = readFileSync(join(here, "..", "recognizer.js"), "utf8");
  // The no-op stub returned when the browser has no engine — the most complete
  // written-out list of the interface in the codebase.
  const stub = speech.slice(speech.indexOf("supported: false"), speech.indexOf("supported: false") + 400);
  const required = [...stub.matchAll(/([a-zA-Z][a-zA-Z0-9]*)\s*:/g)].map((m) => m[1]);

  it("found the stub to compare against", () => {
    expect(required).toContain("mode");
    expect(required.length).toBeGreaterThanOrEqual(7);
  });

  it("implements every member the Web Speech recognizer exposes", () => {
    const mine = iface(clientSrc);
    expect([...required].filter((k) => !mine.has(k))).toEqual([]);
  });

  it("reports wake-word listening, not any-socket-open", () => {
    // VoiceProvider calls listening() to decide whether switching ambient off
    // has anything to stop. Returning `wanted` would also be true mid
    // push-to-talk and would cut a held utterance short.
    expect(clientSrc).toMatch(/listening: \(\) => ambient/);
  });
});

describe("the tap can always move the machine", () => {
  it("resolves the mode before bailing on an empty utterance", () => {
    // The dead end this pins: VoiceProvider.talk() routes every tap on a
    // recognizer already in "capturing" into commitNow(). So if commit() can
    // return with mode still "capturing", the orb becomes permanently inert —
    // it looks like it is listening and no tap can change anything. Nothing
    // throws, nothing logs, the button just stops meaning anything.
    //
    // The Web Speech engine gets this right by accident of structure: ITS
    // settle() resolves the mode and commit() calls it before the empty-text
    // return. This one's settle() only clears the buffer, so the same early
    // return had to move below the mode handling.
    const body = clientSrc.slice(clientSrc.indexOf("function commit(text)"));
    const fn = body.slice(0, body.indexOf("\n  }"));
    const bail = fn.indexOf("if (!said) return");
    const resolves = fn.indexOf('setMode("off")');
    expect(bail).toBeGreaterThan(-1);
    expect(resolves).toBeGreaterThan(-1);
    expect(resolves).toBeLessThan(bail);
  });

  it("makes the thing that says 'tap' actually tappable", () => {
    // The user's report was literally "it won't let me even tap where it says
    // tap". They were aiming at the caption, which was a <span>. A control
    // whose label instructs an action has to accept that action, or the label
    // is a lie and the failure is invisible.
    const page = readFileSync(join(here, "..", "..", "pages", "ConsolePage.jsx"), "utf8");
    const block = page.slice(page.indexOf('className="utterance"'), page.indexOf('className="utterance"') + 700);
    expect(block).toMatch(/<button[\s\S]*className="u-hint"/);
    expect(block).toMatch(/onClick=\{voice\.busy \? voice\.stop : voice\.talk\}/);
  });

  it("says Connecting before it claims to be Listening", () => {
    // Opening the microphone, fetching a token and completing the handshake
    // all happen after the tap and any of them can hang. Calling that
    // "Listening…" made a dead connection and a silent room identical.
    const page = readFileSync(join(here, "..", "..", "pages", "ConsolePage.jsx"), "utf8");
    expect(page).toMatch(/voice\.mode === "starting" \? "Connecting…"/);
    expect(clientSrc).toMatch(/setMode\("starting"\)/);
    // ...and the promotion to a real listening state happens on the socket
    // opening, not on the tap.
    const open = clientSrc.slice(clientSrc.indexOf("ws.onopen"), clientSrc.indexOf("ws.onmessage"));
    expect(open).toMatch(/setMode\(ambient \? "ambient" : "capturing"\)/);
  });

  it("does not push a level update on every animation frame", () => {
    // `level` is a dependency of the context useMemo, so each setLevel
    // re-renders every consumer of useVoice(). At 60fps on a phone that is
    // enough to stop the tab answering taps. Silence returns a jittering
    // near-zero float, so an epsilon is needed as well as a rate cap —
    // without it React never bails out and every frame is a "change".
    const provider = readFileSync(join(here, "..", "VoiceProvider.jsx"), "utf8");
    expect(provider).toMatch(/PUSH_MS/);
    expect(provider).toMatch(/EPSILON/);
    expect(provider).toMatch(/Math\.abs\(v - lastValue\) >= EPSILON/);
  });
});

describe("microphone lifetime", () => {
  it("exposes its own level so nothing opens a second microphone", () => {
    // createMeter() in recognizer.js calls getUserMedia and builds a second
    // AudioContext. Harmless beside Web Speech, which holds no stream; beside
    // this engine it is a second concurrent capture, and iOS answers that by
    // sometimes starving the first — a socket that connects and carries
    // silence.
    expect(clientSrc).toMatch(/level\(\)\s*\{/);
    expect(clientSrc).toContain("createAnalyser");
    const provider = readFileSync(join(here, "..", "VoiceProvider.jsx"), "utf8");
    expect(provider).toMatch(/typeof own === "function"/);
  });

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
