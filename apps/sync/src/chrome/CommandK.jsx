import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  IcSearch, IcBrief, IcMemory, IcMic, IcMicOff,
  IcSettings, IcSparkle, IcSend, IcTrash, IcFocus,
} from "../ui/icons.jsx";
import { NAV, tabLabel } from "../nav.js";
import { PortalLayer } from "../ui/kit.jsx";
import { getState, setSettings, clearConversation } from "../data/store.js";

// ─── ⌘K ──────────────────────────────────────────────────────────────────────
// Keyboard-first is most of what makes software feel like software. Anything
// you can reach by tapping around, you can reach from here — and anything the
// palette can't do, it hands to SYNC as a spoken instruction, so the fallback
// is never "no results".

export default function CommandK({ open, onClose, setPage, voice, onSettings }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    // A frame's delay: the input doesn't exist until the portal has mounted.
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  const commands = useMemo(() => {
    const s = getState();
    return [
      // Straight off NAV — the same table the sub-nav pill and the tab bar
      // render from. Written out by hand this list had drifted twice over: it
      // was missing Mind and Voice, which ARE destinations, and it offered
      // Memory, which is not one (it is routable, and reached from the Mind
      // page's Knows button — so it keeps a row of its own, below the six).
      ...NAV.map(({ key, Icon }) => ({ group: "Go", label: tabLabel(key), Icon, run: () => setPage(key) })),
      { group: "Go", label: "Memory", Icon: IcMemory, run: () => setPage("memory") },

      {
        group: "Ask SYNC", label: "Plan my day", Icon: IcSparkle,
        run: () => { setPage("console"); voice.send("Plan my day. Read what's already there first, then lay out the rest around it."); },
      },
      {
        group: "Ask SYNC", label: "What am I forgetting?", Icon: IcSparkle,
        run: () => { setPage("console"); voice.send("What am I forgetting? Check overdue follow-ups, tasks past their due date, and anything on the plan I haven't closed out."); },
      },
      {
        group: "Ask SYNC", label: "Write my morning brief", Icon: IcBrief,
        run: () => { setPage("console"); voice.send("Write my morning brief and file it."); },
      },
      {
        group: "Ask SYNC", label: "Debrief the day", Icon: IcBrief,
        run: () => { setPage("console"); voice.send("Debrief today — what actually got done, what slipped, and what tomorrow should start with. File it as the evening brief."); },
      },
      {
        group: "Ask SYNC", label: "Start a focus session", Icon: IcFocus,
        run: () => { setPage("console"); voice.send("Start a focus session on whatever is most important right now. Pick it yourself and tell me why."); },
      },

      {
        group: "Voice",
        label: s.settings.ambient ? "Stop listening for the wake word" : "Listen for the wake word",
        Icon: s.settings.ambient ? IcMicOff : IcMic,
        run: () => voice.toggleAmbient(),
      },
      {
        group: "Voice",
        label: s.settings.speak ? "Mute SYNC's voice" : "Let SYNC speak",
        Icon: IcSend,
        run: () => { setSettings({ speak: !s.settings.speak }); if (s.settings.speak) voice.shutUp(); },
      },

      // "Switch to Obsidian / Switch to Quartz" used to sit here. Quartz was
      // SYNC's private light room and it was deleted when this tool adopted the
      // Pentagon's palette — the command survived it, flipping a `settings.theme`
      // that nothing has read since, so the one thing it did was nothing. Light
      // and dark are the shell's now, one preference for the whole estate, and a
      // per-tool copy would be the private system this migration removed. A
      // control that visibly does nothing is worse than no control (§4.7).
      { group: "App", label: "Settings", Icon: IcSettings, run: onSettings },
      { group: "App", label: "Clear this conversation", Icon: IcTrash, run: () => { clearConversation(); setPage("console"); } },
    ];
  }, [setPage, voice, onSettings, open]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(needle));
  }, [q, commands]);

  // Anything the palette can't match becomes an instruction. Typing a sentence
  // and hitting return is the fastest path in the whole app.
  //
  // It sits *after* the matches, not before: if what you typed names a real
  // command, return has to run that command. Only when nothing matches does
  // the sentence become the default — and then it is the only thing there.
  const askItem = q.trim()
    ? { group: "Ask SYNC", label: `Ask: "${q.trim()}"`, Icon: IcSparkle, run: () => { setPage("console"); voice.send(q.trim()); } }
    : null;

  const items = askItem ? [...filtered, askItem] : filtered;
  const clamped = Math.min(sel, Math.max(0, items.length - 1));

  useEffect(() => {
    const el = listRef.current?.querySelector(".cmdk-item.sel");
    el?.scrollIntoView({ block: "nearest" });
  }, [clamped, items.length]);

  if (!open) return null;

  const fire = (i) => {
    const item = items[i];
    if (!item) return;
    onClose();
    // Let the palette finish closing before a command re-renders the page
    // underneath it — otherwise the exit animation is thrown away.
    setTimeout(() => item.run(), 0);
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); fire(clamped); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  let lastGroup = null;

  // Portaled to <body> like the sheets, and wrapped for the same reason: the
  // palette's own tokens and rules do not reach outside .sy-root.
  return createPortal(
    <PortalLayer>
      <div className="cmdk-scrim" onClick={onClose} />
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cmdk-input">
          <IcSearch size={18} style={{ color: "var(--faint)", flex: "none" }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={onKeyDown}
            placeholder="Type a command, or just say what you want done…"
            aria-label="Command"
          />
          <kbd>esc</kbd>
        </div>

        <div className="cmdk-list scroll-thin" ref={listRef}>
          {items.map((c, i) => {
            const showGroup = c.group !== lastGroup;
            lastGroup = c.group;
            return (
              <div key={`${c.group}-${c.label}-${i}`}>
                {showGroup && <div className="cmdk-group t-label">{c.group}</div>}
                <button
                  className={`cmdk-item${i === clamped ? " sel" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => fire(i)}
                >
                  <span className="ci"><c.Icon size={17} /></span>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
                  {i === clamped && <kbd className="chint">↵</kbd>}
                </button>
              </div>
            );
          })}
        </div>

        <div className="cmdk-foot">
          <span className="t-cap"><kbd>↑</kbd> <kbd>↓</kbd> navigate</span>
          <span className="t-cap"><kbd>↵</kbd> run</span>
          <span className="t-cap" style={{ marginLeft: "auto" }}>Anything unmatched goes to SYNC</span>
        </div>
      </div>
    </PortalLayer>,
    document.body
  );
}
