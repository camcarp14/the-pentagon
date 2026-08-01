// Exploratory: dump the top of each tool's content column so anchors can be chosen.
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://127.0.0.1:4178";
const future = Math.floor(Date.now() / 1000) + 3600;
const session = {
  access_token: "t", token_type: "bearer", expires_in: 3600, expires_at: future, refresh_token: "r",
  user: { id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated", email: "stub@example.com", app_metadata: {}, user_metadata: {}, created_at: new Date(0).toISOString() },
};
const ORDER = ["zts", "clarify", "runway", "macro", "looper", "business", "sync", "ideas"];
const TOOLS = (process.env.TOOLS || ORDER.join(",")).split(",");

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(([s, order]) => {
  for (const k of ["sb-stub-auth-token", "sb-localhost-auth-token"]) { try { localStorage.setItem(k, JSON.stringify(s)); } catch {} }
  try { localStorage.setItem("cc_tab_prefs", JSON.stringify({ order, hidden: [] })); } catch {}
}, [session, ORDER]);
await page.route("**/*", (r) => {
  const u = r.request().url();
  if (u.startsWith(BASE)) return r.continue();
  if (/\/rest\/v1\//i.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  if (/\/auth\/v1\//i.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: session.user, session }) });
  return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
});

for (const tool of TOOLS) {
  await page.goto(`${BASE}/#/${tool}`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(2200);
  const out = await page.evaluate(() => {
    const root = document.querySelector("[data-app]");
    const tabs = [...document.querySelectorAll('[role="tab"], .seg-opt, .dock-tab, [role="tablist"] button')].map((b) => ({
      t: (b.textContent || b.getAttribute("aria-label") || "").trim().slice(0, 24),
      cls: String(b.className).slice(0, 30),
      sel: b.getAttribute("aria-selected"),
      top: Math.round(b.getBoundingClientRect().top),
    }));
    const heads = [...document.querySelectorAll("h1,h2,h3")].map((h) => ({
      tag: h.tagName, cls: String(h.className), txt: (h.textContent || "").trim().slice(0, 40),
      top: Math.round(h.getBoundingClientRect().top), h: Math.round(h.getBoundingClientRect().height),
    }));
    const walk = [];
    const seen = new Set();
    const rec = (el, d) => {
      if (d > 6 || walk.length > 70) return;
      for (const c of el.children) {
        const r = c.getBoundingClientRect();
        if (r.height === 0 || r.top > 460) continue;
        if (!seen.has(c)) { seen.add(c); walk.push({ d, tag: c.tagName, cls: String(c.className).slice(0, 40), top: Math.round(r.top), h: Math.round(r.height), txt: (c.textContent || "").trim().replace(/\s+/g, " ").slice(0, 34) }); }
        rec(c, d + 1);
      }
    };
    if (root) rec(root, 0);
    return { tabs, heads, walk };
  });
  console.log(`\n════ ${tool} ════`);
  console.log("TABS:", JSON.stringify(out.tabs));
  console.log("HEADS:", JSON.stringify(out.heads));
  console.log("OUTLINE:");
  for (const w of out.walk) console.log(`  ${"  ".repeat(w.d)}${w.tag}.${w.cls} @${w.top} h${w.h} "${w.txt}"`);
}
await browser.close();
