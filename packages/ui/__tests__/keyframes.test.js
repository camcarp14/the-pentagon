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
// ── WHAT THE FIRST VERSION OF THIS GUARD MISSED ─────────────────────────────
// It derived the owned set from components.css ONLY, and it scanned apps/*/src
// ONLY. Four holes, each demonstrated by mutation, each leaving the suite green:
//
//   1. THE KIT SHIPS MORE THAN ONE STYLESHEET. `packages/ui/index.jsx` injects
//      `toastIn/toastOut/toastShrink/paletteIn` into document.head at import
//      time and its own Toast and CommandPalette consume them; `polish.js`
//      injects `ccPageIn/ccRise/ccShimmer`. ZTS and Clarify each redefined all
//      four toast/palette names with a translateX(18px) throw against the kit's
//      translateY(-8px), from a `useEffect(…, [])` with no cleanup. Both are
//      lazy() mounted inside a ToastProvider that wraps the whole shell, so they
//      landed last and won for the life of the page: open ZTS once and EVERY
//      tool's toasts slid in from the right. Invisible to a components.css-only
//      owned set. The owned set is now the union over every file every package
//      ships.
//   2. PACKAGES OTHER THAN @cc/ui SHIP CSS. `packages/mind-canvas/css.js`
//      injects a sheet into document.head in all three mind-bearing tools and
//      was outside the scan entirely — `@keyframes shimmer` added there, the
//      literal original bug, passed green.
//   3. `@-webkit-keyframes` DOES NOT CONTAIN THE STRING `@keyframes`, so the old
//      pattern could not see it. No file uses the prefixed form today, and
//      DESIGN.md §7 makes iOS/WebKit standalone a first-class target, which is
//      exactly where it comes back.
//   4. APP-VS-APP DUPLICATION WAS UNGUARDED. §6 rule 2 — "an identical copy is a
//      future divergence that nothing will catch" — had nothing enforcing it.
//      ZTS and Clarify held byte-identical `cardIn`, and their two DnaViews hold
//      byte-identical `dnaGlyph`. Both inject into the same document; whichever
//      mounts last owns the name for both.
//
// Properties this guard has to keep, because every one of them was a defect:
//   • The owned set is DERIVED from the package sources, never hardcoded. Add a
//     keyframe to any package sheet and it is protected on the next run.
//   • Every package is scanned, not just @cc/ui.
//   • Every app directory is scanned, not just apps/*/src — `tools/`, `*.html`
//     and `public/` ship too.
//   • The scan reads JS/JSX/MJS as well as CSS. ZTS, Clarify, @cc/ui and
//     mind-canvas all build their sheets as template literals; a `.css`-only
//     glob sees none of them, which is exactly how this survived.
//   • Vendor-prefixed at-rules count as definitions.
//   • Scan-sanity floors sit next to every derived set, so a pattern that
//     quietly stops matching fails loudly instead of reporting zero violations.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// Text formats that can carry a stylesheet. `.mjs` is here for
// apps/sync/tools/scope-css.mjs, `.html` for the standalone entry documents:
// both are outside apps/*/src and both were unscanned.
const SCANNED_EXT = [".css", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".html"];

// `dist`/`build` are compiled output — apps/shell/dist contains a bundled copy
// of every sheet in the repo, so scanning it would report the whole kit as a
// duplicate of itself. `__tests__` is excluded because this file and several
// app tests quote `@keyframes` in assertion strings.
const SKIP_DIRS = new Set(["node_modules", "__tests__", "dist", "build", "coverage", ".vite", ".next", ".git"]);

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

// `@-webkit-keyframes` / `@-moz-keyframes` / `@-o-keyframes` / `@-ms-keyframes`
// register into the SAME global namespace as the unprefixed form, in the engines
// that honour them. The old pattern required the literal `@keyframes` and so was
// blind to all of them.
const KEYFRAME_RE = /@(-(?:webkit|moz|o|ms)-)?keyframes\s+("[^"]+"|'[^']+'|[A-Za-z_-][A-Za-z0-9_-]*)/g;

