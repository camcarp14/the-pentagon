// ─── The repeated page heading, MEASURED ─────────────────────────────────────
//
// WHY THIS EXISTS. The operator's complaint was "i dont need each subtab name to
// repeat itself, i can see what i'm selected into, so this should move
// everything closer to the top". That is two claims, and only the first is
// visible to a source-text assertion:
//
//   1. the heading that repeated the lit nav pill is gone, and
//   2. what was under it MOVED UP by the space that heading occupied.
//
// A grep can prove (1). It cannot prove (2), and (2) is the request. Delete an
// <h1> out of a flex row that still holds a button and nothing moves at all.
// Delete it out of a wrapper whose `margin-bottom` survives and you reclaim the
// glyphs but leave the gap. Both of those pass every `not.toContain` you can
// write, and neither is what was asked for. Same lesson as
// scripts/toolrow-check.mjs — read its header — where a green test asserted the
// source contained "auto-fit" while the bar shipped as a vertical ladder.
//
// So: build it, load it signed in, and measure where content actually sits.
//
//   npm run build && npx serve -l 4178 apps/shell/dist
//   node scripts/heading-check.mjs
//   node scripts/heading-check.mjs --json > after.json
//   node scripts/heading-check.mjs --compare before.json after.json
//
// --compare is the point of the file. `anchorTop` alone is a number with no
// opinion; the reclaimed space is the DIFFERENCE between two builds, so the
// honest workflow is to measure the old bundle before touching the source.
//
// THE ANCHOR. Each view names one piece of its own content that exists in BOTH
// builds — usually the descriptive line that was under the deleted title, which
// is exactly the thing that had to move up. Its viewport y before minus its
// viewport y after IS the reclaimed space, with no inference in between. A view
// with no anchor is one where nothing was removed; it is still visited, because
// the repeated-heading check below has to run everywhere, not only where a fix
// landed.
//
// BASE, CHROMIUM and TOOLS override the defaults. The build being served needs
// VITE_SUPABASE_URL=https://stub.supabase.co in the repo-root .env or the shell
// paints its sign-in form and every tool measures as absent.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4178";

if (process.argv[2] === "--compare") {
  const key = (r) => `${r.tool}/${r.tab}`;
  const b = Object.fromEntries(JSON.parse(readFileSync(process.argv[3], "utf8")).map((r) => [key(r), r]));
  const a = Object.fromEntries(JSON.parse(readFileSync(process.argv[4], "utf8")).map((r) => [key(r), r]));
  let sank = 0, missing = 0;
  console.log(`${"tool/tab".padEnd(28)}${"before".padStart(7)}${"after".padStart(7)}${"reclaimed".padStart(11)}  anchor`);
  for (const k of Object.keys(a)) {
    const B = b[k], A = a[k];
    if (!B) { console.log(`${k.padEnd(28)}  (new row)`); continue; }
    if (A.anchorTop == null || B.anchorTop == null) {
      if (A.anchor) { missing++; console.log(`${k.padEnd(28)}  ANCHOR NOT FOUND ("${A.anchor}") — the measurement is void, not zero`); }
      else console.log(`${k.padEnd(28)}${"—".padStart(7)}${"—".padStart(7)}${"n/a".padStart(11)}  nothing was removed here`);
      continue;
    }
    const d = B.anchorTop - A.anchorTop;
    if (d < 0) sank++;
    console.log(`${k.padEnd(28)}${String(B.anchorTop).padStart(7)}${String(A.anchorTop).padStart(7)}${`${d >= 0 ? "+" : ""}${d}px`.padStart(11)}  "${A.anchor}"`);
  }
  const repeats = Object.values(a).filter((r) => r.repeatedHeading);
  for (const r of repeats) console.log(`STILL REPEATS  ${key(r)}: <${r.repeatedTag}>${r.repeatedHeading}</${r.repeatedTag}> under a pill reading "${r.litText}"`);
  console.log(`\n${repeats.length} view(s) still open with a heading naming the lit pill; ${sank} moved DOWN; ${missing} anchor(s) not found.`);
  process.exit(repeats.length === 0 && sank === 0 && missing === 0 ? 0 : 1);
}

