// ─── when the next scan is due ───────────────────────────────────────────────
//
// A review queue owes an answer a feed never did: you have reached the end, so
// when is there more. The tempting answer is the one written in a comment —
// "four times a day" — and this file exists to make sure that sentence can only
// ever come from ideafeed_runs rows we actually fetched.

import { describe, it, expect } from "vitest";
import { scanCadence, fmtSpan } from "../cadence.js";

const H = 3600000;
const at = (iso) => ({ ran_at: iso });
// Six hours apart, newest first — the shape the query returns.
const SIX_HOURLY = [
  at("2026-08-01T18:00:00.000Z"), at("2026-08-01T12:00:00.000Z"),
  at("2026-08-01T06:00:00.000Z"), at("2026-08-01T00:00:00.000Z"),
];
const NOW = Date.parse("2026-08-01T20:00:00.000Z");

describe("it measures the interval instead of asserting one", () => {
  it("takes the median gap and projects the next run", () => {
    const c = scanCadence(SIX_HOURLY, NOW);
    expect(c.ok).toBe(true);
    expect(c.everyMs).toBe(6 * H);
    expect(c.samples).toBe(3);
    expect(c.nextAt).toBe(Date.parse("2026-08-02T00:00:00.000Z"));
    expect(c.text).toContain("every 6h");
    expect(c.text).toContain("median of the last 3 gaps");
    expect(c.text).toContain("due in about 4h");
  });

  it("is not dragged by one failed cron, which is why it is a median", () => {
    // A mean over these gaps is 10h and would push the next run four hours late.
    const withGap = [
      at("2026-08-01T18:00:00.000Z"), at("2026-08-01T12:00:00.000Z"),
      at("2026-08-01T06:00:00.000Z"), at("2026-07-31T12:00:00.000Z"),
    ];
    expect(scanCadence(withGap, NOW).everyMs).toBe(6 * H);
  });

  it("says a run is overdue rather than promising one in negative time", () => {
    const late = scanCadence(SIX_HOURLY, Date.parse("2026-08-02T09:00:00.000Z"));
    expect(late.text).toContain("overdue");
    expect(late.text).toContain("9h");
    expect(late.text).not.toMatch(/-\d/);
  });

  it("does not care what order the rows arrive in", () => {
    const shuffled = [SIX_HOURLY[2], SIX_HOURLY[0], SIX_HOURLY[3], SIX_HOURLY[1]];
    expect(scanCadence(shuffled, NOW)).toEqual(scanCadence(SIX_HOURLY, NOW));
  });

  it("reads two runs as one gap, and says so", () => {
    const c = scanCadence(SIX_HOURLY.slice(0, 2), NOW);
    expect(c.ok).toBe(true);
    expect(c.samples).toBe(1);
    expect(c.text).toContain("last 1 gap");
    expect(c.text).not.toContain("gaps");
  });
});

describe("a missing input becomes a stated reason, never a default", () => {
  const noNumber = (c) => {
    expect(c.ok).toBe(false);
    expect(c.everyMs).toBe(null);
    expect(c.nextAt).toBe(null);
    // The refusal must not read like a measurement.
    expect(c.text).not.toMatch(/every|due in|overdue/);
    expect(c.text.endsWith(".")).toBe(true);
  };

  it("refuses with ONE run — there is no interval in a single timestamp", () => {
    const c = scanCadence([at("2026-08-01T18:00:00.000Z")], NOW);
    noNumber(c);
    expect(c.text).toContain("Only one scan");
  });

  it("refuses with no runs at all", () => {
    for (const empty of [[], null, undefined, "nope", 7, {}]) {
      const c = scanCadence(empty, NOW);
      noNumber(c);
      expect(c.text, String(empty)).toContain("No scan is on record");
    }
  });

  it("refuses when the timestamps are unusable, rather than reading them as 1970", () => {
    const c = scanCadence([at(null), at("not a date"), at(undefined), {}], NOW);
    noNumber(c);
    expect(c.text).toContain("No scan is on record");
  });

  it("refuses when every recorded run shares a timestamp", () => {
    const same = [at("2026-08-01T18:00:00.000Z"), at("2026-08-01T18:00:00.000Z"), at("2026-08-01T18:00:00.000Z")];
    const c = scanCadence(same, NOW);
    noNumber(c);
    expect(c.text).toContain("share a timestamp");
  });

  it("keeps the good rows when only some timestamps are junk", () => {
    const c = scanCadence([at("2026-08-01T18:00:00.000Z"), at("bad"), at("2026-08-01T12:00:00.000Z")], NOW);
    expect(c.ok).toBe(true);
    expect(c.everyMs).toBe(6 * H);
    expect(c.samples).toBe(1);
  });
});

describe("fmtSpan", () => {
  it("never rounds a real duration down to zero", () => {
    expect(fmtSpan(1)).toBe("1m");
    expect(fmtSpan(29000)).toBe("1m");
  });

  it("climbs units and keeps one decimal only where it reads", () => {
    expect(fmtSpan(45 * 60000)).toBe("45m");
    expect(fmtSpan(5.5 * H)).toBe("5.5h");
    expect(fmtSpan(23 * H)).toBe("23h");
    expect(fmtSpan(36 * H)).toBe("1.5d");
    expect(fmtSpan(30 * 24 * H)).toBe("30d");
  });

  it("is unsigned, so a caller supplies the direction word", () => {
    expect(fmtSpan(-6 * H)).toBe("6h");
  });

  it("says nothing rather than NaN", () => {
    for (const junk of [null, undefined, "x", NaN, Infinity]) expect(fmtSpan(junk), String(junk)).toBe("—");
  });
});
