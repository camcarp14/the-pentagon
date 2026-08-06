// The synonym graph. This is the single reason discovery stopped missing roles.
//
// THE BUG THIS FIXES: matching was `keywords.some(k => hasKeyword(title, k))` —
// a word-boundary substring test against the title. With "paid search" as your
// keyword, that finds "Paid Search Manager" and misses every one of these:
//
//   Growth Marketing Manager, Paid Media      (the same job)
//   Senior SEM Specialist                     (the same job)
//   Performance Marketing Lead                (the same job)
//   Manager, Biddable Media                   (the same job)
//
// Four real postings, four silent misses, and a miss is invisible — you never
// learn what the scanner didn't show you. Widening the keyword list by hand
// doesn't fix it either: you'd have to think of every phrasing every ATS uses
// before you see it, which is exactly the thing you cannot do.
//
// So terms expand through this graph before they're compared. Two tiers,
// because they are genuinely different claims:
//
//   terms[]     — the SAME role wearing a different word. Full weight. If you
//                 want "paid search" you want "SEM"; there is no version of
//                 that preference where you don't.
//   adjacent[]  — a NEARBY role. Reduced weight, and the reason says so. If
//                 you want "paid search" you probably want to see "Growth
//                 Marketing", but you'd want to know that's what happened
//                 rather than have it presented as a direct hit.
//
// Adjacency is deliberately NOT symmetric-by-default in meaning even though the
// lookup treats it as such: a family lists what it considers nearby, and the
// resolver unions both directions, so an omission on one side is recoverable
// from the other. Add to the side where the relationship is obvious.
//
// EXTENDING THIS: add terms to an existing family before adding a family. A
// family exists to say "these are interchangeable"; a term that is only
// interchangeable in one industry belongs in adjacent[], not terms[].

