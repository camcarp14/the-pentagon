// ─── Deepgram streaming recognition ──────────────────────────────────────────
// The replacement for Web Speech, and the reason SYNC can hear you in the
// installed app at all.
//
// Web Speech was never really an option on iOS: `SpeechRecognition` reports
// `service-not-allowed` from a home-screen app because iOS keeps that engine to
// Safari, and there is nothing an app can do about it. This path uses only
// getUserMedia and an AudioContext, both of which work in a standalone app, and
// sends audio to a transcription service that runs anywhere.
//
// Decisions worth knowing:
//
// RAW PCM, NOT MediaRecorder. MediaRecorder's container support splits along
// exactly the wrong line — Chrome gives webm/opus, Safari gives mp4/AAC, and
// fragmented MP4 does not stream cleanly. Capturing Float32 through an
// AudioWorklet and converting to linear16 sidesteps codecs entirely, so one
// code path serves every browser.
//
// NO RESAMPLING. Rather than downsample to a fixed 16 kHz — which means writing
// an interpolator and getting it subtly wrong — we ask the AudioContext for
// 16 kHz, read back whatever rate it actually chose, and tell Deepgram that
// number. Correct on hardware that honours the request and on hardware that
// ignores it.
//
// THE CREDENTIAL IS TRIED THREE WAYS. Browsers cannot set headers on a
// WebSocket, so Deepgram accepts the credential either through
// `Sec-WebSocket-Protocol` or on the query string — and the failure mode when
// you pick wrong is a bare 1006 close with no status, indistinguishable from a
// flaky connection. So connect() walks the documented forms in order of how
// good the evidence for each is, and remembers the first that completes a
// handshake. See AUTH_FORMS for what each one is and why it sits where it does.
//
// The credential is a 60-second token minted per connection by
// netlify/functions/deepgram-key.mjs. A WebSocket cannot be proxied through a
// Netlify function, so the browser has to hold something; this is the smallest
// something that works.

import { afterWake } from "./recognizer.js";

const ENDPOINT = "wss://api.deepgram.com/v1/listen";

// The worklet runs on the audio thread, so it does the format conversion and
// hands the main thread something already the right shape.
const WORKLET_SRC = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    // Float32 [-1,1] -> Int16. Clamp before scaling: a sample that overshoots
    // wraps to the opposite sign, which is heard as a click.
    const out = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
`;

// Every documented way to hand a browser WebSocket a Deepgram credential,
// strongest evidence first. A refused handshake is indistinguishable from a
// dropped connection here — both arrive as a 1006 close with no status — so
// guessing wrong once would leave a dead microphone and nothing to read. We
// try them in order and remember the winner.
//
// [0] is what Deepgram's own JS SDK does. From src/CustomClient.ts:
//         } else if (authHeader.startsWith("Bearer ")) {
//             // Access token: "Bearer TOKEN" -> ["bearer", "TOKEN"]
//             protocols.push("bearer", token);
//     Note the case flip, which is the whole trap: the HTTP header is
//     `Authorization: Bearer <jwt>` with a capital B, but the subprotocol
//     value is lowercase `bearer`. Subprotocol entries are matched as exact
//     strings, so `Bearer` fails where `bearer` succeeds.
//
//     There are scattered reports of temporary tokens failing this handshake
//     with a 401 while a permanent key succeeds. The likeliest explanation is
//     the neighbouring mistake — sending `["token", jwt]`, pairing the API-key
//     scheme word with a JWT — rather than anything wrong with subprotocols,
//     since the official SDK ships this exact code. Treated as unproven, which
//     is precisely why it is not the only option here.
//
// [1] and [2] are the query-parameter forms: the streaming reference documents
//     `authorization` taking a scheme-prefixed value, and `access_token` is the
//     form named in the reports above as the production workaround.
const AUTH_FORMS = [
  (token) => ({ protocols: ["bearer", token] }),
  (token) => ({ params: { access_token: token } }),
  (token) => ({ params: { authorization: `bearer ${token}` } }),
];

// Survives across recognizer instances: once a handshake completes we stop
// paying for the fallback dance on every reconnect.
let provenForm = null;

/** Is this browser capable of the capture path at all? */
export const supported =
  typeof window !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  !!(window.AudioContext || window.webkitAudioContext) &&
  typeof AudioWorkletNode !== "undefined";

async function mintToken() {
  const { supabase } = await import("../lib/supabase.js");
  const session = (await supabase?.auth.getSession())?.data?.session?.access_token;

  const res = await fetch("/.netlify/functions/deepgram-key", {
    method: "POST",
    headers: session ? { authorization: `Bearer ${session}` } : {},
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body?.error?.message || `Couldn't get a voice token (${res.status}).`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  if (!body?.token) throw new Error("The voice token endpoint returned nothing usable.");
  return body.token;
}

