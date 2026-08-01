// ─── The shell chrome, MEASURED: theme + power ───────────────────────────────
//
// WHY THIS EXISTS. scripts/toolrow-check.mjs's header records the last time this
// repo shipped a fix that was written, exported, documented and green: the tool
// row was asserted to contain "auto-fit", it did, and it rendered a vertical
// ladder. Both features below are the same species of risk, and the theme one is
// worse, because its failure mode is INVISIBLE TO SOURCE:
//
//   apps/shell/src/main.jsx already says "App.jsx still stamps cssVars() inline
//   on the wrapper, and an inline custom property beats a stylesheet one".
//   themes.css has carried a contrast-checked light half for all eight palettes
//   since the token layer landed. So a Light button that sets
//   data-theme="light" is CORRECT BY EVERY SOURCE ASSERTION YOU CAN WRITE — the
//   attribute lands, the CSS rule matches — and repaints nothing at all, because
//   eight inline hexes overrule it. Only something that resolves the cascade can
//   tell the two apart. A browser resolves the cascade.
//
// So: build it, load it signed in, and read COMPUTED values off the live page.
// Same posture as scripts/toolrow-check.mjs, scripts/smoke.mjs and
// scripts/nav-check.mjs.
//
//   VITE_SUPABASE_URL=https://stub.supabase.co VITE_SUPABASE_ANON_KEY=stub \
//     npm run build
//   node <a static server> apps/shell/dist 4178
//   node apps/shell/scripts/chrome-check.mjs
//
// BASE and CHROMIUM override the defaults. It lives under apps/shell/ rather
// than in scripts/ because apps/shell is what it measures and what its author
// owns; move it if the repo would rather keep all harnesses together.
import { chromium } from "playwright-core";
import { PALETTES } from "../../../packages/design/palettes.js";

const BASE = process.env.BASE || "http://127.0.0.1:4178";
const CHROMIUM = process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ORDER = ["zts", "clarify", "runway", "macro", "looper", "business", "sync", "ideas"];

