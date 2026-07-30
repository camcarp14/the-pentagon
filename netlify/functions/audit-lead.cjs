// ─── Free audit — the public lead-gen entry point ────────────────────────────
// POST { email, website, name?, business? } → runs a fast marketing audit of
// the site and returns the report. The email IS the product: every valid
// request writes an inbound_leads row (source 'free_audit') that lands in the
// Inbound pipeline, plus an audit_requests row with the full results.
//
// Design constraints (PLAN.md AD-9): no new env vars (Claude insights use the
// existing ANTHROPIC_API_KEY; DB writes ride the publishable key against
// anon-INSERT-only tables), no Firecrawl (direct fetch keeps it fast + free),
// per-IP rate limiting via the no-PII rate_events ledger, and the whole run
// fits a synchronous function budget (~8s worst case).
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const { sbRest } = require("./_shared/supabaseRest.cjs");
const { json, error, methodGuard } = require("./_shared/response.cjs");

const RATE_LIMIT_PER_HOUR = 4;
const FETCH_TIMEOUT_MS = 6000;
// Redirects are followed by hand (see fetchSite) so every hop can be revalidated.
const MAX_REDIRECTS = 4;

const ipHash = (ip) => crypto.createHash("sha256").update("clarify-audit|" + (ip || "unknown")).digest("hex").slice(0, 32);

// ─── SSRF containment ────────────────────────────────────────────────────────
// This endpoint is deliberately anonymous (the email IS the product), and it
// fetches a caller-supplied URL server-side. That combination is the classic
// SSRF shape, so the guard has to hold against three separate bypasses — the
// original string-prefix test on the submitted hostname stopped none of them:
//
//   1. REDIRECT. `redirect: "follow"` let attacker.com answer 302 with
//      Location: http://169.254.169.254/. The guard had already passed on
//      "attacker.com" and was never consulted again. Now redirects are followed
//      manually and every hop is revalidated.
//   2. DNS. A public name can resolve to a private address (127-0-0-1.nip.io),
//      which no amount of string matching on the hostname will catch. Now the
//      host is resolved and every returned address is checked.
//   3. ALTERNATE LITERAL FORMS. "0x7f.0.0.1" is 127.0.0.1 and does not start
//      with any blocked prefix. Checking resolved addresses rather than the
//      text of the hostname makes the encoding irrelevant.
//
// Ports are pinned to 80/443 so the endpoint cannot be used to sweep internal
// service ports, and the failure is always the same generic message so response
// differences cannot be used to probe the network.

function isBlockedIp(addr) {
  const v = net.isIP(addr);
  if (v === 4) {
    const p = addr.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0 || a === 127) return true;                        // this-network, loopback
    if (a === 10) return true;                                    // private
    if (a === 172 && b >= 16 && b <= 31) return true;             // private
    if (a === 192 && b === 168) return true;                      // private
    if (a === 169 && b === 254) return true;                      // link-local (cloud metadata)
    if (a === 100 && b >= 64 && b <= 127) return true;            // CGNAT
    if (a === 192 && b === 0) return true;                        // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true;         // benchmarking
    if (a >= 224) return true;                                    // multicast + reserved + broadcast
    return false;
  }
  if (v === 6) {
    const s = addr.toLowerCase().replace(/^\[|\]$/g, "");
    if (s === "::1" || s === "::") return true;                   // loopback, unspecified
    // IPv4-mapped (::ffff:127.0.0.1) must be judged on the embedded v4 address.
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    if (/^f[cd]/.test(s)) return true;                            // unique local fc00::/7
    if (/^fe[89ab]/.test(s)) return true;                         // link-local fe80::/10
    return false;
  }
  return true; // not an IP literal we understand — refuse
}

// Resolve the host and refuse if ANY answer is internal. All answers, not just
// the first: a name with one public and one private A record would otherwise be
// a coin flip that the attacker gets to re-flip.
async function hostResolvesPublic(hostname) {
  if (net.isIP(hostname)) return !isBlockedIp(hostname);
  let answers;
  try {
    answers = await dns.lookup(hostname, { all: true });
  } catch {
    return false; // cannot resolve → cannot vouch for it
  }
  if (!answers.length) return false;
  return answers.every((a) => !isBlockedIp(a.address));
}

// Syntactic checks only — cheap, and safe to run before touching DNS.
function normalizeUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const parsed = new URL(u);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null; // no credential smuggling
    // Pin the port: an audit only ever needs the standard web ports, and leaving
    // it open turns this into an internal port scanner.
    if (parsed.port && parsed.port !== "80" && parsed.port !== "443") return null;
    if (!parsed.hostname.includes(".") && !net.isIP(parsed.hostname)) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

// The full check: syntax, then resolution. Returns the normalized URL or null.
async function safeUrl(raw) {
  const u = normalizeUrl(raw);
  if (!u) return null;
  return (await hostResolvesPublic(new URL(u).hostname)) ? u : null;
}

