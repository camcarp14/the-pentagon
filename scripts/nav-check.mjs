// Reproduce the reported bug: in Clarify, clicking a sub-tab must not change
// which TOOL is open. Runs against the built bundle.
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://127.0.0.1:4178";
const future = Math.floor(Date.now() / 1000) + 3600;
const session = {
  access_token: "t", token_type: "bearer", expires_in: 3600, expires_at: future, refresh_token: "r",
  user: { id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated", email: "stub@example.com", app_metadata: {}, user_metadata: {}, created_at: new Date(0).toISOString() },
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
await page.addInitScript(([s]) => {
  for (const k of ["sb-stub-auth-token", "sb-localhost-auth-token"]) { try { localStorage.setItem(k, JSON.stringify(s)); } catch {} }
  // Reproduce the reporter's toggle order: Runway first, so a wrong fallback is
  // visible rather than accidentally landing back on the tool you were in.
  try { localStorage.setItem("cc_tab_prefs", JSON.stringify({ order: ["runway", "zts", "clarify", "macro", "looper", "business", "sync", "ideas"], hidden: ["looper", "business"] })); } catch {}
}, [session]);
await page.route("**/*", (r) => {
  const u = r.request().url();
  if (u.startsWith(BASE)) return r.continue();
  if (/\/rest\/v1\//i.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  if (/\/auth\/v1\//i.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: session.user, session }) });
  return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
});

const activeTool = () => page.evaluate(() => document.querySelector("[data-app]")?.getAttribute("data-app"));

let bad = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}: ${got}${ok ? "" : `  (expected ${want})`}`);
};

await page.goto(`${BASE}/#/clarify`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(2500);
check("landed in clarify", await activeTool(), "clarify");

// The reported action: tap Analytics in Clarify's Today/Analytics segment.
await page.$$eval("button", (els) => els.find((e) => e.textContent.trim() === "Analytics")?.click());
await page.waitForTimeout(1500);
check("still in clarify after tapping Analytics", await activeTool(), "clarify");
console.log(`      hash is now ${await page.evaluate(() => location.hash)}`);

// And it has to survive a reload, which is the whole point of putting it in the URL.
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);
check("still in clarify after reload", await activeTool(), "clarify");

// The shell's own navigation must still work.
await page.evaluate(() => { location.hash = "#/zts"; });
await page.waitForTimeout(1500);
check("shell can still switch tools by hash", await activeTool(), "zts");

await browser.close();
console.log(bad ? `\n${bad} check(s) failed` : "\nnavigation is correct");
process.exit(bad ? 1 : 0);
