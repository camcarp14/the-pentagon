// Fixture tests for the news layer. No network here by design — the sandbox
// proxy 403s every crypto and news host on CONNECT — so every payload below is
// written from the documented RSS 2.0 / Atom shapes, exactly as sources.mjs and
// alts.mjs are tested.
//
// The cases that earn their keep are the ADVERSARIAL ones. A naive matcher
// (indexOf, case-insensitive) passes a "does SOL match 'Solana Rallies'" test
// and then ships a watchlist where SOL matches "solution" and "console", ARB
// matches "arbitrary", OP matches almost every headline, and a coin called
// Movement or Story or Grass matches ordinary prose. Each of those is written
// below as a test that a naive implementation FAILS, because the failure mode
// this feature actually has is not "no matches", it is "matches nobody can
// trust", and the operator cannot tell the difference without reading every
// headline — which is the work the panel exists to save.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Blobs is mocked, not reached. The handler tests below are claims about what
// the health record SAYS after a degraded serve, and that record lives here.
const BLOBS = new Map();
vi.mock('@netlify/blobs', () => ({
  getStore: () => ({
    get: async (k) => (BLOBS.has(k) ? JSON.parse(JSON.stringify(BLOBS.get(k))) : null),
    setJSON: async (k, v) => { BLOBS.set(k, JSON.parse(JSON.stringify(v))); },
    delete: async (k) => { BLOBS.delete(k); },
  }),
}));

import {
  parseFeed,
  cleanText,
  decodeEntities,
  absoluteHttpUrl,
  dedupeAndSort,
  isShouty,
  tickerRule,
  nameRule,
  compileCoin,
  headlineMatch,
  matchHeadlines,
  coinsFromScanCache,
  coinsFromWatchlist,
  mergeCoinSources,
  fetchFeed,
  fetchAltNews,
  FEEDS,
  MAX_ITEMS,
  MIN_TICKER_LEN,
  NEWS_TTL_SEC,
  SYMBOL_STOPLIST,
  COMMON_WORDS,
  isCoinedWord,
  PROPER_COIN_NAMES,
} from '../news.mjs';
import { store } from '../util.mjs';
import altNewsHandler, { TTL_SEC } from '../../functions/alt-news.mjs';

/* ---------------- fixtures, written from the documented shapes ---------------- */

const rssItem = ({ title = 'Bitcoin Holds $100K', link = 'https://www.coindesk.com/markets/a', pubDate = 'Sat, 01 Aug 2026 12:00:00 +0000', cdata = false } = {}) => `
  <item>
    <title>${cdata ? `<![CDATA[${title}]]>` : title}</title>
    <link>${link}</link>
    <guid isPermaLink="false">urn:uuid:${encodeURIComponent(title).slice(0, 12)}</guid>
    <description>Some body copy that is not matched against.</description>
    ${pubDate ? `<pubDate>${pubDate}</pubDate>` : ''}
  </item>`;

const rssFeed = (items) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>CoinDesk</title>
    <link>https://www.coindesk.com</link>
    <atom:link href="https://www.coindesk.com/arc/outboundfeeds/rss/" rel="self" type="application/rss+xml"/>
    <description>Leader in cryptocurrency news</description>
    ${items.join('\n')}
  </channel>
</rss>`;

const atomFeed = (entries) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Cointelegraph</title>
  <link rel="self" href="https://cointelegraph.com/rss"/>
  <updated>2026-08-01T12:30:00Z</updated>
  ${entries.join('\n')}
</feed>`;

const atomEntry = ({ title = 'Solana Fees Fall', href = 'https://cointelegraph.com/news/b', published = '2026-08-01T11:00:00Z' } = {}) => `
  <entry>
    <title type="html">${title}</title>
    <link rel="alternate" type="text/html" href="${href}"/>
    <id>tag:cointelegraph.com,2026:/news/b</id>
    ${published ? `<published>${published}</published>` : ''}
    <updated>2026-08-01T11:05:00Z</updated>
  </entry>`;

const coin = (symbol, name, over = {}) => ({ id: name.toLowerCase().replace(/\s+/g, '-'), symbol, name, ...over });

/* ================================ parsers ================================ */

describe('parseFeed — RSS 2.0', () => {
  it('reads title, link and date out of a CoinDesk-shaped feed', () => {
    const items = parseFeed(rssFeed([
      rssItem({ title: 'Bitcoin Holds $100K', link: 'https://www.coindesk.com/markets/a' }),
      rssItem({ title: 'Solana ETF Filing Advances', link: 'https://www.coindesk.com/policy/b', pubDate: 'Fri, 31 Jul 2026 09:30:00 GMT' }),
    ]), { source: 'coindesk', baseUrl: FEEDS[0].url });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: 'Bitcoin Holds $100K', url: 'https://www.coindesk.com/markets/a', source: 'coindesk' });
    expect(items[0].at).toBe(Date.parse('2026-08-01T12:00:00Z'));
    expect(items[1].at).toBe(Date.parse('2026-07-31T09:30:00Z'));
  });

  it('unwraps CDATA and decodes entities in the title', () => {
    const items = parseFeed(rssFeed([
      rssItem({ title: 'Coinbase &amp; Circle Settle', cdata: false }),
      rssItem({ title: 'Ether’s “Merge” Anniversary', link: 'https://www.coindesk.com/markets/c', cdata: true }),
    ]), { source: 'coindesk' });
    expect(items[0].title).toBe('Coinbase & Circle Settle');
    expect(items[1].title).toBe('Ether’s “Merge” Anniversary');
  });

  // Feeds routinely double-encode. One decode leaves `&#39;` on the screen.
  it('survives a double-encoded title without leaving an entity on screen', () => {
    expect(cleanText('Bitcoin&amp;#39;s Rally')).toBe("Bitcoin's Rally");
    expect(cleanText('&amp;lt;b&amp;gt;BTC&amp;lt;/b&amp;gt; Surges')).toBe('BTC Surges');
  });

  // A bare /<[^>]*>/ eats the rest of this headline.
  it('does not eat a headline containing a less-than sign', () => {
    expect(cleanText('Analyst Sees BTC < $80K by 2027')).toBe('Analyst Sees BTC < $80K by 2027');
  });

  it('leaves an item with no readable date as null, never as "now"', () => {
    const items = parseFeed(rssFeed([rssItem({ pubDate: '' })]), { source: 'coindesk' });
    expect(items).toHaveLength(1);
    expect(items[0].at).toBeNull();

    const junk = parseFeed(rssFeed([rssItem({ pubDate: 'sometime last week' })]), { source: 'coindesk' });
    expect(junk[0].at).toBeNull();
  });
});

