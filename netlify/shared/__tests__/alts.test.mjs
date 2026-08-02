// Fixture tests for the alt data layer. There is no network here by design —
// the sandbox proxy 403s every crypto host on CONNECT — so every payload below
// is written from the documented upstream shape, exactly as sources.mjs's own
// parsers are tested.
//
// The cases that earn their keep are the ones a passing eyeball misses:
//   • the 1000× Binance multiplier, which is the one bug in this file that
//     produces a chart that looks completely fine and is off by three orders of
//     magnitude — every stop, target and position size computed off it is wrong
//     and nothing in the UI can tell;
//   • Binance's long/short accounts arriving as FRACTIONS (0.64), which render
//     as "0.64% long" — the opposite of what the number says;
//   • the degrade paths, which ARE the product: a malformed row, a hole in a
//     sparkline, a shorter volume array, an expired cache. Honesty over
//     completeness means each of those has a defined, tested answer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Blobs is mocked, not reached: sourceHandler records source health through it,
// and the stale-serve case below is a claim about what that record SAYS.
const BLOBS = new Map();
vi.mock('@netlify/blobs', () => ({
  getStore: () => ({
    get: async (k) => (BLOBS.has(k) ? JSON.parse(JSON.stringify(BLOBS.get(k))) : null),
    setJSON: async (k, v) => { BLOBS.set(k, JSON.parse(JSON.stringify(v))); },
    delete: async (k) => { BLOBS.delete(k); },
  }),
}));

import {
  parseCoinGeckoMarkets,
  parseCoinGeckoGlobal,
  parseFearGreed,
  parseTrending,
  parseCoinGeckoMarketChart,
  parseBinancePremiumIndex,
  parseBinanceOpenInterestHist,
  parseBinanceLongShort,
  parseCoinGeckoCoin,
  parseBinanceKlines,
  binanceSymbolCandidates,
  applyMultiplier,
  cacheEnvelope,
  cacheIsFresh,
  attemptBudget,
  MIN_ATTEMPT_MS,
  requestDeadline,
  PLATFORM_KILL_MS,
  RESPONSE_RESERVE_MS,
  altCandles,
  altDerivs,
  altCoinMeta,
  altWatchGate,
  mergeDominanceSample,
  isDominanceRow,
  DOM_HISTORY_CAP,
} from '../alts.mjs';
import {
  sourceHandler, store, checkAuth, authVerdict, AUTH_TIMEOUT_MS,
  CHECKAUTH_CALLERS, SOURCE_ERROR, SOURCE_CACHED,
} from '../util.mjs';
import { validateWatchlist } from '../../functions/alt-watchlist.mjs';
import altCoinHandler, { coinCacheKey } from '../../functions/alt-coin.mjs';
import altScanHandler from '../../functions/alt-scan.mjs';
import journalHandler from '../../functions/journal.mjs';

const TEST_OPERATOR_ID = '00000000-0000-0000-0000-000000000001';
const useTestOperator = () => {
  process.env.VITE_SUPABASE_URL = 'https://stub.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'stub-anon-key';
  process.env.ALLOWED_EMAIL = 'op@pentagon.test';
  process.env.ALLOWED_USER_ID = TEST_OPERATOR_ID;
};
useTestOperator();

/* ---------------- fixtures, written from the documented shapes ---------------- */

const sparkline = (n = 168, base = 0.000007) =>
  Array.from({ length: n }, (_, i) => base * (1 + Math.sin(i / 12) * 0.05));

const marketRow = (over = {}) => ({
  id: 'pepe',
  symbol: 'pepe',
  name: 'Pepe',
  image: 'https://assets.coingecko.com/coins/images/29850/large/pepe.png',
  current_price: 0.0000072,
  market_cap: 3_028_000_000,
  market_cap_rank: 32,
  fully_diluted_valuation: 3_030_000_000,
  total_volume: 941_000_000,
  high_24h: 0.0000075,
  low_24h: 0.0000068,
  price_change_percentage_24h: 8.1,
  circulating_supply: 420_690_000_000_000,
  total_supply: 420_690_000_000_000,
  max_supply: null,
  ath: 0.00001717,
  ath_change_percentage: -58.06,
  ath_date: '2024-12-09T14:10:15.184Z',
  atl: 0.00000005,
  atl_change_percentage: 14300.2,
  last_updated: '2026-07-31T12:00:00.000Z',
  sparkline_in_7d: { price: sparkline() },
  price_change_percentage_1h_in_currency: 0.42,
  price_change_percentage_24h_in_currency: 8.12,
  price_change_percentage_7d_in_currency: 22.4,
  price_change_percentage_14d_in_currency: -3.1,
  price_change_percentage_30d_in_currency: 41.9,
  price_change_percentage_1y_in_currency: 180.4,
  ...over,
});

/* ---------------- parseCoinGeckoMarkets ---------------- */

