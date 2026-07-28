// The trade-window score and the torque grade it reads.
//
// These two modules are joined by a STRING. window.js branches on
// torqueRead().grade, and for the life of the file it branched on 'cheap' — a
// value torque.js has never emitted. Nothing failed: an efficient read simply
// scored the same as a fair one, so the advertised 0-10 scale was really 0-9
// with only a downward tilt available, and the "+1 leverage is cheap" line in
// the file's own header described a branch that could not run.
//
// A string contract between two modules needs a test that asserts the SET, not
// just one happy value — otherwise renaming a grade breaks the consumer in
// exactly this silent way again.
import { describe, it, expect } from 'vitest';
import { tradeWindow, directionRead } from '../window.js';
import { torqueRead } from '../torque.js';

/** An arm-checklist shape with `passed` of 5 MSTR gates met, plus the BTC gate. */
const armWith = ({ passed = 0, btcPass = false, ready = false } = {}) => ({
  insufficient: false,
  mstr: Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, pass: i < passed })),
  btc: { pass: btcPass },
  ready,
});

describe('torqueRead — the grade vocabulary window.js depends on', () => {
  it('emits exactly efficient / fair / rich / unknown', () => {
    const grades = new Set([
      torqueRead({ beta: 2.0, mNav: 1.0 }).grade,   // ratio 2.00  → efficient
      torqueRead({ beta: 1.0, mNav: 1.0 }).grade,   // ratio 1.00  → fair
      torqueRead({ beta: 1.0, mNav: 2.0 }).grade,   // ratio 0.50  → rich
      torqueRead({ beta: null, mNav: 1.0 }).grade,  //             → unknown
    ]);
    expect(grades).toEqual(new Set(['efficient', 'fair', 'rich', 'unknown']));
  });

  it('never emits "cheap" — the value window.js used to test for', () => {
    for (const beta of [0.1, 0.9, 1, 1.5, 2, 5, 20]) {
      for (const mNav of [0.5, 1, 1.4, 2, 3]) {
        expect(torqueRead({ beta, mNav }).grade).not.toBe('cheap');
      }
    }
  });

  it('grades on the unrounded quotient at the band edges', () => {
    expect(torqueRead({ beta: 1.11, mNav: 1 }).grade).toBe('efficient');
    expect(torqueRead({ beta: 1.1, mNav: 1 }).grade).toBe('fair');   // >1.1, not >=
    expect(torqueRead({ beta: 0.9, mNav: 1 }).grade).toBe('fair');   // >=0.9
    expect(torqueRead({ beta: 0.89, mNav: 1 }).grade).toBe('rich');
  });

  it('refuses to grade a non-positive or missing mNAV', () => {
    expect(torqueRead({ beta: 2, mNav: 0 }).grade).toBe('unknown');
    expect(torqueRead({ beta: 2, mNav: -1 }).grade).toBe('unknown');
    expect(torqueRead({ beta: 2, mNav: null }).grade).toBe('unknown');
  });
});

