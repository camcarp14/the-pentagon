// The role matcher. Decides whether a posting is worth showing you, and — the
// half that used to be missing entirely — says WHY.
//
// It replaces one line:
//
//   const matched = keywords.some((k) => hasKeyword(p.title, k));
//
// which was a word-boundary substring test on the title alone. Three things
// were wrong with it and all three are fixed here:
//
//   1. NO SYNONYMS. See rolefamilies.js — terms expand before they're compared,
//      so "paid search" finds "Senior SEM Specialist".
//   2. NO REASON. A match was a boolean. You could not tell whether a card in
//      the inbox was a bullseye or a coincidence without opening the posting,
//      so every card cost the same attention. Now every match carries the
//      sentences that produced it and the inbox prints them.
//   3. NO NEGATIVE SPACE. There was no way to say "not agency work", "not
//      contract", "not under $130k". The only filter was the positive one, so
//      exclusions had to be done by hand, one dismissal at a time, forever.
//
// SCORE vs FIT. These are two different numbers and the tool shows both:
//   match score (here)  — how well the posting answers THIS SEARCH.
//   fit score (score.js) — how well it fits your standing profile, on a scale
//                          that is comparable across every job you ever saved.
// A posting can match a hunt strongly (it is exactly the search you asked for)
// and still fit poorly (the search itself was aimed low). Collapsing them into
// one number hides that, so they stay apart.
//
// Pure functions, no I/O, no randomness — same posting and same criteria give
// the same verdict forever, which is what makes the unit tests meaningful.
import { hasKeyword, SENIORITY_LADDER } from './score.js';
import { expandTerm, normTerm } from './rolefamilies.js';

export const MATCH_FLOOR = 35; // below this a posting is logged, never queued

const asArr = (x) => (Array.isArray(x) ? x : []);
const clean = (xs) => asArr(xs).map((t) => normTerm(t)).filter(Boolean);

/**
 * Criteria shape (a hunt, or a profile projected into one):
 *   include[]     role terms — ANY may hit, each synonym-expanded
 *   exclude[]     kill terms — a hit anywhere disqualifies
 *   must[]        every one must appear somewhere
 *   seniority[]   allowed rungs; empty = no constraint
 *   remote_pref   'remote' | 'hybrid' | 'onsite' | 'any'
 *   locations[]   place names that count as a location hit
 *   comp_floor    a stated max BELOW this disqualifies
 *   min_fit       queue threshold applied downstream, not here
 */
export function criteriaFromProfile(profile) {
  return {
    include: clean(profile?.title_keywords),
    exclude: clean(profile?.industries_out),
    must: [],
    seniority: clean(profile?.seniority_band),
    remote_pref: profile?.remote_pref || 'any',
    locations: profile?.location_pref ? [normTerm(profile.location_pref)] : [],
    comp_floor: profile?.comp_floor ?? null,
    min_fit: 0,
  };
}

export function criteriaFromHunt(hunt) {
  return {
    include: clean(hunt?.include),
    exclude: clean(hunt?.exclude),
    must: clean(hunt?.must),
    seniority: clean(hunt?.seniority),
    remote_pref: hunt?.remote_pref || 'any',
    locations: clean(hunt?.locations),
    comp_floor: hunt?.comp_floor ?? null,
    min_fit: Number.isFinite(hunt?.min_fit) ? hunt.min_fit : 0,
  };
}

// Title hits are worth roughly triple a body hit, and an exact phrasing is
// worth roughly 1.5× an adjacent one. Those two ratios are the whole model.
const W = {
  title_same: 55,
  title_near: 38,
  body_same: 22,
  body_near: 12,
  extra_title: 10,   // per additional distinct include term hit in the title
  extra_body: 4,
  no_include: 40,    // a criteria set with no role terms is a "show me everything here" hunt
  cap_title: 78,
};

const anyPhrase = (hay, phrases) => phrases.find((p) => hasKeyword(hay, p)) || null;

/**
 * @param posting {title, text, location, remote_type, seniority, comp_min, comp_max}
 * @param criteria see above
 * @returns {matched, score, why[], kills[], tier}
 *   why[]   [{ kind, text }] — every reason, in the order they were decided
 *   kills[] non-empty means disqualified regardless of score
 */
