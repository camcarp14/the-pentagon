-- Runway baseline — the schema this tool has ALWAYS run on, written down.
--
-- WHY THIS FILE EXISTS AND WHY IT IS DATED TODAY: Runway's tables were applied
-- straight to the live project during the July 2026 consolidation and never
-- landed in supabase/migrations/. For months the repo said Runway had no
-- schema while nine tables, four functions and five triggers ran in production.
-- A fresh clone could not stand the tool up, and nobody could read what the
-- live shapes were without opening the dashboard.
--
-- So this is a TRANSCRIPT, not a change. Every statement is idempotent
-- (`if not exists`, `create or replace`, `drop policy if exists` before
-- `create policy`) and every shape is dumped from the live database rather
-- than remembered — run it against the project it documents and nothing moves.
-- Run it against an empty project and you get Runway.
--
-- Read it before writing the next Runway migration. Two rules it encodes:
--
--   1. EVERY table is owner-scoped AND allow-list-gated. The policy is
--      `user_id = auth.uid() AND runway.email_allowed()` — two independent
--      conditions, because this project's publishable key is public by design
--      and one condition is one mistake away from an open table.
--   2. Stage history is written by a TRIGGER, not by the client. The funnel
--      analytics count "every job that ever reached a stage", which is only
--      honest if the row is logged server-side on the same transaction as the
--      status change. A client that forgets to log is a funnel that lies.

create schema if not exists runway;
grant usage on schema runway to anon, authenticated, service_role;

-- ---------------------------------------------------------------- allow-list
-- One row per address permitted to touch Runway at all. Referenced by every
-- policy through email_allowed(); a compromised token for some other user of
-- the shared project still reads nothing here.
create table if not exists runway.allowed_emails (
  email text primary key
);
alter table runway.allowed_emails enable row level security;

-- SECURITY DEFINER so the policies can consult the allow-list without granting
-- anyone SELECT on it. STABLE + `select ... exists` so Postgres evaluates it
-- once per statement rather than once per row.
create or replace function runway.email_allowed()
returns boolean
language sql
stable
security definer
set search_path to 'runway', 'public'
as $$
  select exists (
    select 1 from runway.allowed_emails a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- --------------------------------------------------------------- trigger fns
create or replace function runway.set_updated_at()
returns trigger
language plpgsql
set search_path to 'runway'
as $$
begin new.updated_at = now(); return new; end;
$$;

-- applied_at is the REAL submission date and the anchor for every aging
-- calculation (staleness, the waiting report, follow-up cadence). Stamped here
-- rather than by the client so it can never be a created_at stand-in.
create or replace function runway.stamp_applied_at()
returns trigger
language plpgsql
set search_path to 'runway'
as $$
begin
  if new.status = 'applied' and new.applied_at is null then new.applied_at = now(); end if;
  return new;
end;
$$;

create or replace function runway.log_stage_change()
returns trigger
language plpgsql
security definer
set search_path to 'runway'
as $$
begin
  if tg_op = 'INSERT' then
    insert into runway.pipeline_events (job_id, user_id, stage, note)
    values (new.id, new.user_id, new.status, 'captured');
  elsif new.status is distinct from old.status then
    insert into runway.pipeline_events (job_id, user_id, stage, note)
    values (new.id, new.user_id, new.status, null);
  end if;
  return new;
end;
$$;

-- --------------------------------------------------------------------- jobs
create table if not exists runway.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  company text not null default '',
  title text not null default '',
  url text,
  raw_description text,
  comp_min integer,
  comp_max integer,
  location text,
  remote_type text not null default 'unknown'
    check (remote_type in ('remote', 'hybrid', 'onsite', 'unknown')),
  seniority text not null default 'unknown'
    check (seniority in ('intern', 'junior', 'mid', 'senior', 'lead', 'manager', 'director', 'vp', 'exec', 'unknown')),
  industry text,
  requirements jsonb not null default '[]'::jsonb,
  flags jsonb not null default '[]'::jsonb,
  fit_score integer check (fit_score >= 0 and fit_score <= 100),
  fit_rationale text,
  fit_breakdown jsonb,
  status text not null default 'saved'
    check (status in ('saved', 'researching', 'applied', 'phone_screen', 'interview', 'offer', 'closed')),
  source text not null default 'manual',
  notes text not null default '',
  prep_notes text not null default '',
  applied_at timestamptz,
  closed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- liveness sweep (check-postings): is this posting still up?
  posting_state text not null default 'unknown'
    check (posting_state in ('unknown', 'live', 'gone', 'uncertain')),
  posting_checked_at timestamptz,
  posting_note text
);
create index if not exists jobs_user_status_idx on runway.jobs (user_id, status);

-- --------------------------------------------------------- pipeline history
create table if not exists runway.pipeline_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references runway.jobs(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  stage text not null,
  note text,
  changed_at timestamptz not null default now()
);
create index if not exists pipeline_events_job_idx on runway.pipeline_events (job_id, changed_at);

