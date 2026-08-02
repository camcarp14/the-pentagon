// ─── What the browser actually computes, over BOTH sheets ─────────────────────
//
// Every other CSS guard in this app reads apps/sync/src/styles.css. That was
// the whole truth until .sy-root grew `data-kit`; since then
// packages/ui/components.css declares on the same elements, is parsed FIRST,
// and supplies every property this sheet stops naming. A guard that reads one
// of the two sheets is reading half the cascade, and a fresh-context review
// proved by mutation what that costs — every one of these was GREEN:
//
//   · delete `justify-content` from SYNC's .entrance → the kit's
//     `justify-content: center` takes over and the onboarding Start button goes
//     back under the top edge of a phone (the bug styles.css:701 documents as
//     fixed);
//   · remove the shared .pentagon-dock safe-bottom padding → the kit pads every
//     tab with raw env(safe-area-inset-bottom);
//   · delete `.sy-root[data-kit] .sheet`'s max-height and padding-bottom → same;
//   · delete `min-height: 0` from .entrance → the kit's `min-height: 100dvh`;
//   · `.sy-root .card { border }` next to `[data-kit] .card { box-shadow }` →
//     the §4.2 anti-pattern, assembled one declaration per sheet.
//
// So this file resolves the cascade. `_cascade.js` next door does the parsing,
// matching, weighing and tie-breaking; everything here is a claim about a
// COMPUTED value, or about the WEIGHT a declaration wins by — never about the
// text of a rule.
//
// Two kinds of claim appear below and the difference matters:
//   value(...)        — what wins today, given that SYNC's sheet is injected
//                       into document.head after the kit's import and therefore
//                       takes every tie.
//   outranksKit(...)  — that SYNC's declaration would STILL win if the two
//                       sheets swapped places. Anything protecting the iOS
//                       geometry (DESIGN.md §7) must clear that higher bar,
//                       because "we happen to be parsed last" is not a contract.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import {
  loadSheets, el, value, resolve, outranksKit,
  targetedElements, borderedSides, hasShadow,
} from "./_cascade.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..");
const SYNC_CSS = join(SRC, "styles.css");
// Read-only, and from the package rather than a copy: a copy is a snapshot that
// stops tracking the thing it is meant to be watching.
const KIT_CSS = join(SRC, "..", "..", "..", "packages", "ui", "components.css");

const S = loadSheets({ syncCssPath: SYNC_CSS, kitCssPath: KIT_CSS });

const MEDIA = S.mediaContexts;
const where = (r) => (r ? `${r.sheet}: ${r.selector} { ${r.prop}: ${r.value} }` : "(nothing declares it)");

/* ════════════════════════════════════════════════════════════════════════════
   SCAN SANITY — the floor under everything below.

   Every assertion in this file is of the form "the winner is not X" or "the
   winner is Y". Both pass vacuously against a parse that found nothing, which
   is precisely how the guards this file replaces came to prove nothing. So the
   parse is checked first, against numbers and against named landmarks.
   ════════════════════════════════════════════════════════════════════════════ */
