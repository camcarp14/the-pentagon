-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠  TEST DATA — TEST DATA — TEST DATA  ⚠
--
-- Fixtures for the AI Business tab. Every row this file writes is invented.
-- None of it is a measurement, a real dollar, or a real decision.
--
-- DO NOT RUN THIS AGAINST AN AGENT PROJECT THAT IS DOING REAL WORK. It rewrites
-- agent_config (the singleton the halt button targets) and inserts into the
-- append-only ledgers, which exist to be evidence. Polluting them with invented
-- rows is exactly the lie the whole tab is built to prevent.
--
-- ── How to use it ──────────────────────────────────────────────────────────
-- Run it in the Supabase SQL editor of the AGENT project, after schema.sql.
-- Not from the browser: the browser holds `authenticated`, which has SELECT and
-- six UPDATE columns and no INSERT anywhere in this schema. It could not write a
-- single line of this file, and proving that is section 4 of README.md.
--
-- IDEMPOTENT. Every row carries a deterministic id and upserts, so re-running is
-- safe — and re-running is the intended way to RE-ARM the 90-second approval and
-- re-anchor every other timestamp to the current now(). Do not hand-edit rows.
--
-- Every timestamp is now()-relative interval arithmetic, so the file stays valid
-- whenever it is run: next week, next year, or at 03:00 on the 1st of a month.
--
-- ── The id convention (this is what makes cleanup exact) ───────────────────
-- Fixture ids are all of the form f1c700NN-0000-4000-8000-… , one NN per table:
--   f1c70001  approvals          f1c70005  learnings
--   f1c70002  action_ledger      f1c70006  metrics_snapshot
--   f1c70003  spend_ledger       f1c70007  invariant_checks
--   f1c70004  hypothesis_queue   f1c70008  budget
-- Real rows use gen_random_uuid() and will never collide with that prefix, so
-- the cleanup block at the bottom removes exactly what this file inserted and
-- nothing else.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  raise notice '=== LOADING TEST FIXTURES into the agent project. Every row below is invented. ===';
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 1. agent_config — running, tier 2, a real goal, a fresh heartbeat.
-- ───────────────────────────────────────────────────────────────────────────
-- schema.sql ships this row HALTED on purpose. Fixtures set it running because
-- the states worth looking at (a live countdown, a burning budget, a stale
-- heartbeat) are all states of a running agent. The cleanup block at the bottom
-- puts it back to shipped-halted.
--
-- heartbeat_at is 90 seconds old: inside the 45-minute window, so the status bar
-- reads a calm `RUNNING`. The scenario switch at the bottom is how you make it
-- read `RUNNING · NO HEARTBEAT` for real.
insert into public.agent_config
  (id, halted, halt_reason, halted_at, halted_by, goal, autonomy_tier, heartbeat_at, tick_seconds, updated_at)
values (
  'singleton',
  false,
  null,
  null,
  null,
  'Take Zero-to-Secure from 0 to 2,000 USD MRR by the end of the quarter. Prefer experiments that can be reversed in under a day. Never email a prospect twice in one week.',
  2,
  now() - interval '90 seconds',
  900,
  now()
)
on conflict (id) do update set
  halted        = excluded.halted,
  halt_reason   = excluded.halt_reason,
  halted_at     = excluded.halted_at,
  halted_by     = excluded.halted_by,
  goal          = excluded.goal,
  autonomy_tier = excluded.autonomy_tier,
  heartbeat_at  = excluded.heartbeat_at,
  tick_seconds  = excluded.tick_seconds,
  updated_at    = excluded.updated_at;


-- ───────────────────────────────────────────────────────────────────────────
-- 2. budget — this month, four caps.
-- ───────────────────────────────────────────────────────────────────────────
-- These are the same four caps schema.sql seeds. `on conflict do nothing` on the
-- (period_start, category) unique key means: if the seed already ran, all four of
-- these are no-ops and keep their original gen_random_uuid() ids — so the cleanup
-- block deletes nothing here. If the seed was skipped, the fixture supplied them
-- with f1c70008 ids and cleanup removes exactly those. Either way, exact.
--
-- NOTE the deliberate hole: there is no cap for the 'data' category, which the
-- spend below does spend against. That is the uncapped case — money leaving with
-- nothing to measure it against — and the budget panel has to surface it rather
-- than rendering only the categories it expected.
insert into public.budget (id, period_start, period_end, category, cap_usd, hard_stop, created_at)
values
  ('f1c70008-0000-4000-8000-000000000001',
   date_trunc('month', now())::date,
   (date_trunc('month', now()) + interval '1 month - 1 day')::date,
   'total', 200.00, true, date_trunc('month', now())),
  ('f1c70008-0000-4000-8000-000000000002',
   date_trunc('month', now())::date,
   (date_trunc('month', now()) + interval '1 month - 1 day')::date,
   'inference', 120.00, false, date_trunc('month', now())),
  ('f1c70008-0000-4000-8000-000000000003',
   date_trunc('month', now())::date,
   (date_trunc('month', now()) + interval '1 month - 1 day')::date,
   'infrastructure', 40.00, false, date_trunc('month', now())),
  ('f1c70008-0000-4000-8000-000000000004',
   date_trunc('month', now())::date,
   (date_trunc('month', now()) + interval '1 month - 1 day')::date,
   'ads', 40.00, false, date_trunc('month', now()))
