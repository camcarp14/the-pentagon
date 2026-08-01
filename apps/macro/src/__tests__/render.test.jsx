// Macro (Torque) on the shared kit — proved, not asserted.
//
// The build does not prove it. `vite build` was green on a component that threw
// "nodeR is not defined" the moment it mounted, and took three tools down.
// react-dom/server executes the whole component body in plain Node — no jsdom
// needed, and this repo has none — so a restyle that broke a reference, a prop
// or a hook fails here.
//
// WHAT IS RENDERED, AND WHY IT IS App AND NOT Root:
// Root.jsx is the shell's mount entry. It returns null until a Supabase session
// resolves in an effect, and effects do not run under renderToStaticMarkup, so
// rendering it cold proves exactly nothing. App.jsx is the component that owns
// the markup — including the data-kit opt-in — so that is what gets rendered.
//
// Macro keeps all four tab panels mounted (drafts survive tab switches), so a
// cold render contains the Chart, Journal and Settings surfaces in full. The
// Cockpit is the one panel that is skeletons at t=0, because its own loading
// gate fires before any data arrives — the trade card and the stat tiles are
// therefore checked against the source, and the reason is noted at each.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App, { DEFAULT_TAB } from "../App.jsx";
import AltsPanel from "../components/alts/AltsPanel.jsx";
import AltBoard from "../components/alts/AltBoard.jsx";
import CoinDetail from "../components/alts/CoinDetail.jsx";
import SeasonCard from "../components/alts/SeasonCard.jsx";
import SinceCard from "../components/alts/SinceCard.jsx";
import { api, API_TIMEOUT_MS } from "../lib/api.js";
import { sparkPoints, sparkDirection } from "../components/alts/sparkline.jsx";
import { screenCoin, screenUniverse } from "../lib/alts/screen.js";
import { seasonRead } from "../lib/alts/season.js";
import { boardSnapshot, boardDelta } from "../lib/alts/pulse.js";
import { freshness } from "../lib/freshness.js";

const warnings = [];
let realWarn, realErr;
beforeAll(() => {
  realWarn = console.warn; realErr = console.error;
  const cap = (...a) => {
    const m = String(a[0] ?? "");
    if (/useLayoutEffect does nothing on the server/.test(m)) return;
    warnings.push(m);
  };
  console.warn = cap; console.error = cap;
});
afterAll(() => { console.warn = realWarn; console.error = realErr; });

// `embedded` is how the shell mounts it; the standalone token gate is a
// separate branch and gets its own case below.
const html = () => renderToStaticMarkup(createElement(App, { embedded: true }));

describe("Macro renders on the kit", () => {
  it("renders at all", () => {
    expect(() => html()).not.toThrow();
  });

  it("opts into the kit on its own root", () => {
    // On Macro's outermost element and nowhere higher. It renders inside the
    // shell's tool slot, so this reaches this app only — the same rule the
    // shell follows by keeping data-kit off the wrapper that holds every tool.
    expect(html()).toMatch(/^<div data-kit/);
  });

  it("uses the kit's primitives in the markup it renders cold", () => {
    const out = html();
    for (const cls of [
      'class="card pad-md"',      // the kit's card + its padding class
      'class="ttl t-label"',      // the one class allowed to be uppercase
      'class="seg" role="tablist"',  // the chart's MSTR/BTC switch
      'class="seg-opt active"',   //   … its options, not `.seg button.on`
      'class="sk sk-line w40"',   // skeletons
      'class="empty-title"',      // empty states
      'class="empty-sub"',
      'class="btn sm quiet"',     // the kit's neutral button
    ]) {
      expect(out, `expected the kit's ${cls}`).toContain(cls);
    }
    // and nothing may still be selecting the segment the old way
    expect(out).not.toMatch(/<div class="seg"[^>]*>\s*<button[^>]*class="on"/);
  });

  it("mounts the Alts tab cold, FIRST in the nav and first in the document", () => {
    // All five panels stay mounted in this app, so the Alts panel's body runs on
    // every cold render whether or not the tab is selected — which is exactly
    // the coverage this file exists for. At t=0 it is skeletons, because its
    // scan has not landed; the tab button and the panel wrapper prove it is
    // wired, and the fixture renders below prove the body.
    const out = html();
    expect(out).toContain('aria-label="Alts"');
    expect(out).toContain('data-testid="alts-panel"');
    // Alts, then cockpit, then chart — in the NAV…
    expect(out.indexOf('aria-label="Alts"')).toBeLessThan(out.indexOf('aria-label="Cockpit"'));
    expect(out.indexOf('aria-label="Cockpit"')).toBeLessThan(out.indexOf('aria-label="Chart"'));
    // …and in the DOCUMENT, which is the order a screen reader and a keyboard
    // walk. Every panel stays mounted, so a nav that reads Alts-first over a
    // document that reads Cockpit-first is two answers to "what is this tab".
    // The chart's replay toggle is the anchor because the cockpit is skeletons
    // at t=0 and has no testid of its own to sit between them; the panel ORDER
    // itself is read off the source below.
    expect(out.indexOf('data-testid="alts-panel"')).toBeLessThan(out.indexOf('data-testid="replay-toggle"'));
    const panels = [...stripComments(read("App.jsx")).matchAll(/<TabPanel active=\{tab === '(\w+)'\}/g)].map((m) => m[1]);
    expect(panels).toEqual(["alts", "cockpit", "chart", "journal", "settings"]);
  });

  it("LANDS on Alts, and takes the landing tab from the nav's own order", () => {
    // The tab that is NOT hidden is the one the app opened on. `hidden` is
    // TabPanel's own attribute, so this reads the real landing state rather than
    // the constant that is supposed to produce it.
    const out = html();
    const alts = out.indexOf('data-testid="alts-panel"');
    const before = out.slice(0, alts).lastIndexOf("<div");
    expect(out.slice(before, alts), "the Alts panel is not the visible one at t=0")
      .not.toMatch(/hidden/);
    // …and a second literal cannot drift from the array: the default IS TABS[0].
    expect(DEFAULT_TAB).toBe("alts");
    const src = stripComments(read("App.jsx"));
    expect(src, "the landing tab must be derived from TABS, not typed again")
      .toMatch(/export const DEFAULT_TAB = TABS\[0\]\.id/);
    expect(src).toMatch(/useState\(DEFAULT_TAB\)/);
    expect(src, "no tab id may be typed into useState")
      .not.toMatch(/useState\('cockpit'\)/);
  });

  it("moves the palette's 'home' vocabulary with the landing tab", () => {
    // ⌘K builds its entries from TABS, so 'Go to Alts' leads the list for free.
    // The KEYWORDS are the part that had to move by hand: 'home' and 'dash' sat
    // on cockpit because cockpit was where the app opened, and leaving them
    // there would make typing "home" into the palette go somewhere that is not.
    const src = stripComments(read("App.jsx"));
    const kw = /const TAB_KEYWORDS = \{([\s\S]*?)\n\}/.exec(src);
    expect(kw, "TAB_KEYWORDS moved or was renamed").toBeTruthy();
    const alts = /alts:\s*\[([^\]]*)\]/.exec(kw[1])[1];
    const cockpit = /cockpit:\s*\[([^\]]*)\]/.exec(kw[1])[1];
    for (const w of ["'home'", "'dash'"]) {
      expect(alts, `${w} belongs to the landing tab`).toContain(w);
      expect(cockpit, `${w} must not still match two tabs`).not.toContain(w);
    }
    // and the palette still builds itself from TABS rather than five literals
    expect(src).toMatch(/\.\.\.TABS\.map\(\(t\) => \(\{ label: `Go to \$\{t\.label\}`/);
  });

  it("renders the chart panel's real content, not just its shell", () => {
    // Proof that the cold render is actually executing component bodies rather
    // than bailing out early everywhere: the Chart tab has no loading gate, so
    // its empty state and its controls are fully built here.
    const out = html();
    expect(out).toContain("No candle history from any source");
    expect(out).toContain('data-testid="replay-toggle"');
  });

  it("emits no NaN and no literal 'undefined' into markup", () => {
    const out = html();
    expect(out).not.toMatch(/NaN/);
    expect(out).not.toMatch(/(style|class)="[^"]*undefined/);
  });

  it("renders without a React warning", () => {
    html();
    const react = warnings.filter((w) => !w.startsWith("[@cc/"));
    expect(react, `React warned:\n${react.join("\n")}`).toEqual([]);
  });
});

/* ── the Alts tab, rendered against fixtures ──────────────────────────────────
 *
 * The cold App render proves the panel is wired and reaches its skeleton gate.
 * It cannot prove the board, the season card or the detail pane, because at t=0
 * none of them have data — and those are precisely the bodies where an
 * undefined reference ships green and blanks the tab in production. So they are
 * rendered here against payloads shaped exactly like /api/alt-scan and
 * /api/alt-coin, which is the only kind of fixture available: the sandbox proxy
 * 403s every crypto host, and a test that needs the network is not a test.  */

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);
const DAY = 86_400_000;

