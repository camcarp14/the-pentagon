import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient";
import DOMPurify from "dompurify";
import { AnimatedNumber, EmptyState, SkeletonLine, SkeletonRows, SkeletonBoard, CommandPalette, useToast, M } from "./ui.jsx";
import { T, syne, mono } from "./theme.js";
import { FactoryPanel, sendBriefToFactory } from "./factory.jsx";
import { DnaView } from "./dna/DnaView.jsx";
import { DnaWorker } from "./dna/dnaWorker.js";

// ════════════════════════════════════════════════════════════════════════════
// ZERO TO SECURE — Creator outreach + Shorts production command center.
// Built on the Clarify architecture (agent engine, premium design, pipeline
// mechanics) but native to ZTS: YouTube creators instead of local businesses,
// and a Shorts production Studio as a co-equal pillar.
// ════════════════════════════════════════════════════════════════════════════

// ─── Config ──────────────────────────────────────────────────────────────────
// SUPABASE_URL/ANON_KEY used to be declared here but were never actually used
// anywhere in this file — supabaseClient.js now owns that (same platform
// pattern as Board Room and Clarify Outreach).
const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || "";

const MODEL_PRICING = {
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
};
function estimateCost(model, inTok, outTok) {
  const p = MODEL_PRICING[model] || MODEL_PRICING["claude-haiku-4-5-20251001"];
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}

// ─── Persistence helpers (localStorage-backed stores) ────────────────────────
const sm = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(`zts_${k}`)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(`zts_${k}`, JSON.stringify(v)); } catch {} },
  del: (k) => { try { localStorage.removeItem(`zts_${k}`); } catch {} },
  keys: (prefix) => { const out = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(`zts_${prefix}`)) out.push(k.replace(`zts_${prefix}`, "")); } return out; },
};

// Observability log (mirrors Clarify's Ops)
const obs = {
  getAll: () => sm.get("obs_log") || [],
  log: (entry) => { const e = { id: `${Date.now()}_${Math.random().toString(36).slice(2,6)}`, ts: new Date().toISOString(), ...entry }; sm.set("obs_log", [e, ...(sm.get("obs_log") || [])].slice(0, 500)); },
  clear: () => sm.set("obs_log", []),
};

// ─── Claude call (shared) ────────────────────────────────────────────────────
async function callClaude({ system, messages, model = "claude-haiku-4-5-20251001", maxTokens = 1024, fn = "generate" }) {
  const t0 = Date.now();
  try {
    const isDeployed = window.location.hostname !== "localhost";
    const url = isDeployed ? "/.netlify/functions/claude" : "https://api.anthropic.com/v1/messages";
    let bearer = null;
    if (isDeployed) { try { bearer = (await supabase?.auth.getSession())?.data?.session?.access_token || null; } catch {} }
    const headers = isDeployed
      ? { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }
      : { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
    const body = { model, max_tokens: maxTokens, messages };
    if (system) body.system = system;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const data = await res.json();
    const text = data.content?.map(b => b.type === "text" ? b.text : "").join("") || "";
    const inTok = data.usage?.input_tokens || Math.round(JSON.stringify(messages).length / 4);
    const outTok = data.usage?.output_tokens || Math.round(text.length / 4);
    obs.log({ fn, model, inputTokens: inTok, outputTokens: outTok, costEstimate: estimateCost(model, inTok, outTok), latencyMs: Date.now() - t0, ok: !!text });
    return text;
  } catch (e) {
    obs.log({ fn, model, ok: false, latencyMs: Date.now() - t0 });
    return null;
  }
}

// ─── ZTS domain: creator-fit value model ─────────────────────────────────────
// Unlike Clarify's monthly retainer, a creator's value to ZTS is audience reach
// weighted by how relevant their niche is to Bitcoin self-custody and how engaged
// their audience is. A 50k-sub Bitcoin-privacy channel beats a 500k general-tech one.
const NICHE_FIT = [
  { match: ["self custody","self-custody","hardware wallet","seed phrase","cold storage","privacy"], weight: 1.0, label: "Self-Custody" },
  { match: ["bitcoin","btc","satoshi","lightning"], weight: 0.9, label: "Bitcoin" },
  { match: ["crypto","cryptocurrency","altcoin","ethereum","defi"], weight: 0.6, label: "Crypto" },
  { match: ["finance","investing","money","wealth"], weight: 0.4, label: "Finance" },
  { match: ["tech","security","cybersecurity","privacy tech"], weight: 0.5, label: "Tech/Security" },
];
function nicheFit(creator) {
  const text = `${creator.channel_name || ""} ${creator.niche || ""} ${creator.description || ""}`.toLowerCase();
  const hit = NICHE_FIT.find(n => n.match.some(m => text.includes(m)));
  return hit || { weight: 0.25, label: "General" };
}
function creatorValue(creator) {
  const subs = creator.subscriber_count || 0;
  const fit = nicheFit(creator);
  const engagement = creator.engagement_rate != null ? creator.engagement_rate : 0.04; // default 4%
  // Reach-value: effective engaged audience in the right niche.
  const score = Math.round(subs * fit.weight * Math.min(engagement / 0.04, 2.5));
  return { score, fitLabel: fit.label, fitWeight: fit.weight, tier: score >= 40000 ? "Prime" : score >= 12000 ? "Strong" : score >= 3000 ? "Fit" : "Light" };
}
function fmtSubs(n) {
  if (!n) return "0";
  if (n >= 1e6) return `${(n/1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n/1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
}
// ─── Premium design system (inherited from Clarify's redesign) ───────────────
function useGlobalStyles() {
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600;700&family=Syne:wght@600;700;800&display=swap";
    document.head.appendChild(link);
    const style = document.createElement("style");
    style.textContent = `
      *, *::before, *::after { box-sizing: border-box; }
      * { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }
      html, body { margin: 0; font-family: 'Inter', system-ui, sans-serif; }
      body { background-color: #0B0F1A; background-image: radial-gradient(1200px 600px at 12% -8%, rgba(62,207,142,0.06), transparent 60%), radial-gradient(1000px 700px at 100% 0%, rgba(110,168,254,0.05), transparent 55%); background-attachment: fixed; }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 10px; border: 2px solid transparent; background-clip: padding-box; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); background-clip: padding-box; }
      textarea, input, select, button { font-family: 'Inter', system-ui, sans-serif; }
      ::selection { background: rgba(62,207,142,0.28); color: #F7F9FC; }
      button, a, [role="button"], input, select, textarea { transition: background-color 0.16s ease, border-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease, transform 0.12s ease, opacity 0.16s ease; }
      button:not(:disabled):active { transform: translateY(0.5px); }
      button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(62,207,142,0.34); }
      input::placeholder, textarea::placeholder { color: #5A6780; }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
      @keyframes fadein { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes slideup { from { opacity: 0; transform: translateY(28px); } to { opacity: 1; transform: none; } }
      @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
      @keyframes toastIn { from { opacity: 0; transform: translateX(18px) scale(0.97); } to { opacity: 1; transform: none; } }
      @keyframes toastOut { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateX(18px) scale(0.97); } }
      @keyframes toastShrink { from { transform: scaleX(1); } to { transform: scaleX(0); } }
      @keyframes paletteIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: none; } }
      @keyframes cardIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      html { overflow-x: hidden; }
      body { overflow-x: hidden; }
      @media (hover: hover) and (pointer: fine) {
        .zts-card-hover:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(0,0,0,0.45), 0 16px 40px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.07); }
      }
      @media (max-width: ${MOBILE_BP}px) {
        input, select, textarea { font-size: 16px !important; }
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
      }
    `;
    document.head.appendChild(style);
  }, []);
}

// ZTS palette (T), display/mono fonts, and motion (M) now live in ./theme.js —
// the shared midnight canvas + emerald accent, derived from @cc/design.

const Card = ({ children, style, onClick, hover }) => (
  <div onClick={onClick} className={hover ? "zts-card-hover" : undefined}
    style={{ background: T.card, borderRadius: "16px", border: `1px solid ${T.line}`, boxShadow: T.cardShadow, padding: "18px 20px", cursor: onClick ? "pointer" : "default", transition: hover ? "transform 0.15s ease, box-shadow 0.15s ease" : undefined, ...style }}>{children}</div>
);
const Label = ({ children, style }) => <div style={{ fontSize: "11px", fontWeight: 700, color: T.sub, textTransform: "uppercase", letterSpacing: "0.13em", fontFamily: syne, ...style }}>{children}</div>;
const Btn = ({ children, onClick, primary, disabled, style }) => (
  <button onClick={onClick} disabled={disabled}
    style={{ padding: "10px 18px", background: disabled ? "rgba(255,255,255,0.06)" : primary ? T.greenGrad : "transparent", border: primary ? `1px solid ${T.accentLine}` : `1px solid ${T.line}`, borderRadius: "10px", color: disabled ? T.faint : primary ? T.accentInk : T.sub, fontSize: "12px", fontWeight: 700, cursor: disabled ? "default" : "pointer", fontFamily: syne, letterSpacing: "0.02em", ...style }}>{children}</button>
);

// ─── Mobile retrofit — shared responsive helpers (desktop paths untouched) ───
// Single breakpoint: phones only (largest phones ~430px, smallest tablets
// ~768px — 680 sits in the gap so tablets/desktop windows are never caught).
const MOBILE_BP = 680;
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" ? window.innerWidth <= MOBILE_BP : false);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= MOBILE_BP);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile;
}
const viewPad = (isMobile) => (isMobile ? "16px 16px 26px" : "24px 28px");
// Kanban boards: unchanged grid on desktop; a horizontal scroll-snap rail on
// mobile so every stage stays reachable with a swipe instead of collapsing.
const kanbanWrapStyle = (isMobile, cols) => isMobile
  ? { display: "flex", gap: "10px", overflowX: "auto", WebkitOverflowScrolling: "touch", scrollSnapType: "x proximity", paddingBottom: "6px" }
  : { display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: "12px", alignItems: "start" };
const kanbanColStyle = (isMobile) => isMobile ? { minWidth: "80vw", maxWidth: "80vw", flexShrink: 0, scrollSnapAlign: "start" } : undefined;

// Shared modal chrome: centered card on desktop (unchanged), bottom sheet on
// mobile so it feels native instead of a floating box on a big screen.
function ModalShell({ onClose, isMobile, width = 560, children }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(11,18,32,0.5)", zIndex: 300, display: "flex", alignItems: isMobile ? "flex-end" : "center", justifyContent: "center", animation: `${isMobile ? "slideup" : "fadein"} 0.18s ease both` }}>
      <div onClick={e => e.stopPropagation()} style={{ background: T.card, borderRadius: isMobile ? "20px 20px 0 0" : "18px", width: isMobile ? "100%" : `${width}px`, maxWidth: isMobile ? "100%" : "94vw", maxHeight: isMobile ? "90vh" : "88vh", display: "flex", flexDirection: "column", boxShadow: isMobile ? "0 -12px 40px rgba(11,17,32,0.22)" : "0 32px 80px rgba(11,17,32,0.24)", overflow: "hidden" }}>
        {isMobile && <div style={{ width: "36px", height: "4px", borderRadius: "3px", background: "rgba(255,255,255,0.18)", margin: "10px auto -4px", flexShrink: 0 }} />}
        {children}
      </div>
    </div>
  );
}

// Bottom-nav icon set — plain geometry only (circles/lines/polygons), no
// icon library dependency, matches the app's existing minimal glyph style.
const TAB_ICONS = {
  mission: (c) => <><polyline points="4,11 12,4.5 20,11" /><path d="M6 10 V19.5 H18 V10" /></>,
  creators: (c) => <><circle cx="8.6" cy="7.8" r="2.5" /><polygon points="8.6,11.3 4.2,19 13,19" /><circle cx="16.6" cy="9.4" r="2.1" /><polygon points="16.6,12.4 13.3,19 19.9,19" /></>,
  studio: (c) => <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><polygon points="10,9.3 10,14.7 15,12" fill={c} stroke="none" /></>,
  seo: (c) => <><circle cx="10.3" cy="10.3" r="6" /><line x1="14.7" y1="14.7" x2="20" y2="20" /></>,
  dna: (c) => <><circle cx="5.5" cy="8" r="2" /><circle cx="18.5" cy="6.5" r="2" /><circle cx="7.5" cy="18" r="2" /><circle cx="17" cy="17.5" r="2" /><line x1="7.4" y1="8.9" x2="16.6" y2="7.4" /><line x1="6.4" y1="9.8" x2="8.6" y2="16.2" /><line x1="9.4" y1="17.8" x2="15.1" y2="17.6" /></>,
  agents: (c) => <><circle cx="12" cy="5.5" r="2" /><circle cx="5.8" cy="17" r="2" /><circle cx="18.2" cy="17" r="2" /><line x1="12" y1="7.5" x2="7.2" y2="15.3" /><line x1="12" y1="7.5" x2="16.8" y2="15.3" /></>,
  ops: (c) => <polyline points="3,13 7,13 9,19 13,6 15,13 21,13" />,
};
const TabIcon = ({ tab, color, size = 21 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {TAB_ICONS[tab] ? TAB_ICONS[tab](color) : null}
  </svg>
);
// Fixed bottom tab bar — replaces the top segmented control on mobile only.
function BottomNav({ view, setView, tabs }) {
  return (
    <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 200, display: "flex", background: "rgba(11,15,26,0.92)", backdropFilter: "blur(20px) saturate(140%)", WebkitBackdropFilter: "blur(20px) saturate(140%)", borderTop: `1px solid ${T.line}`, boxShadow: "0 -2px 16px rgba(0,0,0,0.4)", paddingBottom: "var(--safe-bottom)" }}>
      {tabs.map(t => {
        const active = view === t;
        const color = active ? T.greenDeep : T.faint;
        return (
          <button key={t} onClick={() => setView(t)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "3px", padding: "8px 2px 7px", background: "none", border: "none", cursor: "pointer" }}>
            <TabIcon tab={t} color={color} />
            <span style={{ fontSize: "9px", fontWeight: 700, color, textTransform: "uppercase", letterSpacing: "0.04em", fontFamily: syne }}>{t}</span>
          </button>
        );
      })}
    </div>
  );
}
// ════════════════════════════════════════════════════════════════════════════
// STUDIO — Shorts production. Each Short moves: idea → script → assets → ready →
// posted. Claude generates the assets live; the three Short types frame the angle.
// ════════════════════════════════════════════════════════════════════════════

const SHORT_TYPES = {
  angle: {
    label: "ZTS Angle",
    desc: "Repeatable self-custody truths — 'not your keys', exchange risk, sovereignty.",
    systemHint: "Draw on the ZTS angle library: 'not your keys, not your coins', exchange collapses (FTX, Mt. Gox, Celsius), the case for cold storage, sovereignty and self-reliance. Punchy, conviction-driven, slightly contrarian.",
  },
  news: {
    label: "Newsjack",
    desc: "React to a current crypto event — hack, collapse, regulation, price move.",
    systemHint: "React to a specific current event the user provides. Open with the news hook, pivot fast to the self-custody lesson. Timely and urgent without being alarmist.",
  },
  educational: {
    label: "Educational",
    desc: "Explain how self-custody works — seed phrases, backups, threat models.",
    systemHint: "Teach one concrete self-custody concept clearly and simply (seed phrase backup, metal vs paper, passphrase, inheritance planning). Calm, credible, beginner-friendly.",
  },
};

const ZTS_BRAND = `Zero To Secure (ZTS) sells a premium stainless-steel seed phrase backup kit for Bitcoin self-custody. Brand voice: confident, sovereign, no-nonsense, security-first, respects the viewer's intelligence. Core belief: people locked out of traditional systems deserve real control over their own money. Never fear-monger cheaply; lead with empowerment. Audience: Bitcoin holders who are serious about not losing their coins to exchange failure, hacks, or their own mistakes.`;