on conflict (period_start, category) do nothing;


-- ───────────────────────────────────────────────────────────────────────────
-- 3. hypothesis_queue — every status in the CHECK constraint.
-- ───────────────────────────────────────────────────────────────────────────
-- queued · running · done · rejected · blocked. The blocked row carries a
-- blocked_reason, because the panel renders that reason on the row itself rather
-- than behind a tap: "blocked" with no reason is just a colour.
insert into public.hypothesis_queue
  (id, created_at, updated_at, title, rationale, score, tier, status, expected_lift, effort_hours, blocked_reason)
values
  ('f1c70004-0000-4000-8000-000000000001',
   now() - interval '2 days', now() - interval '3 hours',
   'Move the pricing page CTA above the fold on mobile',
   'Session recordings show 71 percent of mobile visitors never scroll to the current CTA. Cheap to try, trivially reversible.',
   8.400, 2, 'queued', '+8-12 percent trial starts', 1.50, null),

  ('f1c70004-0000-4000-8000-000000000002',
   now() - interval '4 days', now() - interval '19 hours',
   'Add a 14-day trial extension offer on the cancellation screen',
   'Three of the last five churned accounts cancelled inside the first week, before ever running a scan.',
   6.100, 1, 'queued', '+2-4 percent retained trials', 3.00, null),

  ('f1c70004-0000-4000-8000-000000000003',
   now() - interval '1 day', now() - interval '22 minutes',
   'Rewrite the cold outreach opener around the compliance deadline',
   'Reply rate on the current opener is 1.9 percent across 212 sends. The deadline angle tested better in the two manual sends.',
   7.900, 2, 'running', '+1.5pp reply rate', 2.00, null),

  ('f1c70004-0000-4000-8000-000000000004',
   now() - interval '6 days', now() - interval '5 hours',
   'Launch the 49 USD self-serve tier',
   'Largest projected lift in the queue, and the only item that changes the shape of the funnel rather than its conversion.',
   9.200, 3, 'blocked',
   'Needs a Stripe price object that does not exist yet, and creating one is outside the three verbs. A human has to make it in the Stripe dashboard before this can be picked up.',
   6.00,
   'Needs a Stripe price object that does not exist yet, and creating one is outside the three verbs. A human has to make it in the Stripe dashboard before this can be picked up.'),

  ('f1c70004-0000-4000-8000-000000000005',
   now() - interval '11 days', now() - interval '3 days',
   'Shorten the signup form from 6 fields to 3',
   'Ran it. Trial starts up 9 percent, trial-to-paid unchanged, so the extra trials were not worse leads.',
   5.000, 1, 'done', '+9 percent trial starts (measured)', 1.00, null),

  ('f1c70004-0000-4000-8000-000000000006',
   now() - interval '9 days', now() - interval '7 days',
   'Buy a sponsored newsletter slot at 900 USD',
   'Rejected: single spend is 4.5x the monthly ads cap, unmeasurable within one period, and not reversible.',
   2.200, 3, 'rejected', 'unknown', 0.50, null)
on conflict (id) do update set
  created_at     = excluded.created_at,
  updated_at     = excluded.updated_at,
  title          = excluded.title,
  rationale      = excluded.rationale,
  score          = excluded.score,
  tier           = excluded.tier,
  status         = excluded.status,
  expected_lift  = excluded.expected_lift,
  effort_hours   = excluded.effort_hours,
  blocked_reason = excluded.blocked_reason;


