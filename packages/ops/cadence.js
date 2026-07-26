// ═══════════════════════════════════════════════════════════════════════════
// @cc/ops/cadence — how often each subsystem is scheduled.
//
// Mirrors the cron entries in netlify.toml. Not a cron parser: a surface only
// needs "how long until the next pass", and a real parser would be a dependency
// and a class of bug in exchange for nothing.
//
// If a schedule in netlify.toml changes, change it here too. The consequence of
// drift is a countdown that reads slightly wrong — annoying, not dangerous —
// which is why duplicating three numbers beats parsing five cron strings.
// ═══════════════════════════════════════════════════════════════════════════

export const CADENCE_MS = Object.freeze({
  'zts.content': 4 * 3_600_000,       // 0 */4 * * *
  'clarify.outbound': 2 * 3_600_000,  // 30 */2 * * *
  'clarify.replies': 15 * 60_000,     // */15 * * * *
  'zts.store': 6 * 3_600_000,         // 0 */6 * * *
  'ops.heartbeat': 15 * 60_000,       // */15 * * * *
});

export const cadenceFor = (subsystem) => CADENCE_MS[subsystem] || 0;