describe('parseCoinGeckoMarkets', () => {
  it('maps the documented fields and uppercases the symbol', () => {
    const [row] = parseCoinGeckoMarkets([marketRow()]);
    expect(row).toMatchObject({
      id: 'pepe',
      symbol: 'PEPE',
      name: 'Pepe',
      rank: 32,
      price: 0.0000072,
      mcap: 3_028_000_000,
      fdv: 3_030_000_000,
      vol24h: 941_000_000,
      chg1h: 0.42,
      chg24h: 8.12,
      chg7d: 22.4,
      chg14d: -3.1,
      chg30d: 41.9,
      chg1y: 180.4,
      ath: 0.00001717,
      athChangePct: -58.06,
      athDate: '2024-12-09T14:10:15.184Z',
      maxSupply: null,
    });
    expect(row.sparkline7d).toHaveLength(168);
  });

  // One coin with a broken row must not empty a 250-row board.
  it('drops unpriceable rows and keeps the rest, without throwing', () => {
    const rows = parseCoinGeckoMarkets([
      marketRow({ id: 'ok-one' }),
      marketRow({ id: 'no-price', current_price: null }),
      marketRow({ id: 'no-mcap', market_cap: null }),
      marketRow({ id: 'nan-price', current_price: 'not a number' }),
      null,
      'garbage',
      marketRow({ id: 'ok-two' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['ok-one', 'ok-two']);
  });

  // A CoinGecko error body is an object, not an array — and an error body that
  // parsed into an empty board would look exactly like "no coins qualified".
  it('throws on anything that is not an array', () => {
    for (const bad of [null, undefined, {}, { status: { error_code: 429 } }, '[]']) {
      expect(() => parseCoinGeckoMarkets(bad)).toThrow(/coingecko/);
    }
  });

  it('returns an empty board for an empty array rather than throwing', () => {
    expect(parseCoinGeckoMarkets([])).toEqual([]);
  });

  it('falls back to the plain 24h field when the _in_currency one is absent', () => {
    const [row] = parseCoinGeckoMarkets([marketRow({ price_change_percentage_24h_in_currency: undefined })]);
    expect(row.chg24h).toBe(8.1);
  });

  it('nulls a missing percentage instead of coercing it to zero', () => {
    const [row] = parseCoinGeckoMarkets([marketRow({ price_change_percentage_30d_in_currency: null })]);
    expect(row.chg30d).toBeNull();
  });

  // A hole in the series is dropped WHOLE. Compacting it would shift every bar
  // and quietly change the answer to "where does price sit in its 7d range".
  it('refuses a sparkline with a hole in it, and a stub too short to plot', () => {
    const holed = sparkline();
    holed[40] = null;
    expect(parseCoinGeckoMarkets([marketRow({ sparkline_in_7d: { price: holed } })])[0].sparkline7d).toBeNull();
    expect(parseCoinGeckoMarkets([marketRow({ sparkline_in_7d: { price: [1] } })])[0].sparkline7d).toBeNull();
    expect(parseCoinGeckoMarkets([marketRow({ sparkline_in_7d: undefined })])[0].sparkline7d).toBeNull();
  });

  it('copies the sparkline rather than aliasing the payload', () => {
    const raw = marketRow();
    const [row] = parseCoinGeckoMarkets([raw]);
    expect(row.sparkline7d).not.toBe(raw.sparkline_in_7d.price);
    expect(row.sparkline7d).toEqual(raw.sparkline_in_7d.price);
  });
});

/* ---------------- parseCoinGeckoGlobal ---------------- */

describe('parseCoinGeckoGlobal', () => {
  const raw = {
    data: {
      market_cap_percentage: { btc: 54.31, eth: 11.02 },
      total_market_cap: { usd: 3_410_000_000_000 },
      total_volume: { usd: 128_000_000_000 },
      market_cap_change_percentage_24h_usd: -1.44,
    },
  };

  it('maps dominance, total cap and 24h change', () => {
    expect(parseCoinGeckoGlobal(raw)).toEqual({
      btcDominancePct: 54.31,
      ethDominancePct: 11.02,
      totalMcapUsd: 3_410_000_000_000,
      totalVol24hUsd: 128_000_000_000,
      mcapChange24hPct: -1.44,
    });
  });

  // alt-watch turns this into a permanent daily history row, and the free tier
  // has no history endpoint to backfill from — a null here is forever.
  it('throws when BTC dominance is missing rather than recording a null day', () => {
    expect(() => parseCoinGeckoGlobal({ data: { market_cap_percentage: {} } })).toThrow(/BTC dominance/);
    expect(() => parseCoinGeckoGlobal({})).toThrow(/malformed global/);
    expect(() => parseCoinGeckoGlobal(null)).toThrow(/malformed global/);
  });

  // The case above was the only one covered, and it was the one that could not
  // happen: an ABSENT field. A BLANK one arrives the same way and used to be
  // worse than a null, because `Number('')` is 0 — the guard passed, a 0%
  // dominance was recorded as a measurement, and isDominanceRow could not tell
  // it from one. Split out because the two are different failures with
  // different blast radii.
  it('throws on a BLANK BTC dominance too — Number("") is 0, and 0% is a measurement', () => {
    for (const blank of ['', '   ', '\t\n']) {
      expect(() => parseCoinGeckoGlobal({ data: { market_cap_percentage: { btc: blank } } })).toThrow(/BTC dominance/);
    }
    // …while a numeric string is still a number. The guard rejects blanks, not strings.
    expect(parseCoinGeckoGlobal({ data: { market_cap_percentage: { btc: '54.31' } } }).btcDominancePct).toBe(54.31);
  });

  it('tolerates a missing ETH dominance — that is one number, not the payload', () => {
    const out = parseCoinGeckoGlobal({ data: { market_cap_percentage: { btc: 54.31 } } });
    expect(out.btcDominancePct).toBe(54.31);
    expect(out.ethDominancePct).toBeNull();
    expect(out.totalMcapUsd).toBeNull();
  });
});

/* ---------------- parseFearGreed ---------------- */

describe('parseFearGreed', () => {
  it('coerces the all-string payload into numbers', () => {
    const out = parseFearGreed({ data: [{ value: '39', value_classification: 'Fear', timestamp: '1700000000' }] });
    expect(out).toEqual({ value: 39, label: 'Fear', at: 1700000000 });
  });

  // The UI draws this on a fixed 0-100 track; an out-of-range value would put
  // the needle off the end of its own scale.
  it('clamps to 0-100 and rounds', () => {
    expect(parseFearGreed({ data: [{ value: '101.6' }] }).value).toBe(100);
    expect(parseFearGreed({ data: [{ value: '-4' }] }).value).toBe(0);
    expect(parseFearGreed({ data: [{ value: '72.4' }] }).value).toBe(72);
  });

  it('throws on an empty or malformed payload', () => {
    for (const bad of [{ data: [] }, { data: null }, {}, null, { data: [{ value: 'n/a' }] }]) {
      expect(() => parseFearGreed(bad)).toThrow(/alternative\.me/);
    }
  });

  it('nulls a missing label and timestamp rather than inventing them', () => {
    const out = parseFearGreed({ data: [{ value: '50' }] });
    expect(out.label).toBeNull();
    expect(out.at).toBeNull();
  });
});

/* ---------------- parseTrending ---------------- */

describe('parseTrending', () => {
  const raw = {
    coins: [
      { item: { id: 'pepe', symbol: 'pepe', name: 'Pepe', market_cap_rank: 32, score: 0 } },
      { item: null },
      { item: { id: 'bonk', symbol: 'bonk', name: 'Bonk', market_cap_rank: 61, score: 1 } },
      { nope: true },
      { item: { id: 'wif', symbol: 'wif', name: 'dogwifhat', market_cap_rank: null, score: 2 } },
    ],
  };

  // Dense ranks: a gap would read as "there is a #2 we are not showing you".
  it('ranks 1-based by position, skipping malformed entries without leaving a gap', () => {
    const out = parseTrending(raw);
    expect(out.map((c) => [c.symbol, c.rank])).toEqual([['PEPE', 1], ['BONK', 2], ['WIF', 3]]);
    expect(out[2].mcapRank).toBeNull();
  });

  it('throws when the coins array is missing', () => {
    for (const bad of [{}, null, { coins: {} }]) {
      expect(() => parseTrending(bad)).toThrow(/trending/);
    }
  });
});

/* ---------------- parseCoinGeckoMarketChart ---------------- */

describe('parseCoinGeckoMarketChart', () => {
  const raw = {
    prices: [[1700000000000, 1.5], [1700086400000, 1.7], [1700172800000, 1.6]],
    total_volumes: [[1700000000000, 900], [1700086400000, 1100], [1700172800000, 1000]],
  };

  it('emits flat bars in seconds, labelled close-only', () => {
    const { candles, quality } = parseCoinGeckoMarketChart(raw);
    expect(quality).toBe('close-only');
    expect(candles[0]).toEqual({ t: 1700000000, o: 1.5, h: 1.5, l: 1.5, c: 1.5, v: 900 });
    // The whole reason the label has to reach the UI: ATR and bandwidth are
    // identically zero on these bars, and a zero ATR sizes a stop to nothing.
    expect(candles.every((c) => c.o === c.c && c.h === c.l)).toBe(true);
  });

  // Zipping by index attaches every volume to the wrong bar for the rest of the
  // series the moment the two arrays disagree in length.
  it('keys volume by timestamp, so a shorter volume array nulls rather than shifts', () => {
    const { candles } = parseCoinGeckoMarketChart({ ...raw, total_volumes: [[1700086400000, 1100]] });
    expect(candles.map((c) => c.v)).toEqual([null, 1100, null]);
  });

  it('skips unusable points and throws when nothing survives', () => {
    const { candles } = parseCoinGeckoMarketChart({ prices: [[1700000000000, 1.5], [null, 2], [1700086400000, null]] });
    expect(candles).toHaveLength(1);
    expect(() => parseCoinGeckoMarketChart({ prices: [] })).toThrow(/no usable points/);
    expect(() => parseCoinGeckoMarketChart({})).toThrow(/malformed market_chart/);
  });
});

/* ---------------- binance derivatives ---------------- */

describe('parseBinancePremiumIndex', () => {
  it('parses the single-symbol object and leaves the funding rate un-annualised', () => {
    const out = parseBinancePremiumIndex({
      symbol: 'PEPEUSDT', markPrice: '0.00000721', lastFundingRate: '0.0001', nextFundingTime: 1700028800000,
    });
    expect(out).toEqual({
      symbol: 'PEPEUSDT', markPrice: 0.00000721, lastFundingRate: 0.0001, nextFundingTime: 1700028800000,
    });
  });

  it('throws on the array form and on a payload with no funding rate', () => {
    expect(() => parseBinancePremiumIndex([{ symbol: 'X' }])).toThrow(/single-symbol/);
    expect(() => parseBinancePremiumIndex({ symbol: 'X' })).toThrow(/funding rate/);
    expect(() => parseBinancePremiumIndex(null)).toThrow(/premiumIndex/);
  });
});

describe('parseBinanceOpenInterestHist', () => {
  it('coerces the string fields, orders ascending and drops rows with no OI', () => {
    const out = parseBinanceOpenInterestHist([
      { symbol: 'X', sumOpenInterest: '200.5', sumOpenInterestValue: '900.5', timestamp: 1700086400000 },
      { symbol: 'X', sumOpenInterest: '123.4', sumOpenInterestValue: '456.7', timestamp: 1700000000000 },
      { symbol: 'X', sumOpenInterest: null, timestamp: 1700172800000 },
    ]);
    expect(out).toEqual([
      { t: 1700000000, oi: 123.4, oiValueUsd: 456.7 },
      { t: 1700086400, oi: 200.5, oiValueUsd: 900.5 },
    ]);
  });

  it('throws on a non-array payload', () => {
    expect(() => parseBinanceOpenInterestHist({ code: -1121 })).toThrow(/openInterestHist/);
  });
});

describe('parseBinanceLongShort', () => {
  // THE conversion. longAccount is a fraction; every consumer speaks percent,
  // and 0.64 rendered as "0.64% long" says the opposite of what it means.
  it('converts the account fractions to percent', () => {
    const [row] = parseBinanceLongShort([
      { symbol: 'X', longShortRatio: '1.8', longAccount: '0.64', shortAccount: '0.36', timestamp: 1700000000000 },
    ]);
    expect(row).toEqual({ t: 1700000000, ratio: 1.8, longPct: 64, shortPct: 36 });
    expect(row.longPct + row.shortPct).toBeCloseTo(100, 6);
  });

  it('orders ascending and keeps a row that has a ratio but no account split', () => {
    const out = parseBinanceLongShort([
      { longShortRatio: '2.0', longAccount: '0.66', shortAccount: '0.34', timestamp: 1700086400000 },
      { longShortRatio: '1.5', timestamp: 1700000000000 },
      { longShortRatio: '1.1', timestamp: null },
    ]);
    expect(out.map((r) => r.t)).toEqual([1700000000, 1700086400]);
    expect(out[0].longPct).toBeNull();
  });

  it('throws on a non-array payload', () => {
    expect(() => parseBinanceLongShort(null)).toThrow(/long\/short/);
  });
});

/* ---------------- parseCoinGeckoCoin ---------------- */

describe('parseCoinGeckoCoin', () => {
  const raw = {
    id: 'pepe',
    symbol: 'pepe',
    name: 'Pepe',
    categories: ['Meme', null, 'Ethereum Ecosystem', ''],
    sentiment_votes_up_percentage: 71.4,
    watchlist_portfolio_users: 812_400,
    community_data: {
      reddit_subscribers: 51_000,
      reddit_accounts_active_48h: 340,
      reddit_average_posts_48h: 12.5,
      twitter_followers: 480_000,
      telegram_channel_user_count: null,
    },
    links: { homepage: ['', 'https://pepe.vip', ''], twitter_screen_name: 'pepecoineth', subreddit_url: '' },
  };

  it('filters the nulls CoinGecko really does emit inside categories', () => {
    expect(parseCoinGeckoCoin(raw).categories).toEqual(['Meme', 'Ethereum Ecosystem']);
  });

  it('keeps every community field null-safe — no Telegram is not zero members', () => {
    const { community } = parseCoinGeckoCoin(raw);
    expect(community).toEqual({
      sentimentUpPct: 71.4,
      redditSubs: 51_000,
      redditActive48h: 340,
      redditPosts48h: 12.5,
      twitterFollowers: 480_000,
      telegram: null,
      watchlistUsers: 812_400,
    });
    const bare = parseCoinGeckoCoin({ id: 'x', symbol: 'x', name: 'X' });
    expect(Object.values(bare.community).every((v) => v === null)).toBe(true);
    expect(bare.categories).toEqual([]);
  });

  it('picks the first non-empty homepage out of the padded array', () => {
    const { links } = parseCoinGeckoCoin(raw);
    expect(links).toEqual({ homepage: 'https://pepe.vip', twitter: 'pepecoineth', subreddit: null });
  });

  it('throws when there is no id to hang the data on', () => {
    expect(() => parseCoinGeckoCoin({ symbol: 'pepe' })).toThrow(/malformed coin/);
    expect(() => parseCoinGeckoCoin(null)).toThrow(/malformed coin/);
  });
});

/* ---------------- the 1000× multiplier ---------------- */

describe('binance symbol resolution and the 1000× multiplier', () => {
  it('offers the plain symbol first, then the 1000× form', () => {
    expect(binanceSymbolCandidates('pepe')).toEqual(['PEPEUSDT', '1000PEPEUSDT']);
    expect(binanceSymbolCandidates(' sh-ib ')).toEqual(['SHIBUSDT', '1000SHIBUSDT']);
    expect(binanceSymbolCandidates('')).toEqual([]);
    expect(binanceSymbolCandidates(null)).toEqual([]);
  });

  // The bug this exists to prevent: 1000PEPEUSDT prints ~0.0072 while a PEPE is
  // worth ~0.0000072. Left uncorrected the chart is internally consistent and
  // every level built on it — entry, stop, targets, position size — is 1000×
  // wrong, with nothing on screen able to tell.
  it('divides a 1000× symbol back to per-coin units', () => {
    const cgPrice = 0.0000072;
    const raw = [[1700000000000, '0.00710', '0.00750', '0.00700', '0.00720', '1000000', 1700086399999]];
    const asListed = parseBinanceKlines(raw);
    expect(asListed[0].c / cgPrice).toBeCloseTo(1000, 0); // uncorrected: 1000× the coin

    const perCoin = applyMultiplier(asListed, 1000);
    expect(perCoin[0].c).toBeCloseTo(cgPrice, 12);
    expect(perCoin[0].h).toBeCloseTo(0.0000075, 12);
    expect(perCoin[0].l).toBeCloseTo(0.000007, 12);
    expect(perCoin[0].t).toBe(asListed[0].t);
  });

  // Price divides, volume multiplies — a 1000PEPE bar counts lots, not coins.
  // Traded notional is the invariant that proves the pair of them right.
  it('keeps traded notional identical across the conversion', () => {
    const [listed] = parseBinanceKlines([[1700000000000, '0.0071', '0.0075', '0.0070', '0.0072', '1000000']]);
    const [perCoin] = applyMultiplier([listed], 1000);
    expect(perCoin.v).toBe(listed.v * 1000);
    expect(perCoin.c * perCoin.v).toBeCloseTo(listed.c * listed.v, 6);
  });

  it('is a no-op at 1× and on nonsense input', () => {
    const candles = [{ t: 1, o: 2, h: 3, l: 1, c: 2.5, v: 10 }];
    expect(applyMultiplier(candles, 1)).toBe(candles);
    expect(applyMultiplier(candles, null)).toBe(candles);
    expect(applyMultiplier(candles, 0)).toBe(candles);
    expect(applyMultiplier(null, 1000)).toEqual([]);
  });

  it('leaves a null volume null instead of turning it into 0', () => {
    const [out] = applyMultiplier([{ t: 1, o: 2, h: 2, l: 2, c: 2, v: null }], 1000);
    expect(out.v).toBeNull();
    expect(out.c).toBe(0.002);
  });
});

/* ---------------- the blank field, at every guard ---------------- */

// ONE COERCION, EIGHT PARSERS. `Number('')` and `Number(' ')` are both 0, so a
// field that arrived blank used to satisfy every `if (x == null) throw` guard in
// the data layer as a measured zero. The damage is not uniform and that is why
// this sweeps rather than spot-checks: a blank funding rate is a wrong number on
// one card, a blank BTC dominance is a fabricated statistic written into a
// series nothing can ever rebuild. Absent and blank are the same fact — no
// measurement — and both have to answer null.
describe('a blank string is an absent measurement, not a zero', () => {
  it('drops a market row whose price or market cap arrived blank', () => {
    const rows = parseCoinGeckoMarkets([
      marketRow({ id: 'blank-price', current_price: '' }),
      marketRow({ id: 'blank-mcap', market_cap: '  ' }),
      marketRow({ id: 'kept', current_price: '0.0000072', market_cap: '3028000000' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['kept']);
    expect(rows[0].price).toBe(0.0000072);
  });

  it('nulls a blank percentage rather than reporting a flat 24h', () => {
    const [row] = parseCoinGeckoMarkets([marketRow({
      price_change_percentage_24h_in_currency: '',
      price_change_percentage_24h: '',
      price_change_percentage_30d_in_currency: ' ',
    })]);
    expect(row.chg24h).toBeNull();
    expect(row.chg30d).toBeNull();
  });

  // 0 is maximum Extreme Fear. A blank gauge would have pinned the needle at
  // the end of its own scale and called it a reading.
  it('refuses a blank fear & greed value instead of reading maximum fear', () => {
    for (const blank of ['', '   ']) {
      expect(() => parseFearGreed({ data: [{ value: blank }] })).toThrow(/non-numeric fear & greed/);
    }
    expect(parseFearGreed({ data: [{ value: '0' }] }).value).toBe(0); // a real zero still reads
  });

  // 0 is "funding is flat", which the crowding read prints as a fact and the
  // directive leans on. Not measuring it is a different sentence.
  it('refuses a blank funding rate instead of reporting flat funding', () => {
    expect(() => parseBinancePremiumIndex({ symbol: 'X', lastFundingRate: '' })).toThrow(/funding rate/);
    expect(parseBinancePremiumIndex({ symbol: 'X', lastFundingRate: '0' }).lastFundingRate).toBe(0);
  });

  it('drops an open-interest row with a blank OI, and nulls a blank USD value', () => {
    const out = parseBinanceOpenInterestHist([
      { sumOpenInterest: '', sumOpenInterestValue: '456.7', timestamp: 1700000000000 },
      { sumOpenInterest: '200.5', sumOpenInterestValue: '', timestamp: 1700086400000 },
    ]);
    expect(out).toEqual([{ t: 1700086400, oi: 200.5, oiValueUsd: null }]);
  });

  // A blank longAccount at 0 reads as "nobody is long", which is a positioning
  // claim. The row keeps its ratio and says the split is unmeasured.
  it('nulls a blank long/short account split rather than reporting nobody long', () => {
    const [row] = parseBinanceLongShort([
      { longShortRatio: '1.8', longAccount: '', shortAccount: '  ', timestamp: 1700000000000 },
    ]);
    expect(row).toEqual({ t: 1700000000, ratio: 1.8, longPct: null, shortPct: null });
  });

  it('nulls blank community counts — no published Reddit is not zero subscribers', () => {
    const { community } = parseCoinGeckoCoin({
      id: 'x', symbol: 'x', name: 'X',
      sentiment_votes_up_percentage: '',
      community_data: { reddit_subscribers: '  ', twitter_followers: '480000' },
    });
    expect(community.sentimentUpPct).toBeNull();
    expect(community.redditSubs).toBeNull();
    expect(community.twitterFollowers).toBe(480000);
  });

  it('skips a market_chart point with a blank price instead of plotting a $0 bar', () => {
    const { candles } = parseCoinGeckoMarketChart({
      prices: [[1700000000000, ''], [1700086400000, 1.7]],
      total_volumes: [[1700086400000, '']],
    });
    expect(candles).toEqual([{ t: 1700086400, o: 1.7, h: 1.7, l: 1.7, c: 1.7, v: null }]);
  });

  it('leaves a blank multiplier as a no-op rather than dividing by zero', () => {
    const candles = [{ t: 1, o: 2, h: 3, l: 1, c: 2.5, v: 10 }];
    expect(applyMultiplier(candles, '')).toBe(candles);
    expect(applyMultiplier(candles, ' ')).toBe(candles);
  });
});

/* ---------------- the dominance series ---------------- */

// This array IS the dominance history — CoinGecko's free tier has no endpoint
// that can rebuild it — so a bug here is not a wrong render, it is a
// permanently wrong dataset. Hence the disproportionate number of cases.
describe('mergeDominanceSample', () => {
  const sample = (d, btcDom = 54.3) => ({ d, btcDom, ethDom: 11, totalMcap: 3.4e12 });

  it('starts a series from nothing', () => {
    expect(mergeDominanceSample(null, sample('2026-07-31'))).toEqual([sample('2026-07-31')]);
    expect(mergeDominanceSample([], sample('2026-07-31'))).toHaveLength(1);
  });

  it('appends one row per calendar day', () => {
    let rows = [];
    for (const d of ['2026-07-29', '2026-07-30', '2026-07-31']) rows = mergeDominanceSample(rows, sample(d));
    expect(rows.map((r) => r.d)).toEqual(['2026-07-29', '2026-07-30', '2026-07-31']);
  });

  // 12 passes a day at 2h spacing must leave 1 row, not 12. Last write wins, so
  // today tracks live dominance and every completed day settles at its final
  // pass — the same hour for every row, which is what makes a 30-day change a
  // comparison rather than a coincidence.
  it('keeps exactly one row per day, last write winning', () => {
    let rows = [sample('2026-07-30', 55.0)];
    for (const v of [54.9, 54.6, 54.31]) rows = mergeDominanceSample(rows, sample('2026-07-31', v));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(sample('2026-07-31', 54.31));
  });

  it('sorts before capping, so the cap drops the oldest and not the first stored', () => {
    const scrambled = [sample('2026-07-31'), sample('2026-07-01'), sample('2026-07-15')];
    const out = mergeDominanceSample(scrambled, sample('2026-07-10'), 3);
    expect(out.map((r) => r.d)).toEqual(['2026-07-10', '2026-07-15', '2026-07-31']);
  });

  it('caps at 400 days by default', () => {
    const many = Array.from({ length: 500 }, (_, i) => sample(`2025-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`));
    // (dates repeat, so dedupe collapses them) — the invariant is the ceiling.
    const out = mergeDominanceSample(many, sample('2026-07-31'));
    expect(out.length).toBeLessThanOrEqual(DOM_HISTORY_CAP);
    expect(DOM_HISTORY_CAP).toBe(400);
    const distinct = Array.from({ length: 450 }, (_, i) => sample(new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10)));
    const capped = mergeDominanceSample(distinct, sample('2026-07-31'));
    expect(capped).toHaveLength(400);
    expect(capped[capped.length - 1].d).toBe('2026-07-31');
  });

  // A half-written or hand-edited blob must not take the series down with it.
  it('drops junk rows instead of sorting around them', () => {
    const out = mergeDominanceSample(
      [null, 'oops', { d: 5, btcDom: 50 }, { d: '2026-07-30', btcDom: null }, sample('2026-07-29')],
      sample('2026-07-31')
    );
    expect(out.map((r) => r.d)).toEqual(['2026-07-29', '2026-07-31']);
  });

  // Recording a null dominance is worse than recording nothing: the row is
  // permanent and nothing can backfill the day it occupies.
  it('refuses a sample with no date or no dominance', () => {
    expect(() => mergeDominanceSample([], { d: '2026-07-31', btcDom: null })).toThrow(/refusing to record/);
    expect(() => mergeDominanceSample([], { btcDom: 54 })).toThrow(/refusing to record/);
    expect(() => mergeDominanceSample([], null)).toThrow(/refusing to record/);
  });

  it('does not mutate the array it was given', () => {
    const rows = [sample('2026-07-30')];
    mergeDominanceSample(rows, sample('2026-07-31'));
    expect(rows).toHaveLength(1);
  });

  it('isDominanceRow is the single predicate both the read and write side use', () => {
    expect(isDominanceRow(sample('2026-07-31'))).toBe(true);
    expect(isDominanceRow({ d: '2026-07-31', btcDom: '54.3' })).toBe(false);
    expect(isDominanceRow({ btcDom: 54.3 })).toBe(false);
    expect(isDominanceRow(null)).toBe(false);
  });
});

/* ---------------- the cache envelope ---------------- */

describe('cacheEnvelope', () => {
  const cached = { payload: { universe: [], degraded: ['trending: HTTP 429'] }, at: 1, ageSec: 30 };

  it('serves a fresh hit unlabelled, with its age', () => {
    const out = cacheEnvelope(cached, { ttlSec: 90 });
    expect(out).toMatchObject({ cached: true, stale: false, cacheAgeSec: 30 });
    expect(out.degraded).toEqual(['trending: HTTP 429']);
  });

  // A stale payload that does not SAY it is stale is worse than a 502: the
  // freshness ladder cannot age out a number it believes is current.
  it('labels an expired payload and states the refetch failure in degraded', () => {
    const out = cacheEnvelope({ ...cached, ageSec: 4000 }, { ttlSec: 90, refetchError: 'HTTP 429 from api.coingecko.com' });
    expect(out.stale).toBe(true);
    expect(out.cacheAgeSec).toBe(4000);
    expect(out.degraded[0]).toBe('trending: HTTP 429');
    expect(out.degraded[1]).toMatch(/4000s-old cached payload — refetch failed: HTTP 429/);
  });

  it('does not mutate the cached payload it was handed', () => {
    const src = { payload: { degraded: ['a'] }, ageSec: 999 };
    cacheEnvelope(src, { ttlSec: 90, refetchError: 'boom' });
    expect(src.payload.degraded).toEqual(['a']);
  });

  it('survives a payload with no degraded array at all', () => {
    const out = cacheEnvelope({ payload: { universe: [] }, ageSec: 999 }, { ttlSec: 90 });
    expect(out.degraded).toHaveLength(1);
    expect(out.degraded[0]).toMatch(/unknown error/);
  });

  // Every case above passes an INTEGER age, which is the only reason this
  // shipped: cacheGet returns a float. The envelope rounded before comparing to
  // the TTL while the callers compared the raw value, so an 89.5s-old cache was
  // fresh to alt-scan (no refetch attempted) and stale to the envelope — which
  // then appended "refetch failed: unknown error" describing a refetch that
  // never happened, and SeasonCard rendered it.
  it('decides staleness on the raw float and rounds only for display', () => {
    const at = (ageSec) => cacheEnvelope({ payload: {}, ageSec }, { ttlSec: 90 });
    expect(at(89.4).stale).toBe(false);
    expect(at(89.5).stale).toBe(false);
    expect(at(89.999).stale).toBe(false);
    expect(at(90).stale).toBe(true);
    // The half-second that produced the phantom failure: labelled fresh, and
    // nothing invented in degraded.
    expect(at(89.5).degraded).toBeUndefined();
    // Display still rounds — 89.5s of age reads as 90s, which is a rendering
    // choice and not the staleness decision.
    expect(at(89.5).cacheAgeSec).toBe(90);
  });

  it('cacheIsFresh is the one comparison, and the envelope cannot disagree with it', () => {
    for (const ageSec of [0, 89.4, 89.5, 89.999, 90, 90.4, 4000]) {
      const cached = { payload: {}, ageSec };
      expect(cacheEnvelope(cached, { ttlSec: 90 }).stale).toBe(!cacheIsFresh(cached, 90));
    }
    // No cache is not a fresh cache.
    expect(cacheIsFresh(null, 90)).toBe(false);
    expect(cacheIsFresh({ payload: {} }, 90)).toBe(false);
  });
});

/* ---------------- the request's time budget ---------------- */

// The chain that motivated this: Binance plain (3s) → Binance 1000× (3s) →
// CoinGecko (5s) is 11 seconds of honoured per-attempt timeouts against a ~10s
// platform kill — and a kill runs no catch block, so the stale-cache fallback
// the contract requires was unreachable in exactly the case it exists for.
describe('attemptBudget', () => {
  const now = 1_000_000;

  it('gives an attempt its full budget when there is no deadline', () => {
    expect(attemptBudget(3000, null, MIN_ATTEMPT_MS, now)).toBe(3000);
    expect(attemptBudget(3000, undefined, MIN_ATTEMPT_MS, now)).toBe(3000);
  });

  it('clips an attempt to what is left of the request, not to what it wanted', () => {
    expect(attemptBudget(3000, now + 4000, MIN_ATTEMPT_MS, now)).toBe(3000);
    expect(attemptBudget(3000, now + 1200, MIN_ATTEMPT_MS, now)).toBe(1200);
    expect(attemptBudget(5000, now + 5000, MIN_ATTEMPT_MS, now)).toBe(5000);
  });

  // A 40ms window cannot finish a TLS handshake to a CoinGecko edge. Starting
  // one anyway spends the time the fallback needed and returns a timeout.
  it('refuses a window too short to produce anything but a timeout', () => {
    expect(attemptBudget(3000, now + MIN_ATTEMPT_MS - 1, MIN_ATTEMPT_MS, now)).toBeNull();
    expect(attemptBudget(3000, now + MIN_ATTEMPT_MS, MIN_ATTEMPT_MS, now)).toBe(MIN_ATTEMPT_MS);
    expect(attemptBudget(3000, now, MIN_ATTEMPT_MS, now)).toBeNull();
    expect(attemptBudget(3000, now - 5000, MIN_ATTEMPT_MS, now)).toBeNull();
  });
});

/* ---------------- the chains under a deadline ---------------- */

describe('the fetch chains honour the request deadline', () => {
  let calls;
  const realFetch = globalThis.fetch;

  // Stubbed, not networked — the sandbox proxy 403s every crypto host anyway.
  const stub = (respond) => {
    globalThis.fetch = vi.fn(async (url) => { calls.push(String(url)); return respond(String(url)); });
  };
  const httpStatus = (status) => () => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) });

  beforeEach(() => { calls = []; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('altCandles fires nothing once the budget is spent, and says so', async () => {
    stub(httpStatus(200));
    await expect(altCandles('PEPE', 'pepe', { deadlineAt: Date.now() - 1 }))
      .rejects.toThrow(/time budget was spent/);
    expect(calls).toEqual([]);
  });

  it('altCandles names every hop it skipped, so the reason survives to degraded', async () => {
    stub(httpStatus(200));
    const err = await altCandles('PEPE', 'pepe', { deadlineAt: Date.now() - 1 }).catch((e) => e);
    expect(err.message).toMatch(/PEPEUSDT/);
    expect(err.message).toMatch(/1000PEPEUSDT/);
    expect(err.message).toMatch(/market_chart/);
  });

  it('altCoinMeta refuses rather than starting a request it cannot finish', async () => {
    stub(httpStatus(200));
    await expect(altCoinMeta('pepe', { deadlineAt: Date.now() - 1 })).rejects.toThrow(/time budget/);
    expect(calls).toEqual([]);
  });

  // The funding rate is in hand at this point; the three optional series are
  // not worth a platform kill. They come back null WITH a reason, which is the
  // same rule as everywhere else in this file.
  it('altDerivs keeps the funding rate and degrades the optional series when time runs out', async () => {
    // The funding probe itself eats most of the budget, which is the real
    // shape of this: the three optional series are what gets dropped, never
    // the number already in hand.
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      if (calls.length > 1) throw new Error('should not have been called');
      await new Promise((r) => setTimeout(r, 350));
      return { ok: true, status: 200, json: async () => ({ symbol: 'PEPEUSDT', markPrice: '0.0072', lastFundingRate: '0.0001', nextFundingTime: 1 }) };
    });
    const out = await altDerivs('PEPE', { deadlineAt: Date.now() + 1000 });
    expect(out.lastFundingRate).toBe(0.0001);
    expect(out.openInterest).toBeNull();
    expect(out.globalLongShort).toBeNull();
    expect(out.topLongShort).toBeNull();
    expect(out.degraded).toHaveLength(3);
    expect(out.degraded[0]).toMatch(/time budget/);
    expect(calls).toHaveLength(1);
  });
});

/* ---------------- "no perp" is a claim, not a shrug ---------------- */

// alt-coin.mjs renders a null from altDerivs as "SOL has no listed Binance
// perpetual" and sentiment.js as "…and none has been assumed". Both are
// sentences a reader will believe about the coin, so only Binance actually
// saying the symbol is not listed may produce them.
describe('altDerivs distinguishes "not listed" from "did not answer"', () => {
  const realFetch = globalThis.fetch;
  const stub = (status) => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status, json: async () => ({}) }));
  };
  afterEach(() => { globalThis.fetch = realFetch; });

  it('returns null when Binance answers 400 — the definitive "invalid symbol"', async () => {
    stub(400);
    expect(await altDerivs('SOL')).toBeNull();
  });

  // 404 WAS ON THE "NOT LISTED" LIST AND IT IS A DIFFERENT ANSWER. Binance
  // futures says 400 (-1121) for an unlisted SYMBOL; a 404 from fapi is about
  // the PATH. If /fapi/v1/premiumIndex ever moves, a 404-accepting gate makes
  // every probe return null and every coin on the board render "has no listed
  // Binance perpetual" — the exact positive false claim this function exists to
  // prevent, told about 250 coins at once, with nothing on screen able to say
  // the endpoint moved.
  it('throws on 404 — that is the path answering, not the symbol', async () => {
    stub(404);
    const err = await altDerivs('SOL').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/could not establish whether SOL has a listed perpetual/);
    expect(err.message).toMatch(/404/);
  });

  // The host is pinned too: only the FUTURES API's own 400 is evidence about a
  // futures listing. A 400 from anywhere else is somebody else's complaint.
  it('will not read a 400 from another host as "this coin has no perp"', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('HTTP 400 from api.binance.com'); });
    await expect(altDerivs('SOL')).rejects.toThrow(/could not establish/);
  });

  it.each([429, 418, 451, 500, 503])('throws on HTTP %i rather than claiming the coin has no futures market', async (status) => {
    stub(status);
    const err = await altDerivs('SOL').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/could not establish whether SOL has a listed perpetual/);
    expect(err.message).toMatch(String(status));
  });

  it('throws on a timeout, which is nobody\'s evidence about anything', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('timeout after 3000ms'); });
    await expect(altDerivs('SOL')).rejects.toThrow(/could not establish/);
  });

  it('throws on a payload it cannot parse — an unreadable answer is not a "no"', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ symbol: 'SOLUSDT' }) }));
    await expect(altDerivs('SOL')).rejects.toThrow(/could not establish/);
  });

  it('throws rather than reporting "no perp" for a symbol it never probed', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('should not be called'); });
    await expect(altDerivs('')).rejects.toThrow(/no symbol to probe/);
  });
});

