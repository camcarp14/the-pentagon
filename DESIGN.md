# The Pentagon — design language

*(v1 · July 2026 · adopted from Board Room's SESSION)*

Nine surfaces built at different times, in three different styling paradigms,
with 2,680 inline `style={{ }}` objects between them. This document is the
correction: one token layer, one kit, one motion system, eight palettes.

**The system is installed. The surfaces have not moved onto it yet.** That order
is deliberate — see §5.

---

## 1. Where it came from, and the thing that resolved the conflict

The language is Board Room's, ported file for file. Board Room's own `DESIGN.md`
describes a single gold accent and says "if a screen shows gold more than three
times, it's wrong." The Pentagon gives every tool its own colour. Those look
irreconcilable, and reconciling them was the central question of this port.

They are not in conflict, because **Board Room's DESIGN.md is 63 commits stale.**
It was last touched on 2026-07-16; the commit `4fd0d79 "Twenty colour schemes"`
landed on 2026-07-25. What Board Room actually ships today is twenty palettes
selected by a `[data-palette]` attribute, each authoring about ten tokens with
everything else derived by `color-mix`.

The Pentagon's eight per-tool accents are **the same architecture**, not a
departure from it. That is what turned this port from a redesign into a data
table.

## 2. The token layer

```
packages/design/
  gen-themes.mjs   ← the ONLY thing you edit. Eight rows, six numbers each.
  tokens.css       ← motion, type, shape, semantic data palette, neutral ground
  themes.css       ← GENERATED. 8 palettes × 2 modes.
  palettes.js      ← GENERATED. Labels + swatches for any picker UI.
  index.css        ← tokens then themes, in that order. The order is load-bearing.
packages/ui/
  components.css   ← the type scale, the motion system, the kit's class layer
```

Run `npm run themes` after editing the table. A hand-edit to `themes.css` or
`palettes.js` is silently reverted by the next run, and
`packages/design/__tests__/theme.test.js` fails if the two ever disagree.

Each tool is **six numbers**: neutral hue and saturation, accent hue and
saturation, and a ground lightness per mode. Every colour below that derives
through `color-mix`, so overriding `--ink` moves the whole eighteen-step ink
ladder with it — and that is true because the ladder is re-declared inside the
`[data-palette]` block. It is not enough to derive it once on `:root`: custom
properties substitute at computed-value time, so a `:root` ladder resolves
against `:root`'s `--ink` and merely inherits, freezing at the neutral ground
whatever palette is active. The first version of this port made exactly that
mistake and claimed otherwise in this paragraph. The generator contrast-checks
every emitted value against WCAG AA before writing.

The accent hues were measured off the existing ramps in
`packages/design/index.js`, so no tool changed colour on the day this landed.

**Light mode comes free.** The Pentagon ships dark-only, but the generator emits
both modes from the same authored row, so a light Pentagon is now a stylesheet
rather than a redesign. The light halves are already generated and contrast-checked.

## 3. Two deliberate divergences from Board Room

- **No webfont.** Board Room self-hosts Inter Variable from an absolute
  `/fonts/` path, which nine apps building through one shell cannot resolve.
  SESSION's own spec (§2) says system stack, no webfonts — so the spec wins over
  the drift, and the port's hardest blocker disappears.
- **No `--btc`.** Bitcoin orange is one app's domain colour. Macro can define it
  locally; a shared package should not carry one tool's subject matter.

One correction went the other way: Board Room's `.dock-label` is `10px`, which
breaks SESSION §2's stated hard floor of 10.5px ("nothing smaller, ever"). The
floor is the stronger rule — it is absolute and general, where the 10px is one
incidental measurement — and a system that violates its own floor cannot be
enforced by a test. Raised to 10.5px here.

## 4. What is true of every screen

Taken from SESSION and now enforceable, because the tokens exist:

1. **Deference.** Chrome recedes; content leads. If it does not help right now,
   it does not get ink.
2. **One material.** Cards are `--surface`, no outline. Separation is tone and
   soft shadow. **Never a border and a shadow on the same element.** Hairlines
   only inside lists, inset.
3. **Type does the work.** Sentence case. Hierarchy from size and weight, not
   tracking. Uppercase survives in exactly one place: `.t-label`.
   **Hard floor 10.5px.**
4. **One accent, spent rarely.** The active tab, the primary action, live
   indicators, selected states. Nowhere else. The accent says *which tool you are
   in*; that is its whole job, and it does it best when it is scarce.
5. **Numbers are instruments.** Tabular, mono, tweened. They never jiggle.
6. **Motion is one physics.** Press `scale(0.97)`; entrances opacity + 4px rise;
   `--dur-1/2/3` and `--ease-out/spring` and nothing else. All of it behind
   `prefers-reduced-motion`.
7. **Every state is drawn.** Errors get a Retry, never a dead end. Empty states
   say what to do next and give you the button.

## 5. How the surfaces moved

The kit and tokens are imported once, at `apps/shell/src/main.jsx`. **Every rule
in `components.css` is scoped to `[data-kit]`.** A surface opts in by putting
`data-kit` on its root; until it does, the sheet cannot reach it. **All nine
surfaces have now opted in** — this section used to say "nothing sets it yet",
which stayed on the page for the whole migration and was flagged by two separate
reviewers, each assuming the other owned it. If you are reading this while
migrating something, the sentence you are about to falsify is this one.

That scoping is not tidiness — it is the only reason this is safe to land, and it
was not in the first version. That version argued the sheet was harmless because
`App.jsx` stamps `cssVars()` inline and inline beats a stylesheet. True, and
irrelevant: inline only wins for CUSTOM PROPERTIES, and `components.css` ships
~200 ordinary declarations on the most obvious class names there are — `.card`,
`.field`, `.btn`, `.seg`, `.sheet`, `.empty`. Eight apps already owned those
names and meant different things by them:

- Macro's `.field` is a `<label>+<input>` **wrapper** declaring only display and
  gap. The kit's `.field` is the input itself, with a background, 12/14px padding
  and a 44px floor. Zero overlap, so all of it applied — to 26 Settings and
  Journal rows.
- Runway's `.sheet` is its **printed resume**. The kit's `.sheet` is
  `position: fixed`, and a centred 560px modal above 761px. A letter-paper
  document became a bottom sheet.
- Runway's `.card` would have gained a `box-shadow` on top of its existing
  `border` — the exact anti-pattern §4.2 above forbids.

An adversarial review with a fresh context window found all of it before it
shipped. `packages/design/__tests__/theme.test.js` now fails if any rule in the
kit loses its scope, and that assertion was itself mutation-tested.

**Migration order**, from the audit (23 agents, 2.7M tokens, 2026-07-30). All
nine have landed; the order is kept because it explains the shape of the result.

| # | App | Why here | Cost |
|---|-----|----------|------|
| 1 | shell | It is the chrome every tool renders inside; it is 100% inline styles with 2 classNames in 1,351 lines | medium |
| 2 | ideas | 423 lines, one file, 35 inline styles — the cheapest proof the kit works end to end | small |
| 3 | looper | 242-line sheet, 65 classes, already class-based | small |
| 4 | macro | 583-line sheet, 99 classes, only 30 inline escapes — a rename, mostly | medium |
| 5 | runway | 3 stylesheets, and the only app importing neither `@cc/ui` nor `@cc/design` | medium |
| 6 | business | 365 inline styles already written against custom properties | medium |
| 7 | zts | 502 inline styles, 0 CSS files, CSS injected from JS template strings | large |
| 8 | sync | 1,110-line scoped sheet — disciplined, but a private system rather than the shared one | large |
| 9 | clarify | 7,392 lines of JSX, 1,209 inline styles, 103 components, 0 CSS files | very large |

Shell first because navigation is what the operator actually complained about.
Clarify last because it is larger than the four smallest apps combined, and
because by then the kit had been proven on eight surfaces.

**What the order actually bought.** Every migration was reviewed by a fresh
context window whose only job was to prove it broken, and every one of the nine
reviews came back failing. That is the point of the arrangement, not a sign it
went badly: the defects were found by someone who had not just written the code.
The two that mattered most were both invisible to the app that caused them — the
kit's `[data-kit]` scoping (§5 above) and the global keyframe namespace (§6
below) — and neither could have been found by testing one surface in isolation.

