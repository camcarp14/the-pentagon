// Planted problems for the role matcher. Every case here is a posting that
// discovery got WRONG before this module existed, or one it must keep getting
// right afterwards. The whole point of the matcher is recall without noise, and
// those two pull in opposite directions — so both are pinned.
import { describe, it, expect } from 'vitest';
import { matchPosting, criteriaFromProfile, criteriaFromHunt, MATCH_FLOOR, matchHeadline } from '../lib/matcher.js';
import { expandTerm, familiesFor, suggestTerms, normTerm } from '../lib/rolefamilies.js';

const criteria = (over = {}) => ({
  include: ['paid search'], exclude: [], must: [], seniority: [],
  remote_pref: 'any', locations: [], comp_floor: null, ...over,
});
const posting = (over = {}) => ({
  title: '', text: '', location: null, remote_type: 'unknown', seniority: 'unknown',
  comp_min: null, comp_max: null, ...over,
});

describe('the synonym graph', () => {
  it('expands a term into every interchangeable phrasing', () => {
    const e = expandTerm('paid search');
    expect(e.same).toContain('sem');
    expect(e.same).toContain('ppc');
    expect(e.same).toContain('google ads');
    // and the adjacent ring is nearby, not identical
    expect(e.near).toContain('performance marketing');
    expect(e.near).not.toContain('sem');
  });

  it('never reports the same phrase at two weights', () => {
    for (const term of ['paid search', 'software engineer', 'data analyst', 'product manager']) {
      const e = expandTerm(term);
      const overlap = e.same.filter((s) => e.near.includes(s));
      expect(overlap, `"${term}" reported both ways: ${overlap.join(', ')}`).toEqual([]);
    }
  });

  it('anchors on phrases so a short alias cannot match inside a word', () => {
    // "sem" resolving out of "assemble"/"semantic" would make every family
    // claim every posting — the containment check is space-padded for this.
    expect(familiesFor('assemble')).toEqual([]);
    expect(familiesFor('semantic layer')).toEqual([]);
    expect(familiesFor('sem').map((f) => f.id)).toContain('paid_search');
  });

  it('resolves a term that is only a fragment of a family entry', () => {
    expect(familiesFor('senior paid search').map((f) => f.id)).toContain('paid_search');
  });

  it('suggests real terms, shortest first, and never below two characters', () => {
    expect(suggestTerms('p')).toEqual([]);
    const hits = suggestTerms('paid');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.term)).toContain('paid search');
    const lens = hits.map((h) => h.term.length);
    expect(lens).toEqual([...lens].sort((a, b) => a - b));
  });

  it('normalises punctuation without eating the characters skills need', () => {
    expect(normTerm('Paid Search / SEM')).toBe('paid search / sem');
    expect(normTerm('FP&A')).toBe('fp&a');
  });
});

describe('the four postings that used to be missed', () => {
  // Substring-on-title found "Paid Search Manager" and nothing else. These are
  // the same job, four ways, and every one was silently invisible.
  const cases = [
    ['Growth Marketing Manager, Paid Media', 'title-related'],
    ['Senior SEM Specialist', 'title-exact'],
    ['Performance Marketing Lead', 'title-related'],
    ['Manager, Biddable Media', 'title-exact'],
  ];
  for (const [title, tier] of cases) {
    it(`finds "${title}"`, () => {
      const r = matchPosting(posting({ title }), criteria());
      expect(r.matched, `${title} was not matched`).toBe(true);
      expect(r.tier).toBe(tier);
      expect(r.score).toBeGreaterThanOrEqual(MATCH_FLOOR);
    });
  }

  it('still finds the literal title it always found, and ranks it highest', () => {
    const exact = matchPosting(posting({ title: 'Paid Search Manager' }), criteria());
    const related = matchPosting(posting({ title: 'Growth Marketing Manager' }), criteria());
    expect(exact.matched).toBe(true);
    expect(exact.score).toBeGreaterThan(related.score);
  });

  it('does not match an unrelated role just because the graph is wide', () => {
    for (const title of ['Staff Nurse', 'Warehouse Associate', 'Line Cook', 'Structural Engineer']) {
      expect(matchPosting(posting({ title }), criteria()).matched, `${title} should not match`).toBe(false);
    }
  });

  it('ranks a title hit above the same term buried in the body', () => {
    const inTitle = matchPosting(posting({ title: 'Paid Search Manager' }), criteria());
    const inBody = matchPosting(posting({ title: 'Marketing Manager', text: 'You will own paid search.' }), criteria());
    expect(inTitle.score).toBeGreaterThan(inBody.score);
    expect(inBody.tier).toBe('body-exact');
  });
});