/* ---------------- who may spend the sentinel's quota ---------------- */

// NOTHING HERE MAY CAUSE THE SCHEDULER TO SKIP A DOMINANCE SAMPLE. That series
// is the only reason a dominance trend exists to be read — CoinGecko's free
// tier has no history endpoint — and no later fix can backfill a day.
//
// The previous gate admitted one unauthenticated POST per 2-hour slot and
// claimed the slot in Blobs BEFORE doing any work, which meant a bare
// `curl -X POST` was admitted as `scheduled: true`, took the slot, and — if it
// then hit a routine CoinGecko 429 — wrote nothing while the real cron skipped
// with a 200 OK that Netlify recorded as a successful invocation. It also could
// not survive clock skew: a fire landing one second early computed the PREVIOUS
// slot, which the previous fire had claimed. Meanwhile the threat it defended
// against is not reachable — Netlify's docs say a scheduled function published
// as part of a deploy cannot be invoked with a URL, and netlify.toml declares
// alt-watch scheduled (pinned below). Certain lockout, hypothetical attack.
//
// So the tests below assert the ABSENCE of a mechanism, which is the only kind
// of assertion that can hold this invariant: no slot, no claim, no Blobs, no
// clock arithmetic, and no refusal of anything that could be the scheduler.
describe('altWatchGate cannot starve the cron', () => {
  // A REAL STORE THAT ALSO COUNTS. It has to actually persist, or a gate that
  // claims a slot would look identical to one that does not and every test
  // below would pass against the code they exist to refuse. (It did, briefly,
  // when this was a spy returning null — caught by running these against the
  // pre-fix source, which is the only thing that can catch it.)
  const mkStore = () => {
    const blob = new Map();
    const calls = [];
    return {
      blob,
      calls,
      get: async (k) => { calls.push(['get', k]); return blob.get(k) ?? null; },
      setJSON: async (k, v) => { calls.push(['setJSON', k, v]); blob.set(k, v); },
      delete: async (k) => { calls.push(['delete', k]); blob.delete(k); },
    };
  };
  const post = (init = {}) => new Request('https://pentagon.test/api/alt-watch', { method: 'POST', ...init });
  const cron = () => post({ headers: { 'content-type': 'application/json' }, body: '{"next_run":"2026-07-31T20:00:00.000Z"}' });
  const bare = () => post();

  const realFetch = globalThis.fetch;
  beforeEach(() => {
    // No token on any of these, so Supabase answers 401: this is the
    // unauthenticated path in every case below.
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  // The old boundary: 2h slots aligned to even UTC hours.
  const SLOT = 2 * 3600 * 1000;
  const slotTop = Math.floor(Date.UTC(2026, 6, 31, 18) / SLOT) * SLOT;

  it('admits the scheduler every single time, forever, whatever else has run', async () => {
    const s = mkStore();
    for (let i = 0; i < 25; i++) {
      const g = await altWatchGate(cron(), s, slotTop + i * 60_000);
      expect(g).toMatchObject({ allowed: true, authed: false, scheduled: true, reason: null });
    }
  });

  // The forgery that used to burn the slot. It is still admitted — but it can
  // no longer take anything away from the fire behind it.
  it('a forged bare POST cannot deny the cron behind it', async () => {
    const s = mkStore();
    expect((await altWatchGate(bare(), s, slotTop + 5_000)).allowed).toBe(true);
    expect((await altWatchGate(cron(), s, slotTop + 6_000)).allowed).toBe(true);
  });

  // THE SKEW CASE, EXACTLY AS REPRODUCED. A fire that lands one second EARLY —
  // container clock ahead of the scheduler — computed the PREVIOUS slot, which
  // the previous fire had already claimed. Measured on the old gate:
  //   on-time      allowed=true  slot=247989
  //   1s early     allowed=FALSE slot=247989  "already had its pass"
  //   then on-time allowed=true  slot=247991
  // A skipped pass, with a 200 OK, on a series nothing can backfill.
  it('admits a fire that lands a second early after an on-time one', async () => {
    const s = mkStore();
    expect((await altWatchGate(cron(), s, slotTop)).allowed).toBe(true);
    expect((await altWatchGate(cron(), s, slotTop + SLOT - 1000)).allowed).toBe(true);
    expect((await altWatchGate(cron(), s, slotTop + 2 * SLOT)).allowed).toBe(true);
  });

  it('admits every fire in a jittery schedule, early and late', async () => {
    const s = mkStore();
    const jitter = [0, -1000, 500, -1, 2000, -1500, 0, -60_000, 60_000];
    for (let n = 0; n < jitter.length; n++) {
      const at = slotTop + n * SLOT + jitter[n];
      expect({ n, allowed: (await altWatchGate(cron(), s, at)).allowed }).toEqual({ n, allowed: true });
    }
  });

  it('claims nothing and reads nothing — there is no state left to lock', async () => {
    const s = mkStore();
    await altWatchGate(cron(), s, slotTop);
    await altWatchGate(cron(), s, slotTop + 1000);
    expect(s.calls).toEqual([]);
  });

  it('is unbreakable by Blobs, because it never asks Blobs anything', async () => {
    const broken = {
      get: async () => { throw new Error('blobs down'); },
      setJSON: async () => { throw new Error('blobs down'); },
      delete: async () => { throw new Error('blobs down'); },
    };
    expect((await altWatchGate(cron(), broken, slotTop)).allowed).toBe(true);
    expect((await altWatchGate(cron(), undefined, slotTop)).allowed).toBe(true);
  });

  // "I did not recognise the invocation shape" must never be why a dominance
  // row is missing. The old gate refused anything that was not exactly POST —
  // the same fragility its own header worried about for the `next_run` body,
  // one field over.
  it.each([['PUT'], ['PATCH'], ['DELETE'], ['OPTIONS']])('admits %s rather than guessing about the platform', async (method) => {
    const s = mkStore();
    const g = await altWatchGate(new Request('https://pentagon.test/api/alt-watch', { method }), s, slotTop);
    expect(g.allowed).toBe(true);
  });

  it('admits a request that carries no method at all', async () => {
    expect((await altWatchGate({ headers: { get: () => '' } }, mkStore(), slotTop)).allowed).toBe(true);
  });

  // The one refusal that survives, and the only one that cannot be the
  // scheduler: Netlify invokes a scheduled function with a POST, and a browser,
  // a crawler and a bare curl send GET.
  it.each([['GET'], ['HEAD']])('still turns away the bare %s a browser or a crawler sends', async (method) => {
    const g = await altWatchGate(new Request('https://pentagon.test/api/alt-watch', { method }), mkStore(), slotTop);
    expect(g).toMatchObject({ allowed: false, scheduled: false });
    expect(g.reason).toMatch(/CoinGecko quota/);
  });

  it('lets a signed-in operator through as an operator, not as the schedule', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: TEST_OPERATOR_ID, email: 'op@pentagon.test' }) }));
    const authed = new Request('https://pentagon.test/api/alt-watch', { headers: { authorization: 'Bearer t' } });
    expect(await altWatchGate(authed, mkStore(), slotTop))
      .toMatchObject({ allowed: true, authed: true, scheduled: false });
  });

  // THE EVIDENCE THE THREAT IS UNREACHABLE, PINNED. The reasoning above rests
  // on alt-watch being a scheduled function, which Netlify does not expose by
  // URL. Delete the schedule block and it becomes an ordinary /api/* route —
  // at which point this gate's posture needs re-deciding, not silently
  // inheriting. So the config is part of the argument and part of the test.
  it('rests on alt-watch actually being scheduled in netlify.toml', () => {
    const { readFileSync } = require('node:fs');
    const { fileURLToPath } = require('node:url');
    const { dirname, join } = require('node:path');
    const toml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'netlify.toml'), 'utf8');
    expect(toml).toMatch(/\[functions\."alt-watch"\]\s*\n\s*schedule\s*=\s*"0 \*\/2 \* \* \*"/);
  });

  // THE GUARD HAS TO BE CALLED, AND FOR A WHILE IT WAS NOT.
  //
  // This gate shipped exported, documented and covered by every test above it
  // while alt-watch.mjs still ran `const authed = await checkAuth(req)` and let
  // the pass proceed regardless — the endpoint stayed wide open and the suite
  // stayed green, because a guard nothing invokes fails no test that only ever
  // calls the guard. Read the handler and assert the wiring, which is the one
  // property the unit tests above structurally cannot see.
  it('is actually wired into the handler, not merely exported', () => {
    const { readFileSync } = require('node:fs');
    const { fileURLToPath } = require('node:url');
    const { dirname, join } = require('node:path');
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'functions', 'alt-watch.mjs'), 'utf8',
    // Line comments FIRST. The handler's own prose mentions the `/api/*` route
    // mapping, and a block-comment pass run first reads that `/*` as an opening
    // delimiter and swallows the code underneath it — which is how this
    // assertion first went green against a file that did not have the call.
    ).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    expect(src).toMatch(/import\s*\{[^}]*\baltWatchGate\b[^}]*\}\s*from\s*'\.\.\/shared\/alts\.mjs'/);
    expect(src).toMatch(/await\s+altWatchGate\s*\(/);
    // and it must SHORT-CIRCUIT on a refusal rather than reading the flag and
    // carrying on, which is exactly what the old checkAuth line did.
    expect(src).toMatch(/if\s*\(\s*!\s*gate\.allowed\s*\)\s*return/);
    // the superseded path is gone: no second, ungated auth check.
    expect(src).not.toMatch(/\bcheckAuth\b/);
  });
});

