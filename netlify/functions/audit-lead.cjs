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
const dns = require("node:dns/promises");
const { isIP } = require("node:net");
const { sbRest } = require("./_shared/supabaseRest.cjs");
const { json, error, methodGuard } = require("./_shared/response.cjs");

const RATE_LIMIT_PER_HOUR = 4;
const FETCH_TIMEOUT_MS = 6000;
const MAX_FETCH_BYTES = 400_000;
const MAX_REDIRECTS = 3;

const ipHash = (ip, salt) => crypto.createHmac("sha256", salt).update(ip || "unknown").digest("hex").slice(0, 32);

function normalizeUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const parsed = new URL(u);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    if (!parsed.hostname.includes(".")) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function isPrivateAddress(address) {
  const normalized = String(address || "").toLowerCase().replace(/^\[|\]$/g, "");
  const version = isIP(normalized);
  if (version === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (version === 6) {
    const embeddedV4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) || !!(embeddedV4 && isPrivateAddress(embeddedV4[1]));
  }
  return true;
}

async function assertPublicTarget(rawUrl) {
  const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || isPrivateAddress(host)) throw new Error("unsafe target host");
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("unsafe target address");
  return url;
}

async function readTextLimited(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== "function") return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.slice(0, maxBytes - size);
      chunks.push(chunk);
      size += chunk.byteLength;
      if (chunk.byteLength !== value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

async function fetchSite(rawUrl) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const started = Date.now();
  try {
    let url = await assertPublicTarget(rawUrl);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ClarifyAuditBot/1.0; +https://the-pentagon.netlify.app/audit)" },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (redirects === MAX_REDIRECTS) throw new Error("too many redirects");
        url = await assertPublicTarget(new URL(res.headers.get("location"), url));
        continue;
      }
      const html = await readTextLimited(res, MAX_FETCH_BYTES);
      return { ok: res.ok, status: res.status, finalUrl: url.toString(), html, ttfbMs: Date.now() - started, bytes: Buffer.byteLength(html) };
    }
    throw new Error("too many redirects");
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

  add("viewport", "Mobile-ready viewport", /<meta[^>]+name=["']viewport/i.test(html) ? "pass" : "fail",
    /<meta[^>]+name=["']viewport/i.test(html) ? "Responsive viewport configured" : "No viewport meta — mobile visitors get a desktop page");

  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim();
  add("title", "Page title", title ? (title.length > 8 ? "pass" : "warn") : "fail", title ? `"${title.slice(0, 80)}"` : "Missing <title>");

  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [])[1];
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
  const url = normalizeUrl(payload.website);
  const name = String(payload.name || "").trim().slice(0, 120) || null;
  const business = String(payload.business || "").trim().slice(0, 160) || null;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return error(400, "Enter a real email address — the report is tied to it.");
  if (!url) return error(400, "Enter a valid website address (like yourbusiness.com).");

  // Per-IP rate limit via an atomic database claim. A missing salt or unavailable
  // limiter must reject the request rather than leave an AI-billed endpoint open.
  const rateSalt = String(process.env.AUDIT_RATE_LIMIT_SALT || "").trim();
  if (!rateSalt) return error(503, "The audit rate limiter is not configured. Please try again later.");
  const ip = (event.headers && (event.headers["x-nf-client-connection-ip"] || (event.headers["x-forwarded-for"] || "").split(",")[0])) || "";
  const hash = ipHash(ip, rateSalt);
  try {
    const claimed = await sbRest("/rpc/claim_audit_rate", { method: "POST", body: { p_ip_hash: hash, p_limit: RATE_LIMIT_PER_HOUR } });
    if (claimed !== true) {
      return error(429, "That's a few audits in a row — give it an hour and try again.");
    }
  } catch (err) {
    console.error("audit rate limiter failed:", err.message);
    return error(503, "The audit rate limiter is temporarily unavailable. Please try again later.");
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