/** The `{ … }` block starting at or after `from`, brace-matched (stops nest). */
function blockAt(src, from) {
  const open = src.indexOf("{", from);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

const norm = (s) => s.replace(/\s+/g, " ").trim();

/** Every keyframe DEFINITION in a source: name, 1-based line, vendor prefix, body. */
function findKeyframes(src) {
  const clean = stripComments(src);
  const out = [];
  for (const m of clean.matchAll(KEYFRAME_RE)) {
    out.push({
      name: m[2].replace(/^["']|["']$/g, ""),
      line: clean.slice(0, m.index).split("\n").length,
      prefix: m[1] || "",
      body: norm(blockAt(clean, m.index + m[0].length)),
    });
  }
  return out;
}

function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, acc);
    else if (SCANNED_EXT.some((e) => entry.endsWith(e))) acc.push(full);
  }
  return acc;
}

/** Immediate subdirectories of `apps/` or `packages/`, walked whole. */
function scanUnits(group) {
  const base = join(ROOT, group);
  return readdirSync(base)
    .filter((u) => { try { return statSync(join(base, u)).isDirectory(); } catch { return false; } })
    .flatMap((unit) => walk(join(base, unit)).map((file) => ({ unit, file, rel: relative(ROOT, file) })));
}

/** { unit, rel, name, line, prefix, body, ext } for every definition in a group. */
function definitionsIn(files) {
  return files.flatMap(({ unit, file, rel }) =>
    findKeyframes(readFileSync(file, "utf8")).map((k) => ({
      ...k, unit, rel, ext: rel.slice(rel.lastIndexOf(".")),
    })),
  );
}

const packageFiles = scanUnits("packages");
const appFiles = scanUnits("apps");
const packageDefs = definitionsIn(packageFiles);
const appDefs = definitionsIn(appFiles);

/**
 * The owned set: every keyframe name any package ships, from any of its files.
 * Derived, never listed — components.css, packages/ui/index.jsx's injected
 * block, packages/ui/polish.js and packages/mind-canvas/css.js all land here
 * because they are all files inside packages/.
 *
 * name -> [definitions] — a list, because a name appearing in two package files
 * is itself a violation and the report has to be able to name both sites.
 */
const PACKAGE_OWNED = new Map();
for (const d of packageDefs) {
  if (!PACKAGE_OWNED.has(d.name)) PACKAGE_OWNED.set(d.name, []);
  PACKAGE_OWNED.get(d.name).push(d);
}

const site = (d) => `${d.rel}:${d.line}`;
/** One definition site per FILE: `@keyframes X` + `@-webkit-keyframes X` in the
 *  same file is one declaration written twice for two engines, not a shadow. */
const filesDefining = (defs) => [...new Set(defs.map((d) => d.rel))];

const describeShadow = (d) =>
  `${site(d)}  @${d.prefix}keyframes ${d.name}\n` +
  `      shadows ${PACKAGE_OWNED.get(d.name).map(site).join(", ")}`;

// ── the one duplicate that is known, pinned, and out of reach ────────────────
// A name defined in two app files is DESIGN.md §6 rule 2's case: identical
// today, silently divergent the first time someone edits one of them. There is
// exactly one left, and it is registered rather than exempted — the assertion
// below re-reads both copies and fails the moment they stop matching, so the
// divergence this rule exists to prevent is still caught. Adding an entry here
// is a visible edit to this file, which is the point.
const PINNED_APP_DUPLICATES = {
  dnaGlyph:
    "apps/zts/src/dna/DnaView.jsx and apps/clarify/src/features/dna/DnaView.jsx. " +
    "Both DNA tabs are being retired in favour of the shell's Minds screen " +
    "(DESIGN.md §5, 'Still outstanding'), so the name has no long-term home to " +
    "be promoted to; it is pinned identical until those views are deleted.",
};

