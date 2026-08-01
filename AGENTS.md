# AGENTS.md — working on The Pentagon as an AI agent

This file is read automatically by OpenAI Codex / ChatGPT's repo agent, and by
Claude Code (which also honours `AGENTS.md`). It is the shared brief: whichever
model is driving, the rules below are the ones that keep a live site alive.

Read it before the first edit. Nothing here is style preference — each rule is
here because breaking it broke production once.

---

## What this repo is

A monorepo of small operator tools ("The Pentagon") that ship as **one Netlify
site**, backed by **one Supabase project**, deployed from **one GitHub repo**.

```
apps/          one folder per tool — shell (the hub), sync, clarify, zts,
               looper, business, ideas, macro, runway
packages/      shared code — ui, design, ai (model pricing), supabase, ops,
               mind, mind-canvas
netlify/       functions/  — the API. Everything server-side lives here.
               functions/lib/, functions/_shared/ — shared function code
supabase/      migrations/ — the schema, in order. Never edit an applied one.
schema.sql     the flattened current schema, for reading
scripts/       smoke.mjs and friends
```

Routing: `netlify.toml` maps `/api/*` → `/.netlify/functions/*`, and everything
else to the SPA. A function named `foo.mjs` is reachable at both
`/.netlify/functions/foo` and `/api/foo`.

---

## The commands that matter

```bash
npm install            # once
npm run dev            # local shell on Vite
npm test               # vitest, the whole workspace
npm run build          # production build — this is what Netlify runs
npm run verify         # test + build. THE GATE. Run before every push.
npm run smoke          # scripts/smoke.mjs, function-level checks
```

**`npm run verify` must pass before you push.** A red build on `main` takes the
whole site down, not one tool — every app ships in the same bundle.

---

## Git rules

- Work on a branch, never commit straight to `main`.
- Branch naming: `claude/<topic>` or `codex/<topic>` so it is obvious which
  agent produced it.
- Open a PR; let Netlify's deploy preview build before merging.
- Never force-push `main`. Never rewrite pushed history someone else may hold.

---

## Secrets — the hard line

- **No key, token, or URL-with-credentials ever lands in a committed file.**
  Not in a test fixture, not in a comment, not "temporarily".
- Server-side keys live only in **Netlify → Site configuration → Environment
  variables**. `.env.example` documents every name with an empty value; add new
  names there, never values.
- `VITE_*` variables are **baked into the public browser bundle**. Anything
  secret must NOT carry that prefix. `.env.example` says this too, at length,
  because it has been got wrong.
- Supabase: the *publishable* key is public by design and already in the client
  bundle. The **service role key** is not, and must never reach the browser or
  the repo.

---

## Server-side rules for `netlify/functions/`

1. **Every function that spends money or touches data checks auth first.**
   Use `_shared/requireAuth.cjs` (v1 `event`-shaped handlers) or the inline
   session check pattern in `claude-stream.mjs` (v2 `Request`-shaped). A proxy
   without an auth check is an open wallet — anyone with the URL can spend the
   API budget.
2. **Two function generations coexist and are not interchangeable.** `.js`/`.cjs`
   files are v1: `exports.handler = async (event) => ({ statusCode, body })`.
   `.mjs` files are v2: `export default async (req) => new Response(...)`. A v1
   handler cannot stream; a v2 handler has no `event`. Match the file you are in.
3. **Model allow-lists are enforced server-side**, not just in the UI. A browser
   list can be edited from devtools; the server's cannot.
4. Return **503 with the variable name** when a required env var is missing —
   never a 500. It is a configuration fact with one fix, and the message should
   say which.

---

## Database rules for `supabase/`

- Schema changes are **new migration files** in `supabase/migrations/`, named
  with a timestamp prefix. Never edit a migration that has already been applied
  — the remote project will not re-run it, and the file then lies about the
  live schema.
- Every new table gets **RLS enabled** plus an explicit policy. A table without
  RLS on a project with a public publishable key is readable by the internet.
- Prefer additive changes. A `DROP COLUMN` in a migration runs against live data
  the moment it merges.
- Read `list_tables` (or `schema.sql`) before writing a migration, not after.

---

## Model / AI plumbing

Every AI surface speaks **one wire format**: the Anthropic Messages shape.

- `netlify/functions/claude.js` — buffered proxy, one JSON reply.
- `netlify/functions/claude-stream.mjs` — streaming proxy, SSE.
- `netlify/functions/lib/openai.mjs` — translates that shape to/from OpenAI, so
  GPT models work through the same endpoints and the same client parser.

To **add a model**: add its id to `OPENAI_MODELS` (or `ALLOWED_MODELS` for
Anthropic) on the server, add a row to `MODELS` in
`apps/sync/src/agent/transport.js`, and add its price to
`packages/ai/pricing.js`. All three, or spend reporting goes wrong — an unknown
model prices at the most expensive known rate by design.

Known gap: Anthropic's `web_search` server tool has no OpenAI equivalent. The
proxy drops it on GPT models and the Settings sheet says so on screen.

---

## Conventions worth matching

- Comments in this repo explain **why**, at length, especially where a naive
  change would be wrong. Match that. A one-line comment restating the code is
  noise; a paragraph explaining the failure that shaped the code is the house
  style.
- Tests live in `__tests__/` next to what they test. New server behaviour gets a
  test.
- Don't reformat files you aren't changing. Diff noise hides real changes.

---

## Before you say you're done

- [ ] `npm run verify` passes
- [ ] No secret values added to any tracked file
- [ ] New env vars documented (empty) in `.env.example`
- [ ] Schema changes are new migration files with RLS
- [ ] You pushed a branch and opened a PR — you did not push to `main`
