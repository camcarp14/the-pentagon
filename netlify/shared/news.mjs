// Crypto headlines, and which coins they name. Same three rules as sources.mjs
// and alts.mjs:
//   - Parsers are PURE functions over raw upstream payloads → fixture-tested.
//   - Each fetcher throws on any failure; the caller degrades and says so.
//   - Every result names its source so the UI can say where a line came from.
//
// AND ONE RULE THIS FILE ADDS, WHICH IS THE WHOLE POINT OF IT:
//
//   NOTHING HERE MEASURES SENTIMENT, RELEVANCE OR CAUSATION, SO NOTHING HERE
//   MAY IMPLY ANY OF THE THREE. A headline that names a coin is evidence of
//   exactly one thing — that a publisher wrote about that coin — and every
//   string this module emits says that and stops. `why` quotes the literal text
//   that matched. `confidence` grades HOW SPECIFIC THE EVIDENCE IS (a six-letter
//   ticker is harder to hit by accident than a three-letter one), never how
//   bullish, how important, or how likely to move a price. There is no score
//   here and there must never be one, because there is no input to compute it
//   from: we read titles, not markets.
//
// WHY RSS. There is no news API key on this deploy and every free crypto-news
// API wants one, so keyless RSS/Atom is the only thing that actually works.
// CoinDesk and Cointelegraph both publish open feeds and are the two the
// operator already reads in Board Room's Wire, so they are the pair.
//
// WHY A HAND-ROLLED XML READER. No dependency is added for this. The parser
// below is deliberately tolerant rather than correct-by-spec: it scans for
// <item>/<entry> blocks by index, pulls a handful of known child tags out of
// each, and DROPS anything it cannot read instead of throwing. A feed that
// arrives truncated mid-item, double-entity-encoded, or with CDATA around half
// its titles is the normal case on the open web, and a strict parser turns each
// of those into an empty Alts panel.
import { attemptBudget } from './alts.mjs'

// Minimal user-agent, for the reason documented at length in sources.mjs: from
// a datacenter IP a full fake-Chrome UA without a browser TLS fingerprint is
// exactly what bot detection flags. Impersonate nothing; be a polite tool.
const UA = {
  'user-agent': 'Mozilla/5.0',
  accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
}

/**
 * The two feeds, and they are named constants because the response's
 * `sourceDetail` is built from this list — the UI can only say "from CoinDesk"
 * if the fetcher and the label come from the same place.
 */
export const FEEDS = Object.freeze([
  Object.freeze({ source: 'coindesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' }),
  Object.freeze({ source: 'cointelegraph', url: 'https://cointelegraph.com/rss' }),
])

/**
 * FIFTEEN MINUTES, AND IT IS A POLITENESS BUDGET, NOT A PERFORMANCE ONE.
 *
 * These are two publishers' free feeds and we have no contract with either. The
 * TTL is what bounds our hit rate on them: at 900s, N browser tabs, a phone and
 * a reload cost EIGHT requests an hour total (four each) instead of one per
 * poll per client. Both feeds sit behind a publisher CDN with cache lifetimes
 * in the same order of magnitude, so a tighter TTL would mostly re-fetch bytes
 * we already had.
 *
 * The product side agrees. CoinDesk and Cointelegraph publish on the order of
 * tens of items a day; the median gap between two stories is minutes, and this
 * panel answers "what has been written about these coins", not "what is the
 * price right now". A headline surfacing up to 15 minutes late costs the
 * operator nothing, because nothing here is an execution signal. Compare
 * alt-scan's 90s: that one caches PRICES, which decay in seconds.
 *
 * The cache holds the FETCHED ITEMS ONLY. Matching is re-run against the
 * current coin list on every request (see the handler), so starring a new coin
 * shows its headlines immediately rather than 15 minutes later — the thing with
 * a quota is the fetch, and it is the only thing cached.
 */
export const NEWS_TTL_SEC = 900

// How much of a feed body we are willing to read and scan. CoinDesk's Arc feed
// is a few hundred KB; anything past 3MB is not a feed we understand, and
// scanning it would spend the request's budget on nothing. Truncation is safe
// by construction: extractBlocks requires a CLOSING tag, so a half-written
// final item is dropped rather than half-read.
const MAX_FEED_CHARS = 3_000_000
// Per feed, then across both. The panel is a headline list, not an archive.
const MAX_ITEMS_PER_FEED = 30
export const MAX_ITEMS = 60
// A hard ceiling on block scanning so a pathological document cannot turn into
// an unbounded loop inside a function with a ~10s life.
const MAX_BLOCKS = 400

/* ================= parsers (pure, fixture-tested) ================= */

/**
 * Feed XML → items. NEVER THROWS. Garbage in gives `[]` out, and it is the
 * FETCHER that turns "zero usable items" into an error the chain can report —
 * same split as alts.mjs, where parseCoinGeckoMarkets drops bad rows and
 * altUniverse throws on an empty result.
 *
 * Handles RSS 2.0 (`<item>`, `<link>text</link>`, `<pubDate>`) and Atom
 * (`<entry>`, `<link href=…/>`, `<published>`/`<updated>`) because the two
 * publishers are free to switch and a panel that empties on a format change is
 * a panel nobody trusts again.
 *
 * DROPPED, DELIBERATELY: an item with no title, or with no absolute http(s)
 * link. A headline we cannot cite is a headline we cannot put on screen next to
 * a coin — the operator has to be able to click through and read the thing
 * before deciding it means anything. Same posture as parseCoinGeckoMarkets
 * dropping a coin it cannot price.
 *
 * `at` is epoch-ms or NULL. It is never defaulted to now: an item whose date we
 * could not read is an item of unknown age, and stamping it with the fetch time
 * would sort a month-old story to the top of a "what just happened" list.
 */
export function parseFeed(xml, { source = 'unknown', baseUrl = null, max = MAX_ITEMS_PER_FEED } = {}) {
  const raw = typeof xml === 'string' ? xml : ''
  if (!raw) return []
  const doc = raw.length > MAX_FEED_CHARS ? raw.slice(0, MAX_FEED_CHARS) : raw

  const blocks = [...extractBlocks(doc, 'item'), ...extractBlocks(doc, 'entry')]
  const items = []
  for (const block of blocks) {
    if (items.length >= max) break
    const title = cleanText(firstTagText(block, 'title'))
    if (!title) continue
    const url = linkOf(block, baseUrl)
    if (!url) continue
    items.push({ title, url, source, at: parseFeedDate(block) })
  }
  return items
}