-- ----------------------------------------------------------------- contacts
create table if not exists runway.contacts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references runway.jobs(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  role text,
  email text,
  phone text,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists contacts_job_idx on runway.contacts (job_id);

-- ---------------------------------------------------------------- follow-ups
create table if not exists runway.follow_ups (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references runway.jobs(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  due_date date not null,
  note text,
  done boolean not null default false,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists follow_ups_user_idx on runway.follow_ups (user_id, done, due_date);

-- ------------------------------------------------------------------- drafts
-- Immutable versions. Nothing is ever updated in place: (job, type, version)
-- is unique, so "save" always means "add v(n+1)" and the history is the record.
create table if not exists runway.drafts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references runway.jobs(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  type text not null check (type in ('resume_bullets', 'cover_letter', 'outreach_note', 'prep_brief')),
  content text not null,
  version integer not null,
  created_at timestamptz not null default now(),
  unique (job_id, type, version)
);
create index if not exists drafts_job_idx on runway.drafts (job_id, type, version desc);

-- ------------------------------------------------------------ master resume
-- One row per user (unique user_id), JSON rather than columns: the shape is
-- {contact, summary, skills[], experience[{company,title,dates,bullets[]}]} and
-- it is the GROUND TRUTH every AI surface is grounded in. Nothing generated is
-- allowed to claim anything that is not in here.
create table if not exists runway.resume_master (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique default auth.uid() references auth.users(id) on delete cascade,
  content jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------- target profile
create table if not exists runway.target_profile (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique default auth.uid() references auth.users(id) on delete cascade,
  title_keywords jsonb not null default '[]'::jsonb,
  comp_floor integer,
  remote_pref text not null default 'any' check (remote_pref in ('remote', 'hybrid', 'onsite', 'any')),
  location_pref text,
  seniority_band jsonb not null default '[]'::jsonb,
  industries_in jsonb not null default '[]'::jsonb,
  industries_out jsonb not null default '[]'::jsonb,
  followup_days integer not null default 10 check (followup_days >= 1 and followup_days <= 60),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------ watched boards
-- The companies whose PUBLIC ATS feeds the scanner sweeps. `board` is the
-- provider's tenant slug (composite "tenant.instance/site" for Workday).
create table if not exists runway.watch_boards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider text not null check (provider in (
    'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'recruitee',
    'breezy', 'rippling', 'bamboohr', 'jobvite', 'pinpoint', 'teamtailor',
    'personio', 'workday')),
  board text not null,
  company_label text,
  last_scanned_at timestamptz,
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, provider, board)
);

-- ---------------------------------------------------------- discovery ledger
-- Every posting the scanner has ever seen, so a role is surfaced exactly once.
-- status: ignored (logged for dedupe only) | queued (in the inbox) |
-- dismissed | imported (accepted onto the board).
create table if not exists runway.seen_postings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider text not null,
  board text not null,
  external_id text not null,
  url text,
  title text,
  matched boolean not null default false,
  job_id uuid references runway.jobs(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  status text not null default 'ignored'
    check (status in ('ignored', 'queued', 'dismissed', 'imported')),
  fit_score integer,
  fit_rationale text,
  fit_breakdown jsonb,
  flags jsonb not null default '[]'::jsonb,
  company text,
  location text,
  remote_type text,
  seniority text,
  comp_min integer,
  comp_max integer,
  raw_description text,
  unique (user_id, provider, board, external_id)
);
create index if not exists seen_postings_board_idx on runway.seen_postings (user_id, provider, board);
create index if not exists seen_postings_status_idx on runway.seen_postings (user_id, status, fit_score desc);

-- ----------------------------------------------------------------- triggers
drop trigger if exists jobs_updated_at on runway.jobs;
create trigger jobs_updated_at before update on runway.jobs
  for each row execute function runway.set_updated_at();

drop trigger if exists jobs_stamp_applied on runway.jobs;
create trigger jobs_stamp_applied before insert or update of status on runway.jobs
  for each row execute function runway.stamp_applied_at();

drop trigger if exists jobs_log_stage on runway.jobs;
create trigger jobs_log_stage after insert or update of status on runway.jobs
  for each row execute function runway.log_stage_change();

drop trigger if exists resume_master_updated_at on runway.resume_master;
create trigger resume_master_updated_at before update on runway.resume_master
  for each row execute function runway.set_updated_at();

drop trigger if exists target_profile_updated_at on runway.target_profile;
create trigger target_profile_updated_at before update on runway.target_profile
  for each row execute function runway.set_updated_at();

-- --------------------------------------------------------- RLS + the grants
-- The two halves are not redundant: GRANT decides whether the role may issue
-- the statement at all, RLS decides which rows it sees. `authenticated` gets
-- CRUD on every table and `anon` gets nothing but schema USAGE — an anonymous
-- token from the public publishable key can reach the schema and find no door.
do $$
declare t text;
begin
  foreach t in array array['jobs', 'pipeline_events', 'contacts', 'follow_ups',
                           'drafts', 'resume_master', 'target_profile',
                           'watch_boards', 'seen_postings']
  loop
    execute format('alter table runway.%I enable row level security', t);
    execute format('grant select, insert, update, delete on runway.%I to authenticated', t);
    execute format('drop policy if exists owner_all on runway.%I', t);
    execute format($p$
      create policy owner_all on runway.%I
        for all to authenticated
        using (user_id = (select auth.uid()) and (select runway.email_allowed()))
        with check (user_id = (select auth.uid()) and (select runway.email_allowed()))
    $p$, t);
  end loop;
end $$;
