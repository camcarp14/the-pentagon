// Tab preferences. The rules worth pinning are the ones whose failure is a
// broken shell rather than a wrong pixel: a toggle with zero tabs, a tool that
// ships and is invisible to everyone who ever set a preference, and a dead
// segment pointing at a tool that no longer exists.
import { describe, it, expect } from "vitest";
import { APPS } from "@cc/design";
import {
  normalizeTabPrefs, visibleTabs, toggleTab, moveTab, isHidden, canHide,
  resetTabPrefs, resolveActive, DEFAULT_HIDDEN,
} from "../tabPrefs.js";

const fresh = () => normalizeTabPrefs(null);

describe("defaults", () => {
  it("hides Macro, Looper and Business on a fresh install", () => {
    expect(fresh().hidden).toEqual(["macro", "looper", "business"]);
  });

  it("leaves ZTS, Clarify, Runway and SYNC visible, in APPS order", () => {
    // SYNC ships visible rather than in DEFAULT_HIDDEN: it is the voice layer
    // the day actually runs through, and a hidden assistant is a dead one.
    // Four segments still clear the 375px budget that forced Business's short
    // form — the ellipsis risk starts at six.
    expect(visibleTabs(null)).toEqual(["zts", "clarify", "runway", "sync"]);
  });

  it("hides nothing that is not a real tool", () => {
    for (const app of DEFAULT_HIDDEN) expect(APPS).toContain(app);
  });
});

describe("normalizeTabPrefs — it is fed whatever is in localStorage", () => {
  it("survives every shape a stored value could take", () => {
    for (const bad of [null, undefined, 0, "", "zts", [], [1, 2], { order: "zts" }, { hidden: 7 }, { order: null, hidden: null }]) {
      expect(() => normalizeTabPrefs(bad)).not.toThrow();
      const p = normalizeTabPrefs(bad);
      expect(p.order.length).toBe(APPS.length);
      expect(visibleTabs(p).length).toBeGreaterThan(0);
    }
  });

  it("order is always a permutation of APPS — no dupes, no unknowns, none missing", () => {
    const p = normalizeTabPrefs({ order: ["runway", "runway", "atlantis", "zts"] });
    expect([...p.order].sort()).toEqual([...APPS].sort());
    expect(p.order.slice(0, 2)).toEqual(["runway", "zts"]); // stated order respected first
  });

  it("drops a hidden id that is no longer a tool", () => {
    expect(normalizeTabPrefs({ hidden: ["macro", "atlantis"] }).hidden).toEqual(["macro"]);
  });

  it("an explicitly empty hidden list means nothing hidden — not 'fall back to defaults'", () => {
    // Distinguishing "the operator un-hid everything" from "no preference yet"
    // is the whole reason this reads `?? DEFAULT_HIDDEN` rather than `||`.
    expect(normalizeTabPrefs({ hidden: [] }).hidden).toEqual([]);
    expect(visibleTabs({ hidden: [] })).toEqual([...APPS]);
  });

  it("reports hidden in order position, not in the order they were written", () => {
    const p = normalizeTabPrefs({ hidden: ["business", "clarify"] });
    expect(p.hidden).toEqual(["clarify", "business"]);
  });
});

describe("invariant: a new tool must reach an operator who already has prefs", () => {
  it("appends any APPS entry the stored order predates, and leaves it visible", () => {
    // Simulates prefs saved before a tool existed: only two ids stored.
    const p = normalizeTabPrefs({ order: ["zts", "clarify"], hidden: [] });
    expect([...p.order].sort()).toEqual([...APPS].sort());
    for (const app of APPS) if (!["zts", "clarify"].includes(app)) expect(p.hidden).not.toContain(app);
    expect(visibleTabs(p)).toEqual(p.order);
  });
});

describe("invariant: never zero visible tabs", () => {
  it("refuses to hide the last visible tool", () => {
    const p = normalizeTabPrefs({ hidden: APPS.filter((a) => a !== "zts") });
    expect(visibleTabs(p)).toEqual(["zts"]);
    expect(toggleTab(p, "zts")).toEqual(p);
    expect(visibleTabs(toggleTab(p, "zts"))).toEqual(["zts"]);
  });

  it("canHide answers before the tap, so the UI can disable and explain", () => {
    const p = normalizeTabPrefs({ hidden: APPS.filter((a) => a !== "zts") });
    expect(canHide(p, "zts")).toBe(false);   // the last one standing
    expect(canHide(fresh(), "clarify")).toBe(true);
    expect(canHide(fresh(), "macro")).toBe(false);   // already hidden
    expect(canHide(fresh(), "atlantis")).toBe(false); // not a tool
  });

  it("reveals the first tool if storage somehow hid every one of them", () => {
    const p = normalizeTabPrefs({ hidden: [...APPS] });
    expect(visibleTabs(p).length).toBe(1);
    expect(visibleTabs(p)[0]).toBe(p.order[0]);
  });
});