/**
 * Scan for `<tag …>…</tag>` blocks by index rather than by regex.
 *
 * A regex over a multi-megabyte document with a lazy `[\s\S]*?` between two
 * literals is the shape that backtracks catastrophically on a malformed feed —
 * which is exactly the input this file promises not to die on. indexOf cannot.
 */
function extractBlocks(xml, tag) {
  const out = []
  const open = `<${tag}`
  const close = `</${tag}>`
  let i = 0
  while (out.length < MAX_BLOCKS) {
    const s = xml.indexOf(open, i)
    if (s === -1) break
    const gt = xml.indexOf('>', s + open.length)
    if (gt === -1) break
    // `<items>` must not match `<item`. The char right after the tag NAME has
    // to end the name.
    const after = xml[s + open.length]
    if (after !== '>' && after !== '/' && !isSpace(after)) { i = s + open.length; continue }
    // `<item/>` — a self-closing element has no children to read.
    if (xml[gt - 1] === '/') { i = gt + 1; continue }
    const e = xml.indexOf(close, gt + 1)
    // No closing tag: the document is truncated or malformed from here on. Drop
    // the remainder rather than guess where the item ended.
    if (e === -1) break
    out.push(xml.slice(gt + 1, e))
    i = e + close.length
  }
  return out
}

function isSpace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r'
}

/** Inner text of the first `<name>` child, or null. Same index scan, same
 *  reason. Namespaced variants are passed in explicitly by the caller. */
function firstTagText(block, name) {
  const open = `<${name}`
  const close = `</${name}>`
  let i = 0
  for (let guard = 0; guard < 20; guard++) {
    const s = block.indexOf(open, i)
    if (s === -1) return null
    const after = block[s + open.length]
    if (after !== '>' && after !== '/' && !isSpace(after)) { i = s + open.length; continue }
    const gt = block.indexOf('>', s + open.length)
    if (gt === -1) return null
    if (block[gt - 1] === '/') { i = gt + 1; continue }
    const e = block.indexOf(close, gt + 1)
    if (e === -1) return null
    return block.slice(gt + 1, e)
  }
  return null
}

/** The whole opening tag of the first `<name …>`, attributes included. */
function firstTagOpen(block, name) {
  const open = `<${name}`
  let i = 0
  for (let guard = 0; guard < 20; guard++) {
    const s = block.indexOf(open, i)
    if (s === -1) return null
    const after = block[s + open.length]
    if (after !== '>' && after !== '/' && !isSpace(after)) { i = s + open.length; continue }
    const gt = block.indexOf('>', s + open.length)
    if (gt === -1) return null
    return block.slice(s, gt + 1)
  }
  return null
}

/**
 * The item's canonical link. RSS puts it in `<link>text</link>`; Atom puts it in
 * `<link rel="alternate" href="…"/>`; some RSS feeds only carry a permalink
 * `<guid isPermaLink="true">`. All three are tried, and the result must be an
 * absolute http(s) URL — a relative or `javascript:` href is dropped, not
 * rendered.
 */
function linkOf(block, baseUrl) {
  const candidates = []
  const openTag = firstTagOpen(block, 'link')
  if (openTag) {
    const href = attrOf(openTag, 'href')
    if (href) candidates.push(href)
  }
  candidates.push(firstTagText(block, 'link'))
  candidates.push(firstTagText(block, 'guid'))
  candidates.push(firstTagText(block, 'id'))
  for (const c of candidates) {
    const url = absoluteHttpUrl(cleanText(c), baseUrl)
    if (url) return url
  }
  return null
}

function attrOf(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : null
}

/** http(s) only, resolved against the feed's own URL when one is supplied.
 *  Anything else — a relative path with no base, a mailto:, a javascript: —
 *  is not a link this panel will put under the operator's finger. */
export function absoluteHttpUrl(href, baseUrl = null) {
  const s = String(href || '').trim()
  if (!s) return null
  try {
    const u = baseUrl ? new URL(s, baseUrl) : new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

/**
 * RSS `pubDate` (RFC-822), Atom `published`/`updated`, Dublin Core `dc:date`.
 * Unreadable or absent → null, which the UI renders as "no date on this item".
 * Never `Date.now()`: see parseFeed.
 */
function parseFeedDate(block) {
  for (const tag of ['pubDate', 'published', 'updated', 'dc:date', 'date']) {
    const raw = cleanText(firstTagText(block, tag))
    if (!raw) continue
    const t = Date.parse(raw)
    if (Number.isFinite(t)) return t
  }
  return null
}

/**
 * CDATA off, entities decoded, markup stripped, whitespace collapsed.
 *
 * Order matters and the markup strip comes LAST on purpose: feeds routinely
 * arrive double-encoded (`&amp;#39;` for an apostrophe), so decoding runs twice
 * — and a second decode can turn `&amp;lt;b&amp;gt;` into real `<b>` tags,
 * which then have to be removed rather than shipped to a renderer. Two passes,
 * not a loop: a fixed bound cannot be walked into an entity bomb.
 */
export function cleanText(raw) {
  let s = String(raw ?? '')
  if (!s) return ''
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  s = decodeEntities(decodeEntities(s))
  // Conservative: a real tag starts with a letter or a slash. This leaves
  // "Bitcoin < $100 by 2027" alone, which a bare /<[^>]*>/ would eat.
  s = s.replace(/<\/?[a-zA-Z][^>]{0,300}>/g, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  mdash: '—', ndash: '–', hellip: '…', deg: '°', eacute: 'é',
}

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return whole
      try { return String.fromCodePoint(code) } catch { return whole }
    }
    const hit = NAMED_ENTITIES[body.toLowerCase()]
    return hit === undefined ? whole : hit
  })
}

/**
 * Newest first, unknown-date last, duplicates removed.
 *
 * Both publishers cover the same events, and the same story syndicated twice
 * would otherwise read as two independent mentions of a coin — which is
 * precisely the kind of inflation this panel must not do. Deduped on the URL
 * first, then on the normalised title, and the FIRST occurrence wins so the
 * source order in FEEDS is what breaks the tie deterministically.
 */
