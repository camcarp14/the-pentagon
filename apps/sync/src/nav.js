import { IcConsole, IcDay, IcQueue, IcBrief, IcMind, IcSpeaker } from "./ui/icons.jsx";
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
  { key: "brief", label: "Brief", Icon: IcBrief, hint: "Morning and evening" },
  { key: "mind", label: "Mind", Icon: IcMind, hint: "Who SYNC is" },
  { key: "voice", label: "Voice", Icon: IcSpeaker, hint: "How it listens and sounds" },
];

/** The count each destination shows in the rail — attention, not decoration. */
export function navBadges(s) {
  const today = dayKey();
  const open = s.tasks.filter((t) => t.status === "open");
  return {
    console: 0,
    day: s.blocks.filter((b) => b.day === today && b.status !== "done").length,
    queue: open.length + s.followups.filter((f) => f.status === "open" && f.due && f.due <= today).length,
    brief: 0,
    mind: 0,
    voice: 0,
  };
}