export const ROLE_FAMILIES = [
  // ---------------------------------------------------------------- marketing
  {
    id: 'paid_search',
    label: 'Paid search',
    terms: [
      'paid search', 'sem', 'ppc', 'pay per click', 'google ads', 'adwords',
      'search ads', 'sa360', 'search engine marketing', 'biddable media',
      'biddable', 'google adwords', 'bing ads', 'microsoft ads',
    ],
    adjacent: ['paid media', 'performance marketing', 'growth marketing', 'digital marketing', 'paid social', 'media buying'],
  },
  {
    id: 'paid_social',
    label: 'Paid social',
    terms: [
      'paid social', 'social ads', 'meta ads', 'facebook ads', 'tiktok ads',
      'linkedin ads', 'social advertising',
    ],
    adjacent: ['paid media', 'performance marketing', 'growth marketing', 'media buying'],
  },
  {
    id: 'performance_marketing',
    label: 'Performance marketing',
    terms: [
      'performance marketing', 'paid media', 'growth marketing', 'acquisition marketing',
      'user acquisition', 'media buying', 'demand generation', 'demand gen',
      'customer acquisition', 'paid acquisition', 'growth',
    ],
    adjacent: ['paid search', 'paid social', 'digital marketing', 'lifecycle marketing', 'marketing analytics'],
  },
  {
    id: 'digital_marketing',
    label: 'Digital marketing',
    terms: ['digital marketing', 'online marketing', 'digital media', 'integrated marketing'],
    adjacent: ['performance marketing', 'brand marketing', 'content marketing', 'paid search'],
  },
  {
    id: 'seo',
    label: 'SEO',
    terms: ['seo', 'search engine optimization', 'organic search', 'organic growth'],
    adjacent: ['content marketing', 'digital marketing', 'paid search'],
  },
  {
    id: 'lifecycle',
    label: 'Lifecycle & CRM',
    terms: [
      'lifecycle marketing', 'crm marketing', 'email marketing', 'retention marketing',
      'marketing automation', 'lifecycle', 'crm',
    ],
    adjacent: ['growth marketing', 'product marketing', 'marketing analytics'],
  },
  {
    id: 'marketing_analytics',
    label: 'Marketing analytics',
    terms: [
      'marketing analytics', 'marketing science', 'media measurement',
      'marketing measurement', 'media analytics', 'marketing mix',
    ],
    adjacent: ['data analyst', 'business intelligence', 'performance marketing', 'marketing operations'],
  },
  {
    id: 'marketing_ops',
    label: 'Marketing operations',
    terms: ['marketing operations', 'marketing ops', 'martech', 'marketing technology'],
    adjacent: ['revenue operations', 'marketing analytics', 'lifecycle marketing'],
  },
  {
    id: 'product_marketing',
    label: 'Product marketing',
    terms: ['product marketing', 'pmm'],
    adjacent: ['brand marketing', 'content marketing', 'product manager', 'growth marketing'],
  },
  {
    id: 'brand',
    label: 'Brand marketing',
    terms: ['brand marketing', 'brand manager', 'brand strategy', 'creative strategy'],
    adjacent: ['content marketing', 'communications', 'digital marketing', 'product marketing'],
  },
  {
    id: 'content',
    label: 'Content',
    terms: ['content marketing', 'content strategy', 'editorial', 'copywriter', 'content manager'],
    adjacent: ['seo', 'brand marketing', 'communications'],
  },
  {
    id: 'comms',
    label: 'Communications & PR',
    terms: ['communications', 'public relations', 'corporate communications', 'pr manager'],
    adjacent: ['brand marketing', 'content marketing'],
  },

  // -------------------------------------------------------------- engineering
  {
    id: 'swe',
    label: 'Software engineering',
    terms: [
      'software engineer', 'software developer', 'swe', 'full stack', 'fullstack',
      'backend engineer', 'back end engineer', 'frontend engineer', 'front end engineer',
      'web developer', 'application developer', 'software engineering',
    ],
    adjacent: ['platform engineer', 'devops', 'site reliability', 'mobile engineer', 'data engineer'],
  },
  {
    id: 'mobile',
    label: 'Mobile engineering',
    terms: ['mobile engineer', 'ios engineer', 'android engineer', 'ios developer', 'android developer', 'react native'],
    adjacent: ['software engineer', 'frontend engineer'],
  },
  {
    id: 'devops',
    label: 'Infrastructure & SRE',
    terms: [
      'devops', 'site reliability', 'sre', 'platform engineer', 'infrastructure engineer',
      'cloud engineer', 'systems engineer',
    ],
    adjacent: ['software engineer', 'security engineer', 'data engineer'],
  },
  {
    id: 'security',
    label: 'Security',
    terms: [
      'security engineer', 'application security', 'appsec', 'information security',
      'infosec', 'security analyst', 'cybersecurity', 'security operations',
    ],
    adjacent: ['devops', 'compliance', 'software engineer'],
  },
  {
    id: 'data_eng',
    label: 'Data engineering',
    terms: ['data engineer', 'analytics engineer', 'data platform', 'etl developer'],
    adjacent: ['software engineer', 'business intelligence', 'data scientist'],
  },
  {
    id: 'data_sci',
    label: 'Data science & ML',
    terms: [
      'data scientist', 'machine learning engineer', 'ml engineer', 'applied scientist',
      'research scientist', 'data science',
    ],
    adjacent: ['data analyst', 'data engineer', 'analytics'],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    terms: [
      'data analyst', 'business analyst', 'analytics', 'business intelligence',
      'bi analyst', 'reporting analyst', 'insights analyst',
    ],
    adjacent: ['data scientist', 'marketing analytics', 'business operations', 'data engineer'],
  },

  // ---------------------------------------------------------- product & design
  {
    id: 'product',
    label: 'Product management',
    terms: [
      'product manager', 'product owner', 'technical product manager', 'group product manager',
      'product management', 'tpm',
    ],
    adjacent: ['program manager', 'product marketing', 'business analyst', 'product designer'],
  },
  {
    id: 'design',
    label: 'Design',
    terms: [
      'product designer', 'ux designer', 'ui designer', 'user experience', 'ux researcher',
      'visual designer', 'interaction designer', 'ux/ui',
    ],
    adjacent: ['graphic designer', 'brand designer', 'product manager', 'creative strategy'],
  },

  // ------------------------------------------------------------- go to market
  {
    id: 'sales',
    label: 'Sales',
    terms: [
      'account executive', 'sales representative', 'sales manager', 'business development',
      'bdr', 'sdr', 'sales development', 'enterprise sales', 'inside sales',
    ],
    adjacent: ['account management', 'customer success', 'partnerships', 'revenue operations'],
  },
  {
    id: 'cs',
    label: 'Customer success',
    terms: [
      'customer success', 'account management', 'account manager', 'client services',
      'client partner', 'customer experience', 'implementation manager',
    ],
    adjacent: ['sales', 'support', 'program manager'],
  },
  {
    id: 'partnerships',
    label: 'Partnerships',
    terms: ['partnerships', 'business development', 'channel sales', 'alliances'],
    adjacent: ['sales', 'account management'],
  },
  {
    id: 'revops',
    label: 'Revenue operations',
    terms: [
      'revenue operations', 'revops', 'sales operations', 'gtm operations',
      'go to market operations', 'deal desk',
    ],
    adjacent: ['business operations', 'marketing operations', 'analytics'],
  },

  // ----------------------------------------------------- operations & the rest
  {
    id: 'bizops',
    label: 'Business operations',
    terms: [
      'business operations', 'strategy and operations', 'strategy & operations',
      'chief of staff', 'operations manager', 'bizops', 'strategic operations',
    ],
    adjacent: ['program manager', 'revenue operations', 'analytics', 'consultant'],
  },
  {
    id: 'program',
    label: 'Program & project management',
    terms: [
      'program manager', 'project manager', 'delivery manager', 'scrum master',
      'technical program manager', 'portfolio manager',
    ],
    adjacent: ['product manager', 'business operations', 'operations manager'],
  },
  {
    id: 'finance',
    label: 'Finance',
    terms: [
      'financial analyst', 'fp&a', 'finance manager', 'controller', 'accountant',
      'accounting manager', 'treasury', 'financial planning',
    ],
    adjacent: ['business operations', 'strategy', 'analytics'],
  },
  {
    id: 'people',
    label: 'People & recruiting',
    terms: [
      'recruiter', 'talent acquisition', 'people operations', 'hr manager',
      'human resources', 'people partner', 'hrbp', 'technical recruiter',
    ],
    adjacent: ['business operations'],
  },
  {
    id: 'support',
    label: 'Support',
    terms: ['customer support', 'technical support', 'support engineer', 'help desk', 'support specialist'],
    adjacent: ['customer success', 'implementation manager'],
  },
  {
    id: 'consulting',
    label: 'Consulting & strategy',
    terms: ['consultant', 'strategy consultant', 'management consultant', 'strategy manager', 'corporate strategy'],
    adjacent: ['business operations', 'analytics', 'program manager'],
  },
];

