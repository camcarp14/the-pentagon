// Board probing — "does this company publish a public ATS feed, and where?"
//
// Lifted out of find-board.mjs verbatim (same endpoints, same count semantics)
// because a second caller now needs it: company discovery probes a whole list
// of names rather than one typed name. Extracting it rather than copying it
// keeps ONE census of providers — a copy would drift the moment a provider
// changed its endpoint, and the bug would look like "discovery can't find
// companies that Watch finds fine".
//
// Every endpoint here is published by its provider for public consumption.
// No LinkedIn / Indeed / Glassdoor: they prohibit it, and this repo's line on
// that does not move.
import { slugCandidates } from '../../../apps/runway/src/lib/jobsource.js';

const TIMEOUT_MS = 6000;

const get = async (url, type = 'json') => {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) return null;
  return type === 'json' ? r.json() : r.text();
};

// Each probe returns a posting count or null (no board). The original three
// report any live board; the newer providers require count > 0, because some
// multi-tenant hosts answer 200 with an empty feed for slugs that don't exist.
export const PROBES = {
  greenhouse: async (slug) => {
    const j = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    return Array.isArray(j?.jobs) ? j.jobs.length : null;
  },
  lever: async (slug) => {
    const j = await get(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    return Array.isArray(j) ? j.length : null;
  },
  ashby: async (slug) => {
    const j = await get(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    return Array.isArray(j?.jobs) ? j.jobs.length : null;
  },
  smartrecruiters: async (slug) => {
    const j = await get(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1&offset=0&status=PUBLIC`);
    const n = Number(j?.totalFound ?? (Array.isArray(j?.content) ? j.content.length : NaN));
    return Number.isFinite(n) && n > 0 ? n : null;
  },
  workable: async (slug) => {
    const t = await get(`https://apply.workable.com/${slug}/jobs.md`, 'text');
    if (typeof t !== 'string') return null;
    const n = t.split('\n').filter((l) => l.startsWith('|') && l.includes('[View]')).length;
    return n > 0 ? n : null;
  },
  recruitee: async (slug) => {
    const j = await get(`https://${slug}.recruitee.com/api/offers/`);
    return Array.isArray(j?.offers) && j.offers.length > 0 ? j.offers.length : null;
  },
  breezy: async (slug) => {
    const j = await get(`https://${slug}.breezy.hr/json`);
    return Array.isArray(j) && j.length > 0 ? j.length : null;
  },
  rippling: async (slug) => {
    const j = await get(`https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`);
    return Array.isArray(j) && j.length > 0 ? j.length : null;
  },
  bamboohr: async (slug) => {
    const j = await get(`https://${slug}.bamboohr.com/careers/list`);
    return Array.isArray(j?.result) && j.result.length > 0 ? j.result.length : null;
  },
  jobvite: async (slug) => {
    const j = await get(`https://jobs.jobvite.com/api/company/${slug}/jobs`);
    return Array.isArray(j?.jobs) && j.jobs.length > 0 ? j.jobs.length : null;
  },
  pinpoint: async (slug) => {
    const j = await get(`https://${slug}.pinpointhq.com/postings.json`);
    return Array.isArray(j?.data) && j.data.length > 0 ? j.data.length : null;
  },
  teamtailor: async (slug) => {
    const t = await get(`https://${slug}.teamtailor.com/jobs.rss`, 'text');
    if (typeof t !== 'string') return null;
    const n = (t.match(/<item\b/gi) || []).length;
    return n > 0 ? n : null;
  },
  personio: async (slug) => {
    // a nonexistent tenant throws (NXDOMAIN) on .de — still try .com
    for (const tld of ['de', 'com']) {
      try {
        const t = await get(`https://${slug}.jobs.personio.${tld}/xml`, 'text');
        if (typeof t === 'string') {
          const n = (t.match(/<position\b/g) || []).length;
          if (n > 0) return n;
        }
      } catch { /* try the next tld */ }
    }
    return null;
  },
};

export const ALL_PROVIDERS = Object.keys(PROBES);
// The three that host the large majority of the boards worth watching. Company
// discovery tries these first and only pays for the long tail when they miss —
// probing 13 providers × 2 slug spellings for every company on a list is 26
// requests per company, which does not fit a function timeout at any useful
// list length.
export const COMMON_PROVIDERS = ['greenhouse', 'lever', 'ashby'];

export async function probe(provider, slug) {
  try {
    const count = await PROBES[provider](slug);
    return count != null ? { provider, board: slug, count } : null;
  } catch { return null; } // dead probe = no hit
}

/**
 * Probe one company name across a provider set. Returns de-duplicated hits,
 * highest posting count first — when a company has both a stale Lever board and
 * a live Greenhouse one, the live one should be the suggestion.
 */
export async function probeCompany(name, { providers = ALL_PROVIDERS, maxSlugs = 2 } = {}) {
  const slugs = slugCandidates(name).slice(0, maxSlugs);
  if (!slugs.length) return [];
  const results = await Promise.all(
    slugs.flatMap((slug) => providers.map((provider) => probe(provider, slug))),
  );
  const seen = new Set();
  return results
    .filter(Boolean)
    .filter((h) => {
      const key = `${h.provider}|${h.board}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.count - a.count);
}