async function fetchSite(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const started = Date.now();
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      const res = await fetch(current, {
        signal: controller.signal,
        // Manual, so the guard runs again on the target of every redirect
        // instead of once on the URL the caller happened to type.
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ClarifyAuditBot/1.0; +https://the-pentagon.netlify.app/audit)" },
      });

      const isRedirect = res.status >= 300 && res.status < 400 && res.headers.get("location");
      if (!isRedirect) {
        const html = (await res.text()).slice(0, 400_000);
        return { ok: res.ok, status: res.status, finalUrl: current, html, ttfbMs: Date.now() - started, bytes: html.length };
      }

      if (hop >= MAX_REDIRECTS) {
        return { ok: false, status: 0, error: "too many redirects", ttfbMs: Date.now() - started, html: "" };
      }
      // Relative Locations are legal, so resolve against the hop we are on.
      const next = await safeUrl(new URL(res.headers.get("location"), current).toString());
      if (!next) {
        return { ok: false, status: 0, error: "unreachable", ttfbMs: Date.now() - started, html: "" };
      }
      current = next;
    }
  } catch (err) {
    return { ok: false, status: 0, error: err.name === "AbortError" ? "timeout" : err.message, ttfbMs: Date.now() - started, html: "" };
  } finally {
    clearTimeout(t);
  }
}

