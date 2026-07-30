import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createRecognizer, createMeter, supported as webSpeechSupported } from "./recognizer.js";
import { createDeepgramRecognizer, supported as deepgramSupported } from "./deepgram.js";

// Either engine can carry voice input, and the UI only cares that one of them
// can — "this browser has no speech recognition" is the same message either way.
const sttSupported = deepgramSupported || webSpeechSupported;
import * as speaker from "./speaker.js";
import { createAuraSpeaker } from "./aura.js";
import { runTurn } from "../agent/runtime.js";
import { getState, setSettings } from "../data/store.js";
import { useStore } from "../data/useStore.js";

// ─── Conversation-mode constants ─────────────────────────────────────────────
// How long after playback actually ends before the uplink reopens. Room reverb
// and audio scheduling both outlive the last sample, and anything still in the
// air when Deepgram starts listening again gets transcribed as the user.
const ECHO_TAIL_MS = 300;
// How far above the measured noise floor counts as someone talking, and for how
// long. The floor is tracked live because a car, a kitchen and a quiet office
// are three different rooms. Too low and every reply gets chopped by a cough;
// too high and interrupting takes a shout.
const BARGE_MARGIN = 0.16;
const BARGE_FLOOR_MIN = 0.11;
const BARGE_MIN_MS = 240;
// Speech is paused, not cancelled, on a candidate interruption. If no words
// arrive by the time this elapses, it was a noise and playback resumes where it
// left off. This is what turns "it keeps stopping for no reason" — the most
// common complaint about voice assistants — into a brief hiccup.
const BARGE_CONFIRM_MS = 1800;

// ─── The loop ────────────────────────────────────────────────────────────────
// Ear → model → mouth, and the state machine that keeps those three from
// talking over each other. Every surface in the app reads its status from here,
// so the orb, the dock and the transcript can never disagree about what SYNC
// is currently doing.

const VoiceCtx = createContext(null);
export const useVoice = () => useContext(VoiceCtx);

// Is a conversation live, or one beat away from being live? Every manual
// control has to ask, because none of them mean what they usually mean while
// one is running. `mode()` alone is not enough: between converse() and
// ws.onopen the recognizer reads "starting", which is indistinguishable from a
// push-to-talk that is still connecting — so the setting has the final say.
// The setting is only consulted on an engine that can actually hold a
// conversation: on the Web Speech fallback `handsFree` can sit true with
// nothing listening, and there tap and spacebar still mean push-to-talk.
const inConversation = (rec) =>
  rec.mode() === "conversing" || (!!rec.converse && getState().settings.handsFree);

