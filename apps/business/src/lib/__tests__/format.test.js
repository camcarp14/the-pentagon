import { describe, it, expect } from "vitest";
import { shortAge, ageLabel, countdown, usd, pct, signed, ageOf, toMs, newestAt } from "../format.js";

// Every assertion below pins an explicit number. Nothing in this file reads the
// real clock, so a test cannot pass on a Tuesday and fail on a Wednesday.
const NOW = Date.parse("2026-07-26T12:00:00Z");

describe("countdown past zero", () => {
  // The failure this guards: a veto countdown that floors at "0:00" reads as
  // "you still have a moment" forever. The agent has ALREADY acted by then, and
  // the row is the only place that fact is recorded.
  it("an elapsed deadline says expired, never 0:00", () => {
    const c = countdown(-240_000); // deadline passed four minutes ago
    expect(c.expired).toBe(true);
    expect(c.text).not.toBe("0:00");
    expect(c.text).toBe("expired 4m ago");
  });

  it("exactly zero is already expired, not the last tickable second", () => {
    // `<= 0`, not `< 0`. At the instant the deadline lands the window is shut —
    // the RLS policy checks `veto_until > now()`, so a UI that still renders a
    // live countdown at 0 is offering a button the database will refuse.
    const c = countdown(0);
    expect(c.expired).toBe(true);
    expect(c.text).not.toBe("0:00");
    expect(c.text).toMatch(/^expired/);
  });

  it("an unusable remaining value is expired, not treated as time on the clock", () => {
    // null/NaN arriving from a row with no deadline must fail toward "gone",
    // because the alternative is rendering a reassuring timer for a decision
    // that can no longer be made.
    for (const bad of [NaN, null, undefined, Infinity, -Infinity, "soon"]) {
      const c = countdown(bad);
      expect(c.expired, `countdown(${String(bad)}) must be expired`).toBe(true);
      expect(c.text).toBe("expired");
    }
  });

  it("live windows render as a clock and switch to h:mm:ss past an hour", () => {
    expect(countdown(59_000).text).toBe("0:59");
    expect(countdown(90_000).text).toBe("1:30");
    expect(countdown(3_599_000).text).toBe("59:59");
    expect(countdown(3_600_000).text).toBe("1:00:00");
    expect(countdown(3_600_000).expired).toBe(false);
  });

  it("truncates rather than rounds, so a countdown never displays a second it has not reached", () => {
    // Rounding up would show "1:00" while 59.9s remain, which reads as more
    // time than there is.
    expect(countdown(59_999).text).toBe("0:59");
  });
});

describe("shortAge boundaries", () => {
  it("a negative or unreadable age is a dash, never a confident small number", () => {
    // A clock skew that makes `now - rowTime` negative must not render "0s ago",
    // which is the most reassuring string on the page.
    for (const bad of [-1, -60_000, NaN, Infinity, null, undefined, "abc"]) {
      expect(shortAge(bad), `shortAge(${String(bad)})`).toBe("—");
    }
  });

  it("crosses from seconds to minutes to hours to days at the documented points", () => {
    expect(shortAge(0)).toBe("0s");
    expect(shortAge(59_000)).toBe("59s");
    expect(shortAge(60_000)).toBe("1m");
    expect(shortAge(3_540_000)).toBe("59m");     // 59 minutes
    expect(shortAge(3_600_000)).toBe("1h");      // exactly an hour
    expect(shortAge(5_400_000)).toBe("1h 30m");  // sub-10h keeps the minutes
    expect(shortAge(37_800_000)).toBe("10h");    // 10h+ drops them
    expect(shortAge(172_800_000)).toBe("2d");    // 48h is the day boundary
  });

  it("rounds seconds up into minutes instead of printing '60s'", () => {
    expect(shortAge(59_500)).toBe("1m");
  });

  it("ageLabel says 'never' rather than '— ago' when the age is unusable", () => {
    expect(ageLabel(NaN)).toBe("never");
    expect(ageLabel(60_000)).toBe("1m ago");
  });
});

