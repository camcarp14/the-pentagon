// Scope SYNC's stylesheet under a single root class so it can live inside the
// Pentagon shell without colliding with the globally-installed @cc/ui polish
// sheet — and without touching a single className in the JSX.
//
// Two things this buys, both from specificity alone:
//   · `.sy-root .seg button` (0,2,1) beats polish's `.seg button` (0,1,1), so
//     SYNC keeps its own opinion of the seven classes they share.
//   · SYNC's tokens, defined ON `.sy-root`, beat the Pentagon values inherited
//     from the shell's wrapper — which is an inline style, and therefore
//     unbeatable by any stylesheet rule targeting the wrapper itself, but has
//     no say over a descendant that redefines the same custom property.
//
// A rename would have had to touch ~25 JSX files; this touches none.

import { readFileSync, writeFileSync } from "node:fs";

const SCOPE = ".sy-root";

// Rules that describe the document, not the app. The shell already owns every
// one of them (apps/shell/index.html sets box-sizing, the fonts and
// --safe-bottom), so carrying SYNC's copies in would fight the host.
const DROP_SELECTORS = new Set(["*", "html", "body", "#root", "html, body, #root"]);

/**
 * Split a stylesheet into top-level rules, respecting parens, strings AND
 * comments. The comment case is not theoretical: this file's own prose is full
 * of apostrophes ("iOS's wrong idea of the screen"), and treating one as an
 * opening quote swallows every brace after it, which silently collapses the
 * whole sheet into a single rule.
 */
function splitTop(css) {
  const out = [];
  let depth = 0, brace = 0, start = 0, quote = null, comment = false;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (comment) { if (c === "*" && css[i + 1] === "/") { comment = false; i++; } continue; }
    if (quote) { if (c === quote && css[i - 1] !== "\\") quote = null; continue; }
    if (c === "/" && css[i + 1] === "*") { comment = true; i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "{") brace++;
    else if (c === "}") {
      brace--;
      if (brace === 0 && depth === 0) { out.push(css.slice(start, i + 1)); start = i + 1; }
    }
  }
  if (start < css.length) out.push(css.slice(start));
  return out;
}

/** Scope one comma-separated selector list. */
function scopeSelector(sel) {
  return sel
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    // The Quartz (light) room is dropped rather than scoped. The Pentagon is
    // one dark canvas and the shell hardcodes data-theme="dark", so these rules
    // could never match — and collapsing them onto the scope root, as a naive
    // rewrite does, makes the LIGHT palette win outright because it is declared
    // after Obsidian.
    .filter((s) => !/\[data-theme=["']?day["']?\]/.test(s))
    .map((s) => {
      // `:root` and the night-theme variant both describe the token host.
      // Inside the Pentagon that host is the scope root itself.
      if (s === ":root" || /^\[data-theme=/.test(s)) return SCOPE;
      if (s === "body" || s === "html" || s === "#root") return SCOPE;
      // Pseudo-elements that hang off the document (::selection) attach to the
      // scope's subtree rather than replacing it.
      if (s.startsWith("::")) return `${SCOPE} ${s}`;
      return `${SCOPE} ${s}`;
    })
    // A rule like `:root, [data-theme="night"]` collapses to one selector.
    .filter((s, i, a) => a.indexOf(s) === i)
    .join(", ");
}

function transform(css, { top = true } = {}) {
  const chunks = splitTop(css);
  const out = [];

  for (const chunk of chunks) {
    const braceAt = chunk.indexOf("{");
    if (braceAt === -1) { out.push(chunk); continue; }

    const prelude = chunk.slice(0, braceAt);
    const body = chunk.slice(braceAt + 1, chunk.lastIndexOf("}"));
    const lead = prelude.match(/^\s*/)[0];
    const sel = prelude.trim();

    // Comments before a selector ride along in `prelude`; keep them.
    const commentMatch = sel.match(/^((?:\/\*[\s\S]*?\*\/\s*)*)([\s\S]*)$/);
    const comments = commentMatch[1] || "";
    const bare = (commentMatch[2] || "").trim();

    // @font-face is dropped wholesale: the shell serves Inter from Google
    // Fonts, and SYNC's self-hosted copy would need its woff2 files carried
    // into a package that is meant to be source-only.
    if (/^@font-face/i.test(bare)) { out.push(lead + comments); continue; }

    // @keyframes bodies are percentage stops, not selectors. SYNC's names are
    // all un-prefixed but none collide with polish's cc* set, so they pass
    // through untouched.
    if (/^@(keyframes|-webkit-keyframes|font-feature-values|property|counter-style)/i.test(bare)) {
      out.push(chunk);
      continue;
    }

    // Conditional groups nest real rules — recurse into the body.
    if (/^@(media|supports|container|layer)/i.test(bare)) {
      out.push(`${lead}${comments}${bare} {${transform(body, { top: false })}}`);
      continue;
    }

    if (bare.startsWith("@")) { out.push(chunk); continue; }

    if (DROP_SELECTORS.has(bare)) {
      // `body` carries the app's typographic ground floor, which IS wanted —
      // it just belongs on the scope root now. The document-level parts
      // (margin, overflow, overscroll) are the host's business and are cut.
      if (bare === "body") {
        const kept = body
          .split(";")
          .filter((d) => !/^\s*(margin|overflow|overscroll-behavior)\s*:/.test(d))
          .join(";");
        out.push(`${lead}${comments}${SCOPE} {${kept}}`);
      } else {
        out.push(lead + comments);
      }
      continue;
    }

    const scoped = scopeSelector(bare);
    // Every selector in the list was a light-room rule; the whole block goes.
    if (!scoped) { out.push(lead + comments); continue; }
    out.push(`${lead}${comments}${scoped} {${body}}`);
  }

  return out.join("");
}

const [, , tokensPath, componentsPath, stylesPath, outPath] = process.argv;

const tokens = readFileSync(tokensPath, "utf8");
const components = readFileSync(componentsPath, "utf8");
// styles.css leads with @import lines for the other two; we concatenate
// explicitly instead so the output is one flat sheet.
const styles = readFileSync(stylesPath, "utf8").replace(/@import[^;]+;/g, "");

const header = `/* ═══════════════════════════════════════════════════════════════════════════
   SYNC — one flat, scoped stylesheet.

   GENERATED from the standalone app's tokens.css + components.css +
   styles.css by scripts/scope-css.mjs. Every selector is prefixed with
   ${SCOPE}, for two reasons that both matter inside the Pentagon:

     · @cc/ui installs a global, permanent <style id="cc-polish"> (it calls
       installPolish() at module scope and the shell imports it), which styles
       seven classes SYNC also uses — .seg .sk .sk-line .sk-big .expand
       .stagger .pagefade. Scoping wins those on specificity, so neither sheet
       has to know about the other.

     · The shell stamps cssVars(app) as an INLINE STYLE on its wrapper. An
       inline style cannot be beaten by a stylesheet rule on the same element,
       but a DESCENDANT that redefines the same custom property does win — so
       SYNC's 71 tokens, declared on ${SCOPE} below, hold inside SYNC and
       nowhere else.

   The Quartz (light) room is gone: the Pentagon is one dark canvas and the
   shell hardcodes data-theme="dark", so a second room would be unreachable.
   ═══════════════════════════════════════════════════════════════════════════ */

`;

const merged = `${tokens}\n${components}\n${styles}`;
writeFileSync(outPath, header + transform(merged));
console.log(`wrote ${outPath}`);
