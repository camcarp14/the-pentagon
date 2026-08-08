// Planted problems for deriving targets from the master resume.
//
// The failure this guards is quiet: a derivation that overwrites a field the
// user already set looks like the tool "helping", and the user does not notice
// their comp floor moved until a month of scores is wrong. So the fill-never-
// overwrite cases below matter more than the extraction ones — extraction being
// wrong is visible in the form before Save, and overwriting is not.
import { describe, it, expect } from 'vitest';
import {
  deriveTargets, deriveTitleKeywords, deriveSeniority, deriveIndustries,
  deriveCompFloor, INDUSTRY_TERMS,
} from '../lib/derive.js';

const resume = {
  contact: { name: 'A Person', location: 'Chicago, IL' },
  summary: 'Marketing strategy and analytics professional across complex client portfolios.',
  skills: ['google ads', 'sql'],
  experience: [
    {
      company: 'An Agency', title: 'Senior Analyst, Search Engine Marketing', dates: '2023 – present',
      bullets: ['Search lead across a healthcare portfolio', 'Turned around a core retail search program'],
    },
    { company: 'A Brand', title: 'Founder', dates: '2025 – present', bullets: ['Built a DTC brand on Shopify'] },
  ],
};

describe('title keywords', () => {
  it('resolves a title to its whole family, not just the words in the title', () => {
    const kw = deriveTitleKeywords(resume);
    // "Senior Analyst, Search Engine Marketing" — score.js matches keywords
    // literally against a job title, so the family's other phrasings have to be
    // present or every "SEM Manager" posting scores zero on title.
    expect(kw).toContain('paid search');
    expect(kw).toContain('sem');
    expect(kw).toContain('ppc');
  });

  it('carries adjacent families in, so the search is not one family wide', () => {
    expect(deriveTitleKeywords(resume)).toContain('performance marketing');
  });

  it('does not put tools in a list of job titles', () => {
    // The trap: paid_search lists google ads / adwords / sa360 / microsoft ads
    // as interchangeable TERMS, and they are — for a posting body. As title
    // keywords they turn the chip list into a software inventory.
    const kw = deriveTitleKeywords(resume);
    for (const tool of ['google ads', 'adwords', 'sa360', 'bing ads', 'microsoft ads']) {
      expect(kw).not.toContain(tool);
    }
  });

  it('never lists the same term at two weights', () => {
    const kw = deriveTitleKeywords(resume);
    expect(new Set(kw).size).toBe(kw.length);
  });

  it('returns nothing rather than guessing when there is no resume', () => {
    expect(deriveTitleKeywords({})).toEqual([]);
    expect(deriveTitleKeywords(null)).toEqual([]);
  });
});

describe('seniority', () => {
  it('reads the rung off the title and points the band upward', () => {
    expect(deriveSeniority(resume)).toEqual(['senior', 'lead', 'manager']);
  });

  it('takes the highest rung ever held, not the most recent title', () => {
    // A director who is now a founder is a director. "Founder" is not on the
    // ladder, and letting the newest row win would silently demote them.
    const r = { experience: [{ title: 'Founder' }, { title: 'Director of Growth' }] };
    expect(deriveSeniority(r)[0]).toBe('director');
  });

  it('does not promise a band that runs off the top of the ladder', () => {
    const r = { experience: [{ title: 'Director of Growth' }] };
    expect(deriveSeniority(r)).toEqual(['director']);
  });

  it('is empty when no title states a rung', () => {
    expect(deriveSeniority({ experience: [{ title: 'Marketing Analyst' }] })).toEqual([]);
  });
});

