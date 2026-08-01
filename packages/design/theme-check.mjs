// ─── LIGHT MODE, MEASURED IN A BROWSER ───────────────────────────────────────
//
// WHY THIS EXISTS, and it is the same reason scripts/toolrow-check.mjs exists.
//
// Three app stylesheets froze their own dark ground in a `:root` block, so a
// light Pentagon rendered dark chrome under light content. Every property of
// that bug is invisible to a source-text assertion:
//
//   · `--card: #141B2C` is a perfectly good declaration. Nothing about the TEXT
//     is wrong. What is wrong is which element it lands on and what wins there,
//     and that is a cascade question — the browser is the only thing that
//     answers it.
//   · The fix is `--card: var(--surface)`. A test that greps for that string
//     passes whether or not `--surface` resolves to anything at that point in
//     the tree, and an unresolved var() takes the whole declaration with it,
//     silently. This repo has shipped exactly that failure (see
//     packages/design/__tests__/theme.test.js's header).
//   · Contrast is a property of two COMPUTED colours. `color: var(--up)` on
//     `background: var(--card)` tells you nothing at all about legibility.
//
// So: build it, load it signed in, drive the real theme control, mount each of
// the three tools, and read `getComputedStyle` off elements that are actually
// on screen. Every number below is measured, not asserted from a table.
//
//   npm run build && npx serve -l 4179 apps/shell/dist
//   node packages/design/theme-check.mjs
//
// BASE and CHROMIUM override the defaults.
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://127.0.0.1:4179";
const future = Math.floor(Date.now() / 1000) + 3600;
const session = {
  access_token: "t", token_type: "bearer", expires_in: 3600, expires_at: future, refresh_token: "r",
  user: { id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated", email: "stub@example.com", app_metadata: {}, user_metadata: {}, created_at: new Date(0).toISOString() },
};

// The three sheets this file was written for, and the selector that proves each
// tool is actually ON SCREEN — a lazy chunk plus an auth round trip means a
// fixed sleep measures the shell's skeleton about a third of the time, and a
// skeleton passes every check in here for the wrong reason.
//
// ZTS is the CONTROL: it ships no stylesheet of its own, so if ZTS fails, the
// fault is in the shell or the token layer and not in these three.
const TOOLS = [
  { key: "macro", root: ".macro-root" },
  { key: "runway", root: ".shell .rail" },
  { key: "sync", root: ".sy-root" },
  { key: "zts", root: "[data-app='zts'] main, [data-app='zts']" },
];

// ── colour maths, on COMPUTED values ────────────────────────────────────────
// getComputedStyle returns `rgb()` / `rgba()` / `color(srgb …)`. Anything that
// still has alpha has to be composited against what is behind it before a
// contrast ratio means anything — a 6% ink wash is not "almost black".
// A COMPUTED background is rgb()/rgba(); a custom property read back with
// getPropertyValue is whatever the author wrote, so `--up` comes back as a hex.
// Both shapes have to parse or half the checks quietly report "not a colour".
const parse = (s) => {
  s = (s || "").trim();
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (h) {
    const v = h[1].length === 3 ? h[1].split("").map((c) => c + c).join("") : h[1];
    return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16), a: 1 };
  }
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/i.exec(s);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
};
const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});
const srgb = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = (c) => 0.2126 * srgb(c.r) + 0.7152 * srgb(c.g) + 0.0722 * srgb(c.b);
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();

