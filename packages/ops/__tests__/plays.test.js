import { describe, it, expect } from "vitest";
import { enginePhase, enginePlays, doneState, phaseRank, humanGap, PHASE } from "../plays.js";
import { armWrites, disarmWrites, subsystemWrites, armState, SUBSYSTEMS } from "../arm.js";
import { cadenceFor, CADENCE_MS } from "../cadence.js";

const NOW = Date.parse("2026-07-26T12:00:00Z");
const agoMs = (ms) => new Date(NOW - ms).toISOString();

const ON = { enabled: true, dry_run: false, paused_reason: null };
const run = (over = {}) => ({ started_at: agoMs(60_000), ok: true, actions: 1, blocked: 0, note: "drafted something", ...over });

const ready = { ready: true, missing: [], global: ON, subsystem: { key: "x", ...ON }, lastRuns: [run()], queue: [], now: NOW };

describe("phase precedence", () => {
  it("is strictly ordered", () => {
    expect(phaseRank(PHASE.UNPOINTED)).toBeLessThan(phaseRank(PHASE.DISARMED));
    expect(phaseRank(PHASE.DISARMED)).toBeLessThan(phaseRank(PHASE.REHEARSING));
    expect(phaseRank(PHASE.REHEARSING)).toBeLessThan(phaseRank(PHASE.BLOCKED));
    expect(phaseRank(PHASE.BLOCKED)).toBeLessThan(phaseRank(PHASE.WAITING));
    expect(phaseRank(PHASE.WAITING)).toBeLessThan(phaseRank(PHASE.IDLE));
  });

  it("reports UNPOINTED even when everything else is also wrong", () => {
    // The whole point of precedence: the FIRST thing to fix is named first,
    // rather than the loudest thing.
    const p = enginePhase({ ready: false, missing: ["who it's for"], global: null, subsystem: null, now: NOW });
    expect(p.phase).toBe(PHASE.UNPOINTED);
    expect(p.detail).toContain("who it's for");
  });

  it("reports DISARMED when pointed but the global switch is off", () => {
    const p = enginePhase({ ...ready, global: { enabled: false } });
    expect(p.phase).toBe(PHASE.DISARMED);
  });

  it("reports DISARMED when global is on but the SUBSYSTEM row is off", () => {
    // The exact trap: arming only the global row leaves every pass blocked on
    // SUBSYSTEM_OFF, and the operator sees an armed-looking system doing nothing.
    const p = enginePhase({ ...ready, subsystem: { key: "x", enabled: false, dry_run: false } });
    expect(p.phase).toBe(PHASE.DISARMED);
  });

  it("names the stop reason rather than saying 'off'", () => {
    const p = enginePhase({ ...ready, global: { enabled: false, paused_reason: "stopped from the Ops console" } });
    expect(p.phase).toBe(PHASE.DISARMED);
    expect(p.detail).toBe("stopped from the Ops console");
  });

  it("reports REHEARSING — the state that costs money and keeps nothing", () => {
    const p = enginePhase({ ...ready, subsystem: { key: "x", enabled: true, dry_run: true } });
    expect(p.phase).toBe(PHASE.REHEARSING);
    expect(p.headline).toMatch(/costing money/i);
    expect(p.ok).toBe(false);
  });

  it("surfaces a blocked pass with the engine's own words", () => {
    const p = enginePhase({ ...ready, lastRuns: [run({ blocked: 1, actions: 0, note: "blocked: hourly spend cap reached" })] });
    expect(p.phase).toBe(PHASE.BLOCKED);
    expect(p.detail).toBe("blocked: hourly spend cap reached");
  });

  it("surfaces a failed pass", () => {
    const p = enginePhase({ ...ready, lastRuns: [run({ ok: false, note: "ANTHROPIC_UNAUTHORIZED: key rejected" })] });
    expect(p.phase).toBe(PHASE.BLOCKED);
    expect(p.detail).toContain("ANTHROPIC_UNAUTHORIZED");
  });

  it("prefers WAITING over STALE when both exist", () => {
    const p = enginePhase({ ...ready, queue: [{ stale: false }, { stale: true }] });
    expect(p.phase).toBe(PHASE.WAITING);
    expect(p.headline).toBe("1 waiting on you");
    expect(p.detail).toContain("1 more have gone stale");
  });

  it("reports STALE when everything in the queue is stale", () => {
    const p = enginePhase({ ...ready, queue: [{ stale: true }, { stale: true }] });
    expect(p.phase).toBe(PHASE.STALE);
    expect(p.headline).toBe("2 gone stale");
  });
});