export function dedupeAndSort(items, cap = MAX_ITEMS) {
  const seenUrl = new Set()
  const seenTitle = new Set()
  const out = []
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it.title !== 'string' || typeof it.url !== 'string') continue
    const titleKey = it.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (seenUrl.has(it.url) || (titleKey && seenTitle.has(titleKey))) continue
    seenUrl.add(it.url)
    if (titleKey) seenTitle.add(titleKey)
    out.push(it)
  }
  out.sort((a, b) => {
    const at = Number.isFinite(a.at) ? a.at : null
    const bt = Number.isFinite(b.at) ? b.at : null
    if (at == null && bt == null) return 0
    if (at == null) return 1
    if (bt == null) return -1
    return bt - at
  })
  return out.slice(0, cap)
}

/* ================= the matcher (pure, fixture-tested) ================= */

/**
 * THE HARD PART, AND THE PART THAT DECIDES WHETHER THIS FEATURE IS USABLE.
 *
 * A watchlist full of false hits is strictly worse than no watchlist: the
 * operator cannot tell which rows are real without opening every headline, at
 * which point the panel has cost them time and told them nothing. So every rule
 * below is biased toward MISSING a real mention rather than inventing one, and
 * every coin the rules refuse to match is REPORTED (see `skipped`) instead of
 * silently sitting there looking like a coin nobody wrote about.
 *
 * The four ways naive matching fails, and the answer to each:
 *
 *   1. SUBSTRINGS.  "SOL" is inside "solution" and "console"; "ARB" is inside
 *      "arbitrary"; "TIA" is inside "initial". → Word-boundary matching only,
 *      via explicit lookaround on [A-Za-z0-9] so "$SOL", "SOL/USD" and "(SOL)"
 *      still hit while "SOLANA" and "SOLUSDT" do not.
 *
 *   2. CASE.  Tickers are written in caps; ordinary English is not. → Ticker
 *      matching is CASE-SENSITIVE, and specifically ALL-CAPS ONLY. This single
 *      rule is what kills "solution", "console" and "arbitrary" outright, and
 *      it is why the shouty-headline guard below exists: in an ALL-CAPS
 *      headline case carries no information at all, so the rule that was doing
 *      the work has stopped working.
 *
 *      TITLE CASE IS NOT AN OPTION, AND THIS IS THE REASON THE RULE IS THIS
 *      SHAPE. Both publishers write headlines in Title Case, which capitalises
 *      ordinary words: relaxing the ticker to also match "Sui" or "Ton" would
 *      immediately match "Bitcoin Hits a Ton of Resistance" for TON and "A Sol
 *      Eclipse" for SOL. So the only capitalisation this module trusts is the
 *      one Title Case cannot produce.
 *
 *      IT HAS A MEASURED COST AND IT IS ACCEPTED ON PURPOSE. A headline that
 *      names a short-named coin only in prose — "Aptos and Sui Split the
 *      Move-Language Developer Base" — is missed, because "Sui" is three
 *      characters (under MIN_NAME_TOKEN_LEN) and "Sui" is not "SUI". Measured
 *      against a hand-written 23-headline × 30-coin sample in the house style
 *      of both publishers: 18 true positives, 1 miss (that one), 0 false
 *      positives. The brief's ordering decides the trade — a watchlist the
 *      operator has to audit headline-by-headline is worth less than one that
 *      is quiet more often than it should be.
 *
 *   3. SHORT TICKERS.  "OP", "IP", "AI", "ID" match almost everything and
 *      cannot be rescued by any rule. → Under MIN_TICKER_LEN, never matched.
 *      Plus SYMBOL_STOPLIST for the three-letter English words and the
 *      finance/crypto acronyms that genuinely appear in caps in headlines
 *      (ETF, SEC, CEO, GAS, ALL, NEW, …).
 *
 *   4. NAMES THAT ARE ENGLISH.  A coin called Movement, Story or Grass matches
 *      ordinary prose; "Near Protocol" matches "prices near protocol upgrade".
 *      → A name matches only as its FULL text, never one token of it; a name
 *      whose every token is a common English word does not match at all; and a
 *      ONE-WORD name has to clear the extra bar described directly below.
 *
 * RULE 4 USED TO BE A BLOCKLIST AND THAT WAS THE BUG. Until this was fixed, a
 * single-token name matched ordinary prose case-insensitively whenever the word
 * happened to be missing from COMMON_WORDS — so Core, Maker, Verge, Stacks,
 * Compound and Render all lit up on ordinary sentences, and every one of them
 * was graded `high` because a name match is the strongest evidence this module
 * has. An adversarial 20-hit sample measured 7 false positives (65% precision),
 * all of them this. A hand-written word list cannot carry English; it will
 * always be one word short, and the word it is short of becomes a confident
 * wrong row.
 *
 * SO THE BURDEN IS INVERTED. A one-word name is trusted on its own only when it
 * is POSITIVELY KNOWN not to be English — either it is on PROPER_COIN_NAMES, a
 * vetted list of coined names, or it ends in an unmistakable crypto suffix
 * (…coin, …swap, …chain, …dao). Every other one-word name is WEAK: it still
 * matches, but only as corroboration alongside its own ticker in the same
 * headline, never by itself.
 *
 * The direction of failure is the whole point. Under the old rule an unknown
 * word produced a false positive; under this one it produces a miss. A coin
 * this module has never heard of cannot invent a row, and a row that appears
 * is one the operator can trust without opening the link to check.
 *
 * The cost is real and is stated rather than hidden: coins whose ticker is
 * stoplisted and whose name is ordinary English (Story/IP, Movement/MOVE when
 * shouty) cannot be matched by this module, and they come back in `skipped`
 * with the reason. That is the honest shape — "we did not look for this one,
 * here is why" — and it is what makes every row that DOES appear trustworthy.
 */
export const MIN_TICKER_LEN = 3
export const MIN_NAME_TOKEN_LEN = 4