/* ---------------- the alt_coin cache key ---------------- */

// The key has to be a function of everything the payload depends on. Keyed on
// `id` alone, `?id=pepe&symbol=XX` failed both Binance candidates, fell through
// to CoinGecko's close-only market_chart and wrote THAT into `alt_coin_pepe` —
// which the legitimate request then served for 300s. `close-only` is exactly
// what precedentRead refuses on, so one bad request silently stripped
// precedent, ATR and the swing levels off a real coin.
describe('coinCacheKey', () => {
  it('is a function of the symbol as well as the id', () => {
    expect(coinCacheKey('pepe', 'PEPE')).toBe('alt_coin_pepe_pepe');
    expect(coinCacheKey('pepe', 'XX')).not.toBe(coinCacheKey('pepe', 'PEPE'));
  });

  it('collapses the case that could read a key it could never populate', () => {
    // ID_RE is case-insensitive; CoinGecko 404s a non-lowercase slug. So `?id=PEPE`
    // could read alt_coin_pepe and serve it back labelled stale while being
    // structurally unable to ever write it. One spelling, one entry.
    expect(coinCacheKey('PEPE', 'PEPE')).toBe(coinCacheKey('pepe', 'pepe'));
  });

  it('stays inside the Blobs key charset the validators guarantee', () => {
    expect(coinCacheKey('wrapped-bitcoin-2', 'WBTC')).toMatch(/^alt_coin_[a-z0-9_-]+$/);
  });
});

