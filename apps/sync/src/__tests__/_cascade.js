// ─── A cascade, not a grep ────────────────────────────────────────────────────
//
// Every CSS guard in this app used to read apps/sync/src/styles.css and only
// that file. That was sound while SYNC owned all 1,110 lines of its own
// appearance. It stopped being sound the day .sy-root grew a `data-kit`
// attribute, because from that moment packages/ui/components.css declares on
// SYNC's elements too — and a guard that cannot see the kit cannot see:
//
//   · a property SYNC deletes and the kit then supplies (the entrance's
//     `justify-content: center`, the dock tab's raw env() padding, the sheet's
//     env() max-height — every one of those deletions was GREEN);
//   · a property SYNC declares at the same weight as the kit, where the winner
//     is decided by which sheet the browser parsed last rather than by the
//     stylesheet (dropping `[data-kit]` off an override was GREEN);
//   · an anti-pattern assembled from one declaration in each sheet
//     (`.sy-root .card { border }` + `[data-kit] .card { box-shadow }`).
//
// So this module resolves the cascade over BOTH sheets, in document order, the
// way the browser does: match, weigh by specificity, break ties by source
// order. It is deliberately small and deliberately LOUD — a selector it cannot
// parse is reported, never skipped, because a silent skip is how every hole
// listed above stayed green.
//
// It is not a CSS engine. It models exactly what this app needs: descendant and
// child combinators over compounds of tag / class / attribute, with any
// pseudo-class or pseudo-element making a compound non-matching for the resting
// element (which is what keeps `:hover` and `:focus-visible` their own rows —
// see the note on the border-and-shadow guard in render.test.jsx).

import { readFileSync } from "node:fs";

/* ── parsing ───────────────────────────────────────────────────────────────── */

const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/** Index just past the `}` closing the brace group starting at i. */
function endBraces(s, i) {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'") {
      const q = c;
      for (j++; j < s.length; j++) { if (s[j] === "\\") j++; else if (s[j] === q) break; }
      continue;
    }
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) return j + 1; }
  }
  return s.length;
}

/**
 * Every style rule in a sheet as { media, selector, decls }.
 * Descends into @media/@supports/@layer/@container/@scope and records the
 * condition, because a rule inside `@media (max-width: 760px)` is a real rule
 * that a resting-state guard must see. Skips @keyframes, whose `from`/`40%`
 * preludes are stops rather than selectors.
 */
export function parseSheet(text) {
  const out = [];
  (function walk(body, media) {
    let i = 0, prelude = "";
    while (i < body.length) {
      const c = body[i];
      if (c !== "{") { prelude += c; i++; continue; }
      const end = endBraces(body, i);
      const inner = body.slice(i + 1, end - 1);
      const sel = prelude.trim().replace(/\s+/g, " ");
      if (sel.startsWith("@")) {
        if (/^@(media|supports|layer|container|scope)\b/i.test(sel)) {
          walk(inner, media ? `${media} AND ${sel}` : sel);
        }
      } else if (sel) {
        out.push({ media, selector: sel, decls: inner });
      }
      prelude = ""; i = end;
    }
  })(stripCssComments(text), "");
  return out;
}