/**
 * Tickers that are never matched, even in a mixed-case headline.
 *
 * Two groups, and both are field-shaped rather than theoretical:
 *   • ACRONYMS that appear in caps in ordinary crypto/finance copy — ETF, SEC,
 *     CEO, IPO, DAO, NFT, ATH, APY, TVL, DEX, KYC, CPI, FED, USD. Several of
 *     these are also live tickers somewhere on the board; matching them would
 *     put "SEC Delays Spot ETF Decision" under three different coins.
 *   • THREE-LETTER ENGLISH WORDS. Case-sensitivity does not save these: caps
 *     are used for emphasis, and three letters is short enough that a single
 *     stray hit poisons a whole column.
 *
 * The known losses are accepted deliberately and named here so nobody
 * rediscovers them as a bug: ONE (Harmony), GAS (Gas), SUN (Sun), ICE and TOP
 * are real listings that this module will not match. Each of them is reported
 * in `skipped` with the reason, so the screen says so.
 *
 * NOT on this list, on purpose: TON, ETC, UNI, VET, LINK, NEAR, MOVE, CORE,
 * SAFE, FLOW, SAND, MASK, GRASS. Those are four-or-more characters or rare
 * enough in caps that case-sensitivity does the job in a normal headline — and
 * COMMON_WORDS below still blocks every one of them in a SHOUTY one.
 */
export const SYMBOL_STOPLIST = new Set((
  'ETF SEC CEO CFO COO CTO IPO IRS DOJ FBI ECB IMF GDP CPI PPI FED DAO NFT API ATH ATL ' +
  'APY APR TVL DEX CEX KYC AML ICO IDO IEO TGE FUD USA USD EUR GBP JPY CNY KRW CHF INR ' +
  'ADD AGE AGO AIR ALL AND ANY ARE ART ASK BAD BAG BAN BAR BET BIG BID BOX BOY BUS BUY ' +
  'CAN CAP CAR CUP CUT DAY DID DOG EAT END EYE FAR FEE FEW FIT FLY FOR FUN GAS GET GOT ' +
  'GUN HAS HAT HER HIS HIT HOT HOW ICE ILL ITS JOB JOY KEY KID LAB LAW LED LEG LET LIE ' +
  'LOT LOW MAN MAP MAY MEN MIX NEW NET NOT NOW ODD OFF OIL OLD ONE OUR OUT OWE OWN PAY ' +
  'PEN PER PIE PIG PIT POP POT PUT RAW RED ROW RUN SAD SAY SEA SEE SET SHE SIT SIX SKY ' +
  'SON SUN TAG TAX TEA TEN THE TIE TIP TOO TOP TOY TRY TWO USE VAN WAR WAS WAY WEB WHO ' +
  'WHY WIN YES YET YOU ZIP'
).split(' '))

/**
 * Ordinary English, used for two different refusals:
 *   • a SINGLE-WORD coin name in here never matches by name (Movement, Story,
 *     Grass, Move, Link, Near);
 *   • a MULTI-WORD name whose every token is in here never matches either
 *     ("Near Protocol" against "prices near protocol upgrade");
 *   • and a TICKER whose lowercase form is in here never matches in a SHOUTY
 *     headline, where case-sensitivity has stopped protecting anything.
 *
 * It is a word list, not a dictionary: the ~700 commonest English words plus the
 * vocabulary that actually shows up in financial headlines. It does not need to
 * be exhaustive to be useful — every word in it is one fewer way to be wrong,
 * and the tickers it guards are already guarded by case in a normal headline.
 */
export const COMMON_WORDS = new Set((
  'a about above across act add after again against age ago air all almost alone along already also ' +
  'although always among an and another answer any anyone anything appear are area around art as ask at ' +
  'available back bad bag balance bank bar base be because become been before begin behind being believe ' +
  'below best bet better between big bill billion bit board body book both box boy break bring build bull ' +
  'business but buy by call can cannot cap capital car card care case cash catch cause cent center central ' +
  'chain chance change charge chart check chief child choose city claim class clear close coin cold come ' +
  'company control cost could count country course court cover create crypto cup cut data day deal death ' +
  'debt decide deep demand did die digital do does dog dollar down drive drop due during each early earn ' +
  'ease east easy eat economy edge effort eight either election end enough enter entire etc even ever every ' +
  'exchange expect eye face fact fail fair fall family far fast fear federal fee feel few field fight file ' +
  'fill final find fine fire firm first fit five fix flat floor flow fly focus follow food foot for force ' +
  'form former forward found four free friend from front full fun fund future gain game gas gave general ' +
  'get give global go gold gone good got government graph grass great green ground group grow growth gun ' +
  'had half hand happen hard has hat have he head health hear heart heavy held help her here high him his ' +
  'hit hold home hope hot hour house how however huge human hundred idea if impact important in include ' +
  'income increase index industry inside into invest is issue it its job join joint jump just keep key kid ' +
  'kill kind know known lab land large last late later law lay lead leader learn least leave led left legal ' +
  'less let level life light like limit line link list little live loan local lock long look loss lot love ' +
  'low made main major make man many map mark market mass matter may me mean meet member men might mile ' +
  'military million mind mine minute miss mix model money month moon more morning most mother move movement ' +
  'much music must my name nation national near need net network never new news next night nine no none nor ' +
  'north not note nothing now number of off offer office official often oil old on once one only open ' +
  'opinion option or order other our out outside over own pace page paid pair part party pass past pay peak ' +
  'pen people per perhaps period person pick pie place plan plant play please point policy pool poor pop ' +
  'popular position possible post pound power press price private probably problem process produce product ' +
  'program project property protocol prove provide public pull push put quality question quick quite race ' +
  'raise range rate rather raw reach read ready real reason record red reduce reform refuse region relate ' +
  'release remain remember remove report request require research result return reveal rich ride right rise ' +
  'risk river road rock role roll room root round row rule run safe said sale salt same sand save saw say ' +
  'scale scene school science score sea search season seat second section sector see seek seem sell send ' +
  'sense series serious serve service session set settle seven several shall shape share she sheet shift ' +
  'ship shop short shot should show side sign signal similar simple since single sit site situation six ' +
  'size skill sky sleep slow small smart snap so social soft soil sold solid some son song soon sort sound ' +
  'source south space speak special speed spend spot spread spring staff stage stand standard star start ' +
  'state station stay step stick still stock stop store story straight strategy street strike strong ' +
  'structure study stuff style subject success such sudden suffer suggest summer sun super supply support ' +
  'sure surface surprise survey swap switch system table tag take talk target task tax teach team tech ' +
  'technology tell ten term test text than thank that the their them then theory there these they thing ' +
  'think third this those though thought thousand three through throw thus tie time tiny tip title to today ' +
  'together token tomorrow ton tone too took top total touch toward town trade traffic train transfer ' +
  'travel treat tree trend trial trip true trust truth try turn twelve twenty two type under understand ' +
  'union unit until up upon us usd use user usual value van various very view village visit vote wait walk ' +
  'wall want war warm was watch water wave way we wealth wear web week weight welcome well went were west ' +
  'what when where whether which while white who whole whom whose why wide wife will win wind window wine ' +
  'wing winter wire wise wish with within without woman women wonder wood word work world worry worth would ' +
  'write wrong yard year yes yesterday yet you young your zone ' +
  // Crypto-press vocabulary that is now ordinary English in these two feeds.
  // These are here for the SUFFIX rule below more than for prose: "memecoin"
  // and "stablecoin" end in -coin and would otherwise be waved through as
  // obviously-coined names, when they are the most ordinary words in the
  // corpus. Also blocks a coin literally named Airdrop or Mainnet.
  'airdrop altcoin blockchain burn defi delist exploit fork hack liquidity ' +
  'mainnet memecoin mint miner mining nft rally stablecoin stake staking ' +
  'testnet treasury upgrade validator wallet whale yield'
).split(' '))

