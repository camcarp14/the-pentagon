// Planted problems for skill extraction and the gap read.
//
// The failure this guards is quiet and expensive: a dictionary that matches too
// loosely reports demand that is not there, and a positioning page built on
// phantom demand sends you to learn the wrong thing. So the precision cases
// here matter more than the recall ones.
import { describe, it, expect } from 'vitest';
import { extractSkills, skillsForPosting, skillsForResume, marketDemand, gapAnalysis, GAP_MIN_N, SKILLS } from '../lib/skills.js';

const resume = {
  summary: 'Performance marketer running paid search programs.',
  skills: ['google ads', 'sql', 'excel'],
  experience: [{
    company: 'Acme', title: 'Paid Search Manager', dates: '2022 – present',
    bullets: ['Managed a $2.4M annual budget across 12 healthcare clients', 'Built dashboards in Looker'],
  }],
};

describe('extraction', () => {
  it('finds skills by any of their aliases', () => {
    expect(extractSkills('Experience with PPC required')).toContain('paid_search');
    expect(extractSkills('Deep SEM background')).toContain('paid_search');
    expect(extractSkills('You will run AdWords campaigns')).toContain('google_ads');
  });

  it('does not fire on a substring inside another word', () => {
    // "sql" inside "sqlite" is fine (it is SQL), but these are the real traps:
    // a dictionary that substring-matches turns every posting into every skill.
    expect(extractSkills('We assemble semantic layers')).not.toContain('paid_search');
    expect(extractSkills('A great team culture')).not.toContain('cloud');
    expect(extractSkills('Our reporting cadence is weekly')).not.toContain('git');
  });

  it('prefers the longest alias when two overlap', () => {
    // "google tag manager" must not be claimed by "google ads"
    const found = extractSkills('Hands-on with Google Tag Manager');
    expect(found).toContain('gtm');
    expect(found).not.toContain('google_ads');
  });

  it('keeps the characters skill names actually contain', () => {
    expect(extractSkills('Strong Node.js background')).toContain('javascript');
    expect(extractSkills('A/B testing at scale')).toContain('ab_testing');
  });

  it('returns a stable, dictionary-ordered array so a stored column never churns', () => {
    const a = extractSkills('sql looker python sql');
    const b = extractSkills('python looker sql');
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  it('reads a posting from its title, requirements and body together', () => {
    const found = skillsForPosting({
      title: 'Paid Search Manager',
      requirements: ['5+ years managing Google Ads', 'SQL proficiency'],
      raw_description: 'You will own attribution modeling.',
    });
    expect(found).toEqual(expect.arrayContaining(['paid_search', 'google_ads', 'sql', 'attribution']));
  });

  it('reads a resume from its summary, skills and every bullet', () => {
    const mine = skillsForResume(resume);
    expect(mine).toEqual(expect.arrayContaining(['paid_search', 'google_ads', 'sql', 'excel', 'looker', 'budget_management']));
  });

  it('degrades on junk instead of throwing', () => {
    for (const junk of [null, undefined, {}, { requirements: 'not an array' }]) {
      expect(() => skillsForPosting(junk)).not.toThrow();
    }
    expect(skillsForResume(null)).toEqual([]);
  });
});

describe('market demand', () => {
  const postings = [
    { skills: ['paid_search', 'sql'], fit_score: 90, comp_min: 140000, comp_max: 160000 },
    { skills: ['paid_search', 'google_ads'], fit_score: 80, comp_min: 130000, comp_max: 150000 },
    { skills: ['paid_search'], fit_score: 20, comp_min: 90000, comp_max: 100000 },
    { skills: ['sql'], fit_score: 70, comp_min: 150000, comp_max: 170000 },
  ];

  it('counts and percentages the sample it was given', () => {
    const { rows, total } = marketDemand(postings);
    expect(total).toBe(4);
    const ps = rows.find((r) => r.id === 'paid_search');
    expect(ps.count).toBe(3);
    expect(ps.pct).toBe(75);
  });

  it('weights toward the postings that actually fit you', () => {
    // sql appears twice at high fit; google_ads once at high fit. Weighting
    // must not simply re-sort by raw count.
    const { rows } = marketDemand(postings);
    const sql = rows.find((r) => r.id === 'sql');
    const ga = rows.find((r) => r.id === 'google_ads');
    expect(sql.weighted).toBeGreaterThan(ga.weighted);
  });

  it('can be told not to weight', () => {
    const { rows } = marketDemand(postings, { weightByFit: false });
    const ps = rows.find((r) => r.id === 'paid_search');
    expect(ps.weighted).toBe(3);
  });

  it('does not claim a median comp on fewer than three priced postings', () => {
    const { rows } = marketDemand(postings);
    expect(rows.find((r) => r.id === 'paid_search').medianComp).not.toBeNull();
    expect(rows.find((r) => r.id === 'google_ads').medianComp).toBeNull();
  });

  it('falls back to extracting when a posting carries no stored skills', () => {
    const { rows, total } = marketDemand([{ title: 'Paid Search Manager', raw_description: 'SQL required' }]);
    expect(total).toBe(1);
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(['paid_search', 'sql']));
  });

  it('survives an empty or null sample', () => {
    expect(marketDemand(null)).toEqual({ rows: [], total: 0 });
    expect(marketDemand([])).toEqual({ rows: [], total: 0 });
  });
});

describe('the gap read', () => {
  const market = [
    { skills: ['paid_search', 'sql', 'attribution'], fit_score: 90 },
    { skills: ['paid_search', 'attribution'], fit_score: 85 },
    { skills: ['paid_search', 'python'], fit_score: 60 },
  ];

  it('splits demand into what the resume evidences and what it does not', () => {
    const a = gapAnalysis(market, resume);
    expect(a.covered.map((r) => r.id)).toContain('paid_search');
    expect(a.covered.map((r) => r.id)).toContain('sql');
    expect(a.gaps.map((r) => r.id)).toContain('attribution');
  });

  it('suppresses a one-off as a gap — one posting is not a market signal', () => {
    const a = gapAnalysis(market, resume);
    // python appears once; attribution twice
    expect(a.gaps.map((r) => r.id)).not.toContain('python');
    expect(GAP_MIN_N).toBe(2);
  });

  it('ranks gaps by weighted demand, highest leverage first', () => {
    const a = gapAnalysis(market, resume);
    const weights = a.gaps.map((g) => g.weighted);
    expect(weights).toEqual([...weights].sort((x, y) => y - x));
  });

  it('names what is on the resume that this market never asks for', () => {
    const a = gapAnalysis(market, resume);
    expect(a.unused.map((u) => u.id)).toEqual(expect.arrayContaining(['excel', 'looker']));
    expect(a.unused.map((u) => u.id)).not.toContain('paid_search');
  });

  it('flags a thin sample rather than presenting it as a finding', () => {
    expect(gapAnalysis(market, resume).thin).toBe(true);
    const wide = Array.from({ length: 6 }, () => ({ skills: ['sql'], fit_score: 50 }));
    expect(gapAnalysis(wide, resume).thin).toBe(false);
  });

  it('handles no resume at all — demand is still readable', () => {
    const a = gapAnalysis(market, null);
    expect(a.rows.length).toBeGreaterThan(0);
    expect(a.covered).toEqual([]);
    expect(a.coverage).toBe(0);
  });
});

describe('the dictionary itself', () => {
  it('gives every skill a label, a category and at least one alias', () => {
    for (const [id, def] of Object.entries(SKILLS)) {
      expect(def.label, `${id} has no label`).toBeTruthy();
      expect(def.category, `${id} has no category`).toBeTruthy();
      expect(def.aliases.length, `${id} has no aliases`).toBeGreaterThan(0);
    }
  });

  it('has no alias short enough to be noise', () => {
    // A one- or two-character alias matches something in every posting ever
    // written. If one is ever genuinely needed it needs a stricter matcher
    // than this, and this test is where that conversation starts.
    const tiny = Object.entries(SKILLS).flatMap(([id, d]) => d.aliases.filter((a) => a.length < 3).map((a) => `${id}: "${a}"`));
    expect(tiny, `aliases too short to be safe:\n${tiny.join('\n')}`).toEqual([]);
  });
});
