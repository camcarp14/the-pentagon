// Skill extraction and market demand. Deterministic, no AI, no network.
//
// WHAT QUESTION THIS ANSWERS: "what does the market I am actually applying into
// keep asking for, and which of those can I evidence?" Requirements coverage
// (coverage.js) already answers that for ONE posting. This answers it across
// every posting Runway has seen on your behalf — captured jobs and scanned
// discoveries together — which is the only sample that describes YOUR market
// rather than the job market in general.
//
// WHY A DICTIONARY AND NOT AN LLM: a scan touches hundreds of postings and this
// runs over all of them, on every render. A dictionary pass is free, instant,
// identical every time, and unit-testable against planted text. The cost is
// recall on skills nobody wrote down here — which is why UNMATCHED capitalised
// tokens are surfaced separately as "unrecognised, appearing often", so the
// dictionary's blind spots are visible instead of silent.
//
// MATCHING IS PHRASE-ANCHORED, not substring. "R" as a skill would match every
// posting ever written; short or ambiguous entries carry `strict: true` and are
// matched only as standalone words with surrounding punctuation respected.

const CAT = {
  channel: 'Channels',
  platform: 'Platforms & tools',
  analytics: 'Analytics & data',
  technical: 'Technical',
  craft: 'Craft & process',
  domain: 'Domain',
};

