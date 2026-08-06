// The candidate pool for company discovery — NAMES ONLY, deliberately.
//
// WHY NO SLUGS HERE (companyPacks.js has them and this does not): a hardcoded
// slug is a claim about a third party's ATS tenant that rots silently. When
// "powerdigitalmarketing" becomes "powerdigital", the pack quietly watches a
// board that no longer exists and the failure looks like "discovery found
// nothing" rather than "that slug is dead". Names carry no such claim: the
// discovery pass probes each one live, and a company whose board has moved is
// simply re-found at its new slug. A company that has no public board at all
// never appears — which is correct, because Runway could not watch it anyway.
//
// SO WHAT IS THIS FOR: the ceiling on the old discovery flow was that you had
// to already know which companies to watch. You cannot type a name you have
// never heard. This list is the answer to "who else hires for what I do" — and
// crucially, discovery does not just check whether these companies exist, it
// fetches their live boards and counts how many roles MATCH YOUR HUNT. A
// company with 400 open roles and none for you ranks below one with three, all
// of them yours.
//
// The verticals are tags, not silos — most of these hire across several. The
// tag drives which slice gets probed first when a profile names industries.
//
// EXTENDING IT: add a name and a tag. There is nothing to verify and nothing
// to keep in sync; a wrong guess costs one failed probe and shows up nowhere.

export const VERTICALS = [
  { id: 'saas', label: 'B2B SaaS & developer tools' },
  { id: 'consumer', label: 'Consumer tech & marketplaces' },
  { id: 'fintech', label: 'Fintech & financial services' },
  { id: 'health', label: 'Healthcare & health tech' },
  { id: 'commerce', label: 'DTC, retail & commerce' },
  { id: 'agency', label: 'Agencies & marketing services' },
  { id: 'media', label: 'Media, gaming & entertainment' },
  { id: 'infra', label: 'Data, infra & security' },
  { id: 'edu', label: 'Education & non-profit' },
  { id: 'logistics', label: 'Logistics, travel & real estate' },
];

export const VERTICAL_LABEL = Object.fromEntries(VERTICALS.map((v) => [v.id, v.label]));