/* ---------------- a stale serve is not a healthy source ---------------- */

// alt-scan and alt-coin swallow the upstream error and return the expired cache
// — correct, a labelled stale board beats a 502 that blanks the screen. But
// returning normally made sourceHandler write `ok: true, lastSuccessAt: now`,
// so /api/status reported the source green off a payload nobody could refetch.
// util.mjs opens with "so /api/status reflects reality, not hope".
describe('sourceHandler and the degraded serve', () => {
  const realFetch = globalThis.fetch;
  const authedReq = () => new Request('https://pentagon.test/api/alt-scan', { headers: { authorization: 'Bearer test-token' } });
  let allowed;

  beforeEach(() => {
    allowed = process.env.ALLOWED_EMAIL;
    useTestOperator();
    // The Supabase session check, stubbed. No network in this suite.
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: TEST_OPERATOR_ID, email: 'op@pentagon.test' }) }));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (allowed === undefined) delete process.env.ALLOWED_EMAIL; else process.env.ALLOWED_EMAIL = allowed;
  });

  const statusOf = async (name) => (await store().get('source_status', { type: 'json' }))?.[name] ?? null;

  it('records a live fetch as healthy, with the detail it actually used', async () => {
    const res = await sourceHandler('probe_live', async () => ({ ok: 1, sourceDetail: 'coingecko + alternative.me' }))(authedReq(), {});
    expect(res.status).toBe(200);
    expect(await statusOf('probe_live')).toMatchObject({ ok: true, detail: 'coingecko + alternative.me' });
  });

  it('records the source as DOWN when the payload came from a stale cache', async () => {
    const upstream = 'HTTP 429 from api.coingecko.com';
    const res = await sourceHandler('probe_stale', async () => ({
      universe: [],
      stale: true,
      sourceDetail: 'coingecko + alternative.me',
      [SOURCE_ERROR]: upstream,
    }))(authedReq(), {});

    // The client still gets its (labelled) data — degrading, not 502-ing.
    expect(res.status).toBe(200);
    expect((await res.json()).stale).toBe(true);

    const st = await statusOf('probe_stale');
    expect(st.ok).toBe(false);
    expect(st.lastError).toBe(upstream);
    // Not stamped with the CACHED payload's sources — that is the same lie in
    // a smaller font.
    expect(st.detail).toBeNull();
    expect(st.lastSuccessAt).toBeNull();
  });

  it('never puts the marker on the wire — a Symbol key does not survive JSON', async () => {
    const res = await sourceHandler('probe_wire', async () => ({ a: 1, [SOURCE_ERROR]: 'boom' }))(authedReq(), {});
    const body = await res.text();
    expect(body).not.toMatch(/boom/);
    expect(JSON.parse(body).a).toBe(1);
  });

  // alt-coin.mjs authenticates BEFORE it validates its params (so a typo cannot
  // make /api/status say the upstream is down) and then hands off to
  // sourceHandler, which authenticates again. Two Supabase round-trips with no
  // timeout on either was time the stale-cache fallback needed.
  it('asks Supabase once per request even when two call sites check', async () => {
    const req = authedReq();
    expect(await checkAuth(req)).toBe(true);
    const res = await sourceHandler('probe_memo', async () => ({ ok: 1 }))(req, {});
    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not carry a verdict across requests', async () => {
    expect(await checkAuth(authedReq())).toBe(true);
    expect(await checkAuth(authedReq())).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

/* ---------------- the watchlist validator ---------------- */

describe('validateWatchlist', () => {
  const entry = (over = {}) => ({ id: 'pepe', symbol: 'pepe', name: 'Pepe', note: '', ...over });

  it('accepts a well-formed list and uppercases the symbol', () => {
    const r = validateWatchlist({ ids: [entry(), entry({ id: 'bonk', symbol: 'BONK', name: 'Bonk' })] });
    expect(r.ok).toBe(true);
    expect(r.value.map((e) => e.symbol)).toEqual(['PEPE', 'BONK']);
    expect(r.value[0].addedAt).toBeNull(); // stamped by the handler, not the client
  });

  it('rejects a body that is not { ids: [...] }', () => {
    for (const bad of [null, undefined, 'pepe', 42, [], { ids: 'pepe' }, { ids: {} }]) {
      expect(validateWatchlist(bad).ok).toBe(false);
    }
  });

  it('caps the list at 60 — the sentinel screens all of it inside one 30s pass', () => {
    const many = (n) => ({ ids: Array.from({ length: n }, (_, i) => entry({ id: `coin-${i}` })) });
    expect(validateWatchlist(many(60)).ok).toBe(true);
    const r = validateWatchlist(many(61));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/capped at 60/);
  });

  it('enforces the id and symbol patterns that end up in URLs and Blobs keys', () => {
    expect(validateWatchlist({ ids: [entry({ id: 'pepe/../settings' })] }).ok).toBe(false);
    expect(validateWatchlist({ ids: [entry({ id: '' })] }).ok).toBe(false);
    expect(validateWatchlist({ ids: [entry({ id: 'x'.repeat(65) })] }).ok).toBe(false);
    expect(validateWatchlist({ ids: [entry({ symbol: 'PE PE' })] }).ok).toBe(false);
    expect(validateWatchlist({ ids: [entry({ symbol: 42 })] }).ok).toBe(false);
    expect(validateWatchlist({ ids: [entry({ id: 'wrapped-bitcoin-2' })] }).ok).toBe(true);
  });

  it('caps the note at 200 chars and the name at 100', () => {
    expect(validateWatchlist({ ids: [entry({ note: 'x'.repeat(200) })] }).ok).toBe(true);
    expect(validateWatchlist({ ids: [entry({ note: 'x'.repeat(201) })] }).ok).toBe(false);
    expect(validateWatchlist({ ids: [entry({ name: 'x'.repeat(101) })] }).ok).toBe(false);
  });

  // A client that spreads a whole AltRow into an entry should be told which
  // field was refused, not have 20 stale price fields persisted beside it.
  it('rejects unknown keys and names them', () => {
    const r = validateWatchlist({ ids: [entry({ price: 0.0000072 })] });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('entry 0: unknown key "price"');
  });

  // A duplicate star is a UI bug — an optimistic toggle that fired twice.
  // Deduping here would hide it while the sentinel screened the coin twice.
  it('rejects duplicate ids loudly', () => {
    const r = validateWatchlist({ ids: [entry(), entry()] });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/duplicate id "pepe"/);
  });

  it('reports every problem in one pass', () => {
    const r = validateWatchlist({ ids: [entry({ id: '!' }), entry({ id: 'ok', note: 'x'.repeat(999) }), 'nope'] });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('accepts an explicit epoch addedAt and rejects a non-numeric one', () => {
    expect(validateWatchlist({ ids: [entry({ addedAt: 1700000000000 })] }).value[0].addedAt).toBe(1700000000000);
    expect(validateWatchlist({ ids: [entry({ addedAt: '2026-07-31' })] }).ok).toBe(false);
  });

  it('accepts an empty list — clearing the watchlist is a legal write', () => {
    expect(validateWatchlist({ ids: [] })).toEqual({ ok: true, value: [] });
  });

  // MAX_ENTRIES caps how many entries a body may carry, not how many KEYS each
  // one carries. Sixty legal-looking entries of ten thousand junk keys each is
  // a 6MB body that built 600,000 error strings before the 400 went out.
  it('caps the error report and counts the rest, so a huge body costs a counter', () => {
    const junk = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`junk${i}`, 1]));
    const r = validateWatchlist({ ids: [{ id: 'pepe', symbol: 'PEPE', ...junk }] });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeLessThanOrEqual(21);
    expect(r.errors[0]).toMatch(/unknown key "junk0"/);
    expect(r.errors[r.errors.length - 1]).toMatch(/and 4980 more problems/);
  });

  it('still reports every problem when there are few enough to be worth reading', () => {
    const r = validateWatchlist({ ids: [{ id: '!', symbol: 'PEPE' }, { id: 'ok', symbol: 'OK', note: 'x'.repeat(999) }] });
    expect(r.errors).toHaveLength(2);
    expect(r.errors.some((e) => /and \d+ more/.test(e))).toBe(false);
  });

  // A CoinGecko id is a lowercase slug and ID_RE is case-insensitive, so an
  // entry stored as "PEPE" matched nothing in the screened universe: the
  // sentinel counted the coin as off-board every pass and the star silently
  // watched nothing. Same canonicalisation alt-coin.mjs does on its query param.
  it('canonicalises the id, and catches two spellings of one coin as the duplicate they are', () => {
    const r = validateWatchlist({ ids: [entry({ id: 'PePe' })] });
    expect(r.value[0].id).toBe('pepe');
    const dupe = validateWatchlist({ ids: [entry({ id: 'pepe' }), entry({ id: 'PEPE' })] });
    expect(dupe.ok).toBe(false);
    expect(dupe.errors[0]).toMatch(/duplicate id "pepe"/);
  });
});

