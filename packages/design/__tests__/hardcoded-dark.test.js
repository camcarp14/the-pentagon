// ─── The three sheets that froze their own dark ground ───────────────────────
//
// THE BUG. `apps/macro/src/styles.css`, `apps/runway/src/styles/app.css` and
// `apps/sync/src/styles.css` each declared a full dark palette on the document
// root. The token layer has emitted a light half for every palette since it
// landed (DESIGN.md §2: "the light halves are already generated and
// contrast-checked"), and none of it could reach those three tools: whatever the
// shell resolved, a card was #141B2C, a bar was rgba(11,15,26,0.92) and a meter
// track was 7% white. A light Pentagon rendered dark chrome under light content.
//
// WHY A TEST FILE AND A BROWSER HARNESS, AND NOT EITHER ALONE.
// packages/design/theme-check.mjs drives the built app and measures computed
// colour, because a cascade question can only be answered by something that does
// cascade — that is the lesson scripts/toolrow-check.mjs exists to carry, and the
// two files are deliberately the same shape. But it needs a build and a server,
// so it does not run in `npm test`, and a guard nobody runs is not a guard.
//
// So this file holds the half that IS statically decidable, and holds it in the
// form that would have caught the original defect:
//
//   · a token the theme layer owns, declared at document-root specificity, is a
//     token the theme layer can no longer set. That is structural, not textual.
//   · a `body` background resolved from a variable the same sheet freezes paints
//     the document behind EVERY tool, not just its own.
//   · a literal white or black wash inside a paint declaration cannot flip.
//   · a colour is legible or it is not, and that is arithmetic — so the floors
//     here are COMPUTED from the values in the files, never asserted as strings.
//     A test that greps for "#0B7979" passes if the value is right and the
//     reasoning is wrong; this one fails the moment the number stops clearing.
//
// Every assertion below fails against the source as it stood before this change.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const read = (p) => readFileSync(join(REPO, p), "utf8");

const SHEETS = {
  macro: "apps/macro/src/styles.css",
  runway: "apps/runway/src/styles/app.css",
  sync: "apps/sync/src/styles.css",
};

// Comments come out first, always. These files DOCUMENT the traps they avoid —
// "this was rgba(11,15,26,0.92)", "`:root` used to win --bg on <html>" — and a
// scanner that cannot tell an explanation from a rule punishes the write-up of
// the fix. apps/sync/src/__tests__/mount.test.js does not strip them and had to
// be worked around in prose; that is the failure mode being avoided here.
// Bodies are blanked to their own newlines so reported line numbers stay true.
const decomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""));

/** Split a stylesheet into top-level rules, tracking nesting and strings. */
function rules(css, prefix = "") {
  const out = [];
  let depth = 0, start = 0, quote = null, paren = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) { if (c === quote && css[i - 1] !== "\\") quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "{" && !paren) depth++;
    else if (c === "}" && !paren) {
      depth--;
      if (depth === 0) {
        const chunk = css.slice(start, i);
        const at = chunk.indexOf("{");
        const sel = chunk.slice(0, at).trim();
        const body = chunk.slice(at + 1);
        // Conditional groups nest real rules; recurse so a rule hidden inside a
        // media query is not invisible to every check in this file.
        if (/^@(media|supports|container|layer)/i.test(sel)) out.push(...rules(body + "}", sel + " "));
        else if (sel && !sel.startsWith("@")) out.push({ sel: prefix + sel, body, line: css.slice(0, start).split("\n").length });
        start = i + 1;
      }
    }
  }
  return out;
}

const decls = (body) =>
  body.split(";").map((d) => d.trim()).filter(Boolean)
    .map((d) => { const i = d.indexOf(":"); return i === -1 ? null : { prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() }; })
    .filter(Boolean);

