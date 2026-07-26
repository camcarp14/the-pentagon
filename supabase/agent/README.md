# AI Business — the agent project (runbook)

This is the operating manual for the Supabase project behind the **AI Business**
tab. It is written to be followed at 7am on a phone-sized problem, so every
section is: do this → expect this → if not, this.

Two files live here:

| file | what it is |
|---|---|
| `../../schema.sql` | the whole agent project — tables, RLS, grants, realtime, seed. Paste it in once. |
| `fixtures.sql` | TEST DATA that seeds every scenario the tab is checked against. Never run it on a real agent project. |

---

## This deployment

The project exists and the schema is installed. Sections 1 and 3 below are the
general instructions; this is what was actually done.

| | |
|---|---|
| agent project | `business-agent` — ref `qufvlvtoffrgifdkpypg`, us-east-2, Postgres 17 |
| API URL | `https://qufvlvtoffrgifdkpypg.supabase.co` |
| Pentagon project (for contrast) | ref `nrzpinvyxxorxufadvyc` — **different project, which is the point** |
| schema | applied as migration `agent_business_schema`; 9 tables, 11 policies, RLS on all 9 |
| Netlify vars | `VITE_AGENT_SUPABASE_URL` + `VITE_AGENT_SUPABASE_ANON_KEY` set on the-pentagon, all contexts |

Verified in the database itself immediately after applying, rather than assumed
— `anon` has no USAGE on the schema at all, `authenticated` can update exactly
`halted` / `goal` / `decision` and is refused on `autonomy_tier`,
`heartbeat_at`, `veto_until` and every ledger, and `service_role` can still
write (without which the agent would go quiet behind a healthy-looking empty
feed). The config row ships `halted = true`.

**The one step left is yours:** section 2 — create the single user and turn
signups off. There are zero users in the project right now, so the tab will
show its sign-in form and nothing else until you do. That is the correct
behaviour, not a fault.

The anon key is deliberately not reproduced here. It is public by design (RLS
and column grants are what protect the data, not key secrecy) but this repo is
public, and a key pasted into a README is a key nobody remembers to rotate.
Read it from **Project Settings → API Keys**, or from
`/.netlify/functions/env-check`, which reports its *classification* without
ever emitting the key itself.

---

## 0. Why the agent gets its OWN Supabase project

The agent's database holds spend and strategy. The Pentagon's holds Clarify's
leads, ZTS's store truth, Runway's applications. **They are separate projects so
that a compromise of one reaches the other's data not at all.** That isolation is
not a preference — it is the entire security story of this tab, and everything
else here (a second sign-in, a second client, a second set of env vars) is the
price of keeping it.

The tab enforces it rather than trusting it. `checkAgentEnv()` in
`apps/business/src/lib/env.js` compares the **host** of `VITE_AGENT_SUPABASE_URL`
against the host of `VITE_SUPABASE_URL`. If they match:

- `envCheck.ok` is `false`,
- `agentSb` is `null` — **no client is constructed at all**, not a degraded one,
- `BusinessRoot` renders the "This tab is not safe to run" screen and stops.

**What breaks if you point it at the Pentagon's project anyway:**

1. **The tab refuses to boot.** That is the designed outcome and the cheap one.
2. If you *also* run `schema.sql` there to make the error go away, you have
   handed every Pentagon-authenticated session read access to spend, strategy and
   the approvals queue — because the RLS policies are `to authenticated using
   (true)`, and over there "authenticated" means every Clarify/ZTS/Runway user
   and every function holding the Pentagon's service key.
3. Worse, and the reason this is a stop-the-world mistake rather than a tidy-up:
   `schema.sql` ends with

   ```sql
   revoke usage on schema public from anon;
   revoke usage on schema public from public;
   revoke all on all tables in schema public from authenticated;
   ```

   Run against the Pentagon's project that strips `anon` and `authenticated` of
   their reach across the *whole* `public` schema and takes Clarify, ZTS, Runway
   and Macro down with it. `schema.sql` is safe only on an empty project it owns.

There is a smaller, quieter reason too: two supabase-js clients in one page share
one `localStorage`. The agent client sets `storageKey: "agent-sb-auth"`
(`agentClient.js`) precisely so the second client to initialise does not evict the
first. Without the separate project there is no second client, and without the
second client there is nothing keeping the two sessions apart.

