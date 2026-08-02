// ─── The tool row, MEASURED ──────────────────────────────────────────────────
//
// WHY THIS EXISTS. The tool row shipped to production collapsed into a vertical
// ladder on every desktop width — five tools stacked in a 100px column, the bar
// 177px tall instead of 52, overlapping the page beneath it. The unit suite was
// green, and not by accident:
//
//   apps/shell/src/__tests__/chrome.test.js asserted the SOURCE TEXT contained
//   "auto-fit". It did. `repeat(auto-fit, minmax(92px, 1fr))` was right there in
//   the file, and it rendered one column, because the grid had `width: 100%`
//   inside a `flex: 0 1 auto` parent. A percentage against a shrink-to-fit
//   parent is a cycle; CSS resolves it by taking the child's min-content, which
//   for that template is a single column. Every character the test looked for
//   was present in the code that was broken.
//
// A layout bug is only visible to something that does layout. So: build it,
// load it signed in, and measure the computed geometry at real widths. Same
// posture as scripts/smoke.mjs and scripts/nav-check.mjs, which exist for the
// same reason — see smoke.mjs's header for the three other blind spots that
// put this harness in the repo.
//
//   npm run build && npx serve -l 4178 apps/shell/dist   (or any static server)
//   node scripts/toolrow-check.mjs
//
// BASE, CHROMIUM and TOOLS override the defaults.
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://127.0.0.1:4178";
const future = Math.floor(Date.now() / 1000) + 3600;
const session = {
  access_token: "t", token_type: "bearer", expires_in: 3600, expires_at: future, refresh_token: "r",
  user: { id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated", email: "stub@example.com", app_metadata: {}, user_metadata: {}, created_at: new Date(0).toISOString() },
};

// These tools start hidden on every navigation surface.
const ORDER = (process.env.TOOLS || "zts,clarify,runway,macro,looper,business,sync,ideas").split(",");
const HIDDEN = ["macro", "looper", "business"];
const VISIBLE = ORDER.filter((app) => !HIDDEN.includes(app));

// MOBILE ONLY, NOW. The wrapping tool row was the desktop layout when this
// harness was written; the tools have since moved to a left rail above 768px,
// and scripts/rail-check.mjs measures that — including that the rail is what
// renders, so "no .toolrow on desktop" is asserted there rather than being
// silently unowned by both files.
//
// Phones use one compact row of shared tool glyphs. System → Tools controls
// which ones render here as well as in the desktop rail.
const DESKTOP = [];
const MOBILE = [360, 393, 414];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(([s, order, hidden]) => {
  for (const k of ["sb-stub-auth-token", "sb-localhost-auth-token"]) { try { localStorage.setItem(k, JSON.stringify(s)); } catch {} }
  try { localStorage.setItem("cc_tab_prefs", JSON.stringify({ order, hidden })); } catch {}
}, [session, ORDER, HIDDEN]);
await page.route("**/*", (r) => {
  const u = r.request().url();
  if (u.startsWith(BASE)) return r.continue();
  if (/\/rest\/v1\//i.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  if (/\/auth\/v1\//i.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: session.user, session }) });
  return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
});

await page.goto(`${BASE}/#/zts`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(1500);

async function expectFolded(bodyId, label) {
  const control = await page.$(`[aria-controls="${bodyId}"]`);
  if (!control) { fail(`${label}: disclosure control was not rendered`); return; }
  const open = await control.getAttribute("aria-expanded");
  if (open !== "false") fail(`${label}: defaulted open (aria-expanded=${open})`);
  else ok(`${label}: defaults folded while its live status remains in the header`);
}

/** Geometry of the row as the browser actually laid it out. */
const measure = () => page.evaluate(() => {
  const row = document.querySelector(".toolrow");
  if (!row) return null;
  const btns = [...row.querySelectorAll("button")];
  // Distinct top edges = how many lines the tools actually occupy. Counting
  // grid columns would not survive the switch to flex; counting rendered rows
  // is the thing we actually care about and is layout-mode agnostic.
  const lines = new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top))).size;
  const clipped = btns.filter((b) => {
    const s = b.lastElementChild;
    return s && s.scrollWidth > s.clientWidth + 1;
  }).length;
  const bar = row.closest("div[style*='min-height']") || row.parentElement?.parentElement;
  return {
    tools: btns.length,
    lines,
    clipped,
    rowW: Math.round(row.getBoundingClientRect().width),
    rowH: Math.round(row.getBoundingClientRect().height),
    barH: bar ? Math.round(bar.getBoundingClientRect().height) : null,
    shellBar: getComputedStyle(document.documentElement).getPropertyValue("--shell-bar").trim(),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    smallest: Math.min(...btns.map((b) => Math.round(b.getBoundingClientRect().height))),
    narrowest: Math.min(...btns.map((b) => Math.round(b.getBoundingClientRect().width))),
    icons: btns.filter((b) => b.querySelector("svg")).length,
  };
});

let bad = 0;
const fail = (msg) => { bad++; console.log(`FAIL  ${msg}`); };
const ok = (msg) => console.log(`ok    ${msg}`);

