-- Runway: hunts, application kits, and the skill signal.
--
-- Three additions, each answering a thing the tool could not do:
--
--   HUNTS — discovery was hard-wired to ONE set of criteria (the single
--   target_profile row) and matched a title only when a keyword appeared in it
--   verbatim. You could not run "senior paid search, $140k+, remote" and
--   "marketing manager, Chicago, hybrid" as separate searches, and neither
--   would have found "Growth Marketing Manager, Paid Media" anyway. A hunt is
--   a named, independently-scoped search; the matcher expands its terms through
--   a synonym graph before comparing.
--
--   APP_KITS — the tailoring workspace produced prose you still had to retype
--   into a form. A kit is the whole application: the tailored resume, the
--   cover letter, AND an answer to every screening question the ATS will
--   actually ask, keyed by that ATS's own field name. Versioned exactly like
--   drafts (insert-only, unique on (job, version)) so a regeneration never
--   destroys the answer you had already edited.
--
--   SKILLS — every posting carried its requirements as prose, which meant the
--   only way to ask "what does my market keep asking for that I don't have"
--   was to read a few hundred descriptions. Extraction is deterministic and
--   happens once, at scan/capture time, into a compact array — so the Skills
--   page reads a few kilobytes instead of pulling every raw_description down
--   to the browser.
--
-- Additive only: every column has a default, no column is dropped, no check is
-- tightened on existing data. Safe against the live project with rows in it.

-- ------------------------------------------------------------------- hunts
create table if not exists runway.hunts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  -- Role terms. ANY may match, and each is synonym-expanded at match time —
  -- "paid search" also matches sem / ppc / biddable media / google ads.
  include jsonb not null default '[]'::jsonb,
  -- Kill terms. A hit anywhere in title or body disqualifies outright, before
  -- scoring. This is how "no agency", "no contract" gets enforced.
  exclude jsonb not null default '[]'::jsonb,
  -- Every one of these must appear somewhere. Empty = no requirement. Use
  -- sparingly: each entry is a hard filter, not a preference.
  must jsonb not null default '[]'::jsonb,
  seniority jsonb not null default '[]'::jsonb,
  remote_pref text not null default 'any'
    check (remote_pref in ('remote', 'hybrid', 'onsite', 'any')),
  locations jsonb not null default '[]'::jsonb,
  comp_floor integer,
  -- Below this fit score a match is logged but never queued. 0 = queue
  -- everything that matched, which is the right default until the inbox is
  -- noisy enough to need a floor.
  min_fit integer not null default 0 check (min_fit >= 0 and min_fit <= 100),
  active boolean not null default true,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

drop trigger if exists hunts_updated_at on runway.hunts;
create trigger hunts_updated_at before update on runway.hunts
  for each row execute function runway.set_updated_at();

-- -------------------------------------------------------------- app kits
create table if not exists runway.app_kits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  job_id uuid not null references runway.jobs(id) on delete cascade,
  version integer not null,
  -- The form, as the ATS defines it:
  -- [{ key, label, required, type, options[], max_length, hint }]
  -- `key` is the ATS's own field name (Greenhouse: "question_12345"), which is
  -- what makes an answer re-attachable to the right box after a regeneration.
  questions jsonb not null default '[]'::jsonb,
  -- { <key>: "answer text" }. An object rather than an array so an edited
  -- answer survives the question list being re-fetched in a different order.
  answers jsonb not null default '{}'::jsonb,
  resume_md text,
  cover_md text,
  -- Where the question list came from. 'greenhouse' means these are the real
  -- boxes on the real form; 'pasted' means the user gave us the form; 'none'
  -- means we generated the resume and letter with no form in hand. The UI says
  -- which, because "we answered the actual questions" and "we guessed at
  -- likely questions" are very different promises.
  question_source text not null default 'none'
    check (question_source in ('none', 'greenhouse', 'pasted', 'manual')),
  created_at timestamptz not null default now(),
  unique (job_id, version)
);
create index if not exists app_kits_job_idx on runway.app_kits (job_id, version desc);

-- ------------------------------------------------- discovery provenance + skills
-- Which hunt surfaced this, how well it scored against that hunt, and the
-- human-readable reasons. `match_why` is what lets the inbox say "matched:
-- title 'paid media' ≈ your 'paid search'" instead of asking you to trust it.
alter table runway.seen_postings add column if not exists hunt_id uuid references runway.hunts(id) on delete set null;
alter table runway.seen_postings add column if not exists match_score integer;
alter table runway.seen_postings add column if not exists match_why jsonb not null default '[]'::jsonb;
alter table runway.seen_postings add column if not exists skills jsonb not null default '[]'::jsonb;

alter table runway.jobs add column if not exists skills jsonb not null default '[]'::jsonb;

-- The skills read is "across everything my market is asking for", so it wants
-- every matched posting, not just the ones still queued in the inbox.
create index if not exists seen_postings_matched_idx on runway.seen_postings (user_id, matched);

-- --------------------------------------------------- discovered watch boards
-- A board added by the user is a decision; a board added by company discovery
-- is a suggestion that was accepted. Keeping them apart lets the watchlist
-- offer to prune the auto-added ones that never yielded anything, without ever
-- touching a company you chose yourself. open_roles/matching_roles are the
-- counts at discovery time — evidence for why it was suggested, not live data.
alter table runway.watch_boards add column if not exists discovered boolean not null default false;
alter table runway.watch_boards add column if not exists open_roles integer;
alter table runway.watch_boards add column if not exists matching_roles integer;

-- ------------------------------------------------------------ RLS + grants
-- Same two-condition policy as every other Runway table: owner AND allow-list.
do $$
declare t text;
begin
  foreach t in array array['hunts', 'app_kits']
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
