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
vi.mock('@netlify/blobs', () => {
  const blobs = new Map();
  return {
    getStore: () => ({
      get: async (k) => (blobs.has(k) ? JSON.parse(JSON.stringify(blobs.get(k))) : null),
      setJSON: async (k, v) => { blobs.set(k, JSON.parse(JSON.stringify(v))); },
    }),
  };
});

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
  altCandles,
  altDerivs,
  altCoinMeta,
  altWatchGate,
  ALT_WATCH_SLOT_MS,
  ALT_WATCH_GATE_KEY,
  mergeDominanceSample,
  isDominanceRow,
  DOM_HISTORY_CAP,
} from '../alts.mjs';
import { sourceHandler, store, checkAuth, SOURCE_ERROR } from '../util.mjs';
import { validateWatchlist } from '../../functions/alt-watchlist.mjs';
import { coinCacheKey } from '../../functions/alt-coin.mjs';

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
    stub(404);
    expect(await altDerivs('SOL')).toBeNull();
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

// /api/alt-watch is a public path that costs two CoinGecko calls per hit
// against a keyless tier of ~10-30 calls/min. Unauthenticated, anyone who can
// reach the deploy holds that quota in 429 and pins the whole Alts tab on its
// stale cache — the four-calls-per-pass discipline defeated from outside the
// code that enforces it.
describe('altWatchGate', () => {
  const mkStore = () => {
    const blob = new Map();
    return {
      blob,
      get: async (k) => blob.get(k) ?? null,
      setJSON: async (k, v) => { blob.set(k, v); },
    };
  };
  const req = (method) => new Request('https://pentagon.test/api/alt-watch', method === 'GET'
    ? {}
    : { method, headers: { 'content-type': 'application/json' }, body: '{"next_run":"2026-07-31T20:00:00.000Z"}' });

  // Slot boundaries land on even UTC hours because 2h divides 24h and the epoch
  // starts at a UTC midnight — the same instants "0 */2 * * *" fires at.
  const slotTop = Math.floor(Date.UTC(2026, 6, 31, 18) / ALT_WATCH_SLOT_MS) * ALT_WATCH_SLOT_MS;

  it('turns away the bare GET a browser, a crawler or a curl sends', async () => {
    const g = await altWatchGate(req('GET'), mkStore(), slotTop + 60_000);
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/CoinGecko quota/);
  });

  it('lets the scheduler through — it cannot carry a token, and the row it writes is irreplaceable', async () => {
    const s = mkStore();
    const g = await altWatchGate(req('POST'), s, slotTop);
    expect(g).toMatchObject({ allowed: true, authed: false, scheduled: true });
    // Claimed before the caller spends a call, so a burst cannot all pass.
    expect(s.blob.get(ALT_WATCH_GATE_KEY)).toEqual({ slot: g.slot, at: slotTop });
  });

  it('admits one unauthenticated pass per cron slot and no more', async () => {
    const s = mkStore();
    expect((await altWatchGate(req('POST'), s, slotTop)).allowed).toBe(true);
    for (const offset of [1, 60_000, 45 * 60_000, ALT_WATCH_SLOT_MS - 1]) {
      const g = await altWatchGate(req('POST'), s, slotTop + offset);
      expect(g.allowed).toBe(false);
      expect(g.reason).toMatch(/already had its pass/);
    }
    expect((await altWatchGate(req('POST'), s, slotTop + ALT_WATCH_SLOT_MS)).allowed).toBe(true);
  });

  // THE PROPERTY THE SLOT EXISTS FOR. A "one pass per N minutes" limiter would
  // sit in front of the cron's own fire and starve the dominance series, which
  // is a worse outcome than the quota it protects — a day the sentinel does not
  // run is a day nothing can backfill. Slot-aligned, a forger can only ever
  // consume a slot the scheduler has already had.
  it('cannot be used to starve the cron of its own slot', async () => {
    const s = mkStore();
    const forgedAt = slotTop + 119 * 60_000; // one minute before the next fire
    expect((await altWatchGate(req('POST'), s, forgedAt)).allowed).toBe(true);
    expect((await altWatchGate(req('POST'), s, slotTop + ALT_WATCH_SLOT_MS)).allowed).toBe(true);
  });

  it('fails OPEN when Blobs is down, because the dominance row costs more than the quota', async () => {
    const broken = { get: async () => { throw new Error('blobs down'); }, setJSON: async () => { throw new Error('blobs down'); } };
    expect((await altWatchGate(req('POST'), broken, slotTop)).allowed).toBe(true);
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
    delete process.env.ALLOWED_EMAIL;
    // The Supabase session check, stubbed. No network in this suite.
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ email: 'op@pentagon.test' }) }));
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
