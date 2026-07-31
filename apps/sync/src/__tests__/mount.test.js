// The two properties that make SYNC safe to host inside the shell.
//
// Neither is provable by the build: an unscoped selector still compiles, and a
// leaked custom property still resolves — it just resolves to the wrong thing,
// silently, in whichever tab happens to be mounted next. Both failures are
// invisible until someone looks at another tool and finds it wearing SYNC's
// paint, so they get pinned here instead.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "styles.css"), "utf8");

/**
 * Every rule prelude in the sheet, minus at-rules and keyframe stops.
 *
 * Brace-matched rather than regex-scanned, and that is not tidiness. The
 * previous version anchored each prelude to the preceding `}`, so the FIRST
 * rule inside every `@media` block — the one preceded by `{` — was never
 * returned at all: sixteen rules in this sheet, and any unscoped selector
 * among them would have passed the isolation check below by not being looked
 * at. Descending into at-rule bodies is what makes that check total.
 */
function selectors(sheet) {
  const out = [];
  const clean = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
  (function walk(text) {
    let i = 0, prelude = "";
    while (i < text.length) {
      if (text[i] !== "{") { prelude += text[i]; i++; continue; }
      let d = 0, j = i;
      for (; j < text.length; j++) {
        if (text[j] === "{") d++;
        else if (text[j] === "}") { d--; if (d === 0) { j++; break; } }
      }
      const body = text.slice(i + 1, j - 1);
      const sel = prelude.trim();
      // @media/@supports hold rules; @keyframes holds stops, which are not
      // selectors and are not scopeable.
      if (sel.startsWith("@")) {
        if (/^@(media|supports|layer|container|scope)\b/i.test(sel)) walk(body);
      } else if (sel) out.push(sel);
      prelude = ""; i = j;
    }
  })(clean);
  return out;
}