describe("toggleTab", () => {
  it("shows a hidden tool and hides a shown one", () => {
    let p = fresh();
    expect(isHidden(p, "macro")).toBe(true);
    p = toggleTab(p, "macro");
    expect(isHidden(p, "macro")).toBe(false);
    expect(visibleTabs(p)).toContain("macro");
    p = toggleTab(p, "macro");
    expect(isHidden(p, "macro")).toBe(true);
  });

  it("restores a re-shown tool to its original position, not to the end", () => {
    // Order is preserved independently of visibility, so un-hiding is not a
    // second decision about where the tool goes.
    const p = toggleTab(fresh(), "macro");
    expect(visibleTabs(p)).toEqual(["zts", "clarify", "runway", "macro", "sync"]);
  });

  it("ignores an unknown id rather than inventing a tab", () => {
    const p = fresh();
    expect(toggleTab(p, "atlantis")).toEqual(p);
  });

  it("never mutates the object it was given", () => {
    const p = fresh();
    const snapshot = JSON.stringify(p);
    toggleTab(p, "macro");
    expect(JSON.stringify(p)).toBe(snapshot);
  });
});

describe("moveTab", () => {
  it("moves a tool earlier and later", () => {
    let p = fresh();
    p = moveTab(p, "clarify", -1);
    expect(p.order.slice(0, 2)).toEqual(["clarify", "zts"]);
    p = moveTab(p, "clarify", 1);
    expect(p.order.slice(0, 2)).toEqual(["zts", "clarify"]);
  });

  it("refuses to move past either end", () => {
    const p = fresh();
    expect(moveTab(p, p.order[0], -1).order).toEqual(p.order);
    expect(moveTab(p, p.order[p.order.length - 1], 1).order).toEqual(p.order);
  });

  it("moves within the FULL order, so a hidden neighbour is not skipped", () => {
    // Otherwise re-showing a hidden tool would put it somewhere the operator
    // never placed it.
    const p = moveTab(fresh(), "runway", 1);      // runway swaps with hidden macro
    expect(p.order).toEqual(["zts", "clarify", "macro", "runway", "looper", "business", "sync"]);
    expect(visibleTabs(p)).toEqual(["zts", "clarify", "runway", "sync"]); // visible order unchanged
  });

  it("carries hidden state through a reorder", () => {
    const p = moveTab(fresh(), "business", -1);
    expect(p.hidden.sort()).toEqual([...DEFAULT_HIDDEN].sort());
  });

  it("ignores an unknown id", () => {
    const p = fresh();
    expect(moveTab(p, "atlantis", 1).order).toEqual(p.order);
  });
});

describe("resolveActive — hiding the tool you are looking at", () => {
  it("keeps the active tool when it is still visible", () => {
    expect(resolveActive(fresh(), "clarify")).toBe("clarify");
  });

  it("falls back to the first visible tool when the active one is hidden", () => {
    // The only answer that cannot strand the operator on a surface the toggle
    // can no longer reach.
    expect(resolveActive(fresh(), "macro")).toBe("zts");
  });

  it("falls back for an unknown active id too", () => {
    expect(resolveActive(fresh(), "atlantis")).toBe("zts");
  });

  it("always returns something renderable", () => {
    for (const app of [...APPS, null, undefined, "nope"]) {
      expect(visibleTabs(fresh())).toContain(resolveActive(fresh(), app));
    }
  });
});

describe("resetTabPrefs", () => {
  it("returns to APPS order with the shipped defaults hidden", () => {
    const messed = moveTab(toggleTab(fresh(), "macro"), "runway", -1);
    expect(messed.order).not.toEqual([...APPS]);
    const reset = resetTabPrefs();
    expect(reset.order).toEqual([...APPS]);
    expect(reset.hidden).toEqual([...DEFAULT_HIDDEN]);
  });
});