---

## 1. Create the project and install the schema (~5 min)

1. Supabase dashboard → **New project**. Give it a name that cannot be confused
   with `clarify-outreach` / `the-pentagon` — you will be reading these two
   hostnames against each other for the rest of this runbook.
2. **SQL Editor** → paste the entire contents of `schema.sql` → **Run**.
   It is idempotent (`create table if not exists`, `drop policy if exists`,
   `on conflict do nothing`); running it a second time is a no-op and is the
   correct way to re-apply it after an edit.
3. Confirm it shipped **halted**. Deploying a schema must never be the thing that
   starts an autonomous business:

   ```sql
   select halted, halt_reason, autonomy_tier, heartbeat_at from public.agent_config;
   -- expect: true | 'Never started — halted on install' | 1 | null
   ```

4. Confirm the grants landed the way the file intends:

   ```sql
   select table_name, column_name
   from information_schema.column_privileges
   where table_schema = 'public'
     and grantee = 'authenticated'
     and privilege_type = 'UPDATE'      -- without this filter you get all 90 SELECT grants too
   order by table_name, column_name;
   -- expect UPDATE on exactly nine columns — 9 rows, no more, no fewer:
   --   agent_config: halted, halt_reason, halted_at, halted_by, goal, updated_at
   --   approvals:    decision, decided_at, decided_by
   -- (six on the config row and three on approvals. The halt path writes
   --  updated_at itself, which is why it is in the grant. autonomy_tier,
   --  heartbeat_at and veto_until must NOT appear anywhere in this result.)
   ```

   If `autonomy_tier` or `veto_until` shows up here, stop — section 4 will fail
   and the tab's read-only promise is not being kept.

## 2. Create the ONE user, then turn signups OFF (your ~60s step)

Order matters. Create the user first; disabling signups first means re-enabling
it, which is a state you do not want to leave a project in by accident.

1. **Authentication → Users → Add user → Create new user.** Enter the operator
   email and a password. Tick **Auto Confirm User** — an unconfirmed user cannot
   sign in, and the failure reads as a wrong password.
2. **Authentication → Providers → Email → "Allow new users to sign up" → OFF.**
   (Newer dashboards file this under **Authentication → Sign In / Providers →
   Email**. Same toggle.) Save.
3. Prove it took: sign out, and try to sign up through the API.

   ```bash
   curl -s -X POST "$AGENT_URL/auth/v1/signup" \
     -H "apikey: $AGENT_KEY" -H "Content-Type: application/json" \
     -d '{"email":"nope@example.com","password":"correct-horse-battery"}'
   # expect: {"code":422,"error_code":"signup_disabled","msg":"Signups not allowed for this instance"}
   ```

**Why this is load-bearing.** Every read policy in `schema.sql` is
`for select to authenticated using (true)`. There is no per-user filtering. The
single-user rule is the *only* thing making "authenticated" and "the operator"
the same set of people. If a second account could ever exist, go and tighten
every policy — including the two `for update` ones — to the email predicate
already written out in `schema.sql`:

```sql
using ((auth.jwt() ->> 'email') = 'you@example.com')
```

### Auth is mandatory and fails closed

Two independent mechanisms, and you should know both because they fail
differently:

- **In the app** (`Root.jsx`): no session ⇒ no tree. The `AgentDataProvider`
  lives inside `<App/>`, so with no session it is never constructed and cannot
  issue a query. Not a skeleton, not a greyed-out layout — a signed-out visitor
  does not even learn that this tab has an approvals queue. And the session is
  re-validated with `auth.getUser()` (a round trip), not just read out of
  `localStorage`, so a revoked token fails closed instead of cosmetically.
- **In the database**: a signed-out browser is the `anon` role, and `anon` has no
  `USAGE` on schema `public` at all. It cannot resolve a table name, let alone
  read one. Check it yourself, signed out:

  ```bash
  curl -s -i "$AGENT_URL/rest/v1/action_ledger?select=id&limit=1" -H "apikey: $AGENT_KEY"
  ```

  **Correct result:** a 4xx whose body carries `"code":"42501"` and a message
  naming the **schema** — `permission denied for schema public`. The message
  naming the schema rather than the table is the observable proof that the table
  name was never resolved. A `200 []` here means the revokes did not apply;
  re-run `schema.sql`.

