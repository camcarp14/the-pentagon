import { useLayoutEffect, useRef, useState } from "react";
import { NAV, TABS, navBadges, tabLabel } from "../nav.js";
import { useStore } from "../data/useStore.js";
import { setSettings } from "../data/store.js";
import { useVoice } from "../voice/VoiceProvider.jsx";
import { Dot, IconButton } from "../ui/kit.jsx";
import { IcSettings, IcMic, IcMicOff, IcSpeaker, IcSpeakerOff } from "../ui/icons.jsx";

// ─── The frame ───────────────────────────────────────────────────────────────
// A horizontal sub-nav under the shell's chrome on tablet and desktop; a native
// tab bar on a phone. Both drive the same `page` value, and both render from
// NAV — the sub-nav by label, the tab bar by label and icon.
//
// THE RAIL IS GONE, AND THAT IS THE POINT. SYNC used to put its six
// destinations in a 232px VERTICAL rail inside the content column. That was the
// one thing no other tool did, and once the shell grew a left rail of its own it
// became two stacked vertical navs on one screen — exactly what the shell's rail
// was added to stop. The row below is the shape ZTS and Clarify already ship
// (apps/zts/src/App.jsx, apps/clarify/src/App.jsx): a 52px band, one hairline
// under it, sticky off --shell-bar, --glass ground with a blur, and the kit's
// segmented control with its drawn sliding thumb.

const PHASE_TONE = {
  idle: "var(--faint)",
  listening: "var(--accent)",
  thinking: "var(--accent)",
  speaking: "var(--purple)",
  error: "var(--red)",
};

const PHASE_LABEL = {
  idle: "Standing by",
  listening: "Listening",
  thinking: "Working",
  speaking: "Speaking",
  error: "Error",
};

/**
 * Where the rail's four non-navigation affordances went.
 *
 * The rail's foot carried live state and controls, not destinations, and losing
 * any of them would have been a functional regression rather than a restyle:
 *
 *   · "Standing by" — the phase readout. It reports whether the microphone is
 *     open and whether SYNC is mid-sentence, and it has to be legible from
 *     every page, so it stays in the persistent chrome: the Status block on the
 *     right of the row below.
 *   · the microphone — the wake-word (ambient) toggle. Same row.
 *   · the settings gear. Same row.
 *   · "Commands ⌘K" — same row, as the `btn sm quiet` ⌘K affordance ZTS and
 *     Clarify both use, so the same control looks the same in three tools.
 *
 * One control joins them that the rail never had: the SPEAK toggle. It lived in
 * the Console's own `.console-bar`, alongside a second copy of the microphone
 * and a second copy of the gear — three buttons, two of which the rail already
 * drew a few hundred pixels away. With the row below reachable from every page
 * there is now exactly one home for each of the four, and the Console's bar is
 * drawn on a phone only, where there is no row (see ConsolePage).
 */