describe('industries', () => {
  it('reads industries out of bullet prose, not just employer names', () => {
    const ind = deriveIndustries(resume);
    expect(ind).toContain('healthcare');
    expect(ind).toContain('retail');
    expect(ind).toContain('ecommerce');
  });

  it('matches the plural the resume was actually written in', () => {
    expect(deriveIndustries({ summary: 'Ran complex client portfolios' })).toContain('agency');
  });

  it('does not fire on a substring inside another word', () => {
    // "media" inside "immediate" and "legal" inside "illegal" are the traps a
    // raw substring match walks into; every resume would claim every industry.
    const ind = deriveIndustries({ summary: 'Delivered immediate results on illegal-content moderation' });
    expect(ind).not.toContain('media');
    expect(ind).not.toContain('legal');
  });

  it('is empty for an empty resume', () => {
    expect(deriveIndustries({})).toEqual([]);
  });
});

describe('comp floor', () => {
  it('follows the band', () => {
    expect(deriveCompFloor(['senior', 'lead'])).toBe(120000);
    expect(deriveCompFloor(['director'])).toBe(190000);
  });
  it('does not depend on the order the band chips were clicked', () => {
    // The band is stored in click order, so the same band arrives both ways.
    // Reading band[0] would price these two differently.
    expect(deriveCompFloor(['manager', 'senior'])).toBe(deriveCompFloor(['senior', 'manager']));
    expect(deriveCompFloor(['manager', 'senior'])).toBe(120000);
  });

  it('ignores band entries that are not on the ladder', () => {
    expect(deriveCompFloor(['principal', 'senior'])).toBe(120000);
    expect(deriveCompFloor(['principal'])).toBe(null);
  });

  it('has no opinion without a band', () => {
    expect(deriveCompFloor([])).toBe(null);
    expect(deriveCompFloor(undefined)).toBe(null);
  });
});

describe('deriveTargets — fill, never overwrite', () => {
  it('fills every empty field from the resume', () => {
    const { patch, filled } = deriveTargets(resume, {});
    expect(patch.title_keywords.length).toBeGreaterThan(0);
    expect(patch.seniority_band).toEqual(['senior', 'lead', 'manager']);
    expect(patch.industries_in).toContain('healthcare');
    expect(patch.location_pref).toBe('Chicago, IL');
    expect(patch.comp_floor).toBe(120000);
    expect(filled).toContain('title keywords');
  });

  it('leaves a field the user already set completely alone', () => {
    const current = {
      title_keywords: ['product marketing'],
      seniority_band: ['director'],
      industries_in: ['fintech'],
      location_pref: 'Remote only',
      comp_floor: 175000,
    };
    const { patch, filled } = deriveTargets(resume, current);
    expect(patch).toEqual({});
    expect(filled).toEqual([]);
  });

  it('is idempotent — pressing it twice changes nothing the second time', () => {
    const first = deriveTargets(resume, {});
    const second = deriveTargets(resume, { ...first.patch });
    expect(second.patch).toEqual({});
    expect(second.filled).toEqual([]);
  });

  it('suggests a floor against the band the user KEEPS, not the one it computed', () => {
    // The bug this pins: the user has already said "director", the resume says
    // "senior", and the floor silently arrives as the senior number — a figure
    // that matches neither what they typed nor what they meant.
    const { patch } = deriveTargets(resume, { seniority_band: ['director'] });
    expect(patch.comp_floor).toBe(190000);
  });

  it('treats an empty array as empty, not as an answer', () => {
    const { patch } = deriveTargets(resume, { title_keywords: [], industries_in: [] });
    expect(patch.title_keywords.length).toBeGreaterThan(0);
    expect(patch.industries_in.length).toBeGreaterThan(0);
  });

  it('degrades to an empty patch on an empty resume instead of inventing one', () => {
    const { patch, filled } = deriveTargets({}, {});
    expect(patch).toEqual({});
    expect(filled).toEqual([]);
  });
});

describe('the industry dictionary', () => {
  it('has no term short enough to fire on noise', () => {
    for (const [id, terms] of Object.entries(INDUSTRY_TERMS)) {
      for (const t of terms) expect(t.length, `${id}: "${t}"`).toBeGreaterThanOrEqual(3);
    }
  });
});