describe('parseFeed — Atom', () => {
  it('reads <entry>, the href on <link/>, and <published>', () => {
    const items = parseFeed(atomFeed([
      atomEntry({ title: 'Solana Fees Fall', href: 'https://cointelegraph.com/news/b' }),
    ]), { source: 'cointelegraph', baseUrl: FEEDS[1].url });
    expect(items).toEqual([{
      title: 'Solana Fees Fall',
      url: 'https://cointelegraph.com/news/b',
      source: 'cointelegraph',
      at: Date.parse('2026-08-01T11:00:00Z'),
    }]);
  });

  it('falls back to <updated> when an entry has no <published>', () => {
    const items = parseFeed(atomFeed([atomEntry({ published: '' })]), { source: 'cointelegraph' });
    expect(items[0].at).toBe(Date.parse('2026-08-01T11:05:00Z'));
  });
});

describe('parseFeed — malformed input never throws', () => {
  const cases = [
    ['empty string', ''],
    ['not xml at all', 'we are sorry, this feed has moved'],
    ['an HTML error page', '<html><body><h1>403 Forbidden</h1></body></html>'],
    ['an unclosed item', '<rss><channel><item><title>Half a story</title><link>https://x.test/a</link>'],
    ['nested angle soup', '<<<item>>><title><<>></title>'],
    ['null', null],
    ['a number', 42],
    ['an object', { item: 'nope' }],
  ];
  for (const [what, input] of cases) {
    it(`returns [] rather than throwing on ${what}`, () => {
      expect(() => parseFeed(input, { source: 'coindesk' })).not.toThrow();
      expect(parseFeed(input, { source: 'coindesk' })).toEqual([]);
    });
  }

  // A feed cut off mid-transfer is the normal case, not the exotic one.
  it('keeps the complete items and drops a truncated tail', () => {
    const whole = rssFeed([
      rssItem({ title: 'Complete One', link: 'https://x.test/1' }),
      rssItem({ title: 'Complete Two', link: 'https://x.test/2' }),
    ]);
    const cut = whole.slice(0, whole.indexOf('Complete Two') + 8);
    const items = parseFeed(cut, { source: 'coindesk' });
    expect(items.map((i) => i.title)).toEqual(['Complete One']);
  });

  it('does not confuse <items> or <itemDetail> for <item>', () => {
    const xml = '<rss><channel><items><title>Not An Item</title><link>https://x.test/n</link></items>'
      + rssItem({ title: 'Real Item', link: 'https://x.test/r' }) + '</channel></rss>';
    expect(parseFeed(xml, { source: 'coindesk' }).map((i) => i.title)).toEqual(['Real Item']);
  });

  it('drops an item it cannot cite — no title, or no absolute http link', () => {
    const xml = '<rss><channel>'
      + '<item><link>https://x.test/no-title</link></item>'
      + '<item><title>No Link At All</title></item>'
      + '<item><title>Bad Scheme</title><link>javascript:alert(1)</link></item>'
      + rssItem({ title: 'Keeper', link: 'https://x.test/keep' })
      + '</channel></rss>';
    expect(parseFeed(xml, { source: 'coindesk' }).map((i) => i.title)).toEqual(['Keeper']);
  });

  it('resolves a relative link against the feed URL, and refuses one without a base', () => {
    const xml = `<rss><channel><item><title>Relative</title><link>/news/x</link></item></channel></rss>`;
    expect(parseFeed(xml, { source: 'coindesk', baseUrl: FEEDS[0].url })[0].url)
      .toBe('https://www.coindesk.com/news/x');
    expect(parseFeed(xml, { source: 'coindesk' })).toEqual([]);
  });

  it('falls back to a permalink <guid> when there is no <link>', () => {
    const xml = '<rss><channel><item><title>Guid Only</title>'
      + '<guid isPermaLink="true">https://www.coindesk.com/g/1</guid></item></channel></rss>';
    expect(parseFeed(xml, { source: 'coindesk' })[0].url).toBe('https://www.coindesk.com/g/1');
  });

  // The regex-with-a-lazy-wildcard version of this parser backtracks here.
  it('finishes promptly on a pathological document', () => {
    const nasty = '<item><title>' + '<'.repeat(60_000);
    const t0 = Date.now();
    expect(parseFeed(nasty, { source: 'coindesk' })).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('caps how many items one feed can contribute', () => {
    const many = Array.from({ length: 120 }, (_, i) => rssItem({ title: `Story ${i}`, link: `https://x.test/${i}` }));
    expect(parseFeed(rssFeed(many), { source: 'coindesk' }).length).toBe(30);
  });
});

describe('decodeEntities / absoluteHttpUrl', () => {
  it('decodes named, decimal and hex entities and leaves unknown ones alone', () => {
    expect(decodeEntities('a &amp; b &#39;c&#39; &#x2019;d&#x2019; &bogus;')).toBe("a & b 'c' ’d’ &bogus;");
  });
  it('refuses a non-http scheme and a codepoint out of range', () => {
    expect(absoluteHttpUrl('mailto:a@b.test')).toBeNull();
    expect(absoluteHttpUrl('ftp://x.test/a')).toBeNull();
    expect(absoluteHttpUrl('https://x.test/a')).toBe('https://x.test/a');
    expect(decodeEntities('&#99999999;')).toBe('&#99999999;');
  });
});

describe('dedupeAndSort', () => {
  const it0 = { title: 'Solana ETF Filing Advances', url: 'https://a.test/1', source: 'coindesk', at: 3000 };
  const it1 = { title: 'Solana ETF Filing Advances', url: 'https://b.test/1', source: 'cointelegraph', at: 2000 };
  const it2 = { title: 'Bitcoin Holds', url: 'https://a.test/2', source: 'coindesk', at: 9000 };
  const undated = { title: 'Undated Story', url: 'https://a.test/3', source: 'coindesk', at: null };

  it('sorts newest first and puts undated items last, never first', () => {
    expect(dedupeAndSort([undated, it0, it2]).map((i) => i.title))
      .toEqual(['Bitcoin Holds', 'Solana ETF Filing Advances', 'Undated Story']);
  });

  // The same story syndicated by both publishers is ONE mention, not two.
  // Counting it twice inflates a coin up the "in the news" ranking.
  it('collapses the same headline arriving from both publishers', () => {
    const out = dedupeAndSort([it0, it1, it2]);
    expect(out).toHaveLength(2);
    expect(out.find((i) => i.title.startsWith('Solana')).source).toBe('coindesk');
  });

  it('caps the list', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ title: `T${i}`, url: `https://a.test/${i}`, source: 'coindesk', at: i }));
    expect(dedupeAndSort(many)).toHaveLength(MAX_ITEMS);
  });
});

