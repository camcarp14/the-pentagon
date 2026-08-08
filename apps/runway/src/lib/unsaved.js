// The guard between typed work and a reflexive Cmd-R.
//
// WHAT GOES WRONG WITHOUT IT: every editor in Runway holds its work in React
// state until you press Save — the master resume, the targets form, a tailored
// draft, a whole application kit. That is the right shape (a half-typed resume
// has no business being scored against anything), but it means a refresh is
// indistinguishable from a discard, and the browser does not ask. You retype
// twenty minutes of bullets and learn the rule the expensive way.
//
// beforeunload is the only hook the platform gives for this, and it covers
// exactly the cases that lose work without a click you'd recognise as
// destructive: reload, tab close, window close, navigating to another site.
//
// WHAT IT DOES NOT COVER: moving between Runway's own tabs. Runway runs on a
// MemoryRouter, and react-router 6 only exposes useBlocker on a data router —
// so in-app navigation cannot be intercepted without restructuring the router.
// The visible "Unsaved changes" marker each caller renders is what covers that
// gap, and it is why the marker is not optional.
import { useEffect } from 'react';

/**
 * Ask the browser to confirm before unloading while `dirty` is true.
 *
 * The listener is only attached WHILE dirty. An always-attached listener that
 * decides inside the handler is the version that goes wrong: browsers treat a
 * registered beforeunload as a hint to disable the back-forward cache, so the
 * always-on form quietly makes every navigation slower for a prompt that fires
 * on a small minority of them.
 */
export function useUnsavedGuard(dirty) {
  useEffect(() => (dirty ? armUnloadGuard(typeof window === 'undefined' ? null : window) : undefined), [dirty]);
}

/**
 * Attach the beforeunload handler to `win`; returns the detach function.
 *
 * Split out from the hook on purpose. This repo has no jsdom — by design, see
 * vitest.config.js — so a guard that lived entirely inside useEffect could be
 * read but never RUN by a test, and "the listener is removed when the form goes
 * clean" would be a claim rather than a checked fact. As a plain function taking
 * its window, it is exercised against a stub in the suite.
 */
export function armUnloadGuard(win) {
  if (!win) return () => {};
  const onBeforeUnload = (e) => {
    // Both halves are required: preventDefault() is the modern spec, and a
    // non-empty returnValue is what older Safari and Firefox actually read. The
    // string itself is never displayed — every current browser substitutes its
    // own wording — so there is no message worth writing here.
    e.preventDefault();
    e.returnValue = '';
    return '';
  };
  win.addEventListener('beforeunload', onBeforeUnload);
  return () => win.removeEventListener('beforeunload', onBeforeUnload);
}

// Structural equality for the shapes these editors hold. Deliberately a value
// comparison rather than a "touched" flag: a flag counts typing a character and
// deleting it as unsaved work, and a prompt that fires when nothing changed is
// one the user learns to dismiss without reading — which is the same as not
// having one at all on the day it matters.
//
// KEY ORDER IS NOT CONTENT. The saved side of every comparison here came back
// from a jsonb column, and jsonb does not round-trip key order — Postgres
// normalises it (shortest key first, then bytewise). A plain JSON.stringify
// compare therefore reports "unsaved" on a form nobody has touched, for as long
// as the page is open. Sorting keys before serialising is what makes the
// comparison a question about content instead of a question about Postgres.
//
// Arrays are NOT sorted: the order of your roles and the order of a role's
// bullets are content, and reordering them is a real edit worth warning about.
const stable = (v) => {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = stable(v[k]); return acc; }, {});
  }
  return v;
};

export const sameContent = (a, b) => JSON.stringify(stable(a ?? null)) === JSON.stringify(stable(b ?? null));
