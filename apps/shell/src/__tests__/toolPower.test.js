// The pause store, from the shell's side of the wire.
//
// The stake: this is the model behind a switch whose only job is to be TRUE. A
// tab preference that renders wrong costs a confused glance; a power switch that
// renders "paused" over a cron that is still running costs the operator their
// belief that anything on this screen means what it says.
//
// The rules pinned here are the ones whose failure is a lie rather than a bug.
import { describe, it, expect } from "vitest";
import { APPS } from "@cc/design";
import {
  normalizeToolPower, powerFor, pausedTools, hasEngines, withPaused, mergeToolPower,
  stopsSentence, stoppedSentence, keepsSentence, joinPhrase, engineLabel, ENGINE_LABELS,
} from "../toolPower.js";

// Shaped exactly like netlify/shared/toolPower.mjs's summariseAll — including
// the fields the first draft of this file did not know about. `enabled` is
// present and deliberately CONTRADICTS `paused` on two rows, because that is the
// real table: rows ship disabled (autonomy is opt-in) while their crons run.
const payload = () => ({
  tools: {
    zts: {
      label: "zts", pausable: true, paused: false, partial: false, mixed: false, stopped: [],
      stops: "Pauses the content engine and store ingest.", keeps: null,
      engines: [
        { key: "zts.content", label: "the content engine", cron: "content-engine", keeps: null, registered: true, enabled: false, paused: false, pausedReason: null, pausedAt: null },
        { key: "zts.store", label: "store ingest", cron: "zts-ingest", keeps: null, registered: true, enabled: true, paused: false, pausedReason: null, pausedAt: null },
      ],
    },
    macro: {
      label: "macro", pausable: true, paused: true, partial: false, mixed: false,
      stopped: ["macro.watch", "macro.alts"],
      stops: "Pauses the MSTR stop sentinel and the alt sentinel.",
      keeps: "Still records the daily BTC-dominance sample, which nothing can backfill.",
      engines: [
        { key: "macro.watch", label: "the MSTR stop sentinel", keeps: null, registered: true, enabled: true, paused: true, pausedReason: "paused from the tool switch", pausedAt: "2026-07-31T09:00:00.000Z" },
        { key: "macro.alts", label: "the alt sentinel", keeps: "the daily BTC-dominance sample, which nothing can backfill", registered: true, enabled: true, paused: true, pausedReason: "paused from the tool switch", pausedAt: "2026-07-31T09:00:00.000Z" },
      ],
    },
    looper: { label: "looper", pausable: false, paused: false, partial: false, mixed: false, stopped: [], stops: null, keeps: null, engines: [] },
  },
});