---

## 3. Env vars — locally, then in Netlify

Two vars, both client-side, both public by design (RLS and the column grants
protect the data; key secrecy does not).

| var | value |
|---|---|
| `VITE_AGENT_SUPABASE_URL` | `https://<agent-ref>.supabase.co` — **not** the Pentagon's |
| `VITE_AGENT_SUPABASE_ANON_KEY` | the agent project's **anon / publishable** key |

**Locally:** they go in the repo-root `.env` (see `.env.example`). Vite's
`envDir` is pinned to the repo root in `apps/shell/vite.config.js` even though
the build root is `apps/shell` — if you put them in `apps/shell/.env` they will
load as `undefined` and the tab will show the misconfiguration screen.

**In Netlify:** Site configuration → Environment variables. Then **redeploy**.
`VITE_` vars are baked into the bundle at build time, so saving them changes
nothing about the site that is currently live. This is the single most common
version of "I set it and it still says not configured" — the fix is a deploy,
and if you have any doubt, *Clear cache and deploy site*.

### Confirm what the deploy actually has

```bash
curl -s https://the-pentagon.netlify.app/.netlify/functions/env-check | jq
```

Read these four fields and nothing else:

| field | required value | what a wrong value means |
|---|---|---|
| `agent_key_kind` | `"anon"` or `"publishable"` | anything else is a refusal. `"service_role"` / `"secret"` means a key that bypasses RLS is compiled into the public bundle — rotate it in Supabase, then fix the var. `"unknown"` means an unrecognised shape; the tab fails closed on it deliberately. `"missing"` means it is not set in this context. |
| `agent_anon_slot_holds_secret` | `false` | `true` is the same emergency as above, stated as a boolean. |
| `agent_project_is_separate` | `true` | `false` means the two hosts match or one is unset. Either way the isolation guarantee is not being kept and the tab will not boot. |
| `agent_supabase_url_host` | the agent's host | eyeball it against `supabase_url_host` in the same response. They must differ. |

Also check `missing: []` contains neither `VITE_AGENT_*` name, and that `commit`
matches the deploy you think you are looking at.

`env-check` reads the **function runtime's** environment. If it reports the right
values but the browser still shows the misconfiguration screen, the vars were set
after the last build: redeploy.

---

## 4. Verify the three-verb guarantee yourself

Three verbs reach this database from a browser and only three:

1. **halt / resume** → `agent_config.halted`, `.halt_reason`, `.halted_at`, `.halted_by`
2. **approve / veto** → `approvals.decision`, `.decided_at`, `.decided_by`
3. **edit the goal** → `agent_config.goal`

Everything else is read-only, enforced by **column-level `GRANT`** — not by RLS
(which is row-level and cannot restrict columns) and **not by a disabled button**.

**A disabled button proves nothing.** The tab does disable controls — `isDecidable()`
greys out a lapsed approval, the halt button goes busy mid-write — but that is the
UI agreeing with the database, not the enforcement. Anyone with the tab open has
the anon key (it is in the bundle) and a valid session; they can issue any request
they like. The only question that matters is what **Postgres** does with it. So
go and ask Postgres.

### Set up the console

`schema.sql`'s header shows the check as `agentSb.from('action_ledger').insert(...)`.
That works in a dev build where the module is in scope; in the deployed bundle
`agentSb` is not a global. This version works anywhere.

Open the AI Business tab, **sign in**, then paste this once into the browser
console:

