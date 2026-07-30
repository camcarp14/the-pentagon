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

## 5. Why the surfaces have not moved yet

The kit and tokens are imported once, at `apps/shell/src/main.jsx`. **Every rule
in `components.css` is scoped to `[data-kit]`, and nothing sets it yet.** A
surface opts in by putting `data-kit` on its root; until it does, the sheet
cannot reach it.

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

**Migration order**, from the audit (23 agents, 2.7M tokens, 2026-07-30):

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
because by then the kit will have been proven on eight surfaces.

## 6. Untouchable

- Every `localStorage` key, Supabase table/column, query key and netlify function path.
- The iOS standalone geometry — safe areas, the vvh-pinned shell, the letterbox
  discriminator, keyboard handling. It is a CSS/JS contract spanning several
  files and no part of it works alone. Move it, never delete it.
- `@cc/mind` and `@cc/mind-canvas`: the mind graph is one component with eight
  palettes and its own tests. Restyle around it; do not re-fork it.
- Feature parity is absolute. Every control in the old UI exists in the new.