describe('the negative space that did not exist before', () => {
  it('kills a posting on an exclude term, with no score attached', () => {
    const r = matchPosting(
      posting({ title: 'Paid Search Manager', text: 'Our agency serves 40 clients.' }),
      criteria({ exclude: ['agency'] }),
    );
    expect(r.matched).toBe(false);
    expect(r.score).toBe(0); // a number beside "excluded" reads like a near miss
    expect(r.kills[0].kind).toBe('exclude');
    expect(matchHeadline(r)).toMatch(/agency/);
  });

  it('kills a posting missing a must-have term', () => {
    const r = matchPosting(posting({ title: 'Paid Search Manager' }), criteria({ must: ['b2b'] }));
    expect(r.matched).toBe(false);
    expect(r.kills[0].kind).toBe('must');
  });

  it('kills a stated ceiling under the floor, but never silence about comp', () => {
    const under = matchPosting(posting({ title: 'Paid Search Manager', comp_min: 80000, comp_max: 95000 }), criteria({ comp_floor: 130000 }));
    expect(under.matched).toBe(false);
    expect(under.kills[0].kind).toBe('comp');

    const silent = matchPosting(posting({ title: 'Paid Search Manager' }), criteria({ comp_floor: 130000 }));
    expect(silent.matched, 'a posting that states no comp must not be dropped').toBe(true);
    expect(silent.why.some((w) => /no comp stated/.test(w.text))).toBe(true);
  });

  it('rewards a floor that is cleared', () => {
    const clears = matchPosting(posting({ title: 'Paid Search Manager', comp_min: 150000, comp_max: 180000 }), criteria({ comp_floor: 130000 }));
    const silent = matchPosting(posting({ title: 'Paid Search Manager' }), criteria({ comp_floor: 130000 }));
    expect(clears.score).toBeGreaterThan(silent.score);
  });
});

describe('seniority is a distance, not an equality', () => {
  const c = criteria({ seniority: ['senior', 'lead'] });
  it('rewards a role inside the band', () => {
    const r = matchPosting(posting({ title: 'Senior Paid Search Manager', seniority: 'senior' }), c);
    expect(r.matched).toBe(true);
    expect(r.why.some((w) => w.kind === 'seniority' && /sits in your band/.test(w.text))).toBe(true);
  });
  it('still surfaces one rung off, scored lower', () => {
    const inBand = matchPosting(posting({ title: 'Paid Search Manager', seniority: 'senior' }), c);
    const oneOff = matchPosting(posting({ title: 'Paid Search Manager', seniority: 'manager' }), c);
    expect(oneOff.matched).toBe(true);
    expect(oneOff.score).toBeLessThan(inBand.score);
  });
  it('kills three rungs off — that is a different job', () => {
    const r = matchPosting(posting({ title: 'Paid Search Intern', seniority: 'intern' }), c);
    expect(r.matched).toBe(false);
    expect(r.kills[0].kind).toBe('seniority');
  });
  it('does not judge seniority it cannot read', () => {
    const r = matchPosting(posting({ title: 'Paid Search Manager', seniority: 'unknown' }), c);
    expect(r.matched).toBe(true);
    expect(r.why.some((w) => w.kind === 'seniority')).toBe(false);
  });
});

describe('remote and location', () => {
  it('penalises an onsite role hard when you want remote, without hiding it', () => {
    const c = criteria({ remote_pref: 'remote' });
    const onsite = matchPosting(posting({ title: 'Paid Search Manager', remote_type: 'onsite' }), c);
    const remote = matchPosting(posting({ title: 'Paid Search Manager', remote_type: 'remote' }), c);
    expect(remote.score).toBeGreaterThan(onsite.score);
    // Penalised, not killed: remote detection off a short feed blurb is not
    // reliable enough to make an invisible decision with.
    expect(onsite.why.some((w) => w.kind === 'remote' && /you want remote/.test(w.text))).toBe(true);
  });

  it('treats a remote role as acceptable when it is outside your locations', () => {
    const c = criteria({ locations: ['chicago'] });
    const elsewhere = matchPosting(posting({ title: 'Paid Search Manager', location: 'Austin, TX', remote_type: 'onsite' }), c);
    const remote = matchPosting(posting({ title: 'Paid Search Manager', location: 'Austin, TX', remote_type: 'remote' }), c);
    expect(remote.score).toBeGreaterThan(elsewhere.score);
  });
});

describe('criteria plumbing', () => {
  it('projects a profile into equivalent criteria, so an account with no hunts behaves the same', () => {
    const c = criteriaFromProfile({
      title_keywords: ['Paid Search'], industries_out: ['Gambling'],
      seniority_band: ['Senior'], remote_pref: 'remote', location_pref: 'Chicago', comp_floor: 130000,
    });
    expect(c.include).toEqual(['paid search']);
    expect(c.exclude).toEqual(['gambling']);
    expect(c.seniority).toEqual(['senior']);
    expect(c.locations).toEqual(['chicago']);
    expect(matchPosting(posting({ title: 'Paid Search Manager' }), c).matched).toBe(true);
  });

  it('survives a null profile and a null hunt without throwing', () => {
    expect(() => criteriaFromProfile(null)).not.toThrow();
    expect(() => criteriaFromHunt(null)).not.toThrow();
    expect(() => matchPosting(null, null)).not.toThrow();
  });

  it('treats a hunt with no role terms as "everything on this board"', () => {
    const r = matchPosting(posting({ title: 'Anything At All' }), criteria({ include: [] }));
    expect(r.matched).toBe(true);
    expect(r.tier).toBe('open');
  });

  it('still applies exclusions to a hunt with no role terms', () => {
    const r = matchPosting(posting({ title: 'Contract Paid Search Manager' }), criteria({ include: [], exclude: ['contract'] }));
    expect(r.matched).toBe(false);
  });

  it('gives every verdict a written reason', () => {
    for (const p of [posting({ title: 'Paid Search Manager' }), posting({ title: 'Line Cook' })]) {
      const r = matchPosting(p, criteria({ exclude: ['cook'] }));
      expect(matchHeadline(r).length, 'a verdict with no reason is the old boolean').toBeGreaterThan(0);
    }
  });
});
