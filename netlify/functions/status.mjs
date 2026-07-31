// First-deploy diagnostic: live-pings every upstream and reports the Blobs
// health map. If a number on the cockpit looks wrong, this endpoint says
// which upstream to blame — facts before theories.
import { json, authVerdict, authRefusal, store, fetchWithTimeout } from '../shared/util.mjs'

const PROBES = [
  ['yahoo', 'https://query1.finance.yahoo.com/v8/finance/chart/MSTR?interval=1d&range=1d'],
  ['stooq', 'https://stooq.com/q/d/l/?s=mstr.us&i=d'],
  ['binance', 'https://api.binance.com/api/v3/ping'],
  ['coinbase', 'https://api.coinbase.com/v2/prices/BTC-USD/spot'],
  ['coingecko', 'https://api.coingecko.com/api/v3/ping'],
  // The Alts tab's other two hosts. Without them this endpoint could not answer
  // "which upstream to blame" for two of the feeds it is asked about: a dark
  // fear & greed gauge and a coin whose funding, open interest and positioning
  // are all missing looked identical to a CoinGecko problem, which is the one
  // host that was probed. fapi.binance.com is a SEPARATE host from api.binance
  // .com and fails separately — it is the one that answers 451 from a
  // datacenter IP while spot keeps working.
  ['alternative.me', 'https://api.alternative.me/fng/?limit=1'],
  ['binance-futures', 'https://fapi.binance.com/fapi/v1/ping'],
]

export default async (req) => {
  // THE DIAGNOSTIC ENDPOINT IS THE LAST ONE THAT SHOULD LIE ABOUT WHY IT SAID
  // NO. "If a number on the cockpit looks wrong, this endpoint says which
  // upstream to blame" — and when the thing to blame was Supabase being slow,
  // the answer used to be a 401 that reads as "your login expired". It now says
  // which of the two happened. See authVerdict in util.mjs.
  const verdict = await authVerdict(req)
  if (!verdict.ok) return authRefusal(verdict)

  const pings = {}
  await Promise.all(PROBES.map(async ([name, url]) => {
    const started = Date.now()
    try {
      const res = await fetchWithTimeout(url, { headers: { 'user-agent': 'Mozilla/5.0' } }, 2500)
      pings[name] = { ok: res.ok, httpStatus: res.status, latencyMs: Date.now() - started }
    } catch (e) {
      pings[name] = { ok: false, error: String(e?.message || e), latencyMs: Date.now() - started }
    }
  }))

  let sourceStatus = null
  let blobs = { ok: true }
  try {
    sourceStatus = (await store().get('source_status', { type: 'json' })) || {}
  } catch (e) {
    blobs = { ok: false, error: String(e?.message || e) }
  }

  return json({ pings, sourceStatus, blobs, meta: { fetchedAt: Date.now() } })
}