// canonical id → { label, category, aliases[], strict? }
export const SKILLS = {
  // ------------------------------------------------------------- channels
  paid_search: { label: 'Paid search', category: CAT.channel, aliases: ['paid search', 'sem', 'ppc', 'pay per click', 'search engine marketing', 'biddable'] },
  paid_social: { label: 'Paid social', category: CAT.channel, aliases: ['paid social', 'social advertising', 'social ads'] },
  programmatic: { label: 'Programmatic', category: CAT.channel, aliases: ['programmatic', 'dsp', 'display advertising', 'demand side platform'] },
  seo: { label: 'SEO', category: CAT.channel, aliases: ['seo', 'search engine optimization', 'organic search'] },
  email_marketing: { label: 'Email / lifecycle', category: CAT.channel, aliases: ['email marketing', 'lifecycle marketing', 'crm marketing', 'marketing automation', 'drip campaign'] },
  affiliate: { label: 'Affiliate', category: CAT.channel, aliases: ['affiliate marketing', 'affiliate', 'partner marketing'] },
  influencer: { label: 'Influencer', category: CAT.channel, aliases: ['influencer marketing', 'creator marketing'] },
  content_marketing: { label: 'Content marketing', category: CAT.channel, aliases: ['content marketing', 'content strategy'] },
  video_ads: { label: 'Video / CTV', category: CAT.channel, aliases: ['youtube ads', 'ctv', 'connected tv', 'ott advertising', 'video advertising'] },

  // ------------------------------------------------------------ platforms
  google_ads: { label: 'Google Ads', category: CAT.platform, aliases: ['google ads', 'adwords', 'google adwords'] },
  meta_ads: { label: 'Meta Ads', category: CAT.platform, aliases: ['meta ads', 'facebook ads', 'facebook advertising', 'meta business manager'] },
  microsoft_ads: { label: 'Microsoft Ads', category: CAT.platform, aliases: ['microsoft ads', 'bing ads', 'microsoft advertising'] },
  linkedin_ads: { label: 'LinkedIn Ads', category: CAT.platform, aliases: ['linkedin ads', 'linkedin campaign manager'] },
  tiktok_ads: { label: 'TikTok Ads', category: CAT.platform, aliases: ['tiktok ads', 'tiktok advertising'] },
  amazon_ads: { label: 'Amazon Ads', category: CAT.platform, aliases: ['amazon ads', 'amazon advertising', 'amazon dsp'] },
  sa360: { label: 'SA360', category: CAT.platform, aliases: ['sa360', 'search ads 360'] },
  dv360: { label: 'DV360', category: CAT.platform, aliases: ['dv360', 'display & video 360', 'display and video 360'] },
  gtm: { label: 'Google Tag Manager', category: CAT.platform, aliases: ['google tag manager', 'gtm', 'tag manager'] },
  ga4: { label: 'GA4', category: CAT.platform, aliases: ['ga4', 'google analytics'] },
  salesforce: { label: 'Salesforce', category: CAT.platform, aliases: ['salesforce', 'sfdc'] },
  hubspot: { label: 'HubSpot', category: CAT.platform, aliases: ['hubspot'] },
  marketo: { label: 'Marketo', category: CAT.platform, aliases: ['marketo'] },
  braze: { label: 'Braze', category: CAT.platform, aliases: ['braze'] },
  klaviyo: { label: 'Klaviyo', category: CAT.platform, aliases: ['klaviyo'] },
  segment: { label: 'Segment', category: CAT.platform, aliases: ['segment', 'customer data platform', 'cdp'] },
  shopify: { label: 'Shopify', category: CAT.platform, aliases: ['shopify'] },
  jira: { label: 'Jira', category: CAT.platform, aliases: ['jira', 'atlassian'] },
  figma: { label: 'Figma', category: CAT.platform, aliases: ['figma'] },

  // ------------------------------------------------------------ analytics
  sql: { label: 'SQL', category: CAT.analytics, aliases: ['sql', 'postgres', 'postgresql', 'bigquery', 'snowflake', 'redshift'] },
  excel: { label: 'Excel / Sheets', category: CAT.analytics, aliases: ['excel', 'google sheets', 'spreadsheet modeling', 'pivot table'] },
  tableau: { label: 'Tableau', category: CAT.analytics, aliases: ['tableau'] },
  looker: { label: 'Looker', category: CAT.analytics, aliases: ['looker', 'looker studio', 'data studio'] },
  powerbi: { label: 'Power BI', category: CAT.analytics, aliases: ['power bi', 'powerbi'] },
  ab_testing: { label: 'A/B testing', category: CAT.analytics, aliases: ['a/b testing', 'ab testing', 'split testing', 'experimentation', 'incrementality', 'conversion rate optimization', 'cro'] },
  attribution: { label: 'Attribution', category: CAT.analytics, aliases: ['attribution', 'mmm', 'media mix modeling', 'marketing mix modeling', 'multi touch attribution'] },
  forecasting: { label: 'Forecasting', category: CAT.analytics, aliases: ['forecasting', 'budget pacing', 'financial modeling', 'scenario modeling'] },
  dashboarding: { label: 'Dashboarding', category: CAT.analytics, aliases: ['dashboard', 'dashboards', 'reporting automation', 'business intelligence'] },

  // ------------------------------------------------------------ technical
  python: { label: 'Python', category: CAT.technical, aliases: ['python', 'pandas', 'numpy'] },
  javascript: { label: 'JavaScript', category: CAT.technical, aliases: ['javascript', 'typescript', 'node.js', 'nodejs'] },
  react: { label: 'React', category: CAT.technical, aliases: ['react', 'react.js', 'next.js'] },
  api_integration: { label: 'APIs', category: CAT.technical, aliases: ['rest api', 'api integration', 'graphql', 'webhooks'] },
  cloud: { label: 'Cloud', category: CAT.technical, aliases: ['aws', 'gcp', 'google cloud', 'azure', 'kubernetes', 'docker'] },
  git: { label: 'Git', category: CAT.technical, aliases: ['git', 'github', 'version control'] },
  ml: { label: 'Machine learning', category: CAT.technical, aliases: ['machine learning', 'deep learning', 'nlp', 'llm', 'generative ai'] },

  // -------------------------------------------------------- craft & process
  // "Managed a $2.4M annual budget across 12 clients" is the way a resume
  // actually states budget ownership — the abstract nouns ("budget
  // management") are how a JOB POSTING states it. Both phrasings have to be
  // here or the same fact reads as demand on one side and a gap on the other.
  budget_management: { label: 'Budget ownership', category: CAT.craft, aliases: ['budget management', 'budget ownership', 'p&l', 'spend management', 'manage budgets', 'managing budgets', 'annual budget', 'media budget', 'budget allocation', 'ad spend'] },
  people_management: { label: 'People management', category: CAT.craft, aliases: ['people management', 'team leadership', 'manage a team', 'direct reports', 'mentoring', 'coaching'] },
  stakeholder: { label: 'Stakeholder management', category: CAT.craft, aliases: ['stakeholder management', 'cross functional', 'cross-functional', 'executive communication', 'client facing'] },
  strategy: { label: 'Strategy', category: CAT.craft, aliases: ['go to market strategy', 'strategic planning', 'roadmap', 'channel strategy'] },
  project_management: { label: 'Project management', category: CAT.craft, aliases: ['project management', 'program management', 'agile', 'scrum', 'sprint planning'] },
  vendor: { label: 'Vendor / agency management', category: CAT.craft, aliases: ['vendor management', 'agency management', 'managing agencies'] },
  copywriting: { label: 'Copywriting', category: CAT.craft, aliases: ['copywriting', 'ad copy', 'creative testing'] },

  // ---------------------------------------------------------------- domain
  b2b: { label: 'B2B', category: CAT.domain, aliases: ['b2b', 'business to business', 'enterprise saas'] },
  b2c: { label: 'B2C / DTC', category: CAT.domain, aliases: ['b2c', 'dtc', 'direct to consumer', 'ecommerce', 'e-commerce'] },
  healthcare: { label: 'Healthcare', category: CAT.domain, aliases: ['healthcare', 'health tech', 'hipaa', 'payer', 'provider network'] },
  fintech: { label: 'Fintech', category: CAT.domain, aliases: ['fintech', 'financial services', 'payments'] },
  marketplace: { label: 'Marketplace', category: CAT.domain, aliases: ['marketplace', 'two sided marketplace'] },
  saas: { label: 'SaaS', category: CAT.domain, aliases: ['saas', 'software as a service', 'subscription business'] },
};

