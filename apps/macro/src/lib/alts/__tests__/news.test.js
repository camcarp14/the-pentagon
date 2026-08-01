// The "there is nothing here" states are SIX different claims, and this file's
// whole job is to keep them apart. A failed feed rendered as an empty section
// tells the reader nothing on their board is in the news, which is a
// measurement nobody took — the exact shape of the bug this repo already caught
// in the season score.
//
// It also pins the two things the reader must never be able to infer: that a
// mention is directional, and that a mention reordered the board.
//
// FIXTURES ARE THE ENDPOINT'S REAL SHAPE. netlify/shared/news.mjs's
// matchHeadlines() returns `{ matches, coins, skipped }` and alt-news.mjs wraps
// it with `items`, `coinsConsidered` and `degraded`; every payload below is
// that, so a drift in either half fails here rather than on screen.

import { describe, it, expect } from 'vitest'
import { altNewsRead } from '../news.js'

const NOW = 1_760_000_000_000
const H = 3_600_000

const row = (o = {}) => ({ id: 'solana', symbol: 'SOL', name: 'Solana', score: 70, band: 'starting', ...o })
const BOARD = [
  row(),
  row({ id: 'pepe', symbol: 'PEPE', name: 'Pepe', score: 40, band: 'quiet' }),
  row({ id: 'arbitrum', symbol: 'ARB', name: 'Arbitrum', score: 30, band: 'late' }),
]

const hit = (o = {}) => ({
  title: 'Solana network hits a new daily transaction record',
  url: 'https://example.com/a', source: 'coindesk', at: NOW - H,
  why: 'the full name "Solana" appears in this headline',
  basis: 'name', confidence: 'high', ...o,
})

/** The endpoint body, in its real shape. */
const feed = ({ items, matches = {}, coins = [], skipped = [], considered = 3, ...rest } = {}) => ({
  items: items ?? Object.values(matches).flat().map((h) => ({ title: h.title, url: h.url, source: h.source, at: h.at })),
  matches,
  coins,
  skipped,
  coinsConsidered: considered,
  coinSource: 'alt-scan cache + watchlist',
  degraded: [],
  sourceDetail: 'coindesk + cointelegraph',
  asOf: NOW,
  cached: false, stale: false, cacheAgeSec: 0,
  ...rest,
})

const named = (o = {}) => ({ symbol: 'SOL', id: 'solana', name: 'Solana', rank: 5, starred: false, count: 1, latestAt: NOW - H, confidence: 'high', ...o })

describe('the six empty states are six different sentences', () => {
  it('a FAILED feed says the feed failed and refuses to imply quiet', () => {
    const r = altNewsRead({ payload: null, rows: BOARD, error: 'HTTP 502', now: NOW })
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('no_feed')
    expect(r.reason).toMatch(/HTTP 502/)
    expect(r.reason).toMatch(/a feed that failed is not a feed that found nothing/)
    expect(r.coins).toEqual([])
  })

  it('a feed still in flight is not a feed that answered', () => {
    expect(altNewsRead({ payload: null, rows: BOARD, loading: true, now: NOW }).reason)
      .toMatch(/has not answered yet/)
  })

  it('an UNRECOGNISED shape names the keys it did find and the ones it needed', () => {
    const r = altNewsRead({ payload: { data: [], cursor: 'x' }, rows: BOARD, now: NOW })
    expect(r.kind).toBe('no_shape')
    expect(r.reason).toMatch(/top-level keys: data, cursor/)
    expect(r.reason).toMatch(/items, matches and coins/)
  })

  it('NO COIN LIST is its own state — the matcher could not look, so nothing is ruled out', () => {
    const r = altNewsRead({
      payload: feed({ items: [{ title: 'x', at: NOW }], considered: 0, degraded: ['the Alts board has not been loaded in this deploy and the watchlist is empty'] }),
      rows: BOARD, now: NOW,
    })
    expect(r.kind).toBe('no_coins')
    expect(r.reason).toMatch(/no coin list to check them against/)
    expect(r.reason).toMatch(/watchlist is empty/)
  })

  it('an EMPTY feed is a measurement and says so', () => {
    const r = altNewsRead({ payload: feed({ items: [] }), rows: BOARD, now: NOW })
    expect(r.kind).toBe('no_items')
    expect(r.reason).toMatch(/reading of the feed, not a failure to reach it/)
  })

  it('NO MATCH quotes both counts, so it reads as a comparison rather than a blank', () => {
    const r = altNewsRead({
      payload: feed({ items: [{ title: 'Bitcoin ETF flows', at: NOW }], matches: { BTC: [hit({ title: 'Bitcoin ETF flows' })] }, coins: [named({ symbol: 'BTC', id: 'bitcoin' })] }),
      rows: BOARD, now: NOW,
    })
    expect(r.kind).toBe('no_match')
    expect(r.reason).toMatch(/1 headline arrived and none of them names a coin on this board/)
    expect(r.reason).toMatch(/1 coin was named that this scan does not rank/)
    expect(r.reason).toMatch(/3 ranked rows/)
    expect(r.offBoard).toBe(1)
  })
})