/* ============================== the matcher ============================== */

describe('the matcher — substrings (the naive-implementation killers)', () => {
  const sol = coin('SOL', 'Solana');

  // indexOf('SOL') finds all three of these. So does /sol/i.
  it('SOL does not match "solution", "console" or "Solutions"', () => {
    for (const h of [
      'Exchange Ships a New Custody Solution for Institutions',
      'Console Makers Weigh Crypto Payments',
      'Three Solutions to the Fee Problem',
      'A Consoling Word From the Regulator',
      'Absolutely No Movement on the Bill',
    ]) {
      expect(headlineMatch(h, sol)).toBeNull();
    }
  });

  it('SOL still matches the ticker written as a ticker', () => {
    expect(headlineMatch('Solana Rallies as SOL ETF Filing Advances', sol)).toMatchObject({ basis: 'name+ticker', confidence: 'high' });
    expect(headlineMatch('$SOL Reclaims Its 200-Day', sol)).toMatchObject({ basis: 'ticker' });
    expect(headlineMatch('Traders Rotate Into SOL/USD', sol)).toMatchObject({ basis: 'ticker' });
    expect(headlineMatch('Fee Burn Lands (SOL)', sol)).toMatchObject({ basis: 'ticker' });
  });

  it('SOL does not match inside a longer uppercase token', () => {
    expect(headlineMatch('SOLUSDT Perps Open Interest Hits a Record', sol)).toBeNull();
    expect(headlineMatch('SOLANA Ships It', sol)).toMatchObject({ basis: 'name' }); // the NAME, not the ticker
  });

  it('ARB does not match "arbitrary", "arbitrage" or "Arbitration"', () => {
    const arb = coin('ARB', 'Arbitrum');
    for (const h of [
      'An Arbitrary Cutoff Angers Validators',
      'Funding-Rate Arbitrage Is Back',
      'Arbitration Clause Struck Down',
    ]) {
      expect(headlineMatch(h, arb)).toBeNull();
    }
    expect(headlineMatch('Arbitrum Unlocks 92M ARB Tokens', arb)).toMatchObject({ basis: 'name+ticker' });
  });

  it('TIA does not match "initial" and APT does not match "adapt"', () => {
    expect(headlineMatch('Initial Filing Lands at the SEC', coin('TIA', 'Celestia'))).toBeNull();
    expect(headlineMatch('Banks Adapt to Stablecoin Rules', coin('APT', 'Aptos'))).toBeNull();
  });
});

describe('the matcher — tickers too short or too common', () => {
  // "OP" matches almost everything: OP-ED, OP Stack, and any all-caps prose.
  //
  // AND OPTIMISM IS THE MOST EXPENSIVE COIN IN THE ONE-WORD NAME GATE, so it is
  // written down here rather than left to be rediscovered. This test used to
  // assert that "Optimism Ships a Fault Proof" matched by name. It no longer
  // does, and it should not have: "optimism" is one of the commonest words in
  // financial copy — "Optimism Grows Over a September Cut" is a headline both
  // of these publishers write most months. Matching it produced a confident row
  // under OP for a story about interest rates.
  //
  // So OP is now unmatchable by BOTH halves, and the panel says so out loud
  // instead of showing rate-cut stories under an L2. That is the trade this
  // module makes everywhere: a stated miss over a silent invention.
  it('OP is never matched, and neither half of the coin can rescue it', () => {
    const op = compileCoin(coin('OP', 'Optimism'));
    expect(op.ticker).toBeNull();
    expect(tickerRule('OP').reason).toMatch(new RegExp(`under ${MIN_TICKER_LEN} characters`));
    expect(headlineMatch('An OP-Ed on Crypto Policy', op)).toBeNull();
    expect(headlineMatch('Optimism Grows Over a September Rate Cut', op)).toBeNull();
    // The cost, named:
    expect(headlineMatch('Optimism Ships a Fault Proof', op)).toBeNull();
    expect(op.usable).toBe(false);
    expect(op.reason).toMatch(/could be ordinary English/);
  });

  it('two-character tickers are all refused', () => {
    for (const s of ['IP', 'AI', 'ID', 'GO', 'S']) expect(tickerRule(s).ok).toBe(false);
  });

  it('ETF, SEC and CEO are refused even though they are legal tickers somewhere', () => {
    for (const s of ['ETF', 'SEC', 'CEO', 'USD', 'GAS', 'ALL', 'NEW', 'TOP', 'ONE']) {
      expect(SYMBOL_STOPLIST.has(s)).toBe(true);
      expect(tickerRule(s).ok).toBe(false);
    }
  });

  it('does not stoplist real tickers that are not English words', () => {
    for (const s of ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'AVAX', 'DOGE', 'ARB', 'SUI', 'TIA', 'TON', 'LINK', 'NEAR', 'PEPE']) {
      expect(tickerRule(s).ok).toBe(true);
    }
  });
});