-- ───────────────────────────────────────────────────────────────────────────
-- 4. action_ledger — a recent burst, then a much older tail.
-- ───────────────────────────────────────────────────────────────────────────
-- Rows 01-08 land inside the last 45 minutes, so the panel reads FRESH and the
-- 6-hour briefing card has something to summarise. Row 03 is a `failure` with
-- real error text, because a ledger with no failures in it is not a ledger
-- anyone has learned to read.
--
-- Rows 09-14 are older than 45 minutes (up to yesterday). They are what the
-- stale path is made of: delete or back-date the burst above and this tail is
-- what remains, which is how you see "Stale — newest is 3h old" for real rather
-- than through ?fault=stale. The scenario switch at the bottom does it in one
-- statement.
--
-- All five outcomes in the CHECK constraint appear: success, failure, blocked,
-- skipped, dry_run.
insert into public.action_ledger
  (id, occurred_at, tick_type, action, outcome, detail, cost_usd, duration_ms, error, hypothesis_id)
values
  -- ── the recent burst (inside the 45-minute window) ──────────────────────
  ('f1c70002-0000-4000-8000-000000000001', now() - interval '2 minutes',  'heartbeat',
   'Tick 4,181 — nothing due', 'success',
   '{"tick": 4181, "due": 0}'::jsonb, 0.0000, 118, null, null),

  ('f1c70002-0000-4000-8000-000000000002', now() - interval '6 minutes',  'observe',
   'Pulled 24h of Shopify orders and Plausible sessions', 'success',
   '{"orders": 0, "sessions": 412, "source": "shopify+plausible"}'::jsonb, 0.0000, 2140, null, null),

  ('f1c70002-0000-4000-8000-000000000003', now() - interval '11 minutes', 'execute',
   'Publish the rewritten pricing-page hero', 'failure',
   '{"target": "shopify:page/pricing", "attempt": 2}'::jsonb, 0.4200, 3890,
   'Shopify Admin API returned 403 Forbidden: the app token carries write_content only and this call needs write_online_store_pages. Retried once, same result. Not retrying again.',
   'f1c70004-0000-4000-8000-000000000001'),

  ('f1c70002-0000-4000-8000-000000000004', now() - interval '14 minutes', 'plan',
   'Re-ranked the hypothesis queue against the last 48h of metrics', 'success',
   '{"considered": 6, "promoted": 1, "demoted": 2}'::jsonb, 0.1800, 5210, null,
   'f1c70004-0000-4000-8000-000000000003'),

  ('f1c70002-0000-4000-8000-000000000005', now() - interval '19 minutes', 'execute',
   'Start the 49 USD self-serve tier rollout', 'blocked',
   '{"reason": "missing_stripe_price", "hypothesis": "self-serve-tier"}'::jsonb, 0.0000, 240, null,
   'f1c70004-0000-4000-8000-000000000004'),

  ('f1c70002-0000-4000-8000-000000000006', now() - interval '27 minutes', 'execute',
   'Sent 18 outreach emails on the compliance-deadline opener', 'success',
   '{"sent": 18, "bounced": 0, "segment": "smb-fintech"}'::jsonb, 1.1000, 14220, null,
   'f1c70004-0000-4000-8000-000000000003'),

  ('f1c70002-0000-4000-8000-000000000007', now() - interval '33 minutes', 'reflect',
   'Weekly retro skipped — not enough new evidence since the last one', 'skipped',
   '{"new_learnings_since": 1, "threshold": 3}'::jsonb, 0.0000, 90, null, null),

  ('f1c70002-0000-4000-8000-000000000008', now() - interval '41 minutes', 'execute',
   'Ad budget reallocation (dry run — tier 2 requires an approval first)', 'dry_run',
   '{"from": "brand", "to": "intent", "usd": 12.00}'::jsonb, 0.0000, 610, null, null),

  -- ── the older tail (outside the 45-minute window) ───────────────────────
  ('f1c70002-0000-4000-8000-000000000009', now() - interval '1 hour 10 minutes', 'heartbeat',
   'Tick 4,177 — nothing due', 'success',
   '{"tick": 4177, "due": 0}'::jsonb, 0.0000, 104, null, null),

  ('f1c70002-0000-4000-8000-000000000010', now() - interval '2 hours 5 minutes',  'execute',
   'Refreshed the intent keyword list and repriced 4 ad groups', 'success',
   '{"keywords": 61, "adgroups": 4}'::jsonb, 0.3400, 8100, null, null),

  ('f1c70002-0000-4000-8000-000000000011', now() - interval '3 hours 20 minutes', 'execute',
   'Sync learnings to the knowledge store', 'failure',
   '{"batch": 12, "written": 0}'::jsonb, 0.0100, 30040,
   'Timed out after 30s waiting on the embeddings endpoint. Nothing was written, so the batch is still pending and will be retried on the next reflect tick.',
   null),

  ('f1c70002-0000-4000-8000-000000000012', now() - interval '5 hours 40 minutes', 'observe',
   'Captured the objective-function snapshot', 'success',
   '{"objective": 172.15, "captured": true}'::jsonb, 0.0000, 1450, null, null),

  ('f1c70002-0000-4000-8000-000000000013', now() - interval '9 hours 15 minutes', 'plan',
   'Drafted the trial-extension experiment and filed it for approval', 'success',
   '{"filed_approval": true}'::jsonb, 0.2600, 6900, null,
   'f1c70004-0000-4000-8000-000000000002'),

  ('f1c70002-0000-4000-8000-000000000014', now() - interval '26 hours',           'execute',
   'Published 2 comparison pages', 'success',
   '{"pages": 2, "words": 2310}'::jsonb, 0.7700, 41200, null, null)
