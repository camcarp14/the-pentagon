// ─── You cannot concatenate an alpha suffix onto a token ─────────────────────
//
// The bug this exists to prevent shipped, and it shipped SILENTLY.
//
// ZTS's DNA inspector coloured the selected "⛔ Tempers" polarity half with an
// 8% red wash, written as a hex-alpha concatenation:
//
//     background: inhib ? `${T.red}14` : "transparent"
//
// which was fine for as long as T.red was a literal `#F87171` — the template
// produced `#F8717114`, a legal 8-digit hex. Then the app was retokenised onto
// the shared design system and T.red became `var(--red)`. The same template now
// produced `var(--red)14`, which is not a colour: at computed-value time the
// declaration is invalid, so `background` falls back to its initial value and
// the selected half simply lost its fill.
//
// NOTHING FAILED. There is no console error for a discarded declaration, the
// build is unaffected (it is a runtime string), and every test stayed green.
// That is the whole reason this file exists: the failure mode is invisible, so
// the only way to catch it is to go looking.
//
// THE RULE. Take the step off the ladder — `var(--red-a08)` — never build one by
// string concatenation. packages/design/tokens.css says this in prose ("Use the
// ladder, never ad-hoc rgba"); this asserts it.
//
// WHAT IS AND IS NOT A VIOLATION. `${T.red}14` is only wrong when T.red holds a
// var(). Several apps still keep literal hex token tables — Clarify's T.red is
// `#F87171` — and concatenation there is legal and widespread (~40 sites). So a
// blanket ban on `${…}HH` would be wrong and would fail on day one. The check
// has to know which tokens are var()-valued, which is why it reads the tables.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const APPS = join(REPO, "apps");

const SKIP = new Set(["node_modules", "__tests__", "dist", "build", ".vite"]);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(jsx?|tsx?)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Blank out comments, keeping every newline so reported line numbers stay true.
 *
 * Not cosmetic: the first run of this guard failed on the comment in DnaView.jsx
 * that DOCUMENTS the banned pattern. A rule you cannot write down without
 * tripping it is a rule nobody can explain to the next person, so the scanner
 * has to read code only. Strings and template literals are tracked so a `//`
 * inside a URL, or a `/*` inside a CSS string, is not mistaken for a comment.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  let quote = null; // "'", '"', '`', or null
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop; continue;
    }
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += " ".repeat(stop - i);
      i = stop; continue;
    }
    out += c; i++;
  }
  return out;
}

const sources = () =>
  readdirSync(APPS)
    .filter((a) => statSync(join(APPS, a)).isDirectory())
    .flatMap((a) => walk(join(APPS, a, "src")))
    .sort()
    .map((p) => ({ path: p, rel: relative(REPO, p), src: stripComments(readFileSync(p, "utf8")) }));

/**
 * Keys in this file whose value is a var() string.
 *
 * Deliberately per-file rather than following imports: the defect was a table
 * and its call site in one file, following imports across nine apps would need a
 * resolver, and a same-file check has no false positives to argue about.
 */
function varValuedKeys(src) {
  const keys = new Set();
  for (const m of src.matchAll(/(\w+)\s*:\s*["'`](var\(--[^"'`]*)["'`]/g)) keys.add(m[1]);
  return keys;
}

/** `${SOMETHING.key}HH` and `${key}HH` — an interpolation glued to a hex pair. */
function alphaConcats(src) {
  const hits = [];
  for (const m of src.matchAll(/\$\{([^{}]*?)\}([0-9a-fA-F]{2})\b/g)) {
    const expr = m[1].trim();
    // The token being interpolated: the last identifier of a member expression,
    // so `T.red`, `pill.c` and a bare `tone` all reduce to the key to look up.
    const key = (expr.match(/([A-Za-z_$][\w$]*)\s*$/) || [])[1];
    if (!key) continue;
    const line = src.slice(0, m.index).split("\n").length;
    hits.push({ expr, key, alpha: m[2], line });
  }
  return hits;
}

describe("colour tokens are never given an alpha suffix by concatenation", () => {
  it("finds no `${var-valued token}HH` anywhere under apps/*/src", () => {
    const violations = [];
    for (const f of sources()) {
      const vars = varValuedKeys(f.src);
      if (!vars.size) continue;
      for (const h of alphaConcats(f.src)) {
        if (!vars.has(h.key)) continue;
        violations.push(`${f.rel}:${h.line} — \`\${${h.expr}}${h.alpha}\` emits "var(…)${h.alpha}", which is not a colour. Use a ladder step (e.g. var(--red-a08)) instead.`);
      }
    }
    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);
  });

  // ── the scan is not silently finding nothing ───────────────────────────────
  //
  // Every assertion above is a "no matches" assertion, which a broken regex or a
  // wrong path satisfies perfectly. These pin the scan itself. The real numbers
  // when this landed were 183 files, 9 apps, 24 files carrying a var() table and
  // 78 alpha concatenations (all on literal-hex tokens, hence all legal), so the
  // floors sit well below ordinary churn but far above zero.

  it("actually reached the app sources", () => {
    const files = sources();
    expect(files.length).toBeGreaterThanOrEqual(120);
    const apps = new Set(files.map((f) => f.rel.split("/")[1]));
    expect(apps.size).toBeGreaterThanOrEqual(8);
  });

  it("actually found var()-valued token tables to check against", () => {
    const withTables = sources().filter((f) => varValuedKeys(f.src).size > 0);
    expect(withTables.length).toBeGreaterThanOrEqual(12);
    // The file the original defect lived in must still be one of them, or the
    // table reader has stopped recognising the shape it was written to catch.
    expect(withTables.map((f) => f.rel)).toContain("apps/zts/src/dna/DnaView.jsx");
    expect(varValuedKeys(stripComments(readFileSync(join(APPS, "zts/src/dna/DnaView.jsx"), "utf8")))).toContain("red");
  });

  it("actually found alpha concatenations — the legal ones on hex tokens", () => {
    // If this hits zero the concat regex has broken and the main assertion above
    // is vacuous. Clarify keeps literal-hex tokens and concatenates them freely;
    // that is legal and is what keeps this number healthy.
    const total = sources().reduce((n, f) => n + alphaConcats(f.src).length, 0);
    expect(total).toBeGreaterThanOrEqual(30);
  });
});
