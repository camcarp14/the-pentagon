// Planted problems for the unsaved-work guard.
//
// The failure this guards is the one the guard itself can cause. A prompt that
// fires on a form nobody touched is worse than no prompt: it trains you to hit
// "Leave" reflexively, so the one time it fires on real work you dismiss it
// without reading. Most of these cases are therefore about NOT warning.
import { describe, it, expect, vi } from 'vitest';
import { sameContent, armUnloadGuard } from '../lib/unsaved.js';

// Minimal stand-in for window — this repo has no jsdom (see vitest.config.js).
const fakeWindow = () => {
  const listeners = [];
  return {
    listeners,
    addEventListener: (type, fn) => listeners.push([type, fn]),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex(([t, f]) => t === type && f === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
};

describe('sameContent', () => {
  it('ignores key order, because jsonb does not round-trip it', () => {
    // THE BUG THIS PINS: the saved side always comes back from a jsonb column,
    // and Postgres normalises key order. Compared naively, an untouched form
    // reads as unsaved forever and the prompt fires on every single refresh.
    const typed = { contact: { name: 'A' }, summary: 's', skills: ['sql'] };
    const fromDb = { skills: ['sql'], summary: 's', contact: { name: 'A' } };
    expect(sameContent(typed, fromDb)).toBe(true);
  });

  it('still detects a real edit', () => {
    expect(sameContent({ summary: 'a' }, { summary: 'b' })).toBe(false);
  });

  it('treats array order as content, not noise', () => {
    // Reordering your roles, or the bullets inside one, is a real edit.
    expect(sameContent({ e: [{ c: 'A' }, { c: 'B' }] }, { e: [{ c: 'B' }, { c: 'A' }] })).toBe(false);
  });

  it('does not confuse an empty form with a missing record', () => {
    expect(sameContent(undefined, null)).toBe(true);
    expect(sameContent({ summary: '' }, null)).toBe(false);
  });

  it('compares nested experience faithfully', () => {
    const a = { experience: [{ company: 'X', bullets: ['one', 'two'] }] };
    const b = { experience: [{ bullets: ['one', 'two'], company: 'X' }] };
    expect(sameContent(a, b)).toBe(true);
    expect(sameContent(a, { experience: [{ company: 'X', bullets: ['one'] }] })).toBe(false);
  });
});

describe('armUnloadGuard', () => {
  it('registers a beforeunload listener', () => {
    const win = fakeWindow();
    armUnloadGuard(win);
    expect(win.listeners).toHaveLength(1);
    expect(win.listeners[0][0]).toBe('beforeunload');
  });

  it('removes the listener when disarmed — the form went clean or unmounted', () => {
    // If this regresses, the prompt outlives the unsaved work and fires on a
    // saved form, which is the trust-destroying direction of this feature.
    const win = fakeWindow();
    const disarm = armUnloadGuard(win);
    disarm();
    expect(win.listeners).toHaveLength(0);
  });

  it('leaves no listener behind across arm/disarm cycles', () => {
    const win = fakeWindow();
    for (let i = 0; i < 5; i++) armUnloadGuard(win)();
    expect(win.listeners).toHaveLength(0);
  });

  it('actually signals the browser to prompt', () => {
    // Both halves matter: preventDefault is the spec, returnValue is what older
    // Safari and Firefox read. Dropping either makes the prompt silently vanish
    // in some browsers — a failure you cannot see in the one you test in.
    const win = fakeWindow();
    armUnloadGuard(win);
    const evt = { preventDefault: vi.fn(), returnValue: undefined };
    win.listeners[0][1](evt);
    expect(evt.preventDefault).toHaveBeenCalled();
    expect(evt.returnValue).toBe('');
  });

  it('is a no-op without a window instead of throwing', () => {
    // Server-rendered in the render suite; a throw here would take the page down.
    expect(() => armUnloadGuard(null)()).not.toThrow();
  });
});