/**
 * ONE-WORD COIN NAMES THAT ARE POSITIVELY NOT ENGLISH.
 *
 * The allowlist half of rule 4. Read its header first — this list exists
 * because the blocklist half could not be made to work, and the ONLY property
 * every entry has to have is "this is not a word, and not a proper noun that
 * turns up in ordinary news copy". It is not a list of important coins, it is
 * not ranked, and adding a coin to it is not an endorsement of the coin.
 *
 * WHAT IS DELIBERATELY ABSENT, because leaving a coin out costs a missed
 * headline while putting it in costs a wrong one:
 *   • plain English words that happen to be tickers — Compound, Maker, Render,
 *     Stacks, Verge, Core, Beam, Flow, Curve, Osmosis, Helium, Optimism,
 *     Polygon, Avalanche, Cosmos, Stellar, Ripple, Immutable, Injective,
 *     Harmony, Sandbox, Gala, Flux, Saga, Grass, Movement, Story;
 *   • real people and places — Trump, Melania, Brett, Jupiter, Babylon,
 *     Merlin, Terra, Luna, Juno, Komodo. "Trump" in particular appears in
 *     these two feeds most days for reasons that have nothing to do with a
 *     token;
 *   • Greek letters and maths — Theta, Zeta, Ergo.
 * Every one of those is still matched by its TICKER, which is where the
 * evidence actually is. This list only decides whether the NAME alone counts.
 */
export const PROPER_COIN_NAMES = new Set((
  'bitcoin ethereum tether solana dogecoin cardano tron chainlink litecoin polkadot toncoin ' +
  'hedera hyperliquid aptos cronos monero algorand arbitrum filecoin bittensor ethena kaspa ' +
  'celestia starknet worldcoin zcash tezos iota qtum lisk digibyte horizen decred zilliqa ' +
  'ravencoin siacoin nervos kadena arweave akash elrond multiversx kusama moonbeam moonriver ' +
  'astar acala phala klaytn kaia oasys metis gnosis celo taiko zksync linea manta dymension ' +
  'altlayer eigenlayer berachain monad fantom vechain stratis chiliz enjin decentraland ' +
  'illuvium aave uniswap sushiswap pancakeswap synthetix dydx loopring thorchain kava pendle ' +
  'morpho frax lido ondo raydium jito pyth livepeer audius iotex ankr celer cartesi storj ' +
  'renzo ethfi bittorrent numeraire singularitynet arkham kujira evmos elastos aeternity ' +
  'tellor alephium firo dero zano nosana aethir rootstock bouncebit steem peercoin namecoin ' +
  'vertcoin pepe dogwifhat popcat wojak fartcoin pengu moodeng goatseus neiro ponke myro ' +
  'nakamoto satoshi'
).split(' '))

/**
 * Endings no English word this module cares about has, which is what lets a
 * coin nobody has vetted still carry its own name.
 *
 * The suffix has to be UNMISTAKABLE, so the list is four entries and stops. The
 * English words that end in these — coin, swap, chain, blockchain, keychain,
 * memecoin, stablecoin, altcoin — are either shorter than the guard below or
 * sitting in COMMON_WORDS, which is checked first.
 */
const COINED_SUFFIXES = ['coin', 'swap', 'chain', 'dao']

/** Is this one-word name safe to match on its own? Pure, exported for tests. */
export function isCoinedWord(token) {
  const t = String(token ?? '').toLowerCase()
  if (!t || COMMON_WORDS.has(t)) return false
  if (PROPER_COIN_NAMES.has(t)) return true
  // At least three characters of the name have to be the coin's own, so "coin",
  // "swap" and "chain" standing alone are not waved through by their own suffix.
  return COINED_SUFFIXES.some((s) => t.length >= s.length + 3 && t.endsWith(s))
}

/**
 * IS CASE CARRYING ANY INFORMATION IN THIS HEADLINE?
 *
 * Rule 2 above — tickers are caps, English is not — is the load-bearing rule of
 * the whole matcher, and it evaporates the moment a publisher writes a headline
 * in block capitals: "SEC DELAYS ALL SPOT ETF DECISIONS" contains ALL, SPOT and
 * ETF as literal uppercase words and would light up three coins.
 *
 * So: a headline with enough letters to judge and essentially no lowercase is
 * SHOUTY, and in a shouty headline a ticker that is also an ordinary English
 * word is refused. Tickers that are not words (SOL, AVAX, DOGE, BTC) still
 * match, because nothing about them got more ambiguous.
 *
 * The 12-letter floor keeps a legitimately short all-caps title — "BTC ETF" —
 * from being classed as shouting.
 */