export const FAMILY_BY_ID = Object.fromEntries(ROLE_FAMILIES.map((f) => [f.id, f]));

// Normalize for comparison: lowercase, collapse punctuation to single spaces.
// "&" survives as a word so "fp&a" and "strategy & operations" stay intact.
export const normTerm = (s) =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9+#&/]+/g, ' ').replace(/\s+/g, ' ').trim();

// Which families claim this term? A term matches a family when it equals one of
// its terms, or when one fully contains the other as a whole phrase — so
// "senior paid search" resolves to paid_search, and so does "paid search".
//
// Containment is phrase-anchored (space-padded) rather than raw substring, or
// "sem" would resolve out of "assemble" and every family would claim it.
export function familiesFor(term) {
  const t = normTerm(term);
  if (!t) return [];
  const padded = ` ${t} `;
  const hits = [];
  for (const fam of ROLE_FAMILIES) {
    const direct = fam.terms.some((x) => {
      const n = normTerm(x);
      return n === t || padded.includes(` ${n} `) || ` ${n} `.includes(padded);
    });
    if (direct) hits.push(fam);
  }
  return hits;
}

/**
 * Expand one search term into everything that should count as a hit for it.
 *
 * Returns { term, same: string[], near: string[] } where `same` is the term
 * plus every interchangeable phrasing, and `near` is the adjacent ring. Both
 * are de-duplicated and never overlap — a phrase that is `same` for this term
 * is removed from `near`, because a hit should be reported at its strongest
 * true weight, not twice at two weights.
 */
export function expandTerm(term) {
  const t = normTerm(term);
  if (!t) return { term: t, same: [], near: [] };
  const fams = familiesFor(t);
  const same = new Set([t]);
  const near = new Set();
  for (const fam of fams) {
    for (const x of fam.terms) same.add(normTerm(x));
    for (const a of fam.adjacent) near.add(normTerm(a));
  }
  // Adjacency, resolved: an adjacent LABEL like "paid media" is itself a term
  // in some family, and what the user should see is that whole family — not
  // the one phrase that happened to be written in the adjacent list.
  for (const a of [...near]) {
    for (const fam of familiesFor(a)) {
      for (const x of fam.terms) near.add(normTerm(x));
    }
  }
  for (const s of same) near.delete(s);
  return { term: t, same: [...same], near: [...near] };
}

// Every family a set of terms touches — used to label a hunt ("this is a
// performance-marketing hunt") and to seed skill suggestions.
export function familiesForAll(terms) {
  const ids = new Set();
  for (const t of terms || []) for (const f of familiesFor(t)) ids.add(f.id);
  return [...ids].map((id) => FAMILY_BY_ID[id]).filter(Boolean);
}

// Suggestions for a partially-typed term, for the hunt editor's autocomplete.
export function suggestTerms(input, limit = 8) {
  const q = normTerm(input);
  if (q.length < 2) return [];
  const out = [];
  for (const fam of ROLE_FAMILIES) {
    for (const t of fam.terms) {
      const n = normTerm(t);
      if (n !== q && n.includes(q)) out.push({ term: n, family: fam.label });
    }
  }
  // shortest first: the closest thing to what was typed, not the longest match
  return out.sort((a, b) => a.term.length - b.term.length).slice(0, limit);
}