// Generate a full Shorts asset package in one structured call.
async function generateShort({ type, topic, creatorContext, model = "claude-haiku-4-5-20251001" }) {
  const t = SHORT_TYPES[type] || SHORT_TYPES.angle;
  const system = `You are the head of short-form content for Zero To Secure. ${ZTS_BRAND}

You are writing a YouTube Short (under 60 seconds, ~140-160 words of spoken script). ${t.systemHint}

Respond ONLY with valid JSON, no preamble or markdown fences:
{
  "hook": "the first 3 seconds — a scroll-stopping spoken line",
  "script": "the full spoken script, ~140-160 words, punchy short sentences, written to be read aloud, with natural pauses",
  "thumbnail_concepts": [
    { "visual": "what's on screen", "text_overlay": "3-5 words max, bold" },
    { "visual": "alternate concept", "text_overlay": "3-5 words max" }
  ],
  "title": "YouTube title, under 60 chars, high-CTR, no clickbait lies",
  "description": "2-3 line description with a soft CTA to ZTS",
  "tags": ["8-12 relevant tags"],
  "pinned_comment": "a comment to pin that drives engagement or the ZTS link"
}`;
  const userMsg = `Short type: ${t.label}\nTopic / angle: ${topic || "(choose a strong one for this type)"}${creatorContext ? `\nThis Short is for a collab with: ${creatorContext}` : ""}`;
  const raw = await callClaude({ system, messages: [{ role: "user", content: userMsg }], model, maxTokens: 1400, fn: "generate_short" });
  if (!raw) return null;
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return null; }
}

// Regenerate a single asset (when the user wants just a new title, or new thumbnails).
async function regenAsset({ asset, short, type, model = "claude-haiku-4-5-20251001" }) {
  const t = SHORT_TYPES[type] || SHORT_TYPES.angle;
  const assetSpec = {
    title: 'Respond ONLY with JSON: {"title": "..."} — a fresh high-CTR title under 60 chars.',
    thumbnail_concepts: 'Respond ONLY with JSON: {"thumbnail_concepts": [{"visual":"...","text_overlay":"..."},{"visual":"...","text_overlay":"..."}]}',
    hook: 'Respond ONLY with JSON: {"hook": "..."} — a new scroll-stopping opening line.',
    description: 'Respond ONLY with JSON: {"description":"...","tags":["..."]}',
  }[asset];
  const system = `You are the head of short-form content for Zero To Secure. ${ZTS_BRAND} ${t.systemHint} ${assetSpec}`;
  const userMsg = `Existing script:\n${short.script || short.topic || ""}\n\nGive a fresh ${asset.replace("_", " ")}.`;
  const raw = await callClaude({ system, messages: [{ role: "user", content: userMsg }], model, maxTokens: 600, fn: "regen_asset" });
  if (!raw) return null;
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return null; }
}

const SHORT_STAGES = [
  { key: "idea", label: "Idea", color: "#8A97A8" },
  { key: "script", label: "Script", color: "#B68A2E" },
  { key: "assets", label: "Assets", color: "#3B82F6" },
  { key: "ready", label: "Ready", color: "#0E9F6E" },
  { key: "posted", label: "Posted", color: "#7C3AED" },
];

// ─── Stage stepping — one helper for every pipeline in the app ────────────────
// Returns the stage one step forward/back, or null at the ends. Every kanban
// (creators, shorts, articles) moves through its stages with the same ‹ ›
// controls, in both directions.
function stepStage(stages, current, dir) {
  const order = stages.map(s => s.key);
  const i = order.indexOf(current);
  if (i === -1) return dir > 0 ? order[0] : null;
  const next = i + dir;
  if (next < 0 || next >= order.length) return null;
  return order[next];
}

// Compact ‹ › stepper rendered on kanban cards. stopPropagation so steppers
// never fight the card's own onClick (open detail).
function StageStepper({ stages, current, onMove, blockForward = false, blockBack = false, forwardTitle }) {
  const back = blockBack ? null : stepStage(stages, current, -1);
  const fwd = blockForward ? null : stepStage(stages, current, +1);
  const fwdLabel = fwd ? stages.find(s => s.key === fwd)?.label : null;
  const btn = (enabled) => ({
    padding: "4px 9px", background: "transparent", border: `1px solid ${enabled ? T.line : "rgba(255,255,255,0.05)"}`,
    borderRadius: "7px", fontSize: "10px", fontWeight: 700, color: enabled ? T.sub : "rgba(255,255,255,0.2)",
    cursor: enabled ? "pointer" : "default", fontFamily: syne,
  });
  return (
    <div style={{ display: "flex", gap: "5px", marginTop: "8px" }} onClick={e => e.stopPropagation()}>
      <button title={back ? `Back to ${stages.find(s => s.key === back)?.label}` : "Already at the first stage"}
        disabled={!back} onClick={() => back && onMove(back)} style={btn(!!back)}>‹</button>
      <button title={fwd ? `Move to ${fwdLabel}` : forwardTitle || "Already at the last stage"}
        disabled={!fwd} onClick={() => fwd && onMove(fwd)} style={{ ...btn(!!fwd), flex: 1 }}>
        {fwd ? `${fwdLabel} ›` : stages[stages.length - 1].key === current ? "✓" : "—"}
      </button>
    </div>
  );
}

// The publish checklist — every Short runs the same pre-flight before going live.
const PUBLISH_CHECKLIST = [
  "Script recorded & edited",
  "Thumbnail designed (1080×1920)",
  "Title finalized (under 60 chars)",
  "Description + ZTS link added",
  "Tags added",
  "Pinned comment ready",
  "Captions / subtitles on",
  "Scheduled or posted",
];
// ════════════════════════════════════════════════════════════════════════════
// AGENT ENGINE — same two-speed design as Clarify: free heuristic heartbeat,
// rare gated synthesis. ZTS-native watchers cover BOTH pillars (creators + studio).
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// SEO — article pipeline with an approval gate. The agent drafts on a cadence
// (or on demand); nothing publishes without passing your review. Phase 1 uses a
// manual keyword panel (paste from Search Console); Phase 2 wires GSC OAuth.
// ════════════════════════════════════════════════════════════════════════════
const ARTICLE_STAGES = [
  { key: "idea", label: "Idea", color: "#8A97A8" },
  { key: "review", label: "In Review", color: "#F59E0B" },
  { key: "approved", label: "Approved", color: "#3B82F6" },
  { key: "published", label: "Published", color: "#0E9F6E" },
];

// ZTS's natural topic clusters — the agent seeds article ideas from these when
// no keyword is supplied. These are the queries ZTS buyers actually search.
const SEO_TOPIC_CLUSTERS = [
  "metal seed phrase backup vs paper",
  "how to back up a seed phrase safely",
  "what happens to your bitcoin if an exchange collapses",
  "hardware wallet backup best practices",
  "bitcoin inheritance planning self custody",
  "seed phrase storage mistakes that lose bitcoin",
  "stainless steel crypto backup comparison",
  "not your keys not your coins explained",
];

async function generateArticle({ keyword, notes, model = "claude-haiku-4-5-20251001" }) {
  const system = `You are the SEO content lead for Zero To Secure. ${ZTS_BRAND}

Write a search-optimized blog article. Rules: genuinely useful first, optimized second — no keyword stuffing. Write for a smart beginner-to-intermediate Bitcoin holder. Use the target keyword naturally in the title, first paragraph, and 1-2 H2s. Weave in ZTS product relevance without being an ad. Suggest internal links to: /products (the ZTS kit), /pages/breach-index (exchange hack history), /pages/academy (self-custody lessons).

Respond ONLY with valid JSON, no preamble or markdown fences:
{
  "target_keyword": "the primary keyword",
  "search_intent": "informational | commercial | transactional",
  "title_tag": "under 60 chars, keyword near front",
  "meta_description": "under 155 chars, compelling, includes keyword",
  "slug": "url-slug-here",
  "outline": ["H2: ...", "H2: ...", "H3: ..."],
  "article_html": "the full article as clean HTML (h2/h3/p/ul/li/strong only), 1000-1400 words",
  "internal_links": [{ "anchor": "anchor text", "target": "/pages/breach-index" }],
  "word_count": 1200
}`;
  const userMsg = keyword
    ? `Target keyword: ${keyword}${notes ? `\nNotes/angle: ${notes}` : ""}`
    : `No keyword supplied — pick the strongest un-covered topic from ZTS's clusters: ${SEO_TOPIC_CLUSTERS.join("; ")}`;
  const raw = await callClaude({ system, messages: [{ role: "user", content: userMsg }], model, maxTokens: 4000, fn: "generate_article" });
  if (!raw) return null;
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return null; }
}

// Publish to the Shopify blog. Deployed → Netlify function (holds the Admin token);
// local → copies the HTML so you can paste into Shopify admin manually. Mirrors
// the sendEmail/createMeeting graceful-degradation pattern.
async function publishToShopify(article) {
  const isDeployed = window.location.hostname !== "localhost";
  if (isDeployed) {
    // The function now requires a session (it publishes a live, public article
    // with the store's admin token), so send the same bearer callClaude uses.
    let bearer = null;
    try { bearer = (await supabase?.auth.getSession())?.data?.session?.access_token || null; } catch {}
    const res = await fetch("/.netlify/functions/shopify-publish", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ title: article.title_tag, body_html: article.article_html, summary: article.meta_description, tags: article.target_keyword, handle: article.slug }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || "Shopify publish failed");
    return { method: "api", url: data.url || null };
  }
  try { await navigator.clipboard.writeText(article.article_html || ""); } catch {}
  return { method: "clipboard" };
}

const ENGINE_DEFAULTS = {
  running: false, observeOnly: true, cadenceSec: 20, synthEveryMin: 30,
  hourlyCostCap: 0.25, pauseWhenIdle: true, idleMin: 10, allowSonnet: false,
  seoAutoDraft: false, seoEveryDays: 4,
  agents: { creatorScout: true, production: true, cadence: true, reply: true, pattern: true, seoCadence: true, cost: true },
};
const eng = {
  get: () => ({ ...ENGINE_DEFAULTS, ...(sm.get("engine_ctrl") || {}), agents: { ...ENGINE_DEFAULTS.agents, ...((sm.get("engine_ctrl") || {}).agents || {}) } }),
  set: (patch) => sm.set("engine_ctrl", { ...eng.get(), ...patch }),
  setAgent: (key, on) => { const c = eng.get(); eng.set({ agents: { ...c.agents, [key]: on } }); },
};
const kb = {
  all: () => sm.get("agent_kb") || [],
  add: (entries) => { if (!entries || !entries.length) return 0; const ex = sm.get("agent_kb") || []; const stamped = entries.map(e => ({ id: `${Date.now()}_${Math.random().toString(36).slice(2,6)}`, ts: new Date().toISOString(), ...e })); sm.set("agent_kb", [...stamped, ...ex].slice(0, 400)); return stamped.length; },
  clear: () => sm.set("agent_kb", []),
  seenToday: (agent, key) => { const t = new Date().toISOString().slice(0,10); return (sm.get("agent_kb") || []).some(e => e.agent === agent && e.dedupKey === key && (e.ts||"").slice(0,10) === t); },
};
function markActivity() { sm.set("engine_last_activity", Date.now()); }
function isIdle(min) { const last = sm.get("engine_last_activity") || Date.now(); return (Date.now() - last) > min * 60000; }

// Heuristic watchers — pure JS, zero cost. Cover creators AND studio production.
const HEURISTIC_AGENTS = {
  creatorScout: { name: "Creator Scout", scan: (ctx) => {
    const out = [];
    const primeIdle = ctx.creators.filter(c => c.status === "prospected" && creatorValue(c).tier === "Prime");
    if (primeIdle.length > 0 && !kb.seenToday("creatorScout", "prime_idle")) {
      const top = primeIdle.sort((a,b) => creatorValue(b).score - creatorValue(a).score)[0];
      out.push({ agent: "creatorScout", type: "observation", signal: "warning", dedupKey: "prime_idle", text: `${primeIdle.length} Prime-fit creator${primeIdle.length!==1?"s":""} un-contacted. Top: ${top.channel_name} (${fmtSubs(top.subscriber_count)} subs, ${creatorValue(top).fitLabel}). These convert best for ZTS — reach out first.` });
    }
    return out;
  }},
  production: { name: "Production Watcher", scan: (ctx) => {
    const out = [];
    const stuck = ctx.shorts.filter(s => s.stage === "script" || s.stage === "assets");
    if (stuck.length >= 3 && !kb.seenToday("production", "wip_pileup")) out.push({ agent: "production", type: "observation", signal: "info", dedupKey: "wip_pileup", text: `${stuck.length} Shorts are mid-production (script/assets). Batching the finish step keeps your posting cadence alive.` });
    const ready = ctx.shorts.filter(s => s.stage === "ready").length;
    if (ready >= 2 && !kb.seenToday("production", "ready_queue")) out.push({ agent: "production", type: "observation", signal: "warning", dedupKey: "ready_queue", text: `${ready} Shorts are READY to post but not scheduled. Get them on the calendar — published beats perfect.` });
    return out;
  }},
  cadence: { name: "Cadence Monitor", scan: (ctx) => {
    const out = [];
    const posted = ctx.shorts.filter(s => s.stage === "posted" && s.posted_at);
    if (posted.length > 0) {
      const last = posted.sort((a,b) => new Date(b.posted_at) - new Date(a.posted_at))[0];
      const days = Math.floor((Date.now() - new Date(last.posted_at).getTime()) / 86400000);
      if (days >= 3 && !kb.seenToday("cadence", "posting_gap")) out.push({ agent: "cadence", type: "observation", signal: "warning", dedupKey: "posting_gap", text: `${days} days since your last Short went live. The algorithm rewards consistency — ship one today.` });
    }
    return out;
  }},
  reply: { name: "Reply Sentinel", scan: (ctx) => {
    const out = [];
    const replies = ctx.creators.filter(c => c.status === "replied");
    if (replies.length > 0 && !kb.seenToday("reply", "creator_replies")) out.push({ agent: "reply", type: "observation", signal: "critical", dedupKey: "creator_replies", text: `${replies.length} creator repl${replies.length!==1?"ies":"y"} waiting. Warm collab interest goes cold fast — respond before anything else.` });
    return out;
  }},
  pattern: { name: "Pattern Learner", scan: (ctx) => {
    const out = [];
    const posted = ctx.shorts.filter(s => s.stage === "posted");
    if (posted.length < 4) return out;
    const byType = {};
    posted.forEach(s => { const t = s.type || "angle"; if (!byType[t]) byType[t] = 0; byType[t]++; });
    const top = Object.entries(byType).sort((a,b) => b[1]-a[1])[0];
    if (top && !kb.seenToday("pattern", "type_mix")) out.push({ agent: "pattern", type: "learning", signal: "info", dedupKey: "type_mix", text: `Learning: ${SHORT_TYPES[top[0]]?.label || top[0]} is your most-produced Short type (${top[1]} posted). Watch which type actually drives ZTS clicks and lean in.` });
    return out;
  }},
  seoCadence: { name: "SEO Cadence", scan: (ctx) => {
    const out = [];
    const inReview = ctx.articles.filter(a => a.stage === "review").length;
    if (inReview >= 2 && !kb.seenToday("seoCadence", "review_backlog")) out.push({ agent: "seoCadence", type: "observation", signal: "warning", dedupKey: "review_backlog", text: `${inReview} articles are waiting in your SEO review queue. Approve or reject them so the cadence keeps moving.` });
    const published = ctx.articles.filter(a => a.stage === "published" && a.published_at);
    if (published.length > 0) {
      const last = published.sort((a,b) => new Date(b.published_at) - new Date(a.published_at))[0];
      const days = Math.floor((Date.now() - new Date(last.published_at).getTime()) / 86400000);
      if (days >= 7 && !kb.seenToday("seoCadence", "publish_gap")) out.push({ agent: "seoCadence", type: "observation", signal: "info", dedupKey: "publish_gap", text: `${days} days since your last article published. Steady cadence compounds — check the review queue.` });
    }
    return out;
  }},
  cost: { name: "Cost Sentinel", scan: (ctx) => {
    const out = [];
    const hourAgo = Date.now() - 3600000;
    const spend = ctx.obsLogs.filter(l => new Date(l.ts).getTime() > hourAgo).reduce((s,l) => s + (l.costEstimate||0), 0);
    if (spend > 0.5 && !kb.seenToday("cost", "spend")) out.push({ agent: "cost", type: "observation", signal: "warning", dedupKey: "spend", text: `AI spend hit $${spend.toFixed(2)} this hour. Generation runs on Haiku-first to keep this low.` });
    return out;
  }},
};