on conflict (id) do update set
  occurred_at   = excluded.occurred_at,
  tick_type     = excluded.tick_type,
  action        = excluded.action,
  outcome       = excluded.outcome,
  detail        = excluded.detail,
  cost_usd      = excluded.cost_usd,
  duration_ms   = excluded.duration_ms,
  error         = excluded.error,
  hypothesis_id = excluded.hypothesis_id;


-- ───────────────────────────────────────────────────────────────────────────
-- 5. spend_ledger — four categories, one of them uncapped, one over its cap.
-- ───────────────────────────────────────────────────────────────────────────
--   inference       68.40 of 120.00
--   infrastructure  12.20 of  40.00
--   ads             47.50 of  40.00   ← OVER CAP, on purpose
--   data            23.10 of      —   ← NO budget row at all, on purpose
--   total          151.20 of 200.00   (under cap; pace projection may still be over)
--
-- Written as SELECT-over-VALUES rather than a plain VALUES list for one reason:
-- the spent_at expression has to be CLAMPED into the current budget period.
-- budget.js only counts spend that falls inside the period it found, so a row
-- back-dated 12 days would silently vanish whenever this file happens to be run
-- in the first week of a month — and a spend panel that renders 0 while money
-- left is the exact failure the panel exists to prevent.
insert into public.spend_ledger (id, spent_at, category, amount_usd, vendor, memo, action_id)
select
  v.id::uuid,
  greatest(now() - v.ago, date_trunc('month', now()) + interval '90 minutes'),
  v.category,
  v.amount_usd,
  v.vendor,
  v.memo,
  v.action_id::uuid
from (values
  ('f1c70003-0000-4000-8000-000000000001', interval '12 days',    'inference',      9.2000, 'anthropic',    'plan + reflect ticks',              null::text),
  ('f1c70003-0000-4000-8000-000000000002', interval '9 days',     'infrastructure', 6.0000, 'netlify',      'function invocations',              null),
  ('f1c70003-0000-4000-8000-000000000003', interval '7 days',     'inference',     14.8000, 'anthropic',    'content generation batch',           null),
  ('f1c70003-0000-4000-8000-000000000004', interval '5 days',     'ads',           20.0000, 'google-ads',   'intent campaign, week 1',            null),
  ('f1c70003-0000-4000-8000-000000000005', interval '5 days',     'data',          11.6000, 'clearbit',     'enrichment for the smb-fintech list', null),
  ('f1c70003-0000-4000-8000-000000000006', interval '4 days',     'inference',     11.3500, 'anthropic',    'outreach personalisation',           null),
  ('f1c70003-0000-4000-8000-000000000007', interval '3 days',     'ads',           15.5000, 'google-ads',   'intent campaign, week 2',            null),
  ('f1c70003-0000-4000-8000-000000000008', interval '2 days',     'inference',     18.4000, 'anthropic',    'comparison page drafts',
                                                                                                            'f1c70002-0000-4000-8000-000000000014'),
  ('f1c70003-0000-4000-8000-000000000009', interval '1 day',      'infrastructure', 6.2000, 'supabase',     'database + storage',                 null),
  ('f1c70003-0000-4000-8000-000000000010', interval '14 hours',   'ads',           12.0000, 'google-ads',   'intent campaign, week 3 — over cap',  null),
  ('f1c70003-0000-4000-8000-000000000011', interval '6 hours',    'inference',      9.0500, 'anthropic',    'observe tick summarisation',         null),
  ('f1c70003-0000-4000-8000-000000000012', interval '2 hours',    'data',          11.5000, 'clearbit',     'enrichment top-up',                  null),
  ('f1c70003-0000-4000-8000-000000000013', interval '25 minutes', 'inference',      5.6000, 'anthropic',    'outreach send, 18 recipients',
                                                                                                            'f1c70002-0000-4000-8000-000000000006')
) as v (id, ago, category, amount_usd, vendor, memo, action_id)
on conflict (id) do update set
  spent_at   = excluded.spent_at,
  category   = excluded.category,
  amount_usd = excluded.amount_usd,
  vendor     = excluded.vendor,
  memo       = excluded.memo,
  action_id  = excluded.action_id;


