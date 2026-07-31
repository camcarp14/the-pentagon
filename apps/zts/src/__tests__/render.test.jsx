// ZTS on the shared kit — proved by rendering, not by a green build.
//
// `vite build` was green on a component that threw the moment it mounted and
// took three tools down, which is why this file exists at all. react-dom/server
// executes the whole component body in plain Node — no jsdom needed, and this
// repo has none — so a restyle that broke a reference, a prop or a hook fails
// here rather than on a phone.
//
// WHAT IS RENDERED, AND WHY IT IS RENDERED THAT WAY
// Root.jsx is ZTS's mount entry and it already wraps <App embedded/> in the
// ToastProvider every view calls useToast() against, so the cold render below
// needs no mocks and no fake data — it is the real Mission tab with the real
// engine panel under it. The other four surfaces (Creators, Studio, SEO, DNA)
// only render when `view` moves, and `view` is state with no prop behind it, so
// each view component is EXPORTED and rendered directly here with seeded rows.
// Exporting them is the whole reason those `export` keywords exist; nothing else
// in the app imports them, and no prop, key, table or route changed to add them.
//
// THE SAME REASONING REACHES TWO MORE, AND IT DID NOT USED TO. `surfaces()`
// claimed to be "every surface this app has" while omitting BottomNav — the
// entire phone navigation bar, gated on `isMobile`, which a cold render cannot
// set — and ComposeModal, which sits behind Studio's primary action and mounts
// only when `composing` flips. Both were provably unreachable: replacing either
// body with `throw` left all 26 tests green, while the same mutation to
// AgentEngine reddened five. So the ONE failure mode this file exists to catch
// was invisible in the two places a phone user touches first. Both are exported
// and rendered below now, and DnaView with them — it was imported here and
// never rendered, which made the import a decoration.
//
// Effects do not run under renderToStaticMarkup, so nothing here talks to
// Supabase, the factory bridge, localStorage or the network. That is the point:
// what is asserted is the markup the components produce cold.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ToastProvider } from "@cc/ui";

import ZtsRoot from "../Root.jsx";
import {
  MissionView, CreatorsView, StudioView, SeoView,
  ShortDetail, CreatorDetail, ArticleDetail,
  AddCreatorModal, ComposeArticleModal, ComposeModal, LoginScreen,
  BottomNav,
} from "../App.jsx";
import EnginePanel, { Msg } from "../EnginePanel.jsx";
import { FactoryPanel } from "../factory.jsx";
import { DnaView } from "../dna/DnaView.jsx";

/* ── plumbing ──────────────────────────────────────────────────────────────── */

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const warnings = [];
let realWarn, realErr;
beforeAll(() => {
  realWarn = console.warn; realErr = console.error;
  const cap = (...a) => {
    const m = String(a[0] ?? "");
    // The server renderer says this about every useLayoutEffect in the tree,
    // including @cc/mind-canvas's. It is not a defect this migration can fix.
    if (/useLayoutEffect does nothing on the server/.test(m)) return;
    warnings.push(m);
  };
  console.warn = cap; console.error = cap;
});
afterAll(() => { console.warn = realWarn; console.error = realErr; });
// NOT cleared between tests, deliberately. React de-duplicates each warning
// message for the lifetime of the module, so a warning raised by the first
// render in this file is never raised again — clearing the buffer per test made
// the two "no React warning" cases unable to fail, which a mutation proved.
// Accumulating instead means either case fails if ANY render before it warned.

// Class membership, by TOKEN. A `\b`-anchored regex is not good enough here:
// `\bswitch\b` matches inside "switch-knob", so an assertion about .switch was
// satisfied by the knob inside it. Verified by mutation.
const hasClass = (html, cls) => {
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    if (m[1].split(/\s+/).includes(cls)) return true;
  }
  return false;
};

const wrap = (el) => renderToStaticMarkup(h(ToastProvider, null, el));
const cold = () => renderToStaticMarkup(h(ZtsRoot));
const noop = () => {};