export function isShouty(title) {
  const letters = String(title ?? '').match(/[A-Za-z]/g)
  if (!letters || letters.length < 12) return false
  let lower = 0
  for (const c of letters) if (c >= 'a' && c <= 'z') lower++
  return lower / letters.length < 0.15
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Explicit boundaries rather than \b. \b counts `_` as a word character, so
// "SOL_USD" would not match; these do match it, and still refuse "SOLANA",
// "SOLUSDT" and "1SOL". Written out so the boundary rule is readable rather
// than inherited from a shorthand.
const L = '(?<![A-Za-z0-9])'
const R = '(?![A-Za-z0-9])'

/**
 * Can this ticker be matched at all? Pure; returns the compiled rule or the
 * reason there isn't one. The reason string is user-facing — it ends up in
 * `skipped` on the wire.
 */
export function tickerRule(symbol) {
  const sym = String(symbol ?? '').trim().toUpperCase()
  if (!sym) return { ok: false, reason: 'no ticker on this coin' }
  if (!/^[A-Z0-9]+$/.test(sym)) {
    return { ok: false, reason: `ticker "${sym}" is not plain letters and digits, so it cannot be matched on a word boundary` }
  }
  if (sym.length < MIN_TICKER_LEN) {
    return { ok: false, reason: `ticker "${sym}" is under ${MIN_TICKER_LEN} characters — too short to match without hitting ordinary words` }
  }
  if (SYMBOL_STOPLIST.has(sym)) {
    return { ok: false, reason: `ticker "${sym}" is also a common English word or a finance acronym, so it is never matched` }
  }
  return {
    ok: true,
    symbol: sym,
    // No `i` flag. Case-sensitivity is rule 2 and it is the whole defence.
    re: new RegExp(`${L}${escapeRe(sym)}${R}`),
    wordish: COMMON_WORDS.has(sym.toLowerCase()),
  }
}

/**
 * Can this NAME be matched, and as what phrase? Pure. Full text only — one
 * token of a multi-word name is never enough ("Inu" must not match Shiba Inu).
 *
 * Three outcomes, not two:
 *   { ok: false, reason }              never matched, and the reason is shown
 *   { ok: true,  weak: false, … }      matches on its own
 *   { ok: true,  weak: true,  … }      matches ONLY alongside its own ticker
 *
 * The third is the fix described in the block comment above. A one-word name
 * that is not positively known to be coined still gets compiled — it is real
 * evidence when the ticker is sitting next to it — but headlineMatch will not
 * let it stand alone, so "Compound Interest Rates Fall" cannot become a row
 * under COMP while "Compound (COMP) Cuts Its Rate" still can.
 */
export function nameRule(name) {
  const cleaned = String(name ?? '')
    // "Bridged USDC (Polygon PoS)" → "Bridged USDC". Parentheticals are venue
    // and bridge annotations, not how anyone writes the coin in a sentence.
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return { ok: false, reason: 'no name on this coin' }
  if (cleaned.length > 60) return { ok: false, reason: `name "${cleaned.slice(0, 40)}…" is too long to match as a phrase` }

  const tokens = cleaned.split(' ').filter(Boolean).slice(0, 6)
  if (!tokens.length) return { ok: false, reason: 'no name on this coin' }

  const lower = tokens.map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ''))
  if (lower.every((t) => !t)) return { ok: false, reason: `name "${cleaned}" has no matchable text in it` }

  // "Near Protocol", "The Graph", "First Digital" — every token is ordinary
  // English, so the phrase itself is ordinary English and matching it matches
  // prose. This is the rule that stops "prices near protocol upgrade".
  if (lower.every((t) => !t || COMMON_WORDS.has(t))) {
    return { ok: false, reason: `name "${cleaned}" is made only of common English words, so matching it would match ordinary prose` }
  }

  let weak = false
  let weakReason = null
  if (tokens.length === 1) {
    const t = lower[0]
    if (t.length < MIN_NAME_TOKEN_LEN) {
      return { ok: false, reason: `name "${cleaned}" is a single word under ${MIN_NAME_TOKEN_LEN} characters — too short to match safely` }
    }
    // The inverted burden. Not "is this word English?" — which needs a
    // dictionary this deploy does not have — but "is this word known NOT to be
    // English?", which a vetted list can actually answer.
    if (!isCoinedWord(t)) {
      weak = true
      weakReason = `name "${cleaned}" is a single word that could be ordinary English, so it is only counted when the ticker appears in the same headline`
    }
  }

  // Flexible separators so "Shiba Inu" matches "Shiba-Inu" too. Case-insensitive
  // is safe here precisely because the phrase is long and specific, which is the
  // property the rules above just verified.
  const pattern = tokens.map(escapeRe).join('[\\s\\-]+')
  return { ok: true, phrase: cleaned, weak, weakReason, re: new RegExp(`${L}${pattern}${R}`, 'i') }
}

/**
 * Coin → the compiled rules used against every headline. Pure. Exported so the
 * caller can compile once for N items instead of N times, and so a test can
 * assert on the refusal reasons directly.
 */
export function compileCoin(coin) {
  const symbol = String(coin?.symbol ?? '').trim().toUpperCase()
  const name = String(coin?.name ?? '').trim()
  const ticker = tickerRule(symbol)
  const nm = nameRule(name)
  // A WEAK name is not usable on its own — it can only corroborate a ticker, so
  // a coin whose ticker is refused and whose name is weak can never produce a
  // row and has to be REPORTED rather than sitting on the board looking like a
  // coin nobody wrote about.
  const usable = ticker.ok || (nm.ok && !nm.weak)
  return {
    id: typeof coin?.id === 'string' ? coin.id : null,
    symbol,
    name,
    rank: Number.isFinite(coin?.rank) ? coin.rank : null,
    starred: coin?.starred === true,
    ticker: ticker.ok ? ticker : null,
    nameMatch: nm.ok ? nm : null,
    usable,
    // Both halves refused → say both reasons. One sentence, both facts, no
    // shrug: this is the string the panel shows next to a coin it did not look
    // for, and "not matched" without a reason is the neutral default this repo
    // does not ship. A weak name reports the WEAK reason, not "no name" — the
    // difference is the whole finding, and the screen has to be able to say it.
    reason: usable ? null : `${ticker.reason}; ${nm.ok ? nm.weakReason : nm.reason}`,
  }
}

/**
 * Does this headline name this coin? Pure, and the single place the answer is
 * decided. Returns null or `{ basis, confidence, why }`.
 *
 * `basis` is the EVIDENCE: 'name+ticker' | 'name' | 'ticker'.
 * `confidence` grades how specific that evidence is and NOTHING ELSE — see the
 * header. 'high' means the matched text is long or doubly-attested enough that
 * an accidental hit is implausible; 'medium' means a bare three-character
 * ticker, which is the shortest thing this module will match at all.
 */
