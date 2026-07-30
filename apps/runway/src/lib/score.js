// Deterministic fit-scoring engine — no AI, no network, no randomness.
// The AI (capture parsing) only EXTRACTS structured fields from a posting;
// this module turns (job, profile) into a 0–100 score + breakdown + one-line
// rationale. Deterministic on purpose: scripts/smoke.mjs plants problems and
// asserts exact behavior, so silent regressions here fail the verify gate.

export const SENIORITY_LADDER = ['intern', 'junior', 'mid', 'senior', 'lead', 'manager', 'director', 'vp', 'exec'];

export const FLAG_DEFS = {
  vague_comp: { label: 'Vague comp', penalty: 3, hint: 'No numbers in the posting' },
  buzzword_heavy: { label: 'Buzzword-heavy copy', penalty: 5, hint: 'Rockstar/ninja/fast-paced density' },
  unreasonable_requirements: { label: 'Unreasonable requirements', penalty: 8, hint: 'Laundry-list or contradictory asks' },
  excluded_industry: { label: 'Excluded industry', penalty: 10, hint: 'Matches an industries-out entry' },
  reposted: { label: 'Reposted role', penalty: 6, hint: 'Same role re-listed under a new id within 90 days — possible ghost posting' },
};

const norm = (s) => String(s ?? '').toLowerCase();
// keep + and # so "c++"/"c#" style keywords survive; everything else becomes
// a word boundary, so "paid search" matches "Paid Search / SEM Manager"
const clean = (s) => ` ${norm(s).replace(/[^a-z0-9+#]+/g, ' ').trim()} `;
export const hasKeyword = (hay, kw) => {
  const k = clean(kw).trim();
  return k ? clean(hay).includes(` ${k} `) : false;
};

const asArr = (x) => (Array.isArray(x) ? x : []);
const flagIds = (arr) => asArr(arr).map((f) => (typeof f === 'string' ? f : f?.id)).filter(Boolean);

const REMOTE_PTS = {
  any:    { remote: 15, hybrid: 15, onsite: 15, unknown: 15 },
  remote: { remote: 15, hybrid: 5,  onsite: 0,  unknown: 7 },
  hybrid: { remote: 12, hybrid: 15, onsite: 8,  unknown: 7 },
  onsite: { remote: 8,  hybrid: 12, onsite: 15, unknown: 7 },
};