describe('the matcher — a coin whose NAME is ordinary English', () => {
  // The three the brief names by hand, plus the phrase case.
  it('Movement is not matched by "makes a big move"', () => {
    const move = coin('MOVE', 'Movement');
    expect(headlineMatch('Bitcoin Makes a Big Move Above $100K', move)).toBeNull();
    expect(headlineMatch('A Grassroots Movement Forms Around Self-Custody', move)).toBeNull();
    expect(compileCoin(move).nameMatch).toBeNull();
    // The ticker still works in a normal headline; case is what protects it.
    expect(headlineMatch('MOVE Unlock Hits the Market', move)).toMatchObject({ basis: 'ticker', confidence: 'high' });
  });

  it('Story is not matched by "tells the story"', () => {
    const story = coin('IP', 'Story');
    expect(headlineMatch('Coinbase Tells the Story of Its First Decade', story)).toBeNull();
    // Ticker too short AND name is ordinary English → unmatchable, and it SAYS so.
    const c = compileCoin(story);
    expect(c.usable).toBe(false);
    expect(c.reason).toMatch(/under 3 characters/);
    expect(c.reason).toMatch(/common English words/);
  });

  it('Grass is not matched by "grass"', () => {
    const grass = coin('GRASS', 'Grass');
    expect(headlineMatch('Miners Move Onto Cheaper Grass-Fed Power', grass)).toBeNull();
    expect(headlineMatch('The Grass Is Greener in Wyoming', grass)).toBeNull();
    expect(headlineMatch('GRASS Emissions Schedule Changes', grass)).toMatchObject({ basis: 'ticker' });
  });

  // "Near Protocol" is two ordinary words in a row, which is why one-token
  // matching AND naive phrase matching both fail here.
  it('Near Protocol is not matched by "near protocol upgrade"', () => {
    const near = coin('NEAR', 'Near Protocol');
    expect(nameRule('Near Protocol').ok).toBe(false);
    expect(headlineMatch('Ether Prices Near Protocol Upgrade Levels', near)).toBeNull();
    expect(headlineMatch('NEAR Adds an Intents Layer', near)).toMatchObject({ basis: 'ticker', confidence: 'high' });
  });

  it('a multi-word name matches only in full, never one token of it', () => {
    const shib = coin('SHIB', 'Shiba Inu');
    expect(headlineMatch('An Inu-Themed Token Rallies', shib)).toBeNull();
    expect(headlineMatch('Shiba Burns Accelerate', shib)).toBeNull();
    expect(headlineMatch('Shiba Inu Burn Rate Jumps 400%', shib)).toMatchObject({ basis: 'name', confidence: 'high' });
    expect(headlineMatch('Shiba-Inu Burn Rate Jumps', shib)).toMatchObject({ basis: 'name' });
  });

  it('a single-word name under four characters is refused', () => {
    expect(nameRule('Sui').ok).toBe(false);
    // …and SUI the ticker still carries the coin.
    expect(headlineMatch('SUI TVL Crosses $2B', coin('SUI', 'Sui'))).toMatchObject({ basis: 'ticker' });
  });

  // Both publishers write headlines in Title Case, which capitalises ordinary
  // words. This is the pin on why the ticker rule is ALL-CAPS-only and not
  // merely "case-sensitive": a Title-Case relaxation lights up on prose.
  it('Title Case is not enough for a ticker, because Title Case capitalises prose', () => {
    expect(headlineMatch('Bitcoin Hits a Ton of Resistance at $100K', coin('TON', 'Toncoin'))).toBeNull();
    expect(headlineMatch('A Sol Eclipse Darkens the Mining Farm', coin('SOL', 'Solana'))).toBeNull();
    expect(headlineMatch('Traders Link Two Wallets to the Hack', coin('LINK', 'Chainlink'))).toBeNull();
    // And the accepted cost of that, stated as a test rather than discovered later.
    expect(headlineMatch('Aptos and Sui Split the Move-Language Developer Base', coin('SUI', 'Sui'))).toBeNull();
    expect(headlineMatch('Toncoin Slides as Telegram Ad Revenue Misses', coin('TON', 'Toncoin'))).toMatchObject({ basis: 'name' });
  });

  it('strips a parenthetical annotation before matching the name', () => {
    const r = nameRule('Bridged USDC (Polygon PoS Bridge)');
    expect(r.ok).toBe(true);
    expect(r.phrase).toBe('Bridged USDC');
  });
});