const future = Math.floor(Date.now() / 1000) + 3600;
const session = {
  access_token: "t", token_type: "bearer", expires_in: 3600, expires_at: future, refresh_token: "r",
  user: { id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated", email: "stub@example.com", app_metadata: {}, user_metadata: {}, created_at: new Date(0).toISOString() },
};

// Tabs are clicked BY INDEX, never by their text. The text is exactly what half
// of this change alters ("seo" → "SEO"), so a text selector would miss on one of
// the two builds being compared and take the measurement down with it.
//
// `business` is absent on purpose and it is not an oversight: it has no sub-nav
// at all, so it has no sub-tab name to repeat and nothing here to reclaim.
const TOOLS = {
  zts: {
    nav: ".seg[role=tablist] .seg-opt",
    tabs: [
      ["Mission", "The writer"],
      ["Creators", "Find, contact, and track YouTube creators"],
      ["Studio", "Generate Shorts and every asset"],
      ["SEO", "The agent drafts search content on a cadence"],
      // The DNA tab's header is an absolutely-positioned strip floating over a
      // full-bleed canvas: there is no vertical space under it to reclaim, so
      // this row exists only to prove the canvas still paints.
      ["DNA", "The living mind behind the machine"],
    ],
  },
  clarify: {
    nav: ".co-nav-tabs .seg-opt",
    sub: ".co-subnav .seg-opt",
    tabs: [
      ["Today", "Outreach Pipeline"],
      ["Outreach", null],
      ["Inbound", "Audit requests from the Clarify Paid Search site"],
      ["Clients", null],
      ["DNA", null],
      ["Settings", "Product-level levers"],
    ],
    subAnchors: {
      // Analytics has TWO bodies and the browser can only reach one of them:
      // with no cards in the stubbed database it returns an EmptyState that
      // never had a heading, and the "Pipeline analytics" title lives on the
      // other side of `if (!hasData)`. Measured here it would report a
      // reassuring, meaningless zero. The heading's removal is asserted where it
      // can be — apps/clarify/src/__tests__/render.test.jsx renders this view
      // with a seeded pipeline — and this row is left anchorless on purpose.
      Analytics: null,
      Queue: "Everything the engine and the AI want to send",
      Sequences: "Steps wait, check their gate",
      Calendar: "Book meetings from your pipeline",
      Pipeline: null, Analyst: null, Accounts: null, Today: null,
    },
  },
  runway: {
    nav: ".rail .navgroup .nav-item",
    tabs: [
      // Board's title shared its row with the primary action, so the row — and
      // everything under it — does not move. The row is here to say that out
      // loud in the numbers rather than to claim a win.
      ["Board", "everything not closed"],
      ["Capture", "nothing is ever submitted on your behalf"],
      ["Insights", "Comp data:"],
      ["Profile", "Every captured role is scored against these criteria"],
    ],
  },
  macro: { nav: ".navbar .nav > button", tabs: [["Alts", null], ["Cockpit", null], ["Chart", null], ["Journal", null], ["Settings", null]] },
  looper: { nav: ".lp-nav > button", tabs: [["Run", null], ["Mission", null], ["Chat", null], ["Log", null]] },
  sync: {
    nav: ".sidebar .side-nav .side-item",
    // "0 open" and "on hand" are the count lines that survived the two deleted
    // titles — deliberately more than one word, because a one-word anchor like
    // "open" also matches the empty state further down the page and would
    // measure whichever the DOM walk reached first.
    tabs: [["Console", null], ["Day", null], ["Queue", "0 open"], ["Brief", "on hand"], ["Mind", null], ["Voice", null]],
  },
  ideas: { nav: ".seg[role=tablist] .seg-opt", tabs: [["Ideas", "What showed up on GitHub"], ["Saved", "What showed up on GitHub"], ["Skills", "What showed up on GitHub"]] },
};

// Headings that name their own tab and STAY, each with the reason. Written down
// rather than quietly excluded from the scan — an exception nobody can see is
// how the next repeated heading gets in.
//
//   zts/DNA, clarify/DNA — "ZTS DNA" / "Clarify DNA" label a full-bleed mind
//   canvas from an absolutely-positioned strip. Removing them reclaims no
//   vertical space (nothing is in flow under them) and leaves a <canvas> with no
//   accessible name at all. DESIGN.md §5 also has both tabs slated for
//   retirement behind the shell's Minds screen.
const KEPT = new Set(["zts/DNA", "clarify/DNA"]);

const WANTED = (process.env.TOOLS || Object.keys(TOOLS).join(",")).split(",");

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(([s, order]) => {
  for (const k of ["sb-stub-auth-token", "sb-localhost-auth-token"]) { try { localStorage.setItem(k, JSON.stringify(s)); } catch {} }
  try { localStorage.setItem("cc_tab_prefs", JSON.stringify({ order, hidden: [] })); } catch {}
  // SYNC shows its onboarding until this is set, and onboarding has no nav.
  try { localStorage.setItem("sync.state.v1", JSON.stringify({ settings: { onboarded: true } })); } catch {}
}, [session, Object.keys(TOOLS)]);
await page.route("**/*", (r) => {
  const u = r.request().url();
  if (u.startsWith(BASE)) return r.continue();
  if (/\/rest\/v1\//i.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  if (/\/auth\/v1\//i.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: session.user, session }) });
  return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
});

const measure = (navSel, anchor) => page.evaluate(([sel, needle]) => {
  const root = document.querySelector("[data-app]");
  if (!root) return null;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.height > 0 && r.width > 0 && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const lit = [...document.querySelectorAll(sel)].find(
    (b) => b.getAttribute("aria-selected") === "true" || b.getAttribute("aria-current") === "page" || /(^| )(active|on)( |$)/.test(b.className),
  );
  const litText = lit ? (lit.textContent || "").trim() : "";

  // The anchor: the DEEPEST visible element carrying the text, so the number is
  // the top of the line itself and not of some wrapper three levels up that a
  // sibling could be holding open.
  let anchorTop = null;
  if (needle) {
    let best = null;
    for (const el of root.querySelectorAll("*")) {
      if (!(el.textContent || "").includes(needle) || !vis(el)) continue;
      if (!best || el.contains(best) === false) best = el; // later, deeper match wins
      if (best.contains(el)) best = el;
    }
    if (best) anchorTop = Math.round(best.getBoundingClientRect().top);
  }

  // The regression: a visible heading in the tool's first screenful, one of
  // whose WORDS is the word on the lit pill. Word-wise, not substring — "Day"
  // is inside "Today" and a substring test calls that a repeat when it is not.
  const words = (s) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const litWords = words(litText);
  let repeatedHeading = "", repeatedTag = "";
  for (const h of root.querySelectorAll("h1, h2")) {
    if (!vis(h) || h.getBoundingClientRect().top > 320) continue;
    const t = (h.textContent || "").trim();
    if (litWords.size && [...words(t)].some((w) => litWords.has(w))) { repeatedHeading = t; repeatedTag = h.tagName.toLowerCase(); }
  }
  return { litText, anchorTop, repeatedHeading, repeatedTag };
}, [navSel, anchor]);

const rows = [];
for (const tool of WANTED) {
  const spec = TOOLS[tool];
  if (!spec) continue;
  await page.goto(`${BASE}/#/${tool}`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(2000);
  for (let i = 0; i < spec.tabs.length; i++) {
    const [tab, anchor] = spec.tabs[i];
    const items = page.locator(spec.nav);
    if ((await items.count()) <= i) { rows.push({ tool, tab, anchor, anchorTop: null, note: "nav item not found" }); continue; }
    await items.nth(i).click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(700);
    rows.push({ tool, tab, anchor, ...((await measure(spec.nav, anchor)) || { anchorTop: null, note: "no [data-app]" }) });
    if (spec.sub) {
      const n = await page.locator(spec.sub).count();
      for (let j = 1; j < n; j++) {
        await page.locator(spec.sub).nth(j).click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(700);
        const label = ((await page.locator(spec.sub).nth(j).textContent().catch(() => "")) || `sub${j}`).trim();
        const a = spec.subAnchors?.[label] ?? null;
        rows.push({ tool, tab: `${tab}·${label}`, anchor: a, ...((await measure(spec.sub, a)) || { anchorTop: null }) });
      }
    }
  }
}
await browser.close();

for (const r of rows) if (KEPT.has(`${r.tool}/${r.tab}`)) { r.keptHeading = r.repeatedHeading; r.repeatedHeading = ""; }

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(`${"tool/tab".padEnd(28)}${"anchorTop".padStart(10)}   lit pill / finding`);
  for (const r of rows) {
    const flag = r.repeatedHeading ? `REPEATS "${r.repeatedHeading}"` : r.keptHeading ? `kept (allow-listed): "${r.keptHeading}"` : "";
    console.log(`${`${r.tool}/${r.tab}`.padEnd(28)}${String(r.anchorTop ?? (r.anchor ? "NOT FOUND" : "—")).padStart(10)}   ${r.litText || ""}${flag ? ` · ${flag}` : ""}`);
  }
  const bad = rows.filter((r) => r.repeatedHeading);
  console.log(bad.length === 0 ? "\nno view opens with a heading naming its own lit pill" : `\n${bad.length} view(s) still name the pill`);
  process.exit(bad.length === 0 ? 0 : 1);
}