// ── KNOWN OUTSTANDING, REGISTERED RATHER THAN HIDDEN ────────────────────────
// Two dark grounds live in files this harness's author does not own. They are
// listed here so a NEW regression is distinguishable from a documented gap —
// and every one of them is also checked in the opposite direction: if the
// symptom stops appearing, the harness says so and asks for the entry to be
// deleted. An allowlist that can go stale is how a fixed bug gets a permanent
// excuse.
const OUTSTANDING = [
  { match: /light\/runway: \.rail paints/, owner: "apps/runway/src/Root.jsx — EMBED_OVERRIDES pins `.rail { background: rgba(11,15,26,0.78) }` for the desktop embed" },
  { match: /light\/runway: \.rail text/, owner: "apps/runway/src/Root.jsx — same rule; the ink is correct, the bar under it is not" },
  { match: /light\/zts: <body> is/, owner: "apps/zts/src/App.jsx:133 — injects `body { background-color: #0B0F1A; … }` from a JS template string" },
  // The three below are DARK, pre-date this work, and are a product call rather
  // than a theming one. Macro's cockpit inks small text with --down, --crit and
  // --serious, and on a well (#1B2438) they measure 3.48 / 3.30 / 2.99 — under
  // AA for small text, though all three clear the 3:1 mark floor they were
  // originally validated at (the sheet's header says "six-checks", which is a
  // CATEGORICAL validation, and it passes). Lifting them to 4.5 on that ground
  // turns crimson into pink (#E36C88) and burnt orange into tangerine
  // (#F2682F): a visible change to the shipping trading screen, made to values
  // nobody asked to change, on a release about light mode. Registered rather
  // than hidden, with the numbers, so it is a decision someone can take on
  // purpose — and the light halves beside them clear 4.5 on their own hardest
  // ground, so this is the dark room's debt alone.
  { match: /dark\/macro: --down /, owner: "apps/macro/src/styles.css — DARK --down 3.48:1 on the well; product call, see the note beside the data block" },
  { match: /dark\/macro: --crit /, owner: "apps/macro/src/styles.css — DARK --crit 3.30:1 on the well; same call" },
  { match: /dark\/macro: --serious /, owner: "apps/macro/src/styles.css — DARK --serious 2.99:1 on the well; same call, and the worst of the three" },
];
const seen = new Set();

