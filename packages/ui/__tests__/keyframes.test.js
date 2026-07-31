// ═══════════════════════════════════════════════════════════════════════════
// The keyframe-namespace guard.
//
// A CSS `@keyframes` name is DOCUMENT-GLOBAL. It cannot be scoped by an
// attribute selector, a class, a media query or anything else: there is one flat
// namespace per document, last definition wins, and The Pentagon renders nine
// tools into one document. `packages/ui/components.css` scopes every ordinary
// rule to `[data-kit]` (DESIGN.md §5) but its keyframes are naked and cannot be
// otherwise.
//
// So when six app files each defined their own `pulse`/`fadein`/`shimmer`/…,
// and several of those apps append their sheet to `document.head` at mount and
// never remove it, the app's copy landed AFTER the shell's
// `import "@cc/ui/components.css"` and won for EVERY tool on screen.
//
// The sharpest instance, and the reason this file exists: the kit's `shimmer` is
// a TRANSFORM sweep driving `[data-kit] .sk::after`, which starts at
// `translateX(-100%)`. ZTS's and Clarify's `shimmer` were BACKGROUND-POSITION
// sweeps, which do nothing to that element — so with ZTS or Clarify mounted, kit
// skeleton loaders stopped animating everywhere.
//
// Two properties this guard has to have, because the defect had both:
//   • The owned list is DERIVED from components.css, never hardcoded. Add a
//     keyframe to the kit and it is protected on the next run.
//   • The scan reads JS/JSX as well as CSS. ZTS and Clarify inject their entire
//     stylesheet from a template literal; a `.css`-only glob sees neither file,
//     which is exactly how this survived.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const KIT_SHEET = join(ROOT, "packages/ui/components.css");
const SCANNED_EXT = [".css", ".js", ".jsx", ".ts", ".tsx"];

// ── comment handling ─────────────────────────────────────────────────────────
// Runway's stylesheets discuss `@keyframes pulse` and `@keyframes rise` IN PROSE,
// in the comments that explain why they were prefixed away — and the fix notes
// added to macro/zts/clarify/shell do the same. A guard that flagged those would
// punish the documentation of the fix, so comments come out first. Block comment
// bodies are replaced by their own newlines so reported line numbers stay true.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const KEYFRAME_RE = /@keyframes\s+("[^"]+"|'[^']+'|[A-Za-z_][A-Za-z0-9_-]*)/g;