const future = Math.floor(Date.now() / 1000) + 3600;
const session = {
  access_token: "t", token_type: "bearer", expires_in: 3600, expires_at: future, refresh_token: "r",
  user: { id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated", email: "stub@example.com", app_metadata: {}, user_metadata: {}, created_at: new Date(0).toISOString() },
};

// Exactly the shape netlify/shared/toolPower.mjs's summariseAll produces, with
// Macro paused. `enabled` deliberately CONTRADICTS `paused` on the ZTS rows:
// ops_control seeds every row disabled because autonomy is opt-in, so a shell
// that read `enabled` as the pause would paint ZTS as stopped here while its
// content engine drafts an article every four hours. This fixture is the only
// place that difference is visible end to end.
const POWER = {
  tools: {
    zts: {
      label: "zts", pausable: true, paused: false, partial: false, mixed: false, stopped: [],
      stops: "Pauses the content engine and store ingest.", keeps: null,
      engines: [
        { key: "zts.content", label: "the content engine", registered: true, enabled: false, paused: false, pausedReason: null, pausedAt: null, keeps: null },
        { key: "zts.store", label: "store ingest", registered: true, enabled: false, paused: false, pausedReason: null, pausedAt: null, keeps: null },
      ],
    },
    macro: {
      label: "macro", pausable: true, paused: true, partial: false, mixed: false,
      stopped: ["macro.watch", "macro.alts"],
      stops: "Pauses the MSTR stop sentinel and the alt sentinel.",
      keeps: "Still records the daily BTC-dominance sample, which nothing can backfill.",
      engines: [
        { key: "macro.watch", label: "the MSTR stop sentinel", registered: true, enabled: true, paused: true, pausedReason: "paused from the tool switch", pausedAt: "2026-07-31T09:00:00.000Z", keeps: null },
        { key: "macro.alts", label: "the alt sentinel", registered: true, enabled: true, paused: true, pausedReason: "paused from the tool switch", pausedAt: "2026-07-31T09:00:00.000Z", keeps: "the daily BTC-dominance sample, which nothing can backfill" },
      ],
    },
    clarify: {
      label: "clarify", pausable: true, paused: false, partial: false, mixed: false, stopped: [],
      stops: "Pauses the outbound engine and reply detection.", keeps: null,
      engines: [
        { key: "clarify.outbound", label: "the outbound engine", registered: true, enabled: false, paused: false, pausedReason: null, pausedAt: null, keeps: null },
        { key: "clarify.replies", label: "reply detection", registered: true, enabled: false, paused: false, pausedReason: null, pausedAt: null, keeps: null },
      ],
    },
    runway: {
      label: "runway", pausable: true, paused: false, partial: false, mixed: false, stopped: [],
      stops: "Pauses the weekday board scan.", keeps: null,
      engines: [
        { key: "runway.scan", label: "the weekday board scan", registered: false, enabled: null, paused: false, pausedReason: null, pausedAt: null, keeps: null },
      ],
    },
    // The four tools that run nothing. They must get NO switch — a control that
    // writes to zero rows and then renders as though it had is the decorative
    // switch this whole part exists to remove.
    looper: { label: "looper", pausable: false, paused: false, partial: false, mixed: false, stopped: [], stops: null, keeps: null, engines: [] },
    business: { label: "business", pausable: false, paused: false, partial: false, mixed: false, stopped: [], stops: null, keeps: null, engines: [] },
    sync: { label: "sync", pausable: false, paused: false, partial: false, mixed: false, stopped: [], stops: null, keeps: null, engines: [] },
    ideas: { label: "ideas", pausable: false, paused: false, partial: false, mixed: false, stopped: [], stops: null, keeps: null, engines: [] },
  },
};

let bad = 0;
const fail = (msg) => { bad++; console.log(`FAIL  ${msg}`); };
const ok = (msg) => console.log(`ok    ${msg}`);

// ── colour helpers ──────────────────────────────────────────────────────────
// getComputedStyle answers `rgb(…)` for real properties but returns a CUSTOM
// property's text verbatim, so --accent comes back as "#9489EC". Reading that
// with a digit regex yields [9489] and every comparison then fails while
// printing two identical strings — which is what the first run of this file did.
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb = (s) => {
  const v = String(s).trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return hexRgb(v);
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return [1, 2, 3].map((i) => parseInt(v[i] + v[i], 16));
  return (v.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
};
const near = (a, b, tol = 6) => a.length === 3 && b.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= tol);
/** Relative luminance, sRGB. "Light mode is light" has to be a number, not a vibe. */
const lum = ([r, g, b]) => {
  const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

const browser = await chromium.launch({ executablePath: CHROMIUM });

/** A fresh page with the given stored prefs, signed in, with /api/tool-power stubbed. */
async function open(prefs = {}, { colorScheme = "dark", powerStatus = 200, hash = "#/zts" } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme });
  const puts = [];
  await page.addInitScript(([s, order, theme]) => {
    for (const k of ["sb-stub-auth-token", "sb-localhost-auth-token"]) { try { localStorage.setItem(k, JSON.stringify(s)); } catch {} }
    try { localStorage.setItem("cc_tab_prefs", JSON.stringify({ order, hidden: [] })); } catch {}
    // SET ONLY, NEVER CLEAR. addInitScript runs on every navigation including a
    // reload, so a `removeItem` here wipes the preference the page just saved —
    // and the persistence check below then reports a bug in the shell that is
    // really a bug in the harness. Each open() gets its own browser context, so
    // "no theme" already means an empty store.
    try { if (theme) localStorage.setItem("cc_theme_prefs", JSON.stringify(theme)); } catch {}
  }, [session, ORDER, prefs.theme || null]);

  await page.route("**/*", async (r) => {
    const req = r.request();
    const u = req.url();
    if (/\/api\/tool-power/.test(u)) {
      if (req.method() === "PUT") {
        puts.push(JSON.parse(req.postData() || "{}"));
        if (powerStatus !== 200) return r.fulfill({ status: powerStatus, contentType: "application/json", body: JSON.stringify({ error: "ops_control write failed: stubbed" }) });
        const body = puts[puts.length - 1];
        const t = POWER.tools[body.tool];
        return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          tool: body.tool, paused: body.paused,
          tools: { [body.tool]: { ...t, paused: body.paused, stopped: body.paused ? t.engines.map((e) => e.key) : [], engines: t.engines.map((e) => ({ ...e, paused: body.paused })) } },
        }) });
      }
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(POWER) });
    }
    if (u.startsWith(BASE)) return r.continue();
    if (/\/rest\/v1\//i.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    if (/\/auth\/v1\//i.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: session.user, session }) });
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto(`${BASE}/${hash}`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(900);
  return { page, puts };
}

/** What the browser actually resolved on the shell's themed wrapper. */
const readTheme = (page) => page.evaluate(() => {
  const el = document.querySelector("[data-app]");
  if (!el) return null;
  const cs = getComputedStyle(el);
  return {
    palette: el.getAttribute("data-palette"),
    theme: el.getAttribute("data-theme"),
    accent: cs.getPropertyValue("--accent").trim(),
    bg: cs.backgroundColor,
    ink: cs.color,
    docTheme: document.documentElement.getAttribute("data-theme"),
    docScheme: getComputedStyle(document.documentElement).colorScheme,
  };
});

const clickTool = async (page, app) => {
  await page.click(`.toolrow button[title^="${{ zts: "Zero", clarify: "Clarify", runway: "Runway", macro: "Macro", looper: "Looper", business: "AI Business", sync: "SYNC", ideas: "Ideas" }[app]}"]`);
  await page.waitForTimeout(450);
};

// ═══ 1. A CHOSEN PALETTE REPAINTS EVERY TOOL ═══════════════════════════════
// The control first: with "Match the tool" (the default), the eight tools must
// still resolve to eight different accents. Without that half, a picker that
// froze the accent at one value would pass check 1 by being broken.
{
  const { page } = await open();
  const seen = {};
  for (const app of ORDER) { await clickTool(page, app); seen[app] = (await readTheme(page)).accent; }
  const distinct = new Set(Object.values(seen)).size;
  if (distinct !== ORDER.length) fail(`default: ${distinct} distinct accents across ${ORDER.length} tools — "Match the tool" is not matching (${JSON.stringify(seen)})`);
  else ok(`default "Match the tool": ${distinct} distinct accents across ${ORDER.length} tools`);
  await page.close();
}
for (const key of ["runway", "ideas"]) {
  const want = hexRgb(PALETTES.find((p) => p.key === key).night.accent);
  const { page } = await open({ theme: { palette: key, mode: "dark" } });
  const wrong = [];
  for (const app of ORDER) {
    await clickTool(page, app);
    const t = await readTheme(page);
    if (t.palette !== key) wrong.push(`${app}: data-palette=${t.palette}`);
    else if (!near(rgb(t.accent), want)) wrong.push(`${app}: --accent ${t.accent} ≠ ${PALETTES.find((p) => p.key === key).night.accent}`);
  }
  if (wrong.length) fail(`palette "${key}" did not reach ${wrong.length}/${ORDER.length} tools — ${wrong.join(" · ")}`);
  else ok(`palette "${key}" repaints all ${ORDER.length} tools (accent ${PALETTES.find((p) => p.key === key).night.accent})`);
  await page.close();
}

// ═══ 2. LIGHT MODE ACTUALLY GOES LIGHT ═════════════════════════════════════
// A number, not an impression: the ground must be lighter than the ink, by a
// lot, on a tool AND on the settings screen the choice is made from. The old
// inline stamp puts --bg at #0B0F1A (luminance ≈ 0.005) whatever data-theme
// says, so a shipped-but-unwired Light button fails this by ~0.85.
for (const [label, hash] of [["a tool", "#/zts"], ["System", "#/system"]]) {
  const { page } = await open({ theme: { palette: "match", mode: "light" } }, { hash });
  const t = await readTheme(page);
  const surface = await page.evaluate(() => {
    // System's OWN panel, not the shell bar — it is the only [data-kit] root
    // with a min-height, and it hardcoded six midnight hexes until this landed.
    const el = document.querySelector('[data-kit][style*="min-height"]') || document.querySelector("[data-app]");
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, ink: cs.color };
  });
  const wrapBg = lum(rgb(t.bg)), wrapInk = lum(rgb(t.ink));
  if (t.theme !== "light") fail(`${label} in light mode: data-theme=${t.theme}`);
  else if (!(wrapBg > 0.6 && wrapInk < 0.2)) fail(`${label} in light mode: ground luminance ${wrapBg.toFixed(3)} / ink ${wrapInk.toFixed(3)} — the page is still dark (bg ${t.bg})`);
  else ok(`${label} in light mode: ground ${wrapBg.toFixed(2)} over ink ${wrapInk.toFixed(2)} (${t.bg})`);
  if (t.docScheme !== "light") fail(`${label}: <html> color-scheme is "${t.docScheme}" — scrollbars and form controls stay dark`);
  else ok(`${label}: <html> color-scheme follows (${t.docScheme})`);
  if (label === "System" && lum(rgb(surface.bg)) < 0.5) fail(`System's own panel is still ${surface.bg} in light mode — the screen the setting is made on did not follow it`);
  await page.close();
}
{
  // EVERY SYSTEM TAB, AND OPS ABOVE ALL. A wrapper that turned light says
  // nothing about the text on it: before this landed, light mode drew Ops's
  // heading, its state line and the word inside the STOP button in #E9EDF5 on
  // #EFF1F5 — and that file's own header says the STOP control is always
  // reachable and never behind a disclosure. A control you cannot see is behind
  // the deepest disclosure there is. Measured: separation 4 out of 255.
  const { page } = await open({ theme: { palette: "match", mode: "light" } }, { hash: "#/system" });
  for (const tab of ["Overview", "Ops", "Usage", "Minds", "Agents", "Tabs", "Theme"]) {
  // A missing tab is a FAILED CHECK, not a crashed harness. The first version
  // threw here against the pre-change build (which has no Theme tab) and took
  // the remaining twelve checks with it, which is the same disease as a suite
  // that stops at the first error.
  const el = await page.$(`[role="tab"]:has-text("${tab}")`);
  if (!el) { fail(`System has no ${tab} tab`); continue; }
  await el.click();
  await page.waitForTimeout(500);
  const worst = await page.evaluate(() => {
    const lin = (c) => { const [r, g, b] = (String(c).match(/[\d.]+/g) || [0, 0, 0]).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const panel = document.querySelector('[data-kit][style*="min-height"]');
    if (!panel) return null;
    const ground = lin(getComputedStyle(document.querySelector("[data-app]")).backgroundColor);
    let low = { sep: 999, text: "", color: "" };
    let seen = 0;
    for (const el of panel.querySelectorAll("h2, p, div, span, button")) {
      const t = (el.textContent || "").trim();
      if (!t || el.children.length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      // Measured against the PAGE GROUND: every card on this screen is a
      // near-ground tone or a 10-16% wash over it, so the ground is the honest
      // worst case rather than a convenient one.
      seen++;
      const sep = Math.abs(lin(cs.color) - ground);
      if (sep < low.sep) low = { sep, text: t.slice(0, 40), color: cs.color };
    }
    return { ...low, seen, stop: /Force STOP|STOP EVERYTHING|Arm autonomy/.test(panel.innerText) };
  });
  if (!worst) fail(`${tab} in light mode: could not find the System panel at all`);
  // Scan sanity, in the house style: a selector that quietly stops matching must
  // not pass green, and on Ops the STOP control specifically has to be one of
  // the things measured — it is the reason that screen exists.
  else if (worst.seen < 8 || (tab === "Ops" && !worst.stop)) fail(`${tab} in light mode: the scan saw ${worst.seen} text nodes${tab === "Ops" ? ` and did NOT see the STOP control` : ""} — it is measuring nothing`);
  else if (worst.sep < 40) fail(`${tab} in light mode: "${worst.text}" is ${worst.color} against the page ground (separation ${worst.sep.toFixed(0)}) — this screen is unreadable`);
  else ok(`${tab} in light mode: ${worst.seen} text nodes${tab === "Ops" ? " incl. the STOP control" : ""}, worst separation ${worst.sep.toFixed(0)}`);
  }
  await page.close();
}
{
  // And the other direction still works: dark stays dark. The color-scheme
  // assertion belongs HERE rather than only in the light case — the token
  // layer's `:root` selector already answers "light", so a shell that publishes
  // nothing passes the light check by accident and fails this one.
  const { page } = await open({ theme: { palette: "match", mode: "dark" } });
  const t = await readTheme(page);
  if (lum(rgb(t.bg)) > 0.2) fail(`dark mode is not dark: ${t.bg}`); else ok(`dark mode stays dark (${t.bg})`);
  if (t.docScheme !== "dark") fail(`dark mode leaves <html> color-scheme at "${t.docScheme}" — the scrollbars and form controls stay light over a black app`);
  else ok(`dark mode publishes color-scheme: dark to <html>`);
  await page.close();
}

// ═══ 3. "SYSTEM" FOLLOWS THE DEVICE LIVE, NOT AT BOOT ══════════════════════
// The failure this catches is the easy implementation: read matchMedia once in
// useState and never subscribe. It looks right in every manual test, because a
// manual test reloads. An iOS standalone window does not, and the OS flips at
// sunset every day.
{
  const { page } = await open({ theme: { palette: "match", mode: "system" } }, { colorScheme: "dark" });
  const before = await readTheme(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(500);
  const after = await readTheme(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(500);
  const back = await readTheme(page);
  if (before.theme !== "dark") fail(`system mode on a dark device resolved to ${before.theme}`);
  else if (after.theme !== "light" || !(lum(rgb(after.bg)) > 0.6)) fail(`system mode did not follow the device to light without a reload — data-theme=${after.theme}, bg=${after.bg}`);
  else if (back.theme !== "dark") fail(`system mode did not follow the device back to dark — data-theme=${back.theme}`);
  else ok(`system mode follows an emulated colour-scheme change live (dark → light ${after.bg} → dark)`);
  await page.close();
}

// ═══ 4. A PAUSED TOOL IS MARKED IN THE BAR ═════════════════════════════════
{
  const { page } = await open();
  const marks = await page.evaluate(() => {
    const out = {};
    for (const b of document.querySelectorAll(".toolrow button")) {
      const dot = [...b.querySelectorAll("span")].find((s) => getComputedStyle(s).borderRadius.startsWith("50%"));
      const cs = getComputedStyle(b);
      out[b.textContent.replace(/^Paused:\s*/, "").trim()] = {
        opacity: Number(cs.opacity),
        marked: b.getAttribute("data-paused") === "true",
        title: b.getAttribute("title"),
        dotBg: dot ? getComputedStyle(dot).backgroundColor : null,
        dotBorder: dot ? getComputedStyle(dot).borderTopWidth : null,
        srText: b.textContent.startsWith("Paused:"),
      };
    }
    return out;
  });
  const m = marks.Macro, z = marks.ZTS;
  if (!m || !z) fail(`could not find the Macro and ZTS cells in the bar (${Object.keys(marks).join(", ")})`);
  else {
    if (!(m.opacity < 0.95 && z.opacity > 0.95)) fail(`paused Macro is not dimmed: opacity ${m.opacity} vs running ZTS ${z.opacity}`);
    else ok(`paused Macro dims to ${m.opacity} while running ZTS stays ${z.opacity}`);
    // Hollow, not merely recoloured — eight accents means a "muted" dot is some
    // other tool's normal one.
    if (!(/rgba\(0, 0, 0, 0\)|transparent/.test(m.dotBg) && parseFloat(m.dotBorder) > 0)) fail(`paused Macro's dot is not hollow: background ${m.dotBg}, border ${m.dotBorder}`);
    else ok(`paused Macro's dot is hollow (bg ${m.dotBg}, ${m.dotBorder} ring) against ZTS's filled ${z.dotBg}`);
    if (!m.srText) fail("a screen reader hears nothing: the paused cell has no text marker");
    else ok("the paused cell announces itself (accessible name starts \"Paused:\")");
    if (!/paused/i.test(m.title || "")) fail(`paused Macro's title does not say so: ${m.title}`);
    if (z.marked) fail("a running tool is marked as paused");
  }

  // …and opening it explains itself, over a tool that still renders.
  await clickTool(page, "macro");
  const banner = await page.evaluate(() => {
    const el = document.querySelector('[role="status"]');
    if (!el) return null;
    const btn = el.querySelector("button");
    const bs = btn && getComputedStyle(btn);
    const lin = (c) => { const [r, g, b] = (c.match(/[\d.]+/g) || [0, 0, 0]).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    return {
      text: el.innerText.replace(/\s+/g, " ").trim(),
      resume: !!btn,
      // The button renders INSIDE whichever tool is mounted, and eight apps own
      // `.btn`. Macro's is unscoped and dark, so a kit class here came out as a
      // black slab with black text over light mode. Contrast is the only way to
      // see that, and it is a number.
      btnContrast: bs ? Math.abs(lin(bs.color) - lin(bs.backgroundColor === "rgba(0, 0, 0, 0)" ? getComputedStyle(el).backgroundColor : bs.backgroundColor)) : 0,
    };
  });
  if (!banner) fail("opening a paused tool shows no banner");
  else if (banner.btnContrast < 40) fail(`the banner's Resume button is unreadable (ink/ground separation ${banner.btnContrast.toFixed(0)}) — a tool's own unscoped .btn is painting it`);
  else if (!/paused/i.test(banner.text) || !banner.resume) fail(`the banner does not say what it is or offer a way out: ${banner.text}`);
  else if (!/stop sentinel|alt sentinel/i.test(banner.text)) fail(`the banner does not name what is stopped: ${banner.text}`);
  else if (!/BTC-dominance/i.test(banner.text)) fail(`the banner does not say what a pause KEEPS doing — an operator who later finds a dominance row written on a paused day was misled by omission: ${banner.text}`);
  else ok(`the paused tool's banner names the engines and the exception ("${banner.text.slice(0, 96)}…")`);

  await clickTool(page, "zts");
  const stillThere = await page.$('[role="status"]');
  if (stillThere) fail("the paused banner follows you into a tool that is not paused");
  else ok("the banner is gone on a tool that is running");
  await page.close();
}

// ═══ 5. THE SWITCH IS WIRED, AND A FAILED WRITE ROLLS BACK ═════════════════
// The check that would have caught the tool row: does pressing it reach the
// call site at all, and does a refusal leave the control telling the truth?
{
  const { page, puts } = await open({}, { hash: "#/system" });
  await page.click('[role="tab"]:has-text("Tabs")');
  await page.waitForTimeout(400);
  const sel = '[role="switch"][aria-label*="background engines"]';
  const labels = await page.$$eval(sel, (els) => els.map((e) => e.getAttribute("aria-label")));
  // Four of the eight tools run nothing scheduled — they must have NO switch.
  if (labels.length !== 4) fail(`expected 4 power switches (zts, clarify, runway, macro), found ${labels.length}: ${labels.join(" | ")}`);
  else ok(`4 power switches, one per tool that actually runs something: ${labels.map((l) => l.split(" ")[1]).join(", ")}`);
  const copy = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  const missing = [
    "Pauses the content engine and store ingest.",
    "Nothing runs in the background for this tool",
    "nothing it runs on a schedule stops",
    "Still records the daily BTC-dominance sample",
  ].filter((want) => !copy.includes(want));
  if (missing.length) fail(`Tabs is missing the copy: ${missing.map((s) => `"${s}"`).join(", ")}`);
  else ok("both switches' copy is present, including what a pause does NOT stop");

  const zts = await page.$(`${sel}[aria-label*="ZTS"]`);
  if (!zts) fail("there is no power switch on the ZTS row to press");
  else {
    const was = await zts.getAttribute("aria-checked");
    await zts.click();
    await page.waitForTimeout(700);
    const now = await page.getAttribute(`${sel}[aria-label*="ZTS"]`, "aria-checked");
    if (puts.length !== 1 || puts[0].tool !== "zts" || puts[0].paused !== true) fail(`the switch did not reach /api/tool-power with the right body: ${JSON.stringify(puts)}`);
    else ok(`pressing it PUTs ${JSON.stringify(puts[0])} to /api/tool-power`);
    if (!(was === "true" && now === "false")) fail(`the switch did not move: aria-checked ${was} → ${now}`);
    else ok(`the switch moves on success (aria-checked ${was} → ${now})`);

    // …AND IT DID NOT COST THE OTHER THREE. The PUT answers with one tool's
    // rows, so applying it as the whole map wipes every other tool's engines:
    // three live switches become "nothing runs in the background" and a genuinely
    // paused Macro un-dims in the bar. The pressed switch looks perfect either
    // way, which is exactly why this is checked from outside it.
    const after = await page.$$eval(sel, (els) => els.map((e) => `${e.getAttribute("aria-label")}=${e.getAttribute("aria-checked")}`));
    const macroStillPaused = await page.$eval(".toolrow button[title^=\"Macro\"]", (b) => b.getAttribute("data-paused") === "true").catch(() => false);
    if (after.length !== 4) fail(`writing one tool erased the others: ${after.length} switches left (${after.join(" | ")})`);
    else if (!macroStillPaused) fail("writing ZTS un-marked a paused Macro in the tool row — the one-tool reply was applied as the whole map");
    else ok(`writing one tool leaves the other three switches and Macro's mark intact (${after.join(", ")})`);
  }
  await page.close();
}
{
  const { page, puts } = await open({}, { hash: "#/system", powerStatus: 500 });
  await page.click('[role="tab"]:has-text("Tabs")');
  await page.waitForTimeout(400);
  const sel = '[role="switch"][aria-label*="background engines"][aria-label*="ZTS"]';
  if (!(await page.$(sel))) fail("there is no power switch to fail");
  else {
    const was = await page.getAttribute(sel, "aria-checked");
    await page.click(sel);
    await page.waitForTimeout(900);
    const now = await page.getAttribute(sel, "aria-checked");
    const toasted = await page.evaluate(() => /Couldn't pause/i.test(document.body.innerText));
    if (puts.length !== 1) fail(`the failing case never issued the write: ${JSON.stringify(puts)}`);
    if (now !== was) fail(`A FAILED WRITE LEFT THE SWITCH ON: aria-checked ${was} → ${now}. It is claiming to have stopped engines that are still running.`);
    else ok(`a 500 rolls the switch back to aria-checked=${now}`);
    if (!toasted) fail("a failed write said nothing — the switch flips back with no explanation and reads as a bug in the switch");
    else ok("a failed write is explained in a toast");
  }
  await page.close();
}

// ═══ 6. THE PICKER ITSELF ══════════════════════════════════════════════════
// Everything above drove the stored preference directly. This drives the actual
// controls, because a model that works behind a picker nobody wired is the same
// failure in a different file.
{
  const { page } = await open({}, { hash: "#/system" });
  const themeTab = await page.$('[role="tab"]:has-text("Theme")');
  if (!themeTab) { fail("System has no Theme tab"); await page.close(); }
  else {
    await themeTab.click();
    await page.waitForTimeout(350);
    // Scoped to the panel: the shell bar's System button also carries
    // aria-pressed, and counting it made "8 palettes + Match the tool" read 10.
    const swatches = await page.$$eval('[data-kit][style*="min-height"] [aria-pressed]', (els) => els.length);
    if (swatches !== PALETTES.length + 1) fail(`the palette picker offers ${swatches} options, expected ${PALETTES.length} palettes + "Match the tool"`);
    else ok(`the picker offers all ${PALETTES.length} generated palettes plus "Match the tool"`);

    await page.click('button:has-text("Light")');
    await page.waitForTimeout(500);
    let t = await readTheme(page);
    if (!(t.theme === "light" && lum(rgb(t.bg)) > 0.6)) fail(`pressing Light on the Theme tab did not repaint it: data-theme=${t.theme}, bg=${t.bg}`);
    else ok(`pressing Light repaints the settings screen itself (${t.bg})`);

    await page.click('button[aria-pressed]:has-text("Macro")');
    await page.waitForTimeout(500);
    t = await readTheme(page);
    const wantDay = hexRgb(PALETTES.find((p) => p.key === "macro").day.accent);
    if (t.palette !== "macro" || !near(rgb(t.accent), wantDay)) fail(`picking the Macro palette in light mode gave data-palette=${t.palette}, --accent=${t.accent} (wanted ${PALETTES.find((p) => p.key === "macro").day.accent})`);
    else ok(`picking a palette applies its LIGHT half (${t.accent})`);

    // And it survives a reload, which is the only proof the write happened.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    t = await readTheme(page);
    if (t.palette !== "macro" || t.theme !== "light") fail(`the choice did not persist: data-palette=${t.palette}, data-theme=${t.theme}`);
    else ok("the choice survives a reload");
    await page.close();
  }
}

await browser.close();
console.log(bad === 0 ? "\nshell chrome: all checks passed" : `\nshell chrome: ${bad} check(s) failed`);
process.exit(bad === 0 ? 0 : 1);
