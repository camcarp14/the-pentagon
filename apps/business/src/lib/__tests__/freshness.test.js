import { describe, it, expect } from "vitest";
import { panelState, worstState, PANEL, MAX_AGE_MIN } from "../freshness.js";

const NOW = Date.parse("2026-07-26T12:00:00Z");
const MIN = 60_000;

// A panel that is unambiguously healthy, so each test can break exactly one
// thing and prove that one thing is what changed the state. Starting from an
// empty object instead would let a test pass because of a default it never named.
const HEALTHY = {
  status: "ok",
  rowCount: 12,
  newestAtMs: NOW - 2 * MIN,
  fetchedAtMs: NOW - 30_000,
  error: null,
  maxAgeMin: MAX_AGE_MIN,
  expectsRows: true,
  now: NOW,
};
const p = (over = {}) => panelState({ ...HEALTHY, ...over });

describe("the baseline is calm only when everything is actually fine", () => {
  it("a reachable database with recent rows is FRESH and does not alarm", () => {
    const v = p();
    expect(v.state).toBe(PANEL.FRESH);
    expect(v.alarm).toBe(false);
  });
});

describe("the five states never collapse into each other", () => {
  // ── LOADING vs EMPTY ───────────────────────────────────────────────────────
  // The failure: a page that has not heard back yet renders "0 actions". That
  // is the single most common dashboard lie — a spinner-less zero that is
  // indistinguishable from a real, verified zero.
  it("never-fetched is LOADING, not EMPTY", () => {
    for (const status of ["idle", "loading"]) {
      const v = panelState({ status, rowCount: 0, fetchedAtMs: null, newestAtMs: null, now: NOW });
      expect(v.state, `status=${status}`).toBe(PANEL.LOADING);
      expect(v.state).not.toBe(PANEL.EMPTY);
      expect(v.alarm).toBe(false); // not knowing yet is not an emergency
    }
  });

  it("LOADING reports no ages at all rather than zeroes", () => {
    // dataAgeMs: 0 would read as "a row arrived this instant".
    const v = panelState({ status: "loading", rowCount: 0, fetchedAtMs: null, now: NOW });
    expect(v.dataAgeMs).toBe(null);
    expect(v.fetchAgeMs).toBe(null);
  });

  it("a refetch in flight over data we already have does NOT fall back to a skeleton", () => {
    // Once a successful round trip exists, a subsequent `status: 'loading'`
    // must keep showing the real state — otherwise every poll blanks the page.
    const v = p({ status: "loading" });
    expect(v.state).toBe(PANEL.FRESH);
  });

  // ── ERROR vs FRESH ─────────────────────────────────────────────────────────
  // The failure: the fetch throws, the component keeps the rows from the last
  // successful poll, and the panel renders them with no chrome. You are now
  // reading last hour's numbers as if they were live, during an outage — the
  // exact moment you most need to know you cannot see.
  it("a fetch error while STILL HOLDING ROWS is ERROR with an alarm, never fresh data", () => {
    const v = p({ status: "error", error: "TypeError: Failed to fetch", rowCount: 12, newestAtMs: NOW - 30_000 });
    expect(v.state).toBe(PANEL.ERROR);
    expect(v.state).not.toBe(PANEL.FRESH);
    expect(v.alarm).toBe(true);
    expect(v.rowCount).toBe(12);            // the rows are still reported…
    expect(v.detail).toMatch(/not now/i);   // …explicitly labelled as not current
  });

  it("an error outranks every other signal, including rows that look perfect", () => {
    const v = p({ status: "error", error: "500", newestAtMs: NOW });
    expect(v.state).toBe(PANEL.ERROR);
    expect(v.error).toBe("500");
  });

  it("an error with no successful connection at all says so instead of quoting an age", () => {
    const v = panelState({ status: "error", error: "DNS", rowCount: 0, fetchedAtMs: null, now: NOW });
    expect(v.state).toBe(PANEL.ERROR);
    expect(v.alarm).toBe(true);
    expect(v.detail).toMatch(/no successful connection/i);
  });

  // ── EMPTY vs ERROR ─────────────────────────────────────────────────────────
  // The mirror-image failure: a genuinely empty window must not be dressed up as
  // a fault, or the operator learns to ignore the alarm.
  it("zero rows after a SUCCESSFUL fetch is EMPTY, not ERROR", () => {
    const v = p({ rowCount: 0, newestAtMs: null });
    expect(v.state).toBe(PANEL.EMPTY);
    expect(v.state).not.toBe(PANEL.ERROR);
    expect(v.error).toBe(null);
    expect(v.detail).toMatch(/reachable/i);  // says the check itself worked
  });

  it("EMPTY carries the time of the successful check, so 'empty' is verifiable", () => {
    const v = p({ rowCount: 0, newestAtMs: null, fetchedAtMs: NOW - 90_000 });
    expect(v.fetchAgeMs).toBe(90_000);
  });
});

