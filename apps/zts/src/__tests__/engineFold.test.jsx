import { describe, expect, it } from "vitest";
import { PHASE } from "@cc/ops/plays.js";
import { collapsedRead } from "../EnginePanel.jsx";
import { normalizeEnginePanelPrefs, resolveOpen } from "../enginePanelPrefs.js";

const quiet = { phase: PHASE.IDLE, ok: true, headline: "Nothing waiting", detail: "All caught up." };
const stopped = { phase: PHASE.DISARMED, ok: false, headline: "Stopped", detail: "stopped from the console" };
const base = { loaded: true, err: "", controlRead: true, lastPassMs: null };

describe("the ZTS writer fold", () => {
  it("starts closed for a healthy writer and opens for a problem", () => {
    expect(resolveOpen({ open: null }, false)).toBe(false);
    expect(resolveOpen({ open: false }, true)).toBe(true);
    expect(resolveOpen({ open: true }, null)).toBe(true);
  });

  it("never calls an unread control row healthy", () => {
    expect(collapsedRead({ ...base, controlRead: false, phase: quiet })).toEqual({
      attention: true, tone: "bad", line: "State unreadable — the control table did not load",
    });
  });

  it("keeps productive review work folded but surfaces a stop", () => {
    expect(collapsedRead({ ...base, phase: quiet }).attention).toBe(false);
    expect(collapsedRead({ ...base, phase: stopped, stopReason: "stopped from the console" })).toMatchObject({
      attention: true, tone: "bad", line: "Stopped · stopped from the console",
    });
  });

  it("accepts only explicit boolean preferences", () => {
    expect(normalizeEnginePanelPrefs({ open: "yes" })).toEqual({ open: null });
    expect(normalizeEnginePanelPrefs({ open: false })).toEqual({ open: false });
  });
});
