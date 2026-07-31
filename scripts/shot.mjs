// Screenshot a surface at phone size, so a layout complaint can be checked
// against a picture rather than against a guess.
//   TOOL=system node scripts/shot.mjs out.png
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://127.0.0.1:4178";
const TOOL = process.env.TOOL || "system";
const OUT = process.argv[2] || "shot.png";

const future = Math.floor(Date.now() / 1000) + 3600;
const session = {
  access_token: "t", token_type: "bearer", expires_in: 3600, expires_at: future, refresh_token: "r",
  user: { id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated", email: "stub@example.com", app_metadata: {}, user_metadata: {}, created_at: new Date(0).toISOString() },
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3 });
await page.addInitScript(([s]) => {
  for (const k of ["sb-stub-auth-token", "sb-localhost-auth-token"]) { try { localStorage.setItem(k, JSON.stringify(s)); } catch {} }
}, [session]);
await page.route("**/*", (route) => {
  const url = route.request().url();
  if (url.startsWith(BASE)) return route.continue();
  if (/\/rest\/v1\//i.test(url)) return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  if (/\/auth\/v1\//i.test(url)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: session.user, session }) });
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
});
await page.goto(`${BASE}/#/${TOOL}`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: OUT, fullPage: false });
console.log("wrote", OUT);
await browser.close();
