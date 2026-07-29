import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createRecognizer, createMeter, supported as webSpeechSupported } from "./recognizer.js";
import { createDeepgramRecognizer, supported as deepgramSupported } from "./deepgram.js";

// Either engine can carry voice input, and the UI only cares that one of them
// can — "this browser has no speech recognition" is the same message either way.
const sttSupported = deepgramSupported || webSpeechSupported;
import * as speaker from "./speaker.js";
import { runTurn } from "../agent/runtime.js";
import { getState, setSettings } from "../data/store.js";
import { useStore } from "../data/useStore.js";

// ─── The loop ────────────────────────────────────────────────────────────────
// Ear → model → mouth, and the state machine that keeps those three from
// talking over each other. Every surface in the app reads its status from here,
// so the orb, the dock and the transcript can never disagree about what SYNC
// is currently doing.

const VoiceCtx = createContext(null);
export const useVoice = () => useContext(VoiceCtx);

export function VoiceProvider({ children }) {
  const store = useStore();
  const { settings } = store;

  const [phase, setPhase] = useState("idle");      // idle | listening | thinking | speaking | error
  const [mode, setMode] = useState("off");          // off | ambient | capturing
  const [interim, setInterim] = useState("");
  const [level, setLevel] = useState(0);
  const [micError, setMicError] = useState(null);

  const recRef = useRef(null);
  const meterRef = useRef(null);
  const abortRef = useRef(null);
  const busyRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /* ── speaking ────────────────────────────────────────────────────────── */
  const speak = useCallback((text) => {
    const s = settingsRef.current;
    if (!s.speak) return;
    speaker.say(text, { voiceURI: s.voiceURI, rate: s.rate, pitch: s.pitch });
  }, []);

  useEffect(() => {
    const offStart = speaker.onSpeechStart(() => setPhase("speaking"));
    const offEnd = speaker.onSpeechEnd(() => {
      // Only fall back to idle if no turn is still running — a long turn can
      // finish one sentence while the next tool call is still in flight.
      setPhase(busyRef.current ? "thinking" : "idle");
    });
    return () => { offStart(); offEnd(); };
  }, []);

  /* ── running a turn ──────────────────────────────────────────────────── */
  const send = useCallback(async (text, { speakReply = true } = {}) => {
    const utterance = String(text || "").trim();
    if (!utterance || busyRef.current) return;

    speaker.shutUp();
    busyRef.current = true;
    setPhase("thinking");
    setInterim("");

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const res = await runTurn({
      text: utterance,
      signal: ctrl.signal,
      onSpeakable: speakReply ? (sentence) => speak(sentence) : undefined,
    });

    abortRef.current = null;
    busyRef.current = false;

    if (res?.error) {
      setPhase("error");
      // The failure is already rendered in the turn with a retry attached;
      // clear the orb back to idle so it doesn't sit red forever.
      setTimeout(() => setPhase((p) => (p === "error" ? "idle" : p)), 2600);
    } else if (!speaker.isSpeaking()) {
      setPhase("idle");
    }
    return res;
  }, [speak]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    speaker.shutUp();
    recRef.current?.cancel();
    busyRef.current = false;
    setInterim("");
    setPhase("idle");
  }, []);

  /* ── the ear ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!sttSupported) return;
    // Deepgram first, wherever the browser can capture audio at all. Web Speech
    // is the fallback, not the default: iOS keeps its engine to Safari, so in
    // the installed app — the one surface this is actually used from — it
    // reports service-not-allowed and there is nothing to be done about it.
    // Deepgram needs only getUserMedia and an AudioContext, which do work there.
    const make = deepgramSupported ? createDeepgramRecognizer : createRecognizer;
    const rec = make({
      onInterim: setInterim,
      onCommit: (text) => {
        // Barge-in: if SYNC is mid-sentence when a command lands, it stops
        // talking and takes the new instruction. This is what makes the thing
        // feel like a conversation rather than a queue.
        speaker.shutUp();
        if (busyRef.current) abortRef.current?.abort();
        setTimeout(() => send(text), 0);
      },
      onState: (m) => {
        setMode(m);
        setPhase((p) => {
          // "starting" counts as listening for the orb's sake — the tap has to
          // produce motion immediately or it reads as ignored — but the
          // caption distinguishes the two, so "connecting" and "connected but
          // hearing nothing" stop looking alike.
          if (m === "capturing" || m === "starting") return "listening";
          if (p === "listening") return busyRef.current ? "thinking" : "idle";
          return p;
        });
      },
      onError: (e) => {
        setMicError(e.message);
        // Anything that isn't a passing network blip leaves the microphone dead
        // until someone changes something, so the ambient switch must stop
        // claiming SYNC is listening. `network` is the one kind that recovers
        // on its own, so it alone leaves the setting where it was.
        if (e.kind !== "network") setSettings({ ambient: false });
      },
      getWake: () => settingsRef.current.wakeWord || "sync",
    });
    recRef.current = rec;
    return () => { rec.destroy(); recRef.current = null; };
  }, [send]);

  // Ambient listening follows the setting, and only the setting — so the one
  // switch in the UI is genuinely the source of truth.
  useEffect(() => {
    const rec = recRef.current;
    if (!rec?.supported) return;
    if (settings.ambient) { setMicError(null); rec.start(); }
    else if (rec.listening()) rec.stop();
  }, [settings.ambient]);

  /* ── the meter ───────────────────────────────────────────────────────── */
  // Held only while the ear is actually open — wake-word listening, or the
  // length of one push-to-talk. An app you aren't talking to must not leave a
  // live-microphone indicator sitting in the browser chrome.
  const earOpen = settings.ambient || mode === "capturing" || mode === "starting";

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let lastPush = 0;
    let lastValue = 0;

    // `level` is a dependency of the context value below, so every setLevel
    // rebuilds it and re-renders every consumer of useVoice() — the console,
    // the transcript, the composer, the orb. Pushing a fresh float on every
    // animation frame means doing that 60 times a second on a phone, which is
    // enough to make the whole tab stop answering taps.
    //
    // This was survivable before only by accident: the loop used to start only
    // if createMeter() resolved to something, and on iOS that second
    // getUserMedia often didn't, so it frequently never ran at all.
    //
    // The orb eases toward whatever it is given, so it cannot tell the
    // difference between 60 and 20 updates a second. The epsilon matters more
    // than the rate: silence produces a jittering near-zero float, and without
    // it every frame is a "change" and React never bails out.
    const PUSH_MS = 50;
    const EPSILON = 0.02;

    const tick = (now) => {
      const m = meterRef.current;
      if (m) {
        const v = m.level();
        if (Number.isFinite(v) && (now - lastPush >= PUSH_MS) && Math.abs(v - lastValue) >= EPSILON) {
          lastPush = now;
          lastValue = v;
          setLevel(v);
        }
      }
      raf = requestAnimationFrame(tick);
    };

    if (earOpen) {
      // If the engine already holds a microphone, read the level off that graph
      // instead of opening a second one. createMeter() calls getUserMedia and
      // builds its own AudioContext — fine beside Web Speech, which hands out
      // no stream, but beside Deepgram it means two live captures at once, and
      // iOS will sometimes answer that by quietly starving the first.
      const own = recRef.current?.level;
      if (typeof own === "function") {
        meterRef.current = { level: () => recRef.current?.level() ?? 0, close() {} };
        raf = requestAnimationFrame(tick);
      } else {
        createMeter().then((m) => {
          if (cancelled) { m?.close(); return; }
          meterRef.current = m;
          if (m) raf = requestAnimationFrame(tick);
        });
      }
    } else {
      meterRef.current?.close();
      meterRef.current = null;
      setLevel(0);
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      meterRef.current?.close();
      meterRef.current = null;
    };
  }, [earOpen]);

  /* ── manual controls ─────────────────────────────────────────────────── */
  const talk = useCallback(() => {
    const rec = recRef.current;
    if (!rec?.supported) return false;
    speaker.shutUp();
    // "starting" counts as in-progress: a second tap while the socket is still
    // opening has to be able to call it off, or the control is unresponsive for
    // exactly as long as the connection is slow — which is precisely when
    // someone taps again.
    const m = rec.mode();
    if (m === "capturing" || m === "starting") { rec.commitNow(); return true; }
    setMicError(null);
    rec.capture();
    return true;
  }, []);

  const holdStart = useCallback(() => {
    const rec = recRef.current;
    if (!rec?.supported || busyRef.current) return;
    speaker.shutUp();
    rec.capture();
  }, []);

  const holdEnd = useCallback(() => { recRef.current?.commitNow(); }, []);

  const toggleAmbient = useCallback(() => {
    setSettings({ ambient: !getState().settings.ambient });
  }, []);

  const value = useMemo(() => ({
    phase, mode, interim, level,
    micError, clearMicError: () => setMicError(null),
    sttSupported, ttsSupported: speaker.supported,
    busy: busyRef.current || phase === "thinking",
    send, stop, talk, holdStart, holdEnd, toggleAmbient, speak,
    shutUp: speaker.shutUp,
  }), [phase, mode, interim, level, micError, send, stop, talk, holdStart, holdEnd, toggleAmbient, speak]);

  return <VoiceCtx.Provider value={value}>{children}</VoiceCtx.Provider>;
}