describe("expectsRows decides whether empty is an alarm", () => {
  // An approvals queue nobody has filled is genuinely fine at zero. An action
  // log for an agent that ticks continuously is NOT fine at zero — that is the
  // same news as staleness, arriving through a different door.
  it("expectsRows false makes empty calm", () => {
    const v = p({ rowCount: 0, newestAtMs: null, expectsRows: false });
    expect(v.state).toBe(PANEL.EMPTY);
    expect(v.alarm).toBe(false);
    expect(v.headline).toBe("Nothing here");
  });

  it("expectsRows true makes the same emptiness an alarm", () => {
    const v = p({ rowCount: 0, newestAtMs: null, expectsRows: true });
    expect(v.state).toBe(PANEL.EMPTY);
    expect(v.alarm).toBe(true);
    expect(v.headline).toBe("No rows in the window");
  });

  it("defaults to alarming, because the safe default is to be told", () => {
    const v = panelState({ status: "ok", rowCount: 0, fetchedAtMs: NOW - 1000, now: NOW });
    expect(v.alarm).toBe(true);
  });
});

describe("data age — a stopped agent", () => {
  it("a newest row older than the window is STALE and alarms", () => {
    const v = p({ newestAtMs: NOW - 90 * MIN });
    expect(v.state).toBe(PANEL.STALE);
    expect(v.alarm).toBe(true);
    expect(v.headline).toMatch(/^Stale/);
    // It must name the agent, not the database — the database answered fine.
    expect(v.detail).toMatch(/agent is what stopped/i);
  });

  it("alarms strictly past the threshold, not at it", () => {
    // Exactly at maxAge is still inside the promise; one millisecond past is not.
    expect(p({ newestAtMs: NOW - MAX_AGE_MIN * MIN }).state).toBe(PANEL.FRESH);
    expect(p({ newestAtMs: NOW - MAX_AGE_MIN * MIN - 1 }).state).toBe(PANEL.STALE);
  });

  it("honours a per-panel threshold instead of only the global one", () => {
    // A five-minute panel must not inherit the 45-minute tolerance.
    const tenMinOld = { newestAtMs: NOW - 10 * MIN };
    expect(p({ ...tenMinOld, maxAgeMin: 5 }).state).toBe(PANEL.STALE);
    expect(p({ ...tenMinOld, maxAgeMin: 45 }).state).toBe(PANEL.FRESH);
  });
});

describe("fetch age — a stopped POLLER", () => {
  // The subtle one, and the reason there are two ages rather than one.
  //
  // The loader throws once, or the tab is backgrounded and the interval never
  // resumes. The rows on screen are recent — they were recent when they were
  // fetched — so nothing about the DATA says anything is wrong. The page looks
  // live and is frozen. Only the time since the last successful round trip can
  // catch this.
  it("a stalled poller is STALE even though the ROWS look perfectly fresh", () => {
    const v = p({
      fetchedAtMs: NOW - 60 * MIN,  // no round trip in an hour
      newestAtMs: NOW - 1000,       // …but the rows we're holding are a second old
      rowCount: 25,
    });
    expect(v.state).toBe(PANEL.STALE);
    expect(v.state).not.toBe(PANEL.FRESH);
    expect(v.alarm).toBe(true);
    expect(v.headline).toBe("Not refreshing");
    expect(v.detail).toMatch(/not updating/i);
  });

  it("a stalled poller over ZERO rows still reads as not-refreshing, not as empty", () => {
    // Otherwise a frozen page announces a confident, verified "nothing here".
    const v = p({ fetchedAtMs: NOW - 60 * MIN, newestAtMs: null, rowCount: 0 });
    expect(v.state).toBe(PANEL.STALE);
    expect(v.state).not.toBe(PANEL.EMPTY);
  });

  it("fires strictly past the window, so a healthy poll cadence is not flagged", () => {
    expect(p({ fetchedAtMs: NOW - MAX_AGE_MIN * MIN }).state).toBe(PANEL.FRESH);
    expect(p({ fetchedAtMs: NOW - MAX_AGE_MIN * MIN - 1 }).state).toBe(PANEL.STALE);
  });
});

