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
// Two decisions worth knowing:
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
// The credential is a two-minute key minted per session by
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

/** Is this browser capable of the capture path at all? */
export const supported =
  typeof window !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  !!(window.AudioContext || window.webkitAudioContext) &&
  typeof AudioWorkletNode !== "undefined";

async function mintKey() {
  const { supabase } = await import("../lib/supabase.js");
  const token = (await supabase?.auth.getSession())?.data?.session?.access_token;

  const res = await fetch("/.netlify/functions/deepgram-key", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body?.error?.message || `Couldn't get a voice key (${res.status}).`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return (await res.json()).key;
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

  let wanted = false;      // should we be listening at all
  let ambient = false;     // true = waiting for the wake word, false = every word counts
  let buffer = "";         // finalised text for the current utterance
  let armed = false;       // ambient only: the wake word has been heard
  let mode = "off";

  const setMode = (m) => { mode = m; onState?.(m); };

  const settle = () => { buffer = ""; armed = false; onInterim?.(""); };

  function commit(text) {
    const said = text.trim();
    settle();
    if (!said) return;
    if (ambient) { setMode("ambient"); } else { setMode("off"); wanted = false; teardown(); }
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

  async function open() {
    if (socket || !wanted) return;

    let key;
    try {
      key = await mintKey();
    } catch (e) {
      wanted = false;
      setMode("off");
      onError?.({ kind: e.status === 503 ? "unconfigured" : "key", message: e.message });
      return;
    }
    if (!wanted) return;                // stopped while the key was in flight

    try {
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

      if (!wanted) { teardown(); return; }

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
      });

      // Deepgram takes the credential as a WebSocket subprotocol; browsers give
      // no other way to set a header on a WebSocket.
      socket = new WebSocket(`${ENDPOINT}?${params}`, ["token", key]);

      socket.onopen = () => {
        node = new AudioWorkletNode(ctx, "pcm-tap");
        node.port.onmessage = (e) => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(e.data);
        };
        ctx.createMediaStreamSource(stream).connect(node);
        // Terminating into the destination would echo the microphone back out
        // of the speaker. The worklet emits nothing, so this is silent.
        node.connect(ctx.destination);
        setMode(ambient ? "ambient" : "capturing");
      };

      socket.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type !== "Results") return;
        const alt = msg.channel?.alternatives?.[0];
        const text = alt?.transcript || "";
        if (!text) return;
        if (msg.is_final) absorb(text, !!msg.speech_final);
        else if (armed || !ambient) onInterim?.(`${buffer} ${text}`.trim());
      };

      socket.onerror = () => {
        onError?.({ kind: "network", message: "Lost the connection to the transcription service." });
      };

      socket.onclose = () => {
        socket = null;
        // A close we didn't ask for, while still wanted, is worth one reopen —
        // the two-minute key expiring mid-conversation lands here.
        if (wanted) setTimeout(() => { if (wanted && !socket) open(); }, 400);
      };
    } catch (e) {
      wanted = false;
      teardown();
      setMode("off");
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
  }

  function teardown() {
    try { node?.port && (node.port.onmessage = null); node?.disconnect(); } catch { /* already gone */ }
    node = null;
    try { for (const t of stream?.getTracks() || []) t.stop(); } catch { /* already gone */ }
    stream = null;
    if (socket) {
      const s = socket;
      socket = null;                    // clear first so onclose doesn't reopen
      s.onclose = null;
      try { s.close(); } catch { /* already closing */ }
    }
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
      open();
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
      setMode("capturing");
      open();
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

    listening() {
      return wanted;
    },

    destroy() {
      wanted = false;
      teardown();
    },
  };
}