const AGENT_META = [
  { key: "creatorScout", name: "Creator Scout", role: "Outreach prioritization", watches: "Prime-fit creators (high subs × niche relevance × engagement) sitting un-contacted. Surfaces the highest-value collab targets for ZTS first.", cost: "Free heuristic" },
  { key: "production", name: "Production Watcher", role: "Studio throughput", watches: "Shorts stuck mid-production and finished Shorts not yet scheduled. Keeps the content pipeline flowing so you actually ship.", cost: "Free heuristic" },
  { key: "cadence", name: "Cadence Monitor", role: "Posting consistency", watches: "Days since your last Short went live. Flags posting gaps because the algorithm rewards consistency.", cost: "Free heuristic" },
  { key: "reply", name: "Reply Sentinel", role: "Collab triage", watches: "Creator replies waiting on you. Raises a critical flag so warm collab interest never goes cold.", cost: "Free heuristic" },
  { key: "pattern", name: "Pattern Learner", role: "Content learning", watches: "Which Short types you produce most, building toward which ones actually drive ZTS conversions.", cost: "Free heuristic" },
  { key: "seoCadence", name: "SEO Cadence", role: "Content pipeline", watches: "The article review queue and days since last publish. When auto-draft is on, it also queues a new draft for your approval on your cadence.", cost: "Free heuristic (draft = 1 gated call)" },
  { key: "cost", name: "Cost Sentinel", role: "Spend guardrail", watches: "AI generation spend over the last hour. Keeps the engine honest on token cost.", cost: "Free heuristic" },
  { key: "synthesizer", name: "Synthesizer", role: "Insight distillation", watches: "Accumulated observations from every agent. Occasionally distills them into one highest-leverage move across creators + studio. The only agent that spends tokens.", cost: "Haiku · gated" },
];

function engineSpendThisHour() { const h = Date.now() - 3600000; return obs.getAll().filter(l => l.fn === "agent_synthesis" && new Date(l.ts).getTime() > h).reduce((s,l) => s + (l.costEstimate||0), 0); }
function stateHash(creators, shorts) { const sig = [...creators.map(c => `${c.id}:${c.status}`), ...shorts.map(s => `${s.id}:${s.stage}`)].sort().join("|"); let h = 0; for (let i=0;i<sig.length;i++){ h = ((h<<5)-h+sig.charCodeAt(i))|0; } return String(h); }