export function matchPosting(posting, criteria) {
  const c = { include: [], exclude: [], must: [], seniority: [], remote_pref: 'any', locations: [], comp_floor: null, ...(criteria || {}) };
  const title = String(posting?.title || '');
  const body = String(posting?.text || posting?.raw_description || '');
  const hay = `${title}\n${posting?.location || ''}\n${body}`;

  const why = [];
  const kills = [];

  // ---- hard filters first. A killed posting must not cost a scoring pass,
  // and more importantly must not appear with a score attached — a number
  // beside "excluded" reads like a near miss.
  const excludeHit = anyPhrase(hay, c.exclude);
  if (excludeHit) {
    kills.push({ kind: 'exclude', text: `excluded — the posting mentions “${excludeHit}”` });
  }
  for (const m of c.must) {
    if (!hasKeyword(hay, m)) kills.push({ kind: 'must', text: `missing a required term — “${m}” appears nowhere in the posting` });
  }
  // A stated ceiling below the floor is the one comp fact that is definitive.
  // A posting with NO comp is never killed here: silence is not a low number,
  // and most postings are silent.
  if (c.comp_floor != null && posting?.comp_max != null && posting.comp_max < c.comp_floor) {
    kills.push({ kind: 'comp', text: `tops out at $${Math.round(posting.comp_max / 1000)}k, under your $${Math.round(c.comp_floor / 1000)}k floor` });
  }

  // ---- seniority. Distance on the ladder, not equality: "one rung off" is a
  // real opportunity and "three rungs off" is a different job.
  const js = normTerm(posting?.seniority);
  const band = c.seniority.filter((s) => SENIORITY_LADDER.includes(s));
  let seniorityAdj = 0;
  if (band.length && SENIORITY_LADDER.includes(js)) {
    const ji = SENIORITY_LADDER.indexOf(js);
    const dist = Math.min(...band.map((s) => Math.abs(SENIORITY_LADDER.indexOf(s) - ji)));
    if (dist === 0) { seniorityAdj = 10; why.push({ kind: 'seniority', text: `${js} sits in your band` }); }
    else if (dist === 1) { seniorityAdj = -10; why.push({ kind: 'seniority', text: `${js} is one rung off your band` }); }
    else if (dist === 2) { seniorityAdj = -20; why.push({ kind: 'seniority', text: `${js} is two rungs off your band` }); }
    else kills.push({ kind: 'seniority', text: `${js} is far outside your band` });
  }

  if (kills.length) {
    return { matched: false, score: 0, why, kills, tier: 'killed' };
  }

  // ---- role terms. Best tier wins; extra hits add, but a second adjacent hit
  // never beats a first exact one.
  let base = 0;
  let tier = 'none';
  if (!c.include.length) {
    base = W.no_include;
    tier = 'open';
    why.push({ kind: 'role', text: 'no role terms on this search — everything on the board is in scope' });
  } else {
    const expanded = c.include.map(expandTerm);
    const titleSame = [], titleNear = [], bodySame = [], bodyNear = [];
    for (const e of expanded) {
      const ts = anyPhrase(title, e.same);
      if (ts) { titleSame.push({ term: e.term, hit: ts }); continue; }
      const tn = anyPhrase(title, e.near);
      if (tn) { titleNear.push({ term: e.term, hit: tn }); continue; }
      const bs = anyPhrase(body, e.same);
      if (bs) { bodySame.push({ term: e.term, hit: bs }); continue; }
      const bn = anyPhrase(body, e.near);
      if (bn) bodyNear.push({ term: e.term, hit: bn });
    }
    const say = (h) => (normTerm(h.hit) === h.term ? `“${h.hit}”` : `“${h.hit}” (your “${h.term}”)`);

    if (titleSame.length) {
      base = Math.min(W.cap_title, W.title_same + (titleSame.length - 1) * W.extra_title);
      tier = 'title-exact';
      why.push({ kind: 'role', text: `title match on ${titleSame.map(say).join(', ')}` });
      if (titleNear.length) why.push({ kind: 'role', text: `also related: ${titleNear.map(say).join(', ')}` });
    } else if (titleNear.length) {
      base = Math.min(W.cap_title, W.title_near + (titleNear.length - 1) * W.extra_title);
      tier = 'title-related';
      why.push({ kind: 'role', text: `related title — ${titleNear.map(say).join(', ')}` });
    } else if (bodySame.length) {
      base = W.body_same + (bodySame.length - 1) * W.extra_body;
      tier = 'body-exact';
      why.push({ kind: 'role', text: `your terms are in the description but not the title: ${bodySame.map(say).join(', ')}` });
    } else if (bodyNear.length) {
      base = W.body_near + (bodyNear.length - 1) * W.extra_body;
      tier = 'body-related';
      why.push({ kind: 'role', text: `only loosely related, and only in the body: ${bodyNear.map(say).join(', ')}` });
    } else {
      return {
        matched: false, score: 0, tier: 'none', kills: [],
        why: [{ kind: 'role', text: 'none of your role terms appear, in the title or the body' }],
      };
    }
  }

  // ---- modifiers
  let score = base + seniorityAdj;

  const rt = normTerm(posting?.remote_type) || 'unknown';
  if (c.remote_pref !== 'any' && rt !== 'unknown') {
    if (rt === c.remote_pref) { score += 7; why.push({ kind: 'remote', text: `${rt}, which is what you asked for` }); }
    else if (c.remote_pref === 'remote' && rt === 'onsite') { score -= 30; why.push({ kind: 'remote', text: 'onsite, and you want remote' }); }
    else if (c.remote_pref === 'onsite' && rt === 'remote') { score -= 15; why.push({ kind: 'remote', text: 'remote, and you want onsite' }); }
    else { score -= 6; why.push({ kind: 'remote', text: `${rt} against your ${c.remote_pref} preference` }); }
  }

  if (c.locations.length) {
    const locHay = `${posting?.location || ''} ${title}`;
    const locHit = anyPhrase(locHay, c.locations);
    if (locHit) { score += 8; why.push({ kind: 'location', text: `in ${locHit}` }); }
    else if (rt === 'remote') { score += 4; why.push({ kind: 'location', text: 'not in your locations, but remote' }); }
    else { score -= 10; why.push({ kind: 'location', text: `outside your locations${posting?.location ? ` (${posting.location})` : ''}` }); }
  }

  if (c.comp_floor != null) {
    if (posting?.comp_min != null && posting.comp_min >= c.comp_floor) {
      score += 8;
      why.push({ kind: 'comp', text: `starts at $${Math.round(posting.comp_min / 1000)}k, clears your floor` });
    } else if (posting?.comp_min == null && posting?.comp_max == null) {
      why.push({ kind: 'comp', text: 'no comp stated — not counted either way' });
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { matched: score >= MATCH_FLOOR, score, why, kills: [], tier };
}

// The one-line version for a card. Takes the strongest reason rather than
// concatenating them all — the full list belongs behind a disclosure.
export function matchHeadline(result) {
  if (!result) return '';
  if (result.kills?.length) return result.kills[0].text;
  const role = result.why?.find((w) => w.kind === 'role');
  return role ? role.text : (result.why?.[0]?.text || '');
}

export const TIER_LABEL = {
  'title-exact': 'exact title match',
  'title-related': 'related title',
  'body-exact': 'in the description',
  'body-related': 'loosely related',
  open: 'no role filter',
  none: 'no match',
  killed: 'excluded',
};

/**
 * Run a posting against several hunts and keep the best result. Returns
 * { hunt, result } for the winner, or null when nothing matched — so the
 * scanner can attribute a discovery to the search that found it.
 */
export function bestMatch(posting, hunts) {
  let best = null;
  for (const hunt of hunts || []) {
    if (hunt.active === false) continue;
    const result = matchPosting(posting, criteriaFromHunt(hunt));
    if (!result.matched) continue;
    if (result.score < (hunt.min_fit || 0)) continue;
    if (!best || result.score > best.result.score) best = { hunt, result };
  }
  return best;
}
