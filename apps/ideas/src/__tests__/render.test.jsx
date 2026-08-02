// Ideas is the first app surface on the shared kit, so it is also the first
// place a migration can be proved rather than asserted.
//
// The build does not prove it. `vite build` was green on a component that threw
// "nodeR is not defined" the moment it mounted, and took three tools down.
// react-dom/server executes the whole component body in plain Node — no jsdom
// needed — so a restyle that broke a reference, a prop, or a hook fails here.
//
// What this file CANNOT see is layout, and this app has now shipped a layout
// complaint twice. Geometry is measured in a browser instead; the harness is
// scripts/rail-check.mjs's shape, with the ideafeed tables stubbed so there is a
// feed to measure. Everything below is the half that is statically decidable.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Ideas from "../Root.jsx";

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

const html = () => renderToStaticMarkup(createElement(Ideas));

describe("Ideas renders on the kit", () => {
  it("renders at all", () => {
    expect(() => html()).not.toThrow();
  });

  it("opts into the kit on its own root", () => {
    // Ideas renders inside the shell's tool slot, so data-kit here reaches this
    // app and nothing else — the same rule the shell follows by keeping it off
    // the wrapper that holds every tool.
    expect(html()).toMatch(/<div[^>]*data-kit/);
  });

  it("uses the kit's primitives in the markup it renders cold", () => {
    // renderToStaticMarkup does not run effects, so nothing that waits on
    // fetched repos is in this output. What IS here is the page furniture, and
    // all of it should be the kit's.
    //
    // `.stattile` used to be asserted here and is deliberately gone: the three
    // stat tiles (In the feed / Newest batch / Saved) were a third of a phone
    // screen spent on three numbers, two of which the scan line directly below
    // them repeated verbatim. Those two are now in that line and the third is a
    // count on the Saved pill.
    const out = html();
    for (const cls of ["seg", "seg-opt", "btn sm quiet"]) {
      expect(out, `expected the kit's .${cls}`).toContain(cls);
    }
    expect(out, "the stat tiles came back").not.toContain("stattile");
  });

  it("names the view for a screen reader now that the title is gone", () => {
    // This used to assert `t-ltitle` — the <h1>Ideas</h1>, which sat under a
    // tool row saying Ideas and a segment whose first pill says Ideas. It is
    // deleted, so the class is not there to find and asserting it would pin
    // markup nothing renders.
    //
    // What replaced it is the thing the heading was still doing that the
    // deletion had to preserve: giving the view a name a screen reader can
    // announce. The name is the SELECTED tab, so it is right on all three
    // rather than reading "Ideas" while you stand in Saved.
    const out = html();
    expect(out, "the view lost its accessible name with its heading").toMatch(/role="region"/);
    expect(out, "the region is unnamed — aria-label is the whole point of it").toMatch(/aria-label="Ideas"/);
    expect(out, "the deleted page title came back").not.toContain("t-ltitle");
    // The line under the title was never a repeat and had to survive.
    expect(out, "the sub line went with the title").toContain("What showed up on GitHub");
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

/* ══ the sub-nav ════════════════════════════════════════════════════════════
 *
 * Every assertion in this block fails against the source as it stood before
 * this change, where the tabs were the first of THREE stacked full-width
 * segmented bars inside the body's padding and nothing was sticky. */

describe("the sub-nav is the ZTS/Clarify row, not a segmented bar in the body", () => {
  const out = html();

  it("is sticky, and sticks to the shell bar's MEASURED height", () => {
    expect(out, "the sub-nav is gone").toMatch(/data-ideas-nav/);
    expect(out).toMatch(/position:sticky/);
    // NEVER a literal. The shell measures its own bar and publishes the answer
    // — it is 0px on a desktop, where the bar is gone and the tools live in the
    // left rail. Hardcoding 52 is what put ZTS's nav 52px below its own content
    // the night the rail landed.
    expect(out, "the shell bar height is hardcoded again").toMatch(/top:var\(--shell-bar, 52px\)/);
  });

  it("is glass with a hairline and NO shadow", () => {
    expect(out).toMatch(/background:var\(--glass\)/);
    expect(out).toMatch(/backdrop-filter:blur\(20px\) saturate\(140%\)/);
    expect(out).toMatch(/border-bottom:1px solid var\(--line\)/);
    // §4.2: never a border and a shadow on the same element. The bar draws one
    // hairline and nothing else — the pair ZTS's and Macro's bars both had.
    const bar = out.slice(out.indexOf("data-ideas-nav"), out.indexOf("data-ideas-nav") + 700);
    expect(bar, "the bar draws a border AND a shadow").not.toMatch(/box-shadow/);
  });

  it("renders ONE segmented control, not three stacked ones", () => {
    // The complaint, exactly: Ideas/Saved/Skills, then Newest/Popping/Stars,
    // then 7d/30d/90d/All, each spanning the whole content width. Sort and
    // window are filters and are <select>s now, beside the list they filter.
    expect([...out.matchAll(/class="seg"/g)]).toHaveLength(1);
  });

  it("labels the pills from the hoisted map, never from a raw id", () => {
    for (const label of ["Ideas", "Saved", "Skills"]) expect(out).toContain(`>${label}<`);
    expect(out, "a raw id is being title-cased by CSS").not.toMatch(/text-transform:capitalize/);
  });
});

/* ══ the language ═══════════════════════════════════════════════════════════ */

describe("Ideas obeys the language", () => {
  const src = readSrc("Root.jsx");
  const rank = readSrc("lib/rank.js");

  function readSrc(rel) {
    const { readFileSync } = require("node:fs");
    const { fileURLToPath } = require("node:url");
    const { dirname, join } = require("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    // Comments come out first. This file DOCUMENTS the traps it avoids — "this
    // was rgba(11,15,26,0.78)", "was 10px uppercase" — and a scanner that
    // cannot tell an explanation from a rule punishes the write-up of the fix.
    return readFileSync(join(here, "..", rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  it("has no text under the 10.5px floor", () => {
    // The stat label was 10px uppercase tracked at 0.1em — under the floor, and
    // hand-doing what .t-label does at 12px.
    const sizes = [...src.matchAll(/fontSize:\s*([^,\n}]+)/g)]
      .flatMap((m) => [...m[1].matchAll(/[\d.]+/g)].map((n) => Number(n[0])))
      .filter((n) => Number.isFinite(n) && n > 0);
    expect(sizes.filter((n) => n < 10.5)).toEqual([]);
  });

  it("puts no border and shadow on the same element", () => {
    // The local Card had `border: 1px solid` AND was meant to read as elevated.
    // The kit's card separates by tone and shadow, with no outline.
    expect(src).not.toMatch(/border:\s*`1px solid[\s\S]{0,80}boxShadow/);
    expect(src).not.toMatch(/boxShadow[\s\S]{0,80}border:\s*["`]1px solid/);
  });

  it("routes the repo card through the kit too", () => {
    // The card only renders once repos have loaded, so it cannot be asserted
    // from cold markup — the source is the honest place to check it.
    expect(src).toMatch(/className=\{`card pad-\$\{pad\}`\}/);
  });

  it("reaches uppercase only through .t-label", () => {
    // The skill verdict was `textTransform: "uppercase"` with its own tracking
    // and weight, which is .t-label rewritten by hand at a smaller size.
    expect(src).not.toMatch(/textTransform/);
    expect(src).toMatch(/className="t-label"/);
  });

  it("defines no @keyframes of its own", () => {
    // DESIGN.md §6: the name is document-global, nine tools share one document,
    // and last definition wins for EVERY tool on screen.
    expect(src).not.toMatch(/@keyframes/);
    expect(rank).not.toMatch(/@keyframes/);
  });
});

/* ══ colour, in both rooms ══════════════════════════════════════════════════
 *
 * The bug this block exists for: this file painted from `theme("ideas")`, whose
 * ink/muted/faint/line are dark mode LITERALS. With light mode on, a repo's name
 * rendered near-white on a white card and was invisible — and no test could see
 * it, because the hex was right there in a variable called `T.ink`. */

describe("every surface colour is a token with a light half", () => {
  const raw = (() => {
    const { readFileSync } = require("node:fs");
    const { fileURLToPath } = require("node:url");
    const { dirname, join } = require("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "..", "Root.jsx"), "utf8");
  })();
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // GitHub's per-language hexes are DATA — they are the meaning of the swatch,
  // not a palette choice — so the map is lifted out before the scan rather than
  // exempted by name.
  const LANG_BLOCK = /const LANG = \{[\s\S]*?\n\};/;
  const outsideLang = src.replace(LANG_BLOCK, "const LANG = {};");

  it("keeps GitHub's language colours, which are data and not theme", () => {
    expect(src).toMatch(/#f1e05a/i);   // JavaScript
    expect(LANG_BLOCK.test(src), "the LANG map moved or was renamed").toBe(true);
  });

  it("carries no other colour literal anywhere in the file", () => {
    const hexes = [...outsideLang.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]);
    expect(hexes, `hardcoded colour(s): ${hexes.join(", ")}`).toEqual([]);
    const rgbas = [...outsideLang.matchAll(/rgba?\([^)]*\)/g)].map((m) => m[0]);
    expect(rgbas, `hardcoded colour(s): ${rgbas.join(", ")}`).toEqual([]);
  });

  it("no longer paints from theme()'s dark-only table", () => {
    // `theme("ideas")` returns literals. Importing it for colour is the defect;
    // there is nothing else in it this file needs.
    expect(src, "the dark-only palette table is back").not.toMatch(/from "@cc\/design"/);
    expect(src).not.toMatch(/\bT\.(ink|muted|faint|line|accent|good|bad|warn|surface)\b/);
  });

  it("uses only tokens the theme layer authors for BOTH modes", () => {
    const used = new Set([...src.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    // Every one of these is declared in packages/design (tokens.css :root and
    // [data-theme=dark], or themes.css per palette per mode) and every one is
    // either deleted or re-aliased by the shell's themeVars() so the light half
    // wins. A name outside this set is a name that may only exist in the dark
    // inline stamp.
    const ALLOWED = new Set([
      "--ink", "--sub", "--faint", "--line", "--surface", "--bg", "--glass",
      "--accent", "--accent-a10", "--ink-a05", "--good", "--bad", "--warn",
      "--font-mono", "--font-body", "--shell-bar", "--safe-bottom",
    ]);
    const stray = [...used].filter((v) => !ALLOWED.has(v));
    expect(stray, `token(s) with no light half checked: ${stray.join(", ")}`).toEqual([]);
  });
});

/* ══ the ranking is not decoration ══════════════════════════════════════════ */

describe("the recommendation comes from the pure module, not from this file", () => {
  const src = (() => {
    const { readFileSync } = require("node:fs");
    const { fileURLToPath } = require("node:url");
    const { dirname, join } = require("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "..", "Root.jsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  })();

  it("imports the ranker rather than scoring inline", () => {
    expect(src).toMatch(/from "\.\/lib\/rank\.js"/);
    expect(src).toMatch(/recommend\(rows, \{ now, saved/);
  });

  it("reads the clock ONCE and hands it to both pure modules", () => {
    // rank.js and cadence.js are both pure and both take `now`. A clock read
    // per row makes two identical repos score differently for no reason, and
    // makes the modules untestable. There are still exactly two reads in the
    // file: the memo that produces `now`, and `ago()`. The queue added a second
    // consumer of the clock and NOT a second reading of it.
    expect([...src.matchAll(/Date\.now\(\)/g)]).toHaveLength(2);
    expect(src, "`now` is not memoised, so it moves on every keystroke").toMatch(/const now = useMemo\(\(\) => Date\.now\(\)/);
    expect(src, "the cadence reads its own clock").toMatch(/scanCadence\(runs, now\)/);
  });

  it("prints the reason and the addition, not a sparkle", () => {
    // Now on every card in the queue rather than on the top two or three: ten
    // repos you are being asked to judge, each carrying the sentence rank.js
    // built and the addition behind the number.
    expect(src, "the row must say why it was recommended").toMatch(/\{scored \? verdict\.reason :/);
    expect(src, "the score has to be checkable by eye").toMatch(/verdict\.parts\.map\(\(part\) => `\$\{part\.label\} \$\{part\.points\}`\)/);
  });

  it("prints the REFUSAL where a refused row would otherwise show a number", () => {
    // The gate in rank.js exists so a repo with no history cannot be scored.
    // The card has to carry that through: no number, the row's own reason, and
    // an em dash in the score slot — which cannot be misread as a quantity the
    // way a 0 or a greyed-out 50 could.
    expect(src).toMatch(/Not ranked — \$\{verdict\?\.blocked/);
    expect(src).toMatch(/scored \? <AnimatedNumber value=\{verdict\.score\}/);
  });

  it("never claims 'the top N are here' about a queue that has moved past N", () => {
    // rank.js's own sentence ends "…the top 3 are here", which is a claim about
    // a slice off the top of the whole feed. Two rounds in, the ten on screen
    // are ranks 21–30 and that sentence is false — so the file prints the count
    // that clears the floor (a true claim about the feed) and only falls back to
    // rank.js's prose when there is nothing above the floor at all, where every
    // branch of it is a refusal rather than a slice.
    expect(src).toMatch(/ranked\.above > 0[\s\S]{0,240}: ranked\.reason/);
  });

  it("shows the measured rate only where it was actually measured", () => {
    // A row rank.js could not measure prints nothing here — never a zero, which
    // would sit indistinguishably beside a genuine zero.
    expect(src).toMatch(/verdict\?\.observed != null && verdict\.score != null/);
  });
});

/* ══ the queue ══════════════════════════════════════════════════════════════
 *
 * Every assertion here fails against the source as it stood before this change,
 * where Ideas was a 500-row list with a three-row "Worth a look" panel on top.
 * The behaviour itself is tested in src/lib/__tests__/queue.test.js, which can
 * reach it; what is checked here is the wiring — the places where a component
 * can quietly betray a correct pure module. */

describe("Ideas is a review queue", () => {
  const src = (() => {
    const { readFileSync } = require("node:fs");
    const { fileURLToPath } = require("node:url");
    const { dirname, join } = require("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "..", "Root.jsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  })();

  it("keeps seen-state in the pure module beside the ranker", () => {
    expect(src).toMatch(/from "\.\/lib\/queue\.js"/);
    expect(src).toMatch(/from "\.\/lib\/cadence\.js"/);
  });

  it("takes the batch size from the module rather than writing 10 into the view", () => {
    expect(src).toMatch(/splitQueue\(visible, review, BATCH\)/);
    // A literal 10 in the component is a second source of truth for the size of
    // a round, and the module's tests would not be testing the shipped number.
    expect(src, "the batch size is hardcoded in the view").not.toMatch(/\bBATCH\s*=\s*\d/);
  });

  it("marks the ids that were ON SCREEN, not a freshly computed slice", () => {
    // The queue is recomputed every render, so between the paint and the tap a
    // refresh can change which ten the ranker offers. Recomputing inside the
    // handler would stamp a repo the operator never saw.
    expect(src).toMatch(/const ids = \(split\?\.queue \|\| \[\]\)\.map\(\(r\) => r\.id\)/);
    expect(src).toMatch(/markReviewed\(prev, ids\)/);
  });

  it("persists through saveQueue on every write, so React and storage agree", () => {
    expect(src).toMatch(/setReview\(\(prev\) => saveQueue\(fn\(prev\)\)\)/);
    // Everything that changes the history goes through `commit`, so there is
    // exactly one place that writes and exactly one that normalizes.
    for (const fn of ["undoLastRound", "requeue", "clearReviewed", "markReviewed"]) {
      expect(src, `${fn} is called outside commit()`).not.toMatch(new RegExp(`setReview\\([^)]*${fn}`));
    }
    expect(src, "the queue key is being cleared behind the operator's back").not.toMatch(/removeItem/);
  });

  it("offers BOTH ways back, and says so before the button is pressed", () => {
    // A round comes back whole; one repo comes back on its own. Either is
    // reachable from the queue screen itself, not only after the fact.
    // One label component, three call sites, so the queue header, the history
    // header and the empty state cannot describe the same action differently.
    expect(src).toMatch(/Undo round \{round\} — put \{count\.toLocaleString\(\)\} back/);
    expect([...src.matchAll(/<UndoLabel /g)]).toHaveLength(3);
    // Under a filter the round is not the same number as what visibly returns,
    // and the label has to carry both rather than promise ten and return one.
    expect(src).toMatch(/here != null && here !== count/);
    expect(src).toMatch(/onRequeue=\{historyMode \? putBack : null\}/);
    expect(src, "the button does not say what it does to the ten").toMatch(/Marks them reviewed; nothing is deleted/);
  });

  it("names the filters on screen, because they re-rank inside the queue", () => {
    expect(src).toMatch(/the queue re-ranks inside that/);
    expect(src).toMatch(/onClearFilters/);
  });

  it("times the next scan off fetched runs, never off the schedule in a comment", () => {
    // One row can date the last scan; it cannot time the next one.
    expect(src).toMatch(/\.order\("ran_at", \{ ascending: false \}\)\.limit\(8\)/);
    expect(src).toMatch(/sub=\{cadence\.text\}/);
    expect(src, "a cadence is written into the view as prose").not.toMatch(/four times a day|every 6 hours/i);
  });

  it("keeps the Saved and Skills tabs, the filters and the search", () => {
    expect(src).toMatch(/const TABS = \["ideas", "saved", "skills"\]/);
    expect(src).toMatch(/<Filters/);
    for (const id of ["ideas-q", "ideas-sort", "ideas-cat", "ideas-age"]) expect(src).toContain(id);
  });

  it("puts nothing under the touch floor into the sticky bar on a phone", () => {
    // .btn sm is 34px. Fine for a pointer, under the floor for a thumb.
    expect(src).toMatch(/isMobile \? "btn md quiet" : "btn sm quiet"/);
  });
});
