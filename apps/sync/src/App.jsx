import { useEffect, useState, useRef } from "react";
import { NAV } from "./nav.js";
import { getState } from "./data/store.js";
import { VoiceProvider, useVoice } from "./voice/VoiceProvider.jsx";
import { useHotkey } from "./ui/hooks.js";
import Onboarding from "./chrome/Onboarding.jsx";
import { Sidebar, Dock } from "./chrome/Shell.jsx";
import CommandK from "./chrome/CommandK.jsx";
import SettingsSheet from "./chrome/SettingsSheet.jsx";
import ConsolePage from "./pages/ConsolePage.jsx";
import DayPage from "./pages/DayPage.jsx";
import QueuePage from "./pages/QueuePage.jsx";
import BriefPage from "./pages/BriefPage.jsx";
import MindPage from "./pages/MindPage.jsx";
// Still routable, no longer a destination: the dock slot became Mind, but the
// facts, notes and action ledger it holds are the operator's data and stay one
// tap away from the Mind page rather than being orphaned.
import MemoryPage from "./pages/MemoryPage.jsx";
import VoicePage from "./pages/VoicePage.jsx";

const PAGES = {
  console: ConsolePage,
  day: DayPage,
  queue: QueuePage,
  brief: BriefPage,
  mind: MindPage,
  memory: MemoryPage,
  voice: VoicePage,
};

function useIsPhone() {
  const [phone, setPhone] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const on = (e) => setPhone(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

/**
 * Is the soft keyboard up?
 *
 * The only thing SYNC still needs visualViewport for. The shell owns the window
 * and publishes --safe-bottom, so none of the old frame arithmetic survives —
 * but the tab bar must still get out of the way when someone types, or it
 * hovers in the middle of the screen above the keyboard.
 */
function useKeyboardOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const on = () => setOpen(vv.height < window.innerHeight * 0.75);
    on();
    vv.addEventListener("resize", on);
    return () => vv.removeEventListener("resize", on);
  }, []);
  return open;
}

function Workspace() {
  const [page, setPage] = useState("console");
  const [palette, setPalette] = useState(false);
  const [settings, setSettingsOpen] = useState(false);
  const voice = useVoice();
  const phone = useIsPhone();
  const keyboardOpen = useKeyboardOpen();
  const holding = useRef(false);

  const Page = PAGES[page] || ConsolePage;

  useHotkey("mod+k", (e) => { e.preventDefault(); setPalette((v) => !v); }, { allowInField: true });
  useHotkey("mod+,", (e) => { e.preventDefault(); setSettingsOpen(true); }, { allowInField: true });

  // Escape stops SYNC mid-sentence. Sheets swallow it first when one is open,
  // so this only fires when there's nothing layered on top.
  useHotkey("escape", () => { if (voice.busy || voice.phase === "speaking") voice.stop(); }, { allowInField: true });

  // Hold space to talk. Deliberately not a toggle: the whole point is that you
  // can start speaking without deciding to first, and let go when you're done.
  useEffect(() => {
    const isField = (el) => el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    // Space is also how a keyboard user activates a focused control. Taking it
    // for push-to-talk there would break the app for anyone not using a mouse,
    // so the binding stands down whenever something focusable has focus. Inside
    // the Pentagon that now includes the shell's own tool toggle and System
    // button, which sit outside this component entirely — hence the check on
    // document.activeElement rather than only on the event target.
    const onControl = (el) => el && (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute?.("role") === "switch");

    const down = (e) => {
      if (e.code !== "Space" || e.repeat || holding.current) return;
      if (isField(e.target) || palette || settings) return;
      if (onControl(e.target) || onControl(document.activeElement)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      holding.current = true;
      voice.holdStart();
    };
    const up = (e) => {
      if (e.code !== "Space" || !holding.current) return;
      e.preventDefault();
      holding.current = false;
      voice.holdEnd();
    };
    // A lost keyup (tab switch mid-hold, or switching tools in the shell) must
    // not leave the microphone open.
    const blur = () => { if (holding.current) { holding.current = false; voice.holdEnd(); } };

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [voice, palette, settings]);

  return (
    <div className="app">
      {!phone && <Sidebar page={page} setPage={setPage} onSettings={() => setSettingsOpen(true)} onPalette={() => setPalette(true)} />}

      <main className="app-main">
        {/* Keying on `page` restarts the entrance animation, so a destination
            develops instead of snapping into place.
            The region name comes from NAV, the same table the rail and the dock
            render from. Queue and Brief dropped their <h1> — it was the word
            already lit beside them — and a page with no heading is a page a
            screen reader cannot name; this is where the name went. `memory` is
            routable but not a NAV destination, so it falls back to its own
            still-visible heading rather than borrowing a wrong one. */}
        <div key={page} className="app-page" role="region" aria-label={NAV.find((n) => n.key === page)?.label}>
          <Page onSettings={() => setSettingsOpen(true)} setPage={setPage} />
        </div>

        {/* The tab bar — last flex child, in normal flow at the bottom of the
            column. It clears the home indicator through the shell's
            --safe-bottom, which is 0 on a letterboxed install where the
            reported inset is dead space rather than real. */}
        {phone && !keyboardOpen && <Dock page={page} setPage={setPage} onSettings={() => setSettingsOpen(true)} />}
      </main>

      <CommandK
        open={palette}
        onClose={() => setPalette(false)}
        setPage={setPage}
        voice={voice}
        onSettings={() => setSettingsOpen(true)}
      />
      {settings && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

export default function SyncApp() {
  const [onboarded, setOnboarded] = useState(() => getState().settings.onboarded);

  // No Boot screen and no theme wiring: the shell renders its own boot state
  // before any tool mounts, and the Pentagon is one dark canvas that the shell
  // stamps on the wrapper this tool lives inside.
  if (!onboarded) {
    return <div className="entrance"><Onboarding onDone={() => setOnboarded(true)} /></div>;
  }

  return (
    <VoiceProvider>
      <Workspace />
    </VoiceProvider>
  );
}