await expectFolded("zts-engine-body", "ZTS writer");
await page.setViewportSize({ width: 393, height: 852 });
await page.click('.toolrow button[aria-label="Clarify"]');
await page.waitForTimeout(700);
await expectFolded("clarify-engine-body", "Clarify outbound engine");
await page.click('.toolrow button[aria-label="ZTS"]');
await page.waitForTimeout(500);

for (const width of [...DESKTOP, ...MOBILE]) {
  const mobile = width < 768;
  await page.setViewportSize({ width, height: mobile ? 852 : 900 });
  await page.waitForTimeout(180);
  const m = await measure();
  if (!m) { fail(`${width}px: no .toolrow in the document at all`); continue; }

  const label = `${width}px`;
  const detail = `lines=${m.lines} rowW=${m.rowW} barH=${m.barH} clipped=${m.clipped} overflow=${m.overflow}`;

  // THE REGRESSION. On a desktop the whole point of the bar is one glance, and
  // the shipped bug put every tool on its own line. Two lines is the honest
  // answer for eight tools in a narrow window; five is a collapse.
  const maxLines = mobile ? 1 : 2;
  if (m.lines > maxLines) fail(`${label}: tools wrapped onto ${m.lines} lines (max ${maxLines}) — ${detail}`);
  else ok(`${label}: ${m.lines} line${m.lines > 1 ? "s" : ""} — ${detail}`);

  // The bar was 177px tall when it collapsed, against 51 when it is right.
  // These ceilings are set from measurement, not taste, and deliberately leave
  // room: --shell-bar exists so the height CAN change, and a test that pins it
  // exactly would fail on every legitimate tweak while catching nothing extra.
  //   desktop  51 correct · 90 ceiling  · 177 was the bug
  //   mobile  50 correct (brand + icon dock + System in one row) · 72 ceiling
  const maxBar = mobile ? 72 : 90;
  if (m.barH != null && m.barH > maxBar) fail(`${label}: bar is ${m.barH}px tall (max ${maxBar}) — the row is stacking`);

  // Labels belong to desktop; the phone dock owes one glyph per tool instead.
  if (!mobile && m.clipped > 0) fail(`${label}: ${m.clipped} tool label(s) truncated to ellipsis`);
  if (mobile && m.icons !== VISIBLE.length) fail(`${label}: ${m.icons} tool glyph(s) rendered, expected ${VISIBLE.length}`);

  // No tool may be pushed off the side of the page.
  if (m.overflow > 0) fail(`${label}: page scrolls sideways by ${m.overflow}px`);

  if (m.tools !== VISIBLE.length) fail(`${label}: ${m.tools} tools rendered, expected ${VISIBLE.length}`);

  // Touch targets on the platform where they are touched.
  if (mobile && m.smallest < 36) fail(`${label}: smallest tool button is ${m.smallest}px tall`);
  if (mobile && m.narrowest < 30) fail(`${label}: narrowest tool button is ${m.narrowest}px wide`);

  // --shell-bar has to track the real height or ten call sites across six tools
  // that read `calc(100vh - var(--shell-bar))` are wrong by the difference.
  if (m.shellBar && m.barH != null) {
    const published = Number.parseInt(m.shellBar, 10);
    if (Number.isFinite(published) && Math.abs(published - m.barH) > 2) {
      fail(`${label}: --shell-bar says ${published}px, bar measures ${m.barH}px`);
    }
  }
}

// A visibility switch has to move the phone dock, not only write localStorage.
await page.setViewportSize({ width: 393, height: 852 });
await page.click('button[aria-label="System — ops, tools, usage, intelligence and theme"]');
await page.waitForTimeout(300);
await page.click('[role="tab"]:has-text("Tools")');
await page.waitForTimeout(300);
const macroSwitch = '[role="switch"][aria-label="Show Macro in tool navigation"]';
if (!(await page.$(macroSwitch))) {
  fail("393px: no Show Macro switch in System → Tools");
} else {
  await page.click(macroSwitch);
  await page.waitForTimeout(300);
  const shown = await measure();
  if (shown?.tools !== VISIBLE.length + 1 || !(await page.$('.toolrow button[aria-label^="Macro"]'))) {
    fail(`393px: showing Macro did not add it to the phone dock (${shown?.tools ?? "no"} tools)`);
  } else ok("393px: showing Macro immediately adds it to the phone dock");

  await page.click('[role="switch"][aria-label="Hide Macro in tool navigation"]');
  await page.waitForTimeout(300);
  const hidden = await measure();
  if (hidden?.tools !== VISIBLE.length || await page.$('.toolrow button[aria-label^="Macro"]')) {
    fail(`393px: hiding Macro did not remove it from the phone dock (${hidden?.tools ?? "no"} tools)`);
  } else ok("393px: hiding Macro immediately removes it from the phone dock");
}

await browser.close();
console.log(bad === 0 ? "\ntool row: all checks passed" : `\ntool row: ${bad} check(s) failed`);
process.exit(bad === 0 ? 0 : 1);
