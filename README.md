# The Pentagon

One site, one login, one toggle — **The Pentagon** is the operations hub that
houses six tools under a single shell. A top-of-screen toggle (a bottom bar on
mobile) switches between them; each is lazy-loaded and re-skins the whole page to
its own accent while sharing one dark design language.

All six share one dark "midnight" canvas (drawn from Clarify's design) and
differ only by accent, so they read as one product:

| Module | What it is | Accent |
|---|---|---|
| **ZTS** | Zero To Secure's creator registry + content studio | emerald |
| **Clarify** | Outreach & pipeline CRM | brass |
| **Runway** | Job-search command board | violet |
| **Macro** | Trading cockpit | amber |
| **Looper** | Browser-driven mission loop | cyan |
| **Business** | Command and control for the autonomous SaaS agent | magenta |

Above them all sits **System** — a cross-tool hub that merges usage, the neural
"minds" (DNA), and the agent rosters from every module into one place.

This is an npm-workspaces monorepo: the shell lives in `apps/shell`, each tool in
`apps/{zts,clarify,runway,macro,looper,business}`, and the shared design tokens /
UI primitives / Supabase client in `packages/{design,ui,supabase}`. One Netlify
deploy serves the shell (`apps/shell/dist`) with every tool's functions merged
under `netlify/functions`. See
[docs/UNIFICATION-PLAN.md](docs/UNIFICATION-PLAN.md) for the architecture and
[docs/DEPLOY.md](docs/DEPLOY.md) for the runbook.

One exception to "one login": **Business** talks to a different Supabase project
from every other tool, so it carries its own client and its own sign-in. See
below.

---

## ZTS module

Zero To Secure's operations tool — three pillars, one tab set:

| Tab | What lives there |
|---|---|
| **Mission** | Today's picture: creator pipeline, Studio status, AI spend, agent roster |
| **Creators** | YouTube-creator collab pipeline, auto-scored by niche fit — with AI collab-pitch drafting |
| **Studio** | Shorts ideation (Claude drafts the full asset package) + the Factory production rail |
| **SEO** | Article pipeline with an approval gate; publishes to the Shopify blog |
| **DNA** | The living mind: a weighted node graph that compiles into the worker's prompt |
| **Agents** | The heuristic agent engine — free heartbeat, gated synthesis |
| **Ops** | Every Claude call: tokens, cost, latency, success |

Every pipeline moves both directions (`‹ ›` on cards), and `⌘K` opens a command
palette from anywhere — jump to tabs, creators, Shorts, articles, or quick-create.

## The Factory (shorts-factory)

`factory/` holds the production half of the Studio: a local Python pipeline that
turns raw filmed footage into a finished 9:16 Short — local whisper transcription,
LLM clip selection, dead-air tightening, face-aware crop, word-highlight captions,
restrained pop-ups, and a mandatory review gate before export. See
[factory/README.md](factory/README.md) for setup (Python 3.10+, ffmpeg; Windows
runs it under WSL2).

The two halves connect through a zero-dependency local bridge:

```bash
cd factory && python bridge.py     # http://127.0.0.1:8765
```

With the bridge running, the Studio tab's Factory rail shows live project state,
renders each draft's REVIEW doc in-app, and can approve drafts. "⇢ Factory" on
any scripted Short delivers a production brief into `factory/briefs/` — film it,
run the CLI, and the project appears in the rail. With the bridge offline
(including on the deployed site), the same handoff copies a complete brief to
the clipboard instead. The bridge binds 127.0.0.1 only, is read-only apart from
draft approval and brief drop-off, and never runs renders or spends API money.

## ZTS DNA

The **DNA** tab is the marketing machine's mind made visible and editable. It is a
living neural graph — **nodes** are aspects of how ZTS thinks (its identity, the
locked principles, what it knows, the signals it watches, the skills it can run,
the goals it drives toward), wired together by weighted **synapses** (excitatory
or tempering). Drag the canvas to explore it, double-click to grow a node,
⇧-drag to wire one, and click any node or synapse to tune its weight, directive,
region, or — for a skill — the model and token ceiling it runs on.

**The graph *is* the prompt.** `compileGenome()` turns the node graph
deterministically into a single system prompt: a locked governance charter first,
then each region ordered by meaning, with each node's weight setting its emphasis
(PRIMARY command → standing line → minor consideration) and every tempering
synapse spelled out as an explicit "when these conflict, X wins" tension. Same
graph ⇒ byte-identical prompt ⇒ the same `#hash` shown in the header. **⚡ Pulse**
lets you type a question, watch the matching nodes fire across the canvas, read
the exact compiled lines that lit, and optionally "Think it through" (a Haiku call
on that very prompt). The compile-lens (Primary / Standing / Full) tunes how much
of the mind those surfaces reveal — the worker always runs on the **Full** prompt.

**The Worker drafts; it never publishes.** A built-in headless worker (mounted at
app root, running only while ZTS is open in a tab) reads the compiled mind and
works the pipeline one task per pass — drafting an SEO article into the **review**
queue, scouting and ranking prime creators, compiling a daily strategy brief, or
proposing new knowledge nodes for you to accept. Everything it produces lands in a
review queue or the work log as a **draft**: it never posts a Short, publishes an
article, or moves a creator past *contacted* on its own. The dock exposes the
honest levers — a play/pause switch, per-task-type toggles, a tasks-per-hour and
$/hour cap, and a live work log where hovering an entry replays its activation on
the canvas. An optional **evening shift** arms the worker for a nightly window
(e.g. 6–10pm) so drafts are waiting for morning review — same drafts-only rule
applies; it simply runs on a schedule instead of a manual switch.

The mind is portable: **Export JSON** downloads the full genome, **Import JSON**
replaces it (rejected via a toast if it fails `validateGenome`), a **mutation
history** records every edit, and **Reset to seed** restores the shipped ZTS
doctrine. State lives in the same `zts_` localStorage namespace as the rest of the
app — no new infrastructure — and the whole tab is built on the shared **light
design system** (`src/ui.jsx` tokens, Syne / DM Mono, white glass over the ZTS
canvas), so it looks and feels native next to every other tab.

## AI Business module

Command and control for an agent that runs a SaaS business unattended. Built for
one usage pattern and no other: a look every six hours, from a phone, for under
two minutes.

It is the only tool here that does **not** use `@cc/supabase`. The agent lives in
its own Supabase project behind `VITE_AGENT_SUPABASE_URL` /
`VITE_AGENT_SUPABASE_ANON_KEY`, so a compromise of the agent reaches spend and
strategy and stops there. That isolation costs a second sign-in, and the tab
refuses to boot if it detects both URLs pointing at the same project.

Four ideas carry the design:

- **Halt has its own path to the database.** `src/lib/halt.js` imports nothing —
  no client wrapper, no cache, no shared fetch. It builds its own request and
  believes only the row the server hands back. When the rest of the page is
  throwing, the halt button still works, and it says "halted" only once the
  database has said so.
- **Silent failure is the enemy, so nothing renders as a calm zero.** Loading,
  empty, stale and unreachable are four visually distinct treatments, every
  panel carries the age of its data, and a panel whose newest row is older than
  its window alarms. "No actions in the last hour" and "we couldn't reach the
  database" can never look alike.
- **Approvals cannot expire quietly.** Anything closing within the hour pins to
  the top with a live countdown; anything that lapsed unreviewed while you were
  away gets its own *auto-proceeded without you* list, never merged into history.
- **Read-only except three verbs**, enforced by column-level `GRANT` in the
  agent's database — halt/resume, approve/veto, and the goal. An insert into
  `action_ledger` from the browser console fails at Postgres, not at a disabled
  button.

`schema.sql` at the repo root is the agent project's schema, RLS and grants;
`supabase/agent/README.md` is the setup runbook and the self-verification steps.
`?fault=db`, `?fault=loader` and `?fault=stale` inject failures on demand so the
honesty of the surface can be checked rather than assumed.

## Runway module

The job-search command board. Five tabs, and the two that carry the weight are
**Find** and the **apply desk**.

| Tab | What lives there |
|---|---|
| **Board** | The pipeline: seven stages, drag on desktop, one stage at a time on a phone. Today's due follow-ups sit above it |
| **Find** | The discovery inbox, your hunts, company discovery, the watchlist, and manual capture |
| **Skills** | What your market keeps asking for, ranked — and which of it your resume can evidence |
| **Insights** | Funnel, conversion, your rates against published candidate-side benchmarks, comp distribution |
| **Profile** | Target criteria, the master resume everything is grounded in, account |

**Finding roles.** Runway sweeps the *public* feeds of 14 ATS providers
(Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, Breezy,
Rippling, BambooHR, Jobvite, Pinpoint, Teamtailor, Personio, Workday). No
LinkedIn / Indeed / Glassdoor — they prohibit it, and that line does not move.

Two things decide what you actually see:

- **Hunts** — named searches, each with its own role terms, exclusions
  (`agency`, `contract`), must-haves, seniority band, comp floor and location.
  Every scan runs all of them and attributes each find to the one that made it.
- **The matcher** (`apps/runway/src/lib/matcher.js`) — role terms expand through
  a synonym graph before they are compared, so "paid search" finds *Senior SEM
  Specialist*, *Growth Marketing Manager, Paid Media* and *Manager, Biddable
  Media*. Every verdict carries the sentences that produced it, and the inbox
  prints them, so a card can be triaged without opening the posting.

**Company discovery** answers the question watching cannot: who else is hiring
for this? It walks a pool of employers, finds each one's public board live,
fetches it, and ranks companies by *how many roles match your hunt* — not by how
many jobs they have.

**The apply desk** (`/apply/:id`) is where an application gets done. Greenhouse
publishes its real application form, so Runway reads it — every box, its type,
whether it is required, the exact dropdown labels — and one model pass writes the
tailored resume, the cover letter and an answer to every screening question, all
at once so the three agree with each other. Each answer sits in form order with
its own Copy button. Other ATSs: paste the questions, ten seconds, same result.

Three things it will not do, enforced in `netlify/functions/lib/appform.mjs`:

- **It never submits.** There is no code path to an employer.
- **It never answers demographic self-identification** (gender, race, veteran
  status, disability). Those fields are stripped before the model sees them, then
  shown marked and empty. They are voluntary and they are the candidate's.
- **It never invents.** Name, email, phone and links come deterministically from
  the master resume; everything else is grounded in it, and gaps are stated
  rather than papered over.

**Skills** aggregates requirements across every posting you captured and every
one a scan matched — your market, not the market — and diffs it against the
master resume. Deterministic dictionary extraction, no model call, so it reads
the same on every load.

Schema lives in `supabase/migrations/20260806120000_runway_baseline.sql`
(a transcript of the tables as applied, written down at last) and
`…_runway_hunts_kits_skills.sql`.

## Stack

- Vite + React 18, single-page; design tokens + shared primitives in `src/ui.jsx`
- Supabase (`creators` / `shorts` / `articles` tables + auth); every write has a
  local fallback so the app still functions without configuration
- Netlify Functions: `claude` (Anthropic proxy), `shopify-publish` (blog posts)
- shorts-factory: Python 3.10+ / ffmpeg / faster-whisper, `factory/`

## Environment

**Netlify (server-side):** `ANTHROPIC_API_KEY`, `SHOPIFY_*` (see
`netlify/functions/shopify-publish.js`).

**Client (safe to expose):** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` —
RLS protects the data, not key secrecy. Local dev also reads
`VITE_ANTHROPIC_API_KEY` for direct API calls on localhost only.

## Notes

- `factory/projects/` and `factory/briefs/` are gitignored — footage and renders
  stay on the machine that filmed them.
- The SEO auto-draft cadence and agent-engine synthesis are both opt-in and
  cost-capped; a fresh install spends $0 until you flip them on.