// Seeds. These are the shapes the Supabase tables already hand the views; no
// column, key or name changed for the test.
const creator = {
  id: "c1", channel_name: "Cold Storage", subscriber_count: 52000, niche: "bitcoin self custody",
  engagement_rate: 0.06, description: "hardware wallet reviews", stage: "prospected", status: "prospected",
};
const short = {
  id: "s1", stage: "assets", type: "angle", title: "Not your keys", hook: "Three seconds.",
  script: "The script.", description: "A description", tags: ["bitcoin", "selfcustody"],
  thumbnail_concepts: [{ visual: "a vault door", text_overlay: "Own your keys" }],
  pinned_comment: "Pinned.", checklist: { "Tags added": true },
};
// article_html is deliberately empty: DOMPurify needs a real window to sanitize
// and this repo has no jsdom, so the component's own "<em>No draft yet.</em>"
// branch is the one a cold render can reach. Every other field is populated.
const article = {
  id: "a1", stage: "review", title_tag: "Metal beats paper", target_keyword: "metal seed phrase backup",
  slug: "metal-beats-paper", meta_description: "Why steel wins.", word_count: 1200, search_intent: "informational",
  article_html: "", internal_links: [{ anchor: "the kit", target: "/products" }],
};

// Every surface this app has, cold. The keys name what broke if one goes red.
const surfaces = () => ({
  "Mission": wrap(h(MissionView, { creators: [creator], shorts: [short], onNavigate: noop, isMobile: false, loading: false })),
  "Mission (loading)": wrap(h(MissionView, { creators: [], shorts: [], onNavigate: noop, isMobile: true, loading: true })),
  "Creators": wrap(h(CreatorsView, { creators: [creator], setCreators: noop, isMobile: false, loading: false })),
  "Creators (empty)": wrap(h(CreatorsView, { creators: [], setCreators: noop, isMobile: true, loading: false })),
  "Studio": wrap(h(StudioView, { shorts: [short], setShorts: noop, isMobile: false, loading: false })),
  "Studio (empty)": wrap(h(StudioView, { shorts: [], setShorts: noop, isMobile: true, loading: false })),
  "SEO": wrap(h(SeoView, { articles: [article], setArticles: noop, onAddArticle: noop, isMobile: false, loading: false })),
  "ShortDetail": wrap(h(ShortDetail, { short, onClose: noop, onUpdate: noop, onDelete: noop, isMobile: false })),
  "ShortDetail (failed generation)": wrap(h(ShortDetail, { short: { id: "s2", stage: "idea", type: "news" }, onClose: noop, onUpdate: noop, onDelete: noop, isMobile: false })),
  "CreatorDetail": wrap(h(CreatorDetail, { creator, onClose: noop, onUpdate: noop, onDelete: noop, onMove: noop, isMobile: true })),
  "ArticleDetail": wrap(h(ArticleDetail, { article, onClose: noop, onUpdate: noop, onDelete: noop, isMobile: false })),
  "ArticleDetail (idea)": wrap(h(ArticleDetail, { article: { ...article, stage: "idea" }, onClose: noop, onUpdate: noop, onDelete: noop, isMobile: false })),
  "AddCreatorModal": wrap(h(AddCreatorModal, { onClose: noop, onAdd: noop, isMobile: false })),
  "ComposeArticleModal": wrap(h(ComposeArticleModal, { keywords: "metal seed\nbitcoin inheritance", onClose: noop, onCreate: noop, isMobile: false })),
  "LoginScreen": wrap(h(LoginScreen)),
  "EnginePanel": wrap(h(EnginePanel, { isMobile: false })),
  "FactoryPanel": wrap(h(FactoryPanel, { isMobile: false })),
  // The phone navigation bar. `isMobile` is derived from window state, so <App/>
  // never renders this on the server and nothing else reached it.
  "BottomNav": wrap(h(BottomNav, { view: "studio", setView: noop, tabs: ["mission", "creators", "studio", "seo", "dna"] })),
  // Studio's primary action. The same TABS list App.jsx passes, and the same
  // props the Studio call site passes — no shape invented for the test.
  "ComposeModal": wrap(h(ComposeModal, { onClose: noop, onCreate: noop, isMobile: false })),
  "ComposeModal (mobile)": wrap(h(ComposeModal, { onClose: noop, onCreate: noop, isMobile: true })),
  "DNA": wrap(h(DnaView, { creators: [creator], shorts: [short], articles: [article], onArticleDraft: noop })),
});

/* ── 1. it renders, and it renders on the kit ──────────────────────────────── */

