import { FIRECRAWL_API_KEY, GOOGLE_PLACES_KEY, HUNTER_API_KEY, IS_LOCAL } from "../config.js";
import { callClaude } from "./claudeApi.js";
import { db, sbFetch, functionAuthHeaders } from "./supabase.js";

// Deployed traffic → /prospect-proxy (server-side keys); localhost → direct call.
export async function prospectProxy(service, payload) {
  const res = await fetch("/.netlify/functions/prospect-proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await functionAuthHeaders()) },
    body: JSON.stringify({ service, ...payload }),
  });
  if (!res.ok) throw new Error(`${service} proxy error (${res.status}): ${await res.text()}`);
  return await res.json();
}


// ─── Google Places Prospecting ───────────────────────────────────────────────
export const PROSPECT_CATEGORIES = [
  "dental clinic",
  "orthodontist",
  "law firm",
  "personal injury attorney",
  "home remodeling contractor",
  "HVAC contractor",
  "roofing contractor",
  "real estate agent",
  "mortgage broker",
  "accountant",
  "chiropractor",
  "physical therapy clinic",
  "med spa",
  "plastic surgeon",
  "financial advisor",
];


export function extractDomain(websiteUri) {
  if (!websiteUri) return null;
  try { return new URL(websiteUri).hostname.replace("www.", ""); }
  catch { return null; }
}


export async function searchPlaces(query) {
  const body = {
    textQuery: `${query} Chicago Illinois`,
    locationBias: { circle: { center: { latitude: 41.8781, longitude: -87.6298 }, radius: 25000 } },
    maxResultCount: 10,
  };
  if (!IS_LOCAL) {
    const data = await prospectProxy("places_search", { body });
    return data.places || [];
  }
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_PLACES_KEY,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.id",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.places || [];
}


export async function runProspecting(existingPlaceIds, onProgress, existingDomains = new Set(), toneMemory = []) {
  const results = { added: 0, skipped: 0, enriched: 0, drafted: 0, errors: [] };
  const shuffled = [...PROSPECT_CATEGORIES].sort(() => Math.random() - 0.5).slice(0, 2);

  for (const category of shuffled) {
    onProgress(`Searching ${category}s in Chicago…`);
    try {
      const places = await searchPlaces(category);
      for (const place of places) {
        if (existingPlaceIds.has(place.id)) { results.skipped++; continue; }
        const domain = extractDomain(place.websiteUri);
        // Skip if same domain already in pipeline (chain/franchise dedup)
        if (domain && existingDomains.has(domain)) { results.skipped++; continue; }
        try {
          const [prospect] = await db.insertProspect({
            business_name: place.displayName?.text || "Unknown",
            address: place.formattedAddress || "",
            website: domain || "",
            phone: place.nationalPhoneNumber || "",
            category,
            google_place_id: place.id,
            ads_detected: false,
          });
          const [contact] = await db.insertContact({
            prospect_id: prospect.id,
            // This is a guessed placeholder, not real data — Google Places never
            // returns emails. Enrichment below tries to replace it with a real
            // Hunter match; if Hunter finds nothing, this stays clearly labeled
            // as a guess instead of silently passing as sourced/verified data.
            email: domain ? `hello@${domain}` : null,
            email_confidence_score: domain ? 20 : null,
            source: "guessed",
          });
          const [outreach] = await db.insertOutreach({ prospect_id: prospect.id, contact_id: contact.id, status: "prospected" });
          results.added++;

          // Auto-enrich immediately after adding
          onProgress(`Enriching ${place.displayName?.text}…`);
          let enrichResult = null;
          try {
            const mockCard = {
              prospect: { ...prospect, website: domain },
              contact: contact,
            };
            enrichResult = await enrichProspect(mockCard, () => {});
            if (enrichResult.success) results.enriched++;
          } catch {}

          // Auto-draft right away, using what enrichment just learned — skips
          // the manual "generate" click. Uses the enriched context in memory
          // (website_context, ads_detected, Hunter's contact name) rather than
          // re-fetching the prospect row, since enrichProspect already wrote
          // those fields to the DB but doesn't hand back the mutated row.
          // A failed or thin enrichment still gets a draft attempt — generateDraft
          // degrades gracefully with less context, same as the manual path does
          // when someone clicks "generate" on a barely-enriched card.
          try {
            onProgress(`Drafting outreach for ${place.displayName?.text}…`);
            const enrichedProspect = {
              ...prospect,
              website: domain,
              website_context: enrichResult?.websiteContext || null,
              ads_detected: enrichResult?.adsDetected || false,
            };
            const enrichedContact = {
              ...contact,
              name: enrichResult?.contactName || contact.name || null,
              email: enrichResult?.email || contact.email || null,
            };
            const draft = await generateDraft(enrichedProspect, enrichedContact, toneMemory);
            if (draft?.subject || draft?.body) {
              await db.updateOutreach(outreach.id, {
                draft_subject: draft.subject || "",
                draft_body: draft.body || "",
                status: "draft",
              });
              results.drafted++;
            }
          } catch {}
        } catch { results.skipped++; }
      }
    } catch (err) { results.errors.push(`${category}: ${err.message}`); }
  }
  return results;
}