describe("toMs", () => {
  // toMs is the single parser every other module funnels timestamps through.
  // If it invented a number for junk, every downstream freshness/deadline
  // decision would be made against that invented number.
  it("returns null — not 0, not NaN — for absent input", () => {
    expect(toMs(null)).toBe(null);
    expect(toMs(undefined)).toBe(null);
    expect(toMs("")).toBe(null);
  });

  it("returns null for garbage rather than NaN, which would poison comparisons", () => {
    // `NaN > x` and `NaN < x` are both false, so a NaN leaking out of here would
    // make a stale row silently compare as neither fresh nor stale.
    for (const junk of ["not a date", "2026-13-45", {}, [], NaN, "yesterday"]) {
      expect(toMs(junk), `toMs(${JSON.stringify(junk)})`).toBe(null);
    }
  });

  it("passes numeric epochs through, including 0", () => {
    // 0 is a real epoch and must not be swallowed by a falsy check.
    expect(toMs(0)).toBe(0);
    expect(toMs(NOW)).toBe(NOW);
  });

  it("parses the ISO strings Postgres actually returns", () => {
    expect(toMs("2026-07-26T12:00:00Z")).toBe(NOW);
    expect(toMs("2026-07-26T12:00:00.000Z")).toBe(NOW);
    expect(toMs("2026-07-26T12:00:00+00:00")).toBe(NOW);
  });

  it("ageOf reports null instead of an age when the timestamp is unusable", () => {
    expect(ageOf(null, NOW)).toBe(null);
    expect(ageOf("junk", NOW)).toBe(null);
    expect(ageOf("2026-07-26T11:00:00Z", NOW)).toBe(3_600_000);
  });
});

describe("newestAt", () => {
  it("returns null for an empty array, so 'no rows' cannot masquerade as an age", () => {
    // Returning 0 or Date.now() here would hand the freshness layer a timestamp
    // for data that does not exist — the exact collapse of EMPTY into FRESH.
    expect(newestAt([], "occurred_at")).toBe(null);
    expect(newestAt(null, "occurred_at")).toBe(null);
    expect(newestAt(undefined, "occurred_at")).toBe(null);
  });

  it("ignores unparseable values rather than letting them win the max", () => {
    const rows = [
      { occurred_at: "2026-07-26T10:00:00Z" },
      { occurred_at: "not a date" },
      { occurred_at: null },
      { occurred_at: "2026-07-26T11:30:00Z" },
      { occurred_at: "" },
    ];
    expect(newestAt(rows, "occurred_at")).toBe(Date.parse("2026-07-26T11:30:00Z"));
  });

  it("returns null when nothing in a non-empty array parses", () => {
    // The panel must be told "I cannot date these rows" so it can refuse to
    // claim freshness — not handed a fallback number.
    expect(newestAt([{ occurred_at: "junk" }, { occurred_at: null }], "occurred_at")).toBe(null);
  });

  it("survives null rows and a missing column", () => {
    expect(newestAt([null, undefined, {}], "occurred_at")).toBe(null);
    expect(newestAt([null, { occurred_at: NOW }], "occurred_at")).toBe(NOW);
  });
});

describe("money and percent formatting", () => {
  it("never renders a non-number as a number", () => {
    // "$NaN" is ugly; "$0" for a missing value is dangerous.
    for (const bad of [NaN, Infinity, null, undefined, "12"]) {
      expect(usd(bad), `usd(${String(bad)})`).toBe("—");
      expect(pct(bad), `pct(${String(bad)})`).toBe("—");
      expect(signed(bad), `signed(${String(bad)})`).toBe("—");
    }
  });

  it("keeps cents where they matter and drops them where they do not", () => {
    expect(usd(4.2)).toBe("$4.20");
    expect(usd(150)).toBe("$150");
    expect(usd(1500)).toBe("$1,500");
    expect(usd(150, { cents: true })).toBe("$150.00");
  });

  it("signed marks direction explicitly, including a genuine zero", () => {
    expect(signed(3)).toBe("+3");
    expect(signed(-3)).toBe("−3");
    expect(signed(0)).toBe("0");
  });
});