// ── colour maths, so every floor below is computed ──────────────────────────
const srgb = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const rgb = (h) => {
  const v = h.length === 4 ? h.slice(1).split("").map((c) => c + c).join("") : h.slice(1);
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
};
const lum = (h) => { const [r, g, b] = rgb(h); return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// OKLab, because "can these two be told apart" is not a contrast question.
// The first version of the pair check below used the WCAG ratio BETWEEN the two
// members, which for two colours of similar lightness is ~1.0 no matter how far
// apart their hues are — it reported teal and crimson as indistinguishable. A
// ratio measures lightness; separation is a distance in a perceptual space. This
// is the measure the dataviz validator uses (ΔE, OKLab ×100) and its numbers for
// these four pairs are recorded in Macro's own sheet.
const oklab = (hexStr) => {
  const [R, G, B] = rgb(hexStr).map(srgb);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
};
const deltaE = (a, b) => {
  const [x, y] = [oklab(a), oklab(b)];
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

/** `var(--name, <fallback>)` → `var(--name)`.
 *  The documented fallback is the whole shape of this change: it is the value
 *  the standalone entry lands on, and it is by definition the old literal. A
 *  scanner that cannot see past it flags the fix as the bug.
 *
 *  Written as a paren walk rather than a regex because a fallback CONTAINS
 *  parens — `var(--shadow-float, 0 12px 40px rgba(0,0,0,0.5))` is the exact
 *  shape, and `[^()]*` matches none of it. That regex reported the one
 *  pre-existing documented fallback in Runway as a violation, which is the same
 *  class of mistake this whole file exists to catch: a check that looks right
 *  and measures the wrong string. */
function stripFallbacks(v) {
  let out = "";
  for (let i = 0; i < v.length; i++) {
    if (!v.startsWith("var(", i)) { out += v[i]; continue; }
    let depth = 0, j = i;
    for (; j < v.length; j++) {
      if (v[j] === "(") depth++;
      else if (v[j] === ")") { depth--; if (!depth) break; }
    }
    const inner = v.slice(i + 4, j);
    const comma = inner.indexOf(",");
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    // The fallback itself may hold another var() whose own fallback is a
    // literal; that one is documented too, so the whole fallback is dropped.
    out += `var(${name})`;
    i = j;
  }
  return out;
}

// The grounds are READ OUT OF THE GENERATED FILE, never typed here. themes.css
// is rewritten by `npm run themes`; a hardcoded #EFF1F5 in this file would be
// the second source of truth DESIGN.md §2 exists to prevent, and it would go
// stale the day someone re-authors a ground lightness.
const themes = read("packages/design/themes.css");
const paletteBlock = (key, mode) => {
  const head = `[data-palette="${key}"][data-theme="${mode}"] {`;
  const i = themes.indexOf(head);
  expect(i, `no ${mode} block for ${key} in themes.css`).toBeGreaterThan(-1);
  return themes.slice(i, themes.indexOf("}", i));
};
const tokenIn = (block, name) => (block.match(new RegExp(`${name}:\\s*([^;]+);`)) || [])[1]?.trim();
const groundsFor = (key, mode) => ["--bg", "--surface", "--surface-2"].map((t) => tokenIn(paletteBlock(key, mode), t));
/** For LIGHT text the hardest ground is the lightest; for DARK text, the darkest. */
const hardest = (grounds, mode) =>
  grounds.reduce((a, b) => ((mode === "light" ? lum(b) < lum(a) : lum(b) > lum(a)) ? b : a));

// ─────────────────────────────────────────────────────────────────────────────

describe("no app sheet freezes a ground the theme layer owns", () => {
  // The names the token layer authors per mode. A sheet that declares one of
  // these at document-root specificity has taken it away from the theme layer
  // for <html> — which is where `body` resolves, and `body` is the canvas behind
  // every tool, not just the one that shipped the rule.
  const THEME_OWNED = [
    "--bg", "--surface", "--surface-2", "--ink", "--sub", "--faint",
    "--accent", "--accent-hi", "--accent-deep", "--on-accent",
    "--line", "--line-strong", "--glass", "--scrim",
    "--shadow-card", "--shadow-float", "--shadow-deep",
    "--green", "--red", "--amber", "--blue", "--purple", "--pink",
  ];

  for (const [app, path] of Object.entries(SHEETS)) {
    it(`${app}: declares none of them on a bare :root / html / body`, () => {
      const found = [];
      for (const r of rules(decomment(read(path)))) {
        // `:where(:root)` is the documented standalone fallback: zero
        // specificity, so tokens.css's own (0,1,0) blocks beat it inside the
        // Pentagon and it only resolves where nothing else exists. That is the
        // whole point of the selector and it is not a violation.
        const bare = r.sel.split(",").map((s) => s.trim())
          .some((s) => /^(:root|html|body)$/.test(s) || /(^|\s)(:root|html|body)(\s|$)/.test(s.replace(/:where\([^)]*\)/g, "")));
        if (!bare) continue;
        for (const d of decls(r.body)) if (THEME_OWNED.includes(d.prop)) found.push(`${path}:${r.line} — ${r.sel} { ${d.prop} }`);
      }
      expect(found, `\n${found.join("\n")}\n`).toEqual([]);
    });

    it(`${app}: paints <body> from the shell's canvas, not its own --bg`, () => {
      // `body { background: var(--bg) }` resolves ABOVE the shell's themed
      // wrapper, so it painted the whole document in one tool's midnight for as
      // long as that tool was mounted. index.html declares --shell-canvas for
      // exactly this and App.jsx publishes the resolved ground into it.
      for (const r of rules(decomment(read(path)))) {
        if (!r.sel.split(",").some((s) => /(^|\s)body$/.test(s.trim()))) continue;
        for (const d of decls(r.body)) {
          if (!/^background(-color)?$/.test(d.prop)) continue;
          // A print stylesheet is a different medium and legitimately paints white.
          if (r.sel.includes("@media print")) continue;
          expect(d.value, `${path}:${r.line} — body must read --shell-canvas, got "${d.value}"`)
            .toMatch(/var\(--shell-canvas/);
        }
      }
    });
  }
});

describe("no paint declaration is keyed to one ground", () => {
  // A literal white or black wash cannot flip: 7% white is a visible meter track
  // on midnight and an invisible one on paper. Every wash resolves through the
  // ink ladder now, which is color-mix()'d off the live --ink.
  //
  // Four exemptions, each a real one and each named:
  const EXEMPT = [
    // The declared standalone fallback / light-half blocks: literals ARE the
    // content of those blocks, and every one of them is a token definition.
    (r, d) => d.prop.startsWith("--"),
    // Runway's printed résumé. Paper is paper in every palette — the block says
    // so, and a white sheet that went grey in dark mode would be a bug.
    (r) => /\.paper/.test(r.sel),
    // Print is a different medium.
    (r) => r.sel.includes("@media print"),
    // A mask is geometry, not colour: the #000 in a mask-image gradient is an
    // alpha stop and never reaches the screen.
    (r, d) => /mask-image$/.test(d.prop) || /^-webkit-mask-image$/.test(d.prop),
  ];
  const PAINT = /^(background|background-color|color|border(-[a-z]+)?(-color)?|box-shadow|outline(-color)?|scrollbar-color|fill|stroke)$/;
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;

  for (const [app, path] of Object.entries(SHEETS)) {
    it(`${app}: every paint value resolves through a token`, () => {
      const bad = [];
      for (const r of rules(decomment(read(path)))) {
        for (const d of decls(r.body)) {
          if (!PAINT.test(d.prop) || !LITERAL.test(stripFallbacks(d.value))) continue;
          if (EXEMPT.some((f) => f(r, d))) continue;
          bad.push(`${path}:${r.line} — ${r.sel} { ${d.prop}: ${d.value} }`);
        }
      }
      expect(bad, `\n${bad.join("\n")}\n`).toEqual([]);
    });
  }

  it("the scan is not silently finding nothing", () => {
    // Every assertion above is a "no matches" assertion, which a broken splitter
    // or a wrong path satisfies perfectly. Real numbers when this landed: 2,650
    // lines across the three sheets, ~470 rules, ~250 paint declarations.
    const all = Object.values(SHEETS).flatMap((p) => rules(decomment(read(p))));
    expect(all.length).toBeGreaterThan(300);
    const paints = all.flatMap((r) => decls(r.body)).filter((d) => PAINT.test(d.prop));
    expect(paints.length).toBeGreaterThan(150);
    // …and it can still SEE a literal, or the exemptions have swallowed the rule.
    const literals = all.flatMap((r) => decls(r.body)).filter((d) => LITERAL.test(d.value));
    expect(literals.length).toBeGreaterThan(30);
  });
});

describe("Macro's data colours have two halves, and both are legible", () => {
  // --up/--down are candle polarity and --mstr/--btc are two fixed series
  // identities; the sheet's header calls them data and says they do not resolve
  // through the kit. That makes them AUTHORED, not derived — it does not make
  // them frozen. A pair that measures 6.2:1 on #0B0E14 and 2.7:1 on #EFF1F5 is a
  // chart nobody can read half the time.
  const css = decomment(read(SHEETS.macro));
  // Returns {} rather than throwing when the block is absent. A module-scope
  // throw aborts COLLECTION, so vitest reports "0 tests" instead of four named
  // failures — which reads like the file was skipped, not like the sheet is
  // wrong. The absence is asserted inside a test, where it can say so.
  const blockFor = (sel) => {
    const r = rules(css).find((x) => x.sel === sel);
    if (!r) return {};
    return Object.fromEntries(decls(r.body).filter((d) => d.prop.startsWith("--")).map((d) => [d.prop, d.value]));
  };
  const dark = blockFor(".macro-root");
  const light = blockFor('[data-theme="light"] .macro-root');

  it("has a block for each mode on the app's own root", () => {
    // Not on `:root`: a derivation written there resolves against `:root`'s own
    // values and merely inherits, so it freezes at the neutral ground whatever
    // palette is live. It has to be on an element inside the themed wrapper.
    expect(Object.keys(dark).length, "no `.macro-root` token block").toBeGreaterThan(5);
    expect(Object.keys(light).length, 'no `[data-theme="light"] .macro-root` block — the light half does not exist').toBeGreaterThan(0);
  });

  // 4.5:1 where the sheet inks small TEXT with it, 3:1 where it draws a mark.
  // Both are used for both in places; the floor follows the dominant use, and
  // the two marks are the chart series line and a 10×3px legend swatch.
  const TEXT = ["--up", "--down", "--crit", "--serious"];
  const MARK = ["--mstr", "--btc"];

  it("every one of them is authored for light as well as dark", () => {
    for (const name of [...TEXT, ...MARK]) {
      const base = dark[name];
      expect(base, `${name} has no dark value on .macro-root`).toMatch(/^#[0-9a-fA-F]{6}$/);
      // A value only needs a light half if the dark one does not already clear
      // its floor on the light ground — restating a value that does not have to
      // move is one more place for the two halves to drift apart.
      const ground = hardest(groundsFor("macro", "light"), "light");
      const floor = TEXT.includes(name) ? 4.5 : 3;
      const resolved = light[name] || base;
      expect(resolved, `${name}: no light value and the dark one is not a hex`).toMatch(/^#[0-9a-fA-F]{6}$/);
      const c = contrast(resolved, ground);
      expect(c, `${name} ${resolved} on the light ground ${ground} = ${c.toFixed(2)}:1, floor ${floor}`)
        .toBeGreaterThanOrEqual(floor);
    }
  });

  it("the light half never restates a value that did not have to move", () => {
    for (const [name, value] of Object.entries(light)) {
      if (!/^#[0-9a-fA-F]{6}$/.test(value) || !dark[name]) continue;
      expect(value.toLowerCase(), `${name} is restated in the light block with the same value`).not.toBe(dark[name].toLowerCase());
    }
  });

  it("the dark half is unchanged, so the shipping room did not move", () => {
    // These are the values the cockpit ships. The whole design of the two-half
    // block is that adding light costs the dark room nothing — if this fails,
    // something re-tuned production while claiming to add a mode.
    expect(dark).toMatchObject({
      "--mstr": "#3b72e8", "--btc": "#d97706", "--up": "#0fa3a3", "--down": "#d93a5f",
      "--serious": "#c2410c", "--crit": "#e11d48",
    });
  });

  it("the two pairs still separate, in BOTH modes", () => {
    // Not a contrast check — a SEPARATION check, and the other way a chart
    // fails: two series that each clear the ground and cannot be told apart from
    // each other. 15 is the dataviz normal-vision hard floor ("full-colour
    // readers can't tell the pair apart" below it), measured as ΔE in OKLab ×100
    // — the same space and scale the validator reports. Both halves are checked,
    // because re-tuning one member for a new ground is exactly how a pair that
    // used to separate stops.
    for (const [a, b] of [["--up", "--down"], ["--mstr", "--btc"]]) {
      for (const [mode, tbl] of [["dark", dark], ["light", { ...dark, ...light }]]) {
        const d = deltaE(tbl[a], tbl[b]);
        expect(d, `${a} ${tbl[a]} and ${b} ${tbl[b]} are ΔE ${d.toFixed(1)} apart in ${mode} — under the 15 normal-vision floor`)
          .toBeGreaterThanOrEqual(15);
      }
    }
  });
});

describe("the semantic six are checked in the mode they were never checked in", () => {
  // gen-themes.mjs says the semantic colours are "NOT per-palette … They stay on
  // the day/night definitions in tokens.css" — so the generator's WCAG pass, the
  // one DESIGN.md §2 points at, never covered them. Their light half was
  // authored against a pure white card and lands on a #EFF1F5 page.
  const tokens = decomment(read("packages/design/tokens.css"));
  const NAMES = ["--green", "--red", "--amber", "--blue", "--purple", "--pink"];
  const blockAfter = (needle) => {
    const i = tokens.indexOf(needle);
    expect(i, `${needle} not found in tokens.css`).toBeGreaterThan(-1);
    return tokens.slice(i, tokens.indexOf("}", i));
  };
  const lightRoom = blockAfter(':root, [data-theme="light"] {');
  const darkRoom = blockAfter('[data-theme="dark"] {');
  const valueIn = (block, name) => (block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`)) || [])[1];

  it("clears AA text contrast on every light ground the Pentagon paints", () => {
    // Both rooms: tokens.css's own Porcelain page AND the generated palette
    // page, because the semantic set is shared and lands on both.
    const grounds = [valueIn(lightRoom, "--bg"), ...groundsFor("macro", "light")].filter(Boolean);
    const hard = hardest(grounds, "light");
    for (const n of NAMES) {
      const v = valueIn(lightRoom, n);
      expect(v, `${n} missing from the light room`).toBeTruthy();
      const c = contrast(v, hard);
      expect(c, `${n} ${v} on ${hard} = ${c.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("leaves the dark half exactly where it was", () => {
    // Light mode has never rendered, so re-tuning it costs nothing. Dark ships.
    expect(NAMES.map((n) => valueIn(darkRoom, n))).toEqual(["#34A56E", "#E05548", "#BC7F24", "#4C82E8", "#9673E6", "#D95C93"]);
  });
});

describe("SYNC republishes everything its own room declares", () => {
  // SYNC adopts the Pentagon by capturing its custom properties on .sy-scope and
  // re-declaring them under SYNC's names on .sy-root. That block was written
  // when the Pentagon was dark-only, so a name left out of it landed on a value
  // that happened to agree — invisible, and unfalsifiable, until a light ground
  // existed. This is the check that makes "everything is adopted" mean something.
  const css = decomment(read(SHEETS.sync));
  const all = rules(css).filter((r) => r.sel === ".sy-root");
  // Found by CONTENT, not by position. `.sy-root` appears several more times
  // after the adoption block (the geometry section), so "the last one" silently
  // pointed at a layout rule and reported every colour in the file as frozen.
  const republishes = (d) => /var\(\s*--sy-p-/.test(d.value);
  const adoption = all.filter((r) => decls(r.body).some(republishes));
  const declaredIn = all.flatMap((r) => decls(r.body));

  // Only a LITERAL colour carries a room. Two exclusions, both from the block's
  // own reasoning:
  //   · motion, type and shape (--dur-*, --ease-*, --font-*, --r-*) are
  //     mode-independent, so re-pointing them would be noise;
  //   · anything already written as color-mix() over a var() — the whole
  //     --ink-a* / --accent-a* ladder — follows its base for free, which is what
  //     the adoption block means by "the entire palette follows from twenty
  //     lines". Requiring those to be republished would demand twenty pointless
  //     aliases and hide the four names that genuinely were frozen.
  const isFrozenPaint = (v) => !/var\(/.test(v) && /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(v);

  it("has both halves of the bridge", () => {
    expect(all.length, "expected at least an OBSIDIAN block and an adoption block").toBeGreaterThanOrEqual(3);
    expect(adoption.length, "no .sy-root block reads from --sy-p-*").toBeGreaterThan(0);
    expect(rules(css).some((r) => r.sel === ".sy-scope"), "no .sy-scope capture block").toBe(true);
  });

  it("leaves no colour or shadow behind", () => {
    // --orb-* is genuinely local: it is derived from captured values in the
    // adoption block itself, so it is listed rather than silently skipped.
    const LOCAL = ["--orb-1", "--orb-2", "--orb-3"];
    const frozen = declaredIn.filter((d) => d.prop.startsWith("--") && isFrozenPaint(d.value)).map((d) => d.prop);
    const republished = new Set(adoption.flatMap((r) => decls(r.body)).filter(republishes).map((d) => d.prop));
    const missed = [...new Set(frozen)].filter((p) => !republished.has(p) && !LOCAL.includes(p));
    expect(missed, `frozen to SYNC's true-black room: ${missed.join(", ")}`).toEqual([]);
    expect(frozen.length, "the OBSIDIAN scan found nothing — it is broken").toBeGreaterThan(20);
    expect(republished.size, "the adoption scan found nothing — it is broken").toBeGreaterThan(20);
  });

  it("does not pin color-scheme, so native controls follow the shell", () => {
    // An inherited property the shell sets on <html>. Pinned to `dark` here,
    // SYNC alone drew black form controls and a black scrollbar on paper — the
    // parts of a light mode no stylesheet can repaint.
    const pinned = rules(css).filter((r) => decls(r.body).some((d) => d.prop === "color-scheme"));
    expect(pinned.map((r) => `${r.sel} (line ${r.line})`), "color-scheme must be inherited, not pinned").toEqual([]);
  });
});