describe("rows we cannot date", () => {
  it("rows with unparseable timestamps do not get to claim freshness", () => {
    // newestAt() returns null when nothing parses. Treating that as "0ms old"
    // would paint the panel green on data of completely unknown age.
    const v = p({ rowCount: 7, newestAtMs: null });
    expect(v.state).toBe(PANEL.STALE);
    expect(v.state).not.toBe(PANEL.FRESH);
    expect(v.alarm).toBe(true);
    expect(v.headline).toBe("Age unknown");
    expect(v.dataAgeMs).toBe(null);
  });

  it("a NaN timestamp is not silently turned into an age", () => {
    for (const bad of [NaN, undefined, Infinity, "2026-07-26T12:00:00Z"]) {
      const v = p({ rowCount: 7, newestAtMs: bad });
      expect(v.dataAgeMs, `newestAtMs=${String(bad)}`).toBe(null);
      expect(v.state).toBe(PANEL.STALE);
    }
  });
});

describe("clock hygiene", () => {
  it("a row timestamped in the future is clamped to zero, not to a negative age", () => {
    // A negative age would sail past every `> maxAge` check forever.
    const v = p({ newestAtMs: NOW + 10 * MIN });
    expect(v.dataAgeMs).toBe(0);
    expect(v.state).toBe(PANEL.FRESH);
  });

  it("is a pure function of its arguments — same in, same out", () => {
    const args = { ...HEALTHY };
    expect(panelState(args)).toEqual(panelState(args));
  });

  it("called with nothing at all it does not crash or claim to be live", () => {
    const v = panelState();
    expect(v.state).toBe(PANEL.LOADING);
    expect(v.alarm).toBe(false);
  });
});

describe("worstState", () => {
  const of = (state) => ({ state });

  it("ranks error above stale above empty above loading above fresh", () => {
    expect(worstState([of(PANEL.FRESH), of(PANEL.ERROR), of(PANEL.STALE)]).state).toBe(PANEL.ERROR);
    expect(worstState([of(PANEL.FRESH), of(PANEL.EMPTY), of(PANEL.STALE)]).state).toBe(PANEL.STALE);
    expect(worstState([of(PANEL.FRESH), of(PANEL.LOADING), of(PANEL.EMPTY)]).state).toBe(PANEL.EMPTY);
    expect(worstState([of(PANEL.FRESH), of(PANEL.LOADING)]).state).toBe(PANEL.LOADING);
  });

  it("one broken panel is enough to darken the banner", () => {
    // The banner must reflect the worst panel, not the average — an "8 of 9 are
    // fine" summary is how the one that matters gets scrolled past.
    const nine = [...Array(8)].map(() => of(PANEL.FRESH));
    expect(worstState([...nine, of(PANEL.ERROR)]).state).toBe(PANEL.ERROR);
  });

  it("returns the whole panel object, so the banner can quote its detail", () => {
    const err = panelState({ status: "error", error: "boom", now: NOW });
    expect(worstState([panelState({ ...HEALTHY }), err])).toBe(err);
  });

  it("skips null entries rather than throwing on a panel that has not mounted", () => {
    expect(worstState([null, undefined, of(PANEL.STALE)]).state).toBe(PANEL.STALE);
  });

  it("returns null when there is nothing to summarise", () => {
    expect(worstState([])).toBe(null);
    expect(worstState(null)).toBe(null);
    expect(worstState([null, undefined])).toBe(null);
  });

  it("keeps FRESH only when every panel is fresh", () => {
    expect(worstState([of(PANEL.FRESH), of(PANEL.FRESH)]).state).toBe(PANEL.FRESH);
  });
});
