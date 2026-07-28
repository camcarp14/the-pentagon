# Command Center — Deploy (Phase D)

The unified app (shell + all three tools) builds from `apps/shell`. Netlify config
already points there (`netlify.toml`: `publish = "apps/shell/dist"`). What remains
to go live is the serverless-function merge, env wiring, one Supabase settings
toggle, and the deploy itself.

## 1. Merge the Netlify functions (in-repo — the next code step)

All three tools' functions collect into one `netlify/functions/`. Filenames only
collide on **`claude.js`**; everything else is already unique, and `_shared/`
files don't clash (ZTS uses `.js`, Clarify uses `.cjs`; Runway's helpers live in
`lib/`).

Bring in:
- **Clarify** → `audit-lead.cjs`, `check-replies.js`, `prospect-proxy.js`,
  `read-emails.js`, `send-email.js`, `track-click.cjs`, `track-open.cjs`, and
  `_shared/{requireAuth.cjs, response.cjs, supabaseRest.cjs}` (skip `__tests__`).
- **Runway** → `check-postings.mjs`, `env-check.mjs`, `find-board.mjs`,
  `parse-job.mjs`, `parse-resume.mjs`, `scan-boards.mjs`, `scan-cron.mjs`,
  `tailor.mjs`, `whoami.mjs`, and `lib/*`.

**The `claude.js` decision.** ZTS's proxy is *open*; Clarify's *requires a valid
session bearer* (`requireAuth`) so a stranger can't spend the Anthropic budget.
Unify on **Clarify's auth'd proxy** and make ZTS send the bearer — its three call
sites (`apps/zts/src/App.jsx` `callClaude`, `apps/zts/src/dna/dnaWorker.js`,
`apps/zts/src/dna/DnaView.jsx`) each build the deployed request with only
`Content-Type`; add `Authorization: Bearer <supabase access_token>`. All three
tools live on the one clarify project, so the same token validates everywhere.
(Interim fallback if we want zero caller edits: ship ZTS's open proxy and treat
locking it down as a fast follow — but that regresses Clarify's protection, so
prefer the auth'd path.)

**`netlify.toml` redirects to fold in** (specific first, SPA fallback last):
- `/r/*` → `/.netlify/functions/track-click/:splat` (Clarify tracked links)
- `/px/*` → `/.netlify/functions/track-open/:splat` (Clarify open pixel)
- `/api/*` → `/.netlify/functions/:splat` (Runway convenience)
- Scheduled function: `[functions."scan-cron"] schedule = "0 12 * * 1-5"`
- `[functions] node_bundler = "esbuild"` (Runway ships `.mjs`)
- Keep the SPA catch-all `/* → /index.html` **last**.

## 2. Supabase — expose the runway schema (your ~30s step)

In the **clarify** project → **Settings → API → Exposed schemas**: add `runway`
(confirm `zts` and `public` are already there). Without this, Runway's REST calls
404 even though the schema exists.

## 3. Env vars (Netlify)

**Client — build-time, safe to expose** (RLS protects data, not key secrecy):
| var | value |
|---|---|
| `VITE_SUPABASE_URL` | `https://nrzpinvyxxorxufadvyc.supabase.co` (clarify) |
| `VITE_SUPABASE_ANON_KEY` | clarify anon / publishable key |

**Server — Netlify env, NEVER prefixed `VITE_`:**
| var | used by |
|---|---|
| `ANTHROPIC_API_KEY` | claude proxy, Runway `tailor` |
| `ANTHROPIC_MODEL` | optional model override |
| `SUPABASE_URL` | clarify URL (server-side) |
| `SUPABASE_ANON_KEY` | clarify anon |
| `SUPABASE_SERVICE_ROLE_KEY` | clarify service role — Runway scans, Clarify writes, `scan-cron` |
| `ALLOWED_EMAIL` | `cam.carp14@gmail.com` — the function-side operator gate |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` | Clarify send/read email |

`COMMIT_REF` / `CONTEXT` are injected by Netlify automatically.

**On `ALLOWED_EMAIL`.** Every operator function now pins to it, not just
Runway's: `_shared/requireAuth.cjs` (claude proxy, send-email, read-emails,
check-replies, prospect-proxy, shopify-publish, queue-execute) and
`netlify/shared/util.mjs` (Macro's journal / position / settings) both compare
the verified session's email against it and answer 403 on a mismatch. Verifying
a token only proves the caller signed in *somewhere on the project* — these
handlers send mail as Cameron, spend the API budget and rewrite the trade
journal, so a second account on the project would otherwise inherit all of it.

It is enforced **only when set**, so a half-configured deploy keeps working
rather than locking its own operator out of every tool at once. Leaving it unset
is not a supported configuration — `/.netlify/functions/env-check` reports it as
missing, and until it is set any signed-in account passes these gates.

## 4. Deploy

Netlify builds with `npm install && npm run build` (root delegates to
`apps/shell`) and publishes `apps/shell/dist`. Connect the repo, set the env vars
above, deploy. Then log in and verify: the toggle switches ZTS ↔ Clarify ↔
Runway, theming flips light↔dark, and each tool's data loads.

## 5. Cut over the old sites, then clean up

- Point the old per-app Netlify sites at the new domain (redirects) so existing
  links/bookmarks survive.
- Once Runway is confirmed working on clarify, **then** drop the board-room
  `runway` schema (the final, only-after-verified step).

### The naming → "The Pentagon"

The whole bucket is branded **The Pentagon** — the app UI, README, and this
runbook all say it. The npm package name (`command-center`) is internal and left
as-is. Two external names still carry legacy prefixes; renaming them is optional
and cosmetic:

- **Netlify site** — ✅ renamed to `the-pentagon`; the site now serves at
  **the-pentagon.netlify.app**. (The plain `command-center` and `the-command-center`
  subdomains were both already taken globally.) The old
  `zts-command-center.netlify.app` subdomain is freed — update bookmarks. To
  change it again: Netlify UI (Site configuration → Change site name) or MCP
  `update-project-name`.
- **Supabase project** — optionally rename `clarify-outreach` → `the-pentagon`
  in the Supabase dashboard (Project Settings → General → Project name). Cosmetic
  only; the project ref / connection URLs are unchanged, so nothing in the app
  breaks.
- **GitHub repo** — ✅ renamed `zts-command-center` → `the-pentagon`
  (Settings → Repository name). Lossless; GitHub auto-redirects the old URL and
  existing clones keep working until they re-point their remote. Note that a
  session/tool scoped to the old name has to be re-pointed at the new one before
  it can push, and Netlify's repo link should be confirmed to still trigger
  builds after any rename.

## Known follow-ups (non-blocking)
- Lock down the claude proxy (auth'd path above) if shipping the interim open one.
- Optional: unify each tool's ⌘K into a single cross-app palette (today each
  tool owns its own; the shell switches via the toggle + ⌥1/2/3).