describe("the cascade this file reasons over is real", () => {
  it("parsed both sheets", () => {
    const bySheet = (n) => S.rules.filter((r) => r.sheet === n).length;
    // 152 kit / 263 sync on the day this was written (each comma-separated
    // selector counted once, at-rule bodies descended into).
    expect(bySheet("kit"), "packages/ui/components.css parsed").toBeGreaterThan(120);
    expect(bySheet("sync"), "apps/sync/src/styles.css parsed").toBeGreaterThan(200);
  });

  it("refuses to skip a selector it cannot read", () => {
    // A selector the parser drops is a selector no assertion here can see. The
    // sibling combinators are widened rather than dropped (see _cascade.js), so
    // this list must be empty, not merely short.
    expect(S.unhandled).toEqual([]);
  });

  it("sees the at-rule contexts, not just the top level", () => {
    // A rule inside `@media` is a real rule. The old guards' single worst blind
    // spot was `@media (hover: hover)`, and the desktop sheet geometry is only
    // reachable through `@media (min-width: 761px)`.
    for (const m of ["@media (hover: hover)", "@media (min-width: 761px)",
                     "@media (max-width: 760px)", "@media (prefers-reduced-motion: reduce)"])
      expect(MEDIA, `the parse must reach ${m}`).toContain(m);
    expect(MEDIA).toContain("");
  });

  it("resolves against the kit as well as against SYNC", () => {
    // Landmarks: one property SYNC owns outright, one the kit owns outright,
    // and one where the kit wins because SYNC deliberately stopped declaring
    // it. If any of these three stops resolving, the matcher has rotted and
    // every "must not" below has quietly become unfalsifiable.
    // Asserted by WHICH SHEET WON rather than by value, so the kit is free to
    // retune a number without falsifying a claim about the matcher.
    const from = (chain, prop) => resolve(S, chain, prop)?.sheet ?? "(nothing)";
    expect(from(el(".mind-prompt"), "font-family"), "a SYNC-only rule").toBe("sync");
    expect(from(el(".dock-label"), "font-size"), "a kit-only rule").toBe("kit");
    // …and the case this whole file exists for: a property SYNC stopped
    // declaring, arriving from the kit onto one of SYNC's own elements.
    expect(from(el(".entrance"), "align-items"), "the kit reaching a SYNC element").toBe("kit");
  });

  it("enumerates the elements both sheets target", () => {
    const els = targetedElements(S);
    expect(els.length, "targeted elements").toBeGreaterThan(200);
    const keys = els.map((e) => e.key);
    for (const known of [
      "div.sy-scope div.sy-root[data-kit] *.card",
      "div.sy-scope div.sy-root[data-kit] *.entrance",
      "div.sy-scope div.sy-root[data-kit] *.sheet",
      "div.sy-scope div.sy-root[data-kit] *.dock-tab",
      "div.sy-scope div.sy-root[data-kit] *.pill",
      "div.sy-scope div.sy-root[data-kit] *.tl-block",
    ]) expect(keys, `the element walk must reach ${known}`).toContain(known);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   ONBOARDING — the Start button stays reachable on a phone.
   ════════════════════════════════════════════════════════════════════════════ */
describe("the onboarding card can always be scrolled to its Start button", () => {
  const ENTRANCE = el(".entrance");
  // flex-start and start are the only safe values on the MAIN axis of a column
  // that may overflow. center/end/space-around/space-evenly all place a child
  // taller than its container so its top edge sits ABOVE the scroll origin,
  // where no amount of scrolling reaches it — and `margin: auto` on the card
  // does not save it, because auto margins resolve to 0 when free space is
  // negative and hand the decision straight back to justify-content.
  const CLIPS = /^(safe\s+|unsafe\s+)?(center|end|flex-end|space-around|space-evenly|last\s+baseline)$/i;

  it("never centres the card on the axis it can overflow", () => {
    for (const m of MEDIA) {
      const r = resolve(S, ENTRANCE, "justify-content", m);
      expect(r, `nothing decides .entrance justify-content${m ? ` in ${m}` : ""}`).not.toBeNull();
      expect(CLIPS.test(r.value), `.entrance justify-content resolves to "${r.value}"${m ? ` in ${m}` : ""} — ${where(r)}`).toBe(false);
    }
  });

  it("wins that on specificity, not on which sheet was parsed last", () => {
    // The kit's `[data-kit] .entrance { justify-content: center }` is (0,2,0).
    // A competitor written as `.sy-root .entrance` would also be (0,2,0) and
    // would win only because SYNC's sheet is injected later — true today, and
    // not a property of this stylesheet. .sy-root[data-kit] settles it.
    const { ok, sync, kit } = outranksKit(S, ENTRANCE, "justify-content");
    expect(kit, "the kit is expected to declare it — if it stopped, retune this test").not.toBeNull();
    expect(ok, `SYNC's ${where(sync)} must outweigh the kit's ${where(kit)}`).toBe(true);
  });

  it("keeps the definite height and the scroll container that make it scrollable", () => {
    // A scroll container needs all four: a definite height from the frame, a
    // min-height that lets it shrink (the kit's .entrance is min-height:100dvh,
    // which inside SYNC's already-shortened column overflows by the shell's
    // bar), somewhere for the overflow to go, and a column.
    expect(value(S, ENTRANCE, "height")).toBe("100%");
    expect(value(S, ENTRANCE, "min-height")).toBe("0");
    expect(value(S, ENTRANCE, "overflow-y")).toBe("auto");
    expect(value(S, ENTRANCE, "display")).toBe("flex");
    expect(value(S, ENTRANCE, "flex-direction")).toBe("column");
    for (const prop of ["height", "min-height"]) {
      const { ok, sync, kit } = outranksKit(S, ENTRANCE, prop);
      expect(ok, `.entrance ${prop}: ${where(sync)} must outweigh ${where(kit)}`).toBe(true);
    }
  });

  it("still centres the card when there IS room", () => {
    // The positive-space half of the pair. Losing this is not a clipping bug,
    // but it is the reason flex-start is safe to ask for above.
    const card = el(".entrance", ".entrance-card");
    for (const side of ["margin-top", "margin-bottom", "margin-left", "margin-right"])
      expect(value(S, card, side), `.entrance-card ${side}`).toBe("auto");
    expect(value(S, card, "flex")).toBe("none");
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   THE iOS SAFE-AREA CONTRACT — DESIGN.md §7, "move it, never delete it".
   ════════════════════════════════════════════════════════════════════════════ */
describe("the iOS safe-area overrides are each individually pinned", () => {
  // The kit clears the notch and the home indicator with raw
  // env(safe-area-inset-*). On a letterboxed standalone install those insets
  // report DEAD SPACE, so env() floats the tab bar, the sheet and the toast
  // stack off the edge of the glass — the bug this whole migration existed to
  // end. --safe-bottom is the shell's corrected value and is 0 there.

  const kitEnvRules = S.rules.filter(
    (r) => r.sheet === "kit" && r.decls.some((d) => /env\(\s*safe-area-inset/i.test(d.value)));

  // ── the one carve-out, and what keeps it honest ─────────────────────────
  // `targetedElements` is the union of BOTH sheets' selectors, so it includes
  // classes the kit styles and SYNC does not render. There is exactly one that
  // matters here: the kit's `.sidebar`, which pads with a raw
  // env(safe-area-inset-*) and which SYNC used to neutralize because it drew a
  // 232px rail of its own. That rail is gone — the six destinations are a
  // horizontal row now (`.sy-nav`), because with the shell's own left rail up a
  // second vertical nav inside the content column was two stacked vertical
  // navs. Nothing in this app emits `.sidebar` any more, so its override was
  // dead CSS and was deleted with the rest of the rail.
  //
  // A carve-out that merely asserts "we don't render that" would rot the moment
  // someone did, so it is checked rather than claimed: the guard below reads
  // this app's own JSX and fails if the class comes back.
  const UNRENDERED = /\bsidebar\b/;
  it("does not render the kit class it stops defending against", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = join(here, "..");
    const files = [];
    (function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === "__tests__" || e.name === "node_modules") continue;
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.jsx?$/.test(e.name)) files.push(full);
      }
    })(src);
    expect(files.length, "source files to scan").toBeGreaterThan(20);
    const offenders = files.filter((f) => /["'`][^"'`]*\bsidebar\b/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.slice(src.length + 1)),
      "SYNC renders a .sidebar again — put its safe-area override back and drop this carve-out").toEqual([]);
  });

  it("knows which kit rules it is defending against", () => {
    // Scan sanity with teeth. If the kit stopped using env() altogether, the
    // leak sweep below would pass against nothing and this file would go on
    // claiming the geometry is protected while nothing protected it.
    expect(kitEnvRules.length, "kit rules using env(safe-area-inset-*)").toBeGreaterThanOrEqual(5);
    const sels = kitEnvRules.map((r) => r.selector);
    for (const s of ["[data-kit] .dock-tab", "[data-kit] .sidebar", "[data-kit] .sheet",
                     "[data-kit] .sheet-foot", "[data-kit] .toasts"])
      expect(sels, `the kit still pads ${s} with a raw inset`).toContain(s);
  });

  it("lets no raw inset reach any element in this app, in any at-rule context", () => {
    // Total rather than spot-checked: every element either sheet targets, every
    // geometry property, every media context. Deleting ANY of SYNC's overrides
    // hands that element straight back to the kit and lands here.
    const GEOMETRY = [
      "padding-top", "padding-right", "padding-bottom", "padding-left",
      "margin-top", "margin-right", "margin-bottom", "margin-left",
      "top", "right", "bottom", "left", "inset",
      "height", "max-height", "min-height",
    ];
    const leaks = [];
    for (const t of targetedElements(S).filter((t) => !UNRENDERED.test(t.key)))
      for (const m of MEDIA)
        for (const p of GEOMETRY) {
          const r = resolve(S, t.chain, p, m);
          if (r && /env\(\s*safe-area-inset/i.test(r.value)) leaks.push(`${t.key}${m ? ` ${m}` : ""} → ${where(r)}`);
        }
    expect(leaks, `raw env(safe-area-inset-*) reaching SYNC:\n${leaks.join("\n")}`).toEqual([]);
  });

  // Each row is one override that has to beat the kit on WEIGHT, not on parse
  // order — the `[data-kit]` on those selectors is the whole point, and taking
  // it off was a proven-green mutation.
  const PINNED = [
    [".dock-tab",   "padding-bottom", "",                            /var\(--safe-bottom/],
    [".sheet",      "padding-bottom", "",                            /var\(--safe-bottom/],
    [".sheet",      "max-height",     "",                            /^calc\(100% - 24px\)$/],
    [".sheet",      "max-height",     "@media (min-width: 761px)",   /^calc\(100% - 96px\)$/],
    [".sheet-foot", "padding-bottom", "",                            /var\(--safe-bottom/],
    // `.sidebar` used to have a row here. SYNC no longer renders one — see the
    // carve-out above, which is what stops that from being an unchecked claim.
    [".toasts",     "bottom",         "",                            /var\(--safe-bottom/],
    [".entrance",   "padding-bottom", "",                            /var\(--safe-bottom/],
  ];

  for (const [cls, prop, media, expected] of PINNED) {
    it(`pins ${cls} { ${prop} }${media ? ` in ${media}` : ""} above the kit`, () => {
      const chain = el(cls);
      const { ok, sync, kit } = outranksKit(S, chain, prop, media);
      expect(sync, `${cls} { ${prop} } is no longer declared by SYNC at all — the kit's ${where(kit)} now decides it`).not.toBeNull();
      expect(ok, `${cls} { ${prop} }: SYNC's ${where(sync)} only beats the kit's ${where(kit)} on parse order`).toBe(true);
      const won = resolve(S, chain, prop, media);
      expect(expected.test(won.value), `${cls} { ${prop} } resolves to "${won.value}" — ${where(won)}`).toBe(true);
    });
  }

  it("keeps shared dock safe-area padding on the bar, not on every tab", () => {
    const dock = resolve(S, el(".pentagon-dock"), "padding-bottom", "@media (max-width: 767.98px)");
    expect(dock, "nothing clears the shared dock from the home indicator").not.toBeNull();
    expect(dock.sheet, where(dock)).toBe("kit");
    expect(/var\(--safe-bottom/.test(dock.value), where(dock)).toBe(true);
  });

  it("measures the desktop sheet against the window, not the screen", () => {
    // The other half of the same iOS lie: 100vh on an installed app reports the
    // SCREEN. A max-height in vh therefore lets a centred modal run past the
    // bottom of the window it is centred in.
    for (const m of ["", "@media (min-width: 761px)"]) {
      const r = resolve(S, el(".sheet"), "max-height", m);
      expect(/\d\s*v(h|min|max)\b/i.test(r.value), `.sheet max-height is viewport-relative: ${where(r)}`).toBe(false);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   MOTION — a hover that changes colour has to fade into it.
   ════════════════════════════════════════════════════════════════════════════ */
describe("every hover tint SYNC adds fades rather than cuts", () => {
  // The kit draws no hover tints at all, so each of these three is SYNC's own
  // — and the kit's `transition` on them covers `transform` and nothing else.
  // Declaring the tint without extending the transition is a hard cut. The
  // migration caught it for .side-item and .icon-btn (both carry a comment
  // saying "the kit declares none, so the hover would hard-cut") and missed it
  // for .pill, which is the control the Brief, Queue and Console filter with.
  // `.side-item` used to be in this list and left with the rail. `.seg-opt` did
  // NOT replace it here: the kit draws the segmented control's active state as a
  // sliding .seg-thumb rather than as a hover tint, so there is no SYNC tint on
  // it to fade.
  const TINTED = [".pill", ".icon-btn"];

  /** The property names a `transition` shorthand actually animates. */
  const transitioned = (v) =>
    v == null ? [] : v.split(",").map((part) => {
      const first = part.trim().split(/\s+/)[0];
      // a bare duration first means the shorthand is `all`
      return /^[\d.]+m?s$/i.test(first) ? "all" : first;
    }).filter(Boolean);

  /** Is there a non-zero duration anywhere in the shorthand? */
  const hasDuration = (v) => /(^|[\s,])(\d*\.?\d+)m?s\b/i.test(v || "") || /var\(\s*--dur-/i.test(v || "");

  for (const cls of TINTED) {
    it(`${cls} declares the hover tint AND the transition that carries it`, () => {
      const hoverRules = S.rules.filter((r) =>
        new RegExp(`\\.${cls.slice(1)}\\b[^\\s>]*:hover`).test(r.selector) &&
        r.decls.some((d) => d.prop === "background" || d.prop === "color"));
      expect(hoverRules.length, `${cls} has no :hover rule changing background or colour — the tint was deleted`).toBeGreaterThan(0);

      const t = resolve(S, el(cls), "transition");
      expect(t, `${cls} declares no transition at all — its hover hard-cuts`).not.toBeNull();
      const props = transitioned(t.value);
      // Whichever of background/colour the hover actually changes must be
      // covered — `all` covers both.
      const changes = new Set(hoverRules.flatMap((r) => r.decls.map((d) => d.prop))
        .filter((p) => p === "background" || p === "color"));
      for (const p of changes)
        expect(props.includes(p) || props.includes("all"),
          `${cls}:hover changes ${p}, but its transition only covers [${props.join(", ")}] — ${where(t)}`).toBe(true);
      expect(hasDuration(t.value), `${cls} transition has no duration: ${where(t)}`).toBe(true);
    });
  }

  it("does not trade the kit's press physics for the tint", () => {
    // `transition` is a shorthand: naming only background and colour REPLACES
    // the kit's `transform var(--dur-1) var(--ease-out)` rather than adding to
    // it, and §4.6 says the press is one physics across the estate. This is the
    // trap the obvious fix walks into.
    for (const cls of [".pill", ".btn"]) {
      const t = resolve(S, el(cls), "transition");
      const props = transitioned(t.value);
      expect(props.includes("transform") || props.includes("all"),
        `${cls} lost the kit's transform transition: ${where(t)}`).toBe(true);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   TYPE — the two things the kit does not carry.
   ════════════════════════════════════════════════════════════════════════════ */
describe("SYNC still supplies the type properties the kit leaves out", () => {
  it("balances the line breaks of the two display sizes", () => {
    // The kit declares no text-wrap anywhere, so this is SYNC's to add and
    // SYNC's to lose — and it was lost on the way onto the kit, which is why a
    // page title started orphaning its last word again.
    for (const cls of [".t-ltitle", ".t-title1"]) {
      const r = resolve(S, el(cls), "text-wrap");
      expect(r, `${cls} no longer balances its line breaks — nothing declares text-wrap on it`).not.toBeNull();
      expect(r.value, where(r)).toBe("balance");
    }
    // Scan sanity: this only means anything if the kit really is silent on it.
    // If the kit ever adopts text-wrap, delete SYNC's copy instead of both.
    const kitWrap = S.rules.filter((r) => r.sheet === "kit" && r.decls.some((d) => d.prop === "text-wrap"));
    expect(kitWrap.map((r) => r.selector), "the kit has taken over text-wrap; SYNC's copy is now a duplicate").toEqual([]);
  });

  it("keeps the app's typeface on the controls the kit renders as bare buttons", () => {
    // `.sy-root button { font-family: inherit }` is the one rule the app's whole
    // typeface depends on: .cell, .seg-opt, .pill and .dock-tab are all
    // <button>s, and the kit sets font-family on .btn and .field and on
    // nothing else. Without it those five render in the UA's default control
    // face — Helvetica on iOS, in an app whose entire type scale is Inter.
    // Deleting the rule was GREEN before this assertion existed.
    for (const cls of ["cell", "seg-opt", "pill", "dock-tab"]) {
      const r = resolve(S, el({ tag: "button", classes: [cls] }), "font-family");
      expect(r, `a <button class="${cls}"> has no font-family — it will render in the UA's control face`).not.toBeNull();
      expect(/^(inherit|var\(--font-)/.test(r.value), `.${cls} font-family: ${where(r)}`).toBe(true);
    }
    // …and the same for a button carrying no kit class at all.
    expect(value(S, el({ tag: "button", classes: [] }), "font-family")).toBe("inherit");
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   §4.2 — ONE MATERIAL, across both sheets.
   ════════════════════════════════════════════════════════════════════════════ */
describe("no element ends up with a border and a shadow", () => {
  it("resolves both halves over the kit and SYNC together", () => {
    // The old guard merged declarations by identical SELECTOR TEXT, inside
    // SYNC's sheet only. `.sy-root .card` and `[data-kit] .card` are two strings
    // and one element, so adding `.sy-root .card { border: 1px solid var(--line) }`
    // combined with the kit's `.card { box-shadow }` to make the anti-pattern
    // with both suites green. Merging by ELEMENT is what closes that.
    //
    // Honest note: there is no live violation today. This is latent, and the
    // mutation below is how it was proven able to fail.
    const els = targetedElements(S);
    expect(els.length, "elements to check").toBeGreaterThan(200);
    const both = [];
    for (const t of els)
      for (const m of MEDIA) {
        const sides = borderedSides(S, t.chain, m);
        if (sides.length && hasShadow(S, t.chain, m))
          both.push(`${t.key}${m ? ` ${m}` : ""} — border-${sides.join("/")} + box-shadow`);
      }
    expect(both, `border and box-shadow on the same element:\n${both.join("\n")}`).toEqual([]);
  });

  it("still recognises a border and a shadow when it sees one", () => {
    // Scan sanity for the two predicates above: this app really does draw
    // borders, and really does draw shadows — just never on one element. If
    // either predicate stopped matching, the sweep would report a clean sheet
    // of nothing.
    const bordered = targetedElements(S).filter((t) => borderedSides(S, t.chain).length);
    const shadowed = targetedElements(S).filter((t) => hasShadow(S, t.chain));
    expect(bordered.length, "elements with a real border").toBeGreaterThan(4);
    expect(shadowed.length, "elements with a box-shadow").toBeGreaterThan(4);
    expect(bordered.map((t) => t.key)).toContain("div.sy-scope div.sy-root[data-kit] *.mind-stage");
    expect(shadowed.map((t) => t.key)).toContain("div.sy-scope div.sy-root[data-kit] *.tl-block");
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   §4.3 — UPPERCASE HAS EXACTLY ONE ROUTE, AND IT IS .t-label.
   ════════════════════════════════════════════════════════════════════════════ */
describe("uppercase reaches the screen only through .t-label", () => {
  /** Every .js/.jsx under src/, tests excluded. */
  function sourceFiles() {
    const out = [];
    (function walk(dir) {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") walk(p); }
        else if (/\.jsx?$/.test(e.name)) out.push(p);
      }
    })(SRC);
    return out.sort();
  }
  const rel = (p) => relative(SRC, p).split(sep).join("/");

  it("declares no text-transform anywhere in the sheet", () => {
    // The old guard was `expect(css).not.toMatch(/text-transform:\s*uppercase/)`
    // on the raw text. Three reintroductions walked through it: a space before
    // the colon (`text-transform : uppercase`, which CSS accepts), a different
    // case (`text-transform:UPPERCASE`, no /i), and a value reached through a
    // custom property. Reading the parsed declaration removes all three at
    // once, because the parser normalises exactly what the browser does.
    const offenders = S.rules
      .filter((r) => r.sheet === "sync")
      .flatMap((r) => r.decls
        .filter((d) => d.prop === "text-transform" && !/^(none|inherit|initial|unset)$/i.test(d.value))
        .map((d) => `${r.media ? r.media + " " : ""}${r.selector} { text-transform: ${d.value} }`));
    expect(offenders, `SYNC's sheet must reach caps through .t-label only:\n${offenders.join("\n")}`).toEqual([]);
    // Scan sanity: the parser really does see text-transform declarations —
    // the kit's .t-label is the one that is allowed to exist.
    const kitCaps = S.rules.filter((r) => r.sheet === "kit" && r.decls.some((d) => d.prop === "text-transform"));
    expect(kitCaps.length, "the kit's own caps are still parsed").toBeGreaterThan(0);
    expect(kitCaps.map((r) => r.selector), "and .t-label is where they live").toContain("[data-kit] .t-label");
  });

  it("declares no textTransform in an inline style either", () => {
    // The sheet was the only thing the old guard looked at, and an inline style
    // beats every rule in it. `style={{ textTransform: "uppercase" }}` on any
    // page was invisible — while the border-and-shadow guard two tests below it
    // in render.test.jsx has scanned inline styles all along, so this was an
    // inconsistency as well as a hole.
    const files = sourceFiles();
    expect(files.length, "the source glob found files").toBeGreaterThan(25);
    const offenders = [];
    let objects = 0;
    for (const file of files) {
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      // every style={{ … }} object, brace-matched
      const re = /style\s*=\s*\{\{/g;
      let m;
      while ((m = re.exec(source))) {
        let d = 0, j = m.index + m[0].length - 1;
        for (; j < source.length; j++) {
          if (source[j] === "{") d++;
          else if (source[j] === "}") { d--; if (!d) { j++; break; } }
        }
        const text = source.slice(m.index, j);
        objects++;
        if (/textTransform\s*:\s*[^,}]*uppercase/i.test(text))
          offenders.push(`${rel(file)} → ${text.replace(/\s+/g, " ").slice(0, 160)}`);
        re.lastIndex = j;
      }
      // …and the same property reached through a className-free style object
      // held in a variable is caught by the sweep over the whole file:
      if (/textTransform\s*:\s*["'`]?\s*uppercase/i.test(source))
        offenders.push(`${rel(file)} → textTransform: uppercase`);
    }
    // Scan sanity: 239 inline style objects on the day this was written.
    expect(objects, "there are inline style objects to check").toBeGreaterThan(100);
    expect([...new Set(offenders)], `inline uppercase:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("puts .t-label on both mind chips, which is what the sheet claims", () => {
    // styles.css says of .neuron-lock and .neuron-band: "Uppercase has exactly
    // one route in this language and it is .t-label, which both now wear". That
    // was true of one of them. MindPage.jsx:184 was updated and :205 was not, so
    // the weight band survived only by inheriting from a .t-label parent — the
    // same size as its own label and a weight lighter, which is not what the
    // sheet describes and not what the screen should show.
    const files = sourceFiles();
    const found = { "neuron-lock": 0, "neuron-band": 0 };
    const bare = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const cls = m[1] ?? m[2];
        for (const chip of ["neuron-lock", "neuron-band"]) {
          if (!new RegExp(`(^|[\\s\`])${chip}([\\s\`]|$)`).test(cls)) continue;
          found[chip]++;
          if (!/(^|\s)t-label(\s|$)/.test(cls)) bare.push(`${rel(file)} → className="${cls}"`);
        }
      }
    }
    // Scan sanity: both chips are rendered somewhere, so a className regex that
    // rots reports "no violations" instead of passing over the real thing.
    expect(found["neuron-lock"], "the lock chip is rendered").toBeGreaterThan(0);
    expect(found["neuron-band"], "the weight band is rendered").toBeGreaterThan(0);
    expect(bare, `a mind chip without .t-label:\n${bare.join("\n")}`).toEqual([]);
    // …and the sheet must still be leaving the type to the kit rather than
    // rolling its own, or the class above would be decoration.
    for (const cls of [".neuron-lock", ".neuron-band"])
      for (const prop of ["font-size", "letter-spacing", "text-transform"]) {
        const own = S.rules.filter((r) => r.sheet === "sync" && r.selector.endsWith(cls))
          .flatMap((r) => r.decls.filter((d) => d.prop === prop));
        expect(own.map((d) => `${cls} { ${d.prop}: ${d.value} }`),
          `${cls} must take its type from .t-label, not roll its own`).toEqual([]);
      }
  });
});
