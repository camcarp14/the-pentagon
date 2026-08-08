// Targets, derived from the master resume. Deterministic, no AI, no network.
//
// WHAT PROBLEM THIS SOLVES: Runway scores nothing until `target_profile` is
// filled, and `target_profile` is a wall of empty inputs — title keywords,
// seniority band, industries, a comp floor. A new user's first experience is
// therefore an interrogation, and the answers are all already sitting in the
// master resume they just imported. Every field below can be read off that
// resume; asking for them twice is the bug.
//
// FILL, NEVER OVERWRITE. This runs against whatever is already in the form and
// only touches fields that are empty. A derived guess is a starting point, and
// the moment a human has expressed a preference the guess is worth less than
// what they typed — including when they typed it and then came back later.
// That rule is what makes the button safe to press twice.
//
// WHY THE OUTPUT IS NOT SAVED HERE: this returns a patch and a list of what it
// touched. The page shows the result in the form and waits for Save, so a bad
// derivation is visible before it is scoring anything, and correcting it is
// editing a filled-in field rather than undoing a write.
import { SENIORITY_LADDER, hasKeyword } from './score.js';
import { familiesFor, normTerm } from './rolefamilies.js';
import { SKILLS } from './skills.js';
import { resumeText } from './coverage.js';

// ---------------------------------------------------------------- industries
// A resume states its industries in prose, not in a field: "healthcare
// portfolio", "core retail program", "bootstrapped DTC brand". This dictionary
// is the read of that prose. It is deliberately small and literal — every
// entry has to be a word someone actually writes about their own work, because
// a term nobody writes is a term that never fires, and a term that is too broad
// ("technology") fires on everything and makes the industry signal worthless.
//
// The canonical id on the left is what lands in `industries_in`, so it also has
// to read well as a chip the user might delete.
export const INDUSTRY_TERMS = {
  healthcare: ['healthcare', 'health care', 'health system', 'medicare', 'medicaid', 'patient', 'payer', 'hospital', 'clinical', 'provider network', 'telehealth'],
  pharma: ['pharma', 'pharmaceutical', 'biotech', 'life sciences', 'drug development'],
  retail: ['retail', 'brick and mortar', 'merchandising', 'in store'],
  ecommerce: ['ecommerce', 'e commerce', 'dtc', 'direct to consumer', 'shopify', 'online store', 'marketplace seller'],
  saas: ['saas', 'software as a service', 'b2b software', 'subscription software'],
  fintech: ['fintech', 'financial services', 'banking', 'payments', 'lending', 'wealth management'],
  insurance: ['insurance', 'insurtech', 'underwriting', 'risk management', 'claims'],
  education: ['education', 'edtech', 'higher ed', 'university', 'k 12', 'enrollment marketing'],
  media: ['media', 'publishing', 'streaming', 'entertainment', 'broadcast'],
  travel: ['travel', 'hospitality', 'airline', 'hotel', 'tourism'],
  automotive: ['automotive', 'auto dealer', 'vehicle sales'],
  cpg: ['cpg', 'consumer packaged goods', 'fmcg'],
  nonprofit: ['nonprofit', 'non profit', 'ngo', 'philanthropy', 'fundraising'],
  gaming: ['gaming', 'video game', 'esports'],
  legal: ['legal', 'law firm', 'litigation'],
  'real estate': ['real estate', 'proptech', 'brokerage'],
  logistics: ['logistics', 'supply chain', 'freight', 'fulfillment'],
  energy: ['energy', 'utilities', 'solar', 'renewables'],
  government: ['government', 'public sector', 'federal agency'],
  agency: ['agency', 'client portfolio', 'client services', 'account management'],
};

// Terms that name a TOOL rather than a ROLE. Title keywords are matched against
// job titles by score.js, and a title almost never names the tool — "Google Ads
// Manager" exists but "SA360 Manager" does not. Worse, these are the entries
// that make the derived chip list read like a software inventory instead of a
// list of jobs. So a family term that is also a platform alias is dropped from
// the title keywords, and kept nowhere else, because skills.js already reads
// tools off the resume for the Skills page.
const PLATFORM_ALIASES = new Set(
  Object.values(SKILLS)
    .filter((s) => s.category === 'Platforms & tools')
    .flatMap((s) => s.aliases.map(normTerm)),
);

const arr = (x) => (Array.isArray(x) ? x : []);
const isBlank = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

// Plural-tolerant phrase match, the same allowance coverage.js makes: a resume
// says "client portfolios" and "patients", and a dictionary written in the
// singular should still read them. Without this the industry pass silently
// under-fires on exactly the phrasing resumes are written in.
const termHits = (text, t) =>
  hasKeyword(text, t) ||
  hasKeyword(text, `${t}s`) ||
  (t.endsWith('s') && t.length > 3 && hasKeyword(text, t.slice(0, -1)));