// ─── THE ONE-WORD NAME GATE ──────────────────────────────────────────────────
//
// EVERY TEST IN THIS BLOCK FAILED AGAINST THE FIRST IMPLEMENTATION OF THIS FILE
// AND THAT IS WHY THEY ARE HERE.
//
// The original rule 4 was a blocklist: a one-word name matched ordinary prose,
// case-insensitively, whenever the word was absent from COMMON_WORDS. An
// independent review fed the matcher a day of realistic headlines and measured
// SEVEN false positives in twenty hits — 65% precision — every one of them a
// one-word name, and every one graded `high`, because a name match is the
// strongest evidence this module has. Core, Maker, Verge, Stacks, Compound and
// Render were the words the list was short of.
//
// A hand-written word list cannot carry English. It will always be one word
// short, and the word it is short of becomes a confident wrong row — which is
// the specific failure that makes a watchlist worth less than no watchlist.
// So the burden is inverted: a one-word name is trusted alone only if it is
// POSITIVELY known to be coined. Unknown now means MISSED, not INVENTED.
describe('the matcher — one-word names, the 65%-precision bug', () => {
  // The reviewer's corpus, verbatim in spirit: ordinary financial English that
  // happens to contain a token's name. Every line here produced a `high`
  // confidence row before the gate existed.
  const PROSE = [
    [coin('CORE', 'Core'), 'Inflation Cools but Core Prices Stay Sticky'],
    [coin('MKR', 'Maker'), 'A Market Maker Pulls Liquidity From Three Venues'],
    [coin('XVG', 'Verge'), 'Argentina on the Verge of Another Devaluation'],
    [coin('STX', 'Stacks'), 'Treasury Stacks Up Another Record Auction'],
    [coin('COMP', 'Compound'), 'Compound Interest Is Doing the Work in This Portfolio'],
    [coin('RNDR', 'Render'), 'New Chips Render Last Year&apos;s GPUs Obsolete'],
    [coin('MOVE', 'Movement'), 'A Grassroots Movement Pushes Back on the Bill'],
    [coin('SAGA', 'Saga'), 'The Saga of the Missing Keys Continues'],
    [coin('FLUX', 'Flux'), 'Rates Are in Flux Ahead of the Meeting'],
    [coin('AVAX', 'Avalanche'), 'An Avalanche of Sell Orders Hits the Open'],
    [coin('OSMO', 'Osmosis'), 'Talent Moves by Osmosis in a Tight Market'],
    [coin('TRUMP', 'Trump'), 'Trump Signs the Tariff Order'],
  ];

  it.each(PROSE)('does not match %o on ordinary prose', (c, title) => {
    expect(headlineMatch(title, c)).toBeNull();
  });

  it('all twelve of those are silent, so the sample has zero false positives', () => {
    const hits = PROSE.filter(([c, title]) => headlineMatch(title, c) !== null);
    expect(hits.map(([c, t]) => `${c.symbol}: ${t}`)).toEqual([]);
  });

  // The recall this costs, stated as a test rather than discovered later: each
  // of those coins is still reachable the moment the headline carries the
  // actual evidence, which is the ticker.
  it('the same coins still match when the ticker is in the headline', () => {
    expect(headlineMatch('COMP Holders Vote to Cut the Reserve Factor', coin('COMP', 'Compound')))
      .toMatchObject({ basis: 'ticker', confidence: 'high' });
    expect(headlineMatch('Compound (COMP) Cuts Its Reserve Factor', coin('COMP', 'Compound')))
      .toMatchObject({ basis: 'name+ticker', confidence: 'high' });
    expect(headlineMatch('Avalanche Foundation Buys Back AVAX', coin('AVAX', 'Avalanche')))
      .toMatchObject({ basis: 'name+ticker' });
  });

  // …and the coins whose names are genuinely not words are untouched, which is
  // what stops this from being a fix that turns the panel off.
  it('a coined one-word name still stands on its own', () => {
    for (const [sym, name, title] of [
      ['BTC', 'Bitcoin', 'Bitcoin Holds $100K Into the Weekend'],
      ['SOL', 'Solana', 'Solana Validators Approve a Fee Change'],
      ['DOGE', 'Dogecoin', 'Dogecoin Volume Doubles on One Exchange'],
      ['APT', 'Aptos', 'Aptos Ships a Parallel Execution Upgrade'],
      ['TON', 'Toncoin', 'Toncoin Slides as Telegram Ad Revenue Misses'],
      ['PEPE', 'Pepe', 'Pepe Leads a Broad Meme Rally'],
    ]) {
      expect(headlineMatch(title, coin(sym, name))).toMatchObject({ basis: 'name', confidence: 'high' });
    }
  });

  // The structural half of the rule, so a coin nobody vetted can still carry
  // its own name when the name could not possibly be English.
  it('an unmistakable crypto suffix stands in for the vetted list', () => {
    expect(headlineMatch('Uniswap Turns On the Fee Switch', coin('UNI', 'Uniswap')))
      .toMatchObject({ basis: 'name' });
    expect(headlineMatch('Thorchain Halts Swaps After a Bug', coin('RUNE', 'Thorchain')))
      .toMatchObject({ basis: 'name' });
    // A brand-new coin this file has never heard of, matched on structure alone.
    expect(headlineMatch('Zzyzxcoin Lists on Two Venues', coin('ZZYZX', 'Zzyzxcoin')))
      .toMatchObject({ basis: 'name' });
    // But the suffix words themselves are not a free pass. Both of these are
    // refused OUTRIGHT rather than merely weakened, because COMMON_WORDS is
    // checked before the suffix — which is the reason "memecoin" and
    // "stablecoin" were added to it.
    expect(nameRule('Swap').ok).toBe(false);
    expect(nameRule('Memecoin').ok).toBe(false);
    expect(isCoinedWord('memecoin')).toBe(false);
    expect(isCoinedWord('coin')).toBe(false);
    expect(isCoinedWord('dogecoin')).toBe(true);
  });

  it('a weak name is reported as weak, not silently downgraded', () => {
    const r = nameRule('Compound');
    expect(r.ok).toBe(true);
    expect(r.weak).toBe(true);
    expect(r.weakReason).toMatch(/only counted when the ticker appears/);
    expect(nameRule('Bitcoin').weak).toBe(false);
  });

  // The honesty rule, applied to the gate itself. A coin whose ticker is
  // refused AND whose name is weak can never produce a row, so it must come
  // back in `skipped` saying so — not sit on the board looking unwritten-about.
  it('a coin the gate makes unmatchable is reported, not silently dropped', () => {
    // Harmony: ticker ONE is stoplisted, and "Harmony" is a one-word name that
    // is not on the vetted list — so both halves refuse and the coin can never
    // produce a row. It has to come back in `skipped` carrying BOTH reasons.
    const harmony = coin('ONE', 'Harmony');
    const c = compileCoin(harmony);
    expect(c.usable).toBe(false);
    expect(c.reason).toMatch(/common English word or a finance acronym/);
    expect(c.reason).toMatch(/could be ordinary English/);

    const { matches, skipped } = matchHeadlines(
      [{ title: 'Regulators Strike a Note of Harmony on Stablecoins', url: 'https://x.test/a', source: 'coindesk', at: 1 }],
      [harmony],
    );
    expect(matches).toEqual({});
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ symbol: 'ONE', name: 'Harmony' });
  });
});

describe('the matcher — SHOUTY headlines, where case stops protecting anything', () => {
  it('recognises an all-caps headline and an ordinary one', () => {
    expect(isShouty('SEC DELAYS ALL SPOT ETF DECISIONS UNTIL OCTOBER')).toBe(true);
    expect(isShouty('SEC Delays All Spot ETF Decisions Until October')).toBe(false);
    // Short and legitimately capitalised — not shouting.
    expect(isShouty('BTC ETF')).toBe(false);
  });

  it('refuses an English-word ticker in an all-caps headline', () => {
    const shout = 'REGULATORS DELAY EVERY LISTED SPOT PRODUCT UNTIL OCTOBER';
    expect(isShouty(shout)).toBe(true);
    for (const [sym, name] of [['SPOT', 'Spot Coin'], ['MOVE', 'Movement'], ['LINK', 'Chainlink'], ['NEAR', 'Near Protocol']]) {
      expect(COMMON_WORDS.has(sym.toLowerCase())).toBe(true);
      expect(headlineMatch(shout.replace('SPOT', sym), coin(sym, name))).toBeNull();
    }
  });

  it('still matches a ticker that is not an English word in the same headline', () => {
    const shout = 'SOLANA VALIDATORS APPROVE SOL FEE CHANGE OVERNIGHT';
    expect(isShouty(shout)).toBe(true);
    expect(headlineMatch(shout, coin('SOL', 'Solana'))).toMatchObject({ basis: 'name+ticker' });
    expect(headlineMatch(shout.replace('SOL ', 'AVAX '), coin('AVAX', 'Avalanche'))).toMatchObject({ basis: 'ticker' });
  });

  it('a name match is case-insensitive, so an all-caps headline still finds the coin', () => {
    expect(headlineMatch('ETHEREUM FOUNDATION MOVES 1,000 COINS', coin('ETH', 'Ethereum'))).toMatchObject({ basis: 'name' });
  });
});

