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

  it("has no text under the 10.5px floor — anywhere in the shell", () => {
    // Was scoped to the bar, because AppToggle rendered its labels at 9px and
    // the comment above it said that size was what kept eight labels
    // un-truncated at 375px. That was true, and it was the wrong control's
    // problem: a segmented row divides a fixed width, so eight things meant
    // 9px, negative tracking, no dots, a `short` form for Business and ellipsis
    // from 393px down. The row scrolls now, every label fits at 11.5px, and the
    // floor applies to the whole file.
    // Every numeric literal in the whole fontSize EXPRESSION, not just one that
    // happens to sit right after the colon. `fontSize: compact ? 9 : 11.5` hid
    // the 9 from the first version of this regex — which is precisely the shape
    // the violation had, so the test would have passed on the exact code it was
    // written to reject. A mutation test found it.
    const sizes = [...code.matchAll(/fontSize:\s*([^,\n}]+)/g)]
      .flatMap((m) => [...m[1].matchAll(/[\d.]+/g)].map((n) => Number(n[0])))
      .filter((n) => Number.isFinite(n) && n > 0);
    expect(sizes.length).toBeGreaterThan(3);
    expect(sizes.filter((n) => n < 10.5), "below the 10.5px floor").toEqual([]);
  });

  it("gives the tool row a scrolling grammar, not a dividing one", () => {
    const toggle = code.slice(code.indexOf("function AppToggle"), code.indexOf("function ", code.indexOf("function AppToggle") + 10));
    expect(toggle, "eight segments cannot divide a phone row").toContain("overflowX");
    expect(toggle).toContain("scrollSnap");
    // flex: "1 1 0" is the dividing behaviour this replaced.
    expect(toggle).not.toContain('flex: "1 1 0"');
  });

  it("never signals the active tool by colour alone", () => {
    // The dot was dropped on mobile to buy label width back. A scrolling row
    // has the room, and colour-only state is a thing this language forbids.
    const toggle = code.slice(code.indexOf("function AppToggle"), code.indexOf("function ", code.indexOf("function AppToggle") + 10));
    expect(toggle).toContain("aria-current");
    expect(toggle).not.toContain("{!compact && (");   // the dot is unconditional now
  });

  it("keeps uppercase out of the wordmark", () => {
    // Uppercase survives in exactly one place in this language: 12px section
    // labels. A wordmark in 0.16em-tracked caps is tracking theatrics. (The
    // tool segments keep theirs — they ARE the section labels of this bar.)
    // The wordmark's OWN opening tag, not a window of characters before it — a
    // window picks up whatever markup happens to be adjacent, which here is the
    // tool segments, and they legitimately keep their caps.
    // EVERY wordmark, not the first one found. There are two — the bar and the
    // login screen — and the first pass only fixed the bar. A regex that stops
    // at the first match would have reported the other one clean.
    const tags = [...code.matchAll(/<span([^>]*)>The Pentagon<\/span>/g)].map((m) => m[1]);
    expect(tags.length, "expected the bar's wordmark and the login screen's").toBe(2);
    for (const t of tags) {
      expect(t, `wordmark still uppercase: ${t.slice(0, 60)}`).not.toContain("textTransform");
      expect(t, "wordmark hardcodes a colour instead of a token").not.toMatch(/#[0-9a-fA-F]{6}/);
    }
  });

  it("still reserves the accent for state, not decoration", () => {
    // The accent says which tool you are in. In the bar it should appear on the
    // active segment and the System button's live dot, and nowhere else.
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
