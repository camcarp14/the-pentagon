// The shell's URL rules.
//
// Before this, the shell never touched location: reload dumped you on the first
// visible tool, the back button left the site, and there was no way to link to
// a tool at all. These are the rules that fix it, kept pure so they can be
// checked without a browser.

import { describe, it, expect } from "vitest";
import { parseRoute, formatRoute, sameRoute, SYSTEM } from "../route.js";

const TABS = ["zts", "clarify", "sync", "ideas"];

describe("parseRoute", () => {
  it("reads a tool out of the hash", () => {
    expect(parseRoute("#/sync", TABS)).toEqual({ tool: "sync", system: false, known: true });
    expect(parseRoute("#/clarify", TABS)).toEqual({ tool: "clarify", system: false, known: true });
  });

  // ── the shell is not the only router on the page ───────────────────────────
  //
  // Clarify, Runway and SYNC all route their own internal views through the same
  // location.hash. Clarify wrote `#/analytics` when you opened its Analytics
  // view; the shell read a segment naming no tool, fell back to the first
  // visible tool, and threw the operator into Runway. `known` is what lets the
  // hashchange listener tell "go to this tool" apart from "this is not mine".

  it("marks a hash that names no tool as not the shell's", () => {
    for (const foreign of ["#/analytics", "#/clients/abc123", "#/queue", "#/nope"]) {
      expect(parseRoute(foreign, TABS).known, foreign).toBe(false);
    }
    // …while still resolving somewhere sensible, because a FIRST LOAD on a stale
    // URL has to land on something. Only hashchange consults `known`.
    expect(parseRoute("#/analytics", TABS).tool).toBe("zts");
  });

  it("reads a tool through its own sub-route", () => {
    // The shape Clarify writes now: shell owns segment 0, the tool owns the rest.
    expect(parseRoute("#/clarify/analytics", TABS)).toEqual({ tool: "clarify", system: false, known: true });
    expect(parseRoute("#/clarify/clients/abc123", TABS)).toEqual({ tool: "clarify", system: false, known: true });
  });

  it("treats a tool's own sub-route as already being on that tool", () => {
    // sameRoute compares the FIRST SEGMENT ONLY. Comparing the whole hash made
    // `#/clarify/analytics` look like the wrong place, so the shell rewrote the
    // URL back to `#/clarify` and stamped out the tool's view on every nav.
    expect(sameRoute("#/clarify/analytics", { tool: "clarify", system: false })).toBe(true);
    expect(sameRoute("#/clarify/clients/abc123", { tool: "clarify", system: false })).toBe(true);
    expect(sameRoute("#/zts", { tool: "clarify", system: false })).toBe(false);
    expect(sameRoute("#/analytics", { tool: "clarify", system: false })).toBe(false);
  });

  it("leaves a bare load on the first visible tool", () => {
    // App.jsx records this as intended behaviour — a fresh load is meant to land
    // somewhere predictable rather than wherever you were last. The hash only
    // decides anything when it is actually there.
    for (const empty of ["", "#", "#/", undefined, null, 42]) {
      expect(parseRoute(empty, TABS).tool).toBe("zts");
      expect(parseRoute(empty, TABS).system).toBe(false);
    }
  });

  it("ignores a hash naming a tool the operator has hidden", () => {
    // The toggle is a statement about what they want to see. A stale bookmark
    // should not force a hidden tool back on screen.
    expect(parseRoute("#/macro", TABS).tool).toBe("zts");
    expect(parseRoute("#/nonsense", TABS).tool).toBe("zts");
  });

  it("routes the system panel, which is a destination and not a tool", () => {
    const r = parseRoute(`#/${SYSTEM}`, TABS);
    expect(r.system).toBe(true);
    expect(r.tool).toBe("zts");            // something coherent behind the panel
  });

  it("is forgiving about shape", () => {
    expect(parseRoute("#/SYNC", TABS).tool).toBe("sync");        // case
    expect(parseRoute("#sync", TABS).tool).toBe("sync");         // no slash
    expect(parseRoute("#/sync/console", TABS).tool).toBe("sync"); // deeper path, shell level only
    expect(parseRoute("#/sync?x=1", TABS).tool).toBe("sync");     // query
  });

  it("survives an empty tab list rather than throwing", () => {
    expect(() => parseRoute("#/sync", [])).not.toThrow();
    expect(() => parseRoute("#/sync", null)).not.toThrow();
  });
});

describe("formatRoute and sameRoute", () => {
  it("round-trips every visible tool", () => {
    for (const t of TABS) {
      expect(parseRoute(formatRoute({ tool: t, system: false }), TABS).tool).toBe(t);
    }
    expect(parseRoute(formatRoute({ tool: "zts", system: true }), TABS).system).toBe(true);
  });

  it("recognises a hash it already wrote, so no redundant history entry", () => {
    expect(sameRoute("#/sync", { tool: "sync", system: false })).toBe(true);
    expect(sameRoute("#/SYNC", { tool: "sync", system: false })).toBe(true);
    expect(sameRoute("#/zts", { tool: "sync", system: false })).toBe(false);
    expect(sameRoute("", { tool: "sync", system: false })).toBe(false);
  });
});