describe('the matcher — what confidence and why are allowed to say', () => {
  it('grades the SPECIFICITY of the evidence, not the news', () => {
    expect(headlineMatch('AVAX Subnet Count Doubles', coin('AVAX', 'Avalanche')).confidence).toBe('high');
    expect(headlineMatch('SUI TVL Crosses $2B', coin('SUI', 'Sui')).confidence).toBe('medium');
    expect(headlineMatch('Solana Ships Firedancer', coin('SOL', 'Solana')).confidence).toBe('high');
  });

  it('why quotes the matched text and never editorialises', () => {
    const rows = [
      headlineMatch('AVAX Subnet Count Doubles', coin('AVAX', 'Avalanche')),
      headlineMatch('Shiba Inu Burn Rate Jumps', coin('SHIB', 'Shiba Inu')),
      headlineMatch('Solana Rallies as SOL Volume Spikes', coin('SOL', 'Solana')),
    ];
    for (const r of rows) {
      expect(r.why).toMatch(/^the (ticker|full name|name) "/);
      expect(r.why).toMatch(/appears?\b.*\bin this headline$/);
      // Nothing in this module measured any of these, so nothing may say them.
      expect(r.why).not.toMatch(/bullish|bearish|positive|negative|rally|surge|risk|buy|sell|signal|sentiment|because|caused/i);
    }
  });
});

describe('matchHeadlines — the assembled answer', () => {
  const items = [
    { title: 'Solana Rallies as SOL ETF Filing Advances', url: 'https://a.test/1', source: 'coindesk', at: 5000 },
    { title: 'SOL Fees Fall to a Two-Year Low', url: 'https://a.test/2', source: 'cointelegraph', at: 4000 },
    { title: 'A New Custody Solution for Consoles', url: 'https://a.test/3', source: 'coindesk', at: 3000 },
    { title: 'Arbitrum Unlocks 92M ARB', url: 'https://a.test/4', source: 'coindesk', at: 2000 },
  ];
  const coins = [coin('SOL', 'Solana'), coin('ARB', 'Arbitrum'), coin('OP', 'Optimism'), coin('IP', 'Story')];

  it('keys matches by ticker and carries the citation with every row', () => {
    const { matches } = matchHeadlines(items, coins);
    expect(Object.keys(matches).sort()).toEqual(['ARB', 'SOL']);
    expect(matches.SOL).toHaveLength(2);
    expect(matches.SOL[0]).toMatchObject({
      title: 'Solana Rallies as SOL ETF Filing Advances',
      url: 'https://a.test/1',
      source: 'coindesk',
      at: 5000,
      basis: 'name+ticker',
      confidence: 'high',
    });
  });

  it('ranks coins by how many headlines named them, then recency, then market rank', () => {
    const { coins: ranked } = matchHeadlines(items, coins);
    expect(ranked.map((c) => c.symbol)).toEqual(['SOL', 'ARB']);
    expect(ranked[0]).toMatchObject({ symbol: 'SOL', count: 2, latestAt: 5000, confidence: 'high' });
  });

  // A coin with no headlines and a coin we never looked for are DIFFERENT
  // facts, and the second one has to say so or it reads as the first.
  it('reports every coin it refused to look for, with the reason', () => {
    const { skipped } = matchHeadlines(items, coins);
    const byS = Object.fromEntries(skipped.map((s) => [s.symbol, s.reason]));
    expect(Object.keys(byS).sort()).toEqual(['IP', 'OP']);
    expect(byS.IP).toMatch(/under 3 characters/);
    // OP joined this list when the one-word name gate landed, and the reason it
    // gives has to name BOTH refusals — a coin that says only "the ticker is
    // too short" reads as though the name was fine.
    expect(byS.OP).toMatch(/under 3 characters/);
    expect(byS.OP).toMatch(/could be ordinary English/);
  });

  it('never merges two coins that share a ticker — it keeps one and says so', () => {
    const dupes = [
      { id: 'sologenic', symbol: 'SOLO', name: 'Sologenic', rank: 300 },
      { id: 'solo-coin', symbol: 'SOLO', name: 'Solo Coin', rank: 900 },
    ];
    const { skipped, matches } = matchHeadlines(
      [{ title: 'SOLO Listing Lands', url: 'https://a.test/9', source: 'coindesk', at: 1 }],
      dupes,
    );
    expect(matches.SOLO).toHaveLength(1);
    const dup = skipped.find((s) => s.symbol === 'SOLO');
    expect(dup.name).toBe('Solo Coin');
    expect(dup.reason).toMatch(/two coins on this board use the ticker "SOLO"/);
  });

  it('a starred coin wins a ticker collision over a better-ranked board coin', () => {
    const { skipped } = matchHeadlines([], [
      { id: 'board', symbol: 'DUP', name: 'Board Coin', rank: 10, starred: false },
      { id: 'starred', symbol: 'DUP', name: 'Starred Coin', rank: 900, starred: true },
    ]);
    expect(skipped.find((s) => s.symbol === 'DUP').name).toBe('Board Coin');
  });

  it('handles junk input without throwing', () => {
    expect(matchHeadlines(null, null)).toEqual({ matches: {}, coins: [], skipped: [] });
    expect(matchHeadlines([null, { title: 5 }, {}], [null, { symbol: '' }, { symbol: 'SOL', name: 'Solana' }]).matches).toEqual({});
  });

  it('finishes a full board against a full feed in single-digit milliseconds', () => {
    const board = Array.from({ length: 300 }, (_, i) => ({ id: `c${i}`, symbol: `AA${String(i).padStart(3, '0')}`, name: `Coin Number ${i}`, rank: i + 1 }));
    const feed = Array.from({ length: 60 }, (_, i) => ({ title: `Headline number ${i} about AA042 and other things`, url: `https://a.test/${i}`, source: 'coindesk', at: i }));
    const t0 = Date.now();
    const { matches } = matchHeadlines(feed, board);
    expect(Date.now() - t0).toBeLessThan(250);
    expect(matches.AA042).toHaveLength(60);
  });
});

/* ========================= where the coins come from ========================= */

describe('coin sources', () => {
  it('reads the board out of an alt-scan cache payload, defensively', () => {
    expect(coinsFromScanCache(null)).toEqual([]);
    expect(coinsFromScanCache({})).toEqual([]);
    expect(coinsFromScanCache({ universe: 'nope' })).toEqual([]);
    expect(coinsFromScanCache({ universe: [{ id: 'solana', symbol: 'SOL', name: 'Solana', rank: 5 }, null, { junk: 1 }] }))
      .toEqual([{ id: 'solana', symbol: 'SOL', name: 'Solana', rank: 5, starred: false }]);
  });

  it('reads the watchlist blob, defensively', () => {
    expect(coinsFromWatchlist(null)).toEqual([]);
    expect(coinsFromWatchlist({ ids: [{ id: 'pepe', symbol: 'PEPE', name: 'Pepe' }] }))
      .toEqual([{ id: 'pepe', symbol: 'PEPE', name: 'Pepe', rank: null, starred: true }]);
  });

  it('merges the two, keeps the star, and backfills the rank the watchlist lacks', () => {
    const merged = mergeCoinSources(
      [{ id: 'solana', symbol: 'SOL', name: 'Solana', rank: null, starred: true }],
      [{ id: 'solana', symbol: 'SOL', name: 'Solana', rank: 5, starred: false },
        { id: 'arbitrum', symbol: 'ARB', name: 'Arbitrum', rank: 40, starred: false }],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ id: 'solana', starred: true, rank: 5 });
  });

  it('caps the list so an oversized blob cannot become an unbounded loop', () => {
    const many = Array.from({ length: 900 }, (_, i) => ({ id: `c${i}`, symbol: `C${i}`, name: `Coin ${i}`, rank: i }));
    expect(mergeCoinSources([], many, 320)).toHaveLength(320);
  });
});