describe("normalizeToolPower — it is fed whatever came back from the network", () => {
  it("survives every shape a response could take", () => {
    // A 404 through the SPA fallback answers with HTML, an outage answers with
    // nothing, and an older deploy answers with a different shape. None of them
    // may take the shell's chrome down.
    for (const bad of [null, undefined, "", "nope", [], 7, { tools: null }, { tools: [] }, { tools: { zts: "yes" } }, { tools: { zts: { engines: "two" } } }]) {
      expect(() => normalizeToolPower(bad)).not.toThrow();
      const p = normalizeToolPower(bad);
      for (const app of APPS) expect(p.tools[app]).toMatchObject({ engines: [], paused: false });
    }
  });

  it("reports an entry for every tool, including ones the server said nothing about", () => {
    const p = normalizeToolPower(payload());
    expect(Object.keys(p.tools).sort()).toEqual([...APPS].sort());
    // `sync` was absent from the payload entirely — it reads as "no engines",
    // which the UI renders as "nothing runs in the background", not as a switch.
    expect(hasEngines(p.tools.sync)).toBe(false);
    expect(p.tools.sync.paused).toBe(false);
  });

  it("reads the PAUSE from paused, never from enabled", () => {
    // THE ONE THAT MATTERS, and the one this file got wrong first time.
    // netlify/shared/toolPower.mjs: rows are seeded `enabled: false` because
    // autonomy is opt-in, so four engines that run perfectly well read
    // "disabled", and an armed engine reads "enabled" while paused. Deriving
    // pause from `enabled` renders ZTS as stopped while its content engine is
    // drafting articles every four hours.
    const p = normalizeToolPower(payload());
    expect(p.tools.zts.engines.find((e) => e.key === "zts.content").paused).toBe(false);
    expect(p.tools.zts.paused, "enabled:false is not a pause").toBe(false);
    expect(p.tools.macro.engines.every((e) => e.paused), "enabled:true is not 'running'").toBe(true);
    expect(p.tools.macro.paused).toBe(true);
  });

  it("falls back to the reason string when the boolean is missing, and to running when both are", () => {
    const p = normalizeToolPower({ tools: { zts: { engines: [
      { key: "zts.content", pausedReason: "paused from the tool switch" },
      { key: "zts.store", enabled: false },
    ] } } });
    expect(p.tools.zts.engines[0].paused).toBe(true);
    // Unknown resolves to RUNNING. The errors are not symmetric: a stopped
    // engine shown as running costs a click; a running engine shown as stopped
    // tells the operator nothing is happening while mail is going out.
    expect(p.tools.zts.engines[1].paused).toBe(false);
    expect(p.tools.zts.paused).toBe(false);
  });

  it("refuses a row whose key belongs to another tool — ops.* can never reach a tool switch", () => {
    const p = normalizeToolPower({ tools: { zts: { engines: [
      { key: "ops.heartbeat", paused: true },
      { key: "clarify.replies", paused: true },
      { key: "zts.content", paused: true },
    ] } } });
    expect(p.tools.zts.engines.map((e) => e.key)).toEqual(["zts.content"]);
    // And it did not quietly become clarify's problem either.
    expect(p.tools.clarify.engines).toEqual([]);
  });

  it("a tool with no engines is never paused, whatever the payload claims", () => {
    const p = normalizeToolPower({ tools: { looper: { paused: true, engines: [] } } });
    // The server's boolean is honoured where it is meaningful, but the UI keys
    // its switch on hasEngines — there is nothing here to stop, so there is no
    // control, and `stopsSentence` has nothing to promise.
    expect(hasEngines(p.tools.looper)).toBe(false);
    expect(stopsSentence(p.tools.looper)).toBeNull();
  });

  it("half-paused is its own state, not rounded to the comfortable one", () => {
    const p = normalizeToolPower({ tools: { clarify: { engines: [
      { key: "clarify.outbound", paused: true },
      { key: "clarify.replies", paused: false },
    ] } } });
    expect(p.tools.clarify.paused).toBe(false);
    expect(p.tools.clarify.mixed).toBe(true);
    expect(p.tools.clarify.stopped).toEqual(["clarify.outbound"]);
  });
});

describe("the copy is built from the answer, not from a list beside the switch", () => {
  it("prefers the endpoint's own sentence", () => {
    const p = normalizeToolPower(payload());
    expect(stopsSentence(p.tools.zts)).toBe("Pauses the content engine and store ingest.");
  });

  it("builds one from the engine labels when the endpoint sent none", () => {
    const p = normalizeToolPower({ tools: { clarify: { engines: [
      { key: "clarify.outbound", label: "the outbound engine" },
      { key: "clarify.replies", label: "reply detection" },
    ] } } });
    expect(stopsSentence(p.tools.clarify)).toBe("Pauses the outbound engine and reply detection.");
  });

  it("names an engine it has never heard of rather than dropping it", () => {
    // A silently omitted engine is a switch that under-promises what it stops,
    // and nothing would ever surface it. A raw key in the sentence is ugly and
    // therefore gets fixed.
    const p = normalizeToolPower({ tools: { zts: { engines: [{ key: "zts.newthing" }] } } });
    expect(stopsSentence(p.tools.zts)).toBe("Pauses zts.newthing.");
  });

  it("keeps every promise about what a pause does NOT stop", () => {
    // Macro's alt sentinel goes on sampling BTC dominance while paused because
    // that series cannot be rebuilt. An operator told "paused" who later finds a
    // row written on a paused day has been misled by omission.
    const p = normalizeToolPower(payload());
    expect(keepsSentence(p.tools.macro)).toBe("Still records the daily BTC-dominance sample, which nothing can backfill.");
    expect(keepsSentence(p.tools.zts)).toBeNull();
  });

  it("frames a per-engine keeps fragment instead of printing it bare", () => {
    // The tool-level field is already a sentence and the per-engine one is a
    // fragment; conflating them reads "Still records Still records…".
    const p = normalizeToolPower({ tools: { macro: { engines: [
      { key: "macro.alts", label: "the alt sentinel", keeps: "the daily BTC-dominance sample" },
    ] } } });
    expect(keepsSentence(p.tools.macro)).toBe("Still records the daily BTC-dominance sample.");
  });

  it("says what is stopped RIGHT NOW, with number agreement", () => {
    const p = normalizeToolPower(payload());
    expect(stoppedSentence(p.tools.macro)).toBe("the MSTR stop sentinel and the alt sentinel are stopped.");
    expect(stoppedSentence(p.tools.zts)).toBeNull();
    const one = normalizeToolPower({ tools: { zts: { engines: [{ key: "zts.store", label: "store ingest", paused: true }] } } });
    expect(stoppedSentence(one.tools.zts)).toBe("store ingest is stopped.");
  });

  it("joinPhrase reads as English at one, two and three", () => {
    expect(joinPhrase(["a"])).toBe("a");
    expect(joinPhrase(["a", "b"])).toBe("a and b");
    expect(joinPhrase(["a", "b", "c"])).toBe("a, b and c");
    expect(joinPhrase([])).toBe("");
  });

  it("the local label table is a FALLBACK — the server's label wins", () => {
    expect(engineLabel({ key: "zts.store", label: "the store-truth snapshot" })).toBe("the store-truth snapshot");
    expect(engineLabel({ key: "zts.store" })).toBe(ENGINE_LABELS["zts.store"]);
    expect(engineLabel("macro.alts")).toBe("the alt sentinel");
  });
});