-- ───────────────────────────────────────────────────────────────────────────
-- 6. approvals — the veto window, in every state that matters.
-- ───────────────────────────────────────────────────────────────────────────
-- Row 01 expires in NINETY SECONDS. That is the live countdown: open the tab,
-- watch it tick down, watch it cross zero and move itself from "you can still
-- stop this" to "it went ahead without you". Re-run this file to re-arm it.
--
-- Row 02 expired YESTERDAY and is still pending. Nothing in the database marks
-- that transition — the row simply aged past its deadline and the agent
-- proceeded on the default. It is derived, not stored, as
-- (decision = 'pending' AND veto_until < now()), and it must never be filed into
-- ordinary history: history is the list of decisions you made, and this is the
-- one you did not.
--
-- If the "went ahead without you" callout does not appear, the client-side
-- last-visit stamp is newer than this row. Clear it and reload:
--     localStorage.removeItem("agent_business_last_visit")
insert into public.approvals
  (id, created_at, title, summary, kind, risk_tier, cost_usd, veto_until, decision, decided_at, decided_by, payload, hypothesis_id)
values
  -- ── 90 SECONDS. The one you can still stop. ─────────────────────────────
  ('f1c70001-0000-4000-8000-000000000001',
   now() - interval '25 minutes',
   'Raise the daily ads cap from 8 to 14 USD for 5 days',
   'Intent campaign is converting at 3.1 percent against a 1.4 percent baseline and is capped out by 11am every day. Reversible by lowering the cap again; the spend is bounded at 30 USD over the 5 days.',
   'spend', 2, 30.0000,
   now() + interval '90 seconds',
   'pending', null, null,
   '{"campaign": "intent-smb", "cap_from": 8, "cap_to": 14, "days": 5}'::jsonb,
   null),

  -- ── EXPIRED YESTERDAY, STILL PENDING. It already happened. ──────────────
  ('f1c70001-0000-4000-8000-000000000002',
   now() - interval '1 day 6 hours',
   'Publish 2 comparison pages to the blog',
   'Auto-proceeded: the veto window closed with no decision, so the agent published both pages. They are live now. Reversing means unpublishing them.',
   'publish', 1, 0.7700,
   now() - interval '1 day',
   'pending', null, null,
   '{"pages": ["zts-vs-vanta", "zts-vs-drata"], "published": true}'::jsonb,
   null),

  -- ── DECIDED. Ordinary history. ──────────────────────────────────────────
  ('f1c70001-0000-4000-8000-000000000003',
   now() - interval '8 hours',
   'Send 18 cold emails on the compliance-deadline opener',
   'Approved. First send on the new opener; capped at 18 recipients so a bad opener costs 18 addresses, not the list.',
   'external', 2, 1.1000,
   now() - interval '2 hours',
   'approved', now() - interval '5 hours', 'operator',
   '{"segment": "smb-fintech", "count": 18}'::jsonb,
   'f1c70004-0000-4000-8000-000000000003'),

  -- ── PENDING, but hours out. Sits below the urgent band. ─────────────────
  ('f1c70001-0000-4000-8000-000000000004',
   now() - interval '40 minutes',
   'Add a trial-extension offer to the cancellation flow',
   'Touches the billing path. Reversible by removing the offer, but anyone who accepts it keeps the extension.',
   'publish', 2, 0.0000,
   now() + interval '6 hours',
   'pending', null, null,
   '{"surface": "cancel-flow", "offer_days": 14}'::jsonb,
   'f1c70004-0000-4000-8000-000000000002'),

  -- ── VETOED. The other half of history. ──────────────────────────────────
  ('f1c70001-0000-4000-8000-000000000005',
   now() - interval '2 days 4 hours',
   'Buy a sponsored newsletter slot at 900 USD',
   'Vetoed: 4.5x the monthly ads cap in a single irreversible spend, with no way to attribute the result inside one period.',
   'spend', 3, 900.0000,
   now() - interval '2 days 1 hour',
   'vetoed', now() - interval '2 days 2 hours', 'operator',
   '{"vendor": "a-newsletter", "usd": 900}'::jsonb,
   'f1c70004-0000-4000-8000-000000000006')