async function synthesizeInsight(recentObs, allowSonnet) {
  if (!recentObs || !recentObs.length) return null;
  const model = allowSonnet ? "claude-sonnet-4-6" : "claude-haiku-4-5-20251001";
  const bullets = recentObs.slice(0, 12).map(o => `- [${o.agent}] ${o.text}`).join("\n");
  const system = `You are the strategist for Zero To Secure, a Bitcoin self-custody brand running creator outreach AND a YouTube Shorts production pipeline. Your agents observed the following. In 1-2 sentences, name the single highest-leverage move right now across either pillar. Be specific and actionable. No preamble.`;
  const raw = await callClaude({ system, messages: [{ role: "user", content: bullets }], model, maxTokens: 200, fn: "agent_synthesis" });
  return raw;
}
// ─── STUDIO VIEW — the Shorts production pillar ──────────────────────────────
function StudioView({ shorts, setShorts, isMobile, loading, openSignal = 0, onSignalConsumed }) {
  const [composing, setComposing] = useState(false);
  const [openShort, setOpenShort] = useState(null);
  const toast = useToast();

  // Palette handoff: "New Short" from ⌘K opens the composer, even if Studio
  // was already the active view. Consuming clears the signal in App so a
  // later remount doesn't re-open it.
  useEffect(() => { if (openSignal > 0) { setComposing(true); onSignalConsumed?.(); } }, [openSignal, onSignalConsumed]);

  const addShort = async (short) => {
    const fields = { stage: "script", ...short };
    if (!supabase) {
      const s = { id: `local_${Date.now()}`, created_at: new Date().toISOString(), ...fields };
      setShorts(prev => [s, ...prev]); setComposing(false); setOpenShort(s);
      return;
    }
    const { data, error: err } = await supabase.from("shorts").insert(fields).select();
    if (err) { console.warn("[StudioView] insert failed:", err.message); toast.push("Couldn't save the Short: " + err.message, { tone: "error" }); setComposing(false); return; }
    const s = data?.[0];
    if (s) { setShorts(prev => [s, ...prev]); setOpenShort(s); }
    setComposing(false);
  };
  const updateShort = async (id, patch) => {
    setShorts(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s)); // optimistic
    if (openShort?.id === id) setOpenShort(prev => ({ ...prev, ...patch }));
    if (!supabase) return;
    const { error: err } = await supabase.from("shorts").update(patch).eq("id", id);
    if (err) { console.warn("[StudioView] update failed:", err.message); toast.push("Change didn't save — " + err.message, { tone: "error" }); }
  };
  const delShort = async (id) => {
    setShorts(prev => prev.filter(s => s.id !== id)); // optimistic
    setOpenShort(null);
    if (!supabase) return;
    const { error: err } = await supabase.from("shorts").delete().eq("id", id);
    if (err) { console.warn("[StudioView] delete failed:", err.message); toast.push("Delete didn't stick — " + err.message, { tone: "error" }); }
  };

  const byStage = (k) => shorts.filter(s => s.stage === k);

  return (
    <div style={{ minHeight: "calc(100vh - 52px)", padding: viewPad(isMobile) }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <div style={{ fontSize: "18px", fontWeight: 700, color: T.ink, fontFamily: syne }}>Studio</div>
          <div style={{ fontSize: "12px", color: T.faint, marginTop: "2px" }}>Generate Shorts and every asset — script, thumbnail, title, description — then ship.</div>
        </div>
        <Btn primary onClick={() => setComposing(true)}>✦ New Short</Btn>
      </div>

      {/* Stage board */}
      {loading ? (
        <SkeletonBoard cols={4} />
      ) : shorts.length === 0 ? (
        <EmptyState icon="film" title="No Shorts yet"
          sub="Spin up your first Short — pick a type, give a topic, and Claude drafts the whole package."
          action={<Btn primary onClick={() => setComposing(true)}>✦ Create your first Short</Btn>} />
      ) : (
        <div style={kanbanWrapStyle(isMobile, 5)}>
          {SHORT_STAGES.map(stage => {
            const items = byStage(stage.key);
            return (
              <div key={stage.key} style={kanbanColStyle(isMobile)}>
                <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "10px", padding: "0 2px" }}>
                  <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: stage.color }} />
                  <span style={{ fontSize: "11px", fontWeight: 700, color: T.ink, fontFamily: syne }}>{stage.label}</span>
                  <span style={{ fontSize: "11px", color: T.faint, fontFamily: mono }}>{items.length}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {items.map((s, idx) => {
                    const t = SHORT_TYPES[s.type] || SHORT_TYPES.angle;
                    return (
                      <div key={s.id} style={{ animation: `cardIn 0.3s ${M.easeOut} both`, animationDelay: `${Math.min(idx, 8) * 30}ms` }}>
                      <Card hover onClick={() => setOpenShort(s)} style={{ padding: "12px 13px", borderLeft: `3px solid ${stage.color}` }}>
                        <div style={{ display: "inline-block", fontSize: "8px", fontWeight: 700, color: T.amberDeep, background: "rgba(245,158,11,0.1)", padding: "2px 6px", borderRadius: "5px", textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: syne, marginBottom: "6px" }}>{t.label}</div>
                        <div style={{ fontSize: "12px", fontWeight: 600, color: T.ink, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{s.title || s.topic || "Untitled"}</div>
                        {s.hook && <div style={{ fontSize: "10px", color: T.faint, marginTop: "4px", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{s.hook}</div>}
                        <StageStepper stages={SHORT_STAGES} current={stage.key}
                          onMove={(next) => updateShort(s.id, { stage: next, ...(next === "posted" ? { posted_at: new Date().toISOString() } : stage.key === "posted" ? { posted_at: null } : {}) })} />
                      </Card>
                      </div>
                    );
                  })}
                  {items.length === 0 && <EmptyState compact icon="inbox" tint={T.faint} title="Nothing here" />}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Factory — the production half of the Studio. shorts-factory (factory/
          in this repo) turns filmed footage into the finished 9:16 Short; this
          rail shows its live project state whenever the local bridge is up. */}
      <FactoryPanel isMobile={isMobile} />

      {composing && <ComposeModal isMobile={isMobile} onClose={() => setComposing(false)} onCreate={addShort} />}
      {openShort && <ShortDetail short={openShort} isMobile={isMobile} onClose={() => setOpenShort(null)} onUpdate={updateShort} onDelete={delShort} />}
    </div>
  );
}

// Compose: pick type + topic, generate the full package.
function ComposeModal({ onClose, onCreate, isMobile }) {
  const [type, setType] = useState("angle");
  const [topic, setTopic] = useState("");
  const [gen, setGen] = useState(false);
  const toast = useToast();

  const create = async () => {
    setGen(true);
    const pkg = await generateShort({ type, topic });
    setGen(false);
    if (pkg) { onCreate({ type, topic, stage: "assets", ...pkg }); toast.push("Short package drafted — hook, script, thumbnails, title, the lot.", { tone: "success" }); }
    else { onCreate({ type, topic, stage: "idea" }); toast.push("Generation didn't complete — the Short was saved as an idea. Open it to retry.", { tone: "warning" }); }
  };

  return (
    <ModalShell onClose={onClose} isMobile={isMobile} width={560}>
      <div style={{ padding: isMobile ? "14px 18px calc(18px + var(--safe-bottom))" : "26px 28px", overflowY: "auto" }}>
        <div style={{ fontSize: "16px", fontWeight: 700, color: T.ink, fontFamily: syne, marginBottom: "4px" }}>New Short</div>
        <div style={{ fontSize: "12px", color: T.faint, marginBottom: "20px" }}>Pick a type and topic — Claude drafts the hook, script, thumbnails, title, description, and tags.</div>

        <Label style={{ marginBottom: "8px" }}>Short type</Label>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: "8px", marginBottom: "18px" }}>
          {Object.entries(SHORT_TYPES).map(([k, t]) => (
            <button key={k} onClick={() => setType(k)} style={{ textAlign: "left", padding: "12px 13px", background: type === k ? "rgba(14,159,110,0.07)" : "transparent", border: `1px solid ${type === k ? "rgba(14,159,110,0.35)" : T.line}`, borderRadius: "11px", cursor: "pointer" }}>
              <div style={{ fontSize: "12px", fontWeight: 700, color: type === k ? T.greenDeep : T.ink, fontFamily: syne, marginBottom: "3px" }}>{t.label}</div>
              <div style={{ fontSize: "10px", color: T.faint, lineHeight: 1.4 }}>{t.desc}</div>
            </button>
          ))}
        </div>

        <Label style={{ marginBottom: "8px" }}>{type === "news" ? "What's the news / event?" : "Topic or angle (optional)"}</Label>
        <textarea value={topic} onChange={e => setTopic(e.target.value)} placeholder={type === "news" ? "e.g. another exchange just froze withdrawals…" : type === "educational" ? "e.g. why a metal backup beats paper" : "e.g. not your keys, not your coins — leave blank for Claude to pick"}
          style={{ width: "100%", minHeight: "70px", padding: "11px 13px", border: `1px solid ${T.line}`, borderRadius: "10px", fontSize: "13px", color: T.ink, resize: "vertical", lineHeight: 1.5 }} />

        <div style={{ display: "flex", gap: "8px", marginTop: "20px" }}>
          <Btn primary onClick={create} disabled={gen} style={{ flex: 1, padding: "12px" }}>{gen ? "Generating the package…" : "✦ Generate Short"}</Btn>
          <Btn onClick={onClose} style={{ padding: "12px 18px" }}>Cancel</Btn>
        </div>
        <div style={{ fontSize: "10px", color: T.faint, textAlign: "center", marginTop: "10px" }}>One Claude call drafts all assets. Runs on Haiku to stay cheap.</div>
      </div>
    </ModalShell>
  );
}
// Short detail — view/edit/regenerate every asset, run the publish checklist, advance stage.
function ShortDetail({ short, onClose, onUpdate, onDelete, isMobile }) {
  const [regen, setRegen] = useState(null); // which asset is regenerating
  const [tab, setTab] = useState("assets");
  const toast = useToast();
  const t = SHORT_TYPES[short.type] || SHORT_TYPES.angle;
  const checklist = short.checklist || {};

  const doRegen = async (asset) => {
    setRegen(asset);
    const result = await regenAsset({ asset, short, type: short.type });
    setRegen(null);
    if (result) onUpdate(short.id, result);
    else toast.push("Regeneration failed — try again in a moment.", { tone: "error" });
  };
  const toggleCheck = (item) => { const next = { ...checklist, [item]: !checklist[item] }; onUpdate(short.id, { checklist: next }); };
  const moveStage = (dir) => {
    const next = stepStage(SHORT_STAGES, short.stage, dir);
    if (!next) return;
    onUpdate(short.id, { stage: next, ...(next === "posted" ? { posted_at: new Date().toISOString() } : short.stage === "posted" ? { posted_at: null } : {}) });
  };
  const [sendingBrief, setSendingBrief] = useState(false);
  const sendToFactory = async () => {
    setSendingBrief(true);
    await sendBriefToFactory(short, toast);
    setSendingBrief(false);
  };
  const copyAll = () => {
    const text = `TITLE: ${short.title || ""}\n\nHOOK: ${short.hook || ""}\n\nSCRIPT:\n${short.script || ""}\n\nDESCRIPTION:\n${short.description || ""}\n\nTAGS: ${(short.tags||[]).join(", ")}\n\nPINNED COMMENT: ${short.pinned_comment || ""}`;
    try { navigator.clipboard.writeText(text); toast.push("All assets copied — paste straight into YouTube Studio.", { tone: "success" }); }
    catch { toast.push("Couldn't reach the clipboard.", { tone: "error" }); }
  };

  const checkDone = PUBLISH_CHECKLIST.filter(i => checklist[i]).length;

  const AssetBlock = ({ title, asset, children }) => (
    <div style={{ marginBottom: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "7px" }}>
        <Label>{title}</Label>
        {asset && <button onClick={() => doRegen(asset)} disabled={regen === asset} style={{ fontSize: "10px", fontWeight: 700, color: regen === asset ? T.faint : T.greenDeep, background: "none", border: "none", cursor: regen === asset ? "default" : "pointer", fontFamily: syne }}>{regen === asset ? "↻ regenerating…" : "↻ regenerate"}</button>}
      </div>
      {children}
    </div>
  );
  const box = { background: T.subtle, border: `1px solid ${T.line}`, borderRadius: "10px", padding: "12px 14px", fontSize: "13px", color: T.ink, lineHeight: 1.6, whiteSpace: "pre-wrap" };

  const hPad = isMobile ? "18px" : "24px";
  return (
    <ModalShell onClose={onClose} isMobile={isMobile} width={640}>
        <div style={{ padding: `18px ${hPad}`, borderBottom: `1px solid ${T.line}`, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexShrink: 0 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "inline-block", fontSize: "9px", fontWeight: 700, color: T.amberDeep, background: "rgba(245,158,11,0.1)", padding: "2px 7px", borderRadius: "5px", textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: syne, marginBottom: "6px" }}>{t.label} · {short.stage}</div>
            <div style={{ fontSize: "15px", fontWeight: 700, color: T.ink, fontFamily: syne, lineHeight: 1.3 }}>{short.title || short.topic || "Untitled Short"}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.faint, fontSize: "20px", cursor: "pointer", lineHeight: 1, flexShrink: 0 }}>×</button>
        </div>

        <div style={{ display: "flex", gap: "4px", padding: `12px ${hPad} 0`, flexShrink: 0 }}>
          {[["assets", "Assets"], ["publish", `Publish (${checkDone}/${PUBLISH_CHECKLIST.length})`]].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} style={{ padding: "7px 14px", background: tab === k ? "rgba(14,159,110,0.08)" : "transparent", border: "none", borderRadius: "8px", color: tab === k ? T.greenDeep : T.faint, fontSize: "12px", fontWeight: 700, cursor: "pointer", fontFamily: syne }}>{l}</button>
          ))}
        </div>

        <div style={{ padding: `18px ${hPad}`, overflowY: "auto" }}>
          {tab === "assets" ? (
            <>
              {!short.script && short.stage === "idea" ? (
                <div style={{ textAlign: "center", padding: "30px 0" }}>
                  <div style={{ fontSize: "13px", color: T.faint, marginBottom: "16px" }}>Generation didn't complete. Try again:</div>
                  <Btn primary disabled={regen === "all"} onClick={async () => { setRegen("all"); const pkg = await generateShort({ type: short.type, topic: short.topic }); setRegen(null); if (pkg) onUpdate(short.id, { stage: "assets", ...pkg }); else toast.push("Generation failed again — try in a moment.", { tone: "error" }); }}>{regen === "all" ? "Generating…" : "✦ Generate assets"}</Btn>
                </div>
              ) : (
                <>
                  <AssetBlock title="Hook (first 3 seconds)" asset="hook"><div style={box}>{short.hook || "—"}</div></AssetBlock>
                  <AssetBlock title="Script"><div style={box}>{short.script || "—"}</div></AssetBlock>
                  <AssetBlock title="Thumbnail concepts" asset="thumbnail_concepts">
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      {(short.thumbnail_concepts || []).map((tc, i) => (
                        <div key={i} style={{ ...box, display: "flex", gap: "12px", alignItems: "center" }}>
                          <div style={{ flexShrink: 0, width: "70px", height: "90px", background: T.navyGrad, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", padding: "8px", textAlign: "center" }}>
                            <span style={{ fontSize: "10px", fontWeight: 800, color: T.amber, fontFamily: syne, lineHeight: 1.1, textTransform: "uppercase" }}>{tc.text_overlay}</span>
                          </div>
                          <div style={{ fontSize: "12px", color: T.sub, lineHeight: 1.5 }}>{tc.visual}</div>
                        </div>
                      ))}
                    </div>
                  </AssetBlock>
                  <AssetBlock title="Title" asset="title"><div style={box}>{short.title || "—"}</div></AssetBlock>
                  <AssetBlock title="Description + tags" asset="description">
                    <div style={box}>{short.description || "—"}</div>
                    {(short.tags || []).length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", marginTop: "8px" }}>{short.tags.map((tag, i) => <span key={i} style={{ fontSize: "10px", color: T.sub, background: "rgba(255,255,255,0.06)", padding: "2px 8px", borderRadius: "12px", fontFamily: mono }}>#{tag}</span>)}</div>}
                  </AssetBlock>
                  {short.pinned_comment && <AssetBlock title="Pinned comment"><div style={box}>{short.pinned_comment}</div></AssetBlock>}
                </>
              )}
            </>
          ) : (
            <div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "16px" }}>
                {PUBLISH_CHECKLIST.map(item => (
                  <button key={item} onClick={() => toggleCheck(item)} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 13px", background: checklist[item] ? "rgba(14,159,110,0.06)" : "transparent", border: `1px solid ${checklist[item] ? "rgba(14,159,110,0.25)" : T.line}`, borderRadius: "9px", cursor: "pointer", textAlign: "left" }}>
                    <span style={{ width: "18px", height: "18px", borderRadius: "5px", border: `1.5px solid ${checklist[item] ? T.green : "#CBD5E1"}`, background: checklist[item] ? T.green : "transparent", color: "#FFF", fontSize: "11px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{checklist[item] ? "✓" : ""}</span>
                    <span style={{ fontSize: "12px", color: checklist[item] ? T.sub : T.ink, fontWeight: 500, textDecoration: checklist[item] ? "line-through" : "none" }}>{item}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: `14px ${hPad}`, borderTop: `1px solid ${T.line}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", flexShrink: 0 }}>
          <button onClick={() => onDelete(short.id)} style={{ background: "none", border: "none", color: T.faint, fontSize: "11px", cursor: "pointer", fontWeight: 600 }}>Delete</button>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {short.script && <Btn onClick={sendToFactory} disabled={sendingBrief} title="Hand this Short's script + packaging to the shorts-factory production pipeline">{sendingBrief ? "Sending…" : "⇢ Factory"}</Btn>}
            <Btn onClick={copyAll}>Copy all</Btn>
            {short.stage !== "idea" && <Btn onClick={() => moveStage(-1)} title={`Back to ${SHORT_STAGES.find(s => s.key === stepStage(SHORT_STAGES, short.stage, -1))?.label || ""}`}>‹ Back</Btn>}
            {short.stage !== "posted" && <Btn primary onClick={() => moveStage(+1)}>{short.stage === "ready" ? "Mark posted →" : isMobile ? "Advance →" : "Advance stage →"}</Btn>}
          </div>
        </div>
    </ModalShell>
  );
}
// ─── CREATORS VIEW — outreach pipeline (YouTube creators) ────────────────────
const CREATOR_STAGES = [
  { key: "prospected", label: "Prospected", color: "#8A97A8" },
  { key: "drafted", label: "Drafted", color: "#F59E0B" },
  { key: "sent", label: "Sent", color: "#3B82F6" },
  { key: "replied", label: "Replied", color: "#EC4899" },
  { key: "collab", label: "Collab", color: "#0E9F6E" },
];

// Collab pitch draft — the "Drafted" stage finally has a drafting mechanism.
// One Haiku call, grounded in the creator's niche/size and the ZTS brand voice.
async function generateCreatorPitch(creator) {
  const v = creatorValue(creator);
  const system = `You are Cameron, founder of Zero To Secure. ${ZTS_BRAND}

You are writing a first-touch collab pitch email to a YouTube creator. Rules:
- Reference their channel and niche specifically — show you actually watch.
- The offer: a paid/affiliate collab featuring the ZTS metal seed-phrase backup kit (integration or dedicated Short), creative control stays with them.
- Confident and peer-to-peer, never fawning. No "I hope this finds you well".
- Under 130 words. Sign off: Cameron | Zero To Secure

Respond ONLY with valid JSON, no markdown fences: {"subject": "...", "body": "..."}`;
  const userMsg = `Channel: ${creator.channel_name}
Subscribers: ${fmtSubs(creator.subscriber_count)}
Niche: ${creator.niche || "unknown"} (fit: ${v.fitLabel}, tier: ${v.tier})
${creator.description ? `About them: ${creator.description}` : ""}`;
  const raw = await callClaude({ system, messages: [{ role: "user", content: userMsg }], maxTokens: 500, fn: "creator_pitch" });
  if (!raw) return null;
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return null; }
}
function CreatorsView({ creators, setCreators, isMobile, loading, openSignal = 0, onSignalConsumed }) {
  const [adding, setAdding] = useState(false);
  const [openCreator, setOpenCreator] = useState(null);
  const [sortBy, setSortBy] = useState("value");
  const toast = useToast();

  // Palette handoff: "Add Creator" from ⌘K opens the form, even if Creators
  // was already the active view. Consuming clears the signal in App.
  useEffect(() => { if (openSignal > 0) { setAdding(true); onSignalConsumed?.(); } }, [openSignal, onSignalConsumed]);

  const move = async (id, stage) => {
    setCreators(prev => prev.map(c => c.id === id ? { ...c, stage, status: stage } : c)); // optimistic
    if (openCreator?.id === id) setOpenCreator(prev => ({ ...prev, stage, status: stage }));
    if (!supabase) return;
    const { error: err } = await supabase.from("creators").update({ stage, status: stage }).eq("id", id);
    if (err) { console.warn("[CreatorsView] stage update failed:", err.message); toast.push("Stage change didn't save — " + err.message, { tone: "error" }); }
  };

  // localOnly: update React state without touching Supabase — used when the
  // caller already persisted (or deliberately persisted elsewhere, e.g. the
  // pitch's localStorage fallback when the columns don't exist).
  const updateCreator = async (id, patch, { localOnly = false } = {}) => {
    setCreators(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c)); // optimistic
    if (openCreator?.id === id) setOpenCreator(prev => ({ ...prev, ...patch }));
    if (localOnly || !supabase) return true;
    const { error: err } = await supabase.from("creators").update(patch).eq("id", id);
    if (err) { console.warn("[CreatorsView] update failed:", err.message); toast.push("Change didn't save — " + err.message, { tone: "error" }); return false; }
    return true;
  };

  const delCreator = async (id) => {
    setCreators(prev => prev.filter(c => c.id !== id)); // optimistic
    setOpenCreator(null);
    sm.del(`pitch_${id}`); // clear any locally-stored pitch for the deleted row
    if (!supabase) return;
    const { error: err } = await supabase.from("creators").delete().eq("id", id);
    if (err) { console.warn("[CreatorsView] delete failed:", err.message); toast.push("Delete didn't stick — " + err.message, { tone: "error" }); }
  };

  const sorted = [...creators].sort((a, b) => {
    if (sortBy === "value") return creatorValue(b).score - creatorValue(a).score;
    if (sortBy === "subs") return (b.subscriber_count||0) - (a.subscriber_count||0);
    return (a.channel_name||"").localeCompare(b.channel_name||"");
  });
  const byStage = (k) => sorted.filter(c => (c.stage || "prospected") === k);
  const totalReach = creators.filter(c => !["rejected"].includes(c.stage)).reduce((s, c) => s + creatorValue(c).score, 0);

  return (
    <div style={{ minHeight: "calc(100vh - 52px)", padding: viewPad(isMobile) }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <div style={{ fontSize: "18px", fontWeight: 700, color: T.ink, fontFamily: syne }}>Creators</div>
          <div style={{ fontSize: "12px", color: T.faint, marginTop: "2px" }}>Find, contact, and track YouTube creators for ZTS collabs — prioritized by audience fit.</div>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ padding: "8px 12px", border: `1px solid ${T.line}`, borderRadius: "9px", fontSize: "12px", color: T.sub, background: T.subtle }}>
            <option value="value">Best fit first</option>
            <option value="subs">Most subscribers</option>
            <option value="name">A → Z</option>
          </select>
          <Btn primary onClick={() => setAdding(true)}>+ Add Creator</Btn>
        </div>
      </div>

      {creators.length > 0 && (
        <div style={{ display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "16px", padding: "0 2px" }}>
          <Label>Audience-fit reach</Label>
          <span style={{ fontSize: "15px", fontWeight: 600, color: T.ink, fontFamily: mono }}>{fmtSubs(totalReach)}<span style={{ fontSize: "11px", color: T.faint }}> weighted reach in pipeline</span></span>
        </div>
      )}

      {loading ? (
        <SkeletonBoard cols={4} />
      ) : creators.length === 0 ? (
        <EmptyState icon="users" title="No creators yet"
          sub="Add YouTube creators to start building your collab pipeline. They're auto-scored by fit to ZTS."
          action={<Btn primary onClick={() => setAdding(true)}>+ Add your first creator</Btn>} />
      ) : (
        <div style={kanbanWrapStyle(isMobile, 5)}>
          {CREATOR_STAGES.map(stage => {
            const items = byStage(stage.key);
            return (
              <div key={stage.key} style={kanbanColStyle(isMobile)}>
                <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "10px", padding: "0 2px" }}>
                  <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: stage.color }} />
                  <span style={{ fontSize: "11px", fontWeight: 700, color: T.ink, fontFamily: syne }}>{stage.label}</span>
                  <span style={{ fontSize: "11px", color: T.faint, fontFamily: mono }}>{items.length}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {items.map((c, idx) => {
                    const v = creatorValue(c);
                    const tierColor = v.tier === "Prime" ? T.green : v.tier === "Strong" ? T.blue : v.tier === "Fit" ? T.amber : T.faint;
                    return (
                      <div key={c.id} style={{ animation: `cardIn 0.3s ${M.easeOut} both`, animationDelay: `${Math.min(idx, 8) * 30}ms` }}>
                      <Card hover onClick={() => setOpenCreator(c)} style={{ padding: "12px 13px", borderLeft: `3px solid ${tierColor}` }}>
                        <div style={{ fontSize: "12px", fontWeight: 700, color: T.ink, fontFamily: syne, lineHeight: 1.3 }}>{c.channel_name}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "4px", flexWrap: "wrap" }}>
                          <span style={{ fontSize: "10px", color: T.sub, fontFamily: mono }}>{fmtSubs(c.subscriber_count)} subs</span>
                          <span style={{ fontSize: "9px", fontWeight: 700, color: tierColor, background: tierColor + "15", padding: "1px 6px", borderRadius: "5px", fontFamily: syne }}>{v.tier} · {v.fitLabel}</span>
                          {(c.pitch_body || sm.get(`pitch_${c.id}`)) && <span title="Collab pitch drafted" style={{ fontSize: "9px", fontWeight: 700, color: T.amberDeep, background: "rgba(245,158,11,0.1)", padding: "1px 6px", borderRadius: "5px", fontFamily: syne }}>✦ pitch</span>}
                        </div>
                        <StageStepper stages={CREATOR_STAGES} current={stage.key} onMove={(next) => move(c.id, next)} />
                      </Card>
                      </div>
                    );
                  })}
                  {items.length === 0 && <EmptyState compact icon="inbox" tint={T.faint} title="Nothing here" />}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {adding && <AddCreatorModal isMobile={isMobile} onClose={() => setAdding(false)} onAdd={async (c) => {
        const fields = { stage: "prospected", status: "prospected", ...c };
        if (!supabase) {
          setCreators(prev => [{ id: `local_${Date.now()}`, created_at: new Date().toISOString(), ...fields }, ...prev]);
          setAdding(false);
          return;
        }
        const { data, error: err } = await supabase.from("creators").insert(fields).select();
        if (err) { console.warn("[AddCreatorModal] insert failed:", err.message); toast.push("Couldn't add the creator: " + err.message, { tone: "error" }); return; }
        if (data?.[0]) { setCreators(prev => [data[0], ...prev]); toast.push(`${c.channel_name} added to the pipeline.`, { tone: "success" }); }
        setAdding(false);
      }} />}
      {openCreator && <CreatorDetail creator={openCreator} isMobile={isMobile} onClose={() => setOpenCreator(null)} onUpdate={updateCreator} onDelete={delCreator} onMove={move} />}
    </div>
  );
}

// Creator detail — edit, delete, move stages, and draft the collab pitch.
// The pitch persists to the creators row when the columns exist; if the
// schema doesn't have them yet, it falls back to local storage so the
// feature works either way (the card badge reads from the same field).
function CreatorDetail({ creator, onClose, onUpdate, onDelete, onMove, isMobile }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ channel_name: creator.channel_name || "", subscriber_count: String(creator.subscriber_count || ""), niche: creator.niche || "", engagement_rate: creator.engagement_rate != null ? String(creator.engagement_rate * 100) : "", description: creator.description || "" });
  const [pitch, setPitch] = useState(() => (creator.pitch_subject || creator.pitch_body) ? { subject: creator.pitch_subject || "", body: creator.pitch_body || "" } : sm.get(`pitch_${creator.id}`));
  const [drafting, setDrafting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const toast = useToast();
  const v = creatorValue(creator);
  const tierColor = v.tier === "Prime" ? T.green : v.tier === "Strong" ? T.blue : v.tier === "Fit" ? T.amber : T.faint;
  const stage = creator.stage || "prospected";
  const stageMeta = CREATOR_STAGES.find(s => s.key === stage) || CREATOR_STAGES[0];
  const hPad = isMobile ? "18px" : "24px";
  const set = (k, val) => setF(p => ({ ...p, [k]: val }));

  const saveEdit = async () => {
    const patch = {
      channel_name: f.channel_name.trim() || creator.channel_name,
      subscriber_count: Number(f.subscriber_count) || 0,
      niche: f.niche.trim(),
      engagement_rate: f.engagement_rate ? Number(f.engagement_rate) / 100 : null,
      description: f.description.trim(),
    };
    if (await onUpdate(creator.id, patch)) toast.push("Creator updated.", { tone: "success" });
    setEditing(false);
  };

  const savePitch = async (p) => {
    setPitch(p);
    // Try the DB first; if the pitch columns don't exist in the schema the
    // update fails and the pitch lives in localStorage instead. Either way the
    // in-memory row is patched localOnly — persistence already happened here,
    // so onUpdate must not retry Supabase (that would error-toast every blur).
    if (supabase) {
      const { error: err } = await supabase.from("creators").update({ pitch_subject: p.subject, pitch_body: p.body }).eq("id", creator.id);
      if (!err) { onUpdate(creator.id, { pitch_subject: p.subject, pitch_body: p.body }, { localOnly: true }); return; }
    }
    sm.set(`pitch_${creator.id}`, p);
    onUpdate(creator.id, { pitch_subject: p.subject, pitch_body: p.body }, { localOnly: true });
  };

  const draftPitch = async () => {
    setDrafting(true);
    const p = await generateCreatorPitch(creator);
    setDrafting(false);
    if (p) { await savePitch(p); if (stage === "prospected") onMove(creator.id, "drafted"); toast.push("Collab pitch drafted — edit it, then copy into your email client.", { tone: "success" }); }
    else toast.push("Pitch generation failed — try again in a moment.", { tone: "error" });
  };

  const copyPitch = () => {
    if (!pitch) return;
    try { navigator.clipboard.writeText(`Subject: ${pitch.subject}\n\n${pitch.body}`); toast.push("Pitch copied.", { tone: "success" }); } catch {}
  };

  const input = { width: "100%", padding: "9px 12px", border: `1px solid ${T.line}`, borderRadius: "9px", fontSize: "13px", color: T.ink, marginBottom: "8px" };
  const box = { background: T.subtle, border: `1px solid ${T.line}`, borderRadius: "10px", padding: "12px 14px", fontSize: "13px", color: T.ink, lineHeight: 1.6, whiteSpace: "pre-wrap" };

  return (
    <ModalShell onClose={onClose} isMobile={isMobile} width={560}>
      <div style={{ padding: `18px ${hPad}`, borderBottom: `1px solid ${T.line}`, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexShrink: 0 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap", marginBottom: "5px" }}>
            <span style={{ fontSize: "9px", fontWeight: 700, color: stageMeta.color, background: stageMeta.color + "15", padding: "2px 7px", borderRadius: "5px", textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: syne }}>{stageMeta.label}</span>
            <span style={{ fontSize: "9px", fontWeight: 700, color: tierColor, background: tierColor + "15", padding: "2px 7px", borderRadius: "5px", fontFamily: syne }}>{v.tier} · {v.fitLabel}</span>
          </div>
          <div style={{ fontSize: "16px", fontWeight: 700, color: T.ink, fontFamily: syne }}>{creator.channel_name}</div>
          <div style={{ fontSize: "11px", color: T.faint, fontFamily: mono, marginTop: "2px" }}>{fmtSubs(creator.subscriber_count)} subs · weighted reach {fmtSubs(v.score)}</div>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: T.faint, fontSize: "20px", cursor: "pointer", lineHeight: 1, flexShrink: 0 }}>×</button>
      </div>

      <div style={{ padding: `16px ${hPad}`, overflowY: "auto" }}>
        {/* Stage movement — full stepper, both directions */}
        <Label style={{ marginBottom: "8px" }}>Pipeline stage</Label>
        <div style={{ display: "flex", gap: "5px", marginBottom: "18px", flexWrap: "wrap" }}>
          {CREATOR_STAGES.map(s => (
            <button key={s.key} onClick={() => s.key !== stage && onMove(creator.id, s.key)}
              style={{ padding: "6px 12px", background: s.key === stage ? s.color + "15" : "transparent", border: `1px solid ${s.key === stage ? s.color + "50" : T.line}`, borderRadius: "8px", fontSize: "10px", fontWeight: 700, color: s.key === stage ? s.color : T.faint, cursor: s.key === stage ? "default" : "pointer", fontFamily: syne }}>
              {s.label}
            </button>
          ))}
        </div>

        {/* Profile — view or edit */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
          <Label>Profile</Label>
          {!editing && <button onClick={() => setEditing(true)} style={{ background: "none", border: "none", color: T.greenDeep, fontSize: "10px", fontWeight: 700, cursor: "pointer", fontFamily: syne }}>edit</button>}
        </div>
        {editing ? (
          <div style={{ marginBottom: "16px" }}>
            <input placeholder="Channel name" value={f.channel_name} onChange={e => set("channel_name", e.target.value)} style={input} />
            <input placeholder="Subscriber count" value={f.subscriber_count} onChange={e => set("subscriber_count", e.target.value)} style={input} />
            <input placeholder="Niche" value={f.niche} onChange={e => set("niche", e.target.value)} style={input} />
            <input placeholder="Engagement rate % (optional)" value={f.engagement_rate} onChange={e => set("engagement_rate", e.target.value)} style={input} />
            <textarea placeholder="Channel description" value={f.description} onChange={e => set("description", e.target.value)} style={{ ...input, minHeight: "56px", resize: "vertical" }} />
            <div style={{ display: "flex", gap: "8px" }}>
              <Btn primary onClick={saveEdit} style={{ flex: 1, padding: "9px" }}>Save</Btn>
              <Btn onClick={() => setEditing(false)} style={{ padding: "9px 16px" }}>Cancel</Btn>
            </div>
          </div>
        ) : (
          <div style={{ ...box, marginBottom: "16px" }}>
            {[creator.niche && `Niche: ${creator.niche}`, creator.engagement_rate != null && `Engagement: ${(creator.engagement_rate * 100).toFixed(1)}%`, creator.description].filter(Boolean).join("\n") || "No profile details yet — hit edit."}
          </div>
        )}

        {/* Collab pitch — the "Drafted" stage's actual draft */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
          <Label>Collab pitch</Label>
          <button onClick={draftPitch} disabled={drafting} style={{ background: "none", border: "none", color: drafting ? T.faint : T.greenDeep, fontSize: "10px", fontWeight: 700, cursor: drafting ? "default" : "pointer", fontFamily: syne }}>
            {drafting ? "✦ drafting…" : pitch ? "↻ redraft" : "✦ draft with AI"}
          </button>
        </div>
        {pitch ? (
          <div style={{ marginBottom: "6px" }}>
            {/* Edits stay local per keystroke; persistence happens on blur. */}
            <input value={pitch.subject} onChange={e => setPitch(p => ({ ...p, subject: e.target.value }))} onBlur={() => savePitch(pitch)} style={{ ...input, fontWeight: 600 }} />
            <textarea value={pitch.body} onChange={e => setPitch(p => ({ ...p, body: e.target.value }))} onBlur={() => savePitch(pitch)} rows={7} style={{ ...input, resize: "vertical", lineHeight: 1.6, marginBottom: "8px" }} />
            <Btn onClick={copyPitch} style={{ padding: "8px 16px" }}>Copy pitch</Btn>
          </div>
        ) : (
          <div style={{ ...box, color: T.faint }}>No pitch yet. "Draft with AI" writes a first-touch collab email grounded in their niche and the ZTS voice — drafting also moves them to Drafted.</div>
        )}
      </div>

      <div style={{ padding: `13px ${hPad}`, borderTop: `1px solid ${T.line}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        {!confirmDel ? (
          <button onClick={() => setConfirmDel(true)} style={{ background: "none", border: "none", color: T.faint, fontSize: "11px", cursor: "pointer", fontWeight: 600 }}>Delete</button>
        ) : (
          <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "11px", color: T.red }}>Delete {creator.channel_name}?</span>
            <button onClick={() => onDelete(creator.id)} style={{ padding: "5px 12px", background: T.red, border: "none", borderRadius: "7px", color: "#FFF", fontSize: "10px", fontWeight: 700, cursor: "pointer", fontFamily: syne }}>Yes, delete</button>
            <button onClick={() => setConfirmDel(false)} style={{ background: "none", border: "none", color: T.faint, fontSize: "11px", cursor: "pointer" }}>Keep</button>
          </span>
        )}
        <Btn onClick={onClose} style={{ padding: "9px 18px" }}>Done</Btn>
      </div>
    </ModalShell>
  );
}

function AddCreatorModal({ onClose, onAdd, isMobile }) {
  const [f, setF] = useState({ channel_name: "", subscriber_count: "", niche: "", description: "", engagement_rate: "" });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const submit = () => { if (!f.channel_name) return; onAdd({ ...f, subscriber_count: Number(f.subscriber_count) || 0, engagement_rate: f.engagement_rate ? Number(f.engagement_rate) / 100 : null }); };
  const v = f.channel_name ? creatorValue({ ...f, subscriber_count: Number(f.subscriber_count) || 0 }) : null;
  const input = { width: "100%", padding: "10px 12px", border: `1px solid ${T.line}`, borderRadius: "9px", fontSize: "13px", color: T.ink, marginBottom: "10px" };
  return (
    <ModalShell onClose={onClose} isMobile={isMobile} width={480}>
      <div style={{ padding: isMobile ? "14px 18px calc(18px + var(--safe-bottom))" : "26px 28px", overflowY: "auto" }}>
        <div style={{ fontSize: "16px", fontWeight: 700, color: T.ink, fontFamily: syne, marginBottom: "18px" }}>Add Creator</div>
        <input placeholder="Channel name" value={f.channel_name} onChange={e => set("channel_name", e.target.value)} style={input} />
        <input placeholder="Subscriber count (e.g. 45000)" value={f.subscriber_count} onChange={e => set("subscriber_count", e.target.value)} style={input} />
        <input placeholder="Niche (e.g. Bitcoin self-custody)" value={f.niche} onChange={e => set("niche", e.target.value)} style={input} />
        <input placeholder="Engagement rate % (optional, e.g. 5)" value={f.engagement_rate} onChange={e => set("engagement_rate", e.target.value)} style={input} />
        <textarea placeholder="Channel description (helps fit scoring)" value={f.description} onChange={e => set("description", e.target.value)} style={{ ...input, minHeight: "60px", resize: "vertical" }} />
        {v && <div style={{ fontSize: "11px", color: T.sub, marginBottom: "14px", padding: "8px 12px", background: "rgba(14,159,110,0.06)", borderRadius: "8px" }}>Fit: <strong style={{ color: T.greenDeep }}>{v.tier}</strong> · {v.fitLabel} · weighted reach {fmtSubs(v.score)}</div>}
        <div style={{ display: "flex", gap: "8px" }}>
          <Btn primary onClick={submit} style={{ flex: 1, padding: "11px" }}>Add to pipeline</Btn>
          <Btn onClick={onClose} style={{ padding: "11px 18px" }}>Cancel</Btn>
        </div>
      </div>
    </ModalShell>
  );
}
// ─── AGENT ENGINE (headless) ─────────────────────────────────────────────────
function AgentEngine({ creators, shorts, articles, onArticleDraft }) {
  const cRef = useRef(creators), sRef = useRef(shorts), aRef = useRef(articles);
  useEffect(() => { cRef.current = creators; }, [creators]);
  useEffect(() => { sRef.current = shorts; }, [shorts]);
  useEffect(() => { aRef.current = articles; }, [articles]);
  useEffect(() => {
    const onAct = () => markActivity();
    window.addEventListener("mousemove", onAct, { passive: true });
    window.addEventListener("keydown", onAct, { passive: true });
    markActivity();
    let lastWork = 0;
    const poll = setInterval(async () => {
      const ctrl = eng.get();
      if (!ctrl.running) return;
      if (ctrl.pauseWhenIdle && isIdle(ctrl.idleMin)) { eng.set({ running: false }); kb.add([{ agent: "system", type: "system", signal: "info", text: "Auto-paused — no activity detected." }]); return; }
      const now = Date.now();
      const forced = sm.get("engine_force_pass");
      if (!forced && now - lastWork < ctrl.cadenceSec * 1000) return;
      if (forced) sm.del("engine_force_pass");
      lastWork = now;
      sm.set("engine_pass_count", (sm.get("engine_pass_count") || 0) + 1);
      const ctx = { creators: cRef.current || [], shorts: sRef.current || [], articles: aRef.current || [], obsLogs: obs.getAll() };
      let newObs = [];
      Object.entries(HEURISTIC_AGENTS).forEach(([k, a]) => { if (ctrl.agents[k] === false) return; try { newObs = newObs.concat(a.scan(ctx) || []); } catch {} });
      const added = kb.add(newObs);
      sm.set("engine_last_tick", now);
      if (added > 0) sm.set("engine_obs_since_synth", (sm.get("engine_obs_since_synth") || 0) + added);
      if (forced && added === 0) kb.add([{ agent: "system", type: "system", signal: "info", text: `Manual pass #${sm.get("engine_pass_count")} — scanned ${ctx.creators.length} creators + ${ctx.shorts.length} Shorts, nothing new to flag.` }]);
      // ── SEO auto-draft: agent-initiated, approval-gated. Runs only when the
      //    toggle is on, the cadence has elapsed, spend is allowed, and we're
      //    under the cost cap. The draft lands in "In Review" — never published.
      if (ctrl.seoAutoDraft && !ctrl.observeOnly && engineSpendThisHour() < ctrl.hourlyCostCap) {
        const lastDraft = sm.get("seo_last_autodraft") || 0;
        if (now - lastDraft > (ctrl.seoEveryDays || 4) * 86400000) {
          sm.set("seo_last_autodraft", now); // set BEFORE the call so a slow call can't double-fire
          const kws = (sm.get("seo_keywords") || "").split("\n").map(k => k.trim()).filter(Boolean);
          const covered = new Set((aRef.current || []).map(a => (a.target_keyword || a.keyword || "").toLowerCase()));
          const kw = kws.find(k => !covered.has(k.toLowerCase())) || null;
          const pkg = await generateArticle({ keyword: kw });
          if (pkg && onArticleDraft) {
            onArticleDraft({ id: `a_${Date.now()}`, created_at: new Date().toISOString(), stage: "review", auto_drafted: true, keyword: kw, ...pkg });
            kb.add([{ agent: "seoCadence", type: "observation", signal: "info", text: `Drafted a new article for review: "${pkg.title_tag}" (${pkg.target_keyword}). Approve or reject it in the SEO tab.` }]);
          }
        }
      }

      if (ctrl.observeOnly) return;
      if ((sm.get("engine_obs_since_synth") || 0) < 3) return;
      if (now - (sm.get("engine_last_synth_ts") || 0) < ctrl.synthEveryMin * 60000) return;
      const hash = stateHash(ctx.creators, ctx.shorts);
      if (hash === sm.get("engine_last_synth_hash")) return;
      if (engineSpendThisHour() >= ctrl.hourlyCostCap) { eng.set({ observeOnly: true }); kb.add([{ agent: "system", type: "system", signal: "warning", text: `Hourly cost cap reached — dropped to observe-only.` }]); return; }
      const recent = kb.all().filter(e => e.type === "observation" || e.type === "learning").slice(0, 12);
      const insight = await synthesizeInsight(recent, ctrl.allowSonnet);
      sm.set("engine_last_synth_ts", now); sm.set("engine_last_synth_hash", hash); sm.set("engine_obs_since_synth", 0);
      if (insight) kb.add([{ agent: "synthesizer", type: "insight", signal: "info", text: insight }]);
    }, 2000);
    return () => { clearInterval(poll); window.removeEventListener("mousemove", onAct); window.removeEventListener("keydown", onAct); };
  }, []);
  return null;
}

// ─── AGENTS VIEW (control panel + feed) ──────────────────────────────────────
function AgentsView({ isMobile }) {
  const [ctrl, setCtrl] = useState(() => eng.get());
  const [feed, setFeed] = useState(() => kb.all());
  const [passFlash, setPassFlash] = useState(false);
  useEffect(() => { const iv = setInterval(() => { setCtrl(eng.get()); setFeed(kb.all()); }, 1500); return () => clearInterval(iv); }, []);
  const update = (p) => { eng.set(p); setCtrl(eng.get()); };
  const runOnce = () => { sm.set("engine_force_pass", true); eng.set({ running: true }); setCtrl(eng.get()); setPassFlash(true); setTimeout(() => setPassFlash(false), 2500); };
  const ago = (ts) => { if (!ts) return "never"; const m = Math.floor((Date.now() - ts) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m/60)}h ago`; };
  const SEVC = { critical: T.red, warning: T.amber, info: T.blue, system: T.faint };

  const Toggle = ({ on, onClick, label, sub }) => (
    <div onClick={onClick} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px", background: T.card, border: `1px solid ${T.line}`, borderRadius: "10px", cursor: "pointer" }}>
      <div><div style={{ fontSize: "12px", fontWeight: 600, color: T.ink }}>{label}</div>{sub && <div style={{ fontSize: "10px", color: T.faint, marginTop: "1px" }}>{sub}</div>}</div>
      <div style={{ width: "38px", height: "22px", borderRadius: "12px", background: on ? T.green : "rgba(255,255,255,0.14)", position: "relative", flexShrink: 0, transition: "background 0.15s" }}><div style={{ position: "absolute", top: "2px", left: on ? "18px" : "2px", width: "18px", height: "18px", borderRadius: "50%", background: "#FFF", transition: "left 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} /></div>
    </div>
  );
  const agentMeta = [["creatorScout","Creator Scout","Prime-fit creators un-contacted"],["production","Production Watcher","Shorts stuck or unscheduled"],["cadence","Cadence Monitor","Posting gaps"],["reply","Reply Sentinel","Creator replies waiting"],["pattern","Pattern Learner","Which Short types you produce"],["cost","Cost Sentinel","AI spend guardrail"]];

  return (
    <div style={{ minHeight: "calc(100vh - 52px)", padding: viewPad(isMobile) }}>
      <div style={{ marginBottom: "20px" }}>
        <div style={{ fontSize: "18px", fontWeight: 700, color: T.ink, fontFamily: syne }}>Agent Engine</div>
        <div style={{ fontSize: "12px", color: T.faint, marginTop: "2px" }}>A living roster watching creators + studio on a free heartbeat, spending tokens only when it's worth it.</div>
      </div>
      <div style={{ background: ctrl.running ? T.navyGrad : T.card, border: ctrl.running ? "none" : `1px solid ${T.line}`, borderRadius: "16px", padding: isMobile ? "16px 18px" : "18px 22px", marginBottom: "16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap", boxShadow: T.cardShadow }}>
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <button onClick={() => update({ running: !ctrl.running })} style={{ width: "52px", height: "52px", borderRadius: "50%", border: "none", background: ctrl.running ? T.green : T.navy, color: "#FFF", fontSize: "20px", cursor: "pointer", flexShrink: 0 }}>{ctrl.running ? "⏸" : "▶"}</button>
          <div>
            <div style={{ fontSize: "14px", fontWeight: 700, color: ctrl.running ? "#FFF" : T.ink, fontFamily: syne }}>{ctrl.running ? "Running" : "Paused"}</div>
            <div style={{ fontSize: "11px", color: ctrl.running ? "#94A8C9" : T.faint, marginTop: "2px" }}>{ctrl.observeOnly ? "Observe-only · $0 spend" : "Synthesis on"} · heartbeat {ctrl.cadenceSec}s</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
          <div style={{ textAlign: "right" }}><div style={{ fontSize: "9px", fontWeight: 700, color: ctrl.running ? "#7C93C9" : T.faint, textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: syne }}>Passes</div><div style={{ fontSize: "13px", color: passFlash ? "#34D399" : ctrl.running ? "#E8EDF7" : T.sub, fontFamily: mono, fontWeight: passFlash ? 700 : 400 }}>{sm.get("engine_pass_count") || 0}{passFlash ? " ✓" : ""}</div></div>
          <button onClick={runOnce} style={{ padding: "9px 14px", background: ctrl.running ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.05)", border: ctrl.running ? "1px solid rgba(255,255,255,0.2)" : `1px solid ${T.line}`, borderRadius: "9px", color: ctrl.running ? "#E8EDF7" : T.sub, fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: syne }}>⚡ Run pass now</button>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "300px 1fr", gap: "16px", alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <Label style={{ marginBottom: "2px" }}>Token Controls</Label>
          <Toggle on={ctrl.observeOnly} onClick={() => update({ observeOnly: !ctrl.observeOnly })} label="Observe-only" sub="Heuristics only — never spend tokens" />
          <Toggle on={ctrl.allowSonnet} onClick={() => update({ allowSonnet: !ctrl.allowSonnet })} label="Allow Sonnet" sub="Off = synthesis stays on Haiku" />
          <Toggle on={ctrl.pauseWhenIdle} onClick={() => update({ pauseWhenIdle: !ctrl.pauseWhenIdle })} label="Pause when idle" sub={`Auto-stop after ${ctrl.idleMin}m away`} />
          <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: "10px", padding: "12px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}><span style={{ fontSize: "12px", fontWeight: 600, color: T.ink }}>Heartbeat</span><span style={{ fontSize: "12px", color: T.sub, fontFamily: mono }}>{ctrl.cadenceSec}s</span></div>
            <input type="range" min="10" max="120" step="5" value={ctrl.cadenceSec} onChange={e => update({ cadenceSec: Number(e.target.value) })} style={{ width: "100%", accentColor: T.green }} />
          </div>
          <Label style={{ margin: "8px 0 2px" }}>Roster</Label>
          {agentMeta.map(([k, name, sub]) => <Toggle key={k} on={ctrl.agents[k] !== false} onClick={() => { eng.setAgent(k, !(ctrl.agents[k] !== false)); setCtrl(eng.get()); }} label={name} sub={sub} />)}
        </div>
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}><Label>Knowledge & Ideas ({feed.length})</Label>{feed.length > 0 && <button onClick={() => { kb.clear(); setFeed([]); }} style={{ background: "none", border: "none", color: T.faint, fontSize: "11px", cursor: "pointer", fontWeight: 600 }}>Clear</button>}</div>
          {feed.length === 0 ? (
            <EmptyState icon="radar" title="Nothing observed yet" sub="Press play — the roster starts watching your creators and Shorts at zero token cost." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {feed.map(e => { const col = SEVC[e.signal] || T.faint; const ins = e.type === "insight"; return (
                <div key={e.id} style={{ background: ins ? "linear-gradient(135deg, rgba(245,184,77,0.16) 0%, rgba(245,184,77,0.05) 100%)" : T.card, borderRadius: "11px", border: ins ? `1px solid ${T.accentLine}` : `1px solid ${T.line}`, borderLeft: `3px solid ${ins ? T.amber : col}`, padding: "13px 15px", display: "flex", gap: "12px" }}>
                  <span style={{ fontSize: "9px", fontWeight: 700, color: ins ? T.amberDeep : col, textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: syne, flexShrink: 0, marginTop: "2px", minWidth: "56px" }}>{ins ? "✦ Insight" : e.type === "learning" ? "Learned" : e.type === "system" ? "System" : "Observed"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: "12px", color: T.ink, lineHeight: 1.55, fontWeight: ins ? 600 : 400 }}>{e.text}</div><div style={{ fontSize: "9px", color: T.faint, marginTop: "4px", fontFamily: mono }}>{e.agent} · {ago(new Date(e.ts).getTime())}</div></div>
                </div>
              ); })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
// ─── SEO VIEW — article pipeline with approval gate ──────────────────────────
function SeoView({ articles, setArticles, onAddArticle, isMobile, loading, openSignal = 0, onSignalConsumed }) {
  const [composing, setComposing] = useState(false);
  const [openArticle, setOpenArticle] = useState(null);
  const [keywords, setKeywords] = useState(() => sm.get("seo_keywords") || "");
  const [autoDraft, setAutoDraft] = useState(() => eng.get().seoAutoDraft || false);
  const [everyDays, setEveryDays] = useState(() => eng.get().seoEveryDays || 4);
  const toast = useToast();

  // Palette handoff: "New Article" from ⌘K opens the composer, even if SEO
  // was already the active view. Consuming clears the signal in App.
  useEffect(() => { if (openSignal > 0) { setComposing(true); onSignalConsumed?.(); } }, [openSignal, onSignalConsumed]);

  const update = async (id, patch) => {
    setArticles(prev => prev.map(a => a.id === id ? { ...a, ...patch } : a)); // optimistic
    if (openArticle?.id === id) setOpenArticle(prev => ({ ...prev, ...patch }));
    if (!supabase) return;
    const { error: err } = await supabase.from("articles").update(patch).eq("id", id);
    if (err) { console.warn("[SeoView] update failed:", err.message); toast.push("Change didn't save — " + err.message, { tone: "error" }); }
  };
  const byStage = (k) => articles.filter(a => (a.stage || "idea") === k);
  const lastAuto = sm.get("seo_last_autodraft");
  const nextAuto = autoDraft && lastAuto ? new Date(lastAuto + everyDays * 86400000) : null;

  return (
    <div style={{ minHeight: "calc(100vh - 52px)", padding: viewPad(isMobile) }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <div style={{ fontSize: "18px", fontWeight: 700, color: T.ink, fontFamily: syne }}>SEO</div>
          <div style={{ fontSize: "12px", color: T.faint, marginTop: "2px" }}>The agent drafts search content on a cadence — nothing publishes without your approval.</div>
        </div>
        <Btn primary onClick={() => setComposing(true)}>✦ New Article</Btn>
      </div>

      {/* Auto-draft cadence + keyword panel */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: isMobile ? "10px" : "14px", marginBottom: "18px" }}>
        <Card>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
            <Label>Auto-draft cadence</Label>
            <div onClick={() => { const on = !autoDraft; setAutoDraft(on); eng.set({ seoAutoDraft: on }); }} style={{ width: "38px", height: "22px", borderRadius: "12px", background: autoDraft ? T.green : "rgba(255,255,255,0.14)", position: "relative", cursor: "pointer", transition: "background 0.15s" }}>
              <div style={{ position: "absolute", top: "2px", left: autoDraft ? "18px" : "2px", width: "18px", height: "18px", borderRadius: "50%", background: "#FFF", transition: "left 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
            </div>
          </div>
          <div style={{ fontSize: "12px", color: T.sub, lineHeight: 1.5, marginBottom: "10px" }}>{autoDraft ? "The engine drafts a new article into In Review" : "Off — articles only generate when you click New Article"}{autoDraft && <> every <strong>{everyDays}</strong> days. It targets your keyword list first, then ZTS topic clusters.</>}</div>
          {autoDraft && (
            <>
              <input type="range" min="2" max="7" step="1" value={everyDays} onChange={e => { const v = Number(e.target.value); setEveryDays(v); eng.set({ seoEveryDays: v }); }} style={{ width: "100%", accentColor: T.green }} />
              <div style={{ fontSize: "10px", color: T.faint, marginTop: "6px" }}>{everyDays <= 3 ? "≈ twice a week" : "≈ once a week"}{nextAuto ? ` · next draft ~${nextAuto.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}` : " · first draft on next engine pass"}</div>
            </>
          )}
        </Card>
        <Card>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
            <Label>Target keywords</Label>
            <span style={{ fontSize: "9px", color: T.faint, fontWeight: 600 }}>paste from Search Console — GSC sync coming in phase 2</span>
          </div>
          <textarea value={keywords} onChange={e => { setKeywords(e.target.value); sm.set("seo_keywords", e.target.value); }} placeholder={"one keyword per line, e.g.\nmetal seed phrase backup\nbitcoin inheritance planning"} style={{ width: "100%", minHeight: "76px", padding: "10px 12px", border: `1px solid ${T.line}`, borderRadius: "9px", fontSize: "12px", color: T.ink, resize: "vertical", lineHeight: 1.6, fontFamily: mono }} />
        </Card>
      </div>

      {/* Pipeline board */}
      {loading ? (
        <SkeletonBoard cols={4} />
      ) : articles.length === 0 ? (
        <EmptyState icon="doc" title="No articles yet"
          sub="Generate your first SEO article, or flip on auto-draft and let the agent queue them for your review."
          action={<Btn primary onClick={() => setComposing(true)}>✦ Draft the first article</Btn>} />
      ) : (
        <div style={kanbanWrapStyle(isMobile, 4)}>
          {ARTICLE_STAGES.map(stage => {
            const items = byStage(stage.key);
            return (
              <div key={stage.key} style={kanbanColStyle(isMobile)}>
                <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "10px", padding: "0 2px" }}>
                  <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: stage.color }} />
                  <span style={{ fontSize: "11px", fontWeight: 700, color: T.ink, fontFamily: syne }}>{stage.label}</span>
                  <span style={{ fontSize: "11px", color: T.faint, fontFamily: mono }}>{items.length}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {items.map((a, idx) => (
                    <div key={a.id} style={{ animation: `cardIn 0.3s ${M.easeOut} both`, animationDelay: `${Math.min(idx, 8) * 30}ms` }}>
                    <Card hover onClick={() => setOpenArticle(a)} style={{ padding: "12px 13px", borderLeft: `3px solid ${stage.color}` }}>
                      {a.auto_drafted && <div style={{ display: "inline-block", fontSize: "8px", fontWeight: 700, color: T.greenDeep, background: "rgba(14,159,110,0.1)", padding: "2px 6px", borderRadius: "5px", textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: syne, marginBottom: "6px" }}>Agent draft</div>}
                      <div style={{ fontSize: "12px", fontWeight: 600, color: T.ink, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{a.title_tag || a.keyword || "Untitled"}</div>
                      {a.target_keyword && <div style={{ fontSize: "10px", color: T.faint, marginTop: "4px", fontFamily: mono }}>{a.target_keyword}{a.word_count ? ` · ${a.word_count}w` : ""}</div>}
                      {/* Arrows stop at Approved — actually publishing to Shopify
                          stays behind the explicit button in the detail modal.
                          Published articles are frozen: stepping one back would
                          leave a stale published_url and invite a duplicate
                          publish (publishToShopify always creates a new post). */}
                      <StageStepper stages={ARTICLE_STAGES} current={stage.key}
                        blockForward={stage.key === "approved" || stage.key === "published"}
                        blockBack={stage.key === "published"}
                        forwardTitle={stage.key === "approved" ? "Publishing happens in the article view — open it and hit Publish" : undefined}
                        onMove={(next) => update(a.id, { stage: next, ...(next === "approved" ? { approved_at: new Date().toISOString() } : {}) })} />
                    </Card>
                    </div>
                  ))}
                  {items.length === 0 && <EmptyState compact icon="inbox" tint={T.faint} title="Nothing here" />}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {composing && <ComposeArticleModal keywords={keywords} isMobile={isMobile} onClose={() => setComposing(false)} onCreate={async (a) => { await onAddArticle(a); setComposing(false); }} />}
      {openArticle && <ArticleDetail article={openArticle} isMobile={isMobile} onClose={() => setOpenArticle(null)} onUpdate={update} onDelete={async (id) => {
        setArticles(prev => prev.filter(a => a.id !== id)); // optimistic
        setOpenArticle(null);
        if (!supabase) return;
        const { error: err } = await supabase.from("articles").delete().eq("id", id);
        if (err) { console.warn("[SeoView] delete failed:", err.message); toast.push("Delete didn't stick — " + err.message, { tone: "error" }); }
      }} />}
    </div>
  );
}

function ComposeArticleModal({ keywords, onClose, onCreate, isMobile }) {
  const kwList = (keywords || "").split("\n").map(k => k.trim()).filter(Boolean);
  const [keyword, setKeyword] = useState(kwList[0] || "");
  const [notes, setNotes] = useState("");
  const [gen, setGen] = useState(false);
  const toast = useToast();
  const create = async () => {
    setGen(true);
    const pkg = await generateArticle({ keyword, notes });
    setGen(false);
    if (pkg) { onCreate({ keyword, stage: "review", ...pkg }); toast.push(`Article drafted into review: "${pkg.title_tag}"`, { tone: "success" }); }
    else { onCreate({ keyword, stage: "idea" }); toast.push("Drafting didn't complete — saved as an idea. Open it to retry.", { tone: "warning" }); }
  };
  return (
    <ModalShell onClose={onClose} isMobile={isMobile} width={520}>
      <div style={{ padding: isMobile ? "14px 18px calc(18px + var(--safe-bottom))" : "26px 28px", overflowY: "auto" }}>
        <div style={{ fontSize: "16px", fontWeight: 700, color: T.ink, fontFamily: syne, marginBottom: "4px" }}>New Article</div>
        <div style={{ fontSize: "12px", color: T.faint, marginBottom: "18px" }}>Claude drafts the full package — title tag, meta, outline, article, internal links — into your review queue.</div>
        <Label style={{ marginBottom: "8px" }}>Target keyword</Label>
        {kwList.length > 0 ? (
          <select value={keyword} onChange={e => setKeyword(e.target.value)} style={{ width: "100%", padding: "10px 12px", border: `1px solid ${T.line}`, borderRadius: "9px", fontSize: "13px", color: T.ink, background: T.subtle, marginBottom: "14px" }}>
            {kwList.map((k, i) => <option key={i} value={k}>{k}</option>)}
            <option value="">— let the agent pick from ZTS clusters —</option>
          </select>
        ) : (
          <input value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="e.g. metal seed phrase backup (blank = agent picks)" style={{ width: "100%", padding: "10px 12px", border: `1px solid ${T.line}`, borderRadius: "9px", fontSize: "13px", color: T.ink, marginBottom: "14px" }} />
        )}
        <Label style={{ marginBottom: "8px" }}>Angle / notes (optional)</Label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. compare against paper backups, mention the FTX collapse" style={{ width: "100%", minHeight: "60px", padding: "10px 12px", border: `1px solid ${T.line}`, borderRadius: "9px", fontSize: "13px", color: T.ink, resize: "vertical" }} />
        <div style={{ display: "flex", gap: "8px", marginTop: "18px" }}>
          <Btn primary onClick={create} disabled={gen} style={{ flex: 1, padding: "12px" }}>{gen ? "Drafting (~30s)…" : "✦ Generate article"}</Btn>
          <Btn onClick={onClose} style={{ padding: "12px 18px" }}>Cancel</Btn>
        </div>
      </div>
    </ModalShell>
  );
}

function ArticleDetail({ article, onClose, onUpdate, onDelete, isMobile }) {
  const [publishing, setPublishing] = useState(false);
  const [pubResult, setPubResult] = useState(null);
  const [regenerating, setRegenerating] = useState(false);
  const toast = useToast();
  const stage = article.stage || "idea";
  const approve = () => onUpdate(article.id, { stage: "approved", approved_at: new Date().toISOString() });
  const reject = () => onUpdate(article.id, { stage: "idea", rejected: true });
  // Recovery path for ideas (failed generations land here with no article body).
  const regenerate = async () => {
    setRegenerating(true);
    const kw = article.target_keyword || article.keyword || "";
    const pkg = await generateArticle({ keyword: kw });
    setRegenerating(false);
    if (pkg) { onUpdate(article.id, { ...pkg, stage: "review" }); toast.push(`Draft ready for review: "${pkg.title_tag}"`, { tone: "success" }); }
    else toast.push("Drafting failed again — try in a moment.", { tone: "error" });
  };
  const publish = async () => {
    setPublishing(true);
    try {
      const res = await publishToShopify(article);
      setPubResult(res);
      onUpdate(article.id, { stage: "published", published_at: new Date().toISOString(), published_url: res.url || null });
    } catch (e) { setPubResult({ error: e.message }); }
    setPublishing(false);
  };
  const box = { background: T.subtle, border: `1px solid ${T.line}`, borderRadius: "10px", padding: "12px 14px", fontSize: "13px", color: T.ink, lineHeight: 1.6 };
  const hPad = isMobile ? "18px" : "24px";
  return (
    <ModalShell onClose={onClose} isMobile={isMobile} width={720}>
        <div style={{ padding: `18px ${hPad}`, borderBottom: `1px solid ${T.line}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexShrink: 0 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "inline-block", fontSize: "9px", fontWeight: 700, color: T.amberDeep, background: "rgba(245,158,11,0.1)", padding: "2px 7px", borderRadius: "5px", textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: syne, marginBottom: "6px" }}>{stage}{article.auto_drafted ? " · agent draft" : ""}</div>
            <div style={{ fontSize: "15px", fontWeight: 700, color: T.ink, fontFamily: syne, lineHeight: 1.3 }}>{article.title_tag || article.keyword || "Untitled"}</div>
            {article.target_keyword && <div style={{ fontSize: "11px", color: T.faint, marginTop: "3px", fontFamily: mono }}>{article.target_keyword} · {article.search_intent || "—"} · {article.word_count || "?"} words</div>}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.faint, fontSize: "20px", cursor: "pointer", lineHeight: 1, flexShrink: 0 }}>×</button>
        </div>
        <div style={{ padding: `18px ${hPad}`, overflowY: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "10px", marginBottom: "16px" }}>
            <div><Label style={{ marginBottom: "6px" }}>Title tag</Label><div style={box}>{article.title_tag || "—"}</div></div>
            <div><Label style={{ marginBottom: "6px" }}>Slug</Label><div style={{ ...box, fontFamily: mono, fontSize: "12px" }}>/{article.slug || "—"}</div></div>
          </div>
          <Label style={{ marginBottom: "6px" }}>Meta description</Label>
          <div style={{ ...box, marginBottom: "16px" }}>{article.meta_description || "—"}</div>
          {(article.internal_links || []).length > 0 && (<>
            <Label style={{ marginBottom: "6px" }}>Internal links</Label>
            <div style={{ ...box, marginBottom: "16px" }}>{article.internal_links.map((l, i) => <div key={i} style={{ fontSize: "12px" }}>"{l.anchor}" → <span style={{ fontFamily: mono, color: T.greenDeep }}>{l.target}</span></div>)}</div>
          </>)}
          <Label style={{ marginBottom: "6px" }}>Article</Label>
          <div style={{ ...box, maxHeight: isMobile ? "44vh" : "320px", overflowY: "auto" }} dangerouslySetInnerHTML={{ __html: article.article_html ? DOMPurify.sanitize(article.article_html) : "<em>No draft yet.</em>" }} />
          {pubResult && <div style={{ marginTop: "12px", padding: "10px 14px", borderRadius: "9px", fontSize: "12px", background: pubResult.error ? "rgba(220,38,38,0.07)" : "rgba(14,159,110,0.07)", color: pubResult.error ? T.red : T.greenDeep, border: `1px solid ${pubResult.error ? "rgba(220,38,38,0.2)" : "rgba(14,159,110,0.25)"}` }}>{pubResult.error ? `Publish failed: ${pubResult.error}` : pubResult.method === "clipboard" ? "Local mode — article HTML copied to clipboard. Paste into Shopify admin → Blog posts → Add." : "Published to Shopify ✓"}</div>}
        </div>
        <div style={{ padding: `14px ${hPad}`, borderTop: `1px solid ${T.line}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap", flexShrink: 0 }}>
          <button onClick={() => onDelete(article.id)} style={{ background: "none", border: "none", color: T.faint, fontSize: "11px", cursor: "pointer", fontWeight: 600 }}>Delete</button>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {stage === "idea" && <Btn primary onClick={regenerate} disabled={regenerating}>{regenerating ? "Drafting…" : "✦ Generate draft"}</Btn>}
            {stage === "review" && <><Btn onClick={reject}>✕ Reject</Btn><Btn primary onClick={approve}>✓ Approve</Btn></>}
            {stage === "approved" && <>
              <Btn onClick={() => onUpdate(article.id, { stage: "review" })} title="Send back for another look">‹ Back to review</Btn>
              <Btn primary onClick={publish} disabled={publishing}>{publishing ? "Publishing…" : "🚀 Publish to Shopify"}</Btn>
            </>}
            {stage === "published" && article.published_url && <a href={article.published_url} target="_blank" rel="noopener" style={{ fontSize: "12px", color: T.greenDeep, fontWeight: 700, textDecoration: "none", padding: "10px 16px" }}>View live ›</a>}
          </div>
        </div>
    </ModalShell>
  );
}

// ─── MISSION — command center across both pillars ────────────────────────────
function MissionView({ creators, shorts, onNavigate, isMobile, loading }) {
  const engCtrl = eng.get();
  const kbAll = kb.all();
  const cPipe = { prospected: creators.filter(c => (c.stage||"prospected") === "prospected").length, sent: creators.filter(c => c.stage === "sent").length, replied: creators.filter(c => c.stage === "replied").length, collab: creators.filter(c => c.stage === "collab").length };
  const sPipe = { wip: shorts.filter(s => ["script","assets"].includes(s.stage)).length, ready: shorts.filter(s => s.stage === "ready").length, posted: shorts.filter(s => s.stage === "posted").length };
  const totalReach = creators.filter(c => c.stage !== "rejected").reduce((s, c) => s + creatorValue(c).score, 0);
  const roster = AGENT_META.map(m => { const notes = kbAll.filter(e => e.agent === m.key); const enabled = m.key === "synthesizer" ? !engCtrl.observeOnly : engCtrl.agents[m.key] !== false; return { key: m.key, name: m.name, enabled, notes: notes.length }; });
  const recent = obs.getAll().slice(0, 6);

  const Stat = ({ label, value, sub, accent, format, onClick }) => (
    <Card onClick={onClick} hover={!!onClick}><Label style={{ marginBottom: "10px" }}>{label}</Label><div style={{ fontSize: "26px", fontWeight: 500, color: accent || T.ink, fontFamily: mono, lineHeight: 1 }}>{typeof value === "number" ? <AnimatedNumber value={value} format={format} /> : value}</div>{sub && <div style={{ fontSize: "10px", color: T.faint, marginTop: "6px" }}>{sub}</div>}</Card>
  );
  const spanMobile = isMobile ? { gridColumn: "1 / -1" } : undefined;

  if (loading) {
    return (
      <div style={{ minHeight: "calc(100vh - 52px)", padding: viewPad(isMobile) }}>
        <SkeletonLine width="240px" height="22px" style={{ marginBottom: "6px" }} />
        <SkeletonLine width="160px" height="11px" style={{ marginBottom: "22px" }} />
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: isMobile ? "10px" : "14px" }}>
          {[0,1,2,3].map(i => <SkeletonRows key={i} count={1} />)}
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "calc(100vh - 52px)", padding: viewPad(isMobile) }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "18px", flexWrap: "wrap", gap: "8px" }}>
        <div>
          <div style={{ fontSize: isMobile ? "20px" : "24px", fontWeight: 700, color: T.ink, fontFamily: syne }}>Mission</div>
          <div style={{ fontSize: "12px", color: T.faint, marginTop: "2px" }}>Zero To Secure</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: T.green, fontWeight: 600 }}><span style={{ width: "7px", height: "7px", borderRadius: "50%", background: T.green }} />Live</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: isMobile ? "10px" : "14px", marginBottom: "16px" }}>
        <Card style={spanMobile}>
          <Label style={{ marginBottom: "12px" }}>Creator Pipeline</Label>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            {[["Prospected", cPipe.prospected, T.faint], ["Sent", cPipe.sent, T.blue], ["Replied", cPipe.replied, "#EC4899"], ["Collab", cPipe.collab, T.green]].map(([l, v, c], i) => (
              <div key={i} style={{ textAlign: "center" }}><div style={{ fontSize: "22px", fontWeight: 500, color: c, fontFamily: mono, lineHeight: 1 }}><AnimatedNumber value={v} /></div><div style={{ fontSize: "9px", color: T.faint, marginTop: "5px", textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: syne, fontWeight: 700 }}>{l}</div></div>
            ))}
          </div>
          <div style={{ fontSize: "10px", color: T.faint, marginTop: "12px", textAlign: "center" }}><span style={{ color: T.green, fontWeight: 600 }}>{fmtSubs(totalReach)} weighted reach</span> in pipeline</div>
        </Card>
        <Card style={spanMobile}>
          <Label style={{ marginBottom: "12px" }}>Shorts Studio</Label>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            {[["In Production", sPipe.wip, T.amber], ["Ready", sPipe.ready, T.green], ["Posted", sPipe.posted, T.purple]].map(([l, v, c], i) => (
              <div key={i} style={{ textAlign: "center" }}><div style={{ fontSize: "22px", fontWeight: 500, color: c, fontFamily: mono, lineHeight: 1 }}><AnimatedNumber value={v} /></div><div style={{ fontSize: "9px", color: T.faint, marginTop: "5px", textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: syne, fontWeight: 700 }}>{l}</div></div>
            ))}
          </div>
          <div style={{ fontSize: "10px", color: T.amberDeep, marginTop: "12px", textAlign: "center", cursor: "pointer", fontWeight: 600 }} onClick={() => onNavigate("studio")}>Open Studio ›</div>
        </Card>
        <Stat label="Ready to Post" value={sPipe.ready} sub={sPipe.ready > 0 ? "get them scheduled" : "none queued"} accent={sPipe.ready > 0 ? T.green : T.ink} onClick={() => onNavigate("studio")} />
        <Stat label="AI Spend" value={obs.getAll().reduce((s,l) => s + (l.costEstimate||0), 0)} format={(n) => `$${n.toFixed(2)}`} sub={`${obs.getAll().length} calls`} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: isMobile ? "12px" : "16px" }}>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}><Label>Agent Roster</Label><span style={{ fontSize: "10px", color: T.faint, fontWeight: 700 }}>Controls in System ›</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            {roster.map((a, i) => { const active = a.enabled && engCtrl.running; return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: "9px", padding: "9px 11px", background: T.subtle, borderRadius: "9px", border: `1px solid ${T.line}` }}>
                <span style={{ width: "7px", height: "7px", borderRadius: "50%", flexShrink: 0, background: active ? T.green : a.enabled ? T.faint : T.ghost }} />
                <div style={{ minWidth: 0 }}><div style={{ fontSize: "11px", fontWeight: 700, color: T.ink, fontFamily: syne, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</div><div style={{ fontSize: "9px", color: T.faint }}>{a.notes > 0 ? `${a.notes} note${a.notes!==1?"s":""}` : a.enabled ? "ready" : "off"}</div></div>
              </div>
            ); })}
          </div>
        </Card>
        <Card>
          <Label style={{ marginBottom: "14px" }}>Recent Activity</Label>
          {recent.length === 0 ? <EmptyState compact dashed={false} icon="spark" tint={T.faint} title="No AI activity yet" sub="Generate a Short or run an engine pass — calls land here." /> : (
            <div style={{ display: "flex", flexDirection: "column", gap: "9px" }}>
              {recent.map((l, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "9px" }}>
                  <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: l.ok === false ? T.red : T.green, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: "11px", color: T.ink, fontWeight: 600 }}>{({ generate_short: "Generated a Short", regen_asset: "Regenerated asset", agent_synthesis: "Engine synthesis" })[l.fn] || l.fn}</div></div>
                  <span style={{ fontSize: "10px", color: T.faint, fontFamily: mono }}>${(l.costEstimate||0).toFixed(4)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ─── OPS — observability ─────────────────────────────────────────────────────
function OpsView({ isMobile }) {
  const [logs, setLogs] = useState(obs.getAll());
  const testLog = () => { const models = ["claude-haiku-4-5-20251001","claude-sonnet-4-6"]; const m = models[Math.floor(Math.random()*2)]; const i = 800 + Math.floor(Math.random()*3000), o = 200 + Math.floor(Math.random()*1200); obs.log({ fn: ["generate_short","regen_asset","agent_synthesis"][Math.floor(Math.random()*3)], model: m, inputTokens: i, outputTokens: o, costEstimate: estimateCost(m,i,o), latencyMs: 600+Math.floor(Math.random()*5000), ok: Math.random()>0.08 }); setLogs(obs.getAll()); };
  const total = logs.reduce((s,l) => s + (l.costEstimate||0), 0);
  const ok = logs.filter(l => l.ok !== false).length;
  return (
    <div style={{ minHeight: "calc(100vh - 52px)", padding: viewPad(isMobile) }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px", flexWrap: "wrap", gap: "10px" }}>
        <div><div style={{ fontSize: "18px", fontWeight: 700, color: T.ink, fontFamily: syne }}>Observability</div><div style={{ fontSize: "12px", color: T.faint, marginTop: "2px" }}>Every Claude call — tokens, cost, latency, success.</div></div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}><Btn primary onClick={testLog}>+ Test log</Btn><Btn onClick={() => setLogs(obs.getAll())}>↻ Refresh</Btn><Btn onClick={() => { obs.clear(); setLogs([]); }}>Clear</Btn><Btn onClick={() => supabase?.auth.signOut()}>Sign out</Btn></div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: isMobile ? "10px" : "14px", marginBottom: "16px" }}>
        {[
          ["Total Calls", logs.length, (n) => String(Math.round(n))],
          ["Est. Cost", total, (n) => `$${n.toFixed(3)}`],
          ["Success", logs.length ? Math.round(ok/logs.length*100) : null, (n) => n == null ? "—" : `${Math.round(n)}%`],
          ["Avg Latency", logs.length ? Math.round(logs.reduce((s,l)=>s+(l.latencyMs||0),0)/logs.length) : null, (n) => n == null ? "—" : `${Math.round(n)}ms`],
        ].map(([l, v, f], i) => (
          <Card key={i}><Label style={{ marginBottom: "10px" }}>{l}</Label><div style={{ fontSize: "24px", fontWeight: 500, color: T.ink, fontFamily: mono }}>{v == null ? "—" : <AnimatedNumber value={v} format={f} />}</div></Card>
        ))}
      </div>
      <Card>
        <Label style={{ marginBottom: "12px" }}>Run Log</Label>
        {logs.length === 0 ? <EmptyState compact icon="chart" title="No calls logged yet" sub={'Hit "Test log" to verify tracking works — every Claude call shows up here.'} /> : (
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {logs.slice(0, 30).map((l, i) => isMobile ? (
              <div key={i} style={{ padding: "9px 2px", borderBottom: i < 29 ? `1px solid ${T.line}` : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
                  <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: l.ok === false ? T.red : T.green, flexShrink: 0 }} />
                  <span style={{ fontSize: "12px", color: T.ink, fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.fn}</span>
                  <span style={{ fontSize: "11px", color: T.ink, fontFamily: mono, flexShrink: 0 }}>${(l.costEstimate||0).toFixed(4)}</span>
                </div>
                <div style={{ fontSize: "10px", color: T.faint, fontFamily: mono, marginTop: "3px", paddingLeft: "15px" }}>{l.model?.includes("sonnet") ? "Sonnet" : "Haiku"} · {l.latencyMs}ms</div>
              </div>
            ) : (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "9px 4px", borderBottom: i < 29 ? `1px solid ${T.line}` : "none" }}>
                <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: l.ok === false ? T.red : T.green, flexShrink: 0 }} />
                <span style={{ fontSize: "12px", color: T.ink, fontWeight: 600, flex: 1 }}>{l.fn}</span>
                <span style={{ fontSize: "10px", color: T.faint, fontFamily: mono }}>{l.model?.includes("sonnet") ? "Sonnet" : "Haiku"}</span>
                <span style={{ fontSize: "11px", color: T.sub, fontFamily: mono }}>{l.latencyMs}ms</span>
                <span style={{ fontSize: "11px", color: T.ink, fontFamily: mono, minWidth: "60px", textAlign: "right" }}>${(l.costEstimate||0).toFixed(4)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── APP SHELL ───────────────────────────────────────────────────────────────
function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("password");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [sent, setSent] = useState(false);
  const inputStyle = { width: "100%", padding: "11px 13px", fontSize: 13, border: `1px solid ${T.line}`, borderRadius: 9, background: T.subtle, color: T.ink, outline: "none", boxSizing: "border-box" };

  if (!supabase) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, color: T.ink, background: "#0B0F1A" }}>
        <div style={{ width: 380, maxWidth: "94vw", padding: "24px 26px", background: T.card, border: `1px solid ${T.line}`, borderRadius: 16, boxShadow: T.cardShadow }}>
          <div style={{ fontSize: 13, fontWeight: 700, fontFamily: syne, marginBottom: 8 }}>Supabase isn't configured yet</div>
          <div style={{ fontSize: 12, color: T.sub, lineHeight: 1.6 }}>Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then redeploy — sign-in needs a real Supabase project to check against.</div>
        </div>
      </div>
    );
  }

  const signIn = async () => {
    setBusy(true); setErr(null);
    const { error: err0 } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (err0) setErr(err0.message);
    setBusy(false);
  };
  const sendMagic = async () => {
    setBusy(true); setErr(null);
    const { error: err0 } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: window.location.origin } });
    if (err0) setErr(err0.message); else setSent(true);
    setBusy(false);
  };
  const disabled = busy || !email || (mode === "password" && !password);

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "#0B0F1A" }}>
      <div style={{ width: 380, maxWidth: "94vw", padding: "30px 32px", background: T.card, border: `1px solid ${T.line}`, borderRadius: 18, boxShadow: "0 32px 80px rgba(0,0,0,0.55), 0 8px 24px rgba(0,0,0,0.4)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 6 }}>
          <span style={{ width: 20, height: 20, borderRadius: 6, background: `linear-gradient(135deg, ${T.amberDeep} 0%, #A87C2E 100%)`, boxShadow: "0 2px 6px rgba(184,145,58,0.4)" }} />
          <span style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase", fontFamily: syne, color: T.ink }}>Zero To Secure</span>
        </div>
        <div style={{ fontSize: 12, color: T.faint, marginBottom: 22 }}>Sign in to the command center.</div>
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="email" type="email" autoComplete="email"
          style={{ ...inputStyle, marginBottom: 10 }} />
        {mode === "password" && (
          <input value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === "Enter") signIn(); }} placeholder="password" type="password" autoComplete="current-password"
            style={{ ...inputStyle, marginBottom: 10 }} />
        )}
        {err && <div style={{ fontSize: 11, color: T.red, marginBottom: 10 }}>{err}</div>}
        {sent && <div style={{ fontSize: 11, color: T.green, marginBottom: 10 }}>Login link sent — check your email.</div>}
        <button onClick={mode === "password" ? signIn : sendMagic} disabled={disabled}
          style={{ width: "100%", padding: 12, fontSize: 12, fontWeight: 800, fontFamily: syne, borderRadius: 10, cursor: disabled ? "default" : "pointer", border: "none", background: disabled ? "rgba(255,255,255,0.06)" : T.greenGrad, color: disabled ? T.faint : T.accentInk }}>
          {busy ? (mode === "password" ? "Signing in…" : "Sending…") : (mode === "password" ? "Sign in" : "Email me a login link")}
        </button>
        <div onClick={() => { setMode(mode === "password" ? "magic" : "password"); setErr(null); setSent(false); }}
          style={{ fontSize: 10, color: T.faint, textAlign: "center", marginTop: 12, cursor: "pointer" }}>
          {mode === "password" ? "Use a magic link instead" : "Use a password instead"}
        </div>
      </div>
    </div>
  );
}