describe("ZTS renders on the kit", () => {
  it("mounts the whole tab cold", () => {
    expect(() => cold()).not.toThrow();
    expect(cold().length).toBeGreaterThan(4000);
  });

  it("opts into the kit on its own root", () => {
    // ZTS renders inside the shell's tool slot, so data-kit here reaches this
    // app and nothing else — the same rule the shell follows by keeping it off
    // the wrapper that holds every tool.
    expect(cold()).toMatch(/<div[^>]*data-kit/);
  });

  it("uses the kit's primitives in the markup it renders cold", () => {
    // Everything below is on screen the moment ZTS opens: the tab segment, the
    // engine panel's card and plays, the Mission tiles and the page title.
    const out = cold();
    for (const cls of [
      "seg", "seg-opt", "card", "pad-md", "pad-lg", "cell", "cell-title",
      "stattile", "stattile-label", "stattile-value", "pill", "dotstatus",
      "btn", "t-title1", "t-label", "t-foot", "t-cap",
    ]) {
      expect(hasClass(out, cls), `expected the kit's .${cls} in the cold markup`).toBe(true);
    }
  });

  it("emits no NaN and no literal 'undefined' into markup", () => {
    const out = cold();
    expect(out).not.toMatch(/NaN/);
    expect(out).not.toMatch(/(style|class)="[^"]*undefined/);
  });

  it("renders without a React warning", () => {
    cold();
    const react = warnings.filter((w) => !w.startsWith("[@cc/") && !w.startsWith("[supabaseClient]"));
    expect(react, `React warned:\n${react.join("\n")}`).toEqual([]);
  });
});

/* ── 2. every surface, not just the one that opens first ───────────────────── */