describe("the optimistic edit, and the set the tool row dims", () => {
  it("flips every engine of one tool and touches no other", () => {
    const p = normalizeToolPower(payload());
    const next = withPaused(p, "zts", true);
    expect(next.tools.zts.paused).toBe(true);
    expect(next.tools.zts.engines.every((e) => e.paused)).toBe(true);
    expect(next.tools.zts.stopped).toEqual(["zts.content", "zts.store"]);
    expect(next.tools.macro).toEqual(p.tools.macro);
  });

  it("cannot pause a tool with nothing to pause, or a name that is not a tool", () => {
    const p = normalizeToolPower(payload());
    expect(withPaused(p, "looper", true).tools.looper.paused).toBe(false);
    expect(() => withPaused(p, "atlantis", true)).not.toThrow();
    expect(withPaused(p, "atlantis", true).tools.zts).toEqual(p.tools.zts);
  });

  it("clears the half-paused state on the way through", () => {
    const p = normalizeToolPower({ tools: { clarify: { engines: [
      { key: "clarify.outbound", paused: true }, { key: "clarify.replies", paused: false },
    ] } } });
    expect(p.tools.clarify.mixed).toBe(true);
    expect(withPaused(p, "clarify", true).tools.clarify.mixed).toBe(false);
  });

  it("dims nothing when the endpoint could not be read", () => {
    // An unknown pause state must not paint half the bar as stopped — that is a
    // confident claim built on no reading at all, in the direction that makes
    // the operator stop trusting the marking.
    expect([...pausedTools(null)]).toEqual([]);
    expect([...pausedTools(normalizeToolPower(payload()))]).toEqual(["macro"]);
  });

  it("a PUT answer about ONE tool does not erase the others", () => {
    // THE ONE A GREEN SWITCH WOULD HAVE HIDDEN. /api/tool-power's PUT replies
    // with `tools: { [tool]: … }` — only the rows it wrote. Assigning that as
    // the new map gives every other tool `engines: []`, so pausing ZTS un-dims
    // a genuinely paused Macro in the tool row and turns Clarify's and Runway's
    // live switches into "nothing runs in the background". Nothing about the
    // pressed switch looks wrong, which is why it needs its own test.
    const before = normalizeToolPower(payload());
    expect(before.tools.macro.paused).toBe(true);

    const putReply = { tool: "zts", paused: true, tools: { zts: {
      label: "zts", pausable: true, paused: true, partial: false, mixed: false,
      stopped: ["zts.content", "zts.store"], stops: "Pauses the content engine and store ingest.", keeps: null,
      engines: [
        { key: "zts.content", label: "the content engine", paused: true, pausedReason: "paused from the tool switch" },
        { key: "zts.store", label: "store ingest", paused: true, pausedReason: "paused from the tool switch" },
      ],
    } } };

    const after = mergeToolPower(before, putReply);
    expect(after.tools.zts.paused, "the tool that was written takes the server's answer").toBe(true);
    expect(after.tools.macro, "an untouched tool is left exactly as it was").toEqual(before.tools.macro);
    expect([...pausedTools(after)].sort()).toEqual(["macro", "zts"]);
  });

  it("merging survives a reply with no tools at all, and a bogus tool name", () => {
    const before = normalizeToolPower(payload());
    expect(mergeToolPower(before, { tool: "zts", paused: true })).toEqual(before);
    expect(mergeToolPower(before, { tools: { atlantis: { engines: [{ key: "atlantis.x" }] } } })).toEqual(before);
    expect(() => mergeToolPower(null, null)).not.toThrow();
  });

  it("powerFor always answers a usable entry", () => {
    for (const src of [null, undefined, {}, normalizeToolPower(payload())]) {
      for (const app of [...APPS, "atlantis"]) {
        const e = powerFor(src, app);
        expect(Array.isArray(e.engines)).toBe(true);
        expect(typeof e.paused).toBe("boolean");
      }
    }
  });
});