describe("the never-run case", () => {
  it("says so explicitly instead of 'nothing waiting'", () => {
    // ops_runs is empty in production right now. Rendering that as a calm
    // "nothing waiting" is the single most misleading thing this could do.
    const p = enginePhase({ ...ready, lastRuns: [] });
    expect(p.phase).toBe(PHASE.IDLE);
    expect(p.headline).toBe("Has never run");
    expect(p.ok).toBe(false);
    expect(p.detail).toMatch(/credentials/i);
  });

  it("distinguishes 'caught up' from 'running but producing nothing'", () => {
    const caughtUp = enginePhase({ ...ready, lastRuns: [run({ actions: 1 })] });
    expect(caughtUp.headline).toBe("Nothing waiting");
    expect(caughtUp.ok).toBe(true);

    const sterile = enginePhase({ ...ready, lastRuns: [run({ actions: 0, note: "no prospects waiting for a first draft" })] });
    expect(sterile.headline).toBe("Running, producing nothing");
    expect(sterile.ok).toBe(false);
    expect(sterile.detail).toBe("no prospects waiting for a first draft");
  });
});

describe("enginePlays()", () => {
  it("always puts the phase's own remedy first", () => {
    const phase = enginePhase({ ...ready, global: { enabled: false } });
    const plays = enginePlays({
      phase,
      extras: [{ id: "other", count: 9, weight: 99, title: "something with a huge weight", sub: "", action: "queue" }],
    });
    expect(plays[0].id).toBe("arm");
    expect(plays[1].id).toBe("other");
  });

  it("drops zero-count extras", () => {
    const phase = enginePhase(ready);
    const plays = enginePlays({ phase, extras: [{ id: "none", count: 0, weight: 5, title: "x" }] });
    expect(plays.find((p) => p.id === "none")).toBeUndefined();
  });

  it("weight-sorts the extras", () => {
    const phase = enginePhase({ ...ready, queue: [{ stale: false }] });
    const plays = enginePlays({
      phase,
      extras: [
        { id: "low", count: 1, weight: 1, title: "l" },
        { id: "high", count: 1, weight: 9, title: "h" },
      ],
    });
    expect(plays.map((p) => p.id)).toEqual(["review", "high", "low"]);
  });

  it("emits no remedy when genuinely caught up", () => {
    const phase = enginePhase(ready);
    expect(enginePlays({ phase, extras: [] })).toEqual([]);
  });

  it("survives empty everything", () => {
    expect(() => enginePlays({ phase: enginePhase({ now: NOW }) })).not.toThrow();
  });
});

describe("doneState()", () => {
  it("refuses to call it done when nothing has ever run", () => {
    expect(doneState({ lastRuns: [], now: NOW }).ok).toBe(false);
  });

  it("is done only when a recent pass actually did something", () => {
    expect(doneState({ lastRuns: [run({ actions: 1 })], now: NOW }).ok).toBe(true);
    expect(doneState({ lastRuns: [run({ actions: 0 })], now: NOW }).ok).toBe(false);
  });

  it("does not count a productive pass from last week", () => {
    const old = run({ actions: 5, started_at: agoMs(8 * 86_400_000) });
    expect(doneState({ lastRuns: [old], now: NOW }).ok).toBe(false);
  });
});

describe("armWrites()", () => {
  it("writes the global row AND every subsystem row", () => {
    // One-row arming is the four-hours-of-nothing bug.
    const rows = armWrites({ at: "2026-07-26T12:00:00.000Z" });
    expect(rows).toHaveLength(SUBSYSTEMS.length + 1);
    expect(rows.map((r) => r.key)).toContain("global");
    for (const s of SUBSYSTEMS) expect(rows.map((r) => r.key)).toContain(s);
  });

  it("clears dry_run on every row", () => {
    // Arming into dry-run pays for generations and discards them.
    for (const row of armWrites({ at: "x" })) expect(row.dry_run).toBe(false);
  });

  it("clears any previous pause", () => {
    for (const row of armWrites({ at: "x" })) {
      expect(row.enabled).toBe(true);
      expect(row.paused_reason).toBeNull();
      expect(row.paused_at).toBeNull();
    }
  });
});

