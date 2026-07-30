-- ═══════════════════════════════════════════════════════════════════════════
-- `authenticated` is not `the operator`, and three tables were treating it as
-- though it were.
--
-- Same defect class as the sync.is_owner() self-bootstrap closed in
-- 20260730120000: the policies said `to authenticated using (true)`, so the
-- real boundary was "can you obtain a session on this project" — a signup
-- setting, not a database check. Supabase's own linter flags all five as
-- rls_policy_always_true.
--
-- What that reached:
--   ops_control   INSERT/UPDATE  the autonomy control table. The global switch
--                                and every subsystem's enabled/dry_run flag.
--                                An account that signed up could arm autonomy
--                                from the browser console.
--   ops_audit_log UPDATE         the containment record — rewritable by anyone
--                                who could read it, which makes it evidence of
--                                nothing.
--   inbound_leads SELECT/UPDATE/DELETE
--                                customer name, email, website and the whole
--                                inbound pipeline, deletable wholesale.
--
-- public.is_operator() follows the shape runway.email_allowed() already
-- established in this database: SECURITY DEFINER over an RLS-locked allowlist
-- with a pinned search_path. It reads sync.allowed_emails — the canonical owner
-- list, seeded with the owner, RLS-on-with-no-policies so it is unreachable
-- from any client key.
--
-- DELIBERATELY NOT TOUCHED: the anon INSERT policies on audit_requests,
-- email_events, rate_events, and `anon can insert leads`. Those are the public
-- lead-capture and open/click tracking paths, insert-only by design; the
-- free-audit endpoint stops working without them. They are the reason the
-- linter will still report four always-true policies after this migration.
--
-- The scheduled functions are unaffected: they authenticate with the service
-- role, which bypasses RLS entirely.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.is_operator()
returns boolean
language sql
stable
security definer
set search_path = sync, public, pg_temp
as $$
  select auth.uid() is not null
     and exists (
       select 1 from sync.allowed_emails a
        where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
     );
$$;

revoke all on function public.is_operator() from public, anon;
grant execute on function public.is_operator() to authenticated;

-- ── ops_control: the autonomy switch ────────────────────────────────────────
drop policy if exists ops_control_read on public.ops_control;
create policy ops_control_read on public.ops_control
  for select to authenticated using (public.is_operator());

drop policy if exists ops_control_insert on public.ops_control;
create policy ops_control_insert on public.ops_control
  for insert to authenticated with check (public.is_operator());

drop policy if exists ops_control_update on public.ops_control;
create policy ops_control_update on public.ops_control
  for update to authenticated
  using (public.is_operator()) with check (public.is_operator());

-- ── ops_audit_log: the containment record ───────────────────────────────────
drop policy if exists ops_audit_log_read on public.ops_audit_log;
create policy ops_audit_log_read on public.ops_audit_log
  for select to authenticated using (public.is_operator());

drop policy if exists ops_audit_log_mark_undone on public.ops_audit_log;
create policy ops_audit_log_mark_undone on public.ops_audit_log
  for update to authenticated
  using (public.is_operator()) with check (public.is_operator());

-- ── inbound_leads: customer PII ─────────────────────────────────────────────
drop policy if exists "authenticated read leads" on public.inbound_leads;
create policy "authenticated read leads" on public.inbound_leads
  for select to authenticated using (public.is_operator());

drop policy if exists "authenticated update leads" on public.inbound_leads;
create policy "authenticated update leads" on public.inbound_leads
  for update to authenticated
  using (public.is_operator()) with check (public.is_operator());

drop policy if exists "Authenticated users can delete inbound leads" on public.inbound_leads;
create policy "Authenticated users can delete inbound leads" on public.inbound_leads
  for delete to authenticated using (public.is_operator());
