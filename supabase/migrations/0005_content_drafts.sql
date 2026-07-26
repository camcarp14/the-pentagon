-- ═══════════════════════════════════════════════════════════════════════════
-- 0005 — CONTENT DRAFTS
--
-- The content engine's half of the Desk queue. Outbound already had somewhere
-- to land — `outreach` has carried draft_subject/draft_body and a
-- draft_ready → approved → sent lifecycle since Clarify was built, and has
-- simply never been used. Content had nothing, so this is it, modelled to
-- match so the queue can treat the two the same way.
--
-- WHY DRAFTS ARE A TABLE AND NOT A QUEUE OF JOBS. A draft is the finished
-- artifact, not a request to make one. The engine does its expensive work
-- (research, writing, self-critique) on the schedule and stores the RESULT, so
-- approving is instant and costs nothing. If approval triggered generation, the
-- operator would tap approve and then wait — and would be approving something
-- they had not read.
--
-- PUBLISHING IS TIER 2. A published article is customer-visible on a live
-- storefront, which the autonomy doctrine puts squarely in "prepared
-- autonomously, executed only after human approval". Nothing here can reach the
-- storefront without a row moving to `approved` by a human hand.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.content_drafts (
  id                 uuid        primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),

  status             text        not null default 'draft_ready',

  -- The article itself, in the exact shape shopify-publish.js already accepts,
  -- so approving is a pass-through rather than a translation step.
  title              text        not null,
  summary            text,
  body_html          text        not null,
  tags               text,
  handle             text,
  blog_handle        text,

  -- Why the engine chose to write this. Shown in the queue: an operator
  -- approving customer-visible work should never have to guess the reasoning.
  rationale          text,
  topic              text,

  model              text,
  cost_usd           numeric     not null default 0,

  approved_at        timestamptz,
  approved_by        text,
  rejected_at        timestamptz,
  rejection_reason   text,

  published_at       timestamptz,
  shopify_article_id text,
  published_url      text,
  error              text,

  constraint content_drafts_status check
    (status in ('draft_ready','approved','rejected','published','failed')),
  constraint content_drafts_cost_non_negative check (cost_usd >= 0),
  constraint content_drafts_title_not_blank check (length(btrim(title)) > 0),
  constraint content_drafts_body_not_blank  check (length(btrim(body_html)) > 0)
);

-- The queue read: everything still waiting, oldest first.
create index if not exists content_drafts_pending_idx
  on public.content_drafts (created_at) where status = 'draft_ready';

create index if not exists content_drafts_created_idx
  on public.content_drafts (created_at desc);

-- Duplicate-title protection. The engine is asked to write about a small set of
-- topics repeatedly, and an LLM handed the same topic twice will happily
-- produce the same article twice. A unique index makes that a loud insert
-- failure the engine can catch and retry with a different angle, instead of a
-- queue slowly filling with near-identical drafts nobody notices.
create unique index if not exists content_drafts_title_unique
  on public.content_drafts (lower(btrim(title)));

comment on table public.content_drafts is 'Articles written by the content engine, awaiting human approval. Publishing is tier 2.';
comment on column public.content_drafts.rationale is 'Why the engine chose this piece. Shown in the approval queue.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Matches the convention the rest of this schema already uses: authenticated
-- only, checked on the role rather than on a row owner, since this is a
-- single-operator system.
alter table public.content_drafts enable row level security;

drop policy if exists content_drafts_authenticated on public.content_drafts;
create policy content_drafts_authenticated on public.content_drafts
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Explicit grants rather than relying on Supabase defaults, and TRUNCATE stays
-- revoked per 0004 — approving work must not be undoable by wiping the table.
revoke all on public.content_drafts from anon;
revoke all on public.content_drafts from authenticated;
grant select, insert, update, delete on public.content_drafts to authenticated;