// Each check: { key, label, status: pass|warn|fail, detail } — status colors in
// the UI carry icon + label, never color alone.
function runChecks(site, url) {
  const html = site.html || "";
  const h = html.toLowerCase();
  const checks = [];
  const add = (key, label, status, detail) => checks.push({ key, label, status, detail });

  add("reachable", "Site loads", site.ok ? "pass" : "fail",
    site.ok ? `Responded in ${site.ttfbMs}ms` : `Couldn't load the site (${site.error || `HTTP ${site.status}`})`);
  if (!site.ok) return checks;

  add("https", "Secure (HTTPS)", (site.finalUrl || url).startsWith("https://") ? "pass" : "fail",
    (site.finalUrl || url).startsWith("https://") ? "Serving over HTTPS" : "Not serving over HTTPS — ads and browsers penalize this");

  const speedStatus = site.ttfbMs < 1200 ? "pass" : site.ttfbMs < 3000 ? "warn" : "fail";
  add("speed", "Response speed", speedStatus, `First response in ${(site.ttfbMs / 1000).toFixed(1)}s${speedStatus !== "pass" ? " — slow pages burn paid clicks" : ""}`);

  const hasGtag = /gtag\(|googletagmanager\.com\/gtag|google-analytics\.com\/analytics|g-[a-z0-9]{8,}/i.test(html);
  const hasGtm = /googletagmanager\.com\/gtm\.js|gtm-[a-z0-9]{4,}/i.test(html);
  add("analytics", "Google Analytics / Tag Manager", hasGtag || hasGtm ? "pass" : "fail",
    hasGtag || hasGtm ? `${hasGtm ? "GTM" : "GA4"} detected` : "No analytics tag found — you can't optimize what you don't measure");

  const hasAdsTag = /googleadservices|google_conversion|gtag\(['"]config['"],\s*['"]aw-|googlesyndication/i.test(html);
  add("ads_tag", "Google Ads conversion tag", hasAdsTag ? "pass" : "warn",
    hasAdsTag ? "Conversion/remarketing tag present" : "No Ads conversion tag — if you're running ads, conversions aren't tracked");

  const hasMeta = /connect\.facebook\.net|fbq\(/i.test(html);
  add("meta_pixel", "Meta pixel", hasMeta ? "pass" : "warn", hasMeta ? "Meta pixel present" : "No Meta pixel — retargeting audiences aren't being built");

  // The <meta> tags are extracted ONCE with a length-bounded pattern, then
  // matched attribute-wise. The previous form chained two unbounded `[^>]+`
  // runs (`<meta[^>]+name=...[^>]+content=...`), which is quadratic: on a
  // 400KB page of attacker-controlled HTML with many `<meta` starts and no
  // closing `>`, each start scans and backtracks the rest of the document.
  // Since the page body here is fetched from a URL an anonymous caller chose,
  // that is a free way to burn the whole function budget.
  const metaTags = html.match(/<meta\b[^>]{0,600}>/gi) || [];
  const metaWhere = (nameRe) => metaTags.find((t) => nameRe.test(t));
  const contentOf = (tag) => (tag && tag.match(/content=["']([^"']*)/i) || [])[1];

  const hasViewport = !!metaWhere(/name=["']viewport/i);
  add("viewport", "Mobile-ready viewport", hasViewport ? "pass" : "fail",
    hasViewport ? "Responsive viewport configured" : "No viewport meta — mobile visitors get a desktop page");

  const title = (html.match(/<title[^>]{0,200}>([^<]*)<\/title>/i) || [])[1]?.trim();
  add("title", "Page title", title ? (title.length > 8 ? "pass" : "warn") : "fail", title ? `"${title.slice(0, 80)}"` : "Missing <title>");

  const desc = contentOf(metaWhere(/name=["']description["']/i));
  add("description", "Meta description", desc ? "pass" : "warn", desc ? `${desc.slice(0, 90)}…` : "Missing meta description — weak ad/organic snippets");

  const hasPhone = /(tel:|\(\d{3}\)\s?\d{3}[- ]?\d{4}|\d{3}[-.]\d{3}[-.]\d{4})/.test(html);
  add("phone", "Click-to-call", hasPhone ? "pass" : "warn", hasPhone ? "Phone number present" : "No visible phone number — local intent converts on calls");

  const weightStatus = site.bytes < 150_000 ? "pass" : site.bytes < 350_000 ? "warn" : "fail";
  add("weight", "Page weight", weightStatus, `~${Math.round(site.bytes / 1024)}KB of HTML${weightStatus !== "pass" ? " — heavy pages hurt Quality Score" : ""}`);

  const hasSchema = /application\/ld\+json|schema\.org/i.test(html);
  add("schema", "Structured data", hasSchema ? "pass" : "warn", hasSchema ? "schema.org markup present" : "No structured data — weaker local/organic presence");

  return checks;
}

function scoreOf(checks) {
  const weights = { pass: 1, warn: 0.5, fail: 0 };
  const scorable = checks.filter((c) => c.key !== "reachable");
  if (scorable.length === 0) return 0;
  return Math.round((scorable.reduce((a, c) => a + weights[c.status], 0) / scorable.length) * 100);
}

async function aiInsights({ checks, business, url }) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.VITE_ANTHROPIC_API_KEY) return null;
  const failing = checks.filter((c) => c.status !== "pass").map((c) => `${c.label}: ${c.detail}`).join("\n");
  const prompt = `You are a senior paid-search analyst at Clarify Paid Search (Chicago). A local business (${business || url}) ran our free marketing audit. Findings that need attention:\n${failing || "Everything passed."}\n\nWrite 3 short, specific "what this costs you" insights (one sentence each, plain language, no jargon, no fluff) and one closing line on the single highest-impact fix. Return ONLY JSON: {"insights":["...","...","..."],"priority":"..."}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data?.content?.[0]?.text || "";
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    if (Array.isArray(parsed.insights)) return parsed;
  } catch {}
  return null;
}

exports.handler = async (event) => {
  const guard = methodGuard(event, "POST");
  if (guard) return guard;

  let payload;
  try { payload = JSON.parse(event.body || "{}"); } catch { return error(400, "Invalid JSON"); }

  const email = String(payload.email || "").trim().toLowerCase();
  const url = await safeUrl(payload.website);
  const name = String(payload.name || "").trim().slice(0, 120) || null;
  const business = String(payload.business || "").trim().slice(0, 160) || null;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return error(400, "Enter a real email address — the report is tied to it.");
  if (!url) return error(400, "Enter a valid website address (like yourbusiness.com).");

  // Per-IP rate limit via the no-PII ledger.
  const ip = (event.headers && (event.headers["x-nf-client-connection-ip"] || (event.headers["x-forwarded-for"] || "").split(",")[0])) || "";
  const hash = ipHash(ip);
  try {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const recent = await sbRest(`/rate_events?kind=eq.audit&ip_hash=eq.${hash}&created_at=gte.${hourAgo}&select=id`);
    if ((recent || []).length >= RATE_LIMIT_PER_HOUR) {
      return error(429, "That's a few audits in a row — give it an hour and try again.");
    }
    await sbRest(`/rate_events`, { method: "POST", prefer: "return=minimal", body: { ip_hash: hash, kind: "audit" } });
  } catch (err) {
    // FAIL CLOSED. This used to swallow the error so "rate table unavailable
    // must not take the tool down" — but this endpoint is anonymous and every
    // request spends Anthropic credit in aiInsights(), so the rate limit is the
    // only cost control there is. Swallowing its failure means an outage of the
    // rate table silently converts an unauthenticated endpoint into an
    // uncapped one. A lead form being briefly unavailable is recoverable; an
    // unbounded bill is not.
    console.error("audit rate-limit check failed, refusing:", err.message);
    return error(503, "The audit tool is briefly unavailable — please try again in a few minutes.");
  }

  const site = await fetchSite(url);
  const checks = runChecks(site, url);
  const score = scoreOf(checks);
  const insights = site.ok ? await aiInsights({ checks, business, url }) : null;

  const results = { url, finalUrl: site.finalUrl || url, score, checks, insights, ran_at: new Date().toISOString() };

  // The lead is the product — write it even if the site itself was unreachable.
  let leadId = null;
  try {
    const lead = await sbRest(`/inbound_leads`, {
      method: "POST",
      body: {
        name, business, website: url, email,
        service: "Free audit",
        details: `Free audit run — score ${score}/100. ${checks.filter((c) => c.status === "fail").map((c) => c.label).join(", ") || "no failing checks"}.`,
        source: "free_audit",
        status: "new",
        raw: { audit_score: score },
      },
    });
    leadId = lead && lead[0] && lead[0].id;
  } catch (err) {
    console.error("audit lead insert failed:", err.message);
  }
  try {
    await sbRest(`/audit_requests`, {
      method: "POST", prefer: "return=minimal",
      body: { email, website: url, name, business, status: site.ok ? "completed" : "failed", results, ip_hash: hash, lead_id: leadId },
    });
  } catch (err) {
    console.error("audit request insert failed:", err.message);
  }

  return json(200, results);
};