export const SKILL_CATEGORIES = Object.values(CAT);
export const skillLabel = (id) => SKILLS[id]?.label || id;
export const skillCategory = (id) => SKILLS[id]?.category || CAT.craft;

// One flat alias → canonical-id table, longest alias first so "google tag
// manager" is claimed by gtm before "google ads" ever gets a look at it.
const ALIAS_INDEX = Object.entries(SKILLS)
  .flatMap(([id, def]) => def.aliases.map((a) => ({ id, alias: normalize(a) })))
  .sort((a, b) => b.alias.length - a.alias.length);

function normalize(s) {
  // Keep the characters that carry meaning inside skill names: + (c++),
  // # (c#), & (r&d), . (node.js), / (a/b). Everything else becomes a space,
  // and the result is space-padded so every lookup is phrase-anchored.
  return ` ${String(s ?? '').toLowerCase().replace(/[^a-z0-9+#&./]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/**
 * Canonical skill ids present in a blob of text. Order is stable (dictionary
 * order), so two runs over the same posting produce byte-identical arrays and
 * a stored `skills` column never churns.
 */
export function extractSkills(...texts) {
  const hay = normalize(texts.filter(Boolean).join(' \n '));
  const found = new Set();
  for (const { id, alias } of ALIAS_INDEX) {
    if (found.has(id)) continue;
    if (hay.includes(` ${alias.trim()} `)) found.add(id);
  }
  return Object.keys(SKILLS).filter((id) => found.has(id));
}

// A posting's text is title + requirements + description; requirements are
// weighted by being included twice, so a skill named as a REQUIREMENT rather
// than mentioned in passing survives any future frequency weighting.
export function skillsForPosting(posting) {
  const reqs = Array.isArray(posting?.requirements) ? posting.requirements.join(' \n ') : '';
  return extractSkills(posting?.title, reqs, reqs, posting?.raw_description);
}

export function skillsForResume(content) {
  const c = content || {};
  const roles = Array.isArray(c.experience) ? c.experience : [];
  return extractSkills(
    c.summary,
    (Array.isArray(c.skills) ? c.skills : []).join(' \n '),
    roles.map((r) => [r.title, r.company, ...(Array.isArray(r.bullets) ? r.bullets : [])].join(' \n ')).join(' \n '),
  );
}

/**
 * Demand across a set of postings.
 *
 * Each posting may carry a stored `skills` array (written at scan/capture time)
 * or raw text to extract from. `weight` lets a high-fit posting count for more
 * than a marginal one — the market you actually want, not every market.
 *
 * Returns rows sorted by demand: [{ id, label, category, count, pct,
 * weighted, medianComp }].
 */
export function marketDemand(postings, { weightByFit = true } = {}) {
  const list = (postings || []).filter(Boolean);
  if (!list.length) return { rows: [], total: 0 };

  const counts = new Map();
  const weights = new Map();
  const comps = new Map();
  let total = 0;

  for (const p of list) {
    const skills = Array.isArray(p.skills) && p.skills.length ? p.skills.filter((s) => SKILLS[s]) : skillsForPosting(p);
    if (!skills.length) continue;
    total += 1;
    // A 90-fit posting is 1.9× a 0-fit one. Deliberately gentle: an unscored
    // posting (fit null) lands at 1.0 rather than being dropped, because
    // "unscored" is common and dropping it would bias the whole read toward
    // whatever happened to be scored.
    const w = weightByFit && Number.isFinite(p.fit_score) ? 1 + p.fit_score / 100 : 1;
    const mid = p.comp_min != null && p.comp_max != null ? (p.comp_min + p.comp_max) / 2 : (p.comp_min ?? p.comp_max ?? null);
    for (const id of skills) {
      counts.set(id, (counts.get(id) || 0) + 1);
      weights.set(id, (weights.get(id) || 0) + w);
      if (mid != null) {
        if (!comps.has(id)) comps.set(id, []);
        comps.get(id).push(mid);
      }
    }
  }

  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const rows = [...counts.entries()]
    .map(([id, count]) => ({
      id,
      label: skillLabel(id),
      category: skillCategory(id),
      count,
      pct: total ? Math.round((count / total) * 100) : 0,
      weighted: Math.round((weights.get(id) || 0) * 10) / 10,
      medianComp: comps.has(id) && comps.get(id).length >= 3 ? Math.round(median(comps.get(id))) : null,
    }))
    .sort((a, b) => b.weighted - a.weighted || b.count - a.count || a.label.localeCompare(b.label));

  return { rows, total };
}

/**
 * Demand vs. what the resume evidences.
 *
 * `gaps` is the headline: things the market keeps asking for that your resume
 * does not say. Sorted by weighted demand so the top of the list is the highest
 * -leverage thing to learn or to write down — and "write down" matters as much
 * as "learn": a gap here can mean the skill is missing OR that it is real and
 * simply absent from the resume, which is a five-minute fix worth surfacing.
 *
 * MIN_N exists because a skill appearing in one posting is not a market signal.
 */
export const GAP_MIN_N = 2;

export function gapAnalysis(postings, resumeContent, opts) {
  const { rows, total } = marketDemand(postings, opts);
  const mine = new Set(skillsForResume(resumeContent));
  const covered = [];
  const gaps = [];
  for (const r of rows) {
    const row = { ...r, have: mine.has(r.id) };
    if (row.have) covered.push(row);
    else if (r.count >= GAP_MIN_N) gaps.push(row);
  }
  // Skills you have that this market never mentions — the other half of
  // positioning, and the half nobody looks at: resume real estate spent on
  // something your targets do not buy.
  const demanded = new Set(rows.map((r) => r.id));
  const unused = [...mine].filter((id) => !demanded.has(id)).map((id) => ({
    id, label: skillLabel(id), category: skillCategory(id),
  }));

  const coverage = rows.length ? Math.round((covered.length / rows.length) * 100) : null;
  return { rows, total, covered, gaps, unused, coverage, thin: total < 5 };
}