/* ================= the request's time budget, per endpoint ================= */

// A 7500ms deadline measured from arrival was written for alt-coin's genuinely
// serial 11-second chain and then applied to alt-scan, which never had that
// problem: four calls in PARALLEL whose longest hop is 6000ms. With checkAuth
// and the Blobs read now inside that window, the >1MB universe fetch could be
// handed as little as ~4400ms — so a healthy CoinGecko was aborted, the board
// went stale, and /api/status was told the source was down. Each endpoint's
// budget now comes out of its own chain.

describe('requestDeadline', () => {
  const WALL = PLATFORM_KILL_MS - RESPONSE_RESERVE_MS;

  it('lets the CHAIN clock bind when the invocation still has life left', () => {
    // alt-scan shape: 2000ms of auth already spent, 6000ms of chain to run.
    expect(requestDeadline({ arrivedAt: 0, chainMs: 6000, now: 2050 })).toBe(8050);
    // and that leaves the universe fetch its whole 6000ms, which is the number
    // altUniverse says the payload needs. Pre-fix this was 7500 - 2050 = 5450.
    expect(attemptBudget(6000, 8050, MIN_ATTEMPT_MS, 2050)).toBe(6000);
  });

  it('lets the WALL bind once the chain would outlive the function', () => {
    // alt-coin shape: an 11s chain against a ~10s kill. The wall always wins,
    // which is exactly why alt-coin needs one and alt-scan did not.
    expect(requestDeadline({ arrivedAt: 0, chainMs: 11_000, now: 100 })).toBe(WALL);
    expect(requestDeadline({ arrivedAt: 0, chainMs: 11_000, now: 6000 })).toBe(WALL);
  });

  it('takes whichever clock is tighter, always', () => {
    for (const now of [0, 500, 2000, 4000, 7000, 9000]) {
      for (const chain of [3000, 6000, 11_000]) {
        const d = requestDeadline({ arrivedAt: 0, chainMs: chain, now });
        expect(d).toBe(Math.min(WALL, now + chain));
        expect(d).toBeLessThanOrEqual(WALL);
      }
    }
  });

  it('leaves the platform enough room to actually send the answer', () => {
    // The reserve is not a rounding allowance: alt-scan serialises a >1MB
    // payload and writes the cache after the deadline has passed.
    expect(PLATFORM_KILL_MS - WALL).toBe(RESPONSE_RESERVE_MS);
    expect(RESPONSE_RESERVE_MS).toBeGreaterThanOrEqual(1000);
  });

  it('degrades to null rather than a fabricated instant on missing inputs', () => {
    expect(requestDeadline({ arrivedAt: null, chainMs: 6000 })).toBeNull();
    expect(requestDeadline({ arrivedAt: 0, chainMs: null })).toBeNull();
    expect(requestDeadline({})).toBeNull();
  });
});

/* ---------------- the handlers, driven end to end on a fake clock ---------------- */

// Fake timers, so an 8-second budget costs the suite nothing and the assertions
// are about arithmetic rather than about how loaded the machine is. Every delay
// below is a setTimeout the fake clock drives; the abort controllers inside
// getJson and verifySession are driven by the same clock.
function upstreams({ authMs = 20, authStatus = 200, cgMarketsMs = 200, cgMarketsHangs = false, fapiStatus = null } = {}) {
  const calls = [];
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => { clearTimeout(t); reject(signal.reason || new Error('aborted')); };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort);
  });
  const fn = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('supabase.co')) {
      await wait(authMs, opts.signal);
      return { ok: authStatus >= 200 && authStatus < 300, status: authStatus, json: async () => ({ id: TEST_OPERATOR_ID, email: 'op@pentagon.test' }) };
    }
    if (u.includes('coins/markets')) {
      await wait(cgMarketsHangs ? 60_000 : cgMarketsMs, opts.signal);
      return { ok: true, status: 200, json: async () => Array.from({ length: 250 }, (_, i) => marketRow({ id: `c${i}`, symbol: `c${i}`, market_cap: 1e9 - i })) };
    }
    if (u.includes('/global')) {
      await wait(50, opts.signal);
      return { ok: true, status: 200, json: async () => ({ data: { market_cap_percentage: { btc: 54.2, eth: 12.1 }, total_market_cap: { usd: 2.4e12 }, total_volume: { usd: 9.1e10 }, market_cap_change_percentage_24h_usd: 1.4 } }) };
    }
    if (u.includes('alternative.me')) {
      await wait(50, opts.signal);
      return { ok: true, status: 200, json: async () => ({ data: [{ value: '39', value_classification: 'Fear', timestamp: '1700000000' }] }) };
    }
    if (u.includes('search/trending')) {
      await wait(50, opts.signal);
      return { ok: true, status: 200, json: async () => ({ coins: [{ item: { id: 'pepe', symbol: 'pepe', name: 'Pepe', market_cap_rank: 32 } }] }) };
    }
    if (u.includes('fapi.binance.com')) {
      await wait(20, opts.signal);
      if (fapiStatus === 'timeout') throw new Error('fapi.binance.com did not answer inside the 3000ms this request had left for it');
      return { ok: false, status: fapiStatus, json: async () => ({}) };
    }
    if (u.includes('api.binance.com')) {
      await wait(20, opts.signal);
      return { ok: true, status: 200, json: async () => Array.from({ length: 300 }, (_, i) => [1700000000000 + i * 86400000, '1', '2', '0.5', '1.5', '10', 0, '0', 0, '0', '0', '0']) };
    }
    await wait(20, opts.signal);
    return { ok: true, status: 200, json: async () => ({ id: 'solana', symbol: 'sol', name: 'Solana', categories: [], community_data: {} }) };
  });
  fn.calls = calls;
  return fn;
}

