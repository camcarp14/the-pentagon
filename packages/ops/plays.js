// ═══════════════════════════════════════════════════════════════════════════
// @cc/ops/plays — WHAT TO DO NEXT, DERIVED, NEVER STORED.
//
// Clarify's outreach board already had the right idea: a short ranked list of
// things worth doing, not a grid of metrics. This generalises it so ZTS gets the
// same treatment, and fixes the two things the original could not express.
//
// PRECEDENCE, NOT WEIGHTS. Sorting by weight is a heuristic and heuristics tie.
// The phase ladder is evaluated in strict order:
//
//   unpointed > disarmed > rehearsing > blocked > stale > waiting > idle
//
// Because `unpointed` structurally outranks `nothing waiting`, no surface can
// ever render an empty queue that reads like a finished day. That is the exact
// failure of the ZTS Mission tab today: twelve zeros and a green "Live" dot,
// while nothing has ever been switched on.
//
// EVERYTHING DERIVES FROM A LIVE QUERY. No stored flags, no localStorage. The
// "Agent Roster" of eight agents permanently labelled `ready` — none of which
// has ever run — is what happens when status is a constant in a file.
//
// THE ENGINE'S OWN WORDS WIN. Where a run note exists it is rendered verbatim
// rather than recomputed. Two surfaces disagreeing about whether there is work
// to do is precisely what this replaces: the engine computes capacity from rows
// created today regardless of status, so a client-side guess at the same number
// drifts the moment a draft is rejected.
//
// Pure: no fetch, no Date.now(), no database.
// ═══════════════════════════════════════════════════════════════════════════

export const PHASE = Object.freeze({
  UNPOINTED: 'unpointed',
  DISARMED: 'disarmed',
  REHEARSING: 'rehearsing',
  BLOCKED: 'blocked',
  STALE: 'stale',
  WAITING: 'waiting',
  IDLE: 'idle',
});

const ORDER = [PHASE.UNPOINTED, PHASE.DISARMED, PHASE.REHEARSING, PHASE.BLOCKED, PHASE.STALE, PHASE.WAITING, PHASE.IDLE];
export const phaseRank = (p) => {
  const i = ORDER.indexOf(p);
  return i === -1 ? ORDER.length : i;
};

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/** Compact duration. Deliberately coarse — "3d" is more useful than "3d 4h". */
export function humanGap(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < MIN) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

/**
 * The single most important derivation in the file.
 *
 * Returns the engine's phase plus a headline and a detail line, both already
 * written in plain English so no caller has to invent copy for a state it does
 * not understand.
 */
export function enginePhase({
  ready = false, missing = [],
  global = null, subsystem = null,
  lastRuns = [], queue = [],
  now = 0, cadenceMs = 0,
} = {}) {
  const lastRun = lastRuns[0] || null;
  const lastStart = lastRun ? Date.parse(lastRun.started_at) : NaN;
  const sinceLastRunMs = Number.isFinite(lastStart) ? Math.max(0, now - lastStart) : null;
  const nextPassAt = Number.isFinite(lastStart) && cadenceMs > 0 ? lastStart + cadenceMs : null;

  const base = { sinceLastRunMs, nextPassAt, lastNote: lastRun?.note || null };

  if (!ready) {
    return {
      ...base, phase: PHASE.UNPOINTED, ok: false,
      headline: 'Tell it what to work on',
      detail: missing.length ? `Missing: ${missing.join(', ')}` : 'Direction is not set.',
    };
  }

  if (global && global.paused_reason) {
    return { ...base, phase: PHASE.DISARMED, ok: false, headline: 'Stopped', detail: global.paused_reason };
  }
  if (!global || global.enabled !== true || !subsystem || subsystem.enabled !== true) {
    return {
      ...base, phase: PHASE.DISARMED, ok: false,
      headline: 'Nothing runs until you arm it',
      detail: 'Pointed and ready. One tap starts it.',
    };
  }
  if (subsystem.dry_run !== false) {
    return {
      ...base, phase: PHASE.REHEARSING, ok: false,
      headline: 'Rehearsing — costing money, keeping nothing',
      detail: lastRun?.note || 'Each pass runs in full and discards its output.',
    };
  }

  // A pass that blocked or failed is the engine telling you why nothing
  // happened. Rendered verbatim rather than paraphrased.
  if (lastRun && (lastRun.ok === false || (lastRun.blocked || 0) > 0)) {
    return {
      ...base, phase: PHASE.BLOCKED, ok: false,
      headline: lastRun.ok === false ? 'Last pass failed' : 'Last pass was blocked',
      detail: lastRun.note || 'No reason recorded.',
    };
  }

  const staleCount = queue.filter((i) => i && i.stale).length;
  const liveCount = queue.length - staleCount;

  if (liveCount > 0) {
    return {
      ...base, phase: PHASE.WAITING, ok: true,
      headline: `${liveCount} waiting on you`,
      detail: staleCount ? `${staleCount} more have gone stale.` : 'Ready to review.',
    };
  }
  if (staleCount > 0) {
    return {
      ...base, phase: PHASE.STALE, ok: false,
      headline: `${staleCount} gone stale`,
      detail: 'Written too long ago to send. Reject them and fresh ones get written.',
    };
  }

  // Armed, pointed, empty. The honest question is whether that is a finished
  // day or a broken engine, and only the run history can answer it.
  if (!lastRuns.length) {
    return {
      ...base, phase: PHASE.IDLE, ok: false,
      headline: 'Has never run',
      detail: 'No pass has ever been recorded. Check that the server credentials are set.',
    };
  }
  const didSomething = lastRuns.some((r) => (r.actions || 0) > 0);
  return {
    ...base, phase: PHASE.IDLE, ok: didSomething,
    headline: didSomething ? 'Nothing waiting' : 'Running, producing nothing',
    detail: lastRun?.note || (didSomething ? 'All caught up.' : 'The last passes did no work.'),
  };
}