const fmtK = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const joinAnd = (xs) =>
  xs.length <= 1 ? xs[0] || '' : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`;

export function scoreJob(job, profile) {
  if (!profile) {
    return { score: null, rationale: 'No target profile yet — set one on the Profile page to score captures.', breakdown: [], flags: flagIds(job.flags) };
  }
  const b = [];
  const flags = new Set(flagIds(job.flags));
  // vague_comp and excluded_industry are DERIVED below from the job's own
  // fields, so they are decided fresh on every pass. Seeding them from the
  // stored flags made them permanent: the scorer persists what it added, no UI
  // can clear them (JobForm only toggles buzzword_heavy/unreasonable_requirements
  // and re-extract re-unions the old set), and the next rescore read them back
  // in. A job later edited to state $140k–$160k kept its "Vague comp" chip and
  // its 3-point dock forever, ranked below its true fit on the board.
  flags.delete('vague_comp');
  flags.delete('excluded_industry');

  // 1) Title — 30. Any strong keyword hit in the title = 24; +3 per extra hit
  //    (cap 30). No title hit but a keyword in the description = 8.
  const kws = asArr(profile.title_keywords);
  const titleHits = kws.filter((k) => hasKeyword(job.title, k));
  const descHit = kws.some((k) => hasKeyword(job.raw_description, k));
  const titlePts = titleHits.length > 0 ? Math.min(30, 24 + (titleHits.length - 1) * 3) : descHit ? 8 : 0;
  b.push({
    k: 'title', label: 'Title match', pts: titlePts, max: 30,
    why: titleHits.length ? `matches ${joinAnd(titleHits)}` : descHit ? 'keywords only in the description, not the title' : 'no target keywords in the title',
  });

  // 2) Comp — 25 vs the floor. Unknown comp = 10 + vague_comp flag (uncertainty,
  //    not a zero). Tops out under the floor = 0. Clears the floor = 25.
  const hasComp = job.comp_min != null || job.comp_max != null;
  const floor = profile.comp_floor;
  const cmin = job.comp_min ?? job.comp_max;
  const cmax = job.comp_max ?? job.comp_min;
  let compPts, compWhy;
  if (!hasComp) { compPts = 10; flags.add('vague_comp'); compWhy = 'no comp stated'; }
  else if (floor == null) { compPts = 18; compWhy = 'comp stated; no floor set in your profile'; }
  else if (cmax < floor) { compPts = 0; compWhy = `tops out at $${fmtK(cmax)}, under your $${fmtK(floor)} floor`; }
  else if (cmin >= floor) { compPts = 25; compWhy = `starts at $${fmtK(cmin)}, clears your $${fmtK(floor)} floor`; }
  else { compPts = 15; compWhy = `range $${fmtK(cmin)}–$${fmtK(cmax)} straddles your $${fmtK(floor)} floor`; }
  b.push({ k: 'comp', label: 'Compensation', pts: compPts, max: 25, why: compWhy });

  // 3) Location/remote — 15 via preference matrix
  const pref = REMOTE_PTS[profile.remote_pref] ? profile.remote_pref : 'any';
  const rt = REMOTE_PTS[pref][job.remote_type] != null ? job.remote_type : 'unknown';
  b.push({
    k: 'remote', label: 'Location/remote', pts: REMOTE_PTS[pref][rt], max: 15,
    why: pref === 'any' ? 'no location constraint set' : `${rt} role vs your ${pref} preference`,
  });

  // 4) Seniority — 15 in band, 7 one rung off or unknown, 0 otherwise
  const band = asArr(profile.seniority_band).map(norm).filter((s) => SENIORITY_LADDER.includes(s));
  const js = norm(job.seniority);
  let senPts, senWhy;
  if (!band.length || !SENIORITY_LADDER.includes(js)) { senPts = 7; senWhy = 'seniority unclear'; }
  else if (band.includes(js)) { senPts = 15; senWhy = `${js} sits in your band`; }
  else {
    const ji = SENIORITY_LADDER.indexOf(js);
    const dist = Math.min(...band.map((s) => Math.abs(SENIORITY_LADDER.indexOf(s) - ji)));
    senPts = dist === 1 ? 7 : 0;
    senWhy = dist === 1 ? `${js} is one rung off your band` : `${js} is far from your band`;
  }
  b.push({ k: 'seniority', label: 'Seniority', pts: senPts, max: 15, why: senWhy });

  // 5) Industry — 15. An industries-out hit anywhere in the posting zeroes it
  //    AND flags it; an industries-in hit = 15; no signal = 8 neutral.
  const hayAll = [job.industry, job.company, job.title, job.raw_description].join(' \n ');
  const outHit = asArr(profile.industries_out).find((k) => hasKeyword(hayAll, k));
  const inHit = asArr(profile.industries_in).find((k) => hasKeyword(hayAll, k));
  let indPts, indWhy;
  if (outHit) { indPts = 0; flags.add('excluded_industry'); indWhy = `matches excluded industry “${outHit}”`; }
  else if (inHit) { indPts = 15; indWhy = `matches target industry “${inHit}”`; }
  else { indPts = 8; indWhy = 'no industry signal either way'; }
  b.push({ k: 'industry', label: 'Industry', pts: indPts, max: 15, why: indWhy });

  // Red-flag penalties, applied once per flag; clamp to [0, 100]
  const flagList = [...flags];
  const penalty = flagList.reduce((s, id) => s + (FLAG_DEFS[id]?.penalty || 0), 0);
  const raw = b.reduce((s, x) => s + x.pts, 0);
  const score = Math.max(0, Math.min(100, raw - penalty));

  return { score, rationale: buildRationale(b, flagList, score), breakdown: b, flags: flagList };
}

function buildRationale(b, flags, score) {
  const strong = b.filter((x) => x.pts / x.max >= 0.8).map((x) => x.label.toLowerCase());
  const weak = b.filter((x) => x.pts / x.max <= 0.34).map((x) => x.label.toLowerCase());
  const flagged = flags.filter((f) => FLAG_DEFS[f]).map((f) => FLAG_DEFS[f].label.toLowerCase());
  let s = strong.length ? `Strong on ${joinAnd(strong)}` : score >= 50 ? 'Middling match across the board' : 'Weak match overall';
  const docks = [...weak.map((w) => `weak ${w}`), ...flagged];
  if (docks.length) s += `; docked for ${joinAnd(docks)}`;
  return s + '.';
}

export const scoreBadge = (score) => (score == null ? 'none' : score >= 70 ? 'good' : score >= 40 ? 'mid' : 'bad');