describe("disarmWrites()", () => {
  it("touches only the global row", () => {
    const rows = disarmWrites({ reason: "r", at: "x" });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("global");
  });

  it("records why, so 'never armed' and 'stopped' stay distinguishable", () => {
    expect(disarmWrites({ reason: "stopped from the Ops console", at: "x" })[0].paused_reason)
      .toBe("stopped from the Ops console");
  });

  it("does not touch per-subsystem enable flags", () => {
    // Re-arming must not silently switch on something deliberately disabled.
    const rows = disarmWrites({ at: "x" });
    expect(Object.keys(rows[0])).not.toContain("dry_run");
  });
});

describe("subsystemWrites()", () => {
  it("turns one engine off without touching the global row or its siblings", () => {
    const rows = subsystemWrites("zts.content", false, { at: "t" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ key: "zts.content", enabled: false, updated_at: "t" });
  });

  it("off is enabled:false, NOT a pause", () => {
    // A pause is an emergency stop that also blocks manual sends. Switching one
    // engine off must not do that.
    const row = subsystemWrites("clarify.outbound", false, { at: "t" })[0];
    expect(row.paused_reason).toBeUndefined();
    expect(row.paused_at).toBeUndefined();
  });

  it("turning on also clears dry_run and any pause", () => {
    const row = subsystemWrites("clarify.outbound", true, { at: "t" })[0];
    expect(row).toMatchObject({ enabled: true, dry_run: false, paused_reason: null, paused_at: null });
  });

  it("refuses to be pointed at the global row", () => {
    // Otherwise "turn off the writer" would silently become "stop everything".
    expect(() => subsystemWrites("global", false)).toThrow();
    expect(() => subsystemWrites("", false)).toThrow();
  });
});

describe("armState()", () => {
  const sub = (over = {}) => ({ key: "s", enabled: true, dry_run: false, ...over });

  it("reports unknown rather than 'off' when the table is unreadable", () => {
    expect(armState({ global: null }).state).toBe("unknown");
  });

  it("reports stopped with the reason", () => {
    expect(armState({ global: { enabled: false, paused_reason: "why" } })).toMatchObject({ state: "stopped", detail: "why" });
  });

  it("reports off when the master switch is down", () => {
    expect(armState({ global: { enabled: false }, subsystems: [sub()] }).state).toBe("off");
  });

  it("reports off when global is on but every subsystem is off", () => {
    expect(armState({ global: { enabled: true }, subsystems: [sub({ enabled: false })] }).state).toBe("off");
  });

  it("names the money-burning state", () => {
    const s = armState({ global: { enabled: true }, subsystems: [sub({ dry_run: true })] });
    expect(s.state).toBe("rehearsing");
    expect(s.detail).toMatch(/costing money/i);
  });

  it("flags a partial rehearsal rather than calling it armed", () => {
    const s = armState({ global: { enabled: true }, subsystems: [sub({ key: "a" }), sub({ key: "b", dry_run: true })] });
    expect(s.state).toBe("rehearsing");
    expect(s.detail).toContain("b");
  });

  it("reports armed only when everything live is keeping its output", () => {
    expect(armState({ global: { enabled: true }, subsystems: [sub(), sub({ key: "t" })] }).state).toBe("armed");
  });
});

describe("cadence + humanGap", () => {
  it("knows every scheduled subsystem", () => {
    for (const s of SUBSYSTEMS) expect(cadenceFor(s)).toBeGreaterThan(0);
    expect(CADENCE_MS["clarify.replies"]).toBe(900_000);
  });
  it("returns 0 for an unknown subsystem rather than undefined", () => {
    expect(cadenceFor("nope")).toBe(0);
  });
  it("formats coarsely", () => {
    expect(humanGap(30_000)).toBe("just now");
    expect(humanGap(5 * 60_000)).toBe("5m");
    expect(humanGap(3 * 3_600_000)).toBe("3h");
    expect(humanGap(2 * 86_400_000)).toBe("2d");
    expect(humanGap(NaN)).toBe("");
  });
});
