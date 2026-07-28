// ─── The polish system + the ambient canvas, asserted ────────────────────────
//
// Both files fail SILENTLY. They are decoration: nothing imports a value from
// them, no view breaks without them, and no other test renders them. The
// ambient layer in particular can be present, animating, and completely
// invisible — that is not a hypothetical, it is what shipped twice while this
// was being built (see the two stacking/inheritance traps below). So the
// invariants get a test, and every one of them corresponds to a bug that
// actually happened rather than a rule someone thought sounded good.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
/** Strip comments so prose ABOUT a rule can never satisfy a test FOR it. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

const ambient = read("../ambient.css");
const polish = read("../polish.css");
const ambientCode = code(ambient);
const polishCode = code(polish);
const shellApp = read("../../../apps/shell/src/App.jsx");
const shellMain = read("../../../apps/shell/src/main.jsx");
const designPkg = JSON.parse(read("../package.json"));
const shellVite = read("../../../apps/shell/vite.config.js");

describe("the platform mounts the polish system once, for every tool", () => {
  it("exports both stylesheets as subpaths", () => {
    expect(designPkg.exports["./polish.css"]).toBe("./polish.css");
    expect(designPkg.exports["./ambient.css"]).toBe("./ambient.css");
  });

  // The aliases are PREFIX rewrites. With the object shorthand, importing
  // "@cc/design/polish.css" resolved to ".../design/index.js/polish.css" and the
  // build died on ENOTDIR — so the bare specifier has to be anchored.
  it("aliases the bare specifier exactly, so subpath imports resolve", () => {
    expect(shellVite).toMatch(/find:\s*\/\^@cc\\\/design\$\//);
    expect(shellVite).toMatch(/find:\s*\/\^@cc\\\/design\\\/\//);
  });

  // In the entry, not a tool chunk: a lazily-loaded tool must never be what
  // brings the motion vocabulary in, or the first paint has none of it.
  it("imports them from the shell entry", () => {
    expect(shellMain).toMatch(/import ["']@cc\/design\/polish\.css["']/);
    expect(shellMain).toMatch(/import ["']@cc\/design\/ambient\.css["']/);
  });

  // Runway owned the platform's only motion system and kept it to itself.
  it("leaves no second copy in Runway", () => {
    expect(() => read("../../../apps/runway/src/styles/polish.css")).toThrow();
    expect(read("../../../apps/runway/src/Root.jsx")).not.toMatch(/import polishCss/);
  });
});

describe("the wash reaches the screen", () => {
  // TRAP 1. .ambient sits at z-index -1. In a plain stacking context an in-flow
  // block's background paints AFTER negative-z descendants, so the shell's
  // wrapper — which fills var(--bg) — covered the layer entirely. `isolation:
  // isolate` makes the wrapper its own stacking context, which puts its
  // background at step 1 and the ambient at step 2, above it.
  it("the shell wrapper isolates, or its own background hides the layer", () => {
    expect(shellApp).toMatch(/isolation:\s*["']isolate["']/);
  });

  // TRAP 2. The colours are declared on .ambient but consumed by the .amb-*
  // CHILDREN's gradients. Registered with `inherits: false` — the intuitive
  // choice — every pool resolves var(--amb-N) to the initial-value instead,
  // painting three perfectly transparent circles. Measured as a flat grey pixel
  // delta (the grain alone) where a coloured one belonged.
  it("registers the pool colours as inheritable", () => {
    const props = [...ambientCode.matchAll(/@property\s+--amb-\d\s*\{([^}]*)\}/g)];
    expect(props).toHaveLength(3);
    for (const [, body] of props) {
      expect(body).toMatch(/syntax:\s*["']<color>["']/);
      expect(body).toMatch(/inherits:\s*true/);
    }
  });

  it("is mounted, inert, and behind everything", () => {
    expect(shellApp).toMatch(/<Ambient\s*\/>/);
    const layer = ambientCode.match(/\.ambient\s*\{([^}]*)\}/)[1];
    expect(layer).toMatch(/position:\s*fixed/);
    expect(layer).toMatch(/z-index:\s*-1/);
    expect(layer).toMatch(/pointer-events:\s*none/);
    expect(layer).toMatch(/overflow:\s*hidden/);
    // `contain: strict` includes size containment, which an inset-sized box
    // cannot survive — it collapses to nothing.
    expect(layer).not.toMatch(/contain:[^;]*\b(strict|size)\b/);
  });
});

describe("every colour comes from the tool's own accent", () => {
  it("ambient.css hardcodes no colour", () => {
    expect(ambientCode.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(ambientCode.match(/\brgba?\(/g)).toBeNull();
  });

  // polish.css was Runway's, and hardcoded violet in two places that would have
  // painted all six tools violet the moment it was shared.
  it("polish.css takes ::selection and the primary hover glow from --accent", () => {
    const sel = polishCode.match(/::selection\s*\{([^}]*)\}/)[1];
    expect(sel).toMatch(/var\(--accent/);
    expect(sel).not.toMatch(/139,\s*124,\s*255/);
    const glow = polishCode.match(/\.btn\.primary:hover[^{]*\{([^}]*)\}/)[1];
    expect(glow).toMatch(/var\(--accent/);
    expect(glow).not.toMatch(/139,\s*124,\s*255/);
  });
});

describe("motion stays on the compositor", () => {
  // Everything here was profiled in the Board Room app, where each cost real
  // frames. Carried over deliberately; each is easy to undo without noticing.
  it("uses no filter: blur() — the soft edge is the gradient's own falloff", () => {
    expect(ambientCode).not.toMatch(/filter:\s*blur/);
  });

  it("keeps the grain on ::after rather than a fourth element", () => {
    expect(ambientCode).toMatch(/\.ambient::after\s*\{[^}]*background-image:/);
    expect(ambientCode).not.toMatch(/\.amb-grain\s*\{/);
  });

  it("draws the composition in one clamped unit, never raw vmax", () => {
    expect(ambientCode).toMatch(/--amb-u:\s*min\(1vmax,\s*\d+px\)/);
    expect(ambientCode.match(/:\s*-?[\d.]+vmax\b/g)).toBeNull();
  });

  it("translates without scaling, on three non-aligning periods", () => {
    const frames = [...ambientCode.matchAll(/@keyframes\s+amb-drift-\d[\s\S]*?\n\}/g)].map((m) => m[0]);
    expect(frames).toHaveLength(3);
    for (const kf of frames) {
      // Animating scale re-rasterises a full-screen layer every frame.
      expect(kf).not.toMatch(/scale\s*\(/);
      // Each keyframe step is `from|50%|to { prop: value; … }` on one line, so
      // pull the declarations out of the step bodies rather than by line. The
      // @keyframes header has to come off first, or the first {…} match spans
      // the outer brace and swallows the step selector with it.
      const steps = kf.replace(/^@keyframes\s+\S+\s*\{/, "").replace(/\}\s*$/, "");
      const props = [...steps.matchAll(/\{([^}]*)\}/g)]
        .flatMap((m) => m[1].split(";"))
        .map((d) => d.split(":")[0].trim())
        .filter(Boolean);
      expect(props.length).toBeGreaterThan(0);
      expect(new Set(props)).toEqual(new Set(["transform"]));
    }
    const durs = [...ambientCode.matchAll(/animation:\s*amb-drift-\d\s+(\d+)s/g)].map((m) => Number(m[1]));
    expect(durs).toHaveLength(3);
    expect(Math.min(...durs)).toBeGreaterThanOrEqual(45);
    expect(new Set(durs).size).toBe(3); // must not re-align into a learnable loop
  });
});

describe("the mandate", () => {
  it("ambient drift is gated, and the light survives the gate", () => {
    const rm = ambient.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}/)[1];
    expect(rm).toMatch(/\.amb-pool\s*\{[^}]*animation:\s*none/);
    // Frozen mid-cycle, not removed: these users get the same room standing
    // still, and keep the accent that tells them which tool they are in.
    expect(rm).toMatch(/\.amb-1\s*\{[^}]*transform:/);
    expect(rm).toMatch(/\.amb-3\s*\{[^}]*transform:/);
  });

  it("polish gates every animation it introduces", () => {
    const rm = polish.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}/)[1];
    for (const cls of [".pagefade", ".stagger > *", ".toast", ".cmdk"]) {
      expect(rm).toContain(cls);
    }
    expect(rm).toMatch(/\.sk::after\s*\{[^}]*animation:\s*none/);
  });

  // The dark canvas rendered the browser default focus outline nearly
  // invisible, and several surfaces killed it outright with `outline: none`.
  it("rings focus-visible on everything focusable, accent-tinted", () => {
    const rule = polishCode.match(/(:where\([^)]*\)[^{]*):focus-visible\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const [, selector, body] = rule;
    expect(body).toMatch(/box-shadow:.*var\(--focus-ring/);
    // Covers the non-<button> controls too — a div with role=button takes
    // keyboard focus and showed nothing for it. tabindex="-1" stays out: that
    // is the programmatic-focus hatch (scroll containers, dialog roots).
    expect(selector).toContain('[tabindex]:not([tabindex="-1"])');
    expect(selector).toContain('[role="button"]');
  });
});