describe("stylesheet isolation", () => {
  const sels = selectors(css);

  // A floor, not a count. Its only job is to fail loudly if the parser above
  // ever stops seeing the sheet — otherwise the two checks below would pass
  // vacuously against an empty list, which is exactly how a regression test
  // ends up proving nothing.
  //
  // It was 250 against a sheet of 336 rules. Moving SYNC onto the shared kit
  // deleted the 150-odd that were a private second copy of it — the type
  // scale, the card, the cell, the stat tile, the button, the pill, the
  // segmented control, the field, the switch, the sheet, the toast, the
  // skeleton — plus the dead boot screen and the Mind's replaced list UI.
  // The number moves with the sheet; what it guards does not.
  //
  // It was then relaxed to 120, which is where a floor stops doing its job:
  // the sheet parses to 200 rules TODAY (2026-07-31, counted with the walker
  // above, at-rule bodies included), so half the stylesheet could vanish and
  // this would still be green — and the two checks below would go on passing
  // vacuously against whatever was left. 170 is ~85% of the real number:
  // loose enough that ordinary deletion does not trip it, tight enough that a
  // parser which loses a chunk of the sheet does. If you make a large, real
  // deletion, move this number and record the new count here.
  it("has rules to check at all", () => {
    expect(sels.length).toBeGreaterThan(170);
  });

  it("scopes every selector under .sy-root or .sy-scope", () => {
    const leaked = sels.filter((s) =>
      s.split(",").some((one) => {
        const t = one.trim();
        return t && !t.startsWith(".sy-root") && !t.startsWith(".sy-scope");
      }));
    expect(leaked).toEqual([]);
  });

  it("never styles the document itself", () => {
    // html/body/#root/* belong to apps/shell/index.html. SYNC used to set
    // `body { overflow: hidden }`, which would freeze scrolling for every other
    // tab from the moment SYNC's chunk had loaded once.
    expect(css).not.toMatch(/(^|\})\s*(html|body|#root|\*)\s*[,{]/);
  });

  it("clears the home indicator through the shell's variable, not the raw inset", () => {
    // --safe-bottom is 0 on a letterboxed iOS install where the reported inset
    // is dead space; env(safe-area-inset-bottom) there floats the tab bar off
    // the screen edge, which is the bug this whole move was meant to end.
    expect(css).toContain("var(--safe-bottom");
    expect(css).not.toMatch(/padding[^;]*env\(safe-area-inset-bottom/);
  });

  it("sizes the frame to the window, with vh only as a fallback under dvh", () => {
    // The bug this pins cost two rounds. Under the shell's `black` status-bar
    // style the web view starts BELOW the status bar, so the window is the
    // screen minus that strip — but 100vh on an installed iOS app reports the
    // screen anyway. The column then runs ~59pt past the bottom of the window
    // and the tab bar's labels go under the fold while its icons still show,
    // which reads as a sizing nudge rather than an overflow.
    //
    // Order is the whole point: the dvh line must come after the vh line, or
    // the fallback wins in every browser that supports both.
    const frame = [...css.matchAll(/height:\s*calc\(100(vh|dvh)\s*-\s*52px\);/g)].map((m) => m[1]);
    expect(frame).toEqual(["vh", "dvh"]);
  });

  it("keeps its blanket rules under the kit's, not over them", () => {
    // The kit's sheet is parsed BEFORE this one, so at equal specificity this
    // sheet wins every tie. That is what makes the safe-area overrides above
    // reliable — and what makes a broad rule here dangerous, because it now
    // outranks a kit rule it used to lose to. The focus ring is the one that
    // bit: it sets a fallback border-radius, and at (0,2,0) that would
    // repaint every focused .btn, .pill and .switch in the app at 8px.
    expect(css).toMatch(/\.sy-root :where\(:focus-visible\)/);
    expect(css, "an unweighted :focus-visible would outrank the kit's radii")
      .not.toMatch(/\.sy-root :focus-visible\s*\{/);
  });

  it("carries no light room", () => {
    // The Pentagon is one dark canvas and the shell hardcodes data-theme.
    // A scoped-but-later light palette would win outright over the dark one.
    expect(css).not.toMatch(/\[data-theme=["']?day/);
  });
});

describe("mount contract", () => {
  const root = readFileSync(join(here, "..", "Root.jsx"), "utf8");

  it("default-exports the entry the shell aliases", () => {
    expect(root).toMatch(/export default function SyncRoot\(/);
  });

  it("injects its sheet under a unique id and removes it on unmount", () => {
    expect(root).toContain('el.id = "sy-scoped-styles"');
    expect(root).toMatch(/return \(\) => el\.remove\(\)/);
  });

  it("holds the first paint until the sheet is in the document", () => {
    expect(root).toMatch(/if \(!styled\) return null/);
  });

  it("opts into the shared kit on its own root and nowhere else", () => {
    // data-kit belongs on .sy-root, the one element the shell hands this tool.
    // Put it any higher and it would restyle every other app's .card/.btn/
    // .field on the way past — which is the reason the shell keeps it off the
    // wrapper that holds them all.
    expect(root).toMatch(/className="sy-root" data-kit/);
    expect(root).not.toMatch(/className="sy-scope"[^>]*data-kit/);
  });

  it("carries the same bridge to the surfaces it portals out of the tree", () => {
    // Sheets, toasts and the palette render into <body>, which is outside
    // .sy-root and outside the shell's themed wrapper — so every rule in this
    // sheet and every design token missed them entirely. PortalLayer rebuilds
    // .sy-scope > .sy-root there; without it those three surfaces draw with
    // `background: var(--surface)` resolving to nothing at all.
    const kit = readFileSync(join(here, "..", "ui", "kit.jsx"), "utf8");
    expect(kit).toMatch(/export function PortalLayer/);
    expect(kit).toMatch(/className="sy-root sy-layer" data-kit/);
    // Every portal in the app goes through it.
    const cmdk = readFileSync(join(here, "..", "chrome", "CommandK.jsx"), "utf8");
    for (const [name, code] of [["kit.jsx", kit], ["CommandK.jsx", cmdk]]) {
      const portals = (code.match(/createPortal\(/g) || []).length;
      const wrapped = (code.match(/<PortalLayer>/g) || []).length;
      expect(portals, `${name} has portals to check`).toBeGreaterThan(0);
      expect(wrapped, `${name}: every createPortal must be wrapped`).toBe(portals);
    }
    // …and the wrapper must generate no box, or it is a full-height black
    // rectangle appended to <body> under the whole shell.
    expect(css).toMatch(/\.sy-root\.sy-layer\s*\{[^}]*display:\s*contents/);
  });

  it("renders .sy-scope outside .sy-root", () => {
    // Two elements, not one: .sy-scope reads the Pentagon's custom properties
    // and .sy-root republishes them under SYNC's names. Doing both on a single
    // element is a cycle, and CSS drops both sides of a cycle without a word.
    expect(root.indexOf('className="sy-scope"')).toBeGreaterThan(-1);
    expect(root.indexOf('className="sy-scope"')).toBeLessThan(root.indexOf('className="sy-root"'));
  });

  it("locks the document while mounted and gives it back on unmount", () => {
    // The lock is the only thing SYNC touches outside .sy-root, so the restore
    // is what keeps that honest — without it, switching to ZTS would leave its
    // page unscrollable with no clue why.
    expect(root).toMatch(/body\.style\.overflow = "hidden"/);
    expect(root).toMatch(/return \(\) => \{[\s\S]*body\.style\.overflow = prev\.bodyOverflow/);
  });

  it("no longer owns a window", () => {
    // The frame, the visualViewport measurement and the boot screen were all
    // answers to problems the shell now owns.
    const app = readFileSync(join(here, "..", "App.jsx"), "utf8");
    expect(app).not.toContain("position: \"fixed\"");
    expect(app).not.toMatch(/isLetterboxed|notch-cap|useVisualViewport/);
  });
});

describe("registration", () => {
  it("is registered everywhere a tab has to be", async () => {
    const { APPS, appMeta } = await import("@cc/design");
    expect(APPS).toContain("sync");
    expect(appMeta("sync").label).toBe("SYNC");

    const shell = join(here, "..", "..", "..", "shell");
    expect(readFileSync(join(shell, "vite.config.js"), "utf8")).toContain('"@app/sync"');
    expect(readFileSync(join(shell, "src", "App.jsx"), "utf8")).toContain('import("@app/sync")');
    expect(JSON.parse(readFileSync(join(shell, "package.json"), "utf8")).dependencies["@app/sync"]).toBe("*");
  });

  it("takes an accent no other tool or signal already holds", async () => {
    const { APPS, appMeta } = await import("@cc/design");
    const mine = appMeta("sync").accent.toLowerCase();
    const others = APPS.filter((a) => a !== "sync").map((a) => appMeta(a).accent.toLowerCase());
    // good / warn / bad / info, transcribed from MIDNIGHT.
    const signals = ["#3ecf8e", "#f5b84d", "#f87171", "#6ea8fe"];
    expect([...others, ...signals]).not.toContain(mine);
  });
});