/**
 * The ranked list a surface renders.
 *
 * The FIRST play is always the current phase's own remedy, so precedence and
 * ranking can never disagree about what matters most. Everything after it is
 * ordinary work, weight-sorted.
 */
export function enginePlays({ phase, extras = [] } = {}) {
  const remedy = {
    [PHASE.UNPOINTED]: { id: 'point', title: 'Tell it what to work on', sub: phase.detail, action: 'direction', tone: 'prompt' },
    [PHASE.DISARMED]: { id: 'arm', title: phase.headline === 'Stopped' ? 'Clear the stop' : 'Arm it', sub: phase.detail, action: 'arm', tone: 'prompt' },
    [PHASE.REHEARSING]: { id: 'unrehearse', title: 'Keep what it produces', sub: phase.detail, action: 'arm', tone: 'warn' },
    [PHASE.BLOCKED]: { id: 'blocked', title: phase.headline, sub: phase.detail, action: 'ops', tone: 'warn' },
    [PHASE.STALE]: { id: 'stale', title: phase.headline, sub: phase.detail, action: 'queue', tone: 'warn' },
    [PHASE.WAITING]: { id: 'review', title: phase.headline, sub: phase.detail, action: 'queue', tone: 'go' },
    [PHASE.IDLE]: phase.ok ? null : { id: 'idle', title: phase.headline, sub: phase.detail, action: 'ops', tone: 'warn' },
  }[phase.phase];

  const rest = (extras || [])
    .filter((p) => p && p.count > 0)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .map((p) => ({ id: p.id, title: p.title, sub: p.sub, action: p.action, tone: p.tone || 'neutral' }));

  return [remedy, ...rest].filter(Boolean);
}

/**
 * The "you are actually done" line.
 *
 * Deliberately hard to earn: an empty queue only counts as finished if a pass
 * in the last 24h actually did something. Otherwise an engine that silently
 * stopped producing looks identical to a caught-up one, which is how a stalled
 * system goes unnoticed for three weeks.
 */
export function doneState({ lastRuns = [], now = 0, windowMs = DAY } = {}) {
  if (!lastRuns.length) {
    return { ok: false, text: 'No pass has ever been recorded. The engine has never run.' };
  }
  const recentProductive = lastRuns.some((r) => {
    const t = Date.parse(r.started_at);
    return Number.isFinite(t) && now - t <= windowMs && (r.actions || 0) > 0;
  });
  if (recentProductive) return { ok: true, text: 'Armed, pointed, nothing waiting.' };
  return { ok: false, text: `Armed and pointed, but recent passes did nothing: ${lastRuns[0].note || 'no note recorded'}` };
}
