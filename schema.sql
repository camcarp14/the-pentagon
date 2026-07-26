-- ═══════════════════════════════════════════════════════════════════════════
-- THE AGENT PROJECT — schema, RLS, and grants.
--
-- ⚠ AUTHORED, NOT TRANSCRIBED. The build prompt said "read schema.sql in this
--   repo"; there was no such file, and no table in this list appeared anywhere
--   in the tree. This is a faithful reconstruction from what the AI Business
--   tab has to render, not a copy of the live agent project. If the real
--   project differs: table names, orderings, limits and freshness windows all
--   live in `apps/business/src/lib/tables.js` and can be changed there. COLUMN
--   names cannot — there are ~51 hard-coded references spread across 14 files
--   in `apps/business/src`, so a rename means a grep. This comment used to
--   promise the single-file version; it was wrong, and acting on it would have
--   shipped a half-finished rename.
--
-- This runs against the AGENT's Supabase project, which is deliberately NOT
-- the Pentagon's. The isolation is the point: a compromise of the agent
-- reaches spend and strategy, and nothing else. Paste this whole file into
-- that project's SQL editor (see supabase/agent/README.md for the runbook).
--
-- ── The safety model, stated once ──────────────────────────────────────────
-- Three verbs reach this database from a browser, and only three:
--     1. halt / resume        → agent_config.halted, .halt_reason, .halted_at
--     2. approve / veto       → approvals.decision, .decided_at, .decided_by
--     3. edit the goal        → agent_config.goal
-- Everything else is read-only. That is enforced by column-level GRANT, not by
-- a disabled button and not by an RLS policy — RLS is ROW-level and cannot
-- restrict columns, so `for update using(true)` on a table the console can
-- update at all would let the browser rewrite every column in the row. This
-- repo learned that the expensive way; see supabase/migrations/0002.
--
-- The agent itself connects with the service role, bypasses all of this, and
-- is the only writer of the ledgers.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