on conflict (id) do update set
  created_at    = excluded.created_at,
  title         = excluded.title,
  summary       = excluded.summary,
  kind          = excluded.kind,
  risk_tier     = excluded.risk_tier,
  cost_usd      = excluded.cost_usd,
  veto_until    = excluded.veto_until,
  decision      = excluded.decision,
  decided_at    = excluded.decided_at,
  decided_by    = excluded.decided_by,
  payload       = excluded.payload,
  hypothesis_id = excluded.hypothesis_id;


-- ───────────────────────────────────────────────────────────────────────────
-- 7. learnings — high, medium and low confidence.
-- ───────────────────────────────────────────────────────────────────────────
-- Bands the panel renders against: 0.8+ high · 0.5-0.8 medium · below 0.5 low.
-- Rows 01 and 04 are inside the 6-hour briefing window, so the card has
-- something to put under "what did it learn".
insert into public.learnings
  (id, learned_at, statement, detail, confidence, source, tags, source_action_id)
values
  ('f1c70005-0000-4000-8000-000000000001', now() - interval '2 hours',
   'Mobile visitors do not scroll to the pricing CTA',
   'Across 412 mobile sessions, 71 percent never reached 60 percent scroll depth on /pricing. Holds across three traffic sources, so it is not one bad channel.',
   0.920, 'observation', '{pricing,mobile,funnel}', null),

  ('f1c70005-0000-4000-8000-000000000004', now() - interval '5 hours',
   'The compliance-deadline opener beats the feature opener',
   'Two manual sends of 20 each: 4 replies against 1. Small n, but the direction matched the two cold calls that landed.',
   0.850, 'experiment', '{outreach,copy}', 'f1c70002-0000-4000-8000-000000000006'),

  ('f1c70005-0000-4000-8000-000000000002', now() - interval '20 hours',
   'Trials that never run a scan in week one do not convert',
   'Five of the last six churned trials never completed a scan. The sixth ran one and churned anyway, so this predicts churn better than it predicts retention.',
   0.610, 'observation', '{churn,activation}', null),

  ('f1c70005-0000-4000-8000-000000000005', now() - interval '3 days',
   'Comparison pages bring traffic that does not convert',
   'Both comparison pages rank and draw sessions. Neither has produced a trial in 11 days. Could be intent, could be that they are too new to judge.',
   0.450, 'observation', '{content,seo}', 'f1c70002-0000-4000-8000-000000000014'),

  ('f1c70005-0000-4000-8000-000000000003', now() - interval '6 days',
   'Pricing at 49 USD would roughly double self-serve volume',
   'Extrapolated from three competitor teardowns and no first-party data at all. Filed so the assumption is visible, not because it is believed.',
   0.280, 'external', '{pricing,assumption}', null)
on conflict (id) do update set
  learned_at       = excluded.learned_at,
  statement        = excluded.statement,
  detail           = excluded.detail,
  confidence       = excluded.confidence,
  source           = excluded.source,
  tags             = excluded.tags,
  source_action_id = excluded.source_action_id;


-- ───────────────────────────────────────────────────────────────────────────
-- 8. metrics_snapshot — ~14 days at a 6-hour cadence, with one hole in it.
-- ───────────────────────────────────────────────────────────────────────────
-- 56 six-hourly points spanning 13.75 days, generated rather than typed so the
-- series stays valid whenever this runs.
--
-- The CADENCE is deliberate. The panel breaks the sparkline across any silence
-- longer than 2x its 6-hour staleness window, so a once-a-day series would
-- shatter into 14 unconnected dots — technically correct, and useless as a
-- fixture. Six-hourly points connect.
--
-- Two deliberate defects, both of which the chart must handle without inventing
-- data:
--   · THE GAP — steps 18-20 are omitted, a 24-hour silence about 4.5 days back
--     (inside the default 7d range). The line must BREAK there, not draw
--     straight across it, and the panel must say so.
--   · TWO NULLS — steps 6 and 7 carry no mrr_usd. Switch the series to MRR and
--     those snapshots must drop out of the line, not plot at zero. A null is a
--     measurement that did not happen; drawn on the baseline it manufactures a
--     collapse to nothing.
--
-- Step 0 is 20 minutes old, so the panel reads fresh inside its 6-hour window.
insert into public.metrics_snapshot
  (id, captured_at, objective, mrr_usd, customers, trials, conversion, metrics)