export function headlineMatch(title, coinOrCompiled) {
  const c = coinOrCompiled && 'usable' in coinOrCompiled ? coinOrCompiled : compileCoin(coinOrCompiled)
  const text = String(title ?? '')
  if (!text || !c.usable) return null

  const shouty = isShouty(text)
  // In a shouty headline case proves nothing, so a ticker that is also an
  // English word is refused there and only there. See isShouty.
  const tickerHit = !!(c.ticker && !(shouty && c.ticker.wordish) && c.ticker.re.test(text))
  const nameHit = !!(c.nameMatch && c.nameMatch.re.test(text))

  if (nameHit && tickerHit) {
    return {
      basis: 'name+ticker',
      confidence: 'high',
      why: `the name "${c.nameMatch.phrase}" and the ticker "${c.ticker.symbol}" both appear in this headline`,
    }
  }
  // THE GATE. A weak one-word name standing alone is not evidence — it is a
  // word. Fall through to the ticker test, which will also miss, and the coin
  // correctly does not appear. See nameRule.
  if (nameHit && !c.nameMatch.weak) {
    return {
      basis: 'name',
      confidence: 'high',
      why: `the full name "${c.nameMatch.phrase}" appears in this headline`,
    }
  }
  if (tickerHit) {
    return {
      basis: 'ticker',
      // Four characters and up is specific enough that a stray hit is
      // implausible; three is the floor this module allows and is graded as
      // such rather than being quietly presented as the same thing.
      confidence: c.ticker.symbol.length >= 4 ? 'high' : 'medium',
      why: `the ticker "${c.ticker.symbol}" appears as a standalone word in this headline`,
    }
  }
  return null
}

/**
 * Every headline against every coin. Pure — no clock, no network, no Blobs — so
 * the whole product decision in this file is fixture-testable.
 *
 * Returns:
 *   matches  { [SYMBOL]: [{ title, url, source, at, why, basis, confidence }] }
 *            in the order the items were given (newest first, see dedupeAndSort)
 *   coins    [{ symbol, id, name, rank, starred, count, latestAt, confidence }]
 *            the "coins in the news" list, ranked by how many headlines named
 *            them, then by recency, then by market-cap rank. Ranking is a SORT
 *            over counts we actually made — there is no score.
 *   skipped  [{ symbol, name, id, reason }] — coins the rules refused to look
 *            for, each with the reason. Never silent.
 */
export function matchHeadlines(items, coins) {
  const list = Array.isArray(items) ? items : []
  const compiled = []
  const skipped = []
  const bySymbol = new Map()

  for (const raw of Array.isArray(coins) ? coins : []) {
    const c = compileCoin(raw)
    if (!c.symbol) {
      skipped.push({ symbol: null, name: c.name || null, id: c.id, reason: 'no ticker on this coin' })
      continue
    }
    // Two coins on the board can carry the same ticker. Keying `matches` by
    // symbol would silently merge their headlines under one row, so the
    // better-known one (starred first, then lower market-cap rank) is kept and
    // the other is REPORTED as skipped rather than folded in.
    const prev = bySymbol.get(c.symbol)
    if (prev) {
      const loser = betterCoin(prev, c) === prev ? c : prev
      const winner = loser === prev ? c : prev
      if (winner !== prev) {
        bySymbol.set(c.symbol, c)
        const i = compiled.indexOf(prev)
        if (i >= 0) compiled[i] = c
      }
      skipped.push({
        symbol: loser.symbol,
        name: loser.name || null,
        id: loser.id,
        reason: `two coins on this board use the ticker "${loser.symbol}" — headlines are attributed to ${winner.name || winner.symbol}`,
      })
      continue
    }
    bySymbol.set(c.symbol, c)
    if (!c.usable) {
      skipped.push({ symbol: c.symbol, name: c.name || null, id: c.id, reason: c.reason })
      continue
    }
    compiled.push(c)
  }

  const matches = {}
  const stats = new Map()
  for (const item of list) {
    if (!item || typeof item.title !== 'string') continue
    for (const c of compiled) {
      const hit = headlineMatch(item.title, c)
      if (!hit) continue
      const row = {
        title: item.title,
        url: typeof item.url === 'string' ? item.url : null,
        source: typeof item.source === 'string' ? item.source : null,
        at: Number.isFinite(item.at) ? item.at : null,
        why: hit.why,
        basis: hit.basis,
        confidence: hit.confidence,
      }
      ;(matches[c.symbol] ||= []).push(row)
      const s = stats.get(c.symbol) || { coin: c, count: 0, latestAt: null, high: false }
      s.count++
      if (Number.isFinite(item.at) && (s.latestAt == null || item.at > s.latestAt)) s.latestAt = item.at
      if (hit.confidence === 'high') s.high = true
      stats.set(c.symbol, s)
    }
  }

  const ranked = [...stats.values()]
    .map((s) => ({
      symbol: s.coin.symbol,
      id: s.coin.id,
      name: s.coin.name || null,
      rank: s.coin.rank,
      starred: s.coin.starred,
      count: s.count,
      latestAt: s.latestAt,
      // The strongest evidence behind any of this coin's headlines. Still a
      // statement about the MATCH, never about the news.
      confidence: s.high ? 'high' : 'medium',
    }))
    .sort((a, b) => (
      b.count - a.count
      || (b.latestAt ?? -Infinity) - (a.latestAt ?? -Infinity)
      || (a.rank ?? Infinity) - (b.rank ?? Infinity)
      || a.symbol.localeCompare(b.symbol)
    ))

  return { matches, coins: ranked, skipped }
}

function betterCoin(a, b) {
  if (a.starred !== b.starred) return a.starred ? a : b
  const ar = a.rank ?? Infinity
  const br = b.rank ?? Infinity
  if (ar !== br) return ar < br ? a : b
  return a
}

/* ================= where the coin list comes from (pure) ================= */

/**
 * The coins to match against, out of alt-scan's OWN Blobs cache.
 *
 * ZERO EXTRA COINGECKO CALLS, and that is the point. alts.mjs opens with the
 * quota rule — the keyless tier is 10-30 calls/min and alt-scan's header pins
 * its endpoint at exactly four upstream calls because every one of them is
 * multiplied by every polling client. A news panel that fetched its own
 * 250-coin universe would be a fifth call on the same quota, spent on data that
 * is already sitting in Blobs from the board the operator is looking at.
 *
 * The coupling is deliberate and it is one-directional: this reads a cache
 * alt-scan writes, and reads it DEFENSIVELY — an absent, empty or reshaped
 * payload produces an empty list and a stated reason, never a throw and never a
 * silent zero. If alt-scan's cache shape ever changes, this panel says "no coin
 * list available" out loud instead of quietly matching nothing.
 */
