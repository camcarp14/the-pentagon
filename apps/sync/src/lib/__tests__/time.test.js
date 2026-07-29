// The time module is the one place a timezone bug can hide, and every tool the
// model calls parses its arguments through it. It gets the most tests.

import { describe, it, expect } from "vitest";
import { installBrowserEnv } from "../../test/env.js";

installBrowserEnv();

const {
  dayKey, minsOfDay, stampFor, addDays, dayLabel, daysBetween,
  fmtTime, fmt24, fmtDur, fmtClock, ago, parseTime, parseDay, greeting,
} = await import("../time.js");

/* ── day keys are local, never UTC ─────────────────────────────────────────── */
describe("day keys are local, never UTC", () => {
  const localNoon = new Date(2026, 7, 14, 12, 0, 0).getTime();
  it("dayKey at local noon", () => expect(dayKey(localNoon)).toEqual("2026-08-14"));

  // The classic failure: 11pm local on the 14th is the 15th in UTC for anyone
  // west of Greenwich. toISOString().slice(0,10) gets this wrong; we must not.
  const lateNight = new Date(2026, 7, 14, 23, 30, 0).getTime();
  it("dayKey late at night stays on the same local day", () => expect(dayKey(lateNight)).toEqual("2026-08-14"));

  const earlyMorning = new Date(2026, 7, 14, 0, 15, 0).getTime();
  it("dayKey just after midnight", () => expect(dayKey(earlyMorning)).toEqual("2026-08-14"));

  it("minsOfDay", () => expect(minsOfDay(new Date(2026, 7, 14, 9, 5).getTime())).toEqual(545));
  it("stampFor round-trips", () => expect(dayKey(stampFor("2026-08-14", 545))).toEqual("2026-08-14"));
  it("stampFor minutes round-trip", () => expect(minsOfDay(stampFor("2026-08-14", 545))).toEqual(545));
});

/* ── date arithmetic across a month boundary ───────────────────────────────── */
describe("date arithmetic across a month boundary", () => {
  it("addDays forward over month end", () => expect(addDays("2026-08-31", 1)).toEqual("2026-09-01"));
  it("addDays backward over month end", () => expect(addDays("2026-09-01", -1)).toEqual("2026-08-31"));
  it("addDays over a year end", () => expect(addDays("2026-12-31", 1)).toEqual("2027-01-01"));
  it("daysBetween", () => expect(daysBetween("2026-08-14", "2026-08-20")).toEqual(6));
  it("daysBetween negative", () => expect(daysBetween("2026-08-20", "2026-08-14")).toEqual(-6));
  it("daysBetween across a month", () => expect(daysBetween("2026-08-31", "2026-09-02")).toEqual(2));
});

/* ── labels ────────────────────────────────────────────────────────────────── */
describe("labels", () => {
  const today = dayKey();
  it("dayLabel today", () => expect(dayLabel(today)).toEqual("Today"));
  it("dayLabel tomorrow", () => expect(dayLabel(addDays(today, 1))).toEqual("Tomorrow"));
  it("dayLabel yesterday", () => expect(dayLabel(addDays(today, -1))).toEqual("Yesterday"));
  it("dayLabel far future is a real date", () => expect(/\w/.test(dayLabel(addDays(today, 40)))).toBe(true));
});

/* ── formatting ────────────────────────────────────────────────────────────── */
describe("formatting", () => {
  it("fmtTime morning", () => expect(fmtTime(545)).toEqual("9:05 AM"));
  it("fmtTime noon", () => expect(fmtTime(720)).toEqual("12:00 PM"));
  it("fmtTime midnight", () => expect(fmtTime(0)).toEqual("12:00 AM"));
  it("fmtTime afternoon", () => expect(fmtTime(870)).toEqual("2:30 PM"));
  it("fmtTime wraps past midnight", () => expect(fmtTime(1500)).toEqual("1:00 AM"));
  it("fmt24", () => expect(fmt24(545)).toEqual("09:05"));
  it("fmt24 midnight", () => expect(fmt24(0)).toEqual("00:00"));
  it("fmtDur hours and minutes", () => expect(fmtDur(95)).toEqual("1h 35m"));
  it("fmtDur whole hours", () => expect(fmtDur(120)).toEqual("2h"));
  it("fmtDur minutes only", () => expect(fmtDur(45)).toEqual("45m"));
  it("fmtClock under an hour", () => expect(fmtClock(125)).toEqual("2:05"));
  it("fmtClock over an hour", () => expect(fmtClock(3725)).toEqual("1:02:05"));
  it("ago just now", () => expect(ago(Date.now() - 5000, Date.now())).toEqual("just now"));
  it("ago minutes", () => expect(ago(Date.now() - 12 * 60000, Date.now())).toEqual("12m ago"));
  it("ago hours", () => expect(ago(Date.now() - 3 * 3600000, Date.now())).toEqual("3h ago"));
});