describe('only coins on THIS board are surfaced', () => {
  it('drops a coin the endpoint named that this scan does not rank, and counts it', () => {
    const r = altNewsRead({
      payload: feed({
        matches: { SOL: [hit()], DOGE: [hit({ title: 'Dogecoin rallies', url: 'https://e.com/d' })] },
        coins: [named(), named({ symbol: 'DOGE', id: 'dogecoin', name: 'Dogecoin' })],
      }),
      rows: BOARD, now: NOW,
    })
    expect(r.ok).toBe(true)
    expect(r.coins.map((c) => c.row.symbol)).toEqual(['SOL'])
    expect(r.offBoard).toBe(1)
  })

  it('finds the row by CoinGecko id when the ticker arrives in a different case', () => {
    const r = altNewsRead({
      payload: feed({ matches: { sol: [hit()] }, coins: [named({ symbol: 'sol' })] }),
      rows: BOARD, now: NOW,
    })
    expect(r.ok).toBe(true)
    expect(r.coins[0].row).toBe(BOARD[0])
  })

  it('hands back the board’s own row object, untouched', () => {
    const r = altNewsRead({ payload: feed({ matches: { SOL: [hit()] }, coins: [named()] }), rows: BOARD, now: NOW })
    expect(r.coins[0].row).toBe(BOARD[0])
    expect(r.coins[0].row.band).toBe('starting')
  })

  it('drops a named coin whose headlines are all unusable rather than showing an empty row', () => {
    const r = altNewsRead({
      payload: feed({ items: [{ title: 'x', at: NOW }], matches: { SOL: [{ url: 'https://e.com/x' }, null, 7] }, coins: [named()] }),
      rows: BOARD, now: NOW,
    })
    expect(r.kind).toBe('no_match')
  })
})

describe('the matcher’s own refusals are surfaced, counted against THIS board', () => {
  it('counts the board rows the matcher would not even look for', () => {
    const r = altNewsRead({
      payload: feed({
        matches: { SOL: [hit()] },
        coins: [named()],
        skipped: [
          { symbol: 'ARB', id: 'arbitrum', name: 'Arbitrum', reason: 'ticker "ARB" is also a common English word' },
          { symbol: 'XYZ', id: 'xyz', name: 'Xyz', reason: 'too short' },   // not on this board
        ],
      }),
      rows: BOARD, now: NOW,
    })
    // ARB is on the board and was never looked for; XYZ is not this board's problem.
    expect(r.unmatchable).toBe(1)
  })

  it('reports zero unmatchable when the payload carries no skipped list at all', () => {
    const r = altNewsRead({ payload: feed({ matches: { SOL: [hit()] }, coins: [named()] }), rows: BOARD, now: NOW })
    expect(r.unmatchable).toBe(0)
  })
})

