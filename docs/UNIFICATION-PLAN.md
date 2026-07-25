# Command Center — Unification Plan

Combine **ZTS Command Center** (creator registry + studio), **Clarify Outreach**,
and **Runway** into one site: a single shell with a top-of-screen toggle that
switches between the three tools, one shared design system with a per-tool
accent, and one login. Built as a fresh **monorepo** (npm workspaces) so all
three are updated, themed, and shipped together.

> Status: done. This repo is the monorepo root, and has since been renamed
> `zts-command-center` → `the-pentagon` (a settings-only step that preserved
> history and auto-redirects the old URL — no new repo, no lost commits).

## The three apps, as they are today

| | ZTS | Clarify Outreach | Runway |
|---|---|---|---|
| Purpose | YouTube creator registry + Shorts studio + SEO + DNA | Cold-outreach pipeline, inbound, clients, sequences | Single-user job-search command center |
| Build | Vite 5 | Vite 4 | Vite 6 |
| Styling | inline JS tokens (`T`, emerald) | inline JS tokens (`T`, gold) | CSS files + classNames |
| Nav | `view` state, top pill + mobile bottom nav | hash routes `#/`, 6 tabs + sub-nav | react-router paths, left rail |
| Root export | `App.jsx` default | `App.jsx` default | `App.jsx` default (needs `<BrowserRouter>`) |
| Auth | supabase-js | hand-rolled `fetch` to `/auth/v1` | supabase-js |
| Supabase project | `nrzpinvyxxorxufadvyc` (clarify), `zts` schema | `nrzpinvyxxorxufadvyc` (clarify), default schema | `uyjkbvvgfiyarvptbooi` (board-room), `runway` schema |
| Backend fns | claude, shopify-publish | email send/read, tracking, claude, prospecting | parse-job/resume, tailor, board scan, claude |