/** Split a comma-separated list at top level (parens and quotes respected). */
function splitTop(s, sep) {
  const out = [];
  let d = 0, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c; cur += c;
      for (i++; i < s.length; i++) { cur += s[i]; if (s[i] === "\\") { i++; cur += s[i]; } else if (s[i] === q) break; }
      continue;
    }
    if (c === "(" || c === "[") d++;
    else if (c === ")" || c === "]") d--;
    if (c === sep && d === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/* ── declarations ──────────────────────────────────────────────────────────── */

const BOX_SIDES = ["top", "right", "bottom", "left"];

/** `10px 0 calc(1px + 2px)` → ["10px", "0", "calc(1px + 2px)"] */
function splitValues(v) {
  const out = [];
  let d = 0, cur = "";
  for (const c of v) {
    if (c === "(") d++;
    else if (c === ")") d--;
    if (/\s/.test(c) && d === 0) { if (cur) { out.push(cur); cur = ""; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** [top, right, bottom, left] from a 1–4 value box shorthand. */
function boxSides(v) {
  const p = splitValues(v);
  if (!p.length || p.length > 4) return null;
  const [a, b = a, c = a, d = b] = p;
  return [a, b, c, d];
}

/**
 * Declarations of one rule body, in order, with the shorthands this app's
 * guards actually query expanded into longhands. A guard asking for
 * `padding-bottom` must see the kit's `padding: 8px 0 calc(8px + env(…))`, or
 * the safe-area override it is pinning is invisible to it.
 */
export function parseDecls(body) {
  const out = [];
  let idx = 0;
  for (const raw of splitTop(body, ";")) {
    const m = /^([-\w]+)\s*:\s*([\s\S]*)$/.exec(raw.trim());
    if (!m) continue;
    const prop = m[1].toLowerCase();
    let value = m[2].trim();
    let important = false;
    if (/!\s*important$/i.test(value)) { important = true; value = value.replace(/!\s*important$/i, "").trim(); }
    const at = idx++;
    out.push({ prop, value, important, at });
    // padding / margin → four longhands
    if (prop === "padding" || prop === "margin") {
      const sides = boxSides(value);
      if (sides) BOX_SIDES.forEach((s, i) => out.push({ prop: `${prop}-${s}`, value: sides[i], important, at }));
    }
    // border → four sides (the value is carried whole; the guards only ask
    // whether a side draws a line, never how wide)
    if (prop === "border") {
      for (const s of BOX_SIDES) out.push({ prop: `border-${s}`, value, important, at });
    }
    if (prop === "border-width" || prop === "border-style" || prop === "border-color") {
      const sides = boxSides(value);
      if (sides) BOX_SIDES.forEach((s, i) => out.push({ prop: `border-${s}`, value: sides[i], important, at }));
    }
  }
  return out;
}

/* ── selectors ─────────────────────────────────────────────────────────────── */

/**
 * One selector as a list of compounds and the combinators between them.
 * `ok: false` means this module refuses to guess — sibling combinators, or a
 * compound it cannot tokenise. Callers must surface those rather than drop
 * them; `unhandledFor()` below is how.
 */
export function parseSelector(sel) {
  let parts = [];
  let cur = "", combos = [];
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === "(" || c === "[") {
      let d = 0;
      for (; i < sel.length; i++) {
        cur += sel[i];
        if (sel[i] === "(" || sel[i] === "[") d++;
        else if (sel[i] === ")" || sel[i] === "]") { d--; if (!d) break; }
      }
      continue;
    }
    if (c === " " || c === ">" || c === "+" || c === "~") {
      let combo = c === " " ? " " : c;
      let j = i;
      while (j < sel.length && /[\s>+~]/.test(sel[j])) { if (sel[j] !== " ") combo = sel[j]; j++; }
      if (cur) { parts.push(cur); combos.push(combo); }
      cur = ""; i = j - 1;
      continue;
    }
    cur += c;
  }
  if (cur) parts.push(cur);
  if (parts.length !== combos.length + 1) return { ok: false, raw: sel };

  // Sibling combinators are not modelled — an element's siblings are not in the
  // chain. Rather than drop the rule (a silent skip, which is how every hole in
  // this app's guards was made), the selector is WIDENED to its subject side:
  // `.sy-root .v-row + .v-row` is treated as "any .v-row under the root". That
  // over-matches, which for a guard phrased as "this must never be true" is the
  // safe direction — it can raise a false alarm, never miss a real one.
  const lastSib = combos.reduce((acc, c, i) => (c === "+" || c === "~" ? i : acc), -1);
  if (lastSib >= 0) { parts = parts.slice(lastSib + 1); combos = combos.slice(lastSib + 1); }

  const compounds = [];
  for (const p of parts) {
    const cp = { tag: null, classes: [], attrs: [], pseudo: false };
    let rest = p;
    // pseudo-classes / pseudo-elements, with their argument lists
    rest = rest.replace(/::?[-\w]+(\((?:[^()]|\([^()]*\))*\))?/g, () => { cp.pseudo = true; return ""; });
    // attributes
    rest = rest.replace(/\[([^\]]*)\]/g, (_, a) => { cp.attrs.push(a.trim().replace(/\s+/g, "")); return ""; });
    // classes
    rest = rest.replace(/\.([-\w]+)/g, (_, c) => { cp.classes.push(c); return ""; });
    // ids are not used anywhere in either sheet; refuse rather than mis-weigh
    if (rest.includes("#")) return { ok: false, raw: sel };
    rest = rest.trim();
    if (rest && rest !== "*") {
      if (!/^[-\w]+$/.test(rest)) return { ok: false, raw: sel };
      cp.tag = rest.toLowerCase();
    }
    compounds.push(cp);
  }
  return { ok: true, raw: sel, compounds, combos };
}

/** (a, b, c) — ids, then classes/attrs/pseudo-classes, then tags. */
export function specificity(sel) {
  let a = 0, b = 0, c = 0;
  let s = sel;
  // :where() contributes nothing at all — that is the whole reason the focus
  // ring in styles.css is written with it.
  s = s.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, " ");
  // :not()/:is()/:has() take the weight of their heaviest argument; this sheet
  // only ever puts a single simple selector in one, so counting inside is right.
  s = s.replace(/:(not|is|has|matches)\(/g, " ");
  a += (s.match(/#[-\w]+/g) || []).length;
  b += (s.match(/\.[-\w]+/g) || []).length;
  b += (s.match(/\[[^\]]*\]/g) || []).length;
  b += (s.match(/(^|[^:]):[-\w]+/g) || []).length;
  c += (s.match(/::[-\w]+/g) || []).length;
  const bare = s.replace(/::?[-\w]+(\((?:[^()]|\([^()]*\))*\))?/g, " ").replace(/\[[^\]]*\]/g, " ").replace(/[.#][-\w]+/g, " ");
  c += (bare.match(/(^|[\s>+~])([a-zA-Z][-\w]*)/g) || []).length;
  return [a, b, c];
}

const cmpSpec = (x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);

/* ── elements ──────────────────────────────────────────────────────────────── */

/**
 * An element is its ancestor chain, outermost first, each link being
 * { tag?, classes[], attrs[] }. Everything SYNC renders lives under
 * .sy-scope > .sy-root[data-kit], so that prefix is built in.
 */
export function element(...chain) {
  return [
    { tag: "div", classes: ["sy-scope"], attrs: [] },
    { tag: "div", classes: ["sy-root"], attrs: ["data-kit"] },
    ...chain.map((c) => ({ tag: c.tag ?? null, classes: c.classes || [], attrs: c.attrs || [] })),
  ];
}

/** Shorthand: element(".mind-stage", ".dotstatus") from class-name strings. */
export function el(...spec) {
  return element(...spec.map((s) => {
    if (typeof s !== "string") return s;
    const classes = [...s.matchAll(/\.([-\w]+)/g)].map((m) => m[1]);
    const tag = s.replace(/\.[-\w]+/g, "").trim() || null;
    return { tag, classes, attrs: [] };
  }));
}

function compoundMatches(cp, link) {
  if (cp.pseudo) return false;
  if (cp.tag && cp.tag !== link.tag) return false;
  for (const c of cp.classes) if (!link.classes.includes(c)) return false;
  for (const a of cp.attrs) if (!link.attrs.includes(a)) return false;
  return true;
}

/** Does a parsed selector match the element (the last link is the subject)? */
export function matches(parsed, chain) {
  if (!parsed.ok) return false;
  const { compounds, combos } = parsed;
  const last = compounds.length - 1;
  if (!compoundMatches(compounds[last], chain[chain.length - 1])) return false;
  // walk leftwards
  let ci = chain.length - 2;
  for (let k = last - 1; k >= 0; k--) {
    const combo = combos[k]; // combinator between compounds[k] and compounds[k+1]
    if (combo === ">") {
      if (ci < 0 || !compoundMatches(compounds[k], chain[ci])) return false;
      ci--;
    } else {
      let found = false;
      while (ci >= 0) {
        if (compoundMatches(compounds[k], chain[ci])) { found = true; ci--; break; }
        ci--;
      }
      if (!found) return false;
    }
  }
  return true;
}

/* ── the sheets, in document order ─────────────────────────────────────────── */

/**
 * The kit first, SYNC second — the order the browser sees them in. The kit is
 * imported once at apps/shell/src/main.jsx; SYNC injects its own sheet into
 * document.head when the tab mounts, which is necessarily later. Ties in
 * specificity therefore go to SYNC, and every guard here that depends on
 * BEATING the kit rather than tying with it says so explicitly.
 */
export function loadSheets({ syncCssPath, kitCssPath }) {
  const sheets = [
    { name: "kit", path: kitCssPath, text: readFileSync(kitCssPath, "utf8") },
    { name: "sync", path: syncCssPath, text: readFileSync(syncCssPath, "utf8") },
  ];
  const rules = [];
  const unhandled = [];
  sheets.forEach((sheet, si) => {
    parseSheet(sheet.text).forEach((r, ri) => {
      for (const one of splitTop(r.selector, ",")) {
        const parsed = parseSelector(one);
        if (!parsed.ok) { unhandled.push({ sheet: sheet.name, selector: one }); continue; }
        rules.push({
          sheet: sheet.name, si, ri, media: r.media, selector: one, parsed,
          spec: specificity(one), decls: parseDecls(r.decls),
        });
      }
    });
  });
  return { sheets, rules, unhandled, mediaContexts: [...new Set(rules.map((r) => r.media))] };
}

/** Selectors neither sheet's parse could handle that mention `token`. */
export function unhandledFor(sheetSet, token) {
  return sheetSet.unhandled.filter((u) => u.selector.includes(token));
}

/* ── resolution ────────────────────────────────────────────────────────────── */

/**
 * Every declaration of `prop` that lands on `chain`, strongest last.
 * `media` selects the at-rule context: rules with no condition always apply,
 * and rules in the named context apply on top of them. That is what lets a
 * guard ask "and what is true inside `@media (min-width: 761px)`?" — the
 * desktop sheet max-height is only pinnable that way.
 */
export function declarations(sheetSet, chain, prop, media = "") {
  const hits = [];
  for (const r of sheetSet.rules) {
    if (r.media !== "" && r.media !== media) continue;
    if (!matches(r.parsed, chain)) continue;
    for (const d of r.decls) {
      if (d.prop !== prop) continue;
      hits.push({ ...d, sheet: r.sheet, selector: r.selector, media: r.media, spec: r.spec, si: r.si, ri: r.ri });
    }
  }
  hits.sort((x, y) =>
    (x.important - y.important) || cmpSpec(x.spec, y.spec) || (x.si - y.si) || (x.ri - y.ri) || (x.at - y.at));
  return hits;
}

/** The declaration that wins, or null if neither sheet declares the property. */
export function resolve(sheetSet, chain, prop, media = "") {
  const hits = declarations(sheetSet, chain, prop, media);
  return hits.length ? hits[hits.length - 1] : null;
}

/** The winning value, or null. */
export function value(sheetSet, chain, prop, media = "") {
  return resolve(sheetSet, chain, prop, media)?.value ?? null;
}

/**
 * True when SYNC's strongest declaration of `prop` outranks the kit's on
 * SPECIFICITY ALONE — i.e. it would still win if the two sheets swapped places
 * in the document. Equal weight is not enough: an override that only wins on
 * source order is an override that depends on the shell's import order, which
 * is exactly what `[data-kit]` on the sheet and dock-tab rules exists to stop
 * depending on. Returns { ok, sync, kit }.
 */
export function outranksKit(sheetSet, chain, prop, media = "") {
  const hits = declarations(sheetSet, chain, prop, media);
  const kit = hits.filter((h) => h.sheet === "kit").pop() || null;
  const sync = hits.filter((h) => h.sheet === "sync").pop() || null;
  const ok = !!sync && (!kit || cmpSpec(sync.spec, kit.spec) > 0 || (sync.important && !kit.important));
  return { ok, sync, kit };
}

/* ── border + shadow, the §4.2 anti-pattern ────────────────────────────────── */

const REAL_BORDER = (v) => v != null && !/^\s*(none|0|0px|hidden)\s*$/i.test(v) && /\d/.test(v);
const REAL_SHADOW = (v) => v != null && !/^\s*none\s*$/i.test(v);

/** Which of the four sides actually draw a line on this element. */
export function borderedSides(sheetSet, chain, media = "") {
  return BOX_SIDES.filter((s) => REAL_BORDER(value(sheetSet, chain, `border-${s}`, media)));
}

export function hasShadow(sheetSet, chain, media = "") {
  return REAL_SHADOW(value(sheetSet, chain, "box-shadow", media));
}

/**
 * Every element either sheet actually targets, as a chain — one per distinct
 * full selector whose subject compound carries no pseudo. This is what replaces
 * "merge declarations by identical selector TEXT": `.sy-root .card` and
 * `[data-kit] .card` are two strings and one element, and the border-and-shadow
 * hole was exactly that.
 */
export function targetedElements(sheetSet) {
  const seen = new Map();
  for (const r of sheetSet.rules) {
    const { compounds } = r.parsed;
    if (compounds.some((c) => c.pseudo)) continue;
    // Drop the .sy-scope / .sy-root / [data-kit] prefix compounds: element()
    // puts those back, and a rule that only names them targets the root itself.
    const inner = compounds.filter((c) =>
      !(c.classes.includes("sy-scope") || c.classes.includes("sy-root") || (!c.classes.length && !c.tag && c.attrs.includes("data-kit"))));
    if (!inner.length) continue;
    const chain = element(...inner.map((c) => ({ tag: c.tag, classes: c.classes, attrs: c.attrs })));
    const key = chain.map((l) => `${l.tag || "*"}${l.classes.map((x) => "." + x).join("")}${l.attrs.map((a) => `[${a}]`).join("")}`).join(" ");
    if (!seen.has(key)) seen.set(key, { key, chain, from: r.selector });
  }
  return [...seen.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}