export default function App({ embedded = false }) {
  useGlobalStyles();
  const isMobile = useIsMobile();
  const [view, setView] = useState("mission");
  const [creators, setCreators] = useState([]);
  const [shorts, setShorts] = useState([]);
  const [articles, setArticles] = useState([]);
  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Palette → view handoff: bumping a counter tells the target view to open
  // its composer. A counter (not a flag) so it works even when you're already
  // on that view; the view clears it after consuming so a later remount
  // (navigate away and back) doesn't re-open the composer uninvited.
  const [createSignal, setCreateSignal] = useState({ studio: 0, seo: 0, creators: 0 });
  const signalCreate = (key) => setCreateSignal(s => ({ ...s, [key]: s[key] + 1 }));
  const clearSignal = useCallback((key) => setCreateSignal(s => (s[key] === 0 ? s : { ...s, [key]: 0 })), []);
  const toast = useToast();

  // Cmd/Ctrl+K opens the command palette from anywhere. Skips while typing in
  // a field so it never hijacks a keystroke mid-script or mid-article.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      e.preventDefault();
      setPaletteOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auth gate — this app had none before. Same pattern as Board Room:
  // check for an existing Supabase session on load, and keep listening for
  // sign-in/sign-out. Nothing renders below until this resolves.
  useEffect(() => {
    if (!supabase) { setAuthChecked(true); return; } // unconfigured — see LoginScreen's own messaging
    supabase.auth.getSession().then(({ data }) => { setSession(data.session || null); setAuthChecked(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub?.subscription?.unsubscribe();
  }, []);

  // Load from Supabase on mount — replaces the old synchronous localStorage
  // read. Waits for a real session first: querying before sign-in would
  // just return empty results once RLS requires authentication anyway.
  useEffect(() => {
    if (!supabase || !session?.user) return;
    setDataLoading(true);
    (async () => {
      const [{ data: cr, error: crErr }, { data: sh, error: shErr }, { data: ar, error: arErr }] = await Promise.all([
        supabase.from("creators").select("*").order("created_at", { ascending: false }),
        supabase.from("shorts").select("*").order("created_at", { ascending: false }),
        supabase.from("articles").select("*").order("created_at", { ascending: false }),
      ]);
      if (crErr) console.warn("[App] creators load failed:", crErr.message);
      if (shErr) console.warn("[App] shorts load failed:", shErr.message);
      if (arErr) console.warn("[App] articles load failed:", arErr.message);
      const failed = [crErr && "creators", shErr && "Shorts", arErr && "articles"].filter(Boolean);
      if (failed.length) toast.push(`Couldn't load ${failed.join(", ")} — check your connection and refresh.`, { tone: "error" });
      setCreators(cr || []);
      setShorts(sh || []);
      setArticles(ar || []);
      setDataLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  const addArticle = async (a) => {
    // Callers (e.g. the auto-draft cadence below) still build a client-side
    // id/created_at out of habit from the old localStorage shape — strip them
    // so Supabase generates its own UUID/timestamp instead of rejecting a
    // non-UUID string in the id column.
    const { id: _id, created_at: _ca, ...fields } = a;
    if (!supabase) { setArticles(prev => [{ id: `local_${Date.now()}`, created_at: new Date().toISOString(), ...fields }, ...prev]); return; }
    const { data, error: err } = await supabase.from("articles").insert(fields).select();
    if (err) { console.warn("[addArticle] insert failed:", err.message); return; }
    if (data?.[0]) setArticles(prev => [data[0], ...prev]);
  };

  const TABS = ["mission", "creators", "studio", "seo", "dna"];

  // Sliding tab indicator — measured from the active tab's DOM position so the
  // white pill glides between tabs instead of teleporting.
  const tabRefs = useRef({});
  const [tabIndicator, setTabIndicator] = useState({ left: 0, width: 0, ready: false });
  useLayoutEffect(() => {
    const measure = () => {
      const el = tabRefs.current[view];
      if (!el) return;
      setTabIndicator({ left: el.offsetLeft, width: el.offsetWidth, ready: true });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [view, isMobile, authChecked, session]);

  // Command palette actions — tabs, quick creates, live records. Rebuilt each
  // render; the list is small and the handlers aren't stable refs anyway.
  const paletteActions = (() => {
    const acts = [];
    const TAB_LABELS = { mission: "Mission", creators: "Creators", studio: "Studio", seo: "SEO", dna: "DNA" };
    TABS.forEach(t => acts.push({ id: `nav_${t}`, group: "Go to", icon: "→", label: TAB_LABELS[t] || t, run: () => setView(t) }));
    acts.push({ id: "act_short", group: "Create", icon: "✦", label: "New Short", sub: "Generate a full Shorts package", run: () => { signalCreate("studio"); setView("studio"); } });
    acts.push({ id: "act_article", group: "Create", icon: "✦", label: "New Article", sub: "Draft an SEO article into review", run: () => { signalCreate("seo"); setView("seo"); } });
    acts.push({ id: "act_creator", group: "Create", icon: "+", label: "Add Creator", sub: "Add a YouTube creator to the pipeline", run: () => { signalCreate("creators"); setView("creators"); } });
    acts.push({ id: "act_pass", group: "Action", icon: "⚡", label: "Run engine pass now", run: () => { sm.set("engine_force_pass", true); eng.set({ running: true }); } });
    creators.slice(0, 200).forEach(c => c.channel_name && acts.push({ id: `cr_${c.id}`, group: "Creator", icon: "▸", label: c.channel_name, sub: `${fmtSubs(c.subscriber_count)} subs · ${c.stage || "prospected"}`, run: () => setView("creators") }));
    shorts.slice(0, 200).forEach(s => acts.push({ id: `sh_${s.id}`, group: "Short", icon: "▸", label: s.title || s.topic || "Untitled Short", sub: s.stage, run: () => setView("studio") }));
    articles.slice(0, 100).forEach(a => acts.push({ id: `ar_${a.id}`, group: "Article", icon: "▸", label: a.title_tag || a.keyword || "Untitled", sub: a.stage, run: () => setView("seo") }));
    return acts;
  })();

  if (!embedded && !authChecked) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0B0F1A" }}>
      <div style={{ width: "32px", height: "32px", border: "2px solid rgba(255,255,255,0.1)", borderTopColor: T.green, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
  if (!embedded && !session) return <LoginScreen />;

  return (
    <div style={{ minHeight: "100vh", fontFamily: "'Inter', system-ui, sans-serif", paddingBottom: isMobile ? "calc(60px + var(--safe-bottom))" : 0 }}>
      <AgentEngine creators={creators} shorts={shorts} articles={articles} onArticleDraft={addArticle} />
      <DnaWorker creators={creators} shorts={shorts} articles={articles} onArticleDraft={addArticle} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} actions={paletteActions} />
      {/* each tool owns its own ⌘K palette; the shell does not capture ⌘K */}
      {!(embedded && isMobile) && (
      <div style={{ borderBottom: `1px solid ${T.line}`, padding: isMobile ? "0 16px" : "0 24px", height: "52px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: embedded ? "52px" : 0, background: "rgba(11,15,26,0.78)", backdropFilter: "blur(20px) saturate(140%)", WebkitBackdropFilter: "blur(20px) saturate(140%)", boxShadow: "0 1px 0 rgba(255,255,255,0.03), 0 4px 16px rgba(0,0,0,0.35)", zIndex: 50 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          {!embedded && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <span style={{ width: "18px", height: "18px", borderRadius: "5px", background: "linear-gradient(135deg, #12B886 0%, #0A7A54 100%)", boxShadow: "0 1px 3px rgba(10,122,84,0.4), inset 0 1px 0 rgba(255,255,255,0.25)", display: "inline-block" }} />
            <span style={{ fontSize: "13px", fontWeight: 800, color: T.inkDeep, letterSpacing: "0.14em", textTransform: "uppercase", fontFamily: syne }}>Zero To Secure</span>
          </span>
          )}
          {!isMobile && (
            <div style={{ display: "flex", gap: "2px", background: "rgba(255,255,255,0.045)", borderRadius: "10px", padding: "3px", marginLeft: "12px", border: `1px solid ${T.lineSoft}`, position: "relative" }}>
              {tabIndicator.ready && (
                <div style={{ position: "absolute", top: "3px", bottom: "3px", left: `${tabIndicator.left}px`, width: `${tabIndicator.width}px`, background: T.navy, borderRadius: "7px", boxShadow: T.shadowTab, transition: `left ${M.durBase} ${M.easeSpring}, width ${M.durBase} ${M.easeSpring}`, zIndex: 0 }} />
              )}
              {TABS.map(t => (
                <button key={t} ref={el => { tabRefs.current[t] = el; }} onClick={() => setView(t)} style={{ position: "relative", zIndex: 1, padding: "5px 15px", background: "transparent", border: "none", borderRadius: "7px", color: view === t ? T.inkDeep : T.faint, fontSize: "11px", fontWeight: 700, cursor: "pointer", letterSpacing: "0.06em", textTransform: "uppercase", fontFamily: syne, transition: `color ${M.durBase} ${M.easeStd}` }}>{t}</button>
              ))}
            </div>
          )}
        </div>
        {!isMobile && !embedded && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button onClick={() => setPaletteOpen(true)} title="Command palette (⌘K)" style={{ background: "none", border: `1px solid ${T.line}`, borderRadius: 7, color: T.faint, fontSize: 10, padding: "5px 10px", cursor: "pointer", fontWeight: 600, fontFamily: mono }}>⌘K</button>
            <button onClick={() => supabase?.auth.signOut()} style={{ background: "none", border: `1px solid ${T.line}`, borderRadius: 7, color: T.sub, fontSize: 10, padding: "5px 10px", cursor: "pointer", fontWeight: 600, fontFamily: syne }}>Sign out</button>
          </div>
        )}
      </div>
      )}
      {view === "mission" && <MissionView creators={creators} shorts={shorts} onNavigate={setView} isMobile={isMobile} loading={dataLoading} />}
      {view === "creators" && <CreatorsView creators={creators} setCreators={setCreators} isMobile={isMobile} loading={dataLoading} openSignal={createSignal.creators} onSignalConsumed={() => clearSignal("creators")} />}
      {view === "studio" && <StudioView shorts={shorts} setShorts={setShorts} isMobile={isMobile} loading={dataLoading} openSignal={createSignal.studio} onSignalConsumed={() => clearSignal("studio")} />}
      {view === "seo" && <SeoView articles={articles} setArticles={setArticles} onAddArticle={addArticle} isMobile={isMobile} loading={dataLoading} openSignal={createSignal.seo} onSignalConsumed={() => clearSignal("seo")} />}
      {view === "dna" && <DnaView creators={creators} shorts={shorts} articles={articles} onArticleDraft={addArticle} />}
      {isMobile && <BottomNav view={view} setView={setView} tabs={TABS} />}
    </div>
  );
}