describe("every ZTS surface renders on the kit", () => {
  it("renders all twenty-one without throwing", () => {
    const all = surfaces();
    for (const [name, out] of Object.entries(all)) {
      expect(out.length, `${name} rendered nothing`).toBeGreaterThan(300);
    }
    // Scan sanity. The count is the whole point of this file: a surface quietly
    // dropped from the map is a surface a ReferenceError can hide in, which is
    // exactly how BottomNav and ComposeModal — the phone nav bar and Studio's
    // primary action — went unrendered while the header claimed "every surface
    // this app has, cold".
    expect(Object.keys(all).length, "a surface was dropped from the map").toBe(21);
    for (const must of ["BottomNav", "ComposeModal", "DNA"]) {
      expect(Object.keys(all), `${must} is no longer rendered`).toContain(must);
    }
  });

  it("puts every one of them on kit classes", () => {
    // Per surface, the classes that surface is actually built from. A surface
    // that quietly went back to inline styles fails on its own line.
    const want = {
      "Mission": ["card", "stattile", "stattile-value", "t-title1"],
      "Creators": ["card", "field", "t-label", "stattile-value", "btn"],
      "Studio": ["card", "pressable", "t-label", "btn", "dotstatus"],
      "SEO": ["card", "switch", "switch-knob", "field", "t-label"],
      "ShortDetail": ["seg", "seg-opt", "sheet-scrim", "icon-btn", "btn"],
      "CreatorDetail": ["pill", "sheet-scrim", "sheet-grab", "t-head", "btn"],
      "ArticleDetail": ["sheet-scrim", "icon-btn", "t-label", "btn"],
      "AddCreatorModal": ["field", "btn", "t-head"],
      "ComposeArticleModal": ["field", "btn", "t-label"],
      "LoginScreen": ["card"],
      "EnginePanel": ["card", "pill", "cell", "cell-title", "t-title2"],
      "FactoryPanel": ["t-label", "dotstatus", "t-cap"],
      "BottomNav": ["dock-tab", "dock-icon", "dock-label"],
      "ComposeModal": ["sheet-scrim", "stattile", "field", "btn", "t-head"],
    };
    const all = surfaces();
    for (const [name, classes] of Object.entries(want)) {
      for (const cls of classes) {
        expect(hasClass(all[name], cls), `${name} is missing the kit's .${cls}`).toBe(true);
      }
    }
  });

  it("routes every control in the app's own views through a kit surface", () => {
    // .btn is 34/44px, .cell is 46px, .seg-opt is 32px, .pill is 34px,
    // .dock-tab is the 46px bottom-bar item and .stattile is the well-toned
    // tile — the one-thumb targets this app was writing out by hand at 4px/9px
    // padding.
    //
    // .dock-tab and .stattile joined this list when BottomNav and ComposeModal
    // joined `surfaces()`. Both were OUTSIDE the map before, and this assertion
    // passed only because they were: BottomNav's five tabs and ComposeModal's
    // three type tiles were all class-less hand-rolled buttons (the tiles at
    // `border: 1px solid …; border-radius: 11px`). Adding the surfaces without
    // migrating the controls would have reddened this line, which is the proof
    // the omission was load-bearing rather than cosmetic.
    //
    // DNA is the one exclusion, and it is NOT because its buttons belong to
    // @cc/mind-canvas — they are declared in apps/zts/src/dna/DnaView.jsx, so
    // they are ZTS's own and that excuse was simply false. The real reason: the
    // tab is scheduled to be RETIRED in favour of the shell's single Minds
    // screen, so restyling 24 buttons on it is work that gets deleted. It is
    // still RENDERED above — a ReferenceError in it must still fail this file —
    // it is only exempt from the class rule. Delete this exemption, not the
    // surface, when the tab goes.
    const KIT = /class="[^"]*\b(btn|seg-opt|cell|pill|switch|icon-btn|sheet-grab|dock-tab|stattile)\b/;
    const EXEMPT = new Set(["DNA"]);
    const all = surfaces();
    let checked = 0;
    for (const [name, out] of Object.entries(all)) {
      if (EXEMPT.has(name)) continue;
      const buttons = out.match(/<button[^>]*>/g) || [];
      checked += buttons.length;
      const bare = buttons.filter((b) => !KIT.test(b));
      expect(bare, `${name} has controls off the kit:\n${bare.join("\n")}`).toEqual([]);
    }
    expect(checked, "no buttons were scanned — the scan is broken").toBeGreaterThan(40);
    // Scan sanity for the two surfaces this assertion used to be blind to: if
    // either stops rendering controls the exclusion is back, silently.
    expect((all["BottomNav"].match(/<button[^>]*>/g) || []).length,
      "BottomNav rendered no tabs — the nav is no longer being scanned").toBe(5);
    expect((all["ComposeModal"].match(/<button[^>]*>/g) || []).length,
      "ComposeModal rendered no controls — the modal is no longer being scanned").toBeGreaterThanOrEqual(5);
    // …and the exemption must be exempting something real, or it is dead code
    // that will outlive the tab it excuses.
    expect((all["DNA"].match(/<button[^>]*>/g) || []).length,
      "the DNA exemption covers nothing — drop it").toBeGreaterThan(10);
  });

  it("emits no NaN and no literal 'undefined' on any surface", () => {
    for (const [name, out] of Object.entries(surfaces())) {
      expect(out, `${name} rendered NaN`).not.toMatch(/NaN/);
      expect(out, `${name} rendered the string 'undefined'`).not.toMatch(/(style|class)="[^"]*undefined/);
    }
  });

  it("renders every surface without a React warning", () => {
    surfaces();
    const react = warnings.filter((w) => !w.startsWith("[@cc/") && !w.startsWith("[supabaseClient]"));
    expect(react, `React warned:\n${react.join("\n")}`).toEqual([]);
  });

  it("sets uppercase nowhere except through .t-label", () => {
    // Not a source scan: this reads the CSS that actually reached the elements.
    // Eight hand-rolled uppercase micro-styles used to survive here.
    for (const [name, out] of Object.entries(surfaces())) {
      expect(out, `${name} still sets text-transform: uppercase inline`)
        .not.toMatch(/text-transform:\s*uppercase/);
    }
    // and .t-label is genuinely in use, or the line above proves nothing
    expect(hasClass(surfaces()["Studio"], "t-label")).toBe(true);
  });
});

/* ── 3. the two rules that are about behaviour, not paint ──────────────────── */