export const COMPANY_UNIVERSE = [
  // ------------------------------------------------- B2B SaaS & dev tools
  ...['Figma', 'Notion', 'Airtable', 'Webflow', 'Vercel', 'Linear', 'Retool', 'Amplitude',
    'Mixpanel', 'Segment', 'Miro', 'Asana', 'Monday.com', 'Smartsheet', 'Zapier', 'Calendly',
    'Loom', 'Grammarly', 'Intercom', 'Zendesk', 'Front', 'Gong', 'Outreach', 'Clari',
    'ZoomInfo', 'Klaviyo', 'Attentive', 'Braze', 'Iterable', 'Customer.io', 'Twilio',
    'SendGrid', 'Postman', 'Sentry', 'LaunchDarkly', 'PagerDuty', 'Atlassian', 'GitLab',
    'HashiCorp', 'Docker', 'Sourcegraph', 'Airbase', 'Rippling', 'Gusto', 'Deel',
    'Remote', 'Lattice', 'Culture Amp', 'Greenhouse Software', 'Ashby', 'Workable',
  ].map((name) => ({ name, vertical: 'saas' })),

  // ------------------------------------------- consumer tech & marketplaces
  ...['Reddit', 'Pinterest', 'Discord', 'Duolingo', 'Strava', 'Life360', 'Nextdoor',
    'Yelp', 'Eventbrite', 'Etsy', 'Faire', 'Poshmark', 'ThredUp', 'StockX', 'Whatnot',
    'Instacart', 'DoorDash', 'Grubhub', 'Rover', 'Wag', 'Turo', 'Getaround',
    'Bumble', 'Hinge', 'Vimeo', 'Patreon', 'Substack', 'Medium', 'Cameo',
  ].map((name) => ({ name, vertical: 'consumer' })),

  // ----------------------------------------------------------- fintech
  ...['Affirm', 'Chime', 'Plaid', 'Brex', 'Ramp', 'Mercury', 'Marqeta', 'Wealthfront',
    'Betterment', 'Robinhood', 'SoFi', 'Stash', 'Public', 'Carta', 'AngelList',
    'Bill.com', 'Melio', 'Modern Treasury', 'Alloy', 'Unit', 'Lithic', 'Column',
    'Gemini', 'Kraken', 'Circle', 'Nerdwallet', 'Credit Karma', 'LendingClub',
    'Upstart', 'Pagaya', 'Root Insurance', 'Lemonade', 'Hippo', 'Next Insurance',
  ].map((name) => ({ name, vertical: 'fintech' })),

  // ------------------------------------------------- healthcare & health tech
  ...['Oscar Health', 'Included Health', 'Cedar', 'Ro', 'Headway', 'Maven Clinic',
    'Omada Health', 'Carrot Fertility', 'Cohere Health', 'Aledade', 'Commure',
    'Hinge Health', 'Sword Health', 'Spring Health', 'Lyra Health', 'Talkspace',
    'Calm', 'Headspace', 'Noom', 'Hims and Hers', 'Thirty Madison', 'Alto Pharmacy',
    'Devoted Health', 'Clover Health', 'Bright Health', 'Honest Medical',
    'Datavant', 'Komodo Health', 'Tempus', 'Color Health', 'Everlywell',
    'Zocdoc', 'SonderMind', 'Grow Therapy', 'Brightside Health',
  ].map((name) => ({ name, vertical: 'health' })),

  // --------------------------------------------------- DTC, retail & commerce
  ...['Glossier', 'Warby Parker', 'Allbirds', 'Away', 'Casper', 'Brooklinen',
    'Thrive Market', 'Ritual', 'Care/of', 'Olipop', 'Liquid Death', 'Athletic Greens',
    'Chewy', 'Wayfair', 'Peloton', 'Lululemon', 'Figs', 'Rothys', 'On Running',
    'Shopify', 'BigCommerce', 'Recharge', 'Bolt', 'Fast Simon', 'Yotpo',
  ].map((name) => ({ name, vertical: 'commerce' })),

  // ------------------------------------------- agencies & marketing services
  ...['Wpromote', 'Jellyfish', 'Power Digital', 'Brainlabs', 'Code3', 'Tinuiti',
    'Metric Theory', 'Merkle', 'Croud', 'iProspect', 'PMG', 'Media.Monks',
    'Havas Media', 'Horizon Media', 'Rise Interactive', 'Adlucent', 'Closed Loop',
    'Directive Consulting', 'Single Grain', 'NoGood', 'Right Side Up', 'Growth Plays',
  ].map((name) => ({ name, vertical: 'agency' })),

  // ---------------------------------------------- media, gaming, entertainment
  ...['Spotify', 'SoundCloud', 'Bandcamp', 'Epic Games', 'Riot Games', 'Unity',
    'Roblox', 'Scopely', 'Zynga', 'Playtika', 'Discord', 'Twitch',
    'The New York Times', 'The Athletic', 'Axios', 'Vox Media', 'Hearst',
    'Fandom', 'Wikimedia Foundation', 'Sonos', 'iHeartMedia',
  ].map((name) => ({ name, vertical: 'media' })),

  // --------------------------------------------------- data, infra & security
  ...['Databricks', 'Snowflake', 'dbt Labs', 'Fivetran', 'Airbyte', 'Census',
    'Hightouch', 'Monte Carlo', 'Confluent', 'Elastic', 'MongoDB', 'Redis',
    'Cloudflare', 'Fastly', 'DigitalOcean', 'Render', 'Netlify', 'Supabase',
    'Datadog', 'New Relic', 'Grafana Labs', 'Splunk', 'Sumo Logic',
    'Okta', 'Auth0', 'JumpCloud', '1Password', 'Snyk', 'Wiz', 'Abnormal Security',
    'SentinelOne', 'Arctic Wolf', 'Huntress', 'Vanta', 'Drata', 'Secureframe',
  ].map((name) => ({ name, vertical: 'infra' })),

  // ------------------------------------------------- education & non-profit
  ...['Coursera', 'Udemy', 'Skillshare', 'MasterClass', 'Guild Education',
    'Newsela', 'Khan Academy', 'Chegg', 'Course Hero', 'Handshake',
    'Charity Navigator', 'DonorsChoose', 'Classy', 'Bloomerang',
  ].map((name) => ({ name, vertical: 'edu' })),

  // ------------------------------------------ logistics, travel & real estate
  ...['Flexport', 'Convoy', 'project44', 'Samsara', 'Motive', 'ShipBob', 'Stord',
    'Airbnb', 'Vacasa', 'Sonder', 'Hopper', 'Navan', 'TripActions', 'Kayak',
    'Compass', 'Opendoor', 'Zillow', 'Redfin', 'Divvy Homes', 'Roofstock',
    'Procore', 'ServiceTitan', 'EquipmentShare',
  ].map((name) => ({ name, vertical: 'logistics' })),
];

// De-duplicated (Discord is tagged twice on purpose above — it belongs to both
// consumer and media, and the first tag wins rather than the company appearing
// twice in a probe batch).
const seenNames = new Set();
export const COMPANIES = COMPANY_UNIVERSE.filter((c) => {
  const k = c.name.toLowerCase();
  if (seenNames.has(k)) return false;
  seenNames.add(k);
  return true;
});

export const companyCount = COMPANIES.length;

// Order the pool so the verticals a profile names get probed first. Discovery
// runs in batches and the user reads the first batch, so "first" is the whole
// product decision here — not a nicety.
export function orderedCompanies({ industriesIn = [], preferred = [] } = {}) {
  const wanted = new Set();
  const terms = [...industriesIn, ...preferred].map((s) => String(s || '').toLowerCase()).filter(Boolean);
  for (const v of VERTICALS) {
    const hay = `${v.id} ${v.label}`.toLowerCase();
    if (terms.some((t) => hay.includes(t) || t.includes(v.id))) wanted.add(v.id);
  }
  if (!wanted.size) return COMPANIES;
  const hot = COMPANIES.filter((c) => wanted.has(c.vertical));
  const rest = COMPANIES.filter((c) => !wanted.has(c.vertical));
  return [...hot, ...rest];
}