/* ============================== the fetch chain ============================== */

describe('fetchFeed / fetchAltNews', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => body });
  const bad = (status) => ({ ok: false, status, headers: { get: () => null }, text: async () => '' });

  it('throws when a feed answers 200 with an error page — a 200 is not an answer', async () => {
    globalThis.fetch = vi.fn(async () => ok('<html><body>403</body></html>'));
    await expect(fetchFeed(FEEDS[0], {})).rejects.toThrow(/no readable items/);
  });

  it('names the host and the status when a feed refuses', async () => {
    globalThis.fetch = vi.fn(async () => bad(429));
    await expect(fetchFeed(FEEDS[1], {})).rejects.toThrow(/HTTP 429 from cointelegraph\.com/);
  });

  it('skips a hop with no budget left, and says that is what happened', async () => {
    globalThis.fetch = vi.fn(async () => ok(rssFeed([rssItem({})])));
    await expect(fetchFeed(FEEDS[0], { deadlineAt: Date.now() - 1 })).rejects.toThrow(/time budget was spent/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // One publisher being down does not make the other's headlines less true.
  it('serves the feed that answered and names the one that did not', async () => {
    globalThis.fetch = vi.fn(async (url) => (String(url).includes('coindesk') ? bad(503) : ok(atomFeed([atomEntry({})]))));
    const out = await fetchAltNews({});
    expect(out.sourceDetail).toBe('cointelegraph');
    expect(out.degraded).toEqual([expect.stringMatching(/^coindesk: HTTP 503/)]);
    expect(out.items).toHaveLength(1);
  });

  it('throws only when BOTH publishers fail, so the caller can serve its stale cache', async () => {
    globalThis.fetch = vi.fn(async () => bad(500));
    await expect(fetchAltNews({})).rejects.toThrow(/no feed answered/);
  });

  it('merges both publishers newest-first', async () => {
    globalThis.fetch = vi.fn(async (url) => (String(url).includes('coindesk')
      ? ok(rssFeed([rssItem({ title: 'Older CoinDesk Story', link: 'https://c.test/1', pubDate: 'Fri, 31 Jul 2026 09:00:00 GMT' })]))
      : ok(atomFeed([atomEntry({ title: 'Newer Cointelegraph Story', href: 'https://t.test/1', published: '2026-08-01T11:00:00Z' })]))));
    const out = await fetchAltNews({});
    expect(out.items.map((i) => i.title)).toEqual(['Newer Cointelegraph Story', 'Older CoinDesk Story']);
    expect(out.sourceDetail).toBe('coindesk + cointelegraph');
    expect(out.degraded).toEqual([]);
  });
});

/* ================================ the handler ================================ */

describe('/api/alt-news', () => {
  const realFetch = globalThis.fetch;
  let allowed;
  const authedReq = () => new Request('https://pentagon.test/api/alt-news', { headers: { authorization: 'Bearer test-token' } });

  const feedFetch = (feedBody) => vi.fn(async (url) => {
    // The Supabase session check shares this stub with the feeds.
    if (String(url).includes('supabase')) return { ok: true, status: 200, json: async () => ({ email: 'op@pentagon.test' }) };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => feedBody };
  });

  beforeEach(() => {
    BLOBS.clear();
    allowed = process.env.ALLOWED_EMAIL;
    delete process.env.ALLOWED_EMAIL;
    globalThis.fetch = feedFetch(rssFeed([
      rssItem({ title: 'Solana Rallies as SOL ETF Filing Advances', link: 'https://www.coindesk.com/a' }),
      rssItem({ title: 'A New Custody Solution for Consoles', link: 'https://www.coindesk.com/b' }),
    ]));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (allowed === undefined) delete process.env.ALLOWED_EMAIL; else process.env.ALLOWED_EMAIL = allowed;
  });

  const statusOf = async (name) => (await store().get('source_status', { type: 'json' }))?.[name] ?? null;

  it('refuses an unauthenticated request', async () => {
    const res = await altNewsHandler(new Request('https://pentagon.test/api/alt-news'), {});
    expect(res.status).toBe(401);
  });

  it('serves items, matches keyed by ticker, and the coin list it used', async () => {
    BLOBS.set('alt_scan_cache', { at: Date.now(), payload: { universe: [{ id: 'solana', symbol: 'SOL', name: 'Solana', rank: 5 }] } });
    const res = await altNewsHandler(authedReq(), {});
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toHaveLength(2);
    expect(body.sourceDetail).toBe('coindesk + cointelegraph');
    expect(Object.keys(body.matches)).toEqual(['SOL']);
    // The naive-match headline is in `items` and NOT under SOL.
    expect(body.matches.SOL).toHaveLength(1);
    expect(body.matches.SOL[0].why).toMatch(/^the name "Solana" and the ticker "SOL"/);
    expect(body.coins[0]).toMatchObject({ symbol: 'SOL', count: 1 });
    expect(body.coinsConsidered).toBe(1);
    expect(body.coinSource).toMatch(/Alts board alt-scan cached/);
    expect(body.ttlSec).toBe(TTL_SEC);
    expect(TTL_SEC).toBe(NEWS_TTL_SEC);
    expect(await statusOf('alt_news')).toMatchObject({ ok: true, detail: 'coindesk + cointelegraph' });
  });

  // An empty `matches` with no coin list behind it is not a quiet news day, and
  // the response must not let it be read as one.
  it('says out loud when there was no coin list to match against', async () => {
    const res = await altNewsHandler(authedReq(), {});
    const body = await res.json();
    expect(body.coinsConsidered).toBe(0);
    expect(body.matches).toEqual({});
    expect(body.degraded.join(' ')).toMatch(/no coin list at all/);
    expect(body.degraded.join(' ')).toMatch(/unmatched, not unmentioned/);
  });

  it('a second call inside the TTL reaches no publisher and does not restamp source health', async () => {
    BLOBS.set('alt_scan_cache', { at: Date.now(), payload: { universe: [{ id: 'solana', symbol: 'SOL', name: 'Solana', rank: 5 }] } });
    await altNewsHandler(authedReq(), {});
    const firstStatus = await statusOf('alt_news');

    const calls = globalThis.fetch.mock.calls.length;
    const res = await altNewsHandler(authedReq(), {});
    const body = await res.json();
    expect(body.cached).toBe(true);
    expect(body.stale).toBe(false);
    // One extra call: the auth round-trip. No feed was touched.
    const feedCalls = globalThis.fetch.mock.calls.slice(calls).filter(([u]) => !String(u).includes('supabase'));
    expect(feedCalls).toHaveLength(0);
    expect((await statusOf('alt_news')).at).toBe(firstStatus.at);
  });

  // Matching is NOT cached: a coin starred thirty seconds ago must show its
  // headlines now, not after the feed TTL expires.
  it('re-matches against the current coin list even on a cache hit', async () => {
    await altNewsHandler(authedReq(), {});
    expect((await (await altNewsHandler(authedReq(), {})).json()).matches).toEqual({});

    BLOBS.set('alt_watchlist', { ids: [{ id: 'solana', symbol: 'SOL', name: 'Solana' }], updatedAt: Date.now() });
    const body = await (await altNewsHandler(authedReq(), {})).json();
    expect(body.cached).toBe(true);
    expect(Object.keys(body.matches)).toEqual(['SOL']);
    expect(body.coins[0].starred).toBe(true);
    expect(body.coinSource).toMatch(/watchlist \(1 starred\)/);
  });

  it('serves an expired payload LABELLED stale, and records the source as down', async () => {
    const asOf = Date.now() - (TTL_SEC + 60) * 1000;
    BLOBS.set('alt_news_cache', {
      at: asOf,
      payload: {
        items: [{ title: 'Solana Rallies as SOL ETF Filing Advances', url: 'https://c.test/1', source: 'coindesk', at: asOf }],
        degraded: [], sourceDetail: 'coindesk + cointelegraph', asOf,
      },
    });
    BLOBS.set('alt_watchlist', { ids: [{ id: 'solana', symbol: 'SOL', name: 'Solana' }], updatedAt: Date.now() });
    globalThis.fetch = vi.fn(async (url) => (String(url).includes('supabase')
      ? { ok: true, status: 200, json: async () => ({ email: 'op@pentagon.test' }) }
      : { ok: false, status: 429, headers: { get: () => null }, text: async () => '' }));

    const res = await altNewsHandler(authedReq(), {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stale).toBe(true);
    expect(body.cacheAgeSec).toBeGreaterThan(TTL_SEC);
    expect(body.degraded.join(' ')).toMatch(/serving a \d+s-old cached payload — refetch failed/);
    // The matching still ran, against the current watchlist, on stale items.
    expect(Object.keys(body.matches)).toEqual(['SOL']);

    const st = await statusOf('alt_news');
    expect(st.ok).toBe(false);
    expect(st.lastError).toMatch(/no feed answered/);
    expect(st.detail).toBeNull();
  });

  it('502s with the reason when both publishers fail and there is no cache', async () => {
    globalThis.fetch = vi.fn(async (url) => (String(url).includes('supabase')
      ? { ok: true, status: 200, json: async () => ({ email: 'op@pentagon.test' }) }
      : { ok: false, status: 500, headers: { get: () => null }, text: async () => '' }));
    const res = await altNewsHandler(authedReq(), {});
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/no feed answered/);
  });

  it('carries asOf from the fetch, not from the response, so freshness survives caching', async () => {
    const first = await (await altNewsHandler(authedReq(), {})).json();
    await new Promise((r) => setTimeout(r, 12));
    const second = await (await altNewsHandler(authedReq(), {})).json();
    expect(second.cached).toBe(true);
    expect(second.asOf).toBe(first.asOf);
    expect(second.meta.fetchedAt).toBeGreaterThanOrEqual(first.meta.fetchedAt);
  });
});

/* ---- alt-news must not join CHECKAUTH_CALLERS by the back door ---- */
// util.mjs pins the list of functions that import the auth gate directly, and
// alts.test.mjs greps the directory to keep the list honest. This handler goes
// through sourceHandler instead, which is what that pin expects.
describe('the auth posture', () => {
  it('gates through sourceHandler rather than importing checkAuth', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { join, dirname } = await import('node:path');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../functions/alt-news.mjs'), 'utf8');
    expect(src).toMatch(/sourceHandler\('alt_news'/);
    expect(src.replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/\bcheckAuth\b|\bauthVerdict\b/);
  });
});