describe("keyframe names are document-global — the packages own them", () => {
  // ── scan sanity ────────────────────────────────────────────────────────────
  // Every assertion below is only as good as the walk and the regex that feed
  // it. A scan that silently stopped matching — a renamed directory, a tightened
  // pattern, a comment-stripper that ate the whole file — would report zero
  // violations and pass green forever. These floors make that failure loud.
  // They sit well under the real numbers so ordinary churn does not trip them.
  it("scanned a plausible amount of source, in both apps/ and packages/", () => {
    expect(appFiles.length, "files scanned under apps/").toBeGreaterThanOrEqual(150);
    expect(packageFiles.length, "files scanned under packages/").toBeGreaterThanOrEqual(20);

    expect(new Set(appFiles.map((f) => f.unit)).size, "apps reached by the walk").toBeGreaterThanOrEqual(8);
    expect(new Set(packageFiles.map((f) => f.unit)).size, "packages reached by the walk").toBeGreaterThanOrEqual(6);

    expect(appDefs.length, "@keyframes definitions found across the apps").toBeGreaterThanOrEqual(10);
    expect(new Set(appDefs.map((d) => d.unit)).size, "apps that define any keyframe").toBeGreaterThanOrEqual(4);

    // Compiled output is deliberately out of scope: apps/shell/dist bundles a
    // copy of every sheet here, so including it would make the kit a shadow of
    // itself. If that exclusion ever stops working the counts explode and the
    // duplicate assertions go red for nonsense reasons — catch it here instead.
    expect(
      [...appFiles, ...packageFiles]
        .filter((f) => /(^|[\\/])(dist|node_modules|build)[\\/]/.test(f.rel))
        .map((f) => f.rel),
      "compiled output must stay out of the scan",
    ).toEqual([]);
  });

  it("reaches app files outside apps/*/src — tools/, *.html, public/", () => {
    // The old walk started at apps/<app>/src, so apps/sync/tools/scope-css.mjs
    // (which rewrites SYNC's stylesheet, keyframes and all) and every standalone
    // index.html were unreachable. If this drops to zero the walk has silently
    // gone back to src-only while still reporting no violations.
    const outside = appFiles.filter((f) => !f.rel.includes(`${sep}src${sep}`));
    expect(outside.length, "app files scanned outside apps/*/src").toBeGreaterThanOrEqual(4);
    expect(
      outside.some((f) => f.rel.endsWith(".mjs")),
      "apps/sync/tools/scope-css.mjs (or another app tool) is in the scan",
    ).toBe(true);
    expect(
      outside.some((f) => f.rel.endsWith(".html")),
      "the standalone index.html documents are in the scan",
    ).toBe(true);
  });

  it("sees keyframes written inside JS/JSX template literals, not just .css", () => {
    // The whole point. ZTS, Clarify, @cc/ui and mind-canvas all build a
    // stylesheet as a template string and append it to document.head; a
    // `.css`-only glob sees none of them, which is how six collisions survived
    // review and how the toast/palette four survived the first fix.
    const isJs = (d) => [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"].includes(d.ext);
    const fromAppJs = appDefs.filter(isJs);
    expect(fromAppJs.length, "@keyframes found inside app JS/JSX").toBeGreaterThanOrEqual(3);
    expect(new Set(fromAppJs.map((d) => d.unit)).size, "apps defining keyframes from JS").toBeGreaterThanOrEqual(2);

    const fromPkgJs = packageDefs.filter(isJs);
    expect(fromPkgJs.length, "@keyframes found inside package JS (injected sheets)").toBeGreaterThanOrEqual(8);
    expect(new Set(fromPkgJs.map((d) => d.unit)).size, "packages injecting keyframes from JS").toBeGreaterThanOrEqual(2);
  });

  it("derives the owned set from EVERY stylesheet the packages ship", () => {
    expect(PACKAGE_OWNED.size, "keyframe names owned across packages/").toBeGreaterThanOrEqual(20);

    // Each shipping sheet must contribute — counted by FILE, not by name, so the
    // derivation stays derived. components.css alone was the first fix's blind
    // spot; these four are the sheets that actually reach document.head.
    const contributed = (rel) => packageDefs.filter((d) => d.rel.split(sep).join("/") === rel).length;
    expect(contributed("packages/ui/components.css"), "names from components.css").toBeGreaterThanOrEqual(14);
    expect(contributed("packages/ui/index.jsx"), "names from the @cc/ui injected sheet").toBeGreaterThanOrEqual(5);
    expect(contributed("packages/ui/polish.js"), "names from the polish sheet").toBeGreaterThanOrEqual(2);
    expect(contributed("packages/mind-canvas/css.js"), "names from the mind-canvas sheet").toBeGreaterThanOrEqual(1);

    // Anchors, not the list: if the sources stop parsing these, the derivation
    // is broken whatever else it returned. Several from each shipping sheet.
    for (const anchor of [
      "shimmer", "pulse", "fadein", "spin", "rise", "cardIn", // components.css
      "toastIn", "toastOut", "toastShrink", "paletteIn",      // packages/ui/index.jsx
      "ccPageIn", "ccShimmer",                                // packages/ui/polish.js
      "ccMindFadein",                                         // packages/mind-canvas/css.js
    ]) {
      expect([...PACKAGE_OWNED.keys()], `a package still declares ${anchor}`).toContain(anchor);
    }
  });

  // ── the rule ───────────────────────────────────────────────────────────────
  it("no app redefines a name any package owns", () => {
    const violations = appDefs.filter((d) => PACKAGE_OWNED.has(d.name));
    expect(
      violations.map(describeShadow),
      "A @keyframes name cannot be scoped, and an app sheet appended to\n" +
      "    document.head lands after the kit's for EVERY tool on screen. Reference\n" +
      "    the package's name, or define a PREFIXED one (zts-/co-/mc-/rw-/sy-/biz-/\n" +
      "    sh-) and repoint that app's own consumers at it. See DESIGN.md §6.",
    ).toEqual([]);
  });

  it("no package shadows another package's name — one name, one owner", () => {
    // packages/ui/index.jsx and polish.js inject into document.head at import
    // time, which lands AFTER the bundled components.css however the bundler
    // orders sheets — so the kit was capable of shadowing itself, and did: its
    // `shimmer` was a background-position sweep that killed the kit's own
    // `.sk::after`. It is `ccShimmerBg` now. packages/mind-canvas/css.js injects
    // into the same head from three tools and was not scanned at all.
    const violations = [...PACKAGE_OWNED.entries()]
      .filter(([, defs]) => filesDefining(defs).length > 1)
      .map(([name, defs]) => `@keyframes ${name} defined in ${filesDefining(defs).join(" AND ")}`);
    expect(
      violations,
      "Two package sheets cannot both own a name — whichever is injected last\n" +
      "    wins for every tool. Prefix the non-owner (cc…/ccMind…). See DESIGN.md §6.",
    ).toEqual([]);
  });

  it("counts @-webkit-keyframes as a definition", () => {
    // '@-webkit-keyframes' does not contain the substring '@keyframes', so the
    // first pattern was blind to it and a prefixed shadow passed green. Nothing
    // uses the prefixed form today; DESIGN.md §7 makes iOS/WebKit standalone a
    // protected target, which is exactly where it comes back.
    expect(findKeyframes("@-webkit-keyframes shimmer { 100% { opacity: 1; } }").map((k) => k.name)).toEqual(["shimmer"]);
    expect(findKeyframes("@-moz-keyframes pulse { }").map((k) => k.name)).toEqual(["pulse"]);
    expect(findKeyframes("@-ms-keyframes spin { }")[0].prefix).toBe("-ms-");
    // …and it is the SAME name, so it collides with the unprefixed form.
    const both = findKeyframes("@keyframes fadein { }\n@-webkit-keyframes fadein { }");
    expect(both.map((k) => k.name)).toEqual(["fadein", "fadein"]);
    expect(both.map((k) => k.line)).toEqual([1, 2]);
  });

  // ── §6 rule 2: an identical copy is a future divergence ────────────────────
  it("no keyframe name is defined by two different app files", () => {
    const byName = new Map();
    for (const d of appDefs) {
      if (!byName.has(d.name)) byName.set(d.name, []);
      byName.get(d.name).push(d);
    }
    const violations = [...byName.entries()]
      .filter(([name, defs]) => filesDefining(defs).length > 1 && !(name in PINNED_APP_DUPLICATES))
      .map(([name, defs]) => `@keyframes ${name} defined in ${filesDefining(defs).join(" AND ")}`);
    expect(
      violations,
      "Both sheets are appended to the same document, so whichever app mounts\n" +
      "    last owns the name for BOTH. Identical today is not safe: DESIGN.md §6\n" +
      "    rule 2 — an identical copy is a future divergence that nothing will\n" +
      "    catch. Promote the name to packages/ui/components.css if both apps want\n" +
      "    the same motion (that is what `cardIn` did), or prefix it per app.",
    ).toEqual([]);
  });

  it("the pinned app-vs-app duplicate is still real, and still identical", () => {
    for (const [name, why] of Object.entries(PINNED_APP_DUPLICATES)) {
      const defs = appDefs.filter((d) => d.name === name);
      // Non-vacuous: a stale pin is a hole the next reader will trust.
      expect(filesDefining(defs).length, `${name} is still defined in two app files — ${why}`).toBeGreaterThanOrEqual(2);
      // The pin is a lock, not an exemption: the moment the copies diverge —
      // which is the entire risk §6 rule 2 names — this goes red.
      const bodies = [...new Set(defs.map((d) => d.body))];
      expect(
        bodies.length === 1 ? [] : defs.map((d) => `${site(d)}  ${d.body}`),
        `${name} has diverged between apps. It was pinned identical because:\n    ${why}`,
      ).toEqual([]);
    }
  });

  // ── the other half of the rule: prefixed names are the sanctioned escape ───
  it("recognises legitimately prefixed / app-private keyframes as fine", () => {
    const names = new Set(appDefs.map((d) => d.name));
    // business, runway and sync already did this correctly and are the worked
    // examples DESIGN.md §6 points at; slideup/fadeup/dnaGlyph are app-private
    // names no package claims. All must be VISIBLE to the scan (so this is not a
    // vacuous pass) and none may be flagged.
    for (const ok of [
      "bizPulse", "bizSpin", "bizRise",
      "rw-pulse", "rw-fadein", "rw-rise",
      "thinkdot", "cmdkin", "convo-live",
      "slideup", "fadeup", "dnaGlyph",
    ]) {
      expect(names, `${ok} is defined by an app and the scan can see it`).toContain(ok);
      expect(PACKAGE_OWNED.has(ok), `${ok} collides with no package name`).toBe(false);
    }
  });

  it("every animation a package sheet references resolves to a name a package owns", () => {
    // The other direction of the same bug: rename or drop a keyframe and the
    // consumer keeps its old string, silently animating nothing.
    //
    // Plain-CSS shorthand only — the declaration must run from the ident to a
    // `;`/`}` without a quote, a brace or a newline in between. That is what
    // keeps JS call sites out: `animation: RM ? "none" : "ccMindFadein 0.25s"`
    // in MindCanvas.jsx would otherwise be read as a keyframe called `RM`. The
    // interpolating call sites are covered by the definition-side assertions
    // instead; this one guards the sheets that are literal CSS.
    const KEYWORDS = new Set(["none", "inherit", "initial", "unset", "revert", "revert-layer"]);
    const REF_RE = /animation(?:-name)?:\s*([A-Za-z_][A-Za-z0-9_-]*)[^;{}"'`\n]*[;}]/g;
    const refs = packageFiles.flatMap(({ file, rel }) => {
      const clean = stripComments(readFileSync(file, "utf8"));
      return [...clean.matchAll(REF_RE)]
        .map((m) => ({ name: m[1], rel, line: clean.slice(0, m.index).split("\n").length }))
        .filter((r) => !KEYWORDS.has(r.name));
    });
    expect(refs.length, "animation: declarations found in package sheets").toBeGreaterThanOrEqual(15);
    expect(
      refs.filter((r) => !PACKAGE_OWNED.has(r.name)).map((r) => `${r.rel}:${r.line}  animation: ${r.name}`),
      "this call site names a keyframe no package defines",
    ).toEqual([]);
  });

  it("ignores @keyframes mentioned in prose, so documenting the trap is safe", () => {
    // Runway's app.css and polish.css explain the trap by naming `@keyframes
    // pulse` and `@keyframes rise` inside comments, and the notes in
    // zts/clarify/@cc-ui now name the toast set the same way. Not definitions.
    expect(findKeyframes("/* a bare @keyframes pulse would shadow the kit's */")).toEqual([]);
    expect(findKeyframes("// @keyframes rise here would be global\n")).toEqual([]);
    expect(findKeyframes("/* @-webkit-keyframes shimmer is a shadow too */")).toEqual([]);
    // …while a real one on the next line is still caught, at the right number.
    const real = findKeyframes("/* @keyframes pulse */\n@keyframes pulse { 50% { opacity: 0; } }");
    expect(real.map((k) => [k.name, k.line])).toEqual([["pulse", 2]]);
    expect(real[0].body).toBe("{ 50% { opacity: 0; } }");
  });
});