function findKeyframes(src) {
  const clean = stripComments(src);
  const out = [];
  for (const m of clean.matchAll(KEYFRAME_RE)) {
    const line = clean.slice(0, m.index).split("\n").length;
    out.push({ name: m[1].replace(/^["']|["']$/g, ""), line });
  }
  return out;
}

function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "__tests__" || entry === "dist" || entry === "build") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (SCANNED_EXT.some((e) => entry.endsWith(e))) acc.push(full);
  }
  return acc;
}

// ── the kit's own declaration, read fresh ────────────────────────────────────
const kitSrc = readFileSync(KIT_SHEET, "utf8");
const kitClean = stripComments(kitSrc);
/** name -> { line, rule } for every keyframe components.css owns. */
const KIT_OWNED = new Map();
for (const { name, line } of findKeyframes(kitSrc)) {
  const at = kitClean.split("\n")[line - 1] || "";
  KIT_OWNED.set(name, { line, rule: at.trim().slice(0, 120) });
}

// ── every app file, and every keyframe it defines ────────────────────────────
const APPS_DIR = join(ROOT, "apps");
const appFiles = readdirSync(APPS_DIR)
  .filter((a) => { try { return statSync(join(APPS_DIR, a, "src")).isDirectory(); } catch { return false; } })
  .flatMap((a) => walk(join(APPS_DIR, a, "src")));

/** { file (repo-relative), app, name, line, ext } for every app-defined keyframe. */
const appDefs = appFiles.flatMap((file) => {
  const rel = relative(ROOT, file);
  const app = rel.split(sep)[1];
  const ext = rel.slice(rel.lastIndexOf("."));
  return findKeyframes(readFileSync(file, "utf8")).map((k) => ({ ...k, file: rel, app, ext }));
});

const describeDef = (d) => {
  const owner = KIT_OWNED.get(d.name);
  return `${d.file}:${d.line}  @keyframes ${d.name}\n` +
    `      shadows packages/ui/components.css:${owner.line}  ${owner.rule}`;
};

describe("keyframe names are document-global — components.css owns them", () => {
  // ── scan sanity ────────────────────────────────────────────────────────────
  // Every assertion below is only as good as the regex that feeds it. A scan
  // that silently stopped matching — a renamed directory, a tightened pattern,
  // a comment-stripper that ate the whole file — would report zero violations
  // and pass green forever. These floors make that failure loud instead.
  it("scanned a plausible amount of source", () => {
    expect(appFiles.length, "app source files scanned under apps/*/src").toBeGreaterThanOrEqual(40);

    const apps = new Set(appFiles.map((f) => relative(ROOT, f).split(sep)[1]));
    expect(apps.size, "apps reached by the walk").toBeGreaterThanOrEqual(8);

    // Floors, not counts: they sit well under the real numbers (183 files / 23
    // definitions / 5 apps at the time of writing) so ordinary churn does not
    // trip them, but a scan returning nothing cannot creep past them.
    expect(appDefs.length, "@keyframes definitions found across the apps").toBeGreaterThanOrEqual(12);
    expect(new Set(appDefs.map((d) => d.app)).size, "apps that define any keyframe").toBeGreaterThanOrEqual(3);
  });

  it("sees keyframes written inside JS/JSX template literals, not just .css", () => {
    // The whole point. ZTS and Clarify build their entire stylesheet as a
    // template string and append it to document.head; a `.css`-only glob sees
    // neither file, which is how six collisions survived review. If these ever
    // drop to zero the scan has quietly become CSS-only and is blind to exactly
    // the files the defect lived in — while still reporting no violations.
    const fromJs = appDefs.filter((d) => d.ext === ".js" || d.ext === ".jsx");
    expect(fromJs.length, "@keyframes found inside JS/JSX (template literals)").toBeGreaterThanOrEqual(5);
    expect(new Set(fromJs.map((d) => d.app)).size, "apps defining keyframes from JS").toBeGreaterThanOrEqual(2);
  });

  it("derives a non-trivial owned set from components.css rather than a hardcoded list", () => {
    expect(KIT_OWNED.size, "keyframes declared by packages/ui/components.css").toBeGreaterThanOrEqual(14);
    // Anchors, not the list: if the file stops parsing these the derivation is
    // broken, whatever else it returned.
    for (const anchor of ["shimmer", "pulse", "fadein", "spin", "rise"]) {
      expect([...KIT_OWNED.keys()], `components.css still declares ${anchor}`).toContain(anchor);
    }
  });

  // ── the rule ───────────────────────────────────────────────────────────────
  it("no app redefines a kit-owned keyframe name", () => {
    const violations = appDefs.filter((d) => KIT_OWNED.has(d.name));
    expect(
      violations.map(describeDef),
      "A @keyframes name cannot be scoped. Reference the kit's name, or define a\n" +
      "    PREFIXED one (zts-/co-/mc-/rw-/sy-/biz-/sh-) and repoint that app's own\n" +
      "    consumers at it. See DESIGN.md §6.",
    ).toEqual([]);
  });

  it("no shipped file inside packages/ui redefines a components.css name either", () => {
    // packages/ui/index.jsx injects its keyframes into document.head at import
    // time, which lands AFTER the bundled components.css however the bundler
    // orders sheets — so the kit was capable of shadowing itself, and did: its
    // `shimmer` was a background-position sweep that killed the kit's own
    // `.sk::after`. It is `ccShimmerBg` now.
    const uiFiles = walk(join(ROOT, "packages/ui")).filter((f) => f !== KIT_SHEET);
    expect(uiFiles.length, "sibling files scanned in packages/ui").toBeGreaterThanOrEqual(2);
    const violations = uiFiles.flatMap((file) => {
      const rel = relative(ROOT, file);
      return findKeyframes(readFileSync(file, "utf8"))
        .filter((k) => KIT_OWNED.has(k.name))
        .map((k) => `${rel}:${k.line}  @keyframes ${k.name}`);
    });
    expect(violations, "components.css is the sole owner — prefix these (cc…)").toEqual([]);
  });

  // ── the other half of the rule: prefixed names are the sanctioned escape ───
  it("recognises legitimately prefixed app keyframes as fine", () => {
    const names = new Set(appDefs.map((d) => d.name));
    // business and runway already did this correctly and are the worked
    // examples DESIGN.md §6 points at. They must be VISIBLE to the scan (so this
    // is not a vacuous pass) and must NOT be flagged.
    for (const ok of ["bizPulse", "bizSpin", "bizRise", "rw-pulse", "rw-fadein", "rw-rise"]) {
      expect(names, `${ok} is defined by an app and the scan can see it`).toContain(ok);
      expect(KIT_OWNED.has(ok), `${ok} is prefixed, so it is not a collision`).toBe(false);
    }
  });

  it("ignores @keyframes mentioned in prose, so documenting the trap is safe", () => {
    // Runway's app.css and polish.css explain the trap by naming `@keyframes
    // pulse` and `@keyframes rise` inside comments. Those are not definitions.
    expect(findKeyframes("/* a bare @keyframes pulse would shadow the kit's */")).toEqual([]);
    expect(findKeyframes("// @keyframes rise here would be global\n")).toEqual([]);
    // …while a real one on the next line is still caught, at the right number.
    expect(findKeyframes("/* @keyframes pulse */\n@keyframes pulse { }")).toEqual([{ name: "pulse", line: 2 }]);
  });
});