**Still outstanding.** ZTS's and Clarify's DNA tabs are only partly on the kit
(roughly two dozen hand-rolled controls each), and both are exempted wholesale
from the kit-control assertions rather than migrated. That is deliberate: those
tabs are being retired in favour of the shell's single Minds screen
(`apps/shell/src/Minds.jsx`), so restyling them would be work thrown away. Until
the retirement lands, the exemptions are real coverage gaps on shipped surfaces
and should be read as such.

## 6. Keyframe names are document-global — the kit owns them

A `@keyframes` name cannot be scoped. Not by `[data-kit]`, not by a class, not by
a media query, not by a shadow root's parent, not by anything. There is one flat
namespace per document, last definition wins, and nine tools share one document.

That made §5's careful scoping a half-measure: every ordinary declaration in
`components.css` is behind `[data-kit]`, but its sixteen keyframe names are not
and cannot be. Six app files defined the same names. Several of those apps inject
their sheet into `document.head` at mount and never remove it, so they land after
the shell's `import "@cc/ui/components.css"` and win for **every tool on screen**,
not just their own.

The sharpest case, and the one that proves it is not theoretical: the kit's
`shimmer` is a TRANSFORM sweep driving `[data-kit] .sk::after`, which starts at
`translateX(-100%)`. ZTS's and Clarify's `shimmer` were BACKGROUND-POSITION
sweeps. A background-position animation does nothing to that element, so with ZTS
or Clarify mounted, kit skeleton loaders stopped animating **in every tool**.
`packages/ui/index.jsx` shipped a third background-position `shimmer`, injected
from JS at import time, which beat `components.css` unconditionally.

