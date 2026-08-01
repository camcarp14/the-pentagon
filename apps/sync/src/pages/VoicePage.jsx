import { useState } from "react";
import { useStore } from "../data/useStore.js";
import { setSettings } from "../data/store.js";
import { useVoice } from "../voice/VoiceProvider.jsx";
import { PageHead, Segmented, SwitchRow, CellGroup, SectionHeader, Button, useToast } from "../ui/kit.jsx";
import { IcSpeaker, IcAlert } from "../ui/icons.jsx";

// ─── Voice ───────────────────────────────────────────────────────────────────
// Everything about how SYNC listens and how it sounds, on its own tab.
//
// It earns a tab rather than a row in the Settings sheet because voice stopped
// being a garnish: it is now the primary way this thing is used, and the two
// controls people actually reach for — "talk less" and "let me interrupt" — were
// buried behind a modal. The Settings sheet keeps what it is good at: the key,
// the model, the data.

// Deepgram's Aura voices. The descriptions are deliberately thin — pitch and
// warmth are the kind of thing nobody agrees about from a label, so there is a
// Preview button instead of an adjective.
const VOICES = [
  { id: "aura-2-thalia-en", name: "Thalia" },
  { id: "aura-2-andromeda-en", name: "Andromeda" },
  { id: "aura-2-helena-en", name: "Helena" },
  { id: "aura-2-apollo-en", name: "Apollo" },
  { id: "aura-2-arcas-en", name: "Arcas" },
  { id: "aura-2-aries-en", name: "Aries" },
  { id: "aura-asteria-en", name: "Asteria" },
  { id: "aura-orion-en", name: "Orion" },
  { id: "aura-luna-en", name: "Luna" },
  { id: "aura-stella-en", name: "Stella" },
];

const SAMPLE = "Morning. Your eleven o'clock moved to two, and the supplier still hasn't replied.";

