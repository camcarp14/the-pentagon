// Two things have to be right before a word reaches the speakers: the text has
// to be stripped of everything that reads badly out loud, and it has to be cut
// into pieces short enough that Chrome doesn't kill the utterance mid-sentence.
// Both are pure functions, so both are testable without a browser.
//
// The wake-word matcher is here too — it is the single most-exercised piece of
// string handling in the app, and getting it wrong means either a deaf
// assistant or one that talks to itself.

import { describe, it, expect } from "vitest";
import { installBrowserEnv } from "../../test/env.js";

installBrowserEnv();

const { speakable, chunk, supported } = await import("../speaker.js");
const { afterWake } = await import("../recognizer.js");

/* ── with no speechSynthesis, the module still imports and reports honestly ── */
describe("with no speechSynthesis, the module still imports and reports honestly", () => {
  it("speech support is reported, not assumed", () => expect(supported).toEqual(false));
});

/* ── text that reads badly out loud ────────────────────────────────────────── */
describe("text that reads badly out loud", () => {
  it("bold markers are stripped", () => expect(speakable("That's **booked**.")).toEqual("That's booked."));
  it("italic markers are stripped", () => expect(speakable("That's *booked*.")).toEqual("That's booked."));
  it("inline code is unwrapped", () => expect(speakable("Run `npm run dev` first.")).toEqual("Run npm run dev first."));
  it("headers are stripped", () => expect(speakable("## Today\nTwo blocks.")).toEqual("Today\nTwo blocks."));
  it("list bullets are stripped", () => expect(speakable("- one\n- two")).toEqual("one\ntwo"));
  it("bullet dots are stripped", () => expect(speakable("• one")).toEqual("one"));
  it("links keep their label", () => expect(speakable("See [the docs](https://example.com/a/b).")).toEqual("See the docs."));
  it("bare urls become a hostname", () => expect(speakable("It's at https://www.example.com/a/b?c=d now.")).toEqual("It's at example.com now."));
  it("ampersands are spoken", () => expect(speakable("Ops & Finance")).toEqual("Ops and Finance"));
  it("code fences are not read aloud", () => expect(speakable("Here:\n```js\nconst x = 1;\n```").includes("code block")).toBe(true));
  it("internal ids are removed", () => expect(!speakable("Moved block k9x2mf1q3ab to two.").includes("k9x2mf1q3ab")).toBe(true));
  it("whitespace is collapsed", () => expect(speakable("Two   spaces")).toEqual("Two spaces"));
  it("empty in, empty out", () => expect(speakable("")).toEqual(""));
  it("null is survivable", () => expect(speakable(null)).toEqual(""));
});

/* ── chunking ──────────────────────────────────────────────────────────────── */
describe("chunking", () => {
  const short = chunk("Booked. Two till four.");
  it("a short reply stays in one piece", () => expect(short.length).toEqual(1));

  describe("a long reply", () => {
    const long = "This is a sentence that runs on for a while. ".repeat(14);
    const pieces = chunk(long, 190);

    it("a long reply is split", () => expect(pieces.length > 1).toBe(true));
    it("no piece exceeds the ceiling", () => expect(pieces.every((p) => p.length <= 190)).toBe(true));
    it("nothing is lost in the split", () => expect(pieces.join(" ").replace(/\s+/g, " ").trim()).toEqual(long.replace(/\s+/g, " ").trim()));
  });

  // A single sentence longer than the ceiling has to break on a comma or a
  // space — never mid-word, which is what makes synthesis stutter.
  describe("a single sentence longer than the ceiling", () => {
    const runOn = "I moved the creator call to Thursday afternoon, cleared the Wednesday block that was sitting on your only clear stretch of the week, and pushed the supplier reply to tomorrow morning so today has room for the proposal.";
    const hard = chunk(runOn, 90);

    it("an over-long sentence is broken up", () => expect(hard.length > 1).toBe(true));
    it("no piece exceeds the ceiling", () => expect(hard.every((p) => p.length <= 90)).toBe(true));
    it("no word is cut in half", () => expect(hard.every((p) => !/\w$/.test(p) || runOn.includes(p))).toBe(true));
    it("no empty pieces", () => expect(hard.filter((p) => !p.trim()).length).toEqual(0));
  });
});

/* ── the wake word ─────────────────────────────────────────────────────────── */
describe("the wake word", () => {
  it("plain wake word", () => expect(afterWake("sync move my two o'clock", "sync")).toEqual({ hit: true, rest: "move my two o clock" }));
  it("wake word mid-sentence", () => expect(afterWake("hey sync what's next", "sync")).toEqual({ hit: true, rest: "what s next" }));
  it("wake word with punctuation", () => expect(afterWake("Sync, plan my day.", "sync")).toEqual({ hit: true, rest: "plan my day" }));
  it("capitalised", () => expect(afterWake("SYNC start a timer", "sync")).toEqual({ hit: true, rest: "start a timer" }));
  it("wake word alone", () => expect(afterWake("sync", "sync")).toEqual({ hit: true, rest: "" }));

  // The mishearings this particular name actually produces.
  it("misheard as sink", () => expect(afterWake("sink what's on my plate", "sync").hit).toEqual(true));
  it("misheard as think", () => expect(afterWake("think plan my day", "sync").hit).toEqual(true));

  it("no wake word means no command", () => expect(afterWake("just talking to someone else", "sync")).toEqual({ hit: false, rest: "" }));
  it("a word containing the name does not count", () => expect(afterWake("synchronise the files", "sync").hit).toEqual(false));
  it("empty input", () => expect(afterWake("", "sync")).toEqual({ hit: false, rest: "" }));

  // A custom wake word works even though it has no alias list.
  it("a custom wake word", () => expect(afterWake("atlas what's next", "atlas")).toEqual({ hit: true, rest: "what s next" }));
  it("the custom word is required", () => expect(afterWake("sync what's next", "atlas").hit).toEqual(false));
});