**The rule:**

1. `packages/ui/components.css` is the **sole owner** of the kit keyframe names —
   today `pagein, slidel, slider, rise, shimmer, fadein, pulse, sheetup, breathe,
   spin, shake, convene, sheetin, modalin, toastin, toastout`. The list is not
   authoritative here; the file is.
2. An app that wants the kit's behaviour **references** the name and does not
   define it. No copy, however identical — an identical copy is a future
   divergence that nothing will catch.
3. An app that needs **different** behaviour defines a **prefixed** name —
   `zts-`/`co-`/`mc-`/`rw-`/`sy-`/`biz-`/`sh-`, matching that app's existing
   convention — and points its own consumers at the prefixed name. `business`
   (`bizPulse`, `bizSpin`, `bizRise`), `sync` and `runway` (`rw-pulse`,
   `rw-fadein`, `rw-rise`) already do this correctly and are the worked examples.
4. Prefer (2) over (3). A 1px or 0.05-opacity difference is not a reason to fork
   the motion system — §4.6 says motion is one physics, and this is where that
   stops being a slogan.

`packages/ui/__tests__/keyframes.test.js` enforces it. It derives the owned names
from `components.css` rather than hardcoding them, so the guard follows the kit,
and it scans JS/JSX **template literals** as well as `.css` files, because the two
worst offenders injected their CSS from a template string and a `.css`-only glob
missed both entirely. It carries scan-sanity floors so a regex that quietly stops
matching cannot pass green, and every assertion in it was mutation-tested.

## 7. Untouchable

- Every `localStorage` key, Supabase table/column, query key and netlify function path.
- The iOS standalone geometry — safe areas, the vvh-pinned shell, the letterbox
  discriminator, keyboard handling. It is a CSS/JS contract spanning several
  files and no part of it works alone. Move it, never delete it.
- `@cc/mind` and `@cc/mind-canvas`: the mind graph is one component with eight
  palettes and its own tests. Restyle around it; do not re-fork it.
- Feature parity is absolute. Every control in the old UI exists in the new.