export function coinsFromScanCache(cachedPayload) {
  const universe = cachedPayload?.universe
  if (!Array.isArray(universe) || !universe.length) return []
  const out = []
  for (const r of universe) {
    if (!r || typeof r !== 'object') continue
    const symbol = String(r.symbol ?? '').trim().toUpperCase()
    const name = String(r.name ?? '').trim()
    if (!symbol && !name) continue
    out.push({
      id: typeof r.id === 'string' ? r.id : null,
      symbol,
      name,
      rank: Number.isFinite(r.rank) ? r.rank : null,
      starred: false,
    })
  }
  return out
}

/** The operator's starred coins, out of the alt_watchlist blob that
 *  alt-watchlist.mjs writes. Same defensive read. */
export function coinsFromWatchlist(saved) {
  const ids = saved?.ids
  if (!Array.isArray(ids) || !ids.length) return []
  const out = []
  for (const e of ids) {
    if (!e || typeof e !== 'object') continue
    const symbol = String(e.symbol ?? '').trim().toUpperCase()
    const name = String(e.name ?? '').trim()
    if (!symbol && !name) continue
    out.push({ id: typeof e.id === 'string' ? e.id : null, symbol, name, rank: null, starred: true })
  }
  return out
}

/**
 * Watchlist first, then the board, deduped by CoinGecko id and then by ticker.
 *
 * Watchlist entries win the dedupe so a starred coin keeps `starred: true` and
 * the operator's own spelling of the name — but it inherits the board's
 * market-cap rank when the board has one, because rank is a measured number and
 * the watchlist does not carry it.
 *
 * `cap` bounds the matcher's work: MAX_COINS × MAX_ITEMS regex tests per
 * request, and a request that has to run 250 × 60 of them still finishes in
 * single-digit milliseconds. It exists so an unbounded blob cannot become an
 * unbounded loop.
 */
export function mergeCoinSources(watchlist, universe, cap = 300) {
  const out = []
  const byId = new Map()
  const bySymbol = new Map()
  const limit = Math.max(0, Math.floor(cap) || 0)

  const add = (c) => {
    if (out.length >= limit) return
    const idKey = c.id ? c.id.toLowerCase() : null
    const symKey = c.symbol || null
    if (idKey && byId.has(idKey)) return
    if (!idKey && symKey && bySymbol.has(symKey)) return
    if (idKey) byId.set(idKey, c)
    if (symKey && !bySymbol.has(symKey)) bySymbol.set(symKey, c)
    out.push(c)
  }

  for (const c of Array.isArray(watchlist) ? watchlist : []) add(c)
  for (const c of Array.isArray(universe) ? universe : []) {
    const idKey = c.id ? c.id.toLowerCase() : null
    const held = idKey ? byId.get(idKey) : null
    if (held) {
      // Backfill the one field the watchlist genuinely does not have.
      if (held.rank == null && c.rank != null) held.rank = c.rank
      if (!held.name && c.name) held.name = c.name
      continue
    }
    add(c)
  }
  return out
}

/* ================= fetchers (each one throws) ================= */

/**
 * One controller across the handshake AND the body, for the reason alts.mjs
 * spells out: util.mjs's fetchWithTimeout clears its timer when the headers
 * land, so a stream that stalls mid-body is an unbounded wait wearing a 200.
 * A feed body is the exact shape that happens to.
 */
async function getFeedText(url, timeoutMs) {
  const host = new URL(url).host
  const ctl = new AbortController()
  // Names whose clock ran out, same as alts.mjs: "timeout after 900ms" reads as
  // the publisher being down when the 900 was OUR remaining budget.
  const t = setTimeout(
    () => ctl.abort(new Error(`${host} did not answer inside the ${timeoutMs}ms this request had left for it`)),
    timeoutMs,
  )
  try {
    const res = await fetch(url, { headers: UA, redirect: 'follow', signal: ctl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`)
    const declared = Number(res.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > MAX_FEED_CHARS) {
      throw new Error(`${host} sent ${declared} bytes, past the ${MAX_FEED_CHARS}-byte cap for a feed`)
    }
    return await res.text()
  } finally {
    clearTimeout(t)
  }
}

/** One feed. Throws on transport failure AND on a body with no usable items —
 *  a 200 carrying an error page is a failed fetch, and the chain has to see it
 *  as one or the panel reports a healthy source with nothing in it. */
export async function fetchFeed(feed, { deadlineAt = null, perAttemptMs = 4000 } = {}) {
  const ms = attemptBudget(perAttemptMs, deadlineAt)
  if (ms == null) {
    throw new Error(`${feed.source}: skipped — the request's time budget was spent before this hop could be tried`)
  }
  const xml = await getFeedText(feed.url, ms)
  const items = parseFeed(xml, { source: feed.source, baseUrl: feed.url })
  if (!items.length) throw new Error(`${feed.source}: answered, but no readable items were in the feed`)
  return { items, source: feed.source }
}

/**
 * Both feeds, in PARALLEL, and either one alone is a usable answer.
 *
 * Not a fallback chain: these are two publishers, not two mirrors of one
 * dataset, so a CoinDesk outage does not make Cointelegraph's headlines less
 * true. One failure costs coverage and adds a line to `degraded` naming the
 * publisher and the error; BOTH failing throws, which is what lets the handler
 * fall back to its labelled stale cache instead of showing an empty panel that
 * looks like a quiet news day.
 *
 * `sourceDetail` is built from the feeds that actually answered — never from
 * the list we intended to read.
 */
export async function fetchAltNews({ deadlineAt = null } = {}) {
  const results = await Promise.allSettled(FEEDS.map((f) => fetchFeed(f, { deadlineAt })))
  const items = []
  const degraded = []
  const reached = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      items.push(...r.value.items)
      reached.push(FEEDS[i].source)
    } else {
      degraded.push(`${FEEDS[i].source}: ${String(r.reason?.message || r.reason || 'unknown error')}`)
    }
  })
  if (!reached.length) throw new Error(`alt news: no feed answered — ${degraded.join(' | ')}`)
  return { items: dedupeAndSort(items, MAX_ITEMS), degraded, sourceDetail: reached.join(' + ') }
}