// `wall` is stamped WHEN THE PROMISE SETTLES, not after the clock is advanced —
// advanceTimersByTimeAsync moves the fake clock the whole way regardless, so
// reading Date.now() afterwards would report the advance, not the handler.
async function onFakeClock(run) {
  vi.useFakeTimers();
  try {
    const started = Date.now();
    let wall = null;
    const p = Promise.resolve(run()).then(
      (v) => { wall ??= Date.now() - started; return v; },
      (e) => { wall ??= Date.now() - started; throw e; },
    );
    await vi.advanceTimersByTimeAsync(120_000);
    return { out: await p, wall };
  } finally {
    vi.useRealTimers();
  }
}

const authedGet = (path) => new Request(`https://pentagon.test${path}`, { headers: { authorization: 'Bearer test-token' } });
const healthOf = async (name) => (await store().get('source_status', { type: 'json' }))?.[name] ?? null;

describe('alt-scan gets a budget derived from its own chain', () => {
  const realFetch = globalThis.fetch;
  let allowed;
  beforeEach(() => {
    BLOBS.clear();
    allowed = process.env.ALLOWED_EMAIL;
    useTestOperator();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (allowed === undefined) delete process.env.ALLOWED_EMAIL; else process.env.ALLOWED_EMAIL = allowed;
  });

  // THE REGRESSION, ON THE ENDPOINT THE WHOLE TAB POLLS. Everything is healthy:
  // Supabase answers in 2s and CoinGecko returns the markets payload in 5.6s,
  // both well inside their own budgets. Under the shared arrival-based 7500ms
  // this produced a hard 502 on a cold cache.
  it('serves a live board when a slow auth hop is followed by a healthy 5.6s CoinGecko', async () => {
    globalThis.fetch = upstreams({ authMs: 2000, cgMarketsMs: 5600 });
    const { out: res, wall } = await onFakeClock(() => altScanHandler(authedGet('/api/alt-scan'), {}));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.universe).toHaveLength(250);
    expect(body.stale).toBe(false);
    expect(body.cached).toBe(false);
    expect(body.degraded).toEqual([]);
    // And the source is recorded as what it was: up.
    expect(await healthOf('alt_scan')).toMatchObject({ ok: true, lastError: null });
    expect(wall).toBeLessThan(PLATFORM_KILL_MS);
  });

  // The same latencies with a cache to fall back on: the board went stale, the
  // user was told the refetch failed, and /api/status was told CoinGecko was
  // down — three claims about an upstream that answered correctly.
  it('does not report a healthy CoinGecko as down, or a live board as stale', async () => {
    BLOBS.set('alt_scan_cache', {
      at: Date.now() - 200_000,
      payload: { universe: [{ id: 'old' }], degraded: [], sourceDetail: 'coingecko', asOf: Date.now() - 200_000 },
    });
    globalThis.fetch = upstreams({ authMs: 2500, cgMarketsMs: 5500 });
    const { out: res } = await onFakeClock(() => altScanHandler(authedGet('/api/alt-scan'), {}));
    const body = await res.json();

    expect(body.stale).toBe(false);
    expect(body.universe).toHaveLength(250);
    expect(body.degraded.join(' ')).not.toMatch(/refetch failed/);
    const h = await healthOf('alt_scan');
    expect(h.ok).toBe(true);
    expect(h.detail).toBe('coingecko + alternative.me');
  });

  // The other half of the same rule, and the guard against the fix: the wall
  // must still bind when the invocation is genuinely running out of life, so
  // the stale fallback stays reachable instead of meeting the platform kill.
  it('still degrades to a labelled stale board inside the platform budget when CoinGecko really is gone', async () => {
    BLOBS.set('alt_scan_cache', {
      at: Date.now() - 200_000,
      payload: { universe: [{ id: 'old' }], degraded: [], sourceDetail: 'coingecko', asOf: Date.now() - 200_000 },
    });
    globalThis.fetch = upstreams({ authMs: 2900, cgMarketsHangs: true });
    const { out: res, wall } = await onFakeClock(() => altScanHandler(authedGet('/api/alt-scan'), {}));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stale).toBe(true);
    expect(wall).toBeLessThan(PLATFORM_KILL_MS);
    expect(wall).toBeLessThanOrEqual(PLATFORM_KILL_MS - RESPONSE_RESERVE_MS + 50);
    expect(await healthOf('alt_scan')).toMatchObject({ ok: false });
  });

  // "timeout after 4400ms" reads as the host being slow when the 4400 was OUR
  // remaining budget. A clipped hop and a dead upstream are different
  // incidents; the sentence /api/status stores has to say which one happened.
  it('says whose clock ran out when it gives up on a hop', async () => {
    globalThis.fetch = upstreams({ authMs: 20, cgMarketsHangs: true });
    const { out: res } = await onFakeClock(() => altScanHandler(authedGet('/api/alt-scan'), {}));
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.error).toMatch(/api\.coingecko\.com did not answer inside the \d+ms this request had left for it/);
  });
});

/* ---------------- "no perp" is a claim, and the payload has to carry which ---------------- */

// altDerivs already told "Binance said not listed" apart from "Binance did not
// answer" — and alt-coin.mjs collapsed both back into `derivs: null`, which is
// the only field crowdRead reads. So a 451 geo-block, the EXPECTED response
// from a datacenter IP, rendered the positive claim that the coin has no
// futures market, verbatim. The reason lived in `degraded`, which is not the
// sentence a reader believes.
describe('alt-coin publishes WHY derivs is null', () => {
  const realFetch = globalThis.fetch;
  let allowed;
  beforeEach(() => {
    BLOBS.clear();
    allowed = process.env.ALLOWED_EMAIL;
    useTestOperator();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (allowed === undefined) delete process.env.ALLOWED_EMAIL; else process.env.ALLOWED_EMAIL = allowed;
  });

  // Cleared per read: this endpoint caches per id+symbol for 300s, so a second
  // read in the same test would answer out of the first one's payload.
  const read = async (fapiStatus) => {
    BLOBS.clear();
    globalThis.fetch = upstreams({ fapiStatus });
    const { out: res } = await onFakeClock(() => altCoinHandler(authedGet('/api/alt-coin?id=solana&symbol=SOL'), {}));
    return res.json();
  };

  it('calls it a measurement only when Binance measured it', async () => {
    const b = await read(400);
    expect(b.derivs).toBeNull();
    expect(b.derivsStatus).toBe('not_listed');
    expect(b.derivsUnavailable).toBeNull();
    expect(b.degraded.join(' ')).toMatch(/SOL has no listed Binance perpetual/);
  });

  // The three shapes that are NOT evidence about the coin. 451 is the one that
  // matters most: status.mjs's own probe list says a datacenter IP collects it
  // from fapi.binance.com as a matter of course.
  it.each([[451, 'geo-block'], [429, 'quota bump'], ['timeout', 'no answer at all']])(
    'refuses to turn a %s (%s) into a claim about the coin', async (fapiStatus) => {
      const b = await read(fapiStatus);
      expect(b.derivs).toBeNull();
      expect(b.derivsStatus).toBe('unavailable');
      expect(typeof b.derivsUnavailable).toBe('string');
      expect(b.derivsUnavailable.length).toBeGreaterThan(0);
      // and nothing in the payload states the coin has no perp.
      expect(JSON.stringify(b)).not.toMatch(/has no listed Binance perpetual/);
    });

  it('gives the three cases three different statuses, so a consumer can branch', async () => {
    expect((await read(400)).derivsStatus).toBe('not_listed');
    expect((await read(451)).derivsStatus).toBe('unavailable');
    globalThis.fetch = upstreams({ fapiStatus: 200 });
    // a 200 whose body parses is the only 'ok' — this stub's premiumIndex body
    // is unparseable, so it lands in 'unavailable', which is the honest answer
    // for an unreadable response and is asserted by altDerivs' own tests above.
    expect(['ok', 'unavailable']).toContain((await read(200)).derivsStatus);
  });
});

/* ================= the auth check, and the eight handlers it was changed under ================= */

describe('checkAuth: the blast radius is written down and pinned', () => {
  const fnDir = () => {
    const { fileURLToPath } = require('node:url');
    const { dirname, join } = require('node:path');
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'functions');
  };

  // A shared auth change reaches every one of these, and until now the list of
  // them lived nowhere. Grep for the IMPORT, not a mention: claude-stream.mjs
  // discusses checkAuth in prose and does not use it.
  it('CHECKAUTH_CALLERS is every function that actually imports the gate', () => {
    const { readFileSync, readdirSync } = require('node:fs');
    const { join } = require('node:path');
    const dir = fnDir();
    const found = readdirSync(dir)
      .filter((f) => f.endsWith('.mjs'))
      .filter((f) => {
        const src = readFileSync(join(dir, f), 'utf8')
          .replace(/^\s*\/\/.*$/gm, '')
          .replace(/\/\*[\s\S]*?\*\//g, '');
        const imports = src.match(/import\s*\{[^}]*\}\s*from\s*'\.\.\/shared\/util\.mjs'/g) || [];
        return imports.some((i) => /\bcheckAuth\b|\bauthVerdict\b/.test(i));
      })
      .sort();
    expect(found).toEqual([...CHECKAUTH_CALLERS].sort());
  });

  it('the timeout is documented as a constant, not a magic number in a fetch call', () => {
    expect(AUTH_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
    expect(AUTH_TIMEOUT_MS).toBeLessThan(PLATFORM_KILL_MS);
  });
});