/** A rising-then-resting hourly series, 168 points, like sparkline_in_7d. */
const spark = (base, gain) =>
  Array.from({ length: 168 }, (_, i) => base * (1 + (gain * i) / 167 + Math.sin(i / 9) * 0.004));

const row = (over = {}) => ({
  id: "x", symbol: "X", name: "Coin X", image: null, rank: 1,
  price: 1, mcap: 1e9, fdv: 1.2e9, vol24h: 1e8,
  chg1h: 0.2, chg24h: 1.5, chg7d: 4, chg14d: 6, chg30d: 9, chg1y: 40,
  ath: 3, athChangePct: -55, athDate: "2024-03-14T00:00:00.000Z", atl: 0.2, atlChangePct: 400,
  circulating: 1e9, totalSupply: 1e9, maxSupply: null,
  sparkline7d: spark(1, 0.04),
  ...over,
});

const UNIVERSE = [
  row({ id: "bitcoin", symbol: "BTC", name: "Bitcoin", rank: 1, price: 96_400, mcap: 1.9e12, vol24h: 4.2e10, chg24h: 0.8, chg7d: 2.1, chg30d: 5.4, sparkline7d: spark(96_000, 0.02) }),
  row({ id: "ethereum", symbol: "ETH", name: "Ethereum", rank: 2, price: 3_420, mcap: 4.1e11, vol24h: 1.8e10, chg24h: 1.9, chg7d: 6.4, chg30d: 11.2, sparkline7d: spark(3_300, 0.06) }),
  row({ id: "solana", symbol: "SOL", name: "Solana", rank: 5, price: 184.22, mcap: 8.7e10, vol24h: 5.1e9, chg24h: 6.2, chg7d: 14.8, chg30d: 22.5, sparkline7d: spark(160, 0.15) }),
  row({ id: "pepe", symbol: "PEPE", name: "Pepe", rank: 31, price: 0.0000122, mcap: 5.1e9, vol24h: 9.4e8, chg24h: 11.4, chg7d: 26.1, chg30d: 41.9, sparkline7d: spark(0.0000098, 0.24) }),
  row({ id: "some-micro", symbol: "MICRO", name: "Micro Thing", rank: 240, price: 0.0413, mcap: 6.2e7, vol24h: 90_000, chg24h: -2.1, chg7d: -8.4, chg30d: -19.2, sparkline7d: spark(0.05, -0.08) }),
  // Both must be screened OUT: a stablecoin posts perfect turnover on a flat
  // return, and a wrapper is a receipt for something already on the board.
  row({ id: "tether", symbol: "USDT", name: "Tether", rank: 3, price: 1, mcap: 1.4e11, vol24h: 9e10, chg24h: 0.01, chg7d: 0.02, chg30d: -0.01 }),
  row({ id: "wrapped-bitcoin", symbol: "WBTC", name: "Wrapped Bitcoin", rank: 14, price: 96_300, mcap: 1.3e10, vol24h: 3e8, chg24h: 0.8, chg7d: 2.0, chg30d: 5.3 }),
];

const SCAN_PAYLOAD = {
  universe: UNIVERSE,
  global: { btcDominancePct: 54.2, ethDominancePct: 11.8, totalMcapUsd: 3.4e12, totalVol24hUsd: 1.1e11, mcapChange24hPct: 1.4 },
  fearGreed: { value: 62, label: "Greed", at: Math.round(NOW / 1000) },
  trending: [{ id: "solana", symbol: "SOL", name: "Solana", rank: 1, mcapRank: 5 }],
  domHistory: null,          // day one of the cron: the trend must read 'unknown'
  degraded: ["trending: HTTP 429"],
  sourceDetail: "coingecko + alternative.me",
  cached: true, stale: false, cacheAgeSec: 12,
  asOf: NOW,
};

const src = (data, over = {}) => ({
  data, error: null, fetchedAt: NOW, loading: false, reload: () => {}, ...over,
});

const SETTINGS = { equity: 100_000, riskPct: 1, maxPositionPct: 30, stopMode: "atr", atrMult: 2.5, stopPct: 8 };

const WATCHLIST = src({ watchlist: { ids: [{ id: "solana", symbol: "SOL", name: "Solana", addedAt: NOW - DAY, note: "" }], updatedAt: NOW - DAY } });

const panel = (over = {}) =>
  renderToStaticMarkup(createElement(AltsPanel, {
    scan: src(SCAN_PAYLOAD), watchlistSrc: WATCHLIST, settings: SETTINGS, now: NOW, ...over,
  }));

/** Daily OHLCV with three deliberate ignitions, so the precedent read has a
 *  sample to count instead of only its refusal path. */
function candles(n = 520) {
  const out = [];
  let p = 10;
  for (let i = 0; i < n; i++) {
    const pumping = [120, 260, 400].some((s) => i >= s && i < s + 20);
    p *= pumping ? 1.035 : 1 + Math.sin(i / 7) * 0.004 - 0.0004;
    out.push({
      t: Math.round((NOW - (n - 1 - i) * DAY) / 1000),
      o: p * 0.996, h: p * 1.025, l: p * 0.975, c: p,
      v: 1e6 * (1 + (pumping ? 4 : 0) + Math.abs(Math.sin(i / 11))),
    });
  }
  return out;
}

const SOL = UNIVERSE[2];
const COIN_PAYLOAD = {
  id: "solana", symbol: "SOL",
  candles: candles(), candleQuality: "ohlcv", candleSource: "binance klines",
  binanceSymbol: "SOLUSDT", priceMultiplier: 1,
  coin: {
    id: "solana", symbol: "sol", name: "Solana", categories: ["Smart Contract Platform"],
    community: { sentimentUpPct: 81, redditSubs: 220_000, redditActive48h: 640, redditPosts48h: 9, twitterFollowers: 2_600_000, telegram: null, watchlistUsers: 1_100_000 },
  },
  derivs: {
    symbol: "SOLUSDT", priceMultiplier: 1, markPrice: 184.4,
    lastFundingRate: 0.00021, nextFundingTime: NOW + 3 * 3_600_000,
    openInterest: Array.from({ length: 30 }, (_, i) => ({ t: Math.round((NOW - (29 - i) * DAY) / 1000), oi: 1e6 * (1 + i / 60), oiValueUsd: 1.8e8 * (1 + i / 60) })),
    globalLongShort: Array.from({ length: 30 }, (_, i) => ({ t: Math.round((NOW - (29 - i) * DAY) / 1000), ratio: 2.1, longPct: 68, shortPct: 32 })),
    topLongShort: Array.from({ length: 30 }, (_, i) => ({ t: Math.round((NOW - (29 - i) * DAY) / 1000), ratio: 1.05, longPct: 51, shortPct: 49 })),
    degraded: [], sourceDetail: "binance futures SOLUSDT",
  },
  degraded: [], sourceDetail: "binance klines + coingecko meta", asOf: NOW,
};

const detail = (over = {}) => {
  const season = seasonRead({
    universe: UNIVERSE, btcRow: UNIVERSE[0], ethRow: UNIVERSE[1],
    global: SCAN_PAYLOAD.global, fearGreed: SCAN_PAYLOAD.fearGreed,
    trending: SCAN_PAYLOAD.trending, domHistory: null, now: NOW,
  });
  const screened = screenCoin(SOL, { btcRow: UNIVERSE[0], ethRow: UNIVERSE[1], season, now: NOW });
  return renderToStaticMarkup(createElement(CoinDetail, {
    sel: { id: "solana", symbol: "SOL", name: "Solana" },
    payload: COIN_PAYLOAD, loading: false, error: null,
    onRetry: () => {}, onBack: () => {},
    screened, season, settings: SETTINGS,
    freshScan: { state: "live", ageSec: 12, label: "12s ago" },
    freshCoin: { state: "live", ageSec: 3, label: "3s ago" },
    fearGreed: SCAN_PAYLOAD.fearGreed, trendingRank: 1, trendingChecked: true,
    starred: true, onToggleWatch: () => {}, saving: false,
    ...over,
  }));
};

