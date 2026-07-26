// ═══════════════════════════════════════════════════════════════════════════
// @cc/ops/arm — TURNING THE SYSTEM ON, CORRECTLY, IN ONE ACT.
//
// This file exists because the obvious implementation of an "Arm" button is
// wrong in a way that is invisible for four hours.
//
// The guard checks TWO rows, not one:
//   guard.js  — if (glo.enabled !== true) return block(KILL_SWITCH)
//   guard.js  — if (ctl.enabled !== true) return block(SUBSYSTEM_OFF)
//
// The per-subsystem rows are created by registerSubsystem() with the TABLE's
// defaults, which are deliberately the most restrictive combination that can
// exist: enabled=false, dry_run=true. So flipping only the global row arms
// nothing — every pass still blocks on SUBSYSTEM_OFF, the operator sees no
// output, and concludes the button is broken.
//
// And there is a worse state past that one. With both rows enabled but
// dry_run still true, the guard returns DRY_RUN — at which point the content
// engine calls Claude, PAYS FOR THE GENERATION, records a healthy run, and
// throws the article away. That is the only configuration in the system that
// costs real money while producing nothing, and nothing in the UI distinguished
// it from working.
//
// So arming writes all three rows and clears dry_run explicitly. Disarming is
// the mirror, and records WHY, because "never armed" and "deliberately stopped"
// are different facts that rendered identically before.
//
// Pure: returns the payloads. The caller does the I/O.
// ═══════════════════════════════════════════════════════════════════════════

/** Every subsystem that must be enabled for the system to actually produce. */
export const SUBSYSTEMS = Object.freeze([
  'zts.content',
  'clarify.outbound',
  'clarify.replies',
]);

export const GLOBAL_KEY = 'global';

/**
 * Rows to upsert to genuinely arm the system.
 *
 * `dry_run: false` is not optional here. Arming into dry-run is the
 * money-burning no-op described above, and an "Arm" button that lands there has
 * lied about what it did.
 */
export function armWrites({ subsystems = SUBSYSTEMS, at = null } = {}) {
  const stamp = at || new Date().toISOString();
  const base = { enabled: true, dry_run: false, paused_reason: null, paused_at: null, updated_at: stamp };
  return [
    { key: GLOBAL_KEY, ...base },
    ...subsystems.map((key) => ({ key, ...base })),
  ];
}

/**
 * Rows to upsert to stop everything.
 *
 * Only the GLOBAL row is touched. Per-subsystem enable flags are left exactly
 * as the operator set them, so stopping and re-arming does not silently switch
 * on a subsystem they had deliberately turned off. `paused_reason` is what the
 * Desk's approve path refuses on, which is what makes STOP stop a manual send
 * and not merely the schedules.
 */
export function disarmWrites({ reason = 'stopped from the console', at = null } = {}) {
  const stamp = at || new Date().toISOString();
  return [{
    key: GLOBAL_KEY,
    enabled: false,
    paused_reason: reason,
    paused_at: stamp,
    updated_at: stamp,
  }];
}

/**
 * The system's honest state, in four values rather than two.
 *
 * `rehearsing` is the one that matters: it looks armed, it costs money, and it
 * keeps nothing. It existed before and had no name, so no screen could report
 * it.
 */
export function armState({ global, subsystems = [] } = {}) {
  if (!global) return { state: 'unknown', label: 'State unreadable', detail: 'The control table could not be read. Assume something may be running.' };

  if (global.paused_reason) {
    return { state: 'stopped', label: 'Stopped', detail: global.paused_reason };
  }
  if (global.enabled !== true) {
    return { state: 'off', label: 'Off', detail: 'Nothing runs until you arm it.' };
  }

  const live = subsystems.filter((s) => s && s.enabled === true);
  if (live.length === 0) {
    // Global on, every subsystem off — arming wrote one row instead of all of
    // them, or a subsystem was individually disabled.
    return { state: 'off', label: 'Off', detail: 'The master switch is on but no subsystem is enabled.' };
  }

  const rehearsing = live.filter((s) => s.dry_run !== false);
  if (rehearsing.length === live.length) {
    return {
      state: 'rehearsing',
      label: 'Rehearsing',
      detail: 'Costing money, keeping nothing — every pass runs and discards its output.',
    };
  }
  if (rehearsing.length > 0) {
    return {
      state: 'rehearsing',
      label: 'Partly rehearsing',
      detail: `${rehearsing.map((s) => s.key).join(', ')} run and discard their output.`,
    };
  }
  return { state: 'armed', label: 'Armed', detail: `${live.length} subsystem(s) live.` };
}