export function SubNav({ page, setPage, onSettings, onPalette }) {
  const s = useStore();
  const voice = useVoice();
  const badges = navBadges(s);
  const live = voice.phase !== "idle";

  // The kit's .seg-thumb, measured off the active pill exactly the way ZTS and
  // Clarify measure theirs — the kit animates left/width, so all this owns is
  // the geometry. Ready is false for the first paint so the thumb does not
  // slide in from 0 on mount.
  const tabRefs = useRef({});
  const [thumb, setThumb] = useState({ ready: false, left: 0, width: 0 });
  useLayoutEffect(() => {
    const el = tabRefs.current[page];
    if (!el) return;
    const measure = () => setThumb({ ready: true, left: el.offsetLeft, width: el.offsetWidth });
    measure();
    // The row scrolls rather than squashing at narrow desktop widths, so the
    // lit pill can be off the end of it — reachable by ⌘K, invisible on screen.
    // `nearest` on both axes is a no-op when it is already in view and cannot
    // move the page, which does not scroll at all in this app.
    const row = el.parentElement;
    if (row && row.scrollWidth > row.clientWidth) el.scrollIntoView({ block: "nearest", inline: "nearest" });
    // The badge counts change the pill's width while the app runs, and the row
    // reflows when the shell's rail resizes. A static measurement drifts.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, [page, badges.day, badges.queue]);

  return (
    // <nav>, not a bare <div>: the rail this replaces was a landmark
    // (`<nav aria-label="Main">`) and a screen reader user navigating by
    // landmark would otherwise have lost the whole of SYNC's navigation. The
    // tablist is a child of it, so the landmark role survives the tab idiom.
    <nav className="sy-nav" aria-label="Main">
      <div className="seg sy-nav-tabs" role="tablist" aria-label="Sections">
        {thumb.ready && <div className="seg-thumb" style={{ left: `${thumb.left}px`, width: `${thumb.width}px`, zIndex: 0 }} />}
        {TABS.map((key) => {
          const on = page === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={on}
              ref={(el) => { tabRefs.current[key] = el; }}
              className={on ? "seg-opt active" : "seg-opt"}
              onClick={() => setPage(key)}
            >
              {tabLabel(key)}
              {/* The count the rail carried as `.side-badge`. Attention, not
                  decoration — Day and Queue are the only two that ever have
                  one, and it is what told the operator to look. */}
              {badges[key] > 0 && <span className="sy-nav-badge t-num">{badges[key]}</span>}
            </button>
          );
        })}
      </div>

      <div className="sy-nav-actions">
        <span className="sy-nav-status" title={`SYNC is ${PHASE_LABEL[voice.phase].toLowerCase()}`}>
          <Dot tone={PHASE_TONE[voice.phase]} pulse={live} size={6} />
          <span className="t-cap sy-nav-phase" style={{ color: live ? PHASE_TONE[voice.phase] : "var(--faint)" }}>
            {PHASE_LABEL[voice.phase]}
          </span>
        </span>
        <IconButton
          label={s.settings.speak ? "Mute SYNC" : "Let SYNC speak"}
          on={s.settings.speak}
          onClick={() => { setSettings({ speak: !s.settings.speak }); if (s.settings.speak) voice.shutUp(); }}
        >
          {s.settings.speak ? <IcSpeaker size={17} /> : <IcSpeakerOff size={17} />}
        </IconButton>
        <IconButton
          label={s.settings.ambient ? "Stop listening" : "Listen for the wake word"}
          on={s.settings.ambient}
          onClick={voice.toggleAmbient}
          disabled={!voice.sttSupported}
        >
          {s.settings.ambient ? <IcMic size={17} /> : <IcMicOff size={17} />}
        </IconButton>
        <button type="button" className="btn sm quiet sy-nav-cmdk" onClick={onPalette} title="Command palette (⌘K)" aria-label="Command palette">
          ⌘K
        </button>
        <IconButton label="Settings" onClick={onSettings}><IcSettings size={17} /></IconButton>
      </div>
    </nav>
  );
}

export function Dock({ page, setPage }) {
  const s = useStore();
  const badges = navBadges(s);
  return (
    <nav className="dock" aria-label="Main">
      {NAV.map(({ key, Icon }) => (
        <button
          key={key}
          className={`dock-tab${page === key ? " active" : ""}`}
          onClick={() => setPage(key)}
          aria-current={page === key ? "page" : undefined}
        >
          <span className="dock-icon">
            <Icon size={22} />
            {badges[key] > 0 && page !== key && <span className="dock-pip" />}
          </span>
          <span className="dock-label">{tabLabel(key)}</span>
        </button>
      ))}
      {/* Settings is NOT in the dock, and the reason is worth keeping.
          It was added here because on a phone it had been unreachable entirely —
          which is how the API key came to be unset on the one device that gets
          used. That was right at five destinations. At six it made a seventh
          flex child, and seven `white-space: nowrap` labels have a combined
          min-content width wider than an iPhone: the row overflowed and the last
          item sat off the edge of the glass, present in the DOM and impossible
          to tap. Reported, correctly, as "the settings tab won't let me tap it".
          It lives as a gear in the Console's own top bar on a phone, and in the
          sub-nav's actions on everything wider — one tap either way, and never
          competing for width with the destinations. */}
    </nav>
  );
}
