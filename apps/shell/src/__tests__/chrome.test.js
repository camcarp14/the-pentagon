// The shell chrome, pinned to the design language.
//
// This is the first Pentagon surface to adopt the kit, so it is also the first
// place the rules can actually be enforced. Source-text assertions in the house
// style of mount.test.js — the shell cannot be mounted here, but the things that
// go wrong with it are all visible in the source.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "App.jsx"), "utf8");
const code = app.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the shell opts into the kit without dragging the tools in", () => {
  it("puts data-kit on the bar, never on the wrapper", () => {
    // THE ONE THAT MATTERS. Every tool renders inside the wrapper, and the kit
    // styles .btn/.card/.field/.sheet — names eight apps already own meaning
    // different things. data-kit on the wrapper restyles all of them at once;
    // an adversarial review caught that exact class of breakage before it
    // shipped, and this is the guard that keeps it caught.
    expect(code).toContain("<div data-kit");
    // Read the WRAPPER'S OWN OPENING TAG rather than slicing between two
    // markers. The first version of this assertion sliced from "<div data-app="
    // to "<div data-kit" — so moving data-kit onto the wrapper inverted the
    // indices, produced an empty string, and the test passed on the very change
    // it exists to catch. A mutation test found it; this reads the one tag.
    const openTag = /<div\s+([^>]*\bdata-app=[^>]*)>/.exec(code);
    expect(openTag, "could not find the wrapper's opening tag").not.toBeNull();
    expect(openTag[1], "data-kit must not sit on the element that contains the tools").not.toContain("data-kit");
  });

  it("uses the kit's controls rather than hand-rolling them", () => {
    expect(code).toMatch(/className=\{?["'][^"']*\bbtn\b/);
    // A hand-rolled control is how the chrome drifted from every other surface
    // in the first place.
    expect(code).not.toMatch(/border:\s*["']1px solid var\(--border\)["']/);
  });
});

describe("the chrome obeys the language", () => {
  it("carries no decorative font", () => {
    // SESSION §2: system stack only, no webfonts. Syne was three call sites in
    // the bar, and its late arrival is why AppToggle re-measures on fonts.ready.
    expect(code).not.toContain("Syne");
  });

  it("has no text under the 10.5px floor in the bar", () => {
    // Sign out was 10px. The floor is stated as absolute — "nothing smaller,
    // ever" — so it is checkable, and this is the check.
    //
    // Scoped to the BAR, not the file, because one violation is knowingly still
    // here: AppToggle renders its labels at 9px on a phone, and the comment
    // above it records that the size is what keeps every tool label
    // un-truncated at 375px. Raising it to the floor without a device in hand
    // trades a readability rule for a truncation bug, and the toggle is due a
    // real redesign anyway — eight segments is not phone navigation. Left
    // deliberately, and this test will start covering it the moment the toggle
    // moves into the bar's markup.
    const bar = code.slice(code.indexOf("<div data-kit"), code.indexOf("ToolBoundary"));
    const sizes = [...bar.matchAll(/fontSize:\s*([\d.]+)\b/g)].map((m) => Number(m[1]));
    expect(sizes.filter((n) => n < 10.5), "below the 10.5px floor").toEqual([]);
  });

  it("keeps uppercase out of the wordmark", () => {
    // Uppercase survives in exactly one place in this language: 12px section
    // labels. A wordmark in 0.16em-tracked caps is tracking theatrics.
    const bar = code.slice(code.indexOf("<div data-kit"), code.indexOf("ToolBoundary"));
    expect(bar).not.toContain("textTransform");
  });

  it("still reserves the accent for state, not decoration", () => {
    // The accent says which tool you are in. In the bar it should appear on the
    // active toggle segment and the System button's live dot, and nowhere else.
    const bar = code.slice(code.indexOf("<div data-kit"), code.indexOf("ToolBoundary"));
    expect((bar.match(/var\(--accent[^)]*\)/g) || []).length).toBeLessThanOrEqual(3);
  });
});

describe("the 52px contract the tools depend on", () => {
  it("keeps the bar at 51 + 1", () => {
    // Ten call sites across the tools hardcode calc(100vh - 52px) or top: 52px.
    // Growing this by a pixel puts a permanent 1px overflow on every one.
    expect(code).toMatch(/height:\s*51\b/);
  });
});