// ─── Enrichment ──────────────────────────────────────────────────────────────
export async function hunterFindEmail(domain) {
  if (!domain) return null;
  try {
    let data;
    if (!IS_LOCAL) {
      data = await prospectProxy("hunter_domain_search", { domain, limit: 1 });
    } else {
      const res = await fetch(
        `https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${HUNTER_API_KEY}&limit=1`
      );
      data = await res.json();
    }
    if (data.data?.emails?.length > 0) {
      const email = data.data.emails[0];
      return {
        email: email.value,
        name: email.first_name ? `${email.first_name} ${email.last_name || ""}`.trim() : null,
        confidence: email.confidence || 50,
        verified: email.verification?.status === "valid",
      };
    }
  } catch {}
  return null;
}


// Broader marketing-signal detection — sharpens paid-search qualification beyond
// "do they have a Google Ads tag." Each tells us something about their sophistication.
export const MARKETING_SIGNALS = {
  google_ads:      [/AW-\d{6,}/, /googleadservices\.com/, /google_conversion_id/, /gtag\s*\(\s*['"]config['"]\s*,\s*['"]AW-/, /gads_conversion/, /\/pagead\/js/, /googletag\.pubads/],
  conversion_tracking: [/gtag\s*\(\s*['"]event['"]\s*,\s*['"]conversion/, /google_conversion_label/, /fbq\s*\(\s*['"]track['"]\s*,\s*['"]Lead/],
  meta_pixel:      [/connect\.facebook\.net/, /fbq\s*\(\s*['"]init/],
  analytics:       [/google-analytics\.com/, /gtag\s*\(\s*['"]config['"]\s*,\s*['"]G-/, /googletagmanager\.com/],
  call_tracking:   [/calltrk\.com/, /callrail/, /tel:\+?\d{10,}/],
  booking_widget:  [/calendly\.com/, /acuityscheduling/, /squareup\.com\/appointments/, /book(now|ing)/i, /schedule[- ]?appointment/i],
};


export function detectSignals(html) {
  const out = {};
  for (const [key, patterns] of Object.entries(MARKETING_SIGNALS)) {
    out[key] = patterns.some(p => p.test(html));
  }
  return out;
}


// Schema for structured extraction — Firecrawl returns these fields directly from the
// page in the SAME scrape call, so we don't need a second Claude call to derive them.
export const PROSPECT_EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "2-3 sentence overview: what they do, who they serve, and whether they're a good Google Ads candidate" },
    services_offered: { type: "array", items: { type: "string" }, description: "Main services or specialties offered" },
    service_area: { type: "string", description: "Geographic area served, or null" },
    has_booking_form: { type: "boolean", description: "Whether the site has an online booking/appointment form" },
    runs_promotions: { type: "boolean", description: "Whether they mention any current offers, discounts, or promotions" },
    phone_number: { type: "string", description: "Primary phone number, or null" },
    linkedin_url: { type: "string", description: "LinkedIn profile or company page URL, or null" },
    callouts: { type: "array", items: { type: "string" }, description: "3 specific details from the site useful for a personalized cold email (differentiator, pricing signal, or a conversion gap you noticed)" },
  },
  required: ["summary", "callouts"],
};


// Upgraded scrape: one call now returns markdown + html (for signal detection) +
// structured JSON (replacing the separate brief call) + a screenshot, with caching.
export async function firecrawlScrape(domain, opts = {}) {
  const empty = { markdown: null, html: null, ads_detected: false, signals: {}, extract: null, screenshot: null };
  if (!domain) return empty;
  try {
    const body = {
      url: `https://${domain}`,
      // markdown for context, html for signal regex, json for structured fields,
      // screenshot for a visual of their landing page.
      formats: [
        "markdown",
        "html",
        ...(opts.extract !== false ? [{ type: "json", schema: PROSPECT_EXTRACT_SCHEMA }] : []),
        ...(opts.screenshot ? ["screenshot"] : []),
      ],
      onlyMainContent: false,        // need full page for tracking scripts
      maxAge: opts.maxAge ?? 86400000, // serve cached result if <24h old → up to 5x faster, cheaper
      timeout: 20000,
    };
    let data;
    if (!IS_LOCAL) {
      data = await prospectProxy("firecrawl_scrape", { body });
    } else {
      const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${FIRECRAWL_API_KEY}` },
        body: JSON.stringify(body),
      });
      data = await res.json();
    }
    if (!data.success) return empty;
    const d = data.data || {};
    const html = d.html || "";
    const signals = detectSignals(html);
    return {
      markdown: d.markdown ? d.markdown.slice(0, 3000) : null,
      html,
      ads_detected: signals.google_ads,
      signals,
      extract: d.json || null,          // structured fields, extracted in-call
      screenshot: d.screenshot || null, // URL to full-page screenshot
    };
  } catch {}
  return empty;
}


// Batch scrape — enrich many domains in one request instead of N sequential calls.
export async function firecrawlBatchScrape(domains, opts = {}) {
  if (!domains || domains.length === 0) return {};
  try {
    const body = {
      urls: domains.map(d => `https://${d}`),
      formats: ["markdown", "html", ...(opts.extract !== false ? [{ type: "json", schema: PROSPECT_EXTRACT_SCHEMA }] : [])],
      onlyMainContent: false,
      maxAge: opts.maxAge ?? 86400000,
    };
    let data;
    if (!IS_LOCAL) {
      data = await prospectProxy("firecrawl_batch_scrape", { body });
    } else {
      const res = await fetch("https://api.firecrawl.dev/v1/batch/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${FIRECRAWL_API_KEY}` },
        body: JSON.stringify(body),
      });
      data = await res.json();
    }
    // Batch returns an array aligned to input order (or an id to poll for async).
    const results = {};
    (data.data || []).forEach((d, i) => {
      const html = d.html || "";
      const signals = detectSignals(html);
      results[domains[i]] = {
        markdown: d.markdown ? d.markdown.slice(0, 3000) : null,
        ads_detected: signals.google_ads, signals,
        extract: d.json || null,
      };
    });
    return results;
  } catch {}
  return {};
}



export async function buildProspectBrief(prospect, websiteContent) {
  // Use Claude to synthesize a research brief from the scraped content
  const prompt = `You are researching a Chicago small business to determine if they are a good fit for Google Ads management.

Business: ${prospect.business_name}
Category: ${prospect.category}
Address: ${prospect.address}
Website: ${prospect.website}

Website content:
${websiteContent || "No website content available"}

Return ONLY valid JSON, no markdown, no backticks, no preamble:
{
  "summary": "2-3 sentence overview: what they do, who they serve, and whether they're a good Google Ads candidate",
  "callouts": [
    "Specific detail #1 from their site (service, specialty, or differentiator)",
    "Specific detail #2 (pricing signal, service area, or client type)",
    "Specific detail #3 (conversion opportunity or gap you noticed)"
  ],
  "linkedin_url": "LinkedIn profile or company page URL found in website content, or null if not found"
}`;

  try {
    const r = await callClaude({ model: "claude-haiku-4-5-20251001", max_tokens: 600, messages: [{ role: "user", content: prompt }], fn: "enrich_brief", promptChars: prompt.length });
    if (!r.text) return null;
    try {
      return JSON.parse(r.text.replace(/```json|```/g, "").trim());
    } catch {
      return { summary: r.text, callouts: [], linkedin_url: null };
    }
  } catch {}
  return null;
}


export async function enrichProspect(card, onProgress) {
  const prospect = card.prospect || {};
  const contact = card.contact || {};
  const domain = prospect.website;

  if (!domain) return { success: false, reason: "No domain" };

  // 1. Hunter.io email lookup
  onProgress(`Finding contact email for ${prospect.business_name}…`);
  let emailData = null;
  try {
    emailData = await hunterFindEmail(domain);
  } catch {}

  // 2. Firecrawl scrape — structured extraction + signal detection in ONE call.
  onProgress(`Scraping ${domain} with Firecrawl…`);
  let websiteContent = null;
  let adsDetected = false;
  let marketingSignals = {};
  let extract = null;
  let screenshotUrl = null;
  try {
    const scrapeResult = await firecrawlScrape(domain, { screenshot: true });
    websiteContent = scrapeResult.markdown;
    adsDetected = scrapeResult.ads_detected;
    marketingSignals = scrapeResult.signals || {};
    extract = scrapeResult.extract;     // structured fields, no extra Claude call
    screenshotUrl = scrapeResult.screenshot;
  } catch {}

  // 3. Prefer Firecrawl's in-call structured extract; only fall back to a Claude
  //    brief call if extraction came back empty. Saves one Claude call per prospect.
  let prospectBrief = extract;
  if (!prospectBrief && websiteContent) {
    onProgress(`Analyzing ${prospect.business_name}…`);
    try {
      prospectBrief = await buildProspectBrief(prospect, websiteContent);
    } catch {}
  }

  const briefSummary = prospectBrief?.summary || null;
  const briefCallouts = Array.isArray(prospectBrief?.callouts) ? prospectBrief.callouts : [];
  const linkedinUrl = prospectBrief?.linkedin_url || null;

  // Store combined context string for generateDraft compatibility
  const websiteContext = [
    briefSummary ? `RESEARCH BRIEF:\n${briefSummary}` : null,
    briefCallouts.length > 0 ? `KEY CALLOUTS:\n${briefCallouts.map(c => `- ${c}`).join("\n")}` : null,
    websiteContent ? `WEBSITE CONTENT:\n${websiteContent}` : null,
  ].filter(Boolean).join("\n\n");

  // 4. Update contact — only touch it when Hunter actually found something real.
  // Previously this unconditionally set source:"hunter" even when Hunter came
  // back empty, which silently relabeled a guessed placeholder email as if a
  // real lookup had happened. Now a "no match" leaves the honest "guessed"
  // label in place instead of overwriting it with a false one.
  if (contact.id && emailData?.email) {
    try {
      const contactUpdate = {
        source: "hunter",
        email: emailData.email,
        email_verified: emailData.verified || false,
        email_confidence_score: emailData.confidence || 50,
      };
      if (emailData.name) contactUpdate.name = emailData.name;

      await sbFetch(`/contacts?id=eq.${contact.id}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify(contactUpdate),
      });
    } catch {}
  }

  // 5. Update prospect with website context + structured brief fields
  if (prospect.id) {
    const prospectUpdate = {};
    if (websiteContext) prospectUpdate.website_context = websiteContext;
    if (briefSummary) prospectUpdate.prospect_brief = briefSummary;
    if (briefCallouts.length > 0) prospectUpdate.brief_callouts = JSON.stringify(briefCallouts);
    if (linkedinUrl) prospectUpdate.linkedin_url = linkedinUrl;
    prospectUpdate.ads_detected = adsDetected;
    // Richer marketing signals + screenshot, stored as JSON strings. These columns
    // must exist — PostgREST rejects the WHOLE patch on any unknown column, it
    // does not skip them (that's how enrichment saves were silently lost).
    if (marketingSignals && Object.keys(marketingSignals).length > 0) prospectUpdate.marketing_signals = JSON.stringify(marketingSignals);
    if (screenshotUrl) prospectUpdate.screenshot_url = screenshotUrl;

    if (Object.keys(prospectUpdate).length > 0) {
      try {
        await sbFetch(`/prospects?id=eq.${prospect.id}`, {
          method: "PATCH",
          prefer: "return=minimal",
          body: JSON.stringify(prospectUpdate),
        });
      } catch {}
    }
  }

  return {
    success: true,
    email: emailData?.email,
    confidence: emailData?.confidence,
    contactName: emailData?.name || null,
    hasWebContext: !!websiteContext,
    hasBrief: !!prospectBrief,
    linkedinUrl,
    adsDetected,
    // Full enriched content, so a caller (e.g. auto-drafting right after
    // enrichment) can use it immediately instead of re-fetching the prospect
    // row to see the fields step 5 just wrote.
    websiteContext,
  };
}


// ─── Claude ──────────────────────────────────────────────────────────────────
export async function generateDraft(prospect, contact, toneMemory) {
  const toneInstructions = toneMemory.length
    ? `\n\nTone instructions from previous feedback:\n${toneMemory.map((t) => `- ${t.feedback_text}`).join("\n")}`
    : "";

  const systemPrompt = `You are an outreach copywriter for Clarify Paid Search, a boutique Google Ads agency in Chicago that helps small businesses get real ROI from paid search — not just clicks.

Write cold outreach emails that feel human, direct, and specific to the business. Rules:
- Never use words like "leverage", "synergy", or "growth hacking"
- Lead with a specific observation about their business or a gap you noticed in their search presence
- Keep the email under 120 words total
- No greeting like "Hi there" — get straight to the observation
- End with a low-friction CTA (15-minute call or quick reply)
- Sign off as: Cameron | Clarify Paid Search | clarifypaidsearch.com${toneInstructions}`;

  const researchContext = prospect.website_context
    ? `\n\nRESEARCH CONTEXT (use this to write something specific, not generic):\n${prospect.website_context.slice(0, 2500)}`
    : "";

  const userPrompt = `Write a cold outreach email for:

Business: ${prospect.business_name}
Category: ${prospect.category || "local business"}
Website: ${prospect.website || "unknown"}
Location: ${prospect.address || "Chicago"}
Running Google Ads: ${prospect.ads_detected ? "Yes" : "No / Unknown"}
Contact name: ${contact?.name || "unknown"}${researchContext}

IMPORTANT: If research context is provided, reference something SPECIFIC from it — a service they offer, a specific neighborhood they serve, a client type they mention. Make it obvious you actually looked at their business. Generic emails get ignored.

Return ONLY valid JSON, no markdown, no backticks, no preamble. Do NOT use double quotes inside string values — use single quotes or rephrase instead:
{"subject": "...", "body": "..."}`;

  const r = await callClaude({ model: "claude-haiku-4-5-20251001", max_tokens: 800, system: systemPrompt, messages: [{ role: "user", content: userPrompt }], fn: "generate_draft", promptChars: userPrompt.length });
  if (!r.ok) throw new Error(r.error || "API error");
  const text = r.text || "{}";
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return { subject: "Quick question about your Google Ads", body: text };
  }
}


// ─── Follow-up Draft ─────────────────────────────────────────────────────────
export async function generateFollowUpDraft(prospect, contact, originalSubject, originalBody, toneMemory) {
  const toneInstructions = toneMemory.length
    ? `\n\nTone instructions from previous feedback:\n${toneMemory.map((t) => `- ${t.feedback_text}`).join("\n")}`
    : "";

  const systemPrompt = `You are writing a follow-up email for Cameron at Clarify Paid Search, a boutique Google Ads agency in Chicago.

The prospect did not reply to the first email. Write a short, non-pushy follow-up that:
- References the original email briefly (1 line max)
- Adds a new angle, insight, or question — don't just say "just checking in"
- Stays under 80 words
- Ends with a soft CTA (reply or 15-min call)
- Signs off as: Cameron | Clarify Paid Search | clarifypaidsearch.com${toneInstructions}`;

  const userPrompt = `Original outreach:
Subject: ${originalSubject}
Body: ${originalBody}

Business: ${prospect.business_name}
Category: ${prospect.category || "local business"}

Write a follow-up email. Return ONLY valid JSON:
{"subject": "Re: ${originalSubject}", "body": "..."}`;

  const r = await callClaude({ model: "claude-haiku-4-5-20251001", max_tokens: 400, system: systemPrompt, messages: [{ role: "user", content: userPrompt }], fn: "followup_draft", promptChars: userPrompt.length });
  const text = r.text || "{}";
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return { subject: `Re: ${originalSubject}`, body: text };
  }
}
