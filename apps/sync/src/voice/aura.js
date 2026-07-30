// ─── Aura playback ───────────────────────────────────────────────────────────
// SYNC's voice in conversation mode. A queue of sentences, each fetched as mp3
// from netlify/functions/deepgram-speak and played through ONE <audio> element.
//
// Three decisions, all of them forced by iOS rather than chosen:
//
// ONE ELEMENT, CREATED AND UNLOCKED DURING A TAP. Safari only allows playback
// from an element that has been played once inside a user gesture. A
// conversation plays audio many turns later, with no gesture anywhere near it —
// so unlock() is called synchronously from the tap that starts the conversation,
// plays a silent data-URI clip, and from then on the same element is reused
// forever. A fresh element per sentence would be locked again on the second one.
//
// PAUSE, NOT DUCK. When the user interrupts, the obvious move is to fade the
// reply down. `element.volume` is a no-op on iOS Safari — assigning it silently
// does nothing — so there is no fade available. pause() is instant, keeps
// currentTime, and resume() is free if the interruption turns out to be a cough.
//
// NOT speechSynthesis. That is the browser's own voice and needs no network, and
// it is still the wrong tool here: on iOS it runs in the UI process on a separate
// audio session, so it is invisible to the page's echo canceller, and it has a
// reported habit of muting a live getUserMedia track — which would kill the
// conversation it is part of. It stays as the fallback for when this fails,
// because a robotic voice beats silence.

const ENDPOINT = "/.netlify/functions/deepgram-speak";

// 44 bytes of silent WAV. Played during the starting tap to unlock the element.
const SILENCE =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

/** One clip: the text, and the object URL its audio lives at. */
export function createAuraSpeaker({ onStart, onEnd, onError, getVoice = () => undefined }) {
  /** @type {HTMLAudioElement|null} */
  let el = null;
  let queue = [];           // [{ text, url }]
  let playing = null;       // the clip currently on the element
  let unlocked = false;
  let generation = 0;       // bumped by stop(); orphans in-flight fetches
  let announced = false;    // onStart fired for this run of speech

  /** What has actually been played, for the echo filter. */
  let heard = [];

  function ensureEl() {
    if (el) return el;
    el = new Audio();
    el.preload = "auto";
    // Without this iOS may take the conversation full-screen on play.
    el.setAttribute("playsinline", "");
    el.addEventListener("ended", () => { advance(); });
    el.addEventListener("error", () => { advance(); });
    return el;
  }

  /**
   * Must be called synchronously from a user gesture, before any await.
   * Returns whether the element is usable.
   */
  function unlock() {
    const a = ensureEl();
    if (unlocked) return true;
    try {
      a.src = SILENCE;
      const p = a.play();
      if (p?.catch) p.catch(() => { /* still worth trying later */ });
      unlocked = true;
    } catch { /* leave unlocked false; say() will try again */ }
    return unlocked;
  }

  function revoke(clip) {
    if (clip?.url) { try { URL.revokeObjectURL(clip.url); } catch { /* gone */ } }
  }

  function advance() {
    const done = playing;
    if (done) { heard.push(done.text); if (heard.length > 12) heard.shift(); }
    revoke(done);
    playing = null;

    const next = queue.shift();
    if (!next) {
      if (announced) { announced = false; onEnd?.(); }
      return;
    }
    playing = next;
    const a = ensureEl();
    a.src = next.url;
    const p = a.play();
    if (p?.catch) p.catch(() => { advance(); });
  }

  async function fetchClip(text, gen) {
    const { supabase } = await import("../lib/supabase.js");
    const session = (await supabase?.auth.getSession())?.data?.session?.access_token;

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session ? { authorization: `Bearer ${session}` } : {}),
      },
      body: JSON.stringify({ text, model: getVoice() }),
    });
    if (gen !== generation) return null;         // stopped while in flight
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error?.message || `Couldn't fetch speech (${res.status}).`);
    }
    const blob = await res.blob();
    if (gen !== generation) return null;
    return { text, url: URL.createObjectURL(blob) };
  }

  return {
    /** True once the element has been played inside a gesture. */
    get ready() { return unlocked; },

    unlock,

    /**
     * Queue one sentence. Fetches and plays in order.
     *
     * Sentences are fetched as they arrive rather than after the whole reply is
     * written, which is where most of the responsiveness comes from — the first
     * sentence is usually already playing while the model is still writing the
     * third.
     */
    async say(text) {
      const said = String(text || "").trim();
      if (!said) return;
      const gen = generation;
      if (!announced) { announced = true; onStart?.(); }
      try {
        const clip = await fetchClip(said, gen);
        if (!clip || gen !== generation) { revoke(clip); return; }
        queue.push(clip);
        if (!playing) advance();
      } catch (e) {
        // One failure ends the spoken run rather than stalling it silently. The
        // caller falls back to the system voice.
        if (gen !== generation) return;
        announced = false;
        onError?.(e);
        onEnd?.();
      }
    },

    /** Interruption: hold position so it can be resumed if this was a false alarm. */
    pause() { try { el?.pause(); } catch { /* nothing playing */ } },

    resume() {
      if (!el || !playing) return;
      const p = el.play();
      if (p?.catch) p.catch(() => { /* user must tap again */ });
    },

    /** How far through the current clip we are, 0..1. Used to decide whether a
     *  half-spoken sentence should be kept in the transcript. */
    progress() {
      if (!el || !el.duration || !Number.isFinite(el.duration)) return 0;
      return Math.min(1, el.currentTime / el.duration);
    },

    speaking() { return !!playing; },

    /** Everything actually played recently, for the echo filter. */
    heardText() { return heard.join(" "); },

    /** Abandon the queue. Orphans in-flight fetches via the generation counter. */
    stop() {
      generation++;
      queue.forEach(revoke);
      queue = [];
      revoke(playing);
      playing = null;
      try { if (el) { el.pause(); el.removeAttribute("src"); el.load(); } } catch { /* fine */ }
      if (announced) { announced = false; onEnd?.(); }
    },

    destroy() {
      this.stop();
      el = null;
      unlocked = false;
      heard = [];
    },
  };
}