describe("The Alts tab renders against a real payload shape", () => {
  it("renders the season answer, the dashboard layer, the board and the shortlist", () => {
    const out = panel();
    expect(out).toContain('data-testid="season-card"');
    expect(out).toContain('data-testid="alt-board"');
    expect(out).toContain("Solana");
    // the watched coin's star is lit, from the watchlist source and not local state
    expect(out).toContain('aria-label="Remove SOL from the watchlist"');

    // THE LAYER THAT WAS MISSING, and it is BETWEEN the regime and the list.
    // The tab used to be a season card, four tiles and a hundred flat rows: the
    // top of the screen stated a regime and the rest was an undifferentiated
    // list with nothing joining them.
    for (const id of ["alt-since", "alt-shape", "alt-leaders"]) {
      expect(out, `missing ${id}`).toContain(`data-testid="${id}"`);
    }
    const at = (id) => out.indexOf(`data-testid="${id}"`);
    expect(at("season-card")).toBeLessThan(at("alt-since"));
    expect(at("alt-since")).toBeLessThan(at("alt-shape"));
    expect(at("alt-shape")).toBeLessThan(at("alt-board"));

    // The right-hand pane is no longer a permanent instruction occupying half a
    // desktop screen. What it says instead is computed from this scan.
    expect(out, "the placeholder must be gone").not.toContain("Pick a coin");
    expect(out).toContain("Where to look first");
    expect(out).toMatch(/\d+ of \d+ actionable/);
    // …and the instruction it replaced survives, demoted to one line.
    expect(out).toMatch(/opens that coin.{0,8}s directive/);
  });

  it("groups the board by band, with the count and the meaning of each group", () => {
    // A flat ranked list makes you scroll past the extended and dead rows to
    // reach the next igniting one, and igniting is the state the tool exists to
    // catch. The heading carries screen.js's own rule in words, from pulse.js's
    // single copy of it — a group that only sorts is not grouping with meaning.
    const out = panel();
    const heads = [...out.matchAll(/<div class="alt-group"[\s\S]{0,400}?<\/div><\/div>/g)].map((m) => m[0]);
    expect(heads.length, "the board rendered no band groups at all").toBeGreaterThan(1);
    for (const h of heads) {
      expect(h, `a group heading with no band pill:\n${h}`).toMatch(/class="alt-band b-\w+"/);
      expect(h, `a group heading with no count:\n${h}`).toMatch(/class="alt-group-n num">\d+</);
      expect(h, `a group heading with no meaning:\n${h}`).toMatch(/class="alt-group-sub">\w[^<]{20,}</);
    }
    // and the actionable band leads the board, ahead of the ones you scroll past
    const order = [...out.matchAll(/class="alt-band b-(\w+)"[^>]*>[^<]*<\/span><span class="alt-group-n/g)].map((m) => m[1]);
    expect(order.length).toBeGreaterThan(1);
    expect(order.indexOf("dead") === -1 || order.indexOf("dead") === order.length - 1,
      `dead is not last in the group order: ${order}`).toBe(true);
  });

  it("makes the distribution a control, not just a picture", () => {
    // The strip has no text, so the chips under it are its legend AND the
    // fastest route from "eleven are igniting" to the eleven rows. Both surfaces
    // write ONE filter — the chip row and the board's Show select — so the tab
    // can never be filtered to a band while the select still reads "All coins".
    const out = panel();
    expect(out).toMatch(/class="alt-dist"/);
    expect(out).toMatch(/class="alt-dist-seg seg-\w+"/);
    const chips = [...out.matchAll(/<button[^>]*class="alt-chip band-(\w+)[^"]*"[^>]*>/g)].map((m) => m[1]);
    expect(chips.length, "no band chips rendered").toBeGreaterThan(1);
    // every chip names a band that the select can also reach — one control, two skins
    const options = [...out.matchAll(/<option value="(\w+)"/g)].map((m) => m[1]);
    for (const c of chips) expect(options, `the Show select cannot reach band ${c}`).toContain(c);
    expect(out).toMatch(/<optgroup label="Band">/);
    // the filter itself lives above the board, so both surfaces share it
    const src = stripComments(read("components/alts/AltsPanel.jsx"));
    expect(src, "the board's filter must be lifted, or the chips are a second copy of it")
      .toMatch(/const \[filter, setFilter\] = useState\('all'\)/);
    expect(src).toMatch(/onPickBand=\{setFilter\}/);
    expect(src).toMatch(/filter=\{filter\}/);
  });

  it("says there is no earlier board rather than reporting a quiet market", () => {
    // THE STATE THIS SHIPS IN, and the one that has to be unmistakable. Rendered
    // in Node there is no localStorage, so no baseline exists — and "nothing
    // changed" and "there is nothing to compare against" are opposite claims
    // that render as the same blank strip unless something forces them apart.
    const out = panel();
    expect(out).toContain("Since you last looked");
    expect(out).toContain("No comparison yet");
    expect(out).toMatch(/no earlier board stored in this browser/);
    expect(out, "a refusal must not be dressed as a measured zero").not.toMatch(/Nothing moved/);
  });

  it("says the alt-share line needs seven stored days, in season.js’s own words", () => {
    // domHistory is null on day one of the cron, exactly as the season card's
    // dominance tile already reports. The chart refuses in the same shape rather
    // than drawing a flat line off no readings.
    const out = panel();
    expect(out).toContain("Alt share of total cap");
    expect(out).toMatch(/0 of 7 days needed/);
    expect(out, "no chart may be drawn off an absent series").not.toMatch(/class="alt-sharechart/);
  });

  it("draws the alt-share line once the cron has enough days, and says what it is not", () => {
    const domHistory = Array.from({ length: 12 }, (_, i) => ({
      d: new Date(NOW - (11 - i) * DAY).toISOString().slice(0, 10),
      btcDom: 56 - i * 0.3, ethDom: 12, totalMcap: 3.4e12,
    }));
    const out = panel({ scan: src({ ...SCAN_PAYLOAD, domHistory }) });
    expect(out).toMatch(/class="alt-sharechart dir-up"/);
    expect(out).toMatch(/\+3\.30 points rising across 11 days · 12 readings/);
    // It is ALT SHARE and it does not claim to be breadth. Breadth is not stored
    // anywhere, so a breadth history would have to be invented.
    const shape = out.slice(out.indexOf('data-testid="alt-shape"'));
    expect(shape.slice(0, shape.indexOf("</section>")), "the stored series must not be called breadth")
      .not.toMatch(/breadth/i);
  });

  it("renders a real diff, with one line per coin at its most important change", () => {
    // The panel cannot hold a baseline in Node, so the card is driven directly
    // from pulse.js's own output — which is the same object the panel passes it.
    const rows = (over) => screenUniverse(UNIVERSE.map((r) => ({ ...r, ...(over[r.id] ?? {}) })),
      { btcRow: UNIVERSE[0], ethRow: UNIVERSE[1], now: NOW });
    const before = boardSnapshot(rows({ solana: { chg24h: -1, chg7d: -3 } }), { asOf: NOW - 3 * 3600_000 });
    const after = boardSnapshot(rows({}), { asOf: NOW });
    const delta = boardDelta(before, after);
    expect(delta.ok, "the fixture produced no diff to render").toBe(true);
    expect(delta.events.length).toBeGreaterThan(0);

    const byId = new Map(rows({}).map((r) => [r.id, r]));
    const out = renderToStaticMarkup(createElement(SinceCard, { delta, rowsById: byId, onSelect: () => {} }));
    expect(out).toMatch(/3h of tape/);
    // every event row is a control that opens the coin — the point of the card
    // is that you do not then have to find it in a hundred rows
    expect(out).toMatch(/class="alt-ev-main is-link"/);
    expect(out).toMatch(/Open its directive/);
    expect(out).not.toMatch(/undefined|NaN/);
    // one line per coin
    const syms = [...out.matchAll(/class="alt-ev-sym">([^<]+)</g)].map((m) => m[1]);
    expect(new Set(syms).size, `a coin got more than one line: ${syms}`).toBe(syms.length);
  });

  it("draws a measured quiet market differently from a missing baseline", () => {
    const rows = screenUniverse(UNIVERSE, { btcRow: UNIVERSE[0], ethRow: UNIVERSE[1], now: NOW });
    const snap = (t) => boardSnapshot(rows, { asOf: t });
    const quiet = boardDelta(snap(NOW - 2 * 3600_000), snap(NOW));
    expect(quiet.ok).toBe(true);
    const measured = renderToStaticMarkup(createElement(SinceCard, { delta: quiet }));
    expect(measured).toContain("Nothing moved");
    expect(measured, "a measurement must state its own sample").toMatch(/coins were on both boards/);
    expect(measured).not.toContain("No comparison yet");

    const absent = renderToStaticMarkup(createElement(SinceCard, { delta: boardDelta(null, snap(NOW)) }));
    expect(absent).toContain("No comparison yet");
    expect(absent).not.toContain("Nothing moved");
  });

  it("refuses the whole dashboard layer on a dead scan, not just the board", () => {
    // Every one of the new reads is derived from the same payload the freshness
    // ladder refuses, so every one of them has to be behind the same gate. A
    // remembered diff or a remembered distribution is the same class of lie the
    // `screened` prop already shipped once.
    const out = panel({ scan: src({ ...SCAN_PAYLOAD, asOf: NOW - 4000_000 }, { fetchedAt: NOW - 4000_000 }) });
    expect(out).toContain("No board to compare");
    expect(out).toContain("No ranked coins to count");
    expect(out).toContain("Nothing to shortlist");
    expect(out, "a dead scan may not draw a distribution").not.toMatch(/class="alt-dist-seg/);
    expect(out, "…nor a band chip that filters a board that is not there").not.toMatch(/class="alt-chip /);
    expect(out).not.toMatch(/\$96,400/);
  });

  it("never writes a baseline the freshness ladder refused", () => {
    // A dead scan's board written to storage is worse than a dead scan on
    // screen: it becomes the baseline the NEXT visit measures everything
    // against, for as long as it sits there.
    const s = stripComments(read("components/alts/AltsPanel.jsx"));
    expect(s).toMatch(/snapshotRef\.current = live \? market\.dashboard\.snapshot : null/);
    expect(s).toMatch(/const save = \(\) => \{ if \(snapshotRef\.current\) writeBaseline/);
    // and the baseline is READ once into a ref, not rolled forward on every poll
    expect(s).toMatch(/baselineRef\.current === undefined/);
    expect(s, "a write on every render is the roll-forward that empties the diff")
      .not.toMatch(/writeBaseline\(snapshot\)/);
  });

  it("keeps stablecoins and wrappers off the board entirely", () => {
    const out = panel();
    expect(out).toContain(">SOL<");
    expect(out, "USDT is a dollar, not a momentum row").not.toContain(">USDT<");
    expect(out, "WBTC is a receipt for a coin already on the board").not.toContain(">WBTC<");
  });

  it("says the dominance trend is unknown rather than inventing one", () => {
    // domHistory is null on day one of the cron, and season.js refuses to infer
    // the trend from anything else. The card has to say so out loud.
    expect(panel()).toContain("trend unknown");
  });

  it("shows no prices at all once the scan is dead, with no coin picked", () => {
    // The freshness ladder, not the error, decides. A 3× max-age-old payload is
    // dead, and a dead scan may not render a remembered price under a red chip.
    //
    // THIS CASE COVERS HALF THE RULE. It exercises the panel with `sel === null`,
    // which is the state where four of the five reads of the payload are the
    // only ones on screen. The path that carries the PRICES — the board row
    // handed to the detail pane — is only reachable with a coin picked, and it
    // is the one that shipped ungated; it is the case below.
    const out = panel({ scan: src({ ...SCAN_PAYLOAD, asOf: NOW - 4000_000 }, { fetchedAt: NOW - 4000_000 }) });
    expect(out).toContain("No live market scan");
    expect(out).not.toContain("$96,400");
    expect(out).toContain(">Retry<");
  });

  it("shows no prices at all once the scan is dead, with a coin picked", () => {
    // The selection lives in the panel's own state and no static render can set
    // it, so this reproduces the panel's gate exactly — the freshness ladder over
    // the payload's `asOf`, then the board row looked up through it — and renders
    // the detail pane with what that gate yields. `screened` is the prop the
    // directive's entry, trigger, stop, invalidation and position size are all
    // measured from, so if it survives a dead scan, every one of those is a
    // remembered number under a red chip.
    const asOf = NOW - 4000_000;
    const fresh = freshness(asOf, "alt_scan", NOW);
    expect(fresh.state, "the fixture must actually be dead").toBe("dead");

    const season = seasonRead({
      universe: UNIVERSE, btcRow: UNIVERSE[0], ethRow: UNIVERSE[1],
      global: SCAN_PAYLOAD.global, fearGreed: SCAN_PAYLOAD.fearGreed,
      trending: SCAN_PAYLOAD.trending, domHistory: null, now: asOf,
    });
    const byId = new Map(screenUniverse(UNIVERSE, { btcRow: UNIVERSE[0], ethRow: UNIVERSE[1], season, now: asOf })
      .map((r) => [r.id, r]));
    expect(byId.get("solana")?.price, "the payload really does still hold the price").toBe(184.22);

    const live = fresh.state !== "dead";
    const out = detail({
      screened: live ? byId.get("solana") : null,
      season: live ? season : null,
      freshScan: fresh,
      fearGreed: null, trendingChecked: false, trendingRank: null,
    });

    expect(out, "a dead scan may not print a remembered price").not.toMatch(/\$[\d.,]/);
    expect(out, "…nor a remembered score").not.toMatch(/coin-directive/);
    expect(out).toContain("No live scan to price SOL from");
    expect(out).toContain("Refresh");
  });

  it("gives a failed scan an error row with a retry, without losing the board", () => {
    const out = panel({ scan: src(SCAN_PAYLOAD, { error: "coingecko: HTTP 429" }) });
    expect(out).toContain("coingecko: HTTP 429");
    expect(out).toContain("showing the last good pass");
    expect(out).toContain('data-testid="alt-board"');
  });

  it("renders every section of the coin detail, base rates included", () => {
    const out = detail();
    for (const id of ["coin-directive", "coin-precedent", "coin-checklist", "coin-crowd", "coin-sizing"]) {
      expect(out, `missing ${id}`).toContain(`data-testid="${id}"`);
    }
    // the precedent block is either a counted sample or an honest refusal —
    // never a silent gap
    expect(/Match to the archetype|No base rate for SOL/.test(out)).toBe(true);
    // the divergence is the whole reason derivatives are in this app
    expect(out).toContain("Divergence");
  });

  it("puts a worst case under EVERY median, not under one of the three", () => {
    // The rule precedent.js states — "the worst case is reported beside the
    // median everywhere the median is shown" — is a rule about three tiles, and
    // the version of this test it replaces was
    //
    //     if (out.includes("Match to the archetype")) expect(out).toContain("worst ")
    //
    // one substring over the entire document, satisfied by the single tile that
    // had one. `worstFwd7` and `worstFwd60` existed in the lib and appeared
    // nowhere on screen, under a comment claiming they did, and that assertion
    // was green the whole time. So: split the ticket into its tiles and check
    // each one on its own.
    const out = detail();
    const ticket = out.match(/<div class="ticket alt-rates">([\s\S]*?)<\/div><div class="stats/);
    expect(ticket, "the base-rate ticket must be on screen at all").toBeTruthy();
    const tiles = ticket[1].split('<div class="tk">').slice(1);
    expect(tiles).toHaveLength(3);

    for (const [i, label] of ["7d after", "21d after", "60d after"].entries()) {
      const tile = tiles[i];
      expect(tile, `tile ${i} is not ${label}`).toContain(label);
      // the median, then the worst case, then the sample both were counted from
      expect(tile, `${label} has no worst case under its median`).toMatch(/worst [+-]\d/);
      expect(tile, `${label} does not say how many episodes it counted`).toMatch(/\d+ episodes?/);
      expect(tile).not.toMatch(/undefined|NaN|worst —/);
    }
    // …and the three worst cases are three different readings of the archetype,
    // not the 21-day one printed three times.
    const worsts = tiles.map((t) => t.match(/worst ([+-][\d.]+)%/)[1]);
    expect(new Set(worsts).size, `all three tiles printed the same worst case: ${worsts}`).toBeGreaterThan(1);
  });

  it("states the refusal when there is not enough history for a base rate", () => {
    const out = detail({ payload: { ...COIN_PAYLOAD, candles: candles(60) } });
    expect(out).toContain("No base rate for SOL");
    expect(out).toContain('class="empty-sub"');
  });

  it("says a coin has no perp instead of scoring it neutral", () => {
    // `derivsStatus` is REQUIRED to make this claim, and the fixture states it
    // rather than leaving `derivs: null` to be read as whichever case the
    // reader assumes. That ambiguity is the bug the pair below pins.
    const out = detail({ payload: { ...COIN_PAYLOAD, derivs: null, derivsStatus: "not_listed", derivsUnavailable: null } });
    expect(out).toContain("No listed perpetual");
  });

  /* ── THE SEAM: "no perp" vs "could not tell" ────────────────────────────────
   *
   * alt-coin.mjs publishes `derivsStatus`/`derivsUnavailable` because
   * `derivs: null` cannot distinguish "Binance answered and the symbol does not
   * exist" (a measurement) from "Binance did not answer" (nothing at all). The
   * producer had tests; the CONSUMER had none, so the card kept printing the
   * first sentence for both — stating as fact that a coin has no futures market
   * on the 451 geo-block that status.mjs documents as the EXPECTED response
   * from a datacentre IP.
   *
   * Driven through the real CoinDetail → real crowdRead, from the real payload
   * field names, because a hand-built crowd object is how this was missed.
   */
  it("never claims a coin has no perp when the feed merely did not answer", () => {
    const out = detail({
      payload: {
        ...COIN_PAYLOAD, derivs: null, derivsStatus: "unavailable",
        derivsUnavailable: "binance futures: HTTP 451 from fapi.binance.com",
      },
    });
    // The positive claim must be absent in every form it is written in.
    expect(out, "a feed that did not answer establishes nothing about the market")
      .not.toMatch(/No listed perpetual/);
    expect(out).not.toMatch(/no listed perp/);
    expect(out).not.toMatch(/has no Binance perp/);
    // …and the truth is stated, with the reason the reader needs to act on it.
    expect(out).toContain("No perp read this pass");
    expect(out).toMatch(/HTTP 451 from fapi\.binance\.com/);
    // Still unmeasured, not neutral — the points must not come back.
    expect(out).toMatch(/points that had an input/);
  });

  it("falls back to the non-claiming answer when nobody said which it was", () => {
    // A caller that does not pass the status has not established anything. The
    // old default was the CLAIM, which is how the false sentence shipped.
    const out = detail({ payload: { ...COIN_PAYLOAD, derivs: null } });
    expect(out).not.toMatch(/No listed perpetual/);
    expect(out).toContain("No perp read this pass");
  });

  it("names the denominator wherever a rescaled score is printed, not behind a disclosure", () => {
    // Both libs drop an unmeasured component from the numerator AND the
    // denominator and rescale to 100, which is the honest arithmetic — and which
    // means "0/100" and "100/100" can each rest on one input out of seven. The
    // cards print what the score rests on beside the score.
    //
    // A coin with no perp is the measured case: sentiment.js scores it out of the
    // 55 attention points and says so.
    const noPerp = detail({ payload: { ...COIN_PAYLOAD, derivs: null, derivsStatus: "not_listed", derivsUnavailable: null } });
    expect(noPerp).toContain('data-testid="measured-score"');
    expect(noPerp).toMatch(/points that had an input/);
    expect(noPerp, "the missing half must be named, not just counted")
      .toMatch(/no listed perp/);
    // …and it is in the card body, not inside the collapsed <Expand>. The
    // disclosure renders after the two-column attention/crowding block, so the
    // coverage line must come before it.
    expect(noPerp.indexOf('data-testid="measured-score"'))
      .toBeLessThan(noPerp.indexOf("show the crowd read"));

    // The season card is the same rule on the same shape: day one of the cron
    // has no dominance history, so 20 of its 100 points have no input.
    const board = panel();
    expect(board).toContain('data-testid="measured-score"');
    expect(board).toMatch(/points that had an input/);
    expect(board.indexOf('data-testid="measured-score"'),
      "the season card's coverage line must precede 'how this scores'")
      .toBeLessThan(board.indexOf("how this scores"));
  });

  // THE THIN-COVERAGE CASE, which is the one the new fields exist for and the
  // one nothing else here renders. Below half coverage season.js stops naming a
  // phase — `phase: 'unknown'`, label "Not enough measured" — while still
  // reporting a real, and often HIGH, score. Every one of the new fields is
  // load-bearing on this path at once: the band class the card maps the phase
  // to, the `.thin` warning treatment on the coverage line, and the "not
  // measured" wording that replaced rendering a null `points` as " / 20".
  it("renders a regime whose phase was refused for thin coverage", () => {
    // Day one, and only the 7d breadth window resolved: no 30d returns, no ETH
    // row, no dominance history, no fear & greed. 35 of the 100 points.
    const rows = [
      { id: "bitcoin", symbol: "BTC", name: "Bitcoin", rank: 1, price: 6e4, mcap: 1.2e12, chg7d: 3, chg30d: null },
      ...Array.from({ length: 60 }, (_, i) => ({
        id: `c${i}`, symbol: `C${i}`, name: `C${i}`, rank: i + 2, price: 1, mcap: 5e8,
        chg7d: i < 45 ? 20 : -5, chg30d: null,
      })),
    ];
    const season = seasonRead({ universe: rows, btcRow: rows[0], ethRow: null, global: null, fearGreed: null, domHistory: null, now: NOW });
    expect(season.phase).toBe("unknown");
    expect(season.coverage).toBeLessThan(0.5);

    const html = renderToStaticMarkup(createElement(SeasonCard, { season }));
    // NO CONFIDENT NUMERAL UNDER A REFUSED LABEL. This line used to assert
    // `season.score > 70` — it pinned the behaviour where 35 of 100 measured
    // points rendered as a big "74" over "Not enough measured", which is the
    // one thing a reader takes from the top of the tab. The card must print the
    // refusal in the numeral too, not only in the label beneath it.
    expect(html).toMatch(/data-testid="season-score"[^>]*>—</);
    expect(html).not.toMatch(/data-testid="season-score"[^>]*>\d/);
    // The phase maps to a band the stylesheet actually owns.
    expect(html).toContain("tc-head band-unknown");
    // …and a refused score still owes the denominator. It is the state where
    // the reader most needs to know how thin the evidence was, so the coverage
    // line must survive the refusal rather than disappearing with the number.
    expect(html).toMatch(/class="alt-cover thin"/);
    expect(html).toMatch(/only <span class="num">35<\/span> of the <span class="num">100<\/span>/);
    expect(html).toContain("Not enough measured");
    // An unmeasured part says so in words. `{p.points} / {p.max}` rendered a
    // null as " / 25", which reads as a zero that was scored.
    expect(html).toMatch(/not measured · 25 unused/);
    expect(html).not.toMatch(/>\s*\/ 25</);
    // and nothing anywhere leaked a null through a template literal.
    expect(html).not.toMatch(/undefined|NaN/);
  });

  it("prints a sample count and a calendar span as two different things", () => {
    // `windowDays: window.length` was a SAMPLE COUNT rendered as "-1.20pts / 9d",
    // so after a cron gap the card claimed a nine-day move for one measured
    // across up to thirty. The tile now names the span and the readings apart.
    // Nine readings, one every third day: 24 calendar days of span. The old
    // field would have called this "9d".
    const domHistory = Array.from({ length: 9 }, (_, i) => ({
      d: new Date(NOW - (27 - i * 3) * DAY).toISOString().slice(0, 10),
      btcDom: 56 - i * 0.4, ethDom: 12, totalMcap: 3.4e12,
    }));
    const out = panel({ scan: src({ ...SCAN_PAYLOAD, domHistory }) });
    expect(out).toMatch(/over 24d · 9 readings/);
    expect(out, "a reading count may not wear a day's clothes").not.toMatch(/ 9d/);
  });

  it("will not report a coin as unwatched when the trending feed never answered", () => {
    // ABSENT ≠ NULL, and the two reads on this pane have to agree about it.
    // `trendingChecked: false` is what the panel passes when /api/alt-scan came
    // back with `trending: null` (a 429). Both crowdRead and signalChecklist are
    // handed the key only when the list actually arrived — passing a bare null
    // made the late-stage attention row claim "not on the trending list", which
    // is a measurement, and the most bullish reading this row has.
    const down = detail({ trendingChecked: false, trendingRank: null });
    expect(down).toMatch(/did not answer/);
    expect(down, "a failed feed must not read as a measured absence")
      .not.toMatch(/not on the trending list/);

    // ...and when the list DID arrive without this coin on it, that is a real
    // measurement and it still reads as the good version of the row.
    const up = detail({ trendingChecked: true, trendingRank: null });
    expect(up).toMatch(/not on the trending list/);
  });

  it("emits no NaN and no literal 'undefined' from any alts surface", () => {
    for (const out of [panel(), detail(), detail({ loading: true }), detail({ error: "HTTP 502" })]) {
      expect(out).not.toMatch(/NaN/);
      expect(out).not.toMatch(/(style|class)="[^"]*undefined/);
      expect(out).not.toMatch(/>undefined</);
    }
  });

  it("loads with skeletons and fails with a retry, never a spinner", () => {
    const cold = panel({ scan: { data: null, error: null, fetchedAt: null, loading: true, reload: () => {} } });
    expect(cold).toContain('class="sk sk-line w40"');
    const broken = detail({ payload: null, error: "binance: HTTP 451" });
    expect(broken).toContain("binance: HTTP 451");
    expect(broken).toContain(">Retry<");
  });

  it("renders the alts surfaces without a React warning", () => {
    const before = warnings.length;
    panel(); detail(); detail({ payload: { ...COIN_PAYLOAD, derivs: null, candles: null } });
    const react = warnings.slice(before).filter((w) => !w.startsWith("[@cc/"));
    expect(react, `React warned:\n${react.join("\n")}`).toEqual([]);
  });

  it("disables only the star whose own write is outstanding", () => {
    // A single in-flight PUT used to disable EVERY star on the tab — 26 rows
    // plus the detail pane's — because the board was handed `locked={savingId
    // != null}`. With `api()` unbounded, a stalled request left the whole
    // watchlist control surface dead with no toast and no way back (measured
    // still dead at t+15s in a real browser). The writer now queues instead of
    // locking, so the lock is per row and nothing else on the board notices.
    const season = seasonRead({
      universe: UNIVERSE, btcRow: UNIVERSE[0], ethRow: UNIVERSE[1],
      global: SCAN_PAYLOAD.global, fearGreed: SCAN_PAYLOAD.fearGreed,
      trending: SCAN_PAYLOAD.trending, domHistory: null, now: NOW,
    });
    const rows = screenUniverse(UNIVERSE, { btcRow: UNIVERSE[0], ethRow: UNIVERSE[1], season, now: NOW });
    const out = renderToStaticMarkup(createElement(AltBoard, {
      rows, watched: new Set(), selectedId: null,
      pendingIds: new Set(["solana"]),
      onSelect: () => {}, onToggleWatch: () => {},
    }));
    const stars = out.match(/<button[^>]*class="alt-star[^"]*"[^>]*>/g) ?? [];
    expect(stars.length, "the board rendered no stars at all").toBeGreaterThan(2);
    const off = stars.filter((s) => /\sdisabled\b/.test(s));
    expect(off, `${off.length} of ${stars.length} stars are disabled for one row's write`).toHaveLength(1);
    expect(off[0]).toContain("SOL");
    // …and the row that is saving says so with more than an opacity change
    expect(off[0]).toMatch(/class="alt-star[^"]*saving/);
  });

  it("gives up on a stalled request instead of hanging the control that started it", async () => {
    // `fetch` has no timeout. Nothing noticed while every caller was a poll,
    // but the watchlist star disables while its write is in flight, so an
    // unbounded request is a dead button until the browser's own socket
    // timeout. The bound lives in api() so all eleven call sites get it.
    const realFetch = globalThis.fetch;
    const realStore = globalThis.sessionStorage;
    globalThis.sessionStorage = { getItem: () => "" };
    let seen = null;
    try {
      // A stub that behaves like the real thing: it stalls, and it honours the
      // signal. Against the source this replaces there IS no signal, so this
      // throws before the stall and the rejection is the missing bound itself.
      globalThis.fetch = (_url, init) => {
        seen = init;
        if (!init?.signal) throw new Error("api() sent no AbortSignal — a stalled request cannot be given up on");
        return new Promise((_ok, fail) => {
          init.signal.addEventListener("abort", () => fail(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      };
      const started = Date.now();
      await expect(api("alt-watchlist", { method: "PUT", body: "{}", timeoutMs: 60 }))
        .rejects.toMatchObject({ code: "timeout" });
      expect(Date.now() - started, "the bound did not fire").toBeLessThan(2000);
      expect(seen.signal, "no AbortSignal ever reached fetch").toBeTruthy();
      expect(seen.signal.aborted, "the socket was left open after giving up").toBe(true);
      // and the default is a real bound, not Infinity and not absent
      expect(Number.isFinite(API_TIMEOUT_MS) && API_TIMEOUT_MS > 0).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      globalThis.sessionStorage = realStore;
    }
  });
});

describe("The sparkline survives the three inputs that used to blank it", () => {
  it("returns null rather than a broken polyline", () => {
    expect(sparkPoints(null)).toBeNull();
    expect(sparkPoints([])).toBeNull();
    expect(sparkPoints([42])).toBeNull();
    expect(sparkPoints([1, NaN])).toBeNull();      // one finite point after filtering
    expect(sparkDirection(null)).toBeNull();
  });

  it("draws a dead-flat series on the midline instead of dividing by zero", () => {
    // (v - min) / (max - min) is 0/0 here. A single NaN in `points` makes an SVG
    // polyline render NOTHING, silently — the column just goes blank on the rows
    // whose flatness is the interesting fact about them.
    const p = sparkPoints(new Array(24).fill(7), { width: 72, height: 20 });
    expect(p).not.toMatch(/NaN/);
    expect(p.split(" ")).toHaveLength(24);
    // the midline of the drawable band: 18.5 - 0.5 × (18.5 - 1.5)
    for (const pair of p.split(" ")) expect(pair.split(",")[1]).toBe("10");
    expect(sparkDirection(new Array(24).fill(7))).toBe("flat");
  });

  it("downsamples long series but keeps the first and last point", () => {
    const s = Array.from({ length: 168 }, (_, i) => i);
    const pts = sparkPoints(s, { width: 72, height: 20 }).split(" ");
    expect(pts.length).toBeLessThanOrEqual(48);
    expect(pts[0].split(",")[0]).toBe("0");          // first x at the left edge
    expect(pts[pts.length - 1].split(",")[0]).toBe("72");
    expect(pts[pts.length - 1].split(",")[1]).toBe("1.5");  // last point is the high
    expect(sparkDirection(s)).toBe("up");
  });
});

/* ── the language, checked against the source ─────────────────────────────── */

const read = (rel) => {
  const { readFileSync } = require("node:fs");
  const { fileURLToPath } = require("node:url");
  const { dirname, join } = require("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", rel), "utf8");
};
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Every .jsx under src/, discovered rather than listed. A hard-coded manifest
// silently stops covering the file someone adds next — the component that gets
// written after this test does is exactly the one nobody re-reads the list for.
const srcFiles = () => {
  const { readdirSync } = require("node:fs");
  const { fileURLToPath } = require("node:url");
  const { dirname, join, relative } = require("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "__tests__" || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsx")) out.push(relative(root, p));
    }
  };
  walk(root);
  return out;
};

// Every JSX element in `src` that names a class, as [tagName, classTokens].
// The tag is read from the nearest preceding "<" — attribute values with
// braces (onClick={() => …}) make a whole-opening-tag regex unreliable, and
// the class list is what these rules are actually about.
const classedElements = (src) => {
  const out = [];
  for (const m of src.matchAll(/className\s*=\s*/g)) {
    let i = m.index + m[0].length;
    let raw;
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      const end = src.indexOf(q, i + 1);
      raw = src.slice(i, end === -1 ? src.length : end + 1);
    } else if (src[i] === "{") {
      let depth = 0, j = i;
      for (; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && --depth === 0) break;
      }
      raw = src.slice(i + 1, j);
    } else continue;
    // every literal chunk inside the expression contributes class tokens; a
    // `${…}` hole is unknowable from source and is simply skipped
    const tokens = [...raw.matchAll(/`([^`]*)`|"([^"]*)"|'([^']*)'/g)]
      .map((s) => (s[1] ?? s[2] ?? s[3]).replace(/\$\{[^}]*\}/g, " "))
      .join(" ")
      .split(/\s+/)
      .filter(Boolean);
    const lt = src.lastIndexOf("<", m.index);
    const tag = /^<\s*([A-Za-z][\w.]*)/.exec(src.slice(lt, lt + 40))?.[1] ?? "?";
    out.push([tag, tokens]);
  }
  return out;
};

// Every `<div className="empty">…</div>` block, matched by depth rather than by
// a fixed window, so what the test reads is the whole empty state.
const emptyStateBlocks = (src) => {
  const blocks = [];
  for (const m of src.matchAll(/<div className="empty">/g)) {
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = m.index;
    let depth = 0, t, end = src.length;
    while ((t = tags.exec(src))) {
      if (t[0] === "</div>") { if (--depth === 0) { end = tags.lastIndex; break; } }
      else depth++;
    }
    blocks.push(src.slice(m.index, end));
  }
  return blocks;
};

// Every px length inside a font-size declaration, clamp()/min()/max() included
// and case-insensitively — `font-size: clamp(9px, 2vw, 14px)` and
// `font-size: 9PX` are both a 9px floor violation.
const cssFontPx = (css) =>
  [...css.matchAll(/font-size\s*:\s*([^;}]+)/gi)]
    .flatMap((m) => [...m[1].matchAll(/([0-9.]+)\s*px/gi)].map((n) => Number(n[1])))
    .filter((n) => Number.isFinite(n) && n > 0);

describe("Macro obeys the language", () => {
  const css = stripComments(read("styles.css"));
  const files = srcFiles();
  const jsx = files.map((f) => stripComments(read(f))).join("\n");

  it("scans every .jsx under src, not a hand-kept list", () => {
    // The manifest above is globbed. This is the assertion that keeps it
    // honest: a new component under src/ must show up in `files`, and the
    // surfaces that exist today must all still be in it.
    expect(files.length).toBeGreaterThanOrEqual(14);
    for (const f of ["App.jsx", "Root.jsx", "main.jsx", "components/Cockpit.jsx",
      "components/TradeCard.jsx", "components/Journal.jsx", "components/Settings.jsx",
      "components/RunPlan.jsx", "components/ChartPanel.jsx", "components/primitives.jsx",
      "components/alts/AltsPanel.jsx", "components/alts/SeasonCard.jsx",
      "components/alts/AltBoard.jsx", "components/alts/CoinDetail.jsx",
      "components/alts/sparkline.jsx"]) {
      expect(files, `${f} must be scanned`).toContain(f);
    }
  });

  it("has no type under the 10.5px floor, in CSS or in a ternary", () => {
    // Five lived here: the bottom-tab label (9px), the answer card's row keys
    // (10px), the order-ticket keys (10px), the trend-shape header (9.5px) and
    // the "est" badge on mNAV (8.5px).
    //
    // clamp() is this sheet's live idiom for the trade card's numerals, so the
    // scan reads the whole declaration and every px inside it — a 9px lower
    // bound in a clamp() is 9px on a phone. Case-insensitive for the same
    // reason: CSS does not care that it was typed `9PX`.
    const cssSizes = cssFontPx(css);
    expect(cssSizes.length, "the font-size scan found nothing — it is broken").toBeGreaterThan(20);
    expect(cssSizes.filter((n) => n < 10.5), "css font-size under the floor").toEqual([]);

    // Ternaries too — `fontSize: compact ? 9 : 12` hides a 9.
    const jsxSizes = [...jsx.matchAll(/fontSize:\s*([^,\n}]+)/g)]
      .flatMap((m) => [...m[1].matchAll(/[\d.]+/g)].map((n) => Number(n[0])))
      .filter((n) => Number.isFinite(n) && n > 0);
    expect(jsxSizes.filter((n) => n < 10.5), "inline fontSize under the floor").toEqual([]);
  });

  it("reserves uppercase for .t-label", () => {
    // Five hand-rolled uppercase micro-styles are gone: the tab labels, the card
    // titles, the stat-tile keys, the answer-card row keys, the ticket keys, the
    // trend-shape header and the table column heads. `capitalize` is a different
    // thing and is allowed (grade names, regime states).
    //
    // Exactly ONE uppercase rule may remain: the `.ttl` block, which is a
    // value-for-value mirror of the kit's .t-label kept so the standalone dev
    // entry (no kit stylesheet in the page) still renders a card title. It
    // loses to `[data-kit] .t-label` on specificity wherever the kit is loaded.
    const upper = [...css.matchAll(/[^\n{]*text-transform:\s*uppercase[^\n}]*/g)].map((m) => m[0]);
    expect(upper.length, `hand-rolled uppercase survives:\n${upper.join("\n")}`).toBe(1);
    expect(upper[0]).toContain("font-size: 12px");
    expect(upper[0]).toContain("letter-spacing: 0.05em");
  });

  it("puts the kit's .field on the CONTROL and never on the wrapper", () => {
    // THE collision this migration existed to get right. This app's .field was
    // a <label>+<input> WRAPPER; the kit's .field IS the input. Had the wrapper
    // kept the name, every form row would have rendered inside a filled 44px
    // well. Both forms live behind a loading gate, so this is checked in the
    // source — the markup cannot show them until data lands.
    //
    // Read off the class LIST of every element, not off one literal spelling:
    // `<div className="field">`, `<div className="field row">` and
    // `<div className={`field ${x}`}>` are the same bug, and only the first of
    // the three is a literal a single regex can be written against.
    const CONTROLS = new Set(["input", "select", "textarea"]);
    const wrappers = classedElements(jsx)
      .filter(([tag, cls]) => cls.includes("field") && !CONTROLS.has(tag));
    expect(wrappers.map(([t, c]) => `<${t} class="${c.join(" ")}">`),
      "the kit's .field belongs on the control, never on a wrapper").toEqual([]);
    // …and the scan must actually be seeing the controls that DO carry it
    const carriers = classedElements(jsx).filter(([, cls]) => cls.includes("field"));
    expect(carriers.length, "the .field scan found nothing — it is broken").toBeGreaterThanOrEqual(20);
    expect(carriers.filter(([tag]) => !CONTROLS.has(tag))).toEqual([]);

    expect(jsx.match(/<div className="fld"/g).length).toBeGreaterThanOrEqual(20);
    expect(jsx.match(/<input className="field"/g).length).toBeGreaterThanOrEqual(20);
    expect(jsx).toMatch(/<select className="field"/);
    expect(css).toMatch(/\.fld \{ display: flex; flex-direction: column;/);
  });

  it("routes the stat tiles and the primary actions through the kit", () => {
    // Both live behind a loading gate too (the cockpit skeletons at t=0), so
    // the source is the honest place to check them.
    expect(jsx.match(/className="stattile"/g).length).toBeGreaterThanOrEqual(11);
    expect(jsx.match(/stattile-label/g).length).toBeGreaterThanOrEqual(11);
    expect(jsx.match(/stattile-value/g).length).toBeGreaterThanOrEqual(11);
    expect(jsx, "the hand-rolled tile must be gone").not.toMatch(/className="stat"/);
    expect(jsx.match(/className="btn primary md"/g).length).toBeGreaterThanOrEqual(5);
    expect(jsx).toMatch(/className="btn danger md"/);
    expect(jsx).toMatch(/className=\{`card pad-md span2 tcard \$\{d\.severity\}`\}/);
  });

  it("never carries the display face — system stack only", () => {
    // The desktop tab pills were set in Syne, a decorative display font. The
    // shell's own chrome test asserts the same string never appears there.
    expect(css).not.toContain("Syne");
  });

  it("puts no border and box-shadow on the same element", () => {
    // .card did (1px border + --shadow-1), .cmdk did, .toast did. The answer
    // card's severity stripe was a border-left on top of that, and the kit's
    // `border: none` would have deleted it — it is an inset shadow layer now.
    //
    // EVERY rule in the sheet, not the three that were named: .error-row
    // already has a border, so naming .card and .tcard only means the next
    // shadow to land on an outlined element lands unseen.
    const offenders = [];
    let rules = 0;
    for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
      rules++;
      const border = /(^|;)\s*border(-top|-bottom|-left|-right)?:(?!\s*none\b)/.test(body);
      const shadow = /(^|;)\s*box-shadow:(?!\s*none\b)/.test(body);
      if (border && shadow) offenders.push(`${sel.trim()} { ${body.trim()} }`);
    }
    expect(rules, "the rule walk found nothing — it is broken").toBeGreaterThan(100);
    expect(offenders, `border + shadow on one element:\n${offenders.join("\n\n")}`).toEqual([]);

    expect(css).toMatch(/\.card\s*\{[^}]*border:\s*none/);
    expect(css).toMatch(/\[data-kit\] \.card\.tcard\s*\{\s*box-shadow:[^}]*inset 5px 0 0/);
    expect(css, "the stripe must not go back to being a border")
      .not.toMatch(/\.tcard[^{]*\{[^}]*border-left/);
  });

  it("keeps the iOS 16px input workaround, at a weight that beats the kit", () => {
    // `[data-kit] .field` is 15px. Without the twin below, every focused input
    // on iOS zooms the page — the exact bug the original line prevents.
    expect(css).toMatch(/input,\s*select,\s*textarea\s*\{\s*font-size:\s*16px/);
    expect(css).toMatch(/\[data-kit\] input\.field[^{]*\{\s*font-size:\s*16px/);
  });

  it("keeps the iOS letterbox guard governing the toasts", () => {
    // `[data-kit] .toasts` pins itself to calc(84px + env(safe-area-inset-bottom))
    // and out-specifies this app's rule. Raw env() is precisely what the shell's
    // letterbox guard overrides — on a "black-translucent" install the reported
    // inset is a dead strip, and padding for it floats the bar off the screen.
    // The shell publishes the usable value as --safe-bottom; this must read it.
    expect(css).toMatch(/\[data-kit\]\.macro-root \.toasts\s*\{\s*bottom:\s*calc\(var\(--nav-h\) \+ 14px \+ var\(--safe-bottom, 0px\)\)/);
    // and the element that carries data-kit must be the one .macro-root names
    expect(jsx).toMatch(/<div data-kit className="macro-root">/);
  });

  it("keeps every 44px touch target after the .seg rename", () => {
    // `.seg button` no longer matches anything the app renders, so the mobile
    // ergonomics rule had to learn .seg-opt or the stop-mode picker would have
    // silently dropped to the kit's 32px.
    expect(css).toMatch(/\[data-kit\] \.seg \.seg-opt\s*\{\s*min-height:\s*44px/);
  });

  it("keeps the domain colours literal", () => {
    // The series identities and the candle polarity are data. A hex that means
    // "this is BTC" or "this number is negative" is not a palette choice.
    expect(css).toMatch(/--mstr:\s*#3b72e8/i);
    expect(css).toMatch(/--btc:\s*#d97706/i);
    expect(jsx).toMatch(/#0FA3A3/i);   // up / positive R
    expect(jsx).toMatch(/#D93A5F/i);   // down / negative R
  });

  it("gives every error a retry and every empty state a next step", () => {
    expect(jsx.match(/error-row/g).length).toBeGreaterThan(0);
    // one Retry (or the always-reachable Refresh) per error surface
    expect(jsx.match(/>Retry</g).length).toBeGreaterThanOrEqual(4);

    // Every empty state, counted and then read. `for (const m of …) expect(m)
    // .toBeTruthy()` asserted nothing in either direction: no matches meant no
    // iterations, and a matched literal is always truthy. What the title of
    // this case promises is that each empty state exists AND says what to do
    // next, so that is what is checked.
    const empties = emptyStateBlocks(jsx);
    expect(empties.length, "empty states found — the app has five and may not lose one")
      .toBeGreaterThanOrEqual(5);
    for (const b of empties) {
      expect(b, `an empty state with no title:\n${b}`).toMatch(/className="empty-title"/);
      expect(b, `an empty state with no next step:\n${b}`).toMatch(/className="empty-sub"/);
    }
    expect(jsx.match(/empty-sub/g).length).toBeGreaterThanOrEqual(4);
  });

  it("gives every grid's children a min-width floor of 0", () => {
    // The bug this pins twice over: a card sized to its own min-content sets its
    // track and bursts out of it, and the pane is not a scroll container, so the
    // overflow lands on the page (49px of sideways scroll at 360) or under the
    // neighbouring pane (813px of card in a 613px track at 1440, painting over
    // the Score column, the Band pill and every row's star). `min-width: 0` on
    // the CONTAINER does nothing about it — the automatic minimum size belongs
    // to the items.
    for (const grid of [".grid", ".alt-pane-board", ".alt-detail-grid"]) {
      expect(css, `${grid} > * needs min-width: 0`)
        .toMatch(new RegExp(`\\${grid} > \\*\\s*\\{[^}]*min-width:\\s*0`));
    }
  });

  it("derives the board's minimum width from its own columns", () => {
    // A typed floor is a second copy of the column budget, and it stopped
    // matching: 700px against 831px of actual tracks, with `.alt-board`'s
    // overflow:hidden clipping the difference instead of handing it to
    // `.tbl-wrap`, which therefore never scrolled at any width.
    expect(css).toMatch(/\.alt-board\s*\{\s*min-width:\s*min-content/);
    expect(css, "the row must carry a min-content minimum or the board cannot see its own width")
      .toMatch(/\.alt-row\s*\{[^}]*grid-template-columns:\s*minmax\(min-content,\s*1fr\)/);
    // …and the identity column may not go back to a floor that fits four
    // characters: 70px pinned Dogecoin to 26px of its 49 at every width from
    // 768 to 1920.
    const budget = /\.alt-head,\s*\.alt-row-main\s*\{\s*grid-template-columns:([^;]+);/.exec(css);
    expect(budget, "the desktop column budget must be findable").toBeTruthy();
    const coinFloor = Number(/minmax\((\d+)px/.exec(budget[1])?.[1]);
    expect(coinFloor, "the coin column's floor").toBeGreaterThanOrEqual(140);
  });

  it("writes the [data-kit] twin for every rule the kit out-specifies", () => {
    // `[data-kit] .btn` is (0,2,0) and sets display: inline-flex, so a bare
    // `.alt-back { display: none }` (0,1,0) lost and the phone's back control
    // rendered at 1020 and up — measured 81×34 at x=771 at 1440, on top of the
    // board's filter select. DESIGN.md §5 is this failure; `.nav button:active`
    // at :212 is the other one in this sheet.
    expect(css).toMatch(/\.alt-back,\s*\[data-kit\] \.alt-back\s*\{\s*display:\s*none/);
    expect(css).toMatch(/\.nav button:active,\s*\[data-kit\] \.nav button:active/);
  });

  it("keeps the watchlist star out of the accent budget", () => {
    // DESIGN.md §4.4: one accent, spent rarely. A 20-coin watchlist put 20 gold
    // stars on one phone screen and the genuinely selected row — the accent's
    // legitimate use here — competed with all of them. The membership marker is
    // the glyph, ☆ against ★, so nothing is signalled by colour alone.
    expect(css).not.toMatch(/\.alt-star\.on\s*\{\s*color:\s*var\(--accent\)/);
    expect(css, "the selected row keeps the accent").toMatch(/\.alt-row\.on\s*\{[^}]*var\(--accent\)/);
    expect(jsx).toMatch(/starred \? '★' : '☆'/);
  });

  it("gates every read of the scan payload behind the freshness ladder", () => {
    // Four of the five reads were gated on `live`; the fifth was `screened`, the
    // one carrying the price, the score and the four levels into the detail pane.
    // The rendered proof is above — this is the assertion that the gate stays
    // where the payload is unpacked, so the next read added does not have to
    // remember to repeat it.
    const src = stripComments(read("components/alts/AltsPanel.jsx"));
    expect(src).toMatch(/const screened = live && sel \?/);
    expect(src, "the detail pane must not read the scan payload directly")
      .not.toMatch(/screened=\{market\./);
    expect(src, "the cache age is a fact about a payload a dead scan may not quote")
      .toMatch(/cached=\{live &&/);
  });

  it("keys the coin detail's heavy read on the payload, not on the clock", () => {
    // `freshness()` returns a new object literal per call and the panel calls it
    // on App's ten-second tick, so holding one in this memo's dependency list
    // re-ran precedentRead over 730 candles, atr, swings, signalChecklist and
    // altDirective every ten seconds to produce identical output — measured 45ms
    // of script over 31 idle seconds against 0 with the clock frozen. Only the
    // two state strings may be depended on; directive.js reads nothing else off
    // them.
    const src = stripComments(read("components/alts/CoinDetail.jsx"));
    const deps = /\}, \[([^\]]*)\]\)/.exec(src);
    expect(deps, "the read memo's dependency list must be findable").toBeTruthy();
    expect(deps[1]).toContain("scanState");
    expect(deps[1]).toContain("coinState");
    expect(deps[1], "a freshness OBJECT in the deps is a per-tick recompute")
      .not.toMatch(/freshScan|freshCoin/);
  });

  it("keeps identity, the ranking and the star ahead of the columns that scroll away", () => {
    // The board is 885px of min-content inside a 576-670px pane, so ~215px of
    // table is always past the right edge of `.tbl-wrap`. That is what a dense
    // table's scroller is for. WHICH columns are past the edge is not a detail:
    // with score and band written last, the number the board is sorted by, the
    // state word it is inked from and the star were all 0px visible at 1020,
    // 1180, 1280, 1440 and 1920 — with and without a coin selected — and the
    // only way to read the score was to scroll the coin's name off the screen.
    //
    // No DOM here, so this pins the two declarations that decide it. Against
    // the source this replaces the template reads "rank coin price c24 c7 c30
    // rs turn spark score band" and there is no star rule at all, so both
    // assertions fail.
    const areas = /grid-template-areas:\s*"rank ([^"]+)"/.exec(css);
    expect(areas, "the desktop table template moved or was renamed").toBeTruthy();
    const order = `rank ${areas[1]}`.trim().split(/\s+/);
    expect(order).toContain("price");
    for (const name of ["coin", "score", "band"]) {
      expect(order, `${name} is not in the desktop table`).toContain(name);
      expect(order.indexOf(name), `${name} sits behind the fold, after price`)
        .toBeLessThan(order.indexOf("price"));
    }
    // and the star is the first cell of the row from 768 up, not the last
    expect(css, "the star is still parked past the right edge of the scroller")
      .toMatch(/\.alt-row > \.alt-star \{ grid-column: 1; \}/);
  });

  it("explains the board's two flags somewhere touch can read them", () => {
    // `par` and `thin` are the two marks that decide whether a row is tradeable
    // at all, and their only explanation was a `title` attribute, which does not
    // exist on a phone — which is the platform the abbreviation is worst on.
    const board = stripComments(read("components/alts/AltBoard.jsx"));
    expect(board).toMatch(/alt-legend/);
    expect(board, "the legend must quote what the flag measured").toMatch(/\+40% in 24h/);
    expect(board).toMatch(/\$250k of 24h volume/);
    // and a screen reader, which cannot expand an abbreviation either
    expect(board).toMatch(/Flagged parabolic:/);
    expect(board).toMatch(/Flagged thin:/);
  });

  it("did not touch a single storage key or endpoint path", () => {
    // A restyle that renames a key is a data loss bug wearing a stylesheet.
    expect(jsx).toContain("sessionStorage.getItem('torque_token')");
    expect(jsx).toContain("sessionStorage.setItem('torque_token'");
    for (const path of ["'settings'", "'position'", "'journal'", "'status'", "'quote'", "'btc'"]) {
      expect(jsx, `endpoint ${path} must survive`).toContain(path);
    }
    expect(jsx).toContain("'candles?symbol=MSTR&tf=1d'");
  });
});
