-- ═══════════════════════════════════════════════════════════════════════════
-- 0003 — ZTS STORE TRUTH
--
-- The first table in this system that holds a fact about the outside world
-- rather than a fact about the system itself. Everything before it was
-- containment; this is the beginning of ingestion.
--
-- ONE ROW PER DAY, upserted. A pass that runs twice in a day corrects that
-- day's row rather than appending a duplicate, so the table stays a timeline
-- instead of a log. The audit trail of what each pass did already lives in
-- ops_audit_log — this table is the answer, not the history of asking.
--
-- WHAT IT DELIBERATELY DOES NOT HOLD:
--   * Sessions, traffic sources, conversion rate. Not available to an Admin API
--     token — that data belongs to Shopify's analytics surface. Storing a
--     column for it that never fills would be worse than not having it.
--   * Customer names, addresses, phone numbers, line items. Nothing here needs
--     them, and a table holding customer PII acquires obligations that a
--     snapshot table should not have.
--   * Reorder points, stock cover, cash-tied-up. The plan called for them; the
--     store has one active product with inventory tracking OFF and no real
--     order history to forecast from, so the columns would hold nulls forever.
--
-- Additive only. No existing table is touched.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.zts_store_daily (
  day                 date        primary key,
  captured_at         timestamptz not null default now(),

  active_products     integer     not null default 0,
  -- Products that cannot currently be bought. Non-zero here means the
  -- storefront is losing money right now, which is the single most urgent
  -- number this table carries.
  blocked_products    integer     not null default 0,

  orders_total        integer     not null default 0,
  -- Split on purpose. Both lifetime orders on this store were placed by the
  -- owner and refunded; folding those into `orders_total` alone would let every
  -- dashboard built on this table overstate the business by 100%.
  orders_real         integer     not null default 0,
  orders_test         integer     not null default 0,
  orders_unfulfilled  integer     not null default 0,

  real_revenue_usd    numeric     not null default 0,
  gross_usd           numeric     not null default 0,

  -- The findings arrays from @cc/ops/store: which products are blocked and
  -- why, and which real orders are aging unfulfilled.
  findings            jsonb,

  constraint zts_store_daily_counts_non_negative
    check (active_products >= 0 and blocked_products >= 0
           and orders_total >= 0 and orders_real >= 0 and orders_test >= 0
           and orders_unfulfilled >= 0
           and real_revenue_usd >= 0 and gross_usd >= 0)
);

create index if not exists zts_store_daily_captured_idx
  on public.zts_store_daily (captured_at desc);

-- Partial index for the only alerting read: "is anything wrong today".
create index if not exists zts_store_daily_blocked_idx
  on public.zts_store_daily (day desc) where blocked_products > 0;

comment on table public.zts_store_daily is 'Daily Shopify store snapshot: what is sellable, what sold, what is stuck. One row per day, upserted.';
comment on column public.zts_store_daily.orders_real is 'Orders excluding staff test orders, refunds, cancellations. This is the revenue number.';
comment on column public.zts_store_daily.blocked_products is 'Active products that cannot be purchased right now. Non-zero = storefront is down for sales.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Read-only to the operator. The scheduled ingestion uses the service role,
-- which bypasses RLS — so there is deliberately no INSERT or UPDATE policy
-- here. Nothing in a browser writes store truth; it is derived from Shopify or
-- it is not a fact.
alter table public.zts_store_daily enable row level security;

drop policy if exists zts_store_daily_read on public.zts_store_daily;
create policy zts_store_daily_read on public.zts_store_daily
  for select to authenticated using (true);

-- Belt and braces: RLS is row-level and cannot express "no writes ever", so the
-- absence of a policy is backed by an explicit grant. Migration 0002 learned
-- this the hard way on ops_audit_log.
revoke insert, update, delete on public.zts_store_daily from authenticated;
grant select on public.zts_store_daily to authenticated;