-- ───────────────────────────────────────────────────────────────────────────
-- 1. agent_config — one row. The control surface.
-- ───────────────────────────────────────────────────────────────────────────
-- Singleton enforced by a check constraint on the primary key rather than by
-- convention: the halt button targets `id = 'singleton'` over a raw PATCH with
-- no client-side row lookup, so a second row would make halting ambiguous at
-- the exact moment ambiguity is least affordable.
create table if not exists public.agent_config (
  id              text primary key default 'singleton' check (id = 'singleton'),

  -- The kill switch. `halted` is the only thing the halt button touches.
  halted          boolean     not null default false,
  halt_reason     text,
  halted_at       timestamptz,
  halted_by       text,                    -- 'operator' | 'watchdog' | 'invariant:<name>'

  -- What the agent is trying to do, in the operator's words. Editable.
  goal            text        not null default '',

  -- 1 = propose only, 2 = act with a veto window, 3 = act freely within budget.
  autonomy_tier   smallint    not null default 1 check (autonomy_tier between 1 and 3),

  -- Written by the agent every tick. The status bar's "last heartbeat age" is
  -- now() - heartbeat_at, and it is the single most load-bearing number on the
  -- page: a stale heartbeat with everything else calm is exactly the failure
  -- the tab exists to catch.
  heartbeat_at    timestamptz,
  tick_seconds    integer     not null default 900 check (tick_seconds > 0),

  updated_at      timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. budget — the caps. One row per (period, category).
-- ───────────────────────────────────────────────────────────────────────────
-- Caps live apart from spend so that "what am I allowed" survives a truncated
-- ledger, and so the pace projection has a denominator even when nothing has
-- been spent yet. Category 'total' is the umbrella cap; the panel treats it as
-- the headline and every other row as a breakdown.
create table if not exists public.budget (
  id            uuid primary key default gen_random_uuid(),
  period_start  date        not null,
  period_end    date        not null,
  category      text        not null,
  cap_usd       numeric(12,2) not null check (cap_usd >= 0),
  -- true  → breaching this cap halts the agent
  -- false → breaching it only files an approval
  hard_stop     boolean     not null default false,
  created_at    timestamptz not null default now(),
  constraint budget_period_valid check (period_end >= period_start),
  constraint budget_one_cap_per_category unique (period_start, category)
);
create index if not exists budget_period_idx on public.budget (period_start desc);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. spend_ledger — every dollar, append-only.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.spend_ledger (
  id          uuid primary key default gen_random_uuid(),
  spent_at    timestamptz not null default now(),
  category    text        not null,
  amount_usd  numeric(12,4) not null,
  vendor      text,
  memo        text,
  action_id   uuid                      -- the action_ledger row that caused it
);
create index if not exists spend_ledger_spent_at_idx on public.spend_ledger (spent_at desc);
create index if not exists spend_ledger_category_idx on public.spend_ledger (category, spent_at desc);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. action_ledger — what it actually did, append-only. Realtime.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.action_ledger (
  id            uuid primary key default gen_random_uuid(),
  occurred_at   timestamptz not null default now(),
  tick_type     text        not null,   -- 'heartbeat' | 'plan' | 'execute' | 'observe' | 'reflect'
  action        text        not null,   -- human-readable, one line
  outcome       text        not null default 'success'
                check (outcome in ('success','failure','blocked','skipped','dry_run')),
  detail        jsonb       not null default '{}'::jsonb,
  cost_usd      numeric(12,4) not null default 0,
  duration_ms   integer,
  error         text,
  hypothesis_id uuid
);
create index if not exists action_ledger_occurred_at_idx on public.action_ledger (occurred_at desc);
create index if not exists action_ledger_tick_type_idx on public.action_ledger (tick_type, occurred_at desc);
create index if not exists action_ledger_outcome_idx on public.action_ledger (outcome, occurred_at desc);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. hypothesis_queue — what it wants to try next, ranked.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.hypothesis_queue (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  title          text        not null,
  rationale      text,
  score          numeric(6,3) not null default 0,
  tier           smallint    not null default 1 check (tier between 1 and 3),
  status         text        not null default 'queued'
                 check (status in ('queued','running','done','rejected','blocked')),
  expected_lift  text,
  effort_hours   numeric(6,2),
  blocked_reason text
);
create index if not exists hypothesis_queue_rank_idx on public.hypothesis_queue (status, score desc, created_at desc);

-- ───────────────────────────────────────────────────────────────────────────
-- 6. learnings — what it now believes, and how strongly.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.learnings (
  id               uuid primary key default gen_random_uuid(),
  learned_at       timestamptz not null default now(),
  statement        text        not null,
  detail           text,
  confidence       numeric(4,3) not null default 0.5 check (confidence between 0 and 1),
  source           text,                       -- 'experiment' | 'observation' | 'external'
  tags             text[]      not null default '{}',
  source_action_id uuid
);
create index if not exists learnings_learned_at_idx on public.learnings (learned_at desc);

-- ───────────────────────────────────────────────────────────────────────────
-- 7. metrics_snapshot — the objective function over time.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.metrics_snapshot (
  id           uuid primary key default gen_random_uuid(),
  captured_at  timestamptz not null default now(),
  objective    numeric(14,4) not null,   -- the one number it is optimising
  mrr_usd      numeric(12,2),
  customers    integer,
  trials       integer,
  conversion   numeric(6,4),
  metrics      jsonb not null default '{}'::jsonb
);
create index if not exists metrics_snapshot_captured_at_idx on public.metrics_snapshot (captured_at desc);

-- ───────────────────────────────────────────────────────────────────────────
-- 8. invariant_checks — the watchdog's own record.
-- ───────────────────────────────────────────────────────────────────────────
-- A canary that stops REPORTING is indistinguishable from a canary that is
-- fine, unless you look at the age of its newest row. That is why every panel
-- in the tab renders its own data age, and why this table is queried for
-- "newest row" as hard as it is queried for "passed = false".
create table if not exists public.invariant_checks (
  id          uuid primary key default gen_random_uuid(),
  checked_at  timestamptz not null default now(),
  name        text        not null,
  kind        text        not null default 'invariant'
              check (kind in ('canary','watchdog','invariant')),
  passed      boolean     not null,
  severity    text        not null default 'warn'
              check (severity in ('info','warn','critical')),
  detail      text
);
create index if not exists invariant_checks_checked_at_idx on public.invariant_checks (checked_at desc);
create index if not exists invariant_checks_failing_idx on public.invariant_checks (passed, checked_at desc);

-- ───────────────────────────────────────────────────────────────────────────
-- 9. approvals — the veto window. Realtime.
-- ───────────────────────────────────────────────────────────────────────────
-- `veto_until` is a DEADLINE, not a reminder: when it passes with
-- decision = 'pending', the agent proceeds. Nothing in the database marks that
-- transition — the row simply ages — so the panel derives "auto-proceeded
-- without you" as (decision = 'pending' AND veto_until < now()) and gives it
-- its own list. An expiry that merges into normal history is a silent expiry,
-- and silent expiry is the failure mode this table exists to prevent.
create table if not exists public.approvals (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  title         text        not null,
  summary       text,
  kind          text,                       -- 'spend' | 'publish' | 'schema' | 'external'
  risk_tier     smallint    not null default 1 check (risk_tier between 1 and 3),
  cost_usd      numeric(12,4),
  veto_until    timestamptz not null,
  decision      text        not null default 'pending'
                check (decision in ('pending','approved','vetoed')),
  decided_at    timestamptz,
  decided_by    text,
  payload       jsonb       not null default '{}'::jsonb,
  hypothesis_id uuid
);
create index if not exists approvals_pending_idx on public.approvals (decision, veto_until);
create index if not exists approvals_created_at_idx on public.approvals (created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS — on for every table, no exceptions.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.agent_config      enable row level security;
alter table public.budget            enable row level security;
alter table public.spend_ledger      enable row level security;
alter table public.action_ledger     enable row level security;
alter table public.hypothesis_queue  enable row level security;
alter table public.learnings         enable row level security;
alter table public.metrics_snapshot  enable row level security;
alter table public.invariant_checks  enable row level security;
alter table public.approvals         enable row level security;

-- Read: any signed-in user. This project has exactly one user and signups are
-- disabled in the dashboard (Authentication → Providers → "Allow new users to
-- sign up" OFF), so "authenticated" and "the operator" are the same set.
--
-- To pin it harder — worth doing the moment a second account could ever
-- exist — replace `using (true)` with:
--     using ((auth.jwt() ->> 'email') = 'you@example.com')
-- on every policy below, including the two update policies.
do $$
declare t text;
begin
  foreach t in array array[
    'agent_config','budget','spend_ledger','action_ledger',
    'hypothesis_queue','learnings','metrics_snapshot','invariant_checks','approvals'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_read', t
    );
  end loop;
end $$;

-- Write: exactly two tables, and (below) exactly six columns across them.
drop policy if exists agent_config_operator_update on public.agent_config;
create policy agent_config_operator_update on public.agent_config
  for update to authenticated using (true) with check (true);

-- A decision may only be recorded while the veto window is still open and the
-- row is still pending. Once it has lapsed, the agent has already acted on the
-- default — letting the panel flip `decision` afterwards would rewrite history
-- to say a human approved something they never saw.
drop policy if exists approvals_operator_decide on public.approvals;
create policy approvals_operator_decide on public.approvals
  for update to authenticated
  using (decision = 'pending' and veto_until > now())
  with check (decision in ('approved','vetoed'));

-- ═══════════════════════════════════════════════════════════════════════════
-- GRANTS — where "read-only except three verbs" is actually enforced.
--
-- Test it from the browser console with a signed-in session:
--     await agentSb.from('action_ledger').insert({ tick_type:'x', action:'y' })
--     → { code: '42501', message: 'permission denied for table action_ledger' }
-- A disabled button would have let that through.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── The agent itself, first. ────────────────────────────────────────────────
-- THIS BLOCK IS NOT OPTIONAL AND IT GOES FIRST. Everything below revokes, and
-- a file that only revokes is a file that can silently switch the business
-- off. Supabase's project bootstrap grants new tables to service_role through
-- ALTER DEFAULT PRIVILEGES, so on a stock project the agent would keep working
-- by inheritance — but "it works because of a default we did not set and
-- cannot see" is not a guarantee, it is a coincidence. Verified against a bare
-- Postgres 16 with no Supabase defaults: without these lines the agent's own
-- writes fail with 42501 and the ledgers stop, quietly, with the panel showing
-- a perfectly healthy empty feed.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;

-- B5, fail-closed: a signed-out browser is the `anon` role, and it gets
-- nothing at all.
--
-- Note the second line, and why it is not the redundancy it looks like.
-- Postgres grants USAGE on schema public to the PUBLIC pseudo-role by default,
-- and every role inherits it — so `revoke usage ... from anon` on its own is a
-- NO-OP (verified: has_schema_privilege('anon','public','USAGE') stays true).
-- The table-level revoke is what actually stops an anonymous read; revoking
-- from PUBLIC is what makes the schema itself unreachable. Both are here
-- because the first is the real protection and the second is the belt.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
revoke usage on schema public from anon;
revoke usage on schema public from public;
alter default privileges in schema public revoke all on tables from anon;

-- The browser's real role is `authenticated`, not `anon` — mandatory auth (B5)
-- guarantees it. Revoking writes from `anon` alone would have left every
-- ledger writable by the signed-in session, which is every session that can
-- reach the tab at all. So: strip `authenticated` to nothing, then hand back
-- SELECT, then hand back UPDATE on six named columns.
revoke all on all tables in schema public from authenticated;

grant usage on schema public to authenticated;
grant select on
  public.agent_config, public.budget, public.spend_ledger, public.action_ledger,
  public.hypothesis_queue, public.learnings, public.metrics_snapshot,
  public.invariant_checks, public.approvals
to authenticated;

-- Verb 1 (halt/resume) and verb 3 (edit the goal). `updated_at` is included so
-- the row can stamp its own edit; nothing else on this table is reachable —
-- notably NOT autonomy_tier, and NOT heartbeat_at (a console that could
-- forge a heartbeat could hide the exact outage this tab is built to show).
grant update (halted, halt_reason, halted_at, halted_by, goal, updated_at)
  on public.agent_config to authenticated;

-- Verb 2 (approve/veto). Not `veto_until` — extending your own deadline from
-- the client turns a deadline into a suggestion.
grant update (decision, decided_at, decided_by)
  on public.approvals to authenticated;

-- Future tables must not inherit a default write grant.
alter default privileges in schema public revoke all on tables from authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- REALTIME — two tables, deliberately.
-- Nine subscriptions on a phone is nine sockets' worth of battery for data
-- that changes on the scale of hours. The ledger and the approval queue are
-- the two that change while you are looking at them.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'action_ledger'
    ) then
      execute 'alter publication supabase_realtime add table public.action_ledger';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'approvals'
    ) then
      execute 'alter publication supabase_realtime add table public.approvals';
    end if;
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SEED — the singleton config row, and this month's caps.
-- Ships halted. Deploying the schema must never be the thing that starts an
-- autonomous business.
-- ═══════════════════════════════════════════════════════════════════════════
insert into public.agent_config (id, halted, halt_reason, halted_by, goal, autonomy_tier)
values ('singleton', true, 'Never started — halted on install', 'installer', '', 1)
on conflict (id) do nothing;

insert into public.budget (period_start, period_end, category, cap_usd, hard_stop)
values
  (date_trunc('month', now())::date, (date_trunc('month', now()) + interval '1 month - 1 day')::date, 'total',        200.00, true),
  (date_trunc('month', now())::date, (date_trunc('month', now()) + interval '1 month - 1 day')::date, 'inference',    120.00, false),
  (date_trunc('month', now())::date, (date_trunc('month', now()) + interval '1 month - 1 day')::date, 'infrastructure', 40.00, false),
  (date_trunc('month', now())::date, (date_trunc('month', now()) + interval '1 month - 1 day')::date, 'ads',            40.00, false)
on conflict (period_start, category) do nothing;
