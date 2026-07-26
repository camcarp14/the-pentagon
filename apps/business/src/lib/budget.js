// ═══════════════════════════════════════════════════════════════════════════
// Budget: spend by category against its cap, and — the number that actually
// matters at 7am on a phone — whether the current pace lands under the cap by
// month end.
//
// The projection has one honest failure mode and it is handled explicitly: on
// day one of a period, dividing spend by elapsed-fraction multiplies noise by
// ~30. A single $4 test call on the 1st projects to $120 and paints the panel
// red for no reason. Crying wolf on day one is how an alarm gets ignored on
// day twenty, so below a threshold of elapsed time the panel reports "too
// early to project" instead of a number it can't stand behind.
// ═══════════════════════════════════════════════════════════════════════════

import { toMs } from "./format.js";

const DAY_MS = 86_400_000;

/** Under this much of the period elapsed, a projection is noise amplification. */
export const MIN_ELAPSED_FRACTION_FOR_PROJECTION = 0.08; // ~2.5 days of a month

/** A `date` column arrives as 'YYYY-MM-DD'; anchor it to UTC midnight. */
function dateMs(d) {
  if (!d) return null;
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) return Date.parse(`${d}T00:00:00Z`);
  return toMs(d);
}

/**
 * Pick the budget period that contains `now`; if none does (the agent hasn't
 * rolled the month over), fall back to the most recent one that started — and
 * SAY it's expired rather than silently showing last month's caps as current.
 */
export function currentPeriod(caps, now = Date.now()) {
  const rows = (Array.isArray(caps) ? caps : []).filter(Boolean);
  if (rows.length === 0) return null;

  const periods = new Map();
  for (const r of rows) {
    const startMs = dateMs(r.period_start);
    if (startMs === null) continue;
    const endMs = dateMs(r.period_end);
    // period_end is an inclusive date, so the period runs to the END of that day.
    const endExclusiveMs = endMs === null ? startMs + 30 * DAY_MS : endMs + DAY_MS;
    const key = String(r.period_start);
    if (!periods.has(key)) periods.set(key, { key, startMs, endExclusiveMs, caps: [] });
    periods.get(key).caps.push(r);
  }
  if (periods.size === 0) return null;

  const all = [...periods.values()].sort((a, b) => b.startMs - a.startMs);
  const containing = all.find((p) => now >= p.startMs && now < p.endExclusiveMs);
  if (containing) return { ...containing, expired: false };
  return { ...all[0], expired: all[0].endExclusiveMs <= now };
}

/**
 * @param {Array} caps    rows from `budget`
 * @param {Array} spends  rows from `spend_ledger` (any range; filtered here)
 */
export function budgetSummary(caps, spends, now = Date.now()) {
  const period = currentPeriod(caps, now);
  if (!period) {
    return { ok: false, reason: "no_caps", message: "No budget rows — there is no cap to measure spend against." };
  }

  const { startMs, endExclusiveMs, expired } = period;
  const totalMs = Math.max(1, endExclusiveMs - startMs);
  const elapsedMs = Math.min(Math.max(0, now - startMs), totalMs);
  const elapsedFraction = elapsedMs / totalMs;
  const daysRemaining = Math.max(0, Math.ceil((endExclusiveMs - now) / DAY_MS));
  const daysElapsed = Math.max(0, elapsedMs / DAY_MS);

  const inPeriod = (Array.isArray(spends) ? spends : []).filter((s) => {
    const t = toMs(s?.spent_at);
    return t !== null && t >= startMs && t < endExclusiveMs;
  });

  const spentByCategory = new Map();
  let spentTotal = 0;
  for (const s of inPeriod) {
    const amt = Number(s.amount_usd);
    if (!Number.isFinite(amt)) continue;
    spentTotal += amt;
    const c = s.category || "uncategorised";
    spentByCategory.set(c, (spentByCategory.get(c) || 0) + amt);
  }

  const projectable = elapsedFraction >= MIN_ELAPSED_FRACTION_FOR_PROJECTION;
  const project = (spent) => (projectable ? spent / elapsedFraction : null);

  const capRows = period.caps.filter((c) => c.category !== "total");
  const totalCapRow = period.caps.find((c) => c.category === "total");

  const categories = capRows.map((c) => line(c.category, Number(c.cap_usd), spentByCategory.get(c.category) || 0, !!c.hard_stop));

  // Spend in a category nobody set a cap for still has to appear. A budget
  // panel that only renders the categories it expected will show $0 of overrun
  // while the money leaves.
  for (const [cat, spent] of spentByCategory) {
    if (cat === "total") continue;
    if (!capRows.some((c) => c.category === cat)) {
      categories.push({ ...line(cat, null, spent, false), uncapped: true });
    }
  }
  categories.sort((a, b) => b.spentUsd - a.spentUsd);

  const total = line(
    "total",
    totalCapRow ? Number(totalCapRow.cap_usd) : capRows.reduce((n, c) => n + (Number(c.cap_usd) || 0), 0) || null,
    spentTotal,
    totalCapRow ? !!totalCapRow.hard_stop : false,
  );

  function line(category, capUsd, spentUsd, hardStop) {
    const cap = Number.isFinite(capUsd) ? capUsd : null;
    const projectedUsd = project(spentUsd);
    return {
      category,
      capUsd: cap,
      spentUsd,
      remainingUsd: cap === null ? null : cap - spentUsd,
      pctUsed: cap && cap > 0 ? spentUsd / cap : null,
      projectedUsd,
      // The headline judgement. `null` when we refuse to project — which the
      // UI must render as "too early", never as "on pace".
      onPace: projectedUsd === null || cap === null ? null : projectedUsd <= cap,
      overBy: projectedUsd === null || cap === null ? null : Math.max(0, projectedUsd - cap),
      breached: cap !== null && spentUsd > cap,
      hardStop,
      perDayUsd: daysElapsed > 0.25 ? spentUsd / daysElapsed : null,
      // What you could spend per remaining day and still land on the cap.
      allowancePerDayUsd: cap === null || daysRemaining <= 0 ? null : Math.max(0, cap - spentUsd) / daysRemaining,
    };
  }

  return {
    ok: true,
    periodStartMs: startMs,
    periodEndExclusiveMs: endExclusiveMs,
    periodExpired: expired,
    elapsedFraction,
    daysElapsed,
    daysRemaining,
    projectable,
    spendRowCount: inPeriod.length,
    total,
    categories,
  };
}
