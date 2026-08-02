// The shell chrome, pinned to the design language.
//
// This is the first Pentagon surface to adopt the kit, so it is also the first
// place the rules can actually be enforced. Source-text assertions in the house
// style of mount.test.js — the shell cannot be mounted here, but the things that
// go wrong with it are all visible in the source.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (f) => strip(readFileSync(join(here, "..", f), "utf8"));
const app = readFileSync(join(here, "..", "App.jsx"), "utf8");
const code = strip(app);

describe("the shell opts into the kit without dragging the tools in", () => {
  it("puts data-kit on the bar, never on the wrapper", () => {
    // THE ONE THAT MATTERS. Every tool renders inside the wrapper, and the kit
    // styles .btn/.card/.field/.sheet — names eight apps already own meaning
    // different things. data-kit on the wrapper restyles all of them at once;
    // an adversarial review caught that exact class of breakage before it
    // shipped, and this is the guard that keeps it caught.
    expect(code).toContain("<div data-kit");
    // Read the WRAPPER'S OWN OPENING TAG rather than slicing between two
    // markers. The first version of this assertion sliced from "<div data-app="
    // to "<div data-kit" — so moving data-kit onto the wrapper inverted the
    // indices, produced an empty string, and the test passed on the very change
    // it exists to catch. A mutation test found it; this reads the one tag.
    const openTag = /<div\s+([^>]*\bdata-app=[^>]*)>/.exec(code);
    expect(openTag, "could not find the wrapper's opening tag").not.toBeNull();
    expect(openTag[1], "data-kit must not sit on the element that contains the tools").not.toContain("data-kit");
  });

  it("uses the kit's controls rather than hand-rolling them", () => {
    expect(code).toMatch(/className=\{?["'][^"']*\bbtn\b/);
    // A hand-rolled control is how the chrome drifted from every other surface
    // in the first place.
    expect(code).not.toMatch(/border:\s*["']1px solid var\(--border\)["']/);
  });
});

describe("the chrome obeys the language", () => {
  it("carries no decorative font", () => {
    // SESSION §2: system stack only, no webfonts. Syne was three call sites in
    // the bar, and its late arrival is why AppToggle re-measures on fonts.ready.
    expect(code).not.toContain("Syne");
  });

  it("has no text under the 10.5px floor — anywhere in the shell", () => {
    // Was scoped to the bar, because AppToggle rendered its labels at 9px and
    // the comment above it said that size was what kept eight labels
    // un-truncated at 375px. That was true, and it was the wrong control's
    // problem: a segmented row divides a fixed width, so eight things meant
    // 9px, negative tracking, no dots, a `short` form for Business and ellipsis
    // from 393px down. The row scrolls now, every label fits at 11.5px, and the
    // floor applies to the whole file.
    // Every numeric literal in the whole fontSize EXPRESSION, not just one that
    // happens to sit right after the colon. `fontSize: compact ? 9 : 11.5` hid
    // the 9 from the first version of this regex — which is precisely the shape
    // the violation had, so the test would have passed on the exact code it was
    // written to reject. A mutation test found it.
    const sizes = [...code.matchAll(/fontSize:\s*([^,\n}]+)/g)]
      .flatMap((m) => [...m[1].matchAll(/[\d.]+/g)].map((n) => Number(n[0])))
      .filter((n) => Number.isFinite(n) && n > 0);
    expect(sizes.length).toBeGreaterThan(3);
    expect(sizes.filter((n) => n < 10.5), "below the 10.5px floor").toEqual([]);
  });

  it("keeps the desktop rail readable and the mobile dock complete", () => {
    // Eight full labels cannot fit in one phone row at a usable size. The dock
    // uses the same shaped glyphs as the desktop rail instead, so every tool
    // remains reachable without turning the header into two rows or a scroller.
    const toggle = code.slice(code.indexOf("function AppToggle"), code.indexOf("function ", code.indexOf("function AppToggle") + 10));
    expect(toggle, "a scroller hides tools").not.toContain("overflowX");
    expect(toggle, "a scroller hides tools").not.toContain("scrollSnap");
    expect(toggle, "the phone dock has one position per tool").toContain('gridTemplateColumns: "repeat(8, minmax(0, 1fr))"');
    expect(toggle, "the phone dock uses the shared tool glyphs").toContain("<ToolGlyph app={a}");
    expect(toggle, "a hidden desktop tool remains a phone destination").toContain("hiddenApps");

    // ── AND THE PART THIS TEST COULD NOT SEE ────────────────────────────────
    //
    // Everything above passed on code that shipped a vertical ladder of tools
    // to production at every desktop width. `repeat(auto-fit, minmax(92px,
    // 1fr))` was in the file exactly as asserted; it rendered ONE column,
    // because the grid also carried `width: 100%` and its parent is
    // `flex: 0 1 auto`. A percentage against a shrink-to-fit parent is a cycle,
    // and CSS breaks it by taking the child's min-content — a single column.
    // Measured 100x176 with the bar at 177px instead of 51, identical at 1024
    // through 1920.
    //
    // A string match cannot do layout, so the real guard is
    // scripts/toolrow-check.mjs, which measures the built page in a browser and
    // fails 14 checks against the pre-fix source. What is left here is the one
    // thing this file CAN state: the desktop branch must not size itself with a
    // percentage, and must wrap rather than truncate.
    expect(toggle, "desktop sizes to content — a percentage cycles against a shrink-to-fit parent").toContain('width: "auto"');
    expect(toggle, "desktop wraps; it does not scroll or ellipsise").toContain("flexWrap");
    expect(
      [...toggle.matchAll(/width:\s*"100%"/g)].length,
      'only the compact branch may use width: "100%" — its row IS full-width, so the percentage resolves',
    ).toBe(1);
  });

  it("keeps full names on desktop and an accessible name on mobile", () => {
    const toggle = code.slice(code.indexOf("function AppToggle"), code.indexOf("function ", code.indexOf("function AppToggle") + 10));
    // m.short is the abbreviated form ("Biz"); neither the desktop label nor
    // the icon-only button's accessible name may use it.
    expect(toggle, "the full label and accessible name").toContain("m.label");
    expect(toggle).not.toContain("m.short");
    expect(toggle, "icon-only buttons still announce their tool").toContain("aria-label={compact ? name : undefined}");
  });

  it("does not put uppercase or tracking on the tool labels", () => {
    // §4.3 reserves uppercase for .t-label, and losing the caps is also ~10% of
    // the width — most of what bought the second row its comfort.
    const toggle = code.slice(code.indexOf("function AppToggle"), code.indexOf("function ", code.indexOf("function AppToggle") + 10));
    expect(toggle).not.toContain("textTransform");
    expect(toggle).not.toMatch(/letterSpacing:\s*"[\d.]+em"/);
  });

  it("never signals the active tool by colour alone", () => {
    // The phone dock trades labels for shaped glyphs, but the selected button
    // still carries aria-current and a drawn active cell instead of colour-only
    // state.
    const toggle = code.slice(code.indexOf("function AppToggle"), code.indexOf("function ", code.indexOf("function AppToggle") + 10));
    expect(toggle).toContain("aria-current");
    expect(toggle).toContain('background: on ? "var(--surface-2, var(--surface))"');
  });

  it("keeps uppercase out of the wordmark", () => {
    // Uppercase survives in exactly one place in this language: 12px section
    // labels. A wordmark in 0.16em-tracked caps is tracking theatrics. (The
    // tool segments keep theirs — they ARE the section labels of this bar.)
    // The wordmark's OWN opening tag, not a window of characters before it — a
    // window picks up whatever markup happens to be adjacent, which here is the
    // tool segments, and they legitimately keep their caps.
    // EVERY wordmark, not the first one found. There are two — the bar and the
    // login screen — and the first pass only fixed the bar. A regex that stops
    // at the first match would have reported the other one clean.
    // Three now: the bar renders one on desktop and one on mobile (they sit in
    // different rows once the tool grid takes the full width), plus the login
    // screen's. Asserted as ">= 2 and every one clean" rather than an exact
    // count, so adding a surface cannot make this fail for the wrong reason —
    // but the loop below still has to see all of them.
    const tags = [...code.matchAll(/<span([^>]*)>The Pentagon<\/span>/g)].map((m) => m[1]);
    expect(tags.length, "expected the bar's wordmarks and the login screen's").toBeGreaterThanOrEqual(2);
    for (const t of tags) {
      expect(t, `wordmark still uppercase: ${t.slice(0, 60)}`).not.toContain("textTransform");
      expect(t, "wordmark hardcodes a colour instead of a token").not.toMatch(/#[0-9a-fA-F]{6}/);
    }
  });

  it("still reserves the accent for state, not decoration", () => {
    // The accent says which tool you are in. In the bar it should appear on the
    // active segment and the System button's live dot, and nowhere else.
    const bar = code.slice(code.indexOf("<div data-kit"), code.indexOf("ToolBoundary"));
    expect((bar.match(/var\(--accent[^)]*\)/g) || []).length).toBeLessThanOrEqual(3);
  });
});

// ─── the theme setting, and the pause switch ─────────────────────────────────
//
// EVERY VISUAL CLAIM ABOUT THESE TWO IS IN apps/shell/scripts/chrome-check.mjs,
// not here, and that split is the point of this whole file's history. "Light
// mode goes light" is invisible to a string match: the attribute lands, the
// stylesheet rule matches, and eight inline hexes overrule it — source-identical
// to the working version. That harness fails 17 checks against the source these
// tests were written for.
//
// What is left here is what a file CAN state: the structural facts whose
// violation is a design error rather than a rendering one.
describe("pause is server state, and stays that way", () => {
  it("never reaches for localStorage", () => {
    // tabPrefs.js's header promises that hiding a tool changes nothing about
    // what runs, and that "Scheduled functions do not read this file and must
    // not". A pause kept beside it would break that promise in the most
    // dangerous direction: a cron on Netlify has no localStorage, so the switch
    // would flip, the tool would dim, and every engine would keep running.
    const power = read("toolPower.js");
    expect(power, "pause lives in ops_control, reached over /api/tool-power").not.toContain("localStorage");
    expect(power).toContain("/api/tool-power");
    // And the reverse: the tab preference has not quietly grown a network call.
    const tabs = read("tabPrefs.js");
    expect(tabs).not.toContain("fetch(");
    expect(tabs).toContain("localStorage");
  });

  it("reads the pause from `paused`, never from `enabled`", () => {
    // netlify/shared/toolPower.mjs is explicit: ops_control rows ship
    // `enabled: false` because autonomy is opt-in, so four engines that run
    // perfectly well read "disabled" and an armed engine reads "enabled" while
    // paused. This assertion is cheap; the bug it guards renders ZTS as stopped
    // while its content engine drafts an article every four hours.
    const power = read("toolPower.js");
    const norm = power.slice(power.indexOf("export function normalizeToolPower"), power.indexOf("export const EMPTY_POWER"));
    expect(norm.length, "scan sanity — normalizeToolPower must actually be in the slice").toBeGreaterThan(200);
    expect(norm, "`enabled` is the autonomy opt-in, not the pause").not.toMatch(/\be\.enabled\b/);
    expect(norm).toMatch(/\be\.paused\b/);
  });

  it("says what a pause does NOT stop, wherever it says what it stops", () => {
    // Macro's alt sentinel keeps sampling BTC dominance while paused, because
    // that series cannot be backfilled. Naming only the stops is an
    // over-promise, and the operator finds out by seeing a row appear on a day
    // they believed nothing ran.
    let checked = 0;
    for (const f of ["App.jsx", "System.jsx"]) {
      const src = read(f);
      if (!src.includes("stopsSentence") && !src.includes("stoppedSentence")) continue;
      checked++;
      expect(src, `${f} promises what a pause stops without saying what it keeps`).toContain("keepsSentence");
    }
    // Scan sanity: both surfaces name what a pause stops, so both must be
    // reached. Without this the loop passes by matching nothing.
    expect(checked, "neither surface was found to be making the promise").toBe(2);
  });
});

describe("the shell's own screens can go light", () => {
  it("keeps no hardcoded neutral in a palette table", () => {
    // This is the rule that makes a theme setting real on the surfaces the shell
    // owns. System and Ops each carried six or seven midnight hexes; light mode
    // drew Ops's heading, its state line and the word inside its STOP button in
    // #E9EDF5 on #EFF1F5. Measured, not guessed — and the reason the harness now
    // carries a contrast floor for that screen specifically.
    for (const f of ["System.jsx", "Ops.jsx"]) {
      const src = read(f);
      const table = src.slice(src.indexOf("const P = {"), src.indexOf("};", src.indexOf("const P = {")));
      expect(table.length, `scan sanity — no palette table found in ${f}`).toBeGreaterThan(80);
      const neutrals = ["bg", "surface", "surface2", "line", "ink", "muted", "faint"];
      for (const key of neutrals) {
        const m = new RegExp(`\\b${key}:\\s*"([^"]+)"`).exec(table);
        expect(m, `${f}'s palette has no ${key}`).not.toBeNull();
        expect(m[1], `${f}: ${key} is a literal colour and cannot follow the mode`).toMatch(/^var\(--/);
      }
    }
  });

  it("gives a colour token an alpha with color-mix, never by concatenation", () => {
    // The moment a token table holds `var(--faint)` instead of a hex,
    // `${P.faint}44` stops being a colour — and an unparsable value drops the
    // WHOLE declaration rather than falling back, so a disabled subsystem loses
    // its outline in the one console whose job is saying what is switched off.
    // packages/design/__tests__/token-alpha.test.js scans apps/*/src for this;
    // apps/shell is where it just became possible.
    let scanned = 0;
    for (const f of ["System.jsx", "Ops.jsx", "App.jsx", "Minds.jsx"]) {
      const src = read(f);
      scanned += src.length;
      const hits = [...src.matchAll(/\$\{[^}]*\bP\.[a-zA-Z0-9]+[^}]*\}[0-9a-fA-F]{2}\b/g)]
        // A table entry that is still a literal hex may legitimately take a
        // suffix; only var()-valued names are the hazard.
        .filter((m) => !/P\.(crit|good|warn|bad)\b/.test(m[0]) || /var\(--/.test(m[0]));
      expect(hits.map((h) => h[0]), `${f} concatenates an alpha onto a token`).toEqual([]);
    }
    expect(scanned, "scan sanity — the four shell surfaces should not read as empty").toBeGreaterThan(20000);
  });
});

describe("the theme actually gets stamped", () => {
  it("does not overrule the chosen palette with the dark table", () => {
    // The one structural fact behind the whole feature: the inline stamp is a
    // BRANCH now. `cssVars(active)` unconditionally is what made themes.css's
    // light halves — generated and contrast-checked since the token layer
    // landed — unreachable from the page for months.
    expect(code).toContain("themeVars");
    const wrapper = /<div\s+([^>]*\bdata-app=[^>]*)>/.exec(code);
    expect(wrapper, "could not find the wrapper's opening tag").not.toBeNull();
    expect(wrapper[1], "the wrapper must spread the RESOLVED variables").toMatch(/\{\s*\.\.\.vars\b/);
    expect(wrapper[1], "data-theme must come from the resolved mode, not from the tool's fixed one").not.toContain("m.mode");
    expect(wrapper[1]).toMatch(/data-theme=\{mode\}/);
    expect(wrapper[1]).toMatch(/data-palette=\{palette\}/);
  });

  it("subscribes to prefers-color-scheme rather than sampling it once", () => {
    // "System" that only reads the device at boot is "whatever your laptop was
    // doing when this tab last loaded". An iOS standalone window can go weeks
    // without a reload while the OS flips at sunset every day.
    expect(code).toContain("watchSystemTheme");
    const themePrefs = read("themePrefs.js");
    expect(themePrefs).toMatch(/addEventListener\(["']change["']/);
    expect(themePrefs, "Safari < 14 has only addListener, and iOS standalone is a protected target").toContain("addListener");
  });

  it("renders swatches from the generated table, never a hand-copied hex", () => {
    const sys = read("System.jsx");
    const theme = sys.slice(sys.indexOf("function Theme("), sys.indexOf("const TABS ="));
    expect(theme.length, "scan sanity — the Theme panel was not found").toBeGreaterThan(400);
    expect(theme).toContain("PALETTES");
    expect(theme.match(/#[0-9a-fA-F]{3,8}\b/g), "a hex in the picker is a swatch that lies the next time themes are regenerated").toBeNull();
  });
});

describe("the bar's height is published, not assumed", () => {
  // This used to assert `height: 51` and explain that ten call sites across the
  // tools hardcode calc(100vh - 52px), so growing the bar by a pixel would put a
  // permanent 1px overflow on every one. True, and it made the bar unchangeable
  // — which is why the tool row scrolled instead of wrapping. The height is
  // measured and written to --shell-bar now, and those call sites read it.

  it("measures the real height and publishes it as --shell-bar", () => {
    expect(code, "the bar must be measured, not assumed").toContain("--shell-bar");
    expect(code, "a ResizeObserver is what keeps it true as tools wrap").toContain("ResizeObserver");
    // A fixed height would make the measurement a lie the moment the row wraps.
    const bar = code.slice(code.indexOf("ref={barRef}"), code.indexOf("ref={barRef}") + 400);
    expect(bar).not.toMatch(/\bheight:\s*\d/);
    expect(bar).toMatch(/minHeight:\s*\d/);
  });

  it("leaves no tool assuming 52px", () => {
    // The whole point: every dependent call site follows the variable. The
    // fallback is kept because each tool's standalone dev entry has no shell bar.
    const files = [
      "apps/business/src/Root.jsx", "apps/clarify/src/App.jsx",
      "apps/clarify/src/features/dna/DnaView.jsx", "apps/looper/src/styles.css",
      "apps/macro/src/styles.css", "apps/runway/src/Root.jsx", "apps/shell/src/System.jsx",
    ];
    const offenders = [];
    for (const f of files) {
      const src = readFileSync(join(here, "..", "..", "..", "..", f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      // A bare 52px inside a viewport or sticky-offset calculation.
      for (const m of src.matchAll(/(calc\([^)]*?|top:\s*)"?52px/g)) {
        if (!m[0].includes("--shell-bar")) offenders.push(`${f}: ${m[0]}`);
      }
    }
    expect(offenders, `\n${offenders.join("\n")}\n`).toEqual([]);
    expect(files.length, "scan sanity — the dependent set should not shrink to nothing").toBeGreaterThanOrEqual(7);
  });
});