**Already converged:** shared font stack (Syne/Inter/DM Mono), a shared
`ui.jsx` primitive set (ZTS ported Clarify's), a shared DNA "neural mind"
subsystem (ZTS ported Clarify's), and matching motion curves. The unification
formalizes what's already drifting together on purpose.

## Target architecture

```
package.json                 # npm workspaces: apps/*, packages/*
apps/
  shell/                     # THE site. One Vite app, one index.html.
                             #   - single login (both Supabase projects)
                             #   - top toggle: ZTS · Clarify · Runway (desktop)
                             #   - mobile: compact app-switcher in the header
                             #   - lazy-mounts each tool (code-split)
                             #   - cross-app command palette (⌘K)
                             #   - sets the per-tool accent on switch
  zts/                       # from the zts registry repo    (export <ZtsApp/>)
  clarify/                   # from clarify-outreach/src     (export <ClarifyApp/>)
  runway/                    # from runway/src               (export <RunwayApp/>)
packages/
  design/                    # ONE token source: base + per-app accent,
                             #   emitted as JS objects AND CSS variables
  ui/                        # ONE copy of the shared primitives
                             #   (AnimatedNumber, Skeletons, EmptyState,
                             #    Toasts, CommandPalette)
  supabase/                  # client factory per project + unified login
netlify/functions/           # merged; ONE shared claude proxy; rest namespaced
```

Each tool keeps its own screens and its own internal navigation. The shell only
owns: login, the app toggle, theming, and the top-level palette. Tools are
loaded with `React.lazy`, so opening ZTS never downloads Runway.

### The toggle

- **Desktop:** a segmented control at the top-left of the header (reusing ZTS's
  existing sliding-pill pattern, promoted one level up). The active tool's own
  tabs render beneath it, exactly as they do today.
- **Mobile:** each tool already has its own bottom nav, so the *app* switch
  lives in the top header as a compact segmented control / dropdown — never
  competing with a tool's bottom nav.

### Design templatization (per-tool accent, one system)

`packages/design` exports a base token set plus an `accent` slot. A tool's theme
is `base + accent` (ZTS emerald, Clarify gold, Runway its own). The shell writes
`data-app="zts|clarify|runway"` on the root and sets CSS variables
(`--accent`, `--accent-deep`, `--accent-grad`, …) so:

- the two inline-token apps read `theme(app)` (a thin wrapper over the tokens),
- Runway's existing CSS reads `var(--accent)` instead of hard-coded colors.

One component library, one motion vocabulary, three recognizable identities.

### Auth — one login across two projects

Because ZTS/Clarify live on the *clarify* project and Runway lives on the
*board-room* project, "one login" is handled in `packages/supabase`:

- **v1 (now):** the shell shows one login screen. On submit it authenticates the
  single operator against **both** projects with the same credentials (the same
  account is provisioned in both — same `ALLOWED_EMAIL`). Each tool's client then
  reads its own project's persisted session. No data migration, one sign-in UX.
- **later (optional, deferred):** consolidate Runway's `runway` schema into the
  clarify project so there's a single backend and literally one auth. This is
  "deep/data" work and is out of scope for the shell-first pass.

## Concerns / risks (with resolutions)

1. **Two Supabase projects vs. one login** → shell signs into both with one
   credential entry (above). Flagged for your awareness; optional consolidation later.
2. **Runway styles with CSS classes, the others with inline tokens** → bridge via
   CSS variables emitted by `packages/design`; no rewrite of Runway's CSS needed.
3. **Three routers/providers** → v1 keeps each tool's own `ToastProvider`/palette
   nested under the shell. Runway mounts inside `<BrowserRouter basename="/runway">`;
   Clarify's hash-routing coexists (path picks the tool, hash picks Clarify's view).
   Unify providers in a later cleanup.
4. **Netlify function name collisions** (all three have `claude.js`) → one shared
   `claude` proxy; the rest namespaced (`clarify-*`, `runway-*`).
5. **Bundle size** → mandatory per-tool code-splitting via `React.lazy`.
6. **localStorage namespaces** → already namespaced (`zts_`, `clarify_`, Runway's
   own); kept distinct.
7. **Vite version spread (4/5/6)** → the monorepo builds ONE Vite app (the shell,
   Vite 6). Each tool becomes imported modules, not its own Vite build. Each tool's
   source is verified to build under the shared Vite on the way in.

## Deploy

One Netlify site, one domain, one function bundle. Old per-app Netlify sites →
redirects to the unified domain. Env vars: both projects' URL + anon key, the
shared `ANTHROPIC_API_KEY`, plus Clarify's email/Shopify server vars.

## Phases

- **P0 — Plan** (this document).
- **P1 — Skeleton + design system.** Stand up workspaces; extract `packages/design`
  + `packages/ui` (dedupe the three primitive copies to one); move ZTS into
  `apps/zts`; `apps/shell` renders ZTS behind the toggle. Build verified.
- **P2 — Clarify in.** Mount under the shell; move its auth to the shared login;
  reconcile its `ui`/`theme` onto the packages.
- **P3 — Runway in.** Mount with `basename` router; bridge its CSS to the accent
  variables; add board-room auth to the shell login.
- **P4 — Ship.** Merge Netlify functions; one deploy; domain + redirects; env
  consolidation; repo rename.
- **P5 — Deepen (deferred).** Cross-tool links (a creator ↔ an outreach thread,
  etc.) and optional Supabase project consolidation.

## Decisions & status log

**2026-07-23**

- **Repo:** fresh unified monorepo, built in place on this branch (rename to
  `command-center` at the end). ✅ scaffolded (Phase B).
- **Scope:** shell + shared design first; deep data-merge deferred.
- **Auth / backend:** consolidate onto ONE Supabase project (the clarify
  project) rather than signing into two. Supersedes the "sign into both
  projects" note above — with one project there is literally one login.
- **Design:** per-tool identity is **mode (light/dark) + accent**, not accent
  alone — Runway ships a dark canvas. Encoded in `@cc/design`. ✅
- **Runway data:** **start fresh** on the clarify project (no data copy). The
  operator's résumé + targeting can be carried over on request (2 tiny rows)
  any time before cutover.
- **Board-room cleanup:** dropping board-room's `runway` schema is the **final**
  step, run ONLY after Runway is repointed to clarify and confirmed working —
  never before, or the still-live Runway app breaks. It permanently deletes the
  board-room copy of the résumé/targeting/jobs.
- **Nav:** two clear layers — shell top bar = app toggle; each tool keeps its
  own internal tabs/rail beneath.

**Done so far**

- Phase A (DB): `runway` schema ported into the clarify project — 10 tables, 4
  functions, 9 RLS policies, 7 write-triggers, fresh/empty, verified. Remaining
  Phase A = cutover (expose `runway` in the clarify API settings + repoint the
  Runway client/env + service-role key), folded into Phase C/D.
- Phase B (packages): `@cc/design`, `@cc/ui`, `@cc/supabase` built, workspace
  linked, all transform-verified. Committed + pushed.

**Next:** Phase C — move `apps/{zts,clarify,runway}` in, build `apps/shell`
(single login, top toggle, lazy mounts, per-tool theming), mount all three.