describe("ZTS states failures and emptiness the way the language requires", () => {
  it("gives a failed generation a retry, on both pipelines", () => {
    const s = surfaces();
    const shortIdea = s["ShortDetail (failed generation)"];
    expect(shortIdea).toContain("Generation didn&#x27;t complete");
    expect(shortIdea).toMatch(/class="btn md primary"[^>]*>✦ Generate assets/);

    const articleIdea = s["ArticleDetail (idea)"];
    expect(articleIdea).toMatch(/class="btn md primary"[^>]*>✦ Generate draft/);
  });

  it("tells an empty kanban column what to do next", () => {
    // "Nothing here" on its own is a label, not an empty state.
    const studio = surfaces()["Studio"];
    const nothing = (studio.match(/Nothing here/g) || []).length;
    expect(nothing, "no empty column rendered — the seed no longer leaves one").toBeGreaterThan(2);
    const nextStep = (studio.match(/Move one in with the › stepper on a card\./g) || []).length;
    expect(nextStep, "empty columns lost their next step").toBe(nothing);
  });

  it("gives the engine panel's error strip a retry that is safe to press", () => {
    // §4.7: errors get a Retry, never a dead end. The panel runs four
    // INDEPENDENT reads and renders whichever came back, so "one read failed"
    // is exactly the case a second attempt fixes.
    //
    // The strip only mounts when a query fails and effects do not run under
    // renderToStaticMarkup, so it has no cold path — it is rendered directly,
    // for the same reason the view components are.
    const err = wrap(h(Msg, { tone: "#F04438", onRetry: noop, busy: false, children: "runs: boom" }));
    expect(err, "an error with no way out is a dead end").toContain("Try again");
    expect(hasClass(err, "btn"), "the retry is off the kit").toBe(true);
    expect(err, "an error strip announces itself").toMatch(/<div role="alert"/);
    expect(err, "the retry is dead on arrival").not.toMatch(/<button[^>]*disabled/);

    // …and it goes inert while a WRITE is in flight, so a retry cannot race the
    // load() that every write already ends with.
    const busy = wrap(h(Msg, { tone: "#F04438", onRetry: noop, busy: true, children: "runs: boom" }));
    expect(busy, "the retry stays live while a write is in flight").toMatch(/<button[^>]*disabled/);

    // Wired to the panel's own loader, not a stub…
    const panel = FILES.find(([n]) => n === "EnginePanel.jsx")[1];
    expect(panel, "the error strip lost its retry").toMatch(/\{err && <Msg tone=\{T\.red\} onRetry=\{load\} busy=\{!!busy\}>\{err\}<\/Msg>\}/);
    // …and that loader is a pure re-read: a retry that could POST, upsert or
    // delete would be a double-submit rather than a second attempt.
    const start = panel.indexOf("const load = useCallback");
    const body = panel.slice(start, panel.indexOf("useEffect(() => { load(); }", start));
    expect(start, "load() is gone — this scan is asserting nothing").toBeGreaterThan(-1);
    expect(body.length, "the load() body could not be sliced — the scan is broken").toBeGreaterThan(400);
    expect(body, "load() is no longer a pure re-read — a retry could double-submit")
      .not.toMatch(/\.upsert\(|\.insert\(|\.update\(|\.delete\(|fetch\(/);
    // It also takes no arguments, so passing it straight to onClick hands it a
    // React event it must ignore.
    expect(body, "load() now takes an argument — onClick would pass it a MouseEvent")
      .toMatch(/const load = useCallback\(async \(\) =>/);
  });

  it("gives the first-run empty states an action, not just a sentence", () => {
    const s = surfaces();
    expect(s["Studio (empty)"]).toContain("Create your first Short");
    expect(s["Creators (empty)"]).toContain("Add your first creator");
  });
});

/* ── 4. the language, read off the source ──────────────────────────────────── */

const FILES = [
  ["App.jsx", read("App.jsx")],
  ["EnginePanel.jsx", read("EnginePanel.jsx")],
  ["factory.jsx", read("factory.jsx")],
  ["theme.js", read("theme.js")],
  ["dna/DnaView.jsx", read("dna", "DnaView.jsx")],
].map(([n, s]) => [n, strip(s)]);

describe("ZTS obeys the language", () => {
  it("has no text under the 10.5px floor, ternaries and variables included", () => {
    // 38 sites in DnaView alone were under it, the smallest at 8.5px, plus the
    // 9px bottom-nav label and the 8px kanban chips.
    //
    // A literal scan is not enough: a size can hide behind `fontSize: SMALL` or
    // `fontSize: type.size`, so the names a declaration reads are resolved
    // against the numbers assigned to that name in the same file.
    for (const [name, src] of FILES) {
      const sizes = [];
      const refs = new Set();
      for (const m of src.matchAll(/fontSize:\s*([^,\n}]+)/g)) {
        const expr = m[1];
        for (const n of expr.matchAll(/[\d.]+/g)) {
          const v = Number(n[0]);
          if (Number.isFinite(v) && v > 0) sizes.push([`fontSize: ${expr.trim()}`, v]);
        }
        for (const p of expr.matchAll(/\.([A-Za-z_$][\w$]*)/g)) refs.add(p[1]);
        const bare = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(expr);
        if (bare) refs.add(bare[1]);
      }
      // the injected stylesheets are CSS in a template string — scanned too
      for (const m of src.matchAll(/font-size:\s*([^;\n]+)/g)) {
        for (const n of m[1].matchAll(/[\d.]+/g)) {
          const v = Number(n[0]);
          if (Number.isFinite(v) && v > 0) sizes.push([`font-size: ${m[1].trim()}`, v]);
        }
      }
      for (const ref of refs) {
        const decl = new RegExp(`(^|[{,;(\\s])${ref}\\s*[:=]\\s*(-?[\\d.]+)(?![\\w.])`, "g");
        for (const m of src.matchAll(decl)) {
          const v = Number(m[2]);
          if (Number.isFinite(v) && v > 0) sizes.push([`fontSize → ${ref}: ${v}`, v]);
        }
      }
      const under = sizes.filter(([, v]) => v < 10.5).map(([w]) => w);
      expect(under, `${name} is under the floor:\n${under.join("\n")}`).toEqual([]);
    }
    // the scan must actually be finding sizes, or it proves nothing
    const app = FILES.find(([n]) => n === "App.jsx")[1];
    expect([...app.matchAll(/fontSize:/g)].length).toBeGreaterThan(5);
  });

  it("puts no border and box-shadow on the same element", () => {
    // The Card, the top bar, the bottom bar, the engine panel, the sign-in card
    // and every floating panel in the DNA tab all carried a 1px line AND a
    // shadow. Two scans, because the violation has two shapes here:
    //   1. an inline style object that sets both
    //   2. an element that wears the kit's .card (which IS a shadow) and then
    //      draws its own outline on top
    const BORDER = /(^|[^-\w])border(Top|Bottom|Left|Right)?:(?!\s*(?:"none"|'none'|`none`|none\b))/;
    const objectAt = (src, start) => {
      let depth = 0;
      for (let i = start; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
      }
      return src.slice(start);
    };
    const enclosing = (src, idx) => {
      let depth = 0;
      for (let i = idx; i >= 0; i--) {
        if (src[i] === "}") depth++;
        else if (src[i] === "{") { if (depth === 0) return i; depth--; }
      }
      return -1;
    };
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

    let shadows = 0, carded = 0;
    for (const [name, src] of FILES) {
      for (const m of src.matchAll(/boxShadow:\s*/g)) {
        shadows++;
        // walk out through spreads: GLASS and the kanban rail both compose
        let open = enclosing(src, m.index);
        for (let level = 0; level < 3 && open > -1; level++) {
          const obj = objectAt(src, open);
          if (/[<]|\breturn\b|=>/.test(obj)) break;
          expect(BORDER.test(obj), `${name}: border + boxShadow on one element:\n${obj.slice(0, 260)}`).toBe(false);
          open = enclosing(src, open - 1);
        }
      }
      for (const m of src.matchAll(/className\s*=\s*(?:"([^"]*)"|\{`?([^}]*)`?\})/g)) {
        const text = (m[1] ?? m[2] ?? "").replace(/[`'"$]/g, " ");
        if (!/(^|\s)(card|cellgroup|entrance-card|toast)($|\s)/.test(text)) continue;
        carded++;
        const tag = openingTag(src, src.lastIndexOf("<", m.index));
        expect(BORDER.test(tag), `${name}: this element wears the kit's shadow AND draws a border:\n${tag.slice(0, 300)}`).toBe(false);
      }
    }
    expect(shadows, "no boxShadow was found — the scan is broken").toBeGreaterThan(4);
    expect(carded, "no .card element was found — the scan is broken").toBeGreaterThanOrEqual(4);
  });

  it("uses no decorative face — the system stack only", () => {
    // The app pulled Syne + DM Mono + Inter off Google's CDN with a <link> it
    // appended on every mount, and named 'Syne' in ~120 inline styles through
    // theme.js's `syne` const.
    const app = FILES.find(([n]) => n === "App.jsx")[1];
    expect(app).not.toMatch(/fonts\.googleapis\.com/);
    for (const [name, src] of FILES) {
      const fams = [...src.matchAll(/fontFamily:\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(fams.filter((f) => !/^var\(--font-(body|display|mono)\)$/.test(f)), name).toEqual([]);
      expect(src, `${name} still names a webfont family`).not.toMatch(/'(Syne|DM Mono|Inter)'/);
    }
    const theme = FILES.find(([n]) => n === "theme.js")[1];
    expect(theme).toMatch(/export const syne = 'var\(--font-display/);
    expect(theme).toMatch(/export const mono = 'var\(--font-mono/);
  });

  it("takes the kit's pulse on the kit's dot instead of forking it inline", () => {
    // §4.6: motion is one physics. The kit already ships
    // `[data-kit] .dotstatus.pulse { animation: pulse 2s infinite; }`
    // (packages/ui/components.css). factory.jsx took `.dotstatus` and then set
    // `animation: status === "online" ? "pulse 2.5s infinite" : "none"` inline
    // on the same element — the kit's keyframe at a different duration, i.e. a
    // fork of the motion system hiding inside a style object. A 0.5s difference
    // is not a reason to fork (DESIGN.md §6.4).
    const factory = FILES.find(([n]) => n === "factory.jsx")[1];
    expect(factory, "factory.jsx hand-rolls the kit's pulse in an inline style")
      .not.toMatch(/animation:[^,\n]*["'`]pulse[\s"']/);
    expect(factory, "the bridge dot no longer takes .dotstatus.pulse")
      .toMatch(/className=\{`dotstatus\$\{status === "online" \? " pulse" : ""\}`\}/);
    // The keyframe itself stays the kit's — referenced, never redefined.
    expect(factory, "factory.jsx must not define a keyframe the kit owns")
      .not.toMatch(/@keyframes\s+pulse/);
    // Scan sanity: .dotstatus must still be on this element, or the two lines
    // above are asserting things about markup that no longer exists.
    expect((factory.match(/dotstatus/g) || []).length,
      "no .dotstatus in factory.jsx — the scan is broken").toBeGreaterThanOrEqual(1);
    expect(hasClass(surfaces()["FactoryPanel"], "dotstatus"),
      "the bridge dot is gone from the rendered panel").toBe(true);
  });

  it("sets textTransform: uppercase in no source file", () => {
    for (const [name, src] of FILES) {
      expect(src, `${name} still hand-rolls uppercase`).not.toMatch(/textTransform:\s*"uppercase"/);
    }
  });

  it("opts in on ZTS's own roots and never above them", () => {
    // Four roots: the mounted app, the boot gate, and both sign-in screens.
    // Only the first is reachable from a cold render (Root.jsx passes
    // `embedded`, and the others are the standalone paths), so the count is
    // asserted here and the mounted one is asserted from markup above.
    const app = FILES.find(([n]) => n === "App.jsx")[1];
    expect((app.match(/<div data-kit/g) || []).length).toBe(4);
    // and never on anything that could contain another tool
    expect(app).not.toMatch(/document\.body[^\n]*data-kit/);
    // main.jsx keeps data-kit off the palette wrapper for the same reason
    expect(strip(read("main.jsx"))).not.toMatch(/data-kit/);
  });

  it("keeps the domain colours literal", () => {
    // Pipeline stage colours are DATA: the hue is what the stage means, on the
    // column dot, the card rail and the Mission counters. They are not theme,
    // so they did not become tokens.
    const app = FILES.find(([n]) => n === "App.jsx")[1];
    for (const hex of ["#8A97A8", "#B68A2E", "#3B82F6", "#0E9F6E", "#7C3AED", "#F59E0B", "#EC4899"]) {
      expect(app, `stage colour ${hex} was themed away`).toContain(hex);
    }
    // and the ZTS seal, which is the brand mark rather than a palette choice
    expect(app).toContain("linear-gradient(135deg, #12B886 0%, #0A7A54 100%)");
  });

  it("does not restyle @cc/mind-canvas", () => {
    // The DNA tab renders the shared canvas, which is already migrated. It gets
    // the same props it always did and no class or style of ZTS's own.
    const dna = FILES.find(([n]) => n === "dna/DnaView.jsx")[1];
    const tag = dna.slice(dna.indexOf("<MindCanvas"), dna.indexOf("/>", dna.indexOf("<MindCanvas")));
    expect(tag).toContain("palette={ZTS_MIND_PALETTE}");
    expect(tag).toContain("look={ZTS_MIND_LOOK}");
    expect(tag).not.toMatch(/className|style=/);

    // And the palette it is handed is unchanged except for the two font slots.
    // Those named 'Syne' / 'DM Mono', which App.jsx no longer loads, so they
    // pointed at nothing; every colour in the table is the canvas's domain data
    // and stayed a literal.
    const pal = strip(read("dna", "palette.js"));
    for (const hex of ["#2DD4A7", "#A78BFA", "#6EA8FE", "#E3B341", "#3ECF8E", "#F472B6", "#F87171"]) {
      expect(pal, `region colour ${hex} was themed away`).toContain(hex);
    }
    expect(pal).not.toMatch(/'(Syne|DM Mono)'/);
    expect(pal).toContain('fontDisplay: "var(--font-display');
  });
});

/* ── 5. the workarounds that must survive a restyle ────────────────────────── */

describe("ZTS keeps its iOS and safe-area workarounds verbatim", () => {
  const app = read("App.jsx");
  const dna = read("dna", "DnaView.jsx");

  it("keeps the canonical bottom-bar geometry comment, word for word", () => {
    expect(app).toContain("// CANONICAL BOTTOM-BAR GEOMETRY — all four tools must match exactly, or the");
    expect(app).toContain("//   bar:  padding 4px 6px max(10px, calc(6px + var(--safe-bottom, 0px)))");
    // 10.5px, not the 9px this line used to pin. The comment claimed 9 while
    // the code six lines below it deliberately rendered 10.5 and reasoned out
    // why — so this assertion was holding a stale comment in place against the
    // shipped code, and 9px would have violated the hard 10.5px floor
    // (DESIGN.md §4.3) if anyone had "fixed" the code to match the comment.
    // The code was right; the comment and this line were wrong.
    expect(app).toContain("//   item: min-height 46, padding 8px 2px 7px, gap 3, icon 21, label 10.5px");
    expect(app, "the canonical block must not pin a size under the type floor")
      .not.toContain("icon 21, label 9px");
  });

  it("renders the bottom-bar label at the size the canonical comment pins", () => {
    // The half of the contradiction the comment scan cannot see: the label size
    // now comes off the kit's .dock-label (10.5px), so what has to be asserted
    // is that the class is what the bar actually wears.
    const nav = surfaces()["BottomNav"];
    expect(hasClass(nav, "dock-label"), "the bottom-bar label is off the kit's .dock-label").toBe(true);
    expect(hasClass(nav, "dock-icon"), "the bottom-bar icon is off the kit's .dock-icon").toBe(true);
    // and .dock-label is the 10.5px the block above pins, read from the kit
    // itself rather than restated here
    const kit = readFileSync(join(here, "../../../../packages/ui/components.css"), "utf8");
    expect(kit, "the kit's .dock-label is no longer 10.5px — the canonical comment is stale again")
      .toMatch(/\.dock-label\s*\{[^}]*font-size:\s*10\.5px/);
  });

  it("keeps the bottom bar's safe-area padding formula", () => {
    expect(app).toContain('padding: "4px 6px max(10px, calc(6px + var(--safe-bottom, 0px)))"');
    expect(app).toContain('paddingBottom: isMobile ? "calc(60px + var(--safe-bottom))" : 0');
  });

  it("keeps the iOS 16px input rule that stops focus-zoom", () => {
    expect(app).toContain("input, select, textarea { font-size: 16px !important; }");
    expect(app).toMatch(/@media \(max-width: \$\{MOBILE_BP\}px\) \{\s*\n\s*input, select, textarea \{ font-size: 16px !important; \}/);
  });

  it("keeps the modals' safe-area bottom padding", () => {
    expect((app.match(/calc\(18px \+ var\(--safe-bottom\)\)/g) || []).length).toBe(3);
  });

  it("keeps the DNA tab's dvh height math and its comment", () => {
    expect(dna).toContain("// View-scoped CSS: full-bleed height math (100dvh with a 100vh fallback — inline");
    expect(dna).toContain(".dna-view { position: relative; overflow: hidden; height: calc(100vh - 52px); height: calc(100dvh - 52px); }");
    expect(dna).toContain(".dna-view { height: calc(100vh - 112px); height: calc(100dvh - 112px - var(--safe-bottom)); }");
  });
});
