import { IcConsole, IcDay, IcQueue, IcMind, IcSpeaker } from "./ui/icons.jsx";
import { dayKey } from "./lib/time.js";

// One flat list. The Console is first because it is where the work actually
// happens; everything else is a place to look at what the Console did — except
// Voice, which is how the Console is driven.
//
// Voice gets a destination of its own rather than a row in the Settings sheet
// because it stopped being a garnish. It is the primary way this is used now,
// and the two controls people reach for — "say less" and "let me interrupt" —
// were three taps deep behind a modal.
export const NAV = [
  { key: "console", label: "Console", Icon: IcConsole, hint: "Talk to SYNC" },
  { key: "day", label: "Day", Icon: IcDay, hint: "The plan" },
  { key: "queue", label: "Queue", Icon: IcQueue, hint: "Tasks and follow-ups" },
  { key: "mind", label: "Mind", Icon: IcMind, hint: "Who SYNC is" },
  { key: "voice", label: "Voice", Icon: IcSpeaker, hint: "How it listens and sounds" },
];

/**
 * The hoisted label map — the same shape ZTS and Clarify publish.
 *
 * NAV was already the one table, but three surfaces reached past it and wrote
 * the words again: the palette's "Go" group listed five destinations by hand
 * (it had Memory, which is not one, and was missing Mind and Voice, which are),
 * and the Voice page opened with its own <h1>Voice</h1> under the lit Voice
 * pill. Both drifted because there was nothing to import. `tabLabel(key)` is
 * that thing: the sub-nav pill, the tab bar label, the page region's accessible
 * name and the palette entry are now one string, and a rename lands in all four
 * or in none.
 */
export const TABS = NAV.map((n) => n.key);
export const TAB_LABELS = Object.freeze(Object.fromEntries(NAV.map((n) => [n.key, n.label])));
export const tabLabel = (k) => TAB_LABELS[k] || k;

/** The count each destination shows in the rail — attention, not decoration. */
export function navBadges(s) {
  const today = dayKey();
  const open = s.tasks.filter((t) => t.status === "open");
  return {
    console: 0,
    day: s.blocks.filter((b) => b.day === today && b.status !== "done").length,
    queue: open.length + s.followups.filter((f) => f.status === "open" && f.due && f.due <= today).length,
    mind: 0,
    voice: 0,
  };
}