describe('tradeWindow', () => {
  it('reports no read at all when the checklist is insufficient', () => {
    for (const arm of [undefined, null, { insufficient: true }]) {
      const w = tradeWindow({ arm });
      expect(w.score).toBeNull();
      expect(w.band).toBe('unknown');
      expect(w.gatesPassed).toBeNull();
    }
  });

  it('scores one point per gate met, out of six', () => {
    expect(tradeWindow({ arm: armWith({ passed: 0 }) }).score).toBe(0);
    expect(tradeWindow({ arm: armWith({ passed: 3 }) }).score).toBe(3);
    const all = tradeWindow({ arm: armWith({ passed: 5, btcPass: true }) });
    expect(all.gatesPassed).toBe(6);
    expect(all.gatesTotal).toBe(6);
    expect(all.score).toBe(6);
  });

  it('adds the +3 trigger cliff only when the gates are ready AND a trigger is live', () => {
    const arm = armWith({ passed: 5, btcPass: true, ready: true });
    expect(tradeWindow({ arm, pullback: { stage: 'trigger' } }).score).toBe(9);
    expect(tradeWindow({ arm, breakout: { active: true } }).score).toBe(9);
    expect(tradeWindow({ arm, pullback: { stage: 'setup' } }).score).toBe(6);
  });

  // The reason arm.ready gates the trigger points: a breakout inside a
  // downtrend must not score like a live setup.
  it('withholds the trigger points when the regime is not ready', () => {
    const notReady = armWith({ passed: 2, btcPass: false, ready: false });
    const w = tradeWindow({ arm: notReady, breakout: { active: true } });
    expect(w.triggerLive).toBe(false);
    expect(w.score).toBe(2);
  });

  // ── the regression this file exists for ──────────────────────────────────
  it('awards +1 for efficient leverage — the branch that was unreachable', () => {
    const arm = armWith({ passed: 4, btcPass: false });
    const base = tradeWindow({ arm }).score;
    const efficient = tradeWindow({ arm, mNav: 1.4, torqueRead: torqueRead({ beta: 2, mNav: 1.4 }) });
    expect(efficient.parts.find((p) => p.key === 'leverage').points).toBe(1);
    expect(efficient.score).toBe(base + 1);
  });

  it('subtracts 1 for rich leverage and nothing for fair', () => {
    const arm = armWith({ passed: 4, btcPass: false });
    const base = tradeWindow({ arm }).score;
    const rich = tradeWindow({ arm, mNav: 2, torqueRead: { grade: 'rich' } });
    const fair = tradeWindow({ arm, mNav: 1, torqueRead: { grade: 'fair' } });
    expect(rich.score).toBe(base - 1);
    expect(fair.score).toBe(base);
  });

  it('skips the leverage tilt entirely when mNAV is unavailable', () => {
    const arm = armWith({ passed: 4, btcPass: false });
    const w = tradeWindow({ arm, mNav: null, torqueRead: { grade: 'rich' } });
    expect(w.parts.find((p) => p.key === 'leverage')).toBeUndefined();
    expect(w.score).toBe(4);
  });

  // 'unknown' means the grade could not be computed. Listing it as a scored
  // part reads as a judgement that was never made.
  it('skips the leverage tilt when the grade is unknown', () => {
    const arm = armWith({ passed: 4, btcPass: false });
    const w = tradeWindow({ arm, mNav: 1.4, torqueRead: torqueRead({ beta: null, mNav: 1.4 }) });
    expect(w.parts.find((p) => p.key === 'leverage')).toBeUndefined();
    expect(w.score).toBe(4);
  });

  it('clamps into 0-10 rather than emitting an out-of-band score', () => {
    const perfect = tradeWindow({
      arm: armWith({ passed: 5, btcPass: true, ready: true }),
      pullback: { stage: 'trigger' },
      mNav: 1.2,
      torqueRead: { grade: 'efficient' },
    });
    expect(perfect.score).toBe(10);
    expect(perfect.band).toBe('go');

    const floor = tradeWindow({ arm: armWith({ passed: 0 }), mNav: 3, torqueRead: { grade: 'rich' } });
    expect(floor.score).toBe(0);
    expect(floor.band).toBe('no');
  });

  it('lands each score in the band the header advertises', () => {
    const bandFor = (passed, ready = false, trigger = false) =>
      tradeWindow({
        arm: armWith({ passed: Math.min(passed, 5), btcPass: passed > 5, ready }),
        pullback: trigger ? { stage: 'trigger' } : undefined,
      }).band;
    expect(bandFor(0)).toBe('no');
    expect(bandFor(2)).toBe('no');
    expect(bandFor(3)).toBe('building');
    expect(bandFor(5)).toBe('building');
    expect(bandFor(6)).toBe('armed');
    expect(bandFor(6, true, true)).toBe('go');
  });
});

describe('directionRead', () => {
  it('never offers a short — long or no trade, per the long-only rules', () => {
    const actions = ['ENTER', 'ADD', 'HOLD', 'TRIM', 'EXIT', 'STOP_OUT', 'STAND_ASIDE', 'NO_DATA', undefined];
    for (const a of actions) {
      expect(['Long', 'Close it', 'No trade']).toContain(directionRead(a).text);
    }
  });

  it('reads the directive, so it cannot contradict the call above it', () => {
    expect(directionRead('STOP_OUT').text).toBe('Close it');
    expect(directionRead('STAND_ASIDE').text).toBe('No trade');
    expect(directionRead('HOLD').text).toBe('Long');
  });
});