/* ── parsing what a model actually emits ───────────────────────────────────── */
describe("parsing what a model actually emits", () => {
  it("parseTime 24h", () => expect(parseTime("09:30")).toEqual(570));
  it("parseTime 12h lower", () => expect(parseTime("9:30am")).toEqual(570));
  it("parseTime 12h spaced", () => expect(parseTime("2:15 PM")).toEqual(855));
  it("parseTime bare hour with meridiem", () => expect(parseTime("9am")).toEqual(540));
  it("parseTime pm bare hour", () => expect(parseTime("2pm")).toEqual(840));
  it("parseTime 12am is midnight", () => expect(parseTime("12am")).toEqual(0));
  it("parseTime 12pm is noon", () => expect(parseTime("12pm")).toEqual(720));
  it("parseTime dotted meridiem", () => expect(parseTime("9:30 a.m.")).toEqual(570));
  it("parseTime military", () => expect(parseTime("1400")).toEqual(840));
  it("parseTime military with leading zero", () => expect(parseTime("0930")).toEqual(570));
  it("parseTime noon word", () => expect(parseTime("noon")).toEqual(720));
  it("parseTime midnight word", () => expect(parseTime("midnight")).toEqual(0));
  it("parseTime passes a number through", () => expect(parseTime(545)).toEqual(545));
  it("parseTime rejects nonsense", () => expect(parseTime("later")).toEqual(null));
  it("parseTime rejects impossible minutes", () => expect(parseTime("09:75")).toEqual(null));
  it("parseTime rejects impossible hours", () => expect(parseTime("2515")).toEqual(null));
  it("parseTime rejects empty", () => expect(parseTime("")).toEqual(null));
  it("parseTime rejects null", () => expect(parseTime(null)).toEqual(null));

  it("parseDay today", () => expect(parseDay("today", "2026-08-14")).toEqual("2026-08-14"));
  it("parseDay tomorrow", () => expect(parseDay("tomorrow", "2026-08-14")).toEqual("2026-08-15"));
  it("parseDay yesterday", () => expect(parseDay("yesterday", "2026-08-14")).toEqual("2026-08-13"));
  it("parseDay iso passes through", () => expect(parseDay("2026-09-01", "2026-08-14")).toEqual("2026-09-01"));
  it("parseDay offset", () => expect(parseDay("+3d", "2026-08-14")).toEqual("2026-08-17"));
  it("parseDay negative offset", () => expect(parseDay("-2d", "2026-08-14")).toEqual("2026-08-12"));
  // 2026-08-14 is a Friday.
  it("parseDay weekday name", () => expect(parseDay("monday", "2026-08-14")).toEqual("2026-08-17"));
  it("parseDay same weekday means today", () => expect(parseDay("friday", "2026-08-14")).toEqual("2026-08-14"));
  it("parseDay short weekday", () => expect(parseDay("wed", "2026-08-14")).toEqual("2026-08-19"));
  it("parseDay rejects nonsense", () => expect(parseDay("sometime", "2026-08-14")).toEqual(null));
});

/* ── greeting ──────────────────────────────────────────────────────────────── */
describe("greeting", () => {
  it("greeting overnight", () => expect(greeting(3 * 60)).toEqual("Still up"));
  it("greeting morning", () => expect(greeting(9 * 60)).toEqual("Good morning"));
  it("greeting afternoon", () => expect(greeting(14 * 60)).toEqual("Good afternoon"));
  it("greeting evening", () => expect(greeting(20 * 60)).toEqual("Good evening"));
});