export function VoiceProvider({ children }) {
  const store = useStore();
  const { settings } = store;

  const [phase, setPhase] = useState("idle");      // idle | listening | thinking | speaking | error
  const [mode, setMode] = useState("off");          // off | ambient | capturing
  const [interim, setInterim] = useState("");
  const [level, setLevel] = useState(0);
  const [micError, setMicError] = useState(null);
  // Which step of opening the ear we are on: mic | token | socket | live.
  // Exists so "Connecting…" can say what it is doing — three quite different
  // things can stall there and they were indistinguishable from the outside.
  const [stage, setStage] = useState(null);

  const recRef = useRef(null);
  const meterRef = useRef(null);
  const abortRef = useRef(null);
  const busyRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /* ── speaking ────────────────────────────────────────────────────────── */
  const auraRef = useRef(null);
  // Flipped false the first time Aura fails, so one bad reply degrades to the
  // system voice for the rest of the session instead of failing every turn.
  const auraOkRef = useRef(true);
  const bargeRef = useRef({ floor: BARGE_FLOOR_MIN, hot: 0, pending: false, timer: 0 });

  const speak = useCallback((text) => {
    const s = settingsRef.current;
    if (!s.speak) return;
    // Aura only in conversation mode, and only once the element has been
    // unlocked by the tap that started it. Everywhere else the system voice is
    // the right answer: it costs nothing, needs no network, and push-to-talk
    // does not care about echo because it is not listening while it talks.
    if (s.handsFree && auraOkRef.current && auraRef.current?.ready) {
      auraRef.current.say(text);
      return;
    }
    speaker.say(text, { voiceURI: s.voiceURI, rate: s.rate, pitch: s.pitch });
  }, []);

  // Aura's own start/end, and the uplink gate that hangs off them.
  //
  // The gate closes when audio actually becomes audible and opens a beat after
  // it actually stops — not when the text was queued or when the reply was
  // finished being written. Those are different moments, and using the wrong one
  // is precisely how an assistant ends up transcribing its own voice and
  // answering itself.
  useEffect(() => {
    const a = createAuraSpeaker({
      onStart: () => {
        setPhase("speaking");
        recRef.current?.uplink?.(false);
      },
      onEnd: () => {
        const b = bargeRef.current;
        clearTimeout(b.timer);
        b.pending = false;
        b.hot = 0;
        setTimeout(() => {
          // Only reopen if nothing started speaking again in the meantime.
          if (!auraRef.current?.speaking()) recRef.current?.uplink?.(true);
        }, ECHO_TAIL_MS);
        setPhase(busyRef.current ? "thinking" : "idle");
      },
      onError: (e) => {
        // Fall back to the system voice for the rest of the session, and say so
        // once rather than on every sentence.
        auraOkRef.current = false;
        setMicError(`Couldn't use the natural voice — falling back to the system one. ${e?.message || ""}`.trim());
      },
      getVoice: () => settingsRef.current.auraVoice,
    });
    auraRef.current = a;
    return () => { a.destroy(); auraRef.current = null; };
  }, []);

  useEffect(() => {
    const offStart = speaker.onSpeechStart(() => {
      setPhase("speaking");
      // The system voice needs the same gate. On iOS it is worse than Aura for
      // this — it plays on a separate audio session the page's echo canceller
      // cannot see — so not gating would guarantee self-transcription.
      recRef.current?.uplink?.(false);
    });
    const offEnd = speaker.onSpeechEnd(() => {
      setTimeout(() => {
        if (!speaker.isSpeaking()) recRef.current?.uplink?.(true);
      }, ECHO_TAIL_MS);
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
    } else if (!speaker.isSpeaking() && !auraRef.current?.speaking()) {
      setPhase("idle");
    }
    return res;
  }, [speak]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    speaker.shutUp();
    // In a conversation the setting is what holds the ear open, so it has to be
    // what closes it. Cancelling the recognizer alone tore the microphone down
    // while `handsFree` stayed true: the effect below never re-ran, so the orb
    // kept offering "Interrupt" over a dead ear and every further tap cancelled
    // a recognizer that was already off. Let the setting drive the teardown.
    if (getState().settings.handsFree) setSettings({ handsFree: false });
    else recRef.current?.cancel();
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
      // Conversation mode: a turn ended on its own, so run it without waiting
      // for anyone to tap anything. This is the whole feature in one callback —
      // the recognizer stays open, so by the time the reply is spoken the ear is
      // already listening for what comes next.
      onTurnEnd: (text) => {
        speaker.shutUp();
        auraRef.current?.stop();
        if (busyRef.current) abortRef.current?.abort();
        setTimeout(() => send(text), 0);
      },
      onSpeechStarted: () => {
        // Energy-based, so this is an affordance and nothing more: it says
        // something is making noise, never that a turn has begun or ended.
        setPhase((p) => (p === "idle" ? "listening" : p));
      },
      onStage: setStage,
      onState: (m) => {
        setMode(m);
        // Nothing is being opened any more; stop reporting a step.
        if (m === "off" || m === "capturing" || m === "ambient") setStage(null);
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
        // until someone changes something, so the switches must stop claiming
        // SYNC is listening — both of them: clearing `ambient` alone left a
        // failed conversation showing "Go ahead — I'm listening" over an ear
        // that had already been torn down. `network` is the one kind that
        // recovers on its own, so it alone leaves the settings where they were.
        if (e.kind !== "network") setSettings({ ambient: false, handsFree: false });
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
    // `mode() !== "off"`, not `listening()`. listening() reports wake-word
    // listening only, so switching the mic off during a push-to-talk used to
    // call nothing at all — leaving no single control anywhere in the UI that
    // returns the ear to a known state. When the machine wedges, that is the
    // one thing a person needs.
    else if (rec.mode() !== "off") rec.stop();
  }, [settings.ambient]);

  /* ── the meter ───────────────────────────────────────────────────────── */
  // Held only while the ear is actually open — wake-word listening, or the
  // length of one push-to-talk. An app you aren't talking to must not leave a
  // live-microphone indicator sitting in the browser chrome.
  const earOpen = settings.ambient || mode === "capturing" || mode === "starting" || mode === "conversing";

  /**
   * Barge-in, measured locally.
   *
   * It has to be local. While SYNC is speaking the uplink is shut, so Deepgram
   * hears nothing and cannot report that someone started talking — the analyser
   * on our own microphone graph is the only ear still open. That is the whole
   * reason the mic track is never stopped during a conversation.
   *
   * The threshold floats on a measured noise floor rather than sitting at a
   * constant, because the residual of SYNC's own voice leaking back through the
   * phone's speaker IS the floor here, and it differs by room, by volume and by
   * whether the phone is on a table or in a hand.
   */
  const watchBargeIn = useCallback((v, now) => {
    const aura = auraRef.current;
    const b = bargeRef.current;
    const audible = aura?.speaking() || speaker.isSpeaking();

    if (!audible) {
      // Track the floor only while nothing is playing, so the assistant's own
      // voice never teaches the detector to ignore a real one.
      b.floor = Math.min(b.floor * 0.995 + v * 0.005, 0.4);
      b.hot = 0;
      return;
    }

    const threshold = Math.max(b.floor + BARGE_MARGIN, BARGE_FLOOR_MIN);
    if (v < threshold) { b.hot = 0; return; }
    if (!b.hot) { b.hot = now; return; }
    if (now - b.hot < BARGE_MIN_MS || b.pending) return;

    // Candidate. Pause rather than cancel, and open the uplink so Deepgram can
    // tell us within a couple of seconds whether that was a person or a door.
    b.pending = true;
    aura?.pause();
    speaker.shutUp();
    recRef.current?.uplink?.(true);
    setPhase("listening");
    clearTimeout(b.timer);
    b.timer = setTimeout(() => {
      // No words arrived, so it was noise. Pick the reply back up mid-sentence
      // and re-close the gate.
      b.pending = false;
      b.hot = 0;
      if (auraRef.current?.speaking()) {
        recRef.current?.uplink?.(false);
        auraRef.current.resume();
        setPhase("speaking");
      }
    }, BARGE_CONFIRM_MS);
  }, []);

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
        if (Number.isFinite(v)) {
          // Barge-in reads every frame, unthrottled — 250ms of sustained speech
          // is the signal, so sampling it at 20Hz would be coarse enough to miss
          // the start of a word. It touches no React state, so it is free.
          if (settingsRef.current.handsFree) watchBargeIn(v, now);
          if ((now - lastPush >= PUSH_MS) && Math.abs(v - lastValue) >= EPSILON) {
            lastPush = now;
            lastValue = v;
            setLevel(v);
          }
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
  }, [earOpen, watchBargeIn]);

  /* ── manual controls ─────────────────────────────────────────────────── */
  const talk = useCallback(() => {
    const rec = recRef.current;
    if (!rec?.supported) return false;
    speaker.shutUp();
    // A conversation has no tap-to-commit — the turn ends itself — so a tap is
    // an interrupt and nothing more. Falling through to capture() here called
    // setMode("starting") on a socket that had already opened, and nothing can
    // promote it again once ws.onopen has fired: the caption sat on
    // "Connecting…" while the conversation kept working underneath, and the
    // next tap matched "starting", committed, and tore the whole thing down.
    if (inConversation(rec)) {
      auraRef.current?.stop();
      return true;
    }
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
    // Space is push-to-talk, and a conversation has nothing to push into — so
    // holding it is only ever an interrupt. Falling through to capture() here
    // put "starting" back on an already-open socket that ws.onopen can no
    // longer promote, and the release's commitNow() then ran the non-ambient
    // branch of commit(): microphone torn down, mode "off", while `handsFree`
    // stayed true and the effect that owns the ear never re-ran. One tap of
    // the spacebar left the orb offering "Interrupt" over a dead ear.
    if (inConversation(rec)) { auraRef.current?.stop(); return; }
    rec.capture();
  }, []);

  const holdEnd = useCallback(() => {
    const rec = recRef.current;
    if (rec && !inConversation(rec)) rec.commitNow();
  }, []);

  const toggleAmbient = useCallback(() => {
    setSettings({ ambient: !getState().settings.ambient });
  }, []);

  /**
   * Start or end a hands-free conversation.
   *
   * The unlock() call is the part that must not move. Safari will only play audio
   * from an element that has been played once inside a user gesture, and a
   * conversation plays its audio many turns later with no gesture in sight — so
   * the element has to be primed here, synchronously, before any await. Do it
   * after an await and every reply is silent, with nothing in the console to say
   * why.
   */
  const toggleConversation = useCallback(() => {
    const on = !getState().settings.handsFree;
    if (on) {
      auraRef.current?.unlock();
      setMicError(null);
      // Ambient wake-word listening and a live conversation are the same ear
      // wanting two different things. The conversation wins.
      setSettings({ handsFree: true, ambient: false, speak: true });
    } else {
      setSettings({ handsFree: false });
    }
  }, []);

  // The conversation follows the setting, so the switch is the source of truth
  // and the same code path runs whether it was flipped from the orb, the toolbar
  // or Settings.
  useEffect(() => {
    const rec = recRef.current;
    if (!rec?.supported || !rec.converse) return;
    if (settings.handsFree) {
      rec.converse();
    } else {
      auraRef.current?.stop();
      speaker.shutUp();
      clearTimeout(bargeRef.current.timer);
      bargeRef.current.pending = false;
      if (rec.mode() !== "off") rec.stop();
    }
  }, [settings.handsFree]);

  const value = useMemo(() => ({
    phase, mode, interim, level, stage,
    micError, clearMicError: () => setMicError(null),
    sttSupported, ttsSupported: speaker.supported,
    busy: busyRef.current || phase === "thinking",
    handsFree: !!settings.handsFree,
    send, stop, talk, holdStart, holdEnd, toggleAmbient, toggleConversation, speak,
    shutUp: () => { speaker.shutUp(); auraRef.current?.stop(); },
  }), [phase, mode, interim, level, stage, micError, settings.handsFree,
      send, stop, talk, holdStart, holdEnd, toggleAmbient, toggleConversation, speak]);

  return <VoiceCtx.Provider value={value}>{children}</VoiceCtx.Provider>;
}