// ------------------------------------------------------------ title keywords
// Evidence comes from titles FIRST and the summary second. A title is a claim
// about what you are hired as; a summary is a claim about what you do, which is
// broader and noisier. Both are used because a title alone is often one family
// wide ("Senior Analyst, Search Engine Marketing" resolves to paid search and
// nothing else) and that under-serves someone whose next job is one family over.
//
// Same-family terms carry full weight: they are the same job under a different
// word, and score.js should treat a hit on any of them as a title match.
// Adjacent families contribute their CANONICAL term only — one chip each, not
// their whole vocabulary. An adjacent family is "you'd want to see this", not
// "this is your job", and letting it spend fourteen keywords on itself would
// drown the family that actually is your job.
export function deriveTitleKeywords(resume) {
  const c = resume || {};
  const titles = arr(c.experience).map((r) => r?.title).filter(Boolean);
  const primary = new Set();
  const adjacent = new Set();

  const collect = (text, { adjacentToo }) => {
    for (const fam of familiesFor(text)) {
      for (const t of fam.terms) {
        const n = normTerm(t);
        if (n && !PLATFORM_ALIASES.has(n)) primary.add(n);
      }
      if (adjacentToo) for (const a of fam.adjacent) adjacent.add(normTerm(a));
    }
  };

  for (const t of titles) collect(t, { adjacentToo: true });

  // The summary widens the net only when the titles were narrow. Someone whose
  // titles already resolve to three families does not need their prose mined
  // for a fourth — they need a shorter list, not a longer one.
  if (primary.size < 8 && c.summary) {
    for (const phrase of String(c.summary).split(/[,.;]/)) collect(phrase.trim(), { adjacentToo: false });
  }

  for (const a of adjacent) primary.delete(a); // never list a term twice
  // Shortest first: "sem" and "paid search" are the phrasings that actually
  // appear in titles, and the long tail is what gets cut when the cap bites.
  const byLength = (xs) => [...xs].sort((a, b) => a.length - b.length || a.localeCompare(b));
  return [...byLength(primary).slice(0, 10), ...byLength(adjacent).slice(0, 6)];
}

// --------------------------------------------------------------- seniority
// The rung is read from the titles, taking the HIGHEST one found rather than
// the most recent. A founder who was a director before is a director; a person
// whose current title omits the word is not junior because of it.
export function deriveSeniority(resume) {
  const titles = arr((resume || {}).experience).map((r) => normTerm(r?.title)).filter(Boolean);
  let best = -1;
  for (const t of titles) {
    for (let i = 0; i < SENIORITY_LADDER.length; i++) {
      if (i > best && hasKeyword(t, SENIORITY_LADDER[i])) best = i;
    }
  }
  if (best < 0) return [];
  // Your rung and the two above it. A job search points up: the rung below is
  // not a target, and score.js already scores it 7 rather than 0 if one shows
  // up. The upper reach stops at director because "senior → vp in one hop" is
  // not a band, it is a fantasy, and a band that wide stops discriminating.
  const ceiling = Math.max(best, SENIORITY_LADDER.indexOf('director'));
  const band = [];
  for (let i = best; i <= Math.min(best + 2, ceiling); i++) band.push(SENIORITY_LADDER[i]);
  return band;
}

// --------------------------------------------------------------- industries
// Read off the whole resume, not just the employer names: "healthcare
// portfolio" appears in a bullet, never in a company field. resumeText() is the
// same projection coverage.js scores against, so an industry that shows up here
// is one the resume can actually evidence in an interview.
export function deriveIndustries(resume) {
  const text = resumeText(resume || {});
  if (!text.trim()) return [];
  return Object.entries(INDUSTRY_TERMS)
    .filter(([, terms]) => terms.some((t) => termHits(text, t)))
    .map(([id]) => id);
}

// --------------------------------------------------------------- comp floor
// A resume never states a salary, so this is the one field that is a SUGGESTION
// rather than a reading, and the UI has to say so. It is offered anyway because
// the alternative is worse: with no floor at all, score.js gives every posting
// a flat 18/25 on compensation, so comp stops discriminating between postings
// entirely and a quarter of the score goes dead.
//
// Nothing filters on this — a role under the floor scores 0 of 25 and still
// surfaces — so a wrong guess costs ranking, not visibility, and one edit fixes
// it. Deliberately round numbers: a precise-looking floor implies a market
// reading this does not have.
export const FLOOR_BY_RUNG = {
  intern: 40000, junior: 65000, mid: 90000, senior: 120000, lead: 140000,
  manager: 150000, director: 190000, vp: 240000, exec: 300000,
};

// The floor tracks the LOWEST rung in the band — the cheapest job you said you
// would take — and the band has to be sorted by the ladder to find it. A band
// the user built by clicking chips arrives in CLICK order, so reading band[0]
// would price "manager, then senior" at the manager number and "senior, then
// manager" at the senior number: the same band, two different floors, decided
// by which chip they happened to press first.
export const deriveCompFloor = (band) => {
  const rungs = arr(band)
    .map((s) => SENIORITY_LADDER.indexOf(String(s).toLowerCase()))
    .filter((i) => i >= 0);
  return rungs.length ? FLOOR_BY_RUNG[SENIORITY_LADDER[Math.min(...rungs)]] : null;
};

/**
 * Derive a target profile from a master resume.
 *
 * @param resume  master-resume content ({ contact, summary, skills, experience })
 * @param current the profile as it stands — every non-empty field is left alone
 * @returns { patch, filled } — `patch` is merge-ready, `filled` names each field
 *          it set, in UI wording, so the page can report what it did instead of
 *          silently rearranging a form the user was looking at.
 */
export function deriveTargets(resume, current = {}) {
  const patch = {};
  const filled = [];
  const set = (key, label, value) => {
    if (isBlank(value) || !isBlank(current?.[key])) return;
    patch[key] = value;
    filled.push(label);
  };

  set('title_keywords', 'title keywords', deriveTitleKeywords(resume));
  const band = deriveSeniority(resume);
  set('seniority_band', 'seniority band', band);
  set('industries_in', 'industries', deriveIndustries(resume));
  set('location_pref', 'location', (resume?.contact?.location || '').trim());
  // The floor follows the band the user is ACTUALLY left with: if they already
  // set a band, the suggestion should track theirs, not the one just computed.
  set('comp_floor', 'a suggested comp floor', deriveCompFloor(isBlank(current?.seniority_band) ? band : current.seniority_band));

  return { patch, filled };
}