select
  ('f1c70006-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  now() - make_interval(hours => i * 6) - interval '20 minutes',
  round((118 + (55 - i) * 1.15 + (i % 5) * 0.40)::numeric, 4),
  case when i in (6, 7) then null else round((392 + (55 - i) * 3.40)::numeric, 2) end,
  18 + ((55 - i) / 6),
  5 + (i % 4),
  round((0.1100 + (55 - i) * 0.00070)::numeric, 4),
  jsonb_build_object('source', 'fixtures', 'step', i)
from generate_series(0, 55) as i
where i not in (18, 19, 20)
on conflict (id) do update set
  captured_at = excluded.captured_at,
  objective   = excluded.objective,
  mrr_usd     = excluded.mrr_usd,
  customers   = excluded.customers,
  trials      = excluded.trials,
  conversion  = excluded.conversion,
  metrics     = excluded.metrics;


-- ───────────────────────────────────────────────────────────────────────────
-- 9. invariant_checks — passing, failing, and NOT REPORTING.
-- ───────────────────────────────────────────────────────────────────────────
-- Three states, and the third is the one this table exists for. A canary that
-- stops reporting writes exactly as many rows as a canary that is fine — zero —
-- so the only way to tell them apart is the age of the newest row.
--
--   canary:storefront_reachable     passing, 7 minutes old
--   watchdog:tick_loop              the watchdog itself, 4 minutes old, passing
--   invariant:spend_within_cap      FAILING, severity critical, 9 minutes old
--   canary:email_deliverability     passing NOW, failed twice in the window
--                                   (the "flapped x2" case — passing is not fine)
--   invariant:ledger_append_only    NOT REPORTING: newest row is 5 hours old.
--                                   Its last result was a PASS, which is exactly
--                                   why it is dangerous — nothing about the row
--                                   says the check has stopped running.
--
-- Note that the append-only check is amber, not red. Failing and silent are
-- different jobs: one means fix the thing being watched, the other means fix the
-- watcher, and until the watcher is fixed every green line is a claim about the
-- past written in the present tense.
insert into public.invariant_checks (id, checked_at, name, kind, passed, severity, detail)
values
  ('f1c70007-0000-4000-8000-000000000001', now() - interval '4 minutes',
   'watchdog:tick_loop', 'watchdog', true, 'critical',
   'Tick loop has produced 4,181 ticks with no gap longer than 2 intervals.'),

  ('f1c70007-0000-4000-8000-000000000002', now() - interval '7 minutes',
   'canary:storefront_reachable', 'canary', true, 'warn',
   'GET / returned 200 in 340ms.'),

  ('f1c70007-0000-4000-8000-000000000003', now() - interval '9 minutes',
   'invariant:spend_within_cap', 'invariant', false, 'critical',
   'Category ads has spent 47.50 USD against a 40.00 USD cap. hard_stop is false on this cap, so the agent was NOT halted — it filed an approval and carried on. Raise the cap, set hard_stop, or stop the campaign.'),

  ('f1c70007-0000-4000-8000-000000000004', now() - interval '12 minutes',
   'canary:email_deliverability', 'canary', true, 'warn',
   'SPF, DKIM and DMARC all aligned on the last send.'),
  ('f1c70007-0000-4000-8000-000000000005', now() - interval '70 minutes',
   'canary:email_deliverability', 'canary', false, 'warn',
   'DKIM signature missing on 2 of 18 sends.'),
  ('f1c70007-0000-4000-8000-000000000006', now() - interval '2 hours 20 minutes',
   'canary:email_deliverability', 'canary', false, 'warn',
   'DKIM signature missing on 5 of 20 sends.'),

  ('f1c70007-0000-4000-8000-000000000007', now() - interval '35 minutes',
   'watchdog:tick_loop', 'watchdog', true, 'critical',
   'Tick loop has produced 4,178 ticks with no gap longer than 2 intervals.'),

  -- ── the one that stopped reporting ──────────────────────────────────────
  ('f1c70007-0000-4000-8000-000000000008', now() - interval '5 hours',
   'invariant:ledger_append_only', 'invariant', true, 'critical',
   'No UPDATE or DELETE observed against action_ledger or spend_ledger in the audit window.'),
  ('f1c70007-0000-4000-8000-000000000009', now() - interval '9 hours',
   'invariant:ledger_append_only', 'invariant', true, 'critical',
   'No UPDATE or DELETE observed against action_ledger or spend_ledger in the audit window.')
on conflict (id) do update set
  checked_at = excluded.checked_at,
  name       = excluded.name,
  kind       = excluded.kind,
  passed     = excluded.passed,
  severity   = excluded.severity,
  detail     = excluded.detail;


do $$
begin
  raise notice '=== FIXTURES LOADED. The 90-second approval is armed from this moment. ===';
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SCENARIO SWITCHES — uncomment ONE, run it, look at the tab, then re-run this
-- whole file to reset. These produce the REAL versions of states that
-- ?fault=stale can only simulate in the browser.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── RUNNING but no heartbeat (README section 6) ─────────────────────────────
-- The status bar must flip to a red, pulsing `RUNNING · NO HEARTBEAT`. halted is
-- still false, nothing has thrown, no panel is in error — and it must shout.
-- update public.agent_config
--    set heartbeat_at = now() - interval '3 hours', updated_at = now()
--  where id = 'singleton';

-- ── A genuinely stale action ledger ─────────────────────────────────────────
-- Pushes the whole burst past the 45-minute window. The panel must read
-- "Stale — newest is 3h old", NOT empty and NOT fresh.
-- update public.action_ledger
--    set occurred_at = occurred_at - interval '3 hours'
--  where id::text like 'f1c70002-%';

-- ── A genuinely empty ledger (EMPTY, which is not ERROR) ────────────────────
-- The panel must say it reached the database and found nothing, with the time of
-- the successful check — and it must alarm, because action_ledger expects rows.
-- delete from public.action_ledger where id::text like 'f1c70002-%';

-- ── Halted by the watchdog rather than by you ───────────────────────────────
-- update public.agent_config
--    set halted = true,
--        halt_reason = 'Spend cap breached on category ads (47.50 of 40.00).',
--        halted_at = now(), halted_by = 'invariant:spend_within_cap', updated_at = now()
--  where id = 'singleton';

-- ── The watchdog itself goes quiet ──────────────────────────────────────────
-- Every check below it becomes unverified rather than clean.
-- update public.invariant_checks
--    set checked_at = checked_at - interval '6 hours'
--  where kind = 'watchdog' and id::text like 'f1c70007-%';


-- ═══════════════════════════════════════════════════════════════════════════
-- CLEANUP — removes exactly what this file inserted, and nothing else.
--
-- Every DELETE is keyed on the f1c700NN- id prefix, so rows written by the real
-- agent (gen_random_uuid()) are untouched. The budget DELETE is a no-op on a
-- project where schema.sql seeded the caps first: those rows kept their own
-- random ids and the fixture insert was a conflict-do-nothing.
--
-- agent_config is a singleton and cannot be deleted, so it is RESTORED to the
-- state schema.sql ships — halted, tier 1, no goal, no heartbeat. Deploying a
-- schema must never start an autonomous business, and neither must cleaning up
-- after a test.
--
-- Uncomment the whole block and run it.
-- ═══════════════════════════════════════════════════════════════════════════

-- delete from public.approvals        where id::text like 'f1c70001-%';
-- delete from public.action_ledger    where id::text like 'f1c70002-%';
-- delete from public.spend_ledger     where id::text like 'f1c70003-%';
-- delete from public.hypothesis_queue where id::text like 'f1c70004-%';
-- delete from public.learnings        where id::text like 'f1c70005-%';
-- delete from public.metrics_snapshot where id::text like 'f1c70006-%';
-- delete from public.invariant_checks where id::text like 'f1c70007-%';
-- delete from public.budget           where id::text like 'f1c70008-%';
--
-- update public.agent_config
--    set halted        = true,
--        halt_reason   = 'Never started — halted on install',
--        halted_at     = null,
--        halted_by     = 'installer',
--        goal          = '',
--        autonomy_tier = 1,
--        heartbeat_at  = null,
--        tick_seconds  = 900,
--        updated_at    = now()
--  where id = 'singleton';
--
-- -- Verify nothing of this file survives (every count must be 0):
-- select 'approvals' as t, count(*) from public.approvals        where id::text like 'f1c70001-%'
-- union all select 'action_ledger',    count(*) from public.action_ledger    where id::text like 'f1c70002-%'
-- union all select 'spend_ledger',     count(*) from public.spend_ledger     where id::text like 'f1c70003-%'
-- union all select 'hypothesis_queue', count(*) from public.hypothesis_queue where id::text like 'f1c70004-%'
-- union all select 'learnings',        count(*) from public.learnings        where id::text like 'f1c70005-%'
-- union all select 'metrics_snapshot', count(*) from public.metrics_snapshot where id::text like 'f1c70006-%'
-- union all select 'invariant_checks', count(*) from public.invariant_checks where id::text like 'f1c70007-%'
-- union all select 'budget',           count(*) from public.budget           where id::text like 'f1c70008-%';
