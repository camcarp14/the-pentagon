// AI Business on the shared kit — proved by rendering, not by a green build.
//
// `vite build` was green on a component that threw the moment it mounted and
// took three tools down, which is why this file exists at all. react-dom/server
// executes the whole component body in plain Node — no jsdom needed, and this
// repo has none — so a restyle that broke a reference, a prop or a hook fails
// here rather than on a phone.
//
// It caught one immediately: <Btn busy> referenced a `Spinner` that was never
// defined or imported anywhere in the tab. Every path that sets `busy` — HALT
// mid-halt, Save in the goal editor, Sign out, approve/veto — was a
// ReferenceError waiting for a tap. See the "busy button" case below.
//
// WHY <App/> AND NOT <BusinessRoot/> FOR THE MARKUP ASSERTIONS
// BusinessRoot gates its first paint on its stylesheet being in the document
// (`if (!styled) return null`), and that flag is only flipped by an effect —
// which renderToStaticMarkup does not run. So BusinessRoot renders "" cold, by
// design, and the gate is load-bearing: a cold chunk load otherwise flashes the
// whole layout unstyled for a frame. It is still rendered here to prove it does
// not throw; the surface underneath it is rendered through <App/>, which mounts
// its own AgentDataProvider and so stands up with no wiring. data-kit lives on
// BusinessRoot's own roots, above <App/>, so it is asserted from source with
// the reason stated at the assertion.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import BusinessRoot from "../Root.jsx";
import App from "../App.jsx";
import { Btn, Badge, Panel, Stat, EmptyBlock, AlarmBlock } from "../components/primitives.jsx";
import { PANEL } from "../lib/freshness.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const warnings = [];
let realWarn, realErr;
beforeAll(() => {
  realWarn = console.warn; realErr = console.error;
  const cap = (...a) => {
    const m = String(a[0] ?? "");
    if (/useLayoutEffect does nothing on the server/.test(m)) return;
    warnings.push(m);
  };
  console.warn = cap; console.error = cap;
});
afterAll(() => { console.warn = realWarn; console.error = realErr; });

const html = () => renderToStaticMarkup(createElement(App));

describe("AI Business renders on the kit", () => {
  it("mounts the tab root without throwing", () => {
    // Renders to "" — the stylesheet gate above is an effect and effects do not
    // run here. What is being proved is that nothing on the way to that gate
    // throws: the env check, the module-scope Supabase client, activeFault().
    expect(() => renderToStaticMarkup(createElement(BusinessRoot))).not.toThrow();
  });

  it("renders the whole surface cold", () => {
    // Every panel, the halt control, the goal editor and both fold tiles, all
    // in their LOADING state, in one pass.
    expect(() => html()).not.toThrow();
    expect(html().length).toBeGreaterThan(2000);
  });

  it("uses the kit's primitives in the markup it renders cold", () => {
    const out = html();
    // Only what a cold render actually reaches: every panel is in its LOADING
    // state here, so the classes that ride on fetched rows (.stattile-label on
    // the captions under numbers, the tone chips) are asserted in the
    // primitives block below instead of being wished for here.
    for (const cls of ["card", "btn", "t-label", "t-cap", "stattile", "stattile-value"]) {
      expect(out, `expected the kit's .${cls}`).toMatch(new RegExp(`class="[^"]*\\b${cls}\\b`));
    }
  });

  it("routes every button through a kit surface", () => {
    // .btn.md is 44px and .btn.sm is 34px — the one-thumb targets this tab was
    // writing out inline. The one button that is not a .btn is the collapsed
    // goal row, which is a whole tappable card rather than a control, so it is
    // .card.pressable. Anything else here would be a control that opted out of
    // the kit's geometry.
    const out = html();
    const buttons = out.match(/<button[^>]*>/g) || [];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.filter((b) => !/class="[^"]*\b(btn|card)\b/.test(b))).toEqual([]);
  });

  it("emits no NaN and no literal 'undefined' into markup", () => {
    const out = html();
    expect(out).not.toMatch(/NaN/);
    expect(out).not.toMatch(/(style|class)="[^"]*undefined/);
  });

  it("renders without a React warning", () => {
    html();
    const react = warnings.filter((w) => !w.startsWith("[@cc/"));
    expect(react, `React warned:\n${react.join("\n")}`).toEqual([]);
  });
});