```js
const AGENT_URL = "https://<agent-ref>.supabase.co";   // VITE_AGENT_SUPABASE_URL
const AGENT_KEY = "sb_publishable_…";                  // VITE_AGENT_SUPABASE_ANON_KEY

const TOKEN = (() => {
  const raw = localStorage.getItem("agent-sb-auth");   // storageKey from agentClient.js
  const p = raw ? JSON.parse(raw) : null;
  return p?.access_token || p?.currentSession?.access_token || null;
})();
if (!TOKEN) throw new Error("No agent session in this tab — sign in to AI Business first.");

const probe = async (label, path, init = {}) => {
  const res = await fetch(`${AGENT_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: AGENT_KEY,
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const body = await res.text();
  console.log(`${label} → HTTP ${res.status}`, body);
  return { status: res.status, body };
};
```

### Probe 0 — the control (run this FIRST)

A probe that fails because your token expired, your URL has a typo, or you are
offline looks exactly like a probe that failed because the grant is right. So
establish that the harness works before you trust a refusal.

```js
await probe("CONTROL read agent_config", "agent_config?id=eq.singleton&select=id,halted,goal");
```

**PASS:** `HTTP 200` and a one-element array with the config row in it.
**If this is not a 200, stop.** Nothing below means anything yet — fix the URL,
the key, or the session first.

### Probe 1 — insert into `action_ledger` must be refused

```js
await probe("INSERT action_ledger", "action_ledger", {
  method: "POST",
  body: JSON.stringify({ tick_type: "execute", action: "written from the browser console" }),
});
```

**PASS:** a 4xx (401 or 403 — the mapping has changed across PostgREST versions,
so read the *body*, not the status) carrying:

```json
{"code":"42501","details":null,"hint":null,"message":"permission denied for table action_ledger"}
```

`42501` is Postgres's permission-denied. The ledger is append-only *by the agent*;
the browser has no INSERT anywhere in this schema.

**FAIL:** any `201`, or a `200` echoing back a row. If that happens the browser
can forge history — the ledger stops being evidence. Re-run `schema.sql` and
re-check the grants query in section 1.

### Probe 2 — `agent_config.autonomy_tier` must not take

Autonomy tier is how freely the agent may spend. It is deliberately **not** in the
grant list, so the console cannot promote itself from "propose only" to "act
freely in budget".

```js
await probe("READ tier (before)", "agent_config?id=eq.singleton&select=autonomy_tier");
await probe("PATCH autonomy_tier", "agent_config?id=eq.singleton", {
  method: "PATCH",
  body: JSON.stringify({ autonomy_tier: 3 }),
});
await probe("READ tier (after)", "agent_config?id=eq.singleton&select=autonomy_tier");
```

**PASS:** the PATCH returns `42501`. On Postgres 16 (what Supabase runs) the
message is `permission denied for table agent_config` — it names the **table**
even though it is the missing *column* grant doing the work, which is confusing
the first time you see it and is the expected wording. And the *after* read shows
the **same tier as the before read**.

**Read both, not just the status.** A `200 []` — a valid request that changed zero
rows — is *not* a pass on this probe. It would mean the column grant is fine but
something else swallowed the write, and you have learned nothing about the grant.
The pass condition is: refused with 42501 **and** the value is unchanged.

**FAIL:** `200` with `[{"autonomy_tier":3}]`. Put the tier back by hand
(`update public.agent_config set autonomy_tier = 1 where id = 'singleton';`) and
fix the grant before this build goes anywhere.

### Probe 3 — `approvals.veto_until` must not take

Extending your own deadline from the client turns a deadline into a suggestion.
Pick any pending approval's id (from `fixtures.sql`, or the tab's own list):

```js
const APPROVAL_ID = "f1c70001-0000-4000-8000-000000000004";  // fixtures: pending, 6h out

