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

/** Every rule prelude in the sheet, minus at-rules and keyframe stops. */
function selectors(sheet) {
  const out = [];
  const re = /(^|\})\s*((?:\/\*[\s\S]*?\*\/\s*)*)([^{}]+)\{/g;
  let m;
  while ((m = re.exec(sheet))) {
    const sel = m[3].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (!sel || sel.startsWith("@")) continue;
    // Keyframe stops: `from`, `to`, `0%, 100%`.
    if (/^(from|to|[\d.]+%)(\s*,\s*(from|to|[\d.]+%))*$/.test(sel)) continue;
    out.push(sel);
  }
  return out;
}

describe("stylesheet isolation", () => {
  const sels = selectors(css);

  // A floor, not a count. Its only job is to fail loudly if the parser above
  // ever stops seeing the sheet — otherwise the two checks below would pass
  // vacuously against an empty list, which is exactly how a regression test
  // ends up proving nothing.
  it("has rules to check at all", () => {
    expect(sels.length).toBeGreaterThan(250);
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

  it("renders .sy-scope outside .sy-root", () => {
    // Two elements, not one: .sy-scope reads the Pentagon's custom properties
    // and .sy-root republishes them under SYNC's names. Doing both on a single
    // element is a cycle, and CSS drops both sides of a cycle without a word.
    expect(root.indexOf('className="sy-scope"')).toBeGreaterThan(-1);
    expect(root.indexOf('className="sy-scope"')).toBeLessThan(root.indexOf('className="sy-root"'));
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