/**
 * Same shape as createRecognizer() in recognizer.js, so VoiceProvider does not
 * care which one it got.
 */
export function createDeepgramRecognizer({ onInterim, onCommit, onState, onError, getWake = () => "sync" }) {
  let ctx = null;
  let stream = null;
  let node = null;
  let socket = null;
  let analyser = null;
  let levelBins = null;

  let wanted = false;      // should we be listening at all
  let ambient = false;     // true = waiting for the wake word, false = every word counts
  let buffer = "";         // finalised text for the current utterance
  let armed = false;       // ambient only: the wake word has been heard
  let mode = "off";

  let connecting = false;  // a connect() is already in flight
  let formIx = 0;          // which AUTH_FORMS entry to try next
  let refusals = 0;        // consecutive handshakes that never opened

  const setMode = (m) => { mode = m; onState?.(m); };

  const settle = () => { buffer = ""; armed = false; onInterim?.(""); };

  function commit(text) {
    const said = text.trim();
    settle();

    // Resolve the mode FIRST, and unconditionally. Returning early on an empty
    // buffer used to leave mode stuck at "capturing", which was a dead end
    // there was no way out of: VoiceProvider.talk() routes every tap on a
    // capturing recognizer into commitNow(), so once nothing had been heard,
    // the orb sat there looking like it was listening and no further tap could
    // change anything. Nothing threw and nothing was logged — the button had
    // simply stopped meaning anything.
    //
    // An empty commit is not an error. It is what a tap-to-start/tap-to-stop
    // control does every time someone changes their mind, and it has to leave
    // the machine somewhere a tap can move it from.
    if (ambient) setMode("ambient");
    else { wanted = false; teardown(); setMode("off"); }

    if (!said) return;
    onCommit?.(said);
  }

  /** A finalised chunk from Deepgram — decide whether it belongs to us. */
  function absorb(text, speechFinal) {
    if (!text) return;

    if (ambient && !armed) {
      const { hit, rest } = afterWake(text, getWake());
      if (!hit) return;                 // not addressed to SYNC; drop it
      armed = true;
      setMode("capturing");
      buffer = rest;
    } else {
      buffer = `${buffer} ${text}`.trim();
    }

    onInterim?.(buffer);
    // speech_final is Deepgram's end-of-utterance signal, produced by its own
    // endpointing. It replaces the hand-rolled silence timer the Web Speech
    // path needed, and it is markedly better at not cutting off a pause for
    // breath mid-sentence.
    if (speechFinal && (!ambient || armed)) commit(buffer);
  }

  /**
   * Build the microphone graph. Idempotent, and deliberately separate from the
   * socket: a reconnect must NOT rebuild this.
   *
   * Two reasons. The cheap one is that the old code leaked — every reopen
   * created a fresh AudioContext and MediaStream over the top of the last ones
   * without stopping them, and iOS caps how many contexts a page may hold. The
   * real one is that a reconnect happens on a timer, with no user gesture in
   * scope, and iOS will not let a context created there leave the suspended
   * state. Keeping the graph alive across reconnects means the microphone is
   * only ever opened from the tap that asked for it.
   */
  async function ensureAudio() {
    if (node) return;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctx({ sampleRate: 16000 });
    // iOS starts every context suspended until a gesture unlocks it. start()
    // and capture() are both called from a tap, so this resolves.
    if (ctx.state === "suspended") await ctx.resume();

    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    const blob = new Blob([WORKLET_SRC], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    node = new AudioWorkletNode(ctx, "pcm-tap");
    // Reads `socket` fresh on every frame, so the graph outliving any one
    // connection is fine — audio captured while there is no open socket is
    // simply dropped.
    node.port.onmessage = (e) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(e.data);
    };
    const source = ctx.createMediaStreamSource(stream);
    source.connect(node);
    // Terminating into the destination keeps the node pulled by the graph. The
    // worklet writes nothing to its output, so this is silent — it does not
    // echo the microphone back out of the speaker.
    node.connect(ctx.destination);

    // The orb's level meter taps THIS graph rather than opening its own.
    // createMeter() in recognizer.js calls getUserMedia a second time and
    // builds a second AudioContext, which was harmless next to Web Speech
    // (that engine hands out no stream) but means two concurrent captures next
    // to this one. iOS is not reliable about that: the second request can
    // interrupt the first, which presents as a socket that connects happily
    // and then carries silence.
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);
    levelBins = new Uint8Array(analyser.frequencyBinCount);
  }

  function reportOpenFailure(e) {
    const name = e?.name || "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      onError?.({
        kind: "denied",
        message: "Microphone access is blocked for this site. On iPhone: Settings → Safari → Microphone → Ask, then reload. Permission is per-site, so a new address asks again even if you allowed the old one.",
      });
    } else if (name === "NotFoundError") {
      onError?.({ kind: "nomic", message: "No microphone found on this device." });
    } else {
      onError?.({ kind: "audio", message: e?.message || "Couldn't open the microphone." });
    }
  }

  async function connect() {
    if (socket || connecting || !wanted) return;
    connecting = true;

    let token;
    try {
      // Microphone first, token second: if permission is refused there is no
      // point spending a token, and the prompt appears while the tap that
      // triggered it is still the reason the user is looking at the screen.
      await ensureAudio();
      token = await mintToken();
    } catch (e) {
      connecting = false;
      wanted = false;
      teardown();
      setMode("off");
      if (e?.status) {
        onError?.({ kind: e.status === 503 ? "unconfigured" : "key", message: e.message });
      } else {
        reportOpenFailure(e);
      }
      return;
    }

    if (!wanted) { connecting = false; return; }

    const ix = provenForm ?? formIx;
    const auth = AUTH_FORMS[ix](token);
    const params = new URLSearchParams({
      model: "nova-3",
      encoding: "linear16",
      sample_rate: String(ctx.sampleRate),   // whatever we actually got
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      // 300ms of silence ends an utterance. Long enough to think mid-sentence,
      // short enough that the reply doesn't feel delayed.
      endpointing: "300",
      // Excludes this audio from Deepgram's Model Improvement Partnership
      // Program. Accounts are opted out by default, but that is an account
      // setting someone can flip in a console months from now — setting it
      // per request means the guarantee travels with the code rather than
      // depending on a checkbox nobody remembers. Deepgram documents that
      // opted-out audio is retained only for as long as it takes to process
      // the request, which is the strongest retention answer on offer.
      mip_opt_out: "true",
      ...(auth.params || {}),
    });

    // The subprotocol form passes a second argument; the query-parameter forms
    // must not pass one at all. `new WebSocket(url, undefined)` is not the same
    // as `new WebSocket(url)` in every engine, so the call is branched rather
    // than made conditional on a value.
    const url = `${ENDPOINT}?${params}`;
    const ws = auth.protocols ? new WebSocket(url, auth.protocols) : new WebSocket(url);
    socket = ws;
    connecting = false;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      refusals = 0;
      provenForm = ix;                  // this one works; stop trying the other
      setMode(ambient ? "ambient" : "capturing");
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type !== "Results") return;
      const alt = msg.channel?.alternatives?.[0];
      const text = alt?.transcript || "";
      if (!text) return;
      if (msg.is_final) absorb(text, !!msg.speech_final);
      else if (armed || !ambient) onInterim?.(`${buffer} ${text}`.trim());
    };

    // A browser will not tell us the HTTP status behind a refused upgrade — a
    // rejected handshake and a dropped cable both arrive as a 1006 close. So
    // onerror stays quiet and onclose does the reasoning, using "did we ever
    // open?" as the signal onerror can't give us.
    ws.onerror = () => {};

    ws.onclose = () => {
      if (socket !== ws) return;        // already superseded by teardown()
      socket = null;
      if (!wanted) return;

      if (!opened) {
        // Never opened. If we have not yet proven an auth form, the likeliest
        // cause is that we picked the wrong one — try the next before blaming
        // the network.
        if (provenForm === null && ix + 1 < AUTH_FORMS.length) {
          formIx = ix + 1;
          connect();
          return;
        }
        // Out of forms. Two strikes, then stop: retrying a refused handshake
        // forever would mint a token per attempt and never recover.
        if (++refusals >= 2) {
          wanted = false;
          teardown();
          setMode("off");
          onError?.({
            kind: "auth",
            message: "Deepgram refused the voice connection. The token was issued but rejected at the handshake — if this persists, the DEEPGRAM_API_KEY may belong to a different project than the one being billed.",
          });
          return;
        }
      }

      // A close we didn't ask for, while still wanted, is worth reopening —
      // and because Deepgram only checks the credential at the handshake, a
      // reconnect needs a fresh token rather than the expired one.
      setTimeout(() => { if (wanted && !socket) connect(); }, 400);
    };
  }

  /** Close the socket but leave the microphone graph standing. */
  function closeSocket() {
    if (!socket) return;
    const s = socket;
    socket = null;                      // clear first so onclose bails out
    s.onclose = null;
    s.onmessage = null;
    try { s.close(); } catch { /* already closing */ }
  }

  function teardown() {
    closeSocket();
    try { if (node?.port) node.port.onmessage = null; node?.disconnect(); } catch { /* already gone */ }
    node = null;
    try { analyser?.disconnect(); } catch { /* already gone */ }
    analyser = null;
    levelBins = null;
    try { for (const t of stream?.getTracks() || []) t.stop(); } catch { /* already gone */ }
    stream = null;
    try { ctx?.close(); } catch { /* already closed */ }
    ctx = null;
  }

  return {
    supported: true,

    /** Open the ear for the wake word and keep it open. */
    start() {
      ambient = true;
      wanted = true;
      settle();
      connect();
    },

    /** Close the ear entirely, including wake-word listening. */
    stop() {
      wanted = false;
      ambient = false;
      settle();
      teardown();
      setMode("off");
    },

    /** Push-to-talk: everything heard counts, no wake word needed. */
    capture() {
      ambient = false;
      armed = true;
      wanted = true;
      buffer = "";
      // "starting", not "capturing" — the microphone is not open yet and the
      // socket does not exist. Claiming to listen here is how an hour went
      // into debugging a microphone that was never the problem: the caption
      // said "Listening…" from the instant of the tap, so a failure to connect
      // and a failure to hear looked identical from the outside. ws.onopen
      // promotes this to "capturing" once there is genuinely an ear.
      setMode("starting");
      connect();
    },

    /** Commit whatever has been heard right now (push-to-talk release). */
    commitNow() {
      commit(buffer);
    },

    /** Drop the current command without running it. */
    cancel() {
      settle();
      if (ambient) setMode("ambient");
      else { wanted = false; teardown(); setMode("off"); }
    },

    /**
     * Current state: off | ambient | capturing.
     *
     * Its absence is what broke the orb. VoiceProvider.talk() opens with
     * `if (rec.mode() === "capturing")` to decide whether a tap starts a
     * capture or ends one — so on a recognizer without it, every tap threw
     * TypeError before reaching capture(), and threw it inside a click handler
     * where nothing renders the failure. The button simply did nothing, which
     * reads as a dead microphone rather than a missing method.
     */
    mode: () => mode,

    /**
     * Wake-word listening specifically, NOT "is anything open" — VoiceProvider
     * uses it to decide whether turning the ambient switch off has something to
     * stop. Returning `wanted` here would also report true mid push-to-talk and
     * cut a held utterance short.
     */
    listening: () => ambient,

    /** 0..1, weighted toward speech frequencies. Matches createMeter()'s curve
     *  so the orb behaves identically whichever engine is driving it. */
    level() {
      if (!analyser || !levelBins) return 0;
      analyser.getByteFrequencyData(levelBins);
      // Roughly 150Hz–3.5kHz across a 512-point FFT at typical sample rates —
      // the band where a voice actually lives, so keyboard noise moves it less.
      let sum = 0, n = 0;
      for (let i = 2; i < 44; i++) { sum += levelBins[i]; n++; }
      return Math.min(1, (sum / n / 255) * 2.1);
    },

    destroy() {
      wanted = false;
      teardown();
    },
  };
}
