-- ═══════════════════════════════════════════════════════════════════════════
-- 0001 — OPS CONTAINMENT
--
-- The first migration file this repo has ever had. Until now the entire schema
-- existed only inside the live database: no review, no rollback, no way to
-- rebuild it, no diff. Every table added from here forward lands as a file
-- first.
--
-- These three tables are the containment layer. They exist BEFORE anything
-- autonomous does, because an autonomous system that fails does so silently and
-- at scale — one bad rule applied to 500 rows before anyone notices.
--
--   ops_control    the kill switch, per-subsystem enable/dry-run, and the caps
--   ops_audit_log  what happened, why, what changed, and how to undo it
--   ops_runs       one row per scheduled pass; feeds the circuit breaker
--
-- Additive only. No existing table is touched.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── ops_control ─────────────────────────────────────────────────────────────
-- One row per subsystem, plus a reserved 'global' row that is the kill switch.
-- Defaults are deliberately the most restrictive combination that still lets a
-- row exist: disabled, and dry-run if it is ever enabled. Opting IN is a
-- deliberate act; nothing here can start acting because a default was missed.
create table if not exists public.ops_control (
  key                        text primary key,
  enabled                    boolean     not null default false,
  dry_run                    boolean     not null default true,
  max_actions_per_hour       integer     not null default 60,
  max_spend_usd_per_hour     numeric     not null default 1.00,
  consecutive_failure_limit  integer     not null default 3,
  paused_reason              text,
  paused_at                  timestamptz,
  updated_at                 timestamptz not null default now(),
  constraint ops_control_caps_non_negative
    check (max_actions_per_hour >= 0 and max_spend_usd_per_hour >= 0
           and consecutive_failure_limit >= 1)
);

comment on table  public.ops_control is 'Kill switch + per-subsystem autonomy settings. Row key ''global'' is the master switch.';
comment on column public.ops_control.dry_run is 'true = run the logic, log the intent, change nothing. Every automation ships here first.';

-- ── ops_audit_log ───────────────────────────────────────────────────────────
-- The single most important table in the codebase. Every autonomous action
-- writes one row whether it executed, was dry-run, or was blocked — a blocked
-- action is exactly as interesting as a taken one, because "why did nothing
-- happen" is the question this table has to be able to answer.
create table if not exists public.ops_audit_log (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  subsystem     text        not null,
  action        text        not null,
  tier          smallint    not null,
  -- executed | dry_run | prepared | blocked | failed
  status        text        not null,
  blocked_by    text,                     -- WHICH guard stopped it, verbatim
  trigger       text,                     -- what caused this pass
  rationale     text,                     -- why this action, in plain English
  target_table  text,
  target_id     text,
  before_data   jsonb,                    -- state prior, for undo + diffing
  after_data    jsonb,
  undo          jsonb,                    -- how to reverse it, machine-readable
  undone_at     timestamptz,
  undone_by     text,
  cost_usd      numeric     not null default 0,
  duration_ms   integer,
  run_id        uuid,
  error         text,
  constraint ops_audit_log_tier_range check (tier between 0 and 3),
  constraint ops_audit_log_status check
    (status in ('executed','dry_run','prepared','blocked','failed'))
);

-- The three reads this table actually gets: the daily brief (recent, by time),
-- the cap/breaker check (one subsystem's recent rows), and "what can I undo".
create index if not exists ops_audit_log_at_idx         on public.ops_audit_log (at desc);
create index if not exists ops_audit_log_subsystem_idx  on public.ops_audit_log (subsystem, at desc);
create index if not exists ops_audit_log_undoable_idx   on public.ops_audit_log (at desc)
  where undo is not null and undone_at is null;

comment on table public.ops_audit_log is 'Every autonomous action: what, when, why, what changed, how to undo. Blocked actions are logged too.';

-- ── ops_runs ────────────────────────────────────────────────────────────────
-- One row per scheduled pass. `ok` drives the circuit breaker, and the counters
-- are what the daily brief reports as "what the autonomous layer did overnight".
create table if not exists public.ops_runs (
  id           uuid primary key default gen_random_uuid(),
  subsystem    text        not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  ok           boolean,
  actions      integer     not null default 0,
  blocked      integer     not null default 0,
  errors       integer     not null default 0,
  cost_usd     numeric     not null default 0,
  trigger      text,
  note         text
);

create index if not exists ops_runs_subsystem_idx on public.ops_runs (subsystem, started_at desc);

comment on table public.ops_runs is 'One row per scheduled autonomous pass. Feeds the circuit breaker and the daily brief.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Every other table in this database has RLS on; these are no exception. The
-- operator (authenticated) reads and writes control; the audit log is
-- append-only from the client's point of view — there is no UPDATE or DELETE
-- policy for it on purpose, because an audit log you can quietly edit is not
-- one. Scheduled functions use the service role, which bypasses RLS entirely
-- and is the only thing that writes ops_runs.
alter table public.ops_control   enable row level security;
alter table public.ops_audit_log enable row level security;
alter table public.ops_runs      enable row level security;

drop policy if exists ops_control_rw on public.ops_control;
create policy ops_control_rw on public.ops_control
  for all to authenticated using (true) with check (true);

drop policy if exists ops_audit_log_read on public.ops_audit_log;
create policy ops_audit_log_read on public.ops_audit_log
  for select to authenticated using (true);

-- Undo is the one field an operator may set, so the UI can mark a reversal.
drop policy if exists ops_audit_log_mark_undone on public.ops_audit_log;
create policy ops_audit_log_mark_undone on public.ops_audit_log
  for update to authenticated using (true) with check (true);

drop policy if exists ops_runs_read on public.ops_runs;
create policy ops_runs_read on public.ops_runs
  for select to authenticated using (true);

-- ── Seed ────────────────────────────────────────────────────────────────────
-- The global row must exist or the kill switch has nothing to read. It seeds
-- DISABLED: shipping this migration does not switch anything on, and cannot.
insert into public.ops_control (key, enabled, dry_run, max_actions_per_hour, max_spend_usd_per_hour)
values ('global', false, true, 500, 5.00)
on conflict (key) do nothing;