describe("the primitives every panel is built from", () => {
  const mk = (el) => renderToStaticMarkup(el);

  it("renders <Btn busy> — the case that was a ReferenceError", () => {
    // `Spinner` was used and never defined. Nothing rendered it until someone
    // tapped HALT, so the build stayed green and the tab died on the one
    // gesture it exists for.
    expect(() => mk(<Btn busy>Halting…</Btn>)).not.toThrow();
    expect(mk(<Btn busy>Halting…</Btn>)).toContain("spinner");
  });

  it("maps every Btn tone onto a kit class, and keeps 'good' semantic", () => {
    expect(mk(<Btn tone="ghost">x</Btn>)).toMatch(/class="btn md quiet/);
    expect(mk(<Btn tone="accent">x</Btn>)).toMatch(/class="btn md tinted/);
    expect(mk(<Btn tone="danger" size="sm">x</Btn>)).toMatch(/class="btn sm danger/);
    expect(mk(<Btn tone="solid">x</Btn>)).toMatch(/class="btn md primary/);
    // Green is a verdict colour here, not the tool's accent, so it keeps its own
    // fill on .btn's geometry rather than borrowing .primary.
    const good = mk(<Btn tone="good">x</Btn>);
    expect(good).toMatch(/class="btn md biz-press"/);
    expect(good).toContain("var(--good)");
  });

  it("puts uppercase only on .t-label", () => {
    expect(mk(<Badge tone="error">failed</Badge>)).toMatch(/class="t-label"/);
    const src = [
      stripComments(read("components", "primitives.jsx")),
      stripComments(read("App.jsx")),
      stripComments(read("components", "GoalEditor.jsx")),
      ...["Approvals", "Budget", "BriefingCard", "Hypotheses", "ActionLedger", "Invariants", "Learnings", "Metrics"]
        .map((f) => stripComments(read("components", "panels", `${f}.jsx`))),
    ].join("\n");
    expect(src).not.toMatch(/textTransform:\s*"uppercase"/);
  });

  it("renders a Panel in each of its four states", () => {
    const base = { rowCount: 0, alarm: false, dataAgeMs: null, fetchAgeMs: null, headline: "h", detail: "d", error: null };
    for (const st of [PANEL.LOADING, PANEL.ERROR, PANEL.EMPTY, PANEL.STALE, PANEL.FRESH]) {
      const out = mk(
        <Panel title="T" state={{ ...base, state: st, alarm: st === PANEL.ERROR }} onRetry={() => {}}>
          <p>body</p>
        </Panel>
      );
      expect(out, `state ${st}`).toMatch(/class="card"/);
      expect(out, `state ${st}`).toMatch(/class="t-label"/);
      expect(out, `state ${st}`).not.toMatch(/NaN/);
    }
  });

  it("gives the error state a retry, and the empty state a next step", () => {
    // Errors get a retry; empty states say what to do next. Both are the
    // language's rules, and both are load-bearing on this tab.
    const err = mk(
      <Panel title="T" state={{ state: PANEL.ERROR, alarm: true, rowCount: 0, dataAgeMs: null, fetchAgeMs: null, headline: "Gone", detail: "d", error: "boom" }} onRetry={() => {}} />
    );
    expect(err).toContain("Retry");
    expect(mk(<EmptyBlock headline="Nothing waiting" detail="The agent files one here when it needs a decision." />))
      .toContain("The agent files one here");
  });

  it("keeps Stat on the kit's stat grammar", () => {
    const out = mk(<Stat label="Spent" value="$0" sub="of $500" />);
    expect(out).toMatch(/class="t-label"/);
    expect(out).toMatch(/class="stattile-value"/);
    expect(out).toMatch(/class="t-cap"/);
  });

  it("uses the kit's .stattile-label for the captions that sit under a number", () => {
    // These were the smallest text in the tab — 8.5px under a score, 9px under
    // an age — and .stattile-label is the kit's own 10.5px version of exactly
    // that: the floor, not below it. They only render once rows have loaded, so
    // the source is the honest place to check.
    //
    // Comments stripped first: several of these files EXPLAIN .stattile-label
    // in a comment right above the markup that uses it, so an unstripped scan
    // is satisfied by the prose after the markup is gone.
    const panels = ["Approvals", "BriefingCard", "Hypotheses", "Invariants", "Learnings", "Metrics"];
    const users = panels
      .filter((f) => stripComments(read("components", "panels", `${f}.jsx`)).includes('className="stattile-label"'));
    expect(users, `panels still hand-rolling the caption: ${panels.filter((p) => !users.includes(p)).join(", ")}`)
      .toEqual(panels);
  });

  it("renders AlarmBlock without throwing", () => {
    expect(() => mk(<AlarmBlock headline="The halt did NOT take effect" detail="401" />)).not.toThrow();
  });
});

describe("AI Business obeys the language", () => {
  const files = [
    ["Root.jsx", read("Root.jsx")],
    ["App.jsx", read("App.jsx")],
    ["components/primitives.jsx", read("components", "primitives.jsx")],
    ["components/HaltControl.jsx", read("components", "HaltControl.jsx")],
    ["components/GoalEditor.jsx", read("components", "GoalEditor.jsx")],
    ...["Approvals", "Budget", "BriefingCard", "Hypotheses", "ActionLedger", "Invariants", "Learnings", "Metrics"]
      .map((f) => [`components/panels/${f}.jsx`, read("components", "panels", `${f}.jsx`)]),
  ].map(([name, src]) => [name, stripComments(src)]);

  it("opts into the kit on the tab's own roots", () => {
    // BusinessRoot gates its first paint on an effect, so this cannot be read
    // off a cold render (see the file header). Both roots are asserted here
    // instead: the mounted tab root, and Centered, which is the separate root
    // the env / checking / sign-in gates render through.
    const root = files.find(([n]) => n === "Root.jsx")[1];
    const roots = root.match(/className="biz-root[^"]*"[^>]*/g) || [];
    expect(roots.length).toBeGreaterThanOrEqual(2);
    // The sign-in form nests inside Centered, so it inherits the opt-in.
    expect(roots.filter((r) => !/data-kit/.test(r) && !/\bcard\b/.test(r))).toEqual([]);
    // And never on anything that could contain another tool: the shell owns the
    // wrapper above this, and nothing here reaches for document.body.
    expect(root).not.toMatch(/document\.body[^\n]*data-kit/);
  });

  it("has no text under the 10.5px floor, ternaries included", () => {
    // 41 sites were under it, the smallest at 8.5px, and one hid inside
    // `fontSize: d.delta === null ? 10 : 11.5` where only the emptier state
    // reached the violation.
    //
    // A literal scan does not see Learnings.jsx, whose whole typographic
    // ladder is `fontSize: type.size` off a WEIGHT map — every size in that
    // file is one indirection away from the regex. So a reference is followed:
    // the property (or binding) name the declaration reads is resolved against
    // the numbers assigned to that name in the same file.
    for (const [name, src] of files) {
      const sizes = [];   // [where, value]
      const refs = new Set();
      for (const m of src.matchAll(/fontSize:\s*([^,\n}]+)/g)) {
        const expr = m[1];
        for (const n of expr.matchAll(/[\d.]+/g)) {
          const v = Number(n[0]);
          if (Number.isFinite(v) && v > 0) sizes.push([`fontSize: ${expr.trim()}`, v]);
        }
        // `type.size`, `WEIGHT[k].size` — the map key that holds the number
        for (const p of expr.matchAll(/\.([A-Za-z_$][\w$]*)/g)) refs.add(p[1]);
        // `fontSize: SMALL` — a bare binding
        const bare = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(expr);
        if (bare) refs.add(bare[1]);
      }
      for (const ref of refs) {
        const decl = new RegExp(`(^|[{,;(\\s])${ref}\\s*[:=]\\s*(-?[\\d.]+)(?![\\w.])`, "g");
        for (const m of src.matchAll(decl)) {
          const v = Number(m[2]);
          if (Number.isFinite(v) && v > 0) sizes.push([`fontSize → ${ref}: ${v}`, v]);
        }
      }
      const under = sizes.filter(([, v]) => v < 10.5).map(([where]) => where);
      expect(under, `${name} is under the floor:\n${under.join("\n")}`).toEqual([]);
    }
    // the reference walk must actually be resolving something — Learnings.jsx
    // holds its whole ladder behind `type.size`
    const learnings = files.find(([n]) => n.endsWith("Learnings.jsx"))[1];
    expect(learnings, "Learnings.jsx no longer reads its sizes from a map — re-check this scan")
      .toMatch(/fontSize:\s*[A-Za-z_$][\w$]*\./);
  });

  it("puts no border and box-shadow on the same element", () => {
    // Panel, the halt block, both fold tiles, the sign-in card and the goal
    // editor all had a 1px border AND a shadow. They are .card now, and the
    // alarm rail rides along as an inset shadow instead of an outline.
    //
    // This walks braces rather than matching `style={{…}}`, because the fold
    // tile builds its style as a plain object and spreads it — a regex over
    // JSX attributes reads that as clean, which is how the violation would get
    // back in. Verified to fail on an injected `border:` next to a boxShadow.
    const enclosing = (src, idx) => {
      let depth = 0;
      for (let i = idx; i >= 0; i--) {
        if (src[i] === "}") depth++;
        else if (src[i] === "{") { if (depth === 0) return i; depth--; }
      }
      return -1;
    };
    const objectAt = (src, start) => {
      let depth = 0;
      for (let i = start; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
      }
      return src.slice(start);
    };

    // The whole opening tag of the JSX element that starts at `lt`. Braces and
    // quotes are tracked so an arrow function in an attribute (`onClick={() =>
    // …}`) does not end the tag at its own ">".
    const openingTag = (src, lt) => {
      let depth = 0, quote = null;
      for (let i = lt + 1; i < src.length; i++) {
        const c = src[i];
        if (quote) { if (c === quote && src[i - 1] !== "\\") quote = null; continue; }
        if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) return src.slice(lt, i + 1);
      }
      return src.slice(lt);
    };

    const BORDER = /(^|[^-\w])border(Top|Bottom|Left|Right)?:\s*(?!"none")(?!none)/;

    // ── 1. the shadow that is not written here at all ───────────────────────
    // Nearly every surface in this tab gets its elevation from the KIT's
    // .card, not from an inline boxShadow — so a walk that starts at the token
    // `boxShadow:` cannot see the sign-in card, the panel, the halt block or
    // the goal editor. Carrying .card IS carrying a shadow; the rule is that
    // such an element may not also draw an outline.
    let carded = 0;
    for (const [name, src] of files) {
      for (const m of src.matchAll(/className\s*=\s*(?:"([^"]*)"|\{([^}]*)\})/g)) {
        const classText = (m[1] ?? m[2] ?? "").replace(/[`'"]/g, " ");
        if (!/(^|\s)card($|\s)/.test(classText)) continue;
        carded++;
        const lt = src.lastIndexOf("<", m.index);
        const tag = openingTag(src, lt);
        expect(BORDER.test(tag), `${name}: the kit's .card already carries a shadow — this element also draws a border:\n${tag.slice(0, 300)}`).toBe(false);
      }
    }
    expect(carded, "no .card element was found — the scan is broken").toBeGreaterThanOrEqual(4);

    // ── 2. the tab's own stylesheet ─────────────────────────────────────────
    // It was never read here at all. It is small, but it styles every input in
    // the tab, and a rule is exactly where a border and a shadow drift back
    // onto one element without any JSX changing.
    const sheet = stripComments(read("styles.css"));
    const cssOffenders = [];
    let rules = 0;
    for (const [, sel, body] of sheet.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
      rules++;
      const border = /(^|;)\s*border(-top|-bottom|-left|-right)?:(?!\s*none\b)/.test(body);
      const shadow = /(^|;)\s*box-shadow:(?!\s*none\b)/.test(body);
      if (border && shadow) cssOffenders.push(`${sel.trim()} { ${body.trim()} }`);
    }
    expect(rules, "styles.css produced no rules — the scan is broken").toBeGreaterThan(10);
    expect(cssOffenders, `styles.css: border + shadow on one element:\n${cssOffenders.join("\n\n")}`).toEqual([]);

    // ── 3. the inline shadow, walked out through the spreads ────────────────
    for (const [name, src] of files) {
      for (const m of src.matchAll(/boxShadow:\s*/g)) {
        // Walk OUT as well as in: the fold tile spreads `{ boxShadow }` into a
        // wider object, so the border and the shadow live one brace apart and
        // only an ancestor sees both. Stop as soon as the text stops looking
        // like a style object.
        let open = enclosing(src, m.index);
        for (let level = 0; level < 4 && open > -1; level++) {
          const obj = objectAt(src, open);
          if (/[<]|\breturn\b|=>/.test(obj)) break;
          expect(BORDER.test(obj), `${name}: border + boxShadow on one element:\n${obj.slice(0, 260)}`).toBe(false);
          open = enclosing(src, open - 1);
        }
      }
    }
  });

  it("uses no decorative font — the system stack only", () => {
    // --font-display and --font-body both resolve to the system stack in
    // @cc/design's tokens, and nothing here names a family directly.
    for (const [name, src] of files) {
      const fams = [...src.matchAll(/fontFamily:\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(fams.filter((f) => !/^var\(--font-(body|display|mono)\)$/.test(f)), name).toEqual([]);
    }
  });

  it("keeps the iOS 16px input rule, verbatim", () => {
    // The kit's .field is 15px. Adopting it on these inputs would re-introduce
    // the viewport zoom this comment was written to stop, so the inputs keep
    // the tab's own rule — see notMigrated in the migration report.
    const css = read("styles.css");
    expect(css).toContain("iOS Safari zooms the viewport on focus for any");
    expect(css).toMatch(/font-size:\s*16px;/);
    for (const [, src] of files) expect(src).not.toMatch(/className="[^"]*\bfield\b/);
  });

  it("keeps the safe-area inset the phone layout depends on", () => {
    const app = files.find(([n]) => n === "App.jsx")[1];
    expect(app).toContain("calc(28px + var(--safe-bottom, 0px))");
  });

  it("keeps the tab's own scoped sheet scoped", () => {
    // Every selector stays biz-prefixed. The kit is opted into by attribute, so
    // nothing here had to be renamed — and a biz- class cannot collide with a
    // kit class by construction.
    const css = read("styles.css");
    const selectors = [...css.matchAll(/^\.([a-zA-Z-]+)/gm)].map((m) => m[1]);
    expect(selectors.filter((s) => !s.startsWith("biz-"))).toEqual([]);
  });
});