describe('a headline is attention, and this read refuses to make it anything else', () => {
  it('orders by RECENCY, not by the endpoint’s mention count', () => {
    const r = altNewsRead({
      payload: feed({
        items: Array.from({ length: 4 }, (_, i) => ({ title: `t${i}`, at: NOW })),
        matches: {
          PEPE: [hit({ title: 'p1', at: NOW - 20 * H, url: 'https://e.com/1' }), hit({ title: 'p2', at: NOW - 19 * H, url: 'https://e.com/2' }), hit({ title: 'p3', at: NOW - 18 * H, url: 'https://e.com/3' })],
          SOL: [hit({ title: 's1', at: NOW - H, url: 'https://e.com/4' })],
        },
        // The endpoint sends PEPE first: three mentions beats one.
        coins: [named({ symbol: 'PEPE', id: 'pepe', name: 'Pepe', count: 3, latestAt: NOW - 18 * H }), named({ count: 1, latestAt: NOW - H })],
      }),
      rows: BOARD, now: NOW,
    })
    expect(r.coins.map((c) => c.row.symbol)).toEqual(['SOL', 'PEPE'])
    expect(r.coins[1].n).toBe(3)
    expect(r.coins[1].items[0].title).toBe('p3')   // newest first inside a coin
  })

  it('publishes no sentiment, no direction and no score anywhere in the result', () => {
    const r = altNewsRead({ payload: feed({ matches: { SOL: [hit()] }, coins: [named()] }), rows: BOARD, now: NOW })
    const json = JSON.stringify(r).toLowerCase()
    for (const forbidden of ['sentiment', 'bullish', 'bearish', 'positive', 'negative']) {
      expect(json, `news must not publish "${forbidden}"`).not.toContain(forbidden)
    }
    expect(r.coins[0]).not.toHaveProperty('score')
  })

  it('carries the matcher’s `why` and its confidence grade through verbatim', () => {
    const r = altNewsRead({ payload: feed({ matches: { SOL: [hit()] }, coins: [named()] }), rows: BOARD, now: NOW })
    expect(r.coins[0].items[0].why).toBe('the full name "Solana" appears in this headline')
    expect(r.coins[0].items[0].confidence).toBe('high')
    expect(r.coins[0].confidence).toBe('high')
  })

  it('drops a confidence value it does not recognise instead of labelling with it', () => {
    const r = altNewsRead({
      payload: feed({ matches: { SOL: [hit({ confidence: 'certain' })] }, coins: [named({ confidence: 'certain' })] }),
      rows: BOARD, now: NOW,
    })
    expect(r.coins[0].items[0].confidence).toBeNull()
    expect(r.coins[0].confidence).toBeNull()
  })
})

describe('what reaches an anchor is validated on the last hop', () => {
  it('drops a non-http href rather than rendering a link that runs a script', () => {
    const r = altNewsRead({
      // eslint-disable-next-line no-script-url
      payload: feed({ matches: { SOL: [hit({ url: 'javascript:alert(1)' }), hit({ title: 'b', url: '/relative' })] }, coins: [named({ count: 2 })] }),
      rows: BOARD, now: NOW,
    })
    for (const it of r.coins[0].items) expect(it.url).toBeNull()
  })

  it('never throws on a malformed payload, whatever it is', () => {
    for (const junk of [null, undefined, 3, 'x', [], {}, { items: 1, matches: 2, coins: 3 }, { items: [], matches: [], coins: [] }]) {
      const r = altNewsRead({ payload: junk, rows: BOARD, now: NOW })
      expect(r.ok).toBe(false)
      expect(typeof r.reason).toBe('string')
      expect(r.reason.length).toBeGreaterThan(20)
    }
  })

  it('never throws on an empty or absent board', () => {
    for (const rows of [null, [], undefined]) {
      const r = altNewsRead({ payload: feed({ matches: { SOL: [hit()] }, coins: [named()] }), rows, now: NOW })
      expect(r.kind).toBe('no_match')
    }
  })
})

describe('ages come from the caller’s clock, never from the module’s', () => {
  it('computes an age against `now` and leaves it null when there is none', () => {
    const withNow = altNewsRead({ payload: feed({ matches: { SOL: [hit()] }, coins: [named()] }), rows: BOARD, now: NOW })
    expect(withNow.coins[0].items[0].ageMs).toBe(H)
    const without = altNewsRead({ payload: feed({ matches: { SOL: [hit()] }, coins: [named()] }), rows: BOARD })
    expect(without.coins[0].items[0].ageMs).toBeNull()
  })

  it('leaves an undated headline undated rather than stamping it now', () => {
    const r = altNewsRead({ payload: feed({ matches: { SOL: [hit({ at: null })] }, coins: [named({ latestAt: null })] }), rows: BOARD, now: NOW })
    expect(r.coins[0].items[0].publishedAt).toBeNull()
    expect(r.coins[0].items[0].ageMs).toBeNull()
  })
})

describe('the payload’s own health travels with the read', () => {
  it('carries stale, degraded and the source detail through to the caption', () => {
    const r = altNewsRead({
      payload: feed({ matches: { SOL: [hit()] }, coins: [named()], stale: true, degraded: ['cointelegraph: timeout'] }),
      rows: BOARD, now: NOW,
    })
    expect(r.stale).toBe(true)
    expect(r.degraded).toEqual(['cointelegraph: timeout'])
    expect(r.sourceDetail).toBe('coindesk + cointelegraph')
    expect(r.coinsConsidered).toBe(3)
  })
})