describe('checkAuth: a refusal and an outage are different answers', () => {
  const realFetch = globalThis.fetch;
  let allowed;
  beforeEach(() => {
    BLOBS.clear();
    allowed = process.env.ALLOWED_EMAIL;
    useTestOperator();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (allowed === undefined) delete process.env.ALLOWED_EMAIL; else process.env.ALLOWED_EMAIL = allowed;
  });
  const withToken = () => new Request('https://pentagon.test/api/journal', { headers: { authorization: 'Bearer t' } });

  it.each([[401], [403]])('Supabase answering %i is a definitive refusal', async (status) => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status, json: async () => ({}) }));
    expect(await authVerdict(withToken())).toMatchObject({ ok: false, indeterminate: false });
  });

  it('a missing token is a refusal, and costs Supabase nothing', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('should not be called'); });
    expect(await authVerdict(new Request('https://pentagon.test/api/journal')))
      .toMatchObject({ ok: false, indeterminate: false });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([[500], [502], [429]])('Supabase answering %i is an OUTAGE, not a verdict about the token', async (status) => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status, json: async () => ({}) }));
    const v = await authVerdict(withToken());
    expect(v).toMatchObject({ ok: false, indeterminate: true });
    expect(v.reason).toMatch(String(status));
  });

  it('a network failure is an outage too, and still fails closed', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNRESET'); });
    expect(await authVerdict(withToken())).toMatchObject({ ok: false, indeterminate: true });
  });

  // A SUPABASE COLD START IS NOT A BAD TOKEN. 3000ms sat inside the range one
  // legitimately takes, and the old code turned it into a bare `false` — which
  // every caller renders as 401 "unauthorized" — on eight handlers that had
  // never opted into that trade.
  it('a 3.5s Supabase cold start verifies rather than 401-ing a working token', async () => {
    globalThis.fetch = upstreams({ authMs: 3500 });
    const { out } = await onFakeClock(() => authVerdict(withToken()));
    expect(out).toMatchObject({ ok: true, indeterminate: false });
  });

  // ONLY THE HEADER WAIT WAS BOUNDED. fetchWithTimeout clears its timer the
  // moment the headers land, so res.json() ran completely unbounded — a stalled
  // response stream held the function past the platform kill while the comment
  // above it said it could not.
  it('bounds the body read with the same timer as the handshake', async () => {
    process.env.ALLOWED_EMAIL = 'op@pentagon.test';
    globalThis.fetch = vi.fn(async (url, opts = {}) => ({
      ok: true,
      status: 200,
      json: () => new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ id: TEST_OPERATOR_ID, email: 'op@pentagon.test' }), 60_000);
        opts.signal?.addEventListener('abort', () => { clearTimeout(t); reject(opts.signal.reason); });
      }),
    }));
    const { out, wall } = await onFakeClock(() => authVerdict(withToken()));
    expect(wall).toBeLessThanOrEqual(AUTH_TIMEOUT_MS + 50);
    expect(out).toMatchObject({ ok: false, indeterminate: true });
  });

  it('memoises a verdict it actually reached, so the double check costs one round-trip', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: TEST_OPERATOR_ID, email: 'op@pentagon.test' }) }));
    const req = withToken();
    expect(await checkAuth(req)).toBe(true);
    expect(await checkAuth(req)).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('memoises a definitive refusal too — a bad token does not get retried', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    const req = withToken();
    expect(await checkAuth(req)).toBe(false);
    expect(await checkAuth(req)).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  // A VERDICT WE NEVER REACHED IS NOT A VERDICT. alt-coin checks before it
  // validates its params and sourceHandler checks again, so memoising a
  // transient 500 from the first hop 401'd a request whose second hop would
  // have succeeded.
  it('does not memoise an outage — the second call site gets a real answer', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return n === 1
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ id: TEST_OPERATOR_ID, email: 'op@pentagon.test' }) };
    });
    const req = withToken();
    expect(await checkAuth(req)).toBe(false);
    expect(await checkAuth(req)).toBe(true);
    expect(n).toBe(2);
  });

  it('still collapses concurrent checks on one request to a single round-trip', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: TEST_OPERATOR_ID, email: 'op@pentagon.test' }) }));
    const req = withToken();
    expect(await Promise.all([checkAuth(req), checkAuth(req), checkAuth(req), checkAuth(req)]))
      .toEqual([true, true, true, true]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not carry a verdict across requests', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: TEST_OPERATOR_ID, email: 'op@pentagon.test' }) }));
    expect(await checkAuth(withToken())).toBe(true);
    expect(await checkAuth(withToken())).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('degrades rather than throwing on something that is not a Request', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('should not be called'); });
    for (const bad of [null, undefined, 42, 'req', {}, { headers: {} }]) {
      expect(await checkAuth(bad)).toBe(false);
    }
  });
});

// The eight handlers that predate the Alts work and had no test for any of
// this. Six of them refuse an unauthenticated request before touching storage
// or an upstream; that is the property a shared auth change can silently break,
// and it is now pinned per handler rather than assumed from util.mjs.
describe('every checkAuth caller refuses an unauthenticated request first', () => {
  const realFetch = globalThis.fetch;
  let allowed;
  beforeEach(() => {
    BLOBS.clear();
    allowed = process.env.ALLOWED_EMAIL;
    useTestOperator();
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (allowed === undefined) delete process.env.ALLOWED_EMAIL; else process.env.ALLOWED_EMAIL = allowed;
  });

  const cases = [
    ['journal.mjs', '/api/journal'],
    ['settings.mjs', '/api/settings'],
    ['position.mjs', '/api/position'],
    ['candles.mjs', '/api/candles?symbol=MSTR'],
    ['status.mjs', '/api/status'],
    ['alt-watchlist.mjs', '/api/alt-watchlist'],
    ['alt-coin.mjs', '/api/alt-coin?id=solana&symbol=SOL'],
  ];

  it.each(cases)('%s answers 401 with no token, and spends nothing', async (file, path) => {
    const mod = await import(`../../functions/${file}`);
    const res = await mod.default(new Request(`https://pentagon.test${path}`), {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    // Not even the Supabase round-trip: there was no token to check. No
    // upstream, no Blobs write, nothing recorded against any source.
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(BLOBS.size).toBe(0);
  });

  it.each(cases)('%s answers 401 when Supabase refuses the token, not when it is merely slow', async (file, path) => {
    globalThis.fetch = upstreams({ authMs: 3500 });
    const mod = await import(`../../functions/${file}`);
    const { out: res } = await onFakeClock(() => mod.default(
      new Request(`https://pentagon.test${path}`, { headers: { authorization: 'Bearer t' } }), {},
    ));
    // 200, or a 502 from an upstream this stub cannot satisfy — anything but the
    // 401 a 3000ms cap used to produce on a token that was perfectly good.
    expect([200, 502]).toContain(res.status);
  });

  // journal.mjs is the representative for the boolean contract: it calls
  // checkAuth and unauthorized() directly and must keep behaving exactly as it
  // did, including on the outage path, because it was never given the richer
  // verdict and must not silently change shape.
  it('journal.mjs still 401s on a Supabase outage — the boolean contract is unchanged', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const res = await journalHandler(
      new Request('https://pentagon.test/api/journal', { headers: { authorization: 'Bearer t' } }), {},
    );
    expect(res.status).toBe(401);
  });

  it('journal.mjs serves a signed-in operator whose Supabase hop took 3.5s', async () => {
    globalThis.fetch = upstreams({ authMs: 3500 });
    const { out: res } = await onFakeClock(() => journalHandler(
      new Request('https://pentagon.test/api/journal', { headers: { authorization: 'Bearer t' } }), {},
    ));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ trades: [] });
  });
});

// sourceHandler is the one caller that CAN tell the two apart, and it is the
// one whose clients render the difference.
describe('sourceHandler separates "we refused you" from "we could not ask"', () => {
  const realFetch = globalThis.fetch;
  let allowed;
  beforeEach(() => {
    BLOBS.clear();
    allowed = process.env.ALLOWED_EMAIL;
    useTestOperator();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (allowed === undefined) delete process.env.ALLOWED_EMAIL; else process.env.ALLOWED_EMAIL = allowed;
  });
  const req = () => new Request('https://pentagon.test/api/alt-scan', { headers: { authorization: 'Bearer t' } });

  it('401s a token Supabase rejected', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    const res = await sourceHandler('probe_401', async () => ({ ok: 1 }))(req(), {});
    expect(res.status).toBe(401);
    expect(await healthOf('probe_401')).toBeNull();
  });

  it('503s with the reason when Supabase never answered, so a hiccup is not "your login expired"', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const res = await sourceHandler('probe_503', async () => ({ ok: 1 }))(req(), {});
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/auth check could not complete/);
    expect(body.retryable).toBe(true);
    // The SOURCE was never asked, so it is neither up nor down.
    expect(await healthOf('probe_503')).toBeNull();
  });
});

/* ---------------- a fresh cache hit is not evidence about an upstream ---------------- */

// The smaller sibling of the stale-serve lie: a fresh hit reached nothing and
// still recorded `ok: true, lastSuccessAt: now`, so /api/status reported the
// time a browser last polled us as the time we last reached CoinGecko.
describe('SOURCE_CACHED', () => {
  const realFetch = globalThis.fetch;
  let allowed;
  beforeEach(() => {
    BLOBS.clear();
    allowed = process.env.ALLOWED_EMAIL;
    useTestOperator();
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: TEST_OPERATOR_ID, email: 'op@pentagon.test' }) }));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (allowed === undefined) delete process.env.ALLOWED_EMAIL; else process.env.ALLOWED_EMAIL = allowed;
  });

  it('writes no health record at all — the previous one is the truth', async () => {
    const res = await sourceHandler('probe_cachehit', async () => ({ rows: 1, [SOURCE_CACHED]: true }))(
      new Request('https://pentagon.test/api/x', { headers: { authorization: 'Bearer t' } }), {},
    );
    expect(res.status).toBe(200);
    expect((await res.json()).rows).toBe(1);
    expect(await healthOf('probe_cachehit')).toBeNull();
  });

  it('never puts the marker on the wire', async () => {
    const res = await sourceHandler('probe_cachewire', async () => ({ a: 1, [SOURCE_CACHED]: true }))(
      new Request('https://pentagon.test/api/x', { headers: { authorization: 'Bearer t' } }), {},
    );
    expect(Object.keys(await res.json())).toEqual(['a', 'meta']);
  });

  it('alt-scan serves its fresh cache without touching alt_scan health', async () => {
    BLOBS.set('alt_scan_cache', {
      at: Date.now() - 5_000,
      payload: { universe: [{ id: 'x' }], degraded: [], sourceDetail: 'coingecko', asOf: Date.now() - 5_000 },
    });
    const res = await altScanHandler(authedGet('/api/alt-scan'), {});
    const body = await res.json();
    expect(body.cached).toBe(true);
    expect(body.stale).toBe(false);
    expect(await healthOf('alt_scan')).toBeNull();
    // one fetch: the auth check. Zero upstream calls.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

/* ---------------- the blobs the key change orphaned ---------------- */

describe('the pre-symbol alt_coin cache entries', () => {
  const realFetch = globalThis.fetch;
  let allowed;
  beforeEach(() => {
    BLOBS.clear();
    allowed = process.env.ALLOWED_EMAIL;
    useTestOperator();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (allowed === undefined) delete process.env.ALLOWED_EMAIL; else process.env.ALLOWED_EMAIL = allowed;
  });

  // Nothing lists them and nothing can read them, so they are storage that can
  // never be reclaimed. Cleared on the one pass that identifies them for free:
  // a request for a coin with no entry under the new key at all.
  it('are deleted the first time the new key misses, and not looked for again', async () => {
    BLOBS.set('alt_coin_solana', { at: Date.now(), payload: { legacy: true } });
    globalThis.fetch = upstreams({ fapiStatus: 400 });
    await onFakeClock(() => altCoinHandler(authedGet('/api/alt-coin?id=solana&symbol=SOL'), {}));
    expect(BLOBS.has('alt_coin_solana')).toBe(false);
    expect(BLOBS.has('alt_coin_solana_sol')).toBe(true);
  });
});
