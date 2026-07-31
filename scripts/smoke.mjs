// ─── The browser smoke test ──────────────────────────────────────────────────
//
// WHY THIS EXISTS. ZTS shipped broken twice, and the unit suite was green both
// times — not by accident, but because of a structural blind spot that no amount
// of extra assertions closes:
//
//   · renderToStaticMarkup NEVER RUNS EFFECTS. Anything inside a useEffect —
//     which for these apps includes every injected stylesheet, every
//     subscription and every bit of DOM measurement — is simply not executed by
//     the component tests. The second outage was a stray backtick inside a CSS
//     template literal in a useEffect: still valid JavaScript, so the build was
//     green, and never evaluated, so 1,695 tests were green.
//   · JSX text is not JavaScript. `// a comment` in a children position is
//     TEXT. Three lines of source commentary rendered next to the logo on the
//     live sign-in screen for days.
//   · index.html is outside the module graph entirely. A <link> to Google Fonts
//     kept loading two retired typefaces long after every token table had moved
//     to the system stack — invisible to every test that reads source.
//
// All three are trivially visible the moment a real browser loads the page. So:
// load each tool, signed in, and fail on any uncaught error or console error.
//
// It stubs the network rather than reaching Supabase — SHAPE MATTERS, because a
// wrong-shaped stub produces failures that look exactly like real ones (an
// object where PostgREST returns an array shows up as "x.slice is not a
// function" deep in app code). Better a narrow honest stub than a broad lying one.
//
// Run:  npm run smoke        (builds, serves, checks every tool, tears down)

import { chromium } from "playwright";

const BASE = process.env.BASE || "http://127.0.0.1:4178";
const ONLY = process.env.TOOL ? [process.env.TOOL] : null;

const TOOLS = ONLY || ["zts", "clarify", "runway", "sync", "ideas", "macro", "looper", "business", "system"];

// Noise that says nothing about our code: the sandbox blocks outbound requests,
// and React's dev warnings are covered by the unit suite. Keep this list SHORT
// and specific — every entry here is a class of bug this test stops catching.
const IGNORE = [
  /net::ERR_/i,                       // no outbound network in CI/sandbox
  /Failed to load resource/i,         // ditto
  /\[@cc\/supabase\] Missing/i,       // expected under stub credentials
  /Missing VITE_SUPABASE/i,
];

const future = Math.floor(Date.now() / 1000) + 3600;
const session = {
  access_token: "stub.access.token", token_type: "bearer", expires_in: 3600, expires_at: future,
  refresh_token: "stub-refresh",
  user: {
    id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated",
    email: "stub@example.com", app_metadata: {}, user_metadata: {}, created_at: new Date(0).toISOString(),
  },
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});

const failures = [];

// The sign-in screen only renders when signed OUT, so a run that is always
// authenticated never looks at it — which is how three lines of source comment
// sat on it unnoticed. "signed-out" loads the shell with no session.
const SURFACES = [...TOOLS.map((t) => ({ tool: t, signedIn: true })), { tool: "signed-out", signedIn: false }];

for (const { tool, signedIn } of SURFACES) {
  const page = await browser.newPage();
  if (signedIn) {
    await page.addInitScript(([s]) => {
      for (const k of ["sb-stub-auth-token", "sb-localhost-auth-token"]) {
        try { localStorage.setItem(k, JSON.stringify(s)); } catch {}
      }
    }, [session]);
  }

  // DESIGN.md §3: no webfonts, system stack only. index.html is outside the
  // module graph, so no source-reading test sees a <link> there — but the
  // browser does, and a retired face that still loads still gets applied.
  const webfonts = [];
  page.on("request", (r) => {
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com|\.woff2?($|\?)/i.test(r.url())) webfonts.push(r.url());
  });

  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE)) return route.continue();
    if (/\/rest\/v1\//i.test(url)) return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    if (/\/auth\/v1\//i.test(url)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: session.user, session }) });
    if (/\.netlify\/functions|anthropic/i.test(url)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, content: [], usage: {} }) });
    return route.fulfill({ status: 200, contentType: "text/plain", body: "" });
  });

  const errs = [];
  page.on("pageerror", (e) => errs.push(`uncaught: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errs.push(`console: ${m.text()}`); });

  const hash = signedIn ? `#/${tool}` : "";
  try {
    await page.goto(`${BASE}/${hash}`, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(2500);
  } catch (e) {
    errs.push(`navigation: ${e.message}`);
  }

  if (webfonts.length) errs.push(`requested a webfont (DESIGN.md §3 says system stack only): ${webfonts[0]}`);

  const text = await page.evaluate(() => document.body.innerText).catch(() => "");

  // The shell catches a thrown tool and renders this instead of crashing the
  // page, so a tool can be completely dead with NO uncaught error reaching us.
  // Both outages looked exactly like this. Treat it as a failure.
  if (signedIn && /This tool hit an error/i.test(text)) {
    errs.push(`shell error boundary caught this tool — visible text: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  }
  // A JS comment in a JSX children position renders as text. Nothing else in
  // this product legitimately shows a source comment to a user.
  if (/^\s*\/\//m.test(text) || /\/\*/.test(text)) {
    const line = (text.match(/^.*\/\/.*$/m) || [""])[0];
    errs.push(`source comment rendered as visible text: ${line.trim().slice(0, 160)}`);
  }
  if (!text.trim()) errs.push("rendered nothing at all");

  const real = errs.filter((e) => !IGNORE.some((re) => re.test(e)));
  if (real.length) failures.push({ tool, errs: real });
  console.log(`${real.length ? "FAIL" : "ok  "}  ${tool}${signedIn ? "" : " (login screen)"}${real.length ? "\n      " + real.join("\n      ") : ""}`);

  await page.close();
}

await browser.close();

if (failures.length) {
  console.error(`\n${failures.length} of ${SURFACES.length} surfaces failed: ${failures.map((f) => f.tool).join(", ")}`);
  process.exit(1);
}
console.log(`\nAll ${SURFACES.length} surfaces loaded clean.`);