let bad = 0;
const fail = (msg) => {
  const known = OUTSTANDING.find((o) => o.match.test(msg));
  if (known) { seen.add(known.owner); console.log(`KNOWN ${msg}\n        ↳ ${known.owner}`); return; }
  bad++; console.log(`FAIL  ${msg}`);
};
const ok = (msg) => console.log(`ok    ${msg}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// Signed in, and every tool VISIBLE. tabPrefs.js hides macro/looper/business by
// default, so without this the macro route resolves to a different tool and the
// whole macro half of this harness measures ZTS while reporting "macro".
await page.addInitScript((s) => {
  for (const k of ["sb-stub-auth-token", "sb-localhost-auth-token"]) { try { localStorage.setItem(k, JSON.stringify(s)); } catch {} }
  try {
    localStorage.setItem("cc_tab_prefs", JSON.stringify({
      order: ["zts", "clarify", "runway", "macro", "looper", "business", "sync", "ideas"], hidden: [],
    }));
  } catch {}
}, session);
await page.route("**/*", (r) => {
  const u = r.request().url();
  if (u.startsWith(BASE)) return r.continue();
  if (/\/rest\/v1\//i.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  if (/\/auth\/v1\//i.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: session.user, session }) });
  return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
});

/** Set the operator's stored preference and reload. This is the SAME key the
 *  System screen writes (apps/shell/src/themePrefs.js) — driving the store
 *  rather than the widget keeps this harness independent of the picker's
 *  markup, which another agent owns, while still exercising the real path. */
const setMode = async (mode) => {
  await page.evaluate((m) => localStorage.setItem("cc_theme_prefs", JSON.stringify({ palette: "match", mode: m })), mode);
};

/** Everything worth measuring on one tool in one mode, read off live elements. */
const probe = (rootSel) => page.evaluate((sel) => {
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const root = document.documentElement;
  const wrap = document.querySelector("[data-app]");
  // The tool's own outermost element — the only place where "did the mapping
  // reach this app?" has an answer. Falling back to the wrapper would make the
  // token check pass on the shell's own variables and prove nothing.
  const app = document.querySelector(sel) || wrap;
  // The topmost painted background in the tool's own subtree that is not
  // transparent — this is what a card or a bar is actually drawn on.
  const painted = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return { sel, bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color };
  };
  const varOf = (el, name) => (el ? getComputedStyle(el).getPropertyValue(name).trim() : "");
  return {
    htmlTheme: root.getAttribute("data-theme"),
    htmlScheme: cs(root).colorScheme,
    appScheme: app ? cs(app).colorScheme : null,
    bodyBg: cs(document.body).backgroundColor,
    wrapBg: wrap ? cs(wrap).backgroundColor : null,
    wrapInk: wrap ? cs(wrap).color : null,
    appBg: app ? cs(app).backgroundColor : null,
    // Every custom property this exercise is about, resolved AT THE TOOL'S ROOT
    // — which is the only place the question "did the mapping reach it?" has an
    // answer. An empty string here means the var() chain broke.
    tokens: Object.fromEntries(
      ["--bg", "--surface", "--ink", "--card", "--card-2", "--bg-elev", "--ink-2", "--ink-3",
       "--up", "--down", "--mstr", "--btc", "--good", "--warn", "--crit", "--serious",
       "--text", "--dim", "--subtle", "--purple", "--pink", "--shadow-card", "--shadow-1"]
        .map((k) => [k, varOf(app, k)]),
    ),
    // Real painted furniture: the nav/rail bar, a card, a meter track.
    bars: [".nav", ".navbar", ".rail", ".dock", ".side-nav"].map(painted).filter(Boolean),
    cards: [".card", ".kcard", ".alt-bar", ".sy-root .card"].map(painted).filter(Boolean),
    mounted: !!document.querySelector(sel),
  };
}, rootSel);

const AA_TEXT = 4.5;
const MARK = 3.0;

for (const mode of ["dark", "light"]) {
  console.log(`\n══ ${mode} ══`);
  for (const { key: tool, root: rootSel } of TOOLS) {
    // goto FIRST, then write the preference, then RELOAD. A goto that only
    // changes the hash is not a navigation, so the app would keep the prefs it
    // booted with and every "light" measurement would silently be a dark one —
    // a harness that cannot see the thing it exists to see.
    await page.goto(`${BASE}/#/${tool}`, { waitUntil: "networkidle", timeout: 45000 });
    await setMode(mode);
    await page.reload({ waitUntil: "networkidle", timeout: 45000 });
    try { await page.waitForSelector(rootSel, { timeout: 20000 }); } catch { /* reported below */ }
    await page.waitForTimeout(400);
    const m = await probe(rootSel);
    const tag = `${mode}/${tool}`;

    if (!m.mounted) { fail(`${tag}: "${rootSel}" never appeared — the tool did not mount, so nothing below was measured`); continue; }
    if (m.htmlTheme !== mode) { fail(`${tag}: <html data-theme> is "${m.htmlTheme}", expected "${mode}"`); continue; }

    const wrapBg = parse(m.wrapBg);
    const wrapInk = parse(m.wrapInk);
    if (!wrapBg || !wrapInk) { fail(`${tag}: the tool wrapper paints nothing measurable`); continue; }

    // 1. THE GROUND IS THE MODE'S GROUND. In light mode a dark wrapper is the
    //    whole bug: the sheet froze its own --bg and won.
    const light = lum(wrapBg) > 0.5;
    if (light !== (mode === "light")) fail(`${tag}: wrapper ground ${hex(wrapBg)} is ${light ? "light" : "dark"} in ${mode} mode`);
    else ok(`${tag}: ground ${hex(wrapBg)}`);

    // 2. BODY IS NOT PAINTED BY THE TOOL. Macro and Runway used to set
    //    `body { background: var(--bg) }`, which resolved above the themed
    //    wrapper and painted the document behind EVERY tool midnight.
    const bodyBg = parse(m.bodyBg);
    if (bodyBg && bodyBg.a > 0) {
      const bodyLight = lum(bodyBg) > 0.5;
      if (bodyLight !== (mode === "light")) fail(`${tag}: <body> is ${hex(bodyBg)} — a ${bodyLight ? "light" : "dark"} gutter in ${mode} mode`);
      else ok(`${tag}: body gutter ${hex(bodyBg)}`);
    }

    // 3. color-scheme reaches the tool, so form controls and scrollbars follow.
    if (m.appScheme && m.appScheme !== "normal" && !m.appScheme.includes(mode)) {
      fail(`${tag}: the tool's color-scheme is "${m.appScheme}" — native controls stay ${m.appScheme}`);
    }

    // 4. NO TOKEN IN THE CHAIN BROKE. An unresolved var() empties the property
    //    and the browser drops the declaration whole, with no error anywhere.
    const empty = Object.entries(m.tokens).filter(([, v]) => v === "").map(([k]) => k);
    const expected = { macro: ["--card", "--card-2", "--bg-elev", "--ink-2", "--ink-3", "--up", "--down", "--mstr", "--btc", "--crit", "--serious", "--shadow-1"], runway: ["--text", "--dim", "--subtle"], sync: ["--purple", "--pink", "--shadow-card"], zts: [] }[tool];
    const broken = expected.filter((k) => empty.includes(k));
    if (broken.length) fail(`${tag}: ${broken.join(", ")} resolved to nothing at the tool root`);
    else if (expected.length) ok(`${tag}: ${expected.length} mapped token(s) all resolve`);

    // 5. TEXT ON ITS OWN GROUND. Not the token table's idea of the ground —
    //    the composited colour of the element the text is actually inside.
    const inkC = contrast(wrapInk, wrapBg);
    if (inkC < 7) fail(`${tag}: body ink ${hex(wrapInk)} on ${hex(wrapBg)} = ${inkC.toFixed(2)}:1`);
    else ok(`${tag}: ink ${inkC.toFixed(2)}:1`);

    // 6. EVERY BAR AND CARD IS IN THE RIGHT ROOM. A bar that stayed dark under
    //    a light page is the literal "dark chrome under light content".
    for (const p of [...m.bars, ...m.cards]) {
      const c = parse(p.bg);
      if (!c || c.a === 0) continue;
      const flat = c.a < 1 ? over(c, wrapBg) : c;
      const isLight = lum(flat) > 0.5;
      if (isLight !== (mode === "light")) fail(`${tag}: ${p.sel} paints ${hex(flat)} — ${isLight ? "light" : "dark"} chrome in ${mode} mode`);
      else ok(`${tag}: ${p.sel} ${hex(flat)}`);
      const t = parse(p.color);
      if (t) {
        const tc = contrast(t.a < 1 ? over(t, flat) : t, flat);
        if (tc < MARK) fail(`${tag}: ${p.sel} text ${hex(t)} on ${hex(flat)} = ${tc.toFixed(2)}:1`);
      }
    }

    // 7. THE DATA COLOURS, ON THE GROUND THEY LAND ON. This is the check the
    //    whole exercise turns on: a polarity pair that measures 6.2:1 on
    //    midnight and 2.7:1 on paper is a chart nobody can read half the time.
    if (tool === "macro") {
      // THE HARDEST GROUND, not the page. Macro paints this set on the page, on
      // cards and inside wells, and which of the three is hardest FLIPS with the
      // mode: light-mode ink is dark so the darkest surface is the hard one,
      // dark-mode ink is light so the lightest is. Measuring against the page
      // alone is how a value passes here and is unreadable inside a card — the
      // exact mistake gen-themes.mjs documents having made once already.
      const grounds = [wrapBg, parse(m.tokens["--card"]), parse(m.tokens["--card-2"])].filter(Boolean);
      const hard = grounds.reduce((a, b) => ((mode === "light" ? lum(b) < lum(a) : lum(b) > lum(a)) ? b : a));
      // MARK (3:1) for the two the app draws as chart geometry — a series line
      // and a 10×3px legend swatch are graphical objects, not copy. AA_TEXT
      // (4.5:1) for the four it inks small text with.
      for (const [name, floor] of [
        ["--up", AA_TEXT], ["--down", AA_TEXT], ["--crit", AA_TEXT], ["--serious", AA_TEXT],
        ["--good", AA_TEXT], ["--warn", AA_TEXT],
        ["--mstr", MARK], ["--btc", MARK],
      ]) {
        const c = parse(m.tokens[name]);
        if (!c) { fail(`${tag}: ${name} is not a colour ("${m.tokens[name]}")`); continue; }
        const r = contrast(c, hard);
        if (r < floor) fail(`${tag}: ${name} ${hex(c)} on ${hex(hard)} = ${r.toFixed(2)}:1 (floor ${floor})`);
        else ok(`${tag}: ${name} ${hex(c)} ${r.toFixed(2)}:1 on ${hex(hard)}`);
      }
    }
  }
}

await browser.close();

// A registered gap that stopped reproducing is a stale excuse — say so loudly.
const stale = OUTSTANDING.filter((o) => !seen.has(o.owner));
for (const o of stale) { bad++; console.log(`FAIL  a KNOWN entry no longer reproduces — delete it: ${o.owner}`); }

console.log(bad === 0 ? "\ntheme: all checks passed in both modes" : `\ntheme: ${bad} check(s) failed`);
process.exit(bad === 0 ? 0 : 1);