function Row({ title, sub, children }) {
  return (
    <div className="v-row">
      <div className="v-row-text">
        <div className="v-row-title">{title}</div>
        {sub && <div className="v-row-sub">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

export default function VoicePage() {
  const s = useStore();
  const st = s.settings;
  const voice = useVoice();
  const toast = useToast();
  const [previewing, setPreviewing] = useState(false);

  const preview = () => {
    if (!st.speak) { toast("Turn on spoken replies first", { err: true }); return; }
    setPreviewing(true);
    voice.speak(SAMPLE);
    setTimeout(() => setPreviewing(false), 2500);
  };

  // THE PAGE FURNITURE EVERY OTHER PAGE HAS, AND THIS ONE DID NOT.
  //
  // Voice was the only destination rendering its content straight into
  // `.app-page` — no PageHead, no `.content-scroll`, no `.content-max`. The
  // consequences were not cosmetic. `.app-page` is a fixed-height flex column
  // inside a root that is `overflow: hidden`, so with no scroll container the
  // bottom of this page was CLIPPED AND UNREACHABLE: 104px of it at 1440x900
  // and 394px at 393x852, which is the wake-word switch and the whole paragraph
  // about what a conversation streams to Deepgram. Measured in a browser; no
  // source-text assertion could see it.
  // The full-bleed was the other half — with no `.content-max` every card ran
  // to both edges of the column while every other page's stopped at 900px.
  //
  // The <h1> does not come back with it. The heading said "Voice" underneath a
  // lit "Voice" pill; `namedByNav` is the same call Queue and Brief already
  // make, and the page's accessible name comes from the region App.jsx wraps it
  // in, wired to the same TAB_LABELS entry the pill renders.
  return (
    <>
      <PageHead
        title="Voice"
        namedByNav
        sub="How SYNC listens, and how it sounds. Changes take effect on the next thing it says."
      />
      <div className="content-scroll">
        <div className="content-max pagefade" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {/* ── talking ─────────────────────────────────────────────────── */}
        <SectionHeader title="Talking" />
        <CellGroup>
          <SwitchRow
            title="Speak replies"
            sub="Off makes SYNC text-only — everything still works, it just stays quiet"
            on={!!st.speak}
            onToggle={() => { const next = !st.speak; setSettings({ speak: next }); if (!next) voice.shutUp(); }}
          />
        </CellGroup>

        <div className="card pad-lg" style={{ marginTop: 10 }}>
          <Row title="Voice" sub="Deepgram's Aura voices. Preview rather than guess from the name.">
            <select
              className="field"
              style={{ maxWidth: 170 }}
              value={st.auraVoice}
              onChange={(e) => setSettings({ auraVoice: e.target.value })}
              aria-label="Voice"
            >
              {VOICES.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </Row>

          <Row title={`Speed · ${Number(st.speakRate).toFixed(2)}×`} sub="1× is how the voice was recorded">
            <input
              type="range"
              min="0.8" max="1.4" step="0.05"
              value={st.speakRate}
              onChange={(e) => setSettings({ speakRate: Number(e.target.value) })}
              aria-label="Speaking speed"
              style={{ width: 150 }}
            />
          </Row>

          <div style={{ marginTop: 12 }}>
            <Button kind="quiet" size="sm" onClick={preview} disabled={previewing}>
              <IcSpeaker size={15} /> {previewing ? "Playing…" : "Preview"}
            </Button>
          </div>
        </div>

        {/* ── how much it says ────────────────────────────────────────── */}
        <SectionHeader title="How much it says" />
        <div className="card pad-lg">
          <Segmented
            value={st.replyLength}
            onChange={(v) => setSettings({ replyLength: v })}
            options={[
              { key: "brief", label: "Brief" },
              { key: "normal", label: "Normal" },
              { key: "full", label: "Full" },
            ]}
          />
          <div className="t-foot" style={{ marginTop: 10 }}>
            {st.replyLength === "brief"
              ? "One sentence where one will do. Best on the move."
              : st.replyLength === "full"
                ? "Gives the reasoning when it matters. Best at a desk."
                : "Two or three sentences — the house default."}
          </div>
        </div>

        {/* ── conversation ────────────────────────────────────────────── */}
        <SectionHeader title="Conversation" trailing={voice.handsFree ? "Running" : undefined} />
        <div className="card pad-lg">
          <Row
            title="Interrupting"
            sub="How readily SYNC stops talking when it hears you"
          >
            <Segmented
              value={st.bargeSensitivity}
              onChange={(v) => setSettings({ bargeSensitivity: v })}
              options={[
                { key: "eager", label: "Eager" },
                { key: "normal", label: "Normal" },
                { key: "patient", label: "Patient" },
              ]}
            />
          </Row>
          <div className="t-foot" style={{ marginTop: -2, marginBottom: 14 }}>
            Cutting you off mid-reply for no reason? Go Patient. Having to raise your
            voice to interrupt? Go Eager.
          </div>

          <Row title="End after silence" sub="An open microphone keeps costing money in an empty room">
            <select
              className="field"
              style={{ maxWidth: 130 }}
              value={String(st.idleMinutes)}
              onChange={(e) => setSettings({ idleMinutes: Number(e.target.value) })}
              aria-label="End conversation after silence"
            >
              <option value="2">2 minutes</option>
              <option value="5">5 minutes</option>
              <option value="10">10 minutes</option>
              <option value="30">30 minutes</option>
              <option value="0">Never</option>
            </select>
          </Row>
        </div>

        <CellGroup style={{ marginTop: 10 }}>
          <SwitchRow
            title="Reveal text as it's spoken"
            sub="Off shows the whole reply at once — which means reading it before hearing it"
            on={!!st.syncReveal}
            onToggle={() => setSettings({ syncReveal: !st.syncReveal })}
          />
          <SwitchRow
            title="Listen for the wake word"
            sub={voice.sttSupported ? `Say "${st.wakeWord}" without starting a conversation` : "This browser has no speech recognition"}
            on={!!st.ambient}
            onToggle={voice.toggleAmbient}
            disabled={!voice.sttSupported}
          />
        </CellGroup>

        {/* ── the honest note ─────────────────────────────────────────── */}
        <div className="act" style={{ marginTop: 18 }}>
          <span className="act-ic" style={{ color: "var(--amber)" }}><IcAlert size={15} /></span>
          <span className="act-body">
            <span className="act-detail">
              A conversation streams what your microphone hears to Deepgram for as long
              as it runs, and spoken replies are generated there too. It never resumes
              on its own after a reload — you start it each time, deliberately.
            </span>
          </span>
        </div>
        </div>
      </div>
    </>
  );
}