await probe("READ veto_until (before)", `approvals?id=eq.${APPROVAL_ID}&select=veto_until,decision`);
await probe("PATCH veto_until", `approvals?id=eq.${APPROVAL_ID}`, {
  method: "PATCH",
  body: JSON.stringify({ veto_until: new Date(Date.now() + 86400000).toISOString() }),
});
await probe("READ veto_until (after)", `approvals?id=eq.${APPROVAL_ID}&select=veto_until,decision`);
```

**PASS:** `42501` on the PATCH, and the before/after `veto_until` are identical.

**FAIL:** a `200` echoing tomorrow's timestamp. That is the browser granting
itself another day to think about something the agent is about to do.

Unlike probe 2, this one cannot give you a false pass: column privileges are
checked when the statement starts executing, *before* any row is looked at, so a
`veto_until` write is refused with 42501 even when the `where` clause matches
nothing at all. Any id you use here gives a real answer. (Row id
`…0001` also works, but it is the 90-second approval and will have lapsed by the
time you get to it — use `…0004`, which stays pending for six hours.)

While you are here, the counterpart worth understanding — because it is a `200`
that is *correct*:

```js
// an approval whose veto_until is already in the past
await probe("PATCH decision on a lapsed row", `approvals?id=eq.f1c70001-0000-4000-8000-000000000002`, {
  method: "PATCH",
  body: JSON.stringify({ decision: "vetoed", decided_at: new Date().toISOString(), decided_by: "operator" }),
});
```

**PASS:** `HTTP 200` with an **empty array**. `decision` *is* in the grant, so
there is no 42501 here — the RLS policy's `using (decision = 'pending' and
veto_until > now())` simply matches no rows. The agent already proceeded on the
default, and rewriting the row afterwards would make history claim a human
approved something they never saw. `decide.js` treats this exact `200 []` as a
failure and tells you so; that is why the tab never says "saved" in this case.

---

## 5. Fault injection — checking that the tab reports failure honestly

Three query params, opt-in per page load, declared in `agentClient.js`. They only
ever make things **worse** — nothing here can mask a real failure — and each one
paints a loud amber banner across the top, so a screenshot taken with a fault on
can never be mistaken for real state.

**The passing outcome is that the page looks broken.** You are not checking that
it still renders nicely. You are checking that it refuses to render a calm zero
over an outage, which is the failure this whole tab exists to prevent.

### `?fault=db` — every shared read fails

**CORRECT:**
- Amber banner: `FAULT INJECTION ACTIVE (?fault=db)`.
- Every panel in the stack shows the ERROR chrome: *"Can't reach the agent
  database"*, plus *"Last successful read Nm ago. Anything below is from then, not
  now."* Panels that already had rows **keep showing them, labelled stale** — they
  do not blank out. An outage that empties the screen looks like an agent with
  nothing to do.
- Both above-the-fold tiles read **`—`**, not `0`, with "can't reach the database"
  underneath.
- **The status block at the top keeps working.** `useConfirmedConfig` reads
  through `halt.js`, which has its own fetch and is not touched by the injected
  fault. Seeing `RUNNING` / `HALTED` here while everything below is red is
  correct, and it is the arrangement that keeps the halt button alive during a
  real outage.

**WRONG (a bug — stop and fix it):** any panel showing `0`, any tile showing a
number, any panel showing the dashed "genuinely holds nothing" empty frame. EMPTY
and ERROR are the pair this tab exists to keep apart.

### `?fault=loader` — the shared loader throws

`<LoaderFault/>` is mounted inside every error boundary **except** the halt
control. The point of the arrangement is what survives.

**CORRECT:**
- The summary-tiles region and the entire panel stack render as crash blocks.
- The status + HALT block above them renders normally — it sits outside every
  boundary and reads over `halt.js`, which imports nothing.
- **Now actually press HALT.** It must go `Halting…` → the status must flip to a
  red `HALTED` sourced from the row the server handed back. Then press **Resume**
  and confirm; it must go back to `RUNNING`. That round trip, with the whole data
  layer on fire, is the check. Anything less is looking at a button and assuming.

**WRONG:** a blank white page (a boundary is missing), or a halt button that is
absent, inert, or reports success without the status changing.

### `?fault=stale` — rows arrive back-dated 3h

Every row's timestamp column is shifted back three hours as it arrives, so the
staleness path can be seen without waiting three hours for it.

**CORRECT:** panels alarm **according to their own window**, which means they do
not all alarm — and that is the point, not a miss:

| panel | window | at −3h |
|---|---|---|
| Action ledger | 45 min | **STALE** — "newest is 3h old" |
| Invariants | 45 min | **STALE**, and checks flip to *not reporting* (amber) rather than *failing* (red) |
| Metrics | 6h | calm. 3h is inside its window. **Correct.** |
| Approvals / Spend | 24h | calm. **Correct.** |
| Learnings | 7d | calm. **Correct.** |
| Budget | 45d | calm. **Correct.** |
| Hypotheses | 24h | calm. **Correct.** |

Also correct: the top status block still says `RUNNING`, because the heartbeat is
read over `halt.js` and never passes through the fault. `?fault=stale` is a
rendering trick on the shared read layer — to exercise a genuinely stale heartbeat
you back-date the row in SQL (see the scenario switch at the bottom of
`fixtures.sql`).

**WRONG:** a panel calling itself *Live* with a 3h-old newest row, or a panel
alarming outside its declared window (that means its `maxAgeMin` in `tables.js`
and its rendering disagree).

---

## 6. When the status says RUNNING but the heartbeat is stale

`RUNNING · NO HEARTBEAT` — red, pulsing, at the top of the page. It means
`agent_config.halted = false` and `heartbeat_at` is older than 45 minutes.
Nothing has failed loudly. Nothing has thrown. **This is the state the entire tab
exists to surface**, because every naive dashboard renders it as a calm green
"running".

Work it in this order.

**1. Believe the reading.** It came over `halt.js`'s own connection, not the
shared data layer, so it is not a cached panel — the only way it can be wrong is
if the database is unreachable, and that shows as `UNKNOWN` instead.

**2. Rule out yourself.** Reload with **no `?fault=` in the URL**. Then read the
heartbeat age twice, a minute apart. It must be *growing*. If it snapped back to
seconds, the agent is alive and you caught it between ticks (the default
`tick_seconds` is 900, so a 45-minute window is three missed ticks, not one).

**3. Cross-check the action ledger.** This is the fork:

- **Ledger also stale or empty** → nothing is writing. The agent process is dead,
  wedged, or its host is down. Go to step 4.
- **Ledger fresh, heartbeat stale** → the tick loop is running but the heartbeat
  write is failing. That is usually the agent's own credentials: `heartbeat_at` is
  written with the service role, and `schema.sql`'s `grant all ... to service_role`
  block is the thing that makes that possible. Check the newest `action_ledger`
  rows with `outcome = 'failure'` and read their `error` text — the failing write
  usually names itself there. Also open **Invariants** and look for a failing
  critical check.

**4. Decide whether to halt — and lean towards halting.** A silent agent that is
actually alive keeps spending; a halted agent costs you a Resume tap. If you
cannot tell which of the two you are looking at inside a minute, **halt**. The
proof is the red `HALTED` state, which only paints once the database has handed
back a row saying so. If the write fails you get "The halt did NOT take effect"
in full, not a toast — read it, and try again.

**5. Read what happened while it was quiet.** In order:

- **Approvals → "went ahead without you"** — a pending row whose `veto_until` has
  passed. Nothing marks that transition in the database; the row just ages. These
  are actions taken with no human in the loop, and they are the highest-value
  thing on the screen right now.
- **Budget** — a wedged retry loop can burn inference budget without ever writing
  a heartbeat. Check the total against its cap and the pace projection.
- **Invariants → not reporting** vs **failing**. Amber "not reporting" means the
  watcher stopped, so every green line below it is a claim about the past wearing
  the present tense. Red "failing" means it ran and said no. They need different
  fixes.

**6. Then go to the agent's host and logs.** The tab's job ends at *"it is not
reporting"*. It has no idea why, and it will not pretend to.

**Two things not to do:**

- **Do not try to "fix the display" by touching `heartbeat_at`.** You cannot from
  the browser — it is deliberately outside the grant, because a console that can
  forge a heartbeat can hide exactly this outage. From the SQL editor you *can*,
  and it would be falsifying the one number on this page that is load-bearing.
- **Do not resume until the heartbeat is moving again.** Resume asks for
  confirmation on purpose; halting is one tap because it is the safe direction and
  resuming is not.

---

## 7. Test fixtures

`fixtures.sql` seeds every scenario above — an approval expiring in 90 seconds,
one that lapsed yesterday, a failing critical invariant, a check that stopped
reporting, a category over its cap, a category with no cap at all, a metrics
series with a hole in it.

- Run it from the **SQL editor**, never from the browser. (The browser could not
  insert a single row of it — that is section 4's whole point.)
- It is idempotent and re-anchors every timestamp to `now()`, so **re-run it to
  re-arm the 90-second approval** rather than editing rows by hand.
- It ends with a commented-out cleanup block that removes exactly what it
  inserted, and a commented-out scenario switch that back-dates the ledger and the
  heartbeat so you can see the real stale path rather than `?fault=stale`'s
  simulation of it.
- The "went ahead without you" callout is filtered against a `localStorage`
  timestamp. If you do not see it, clear the stamp and reload:

  ```js
  localStorage.removeItem("agent_business_last_visit");
  ```

  (It is client-side on purpose: writing an `acknowledged_at` column would be a
  fourth verb from the browser, and there are three.)
