-- ═══════════════════════════════════════════════════════════════════════════
-- 0002 — make "append-only" actually true, and stop the kill switch being
-- deletable.
--
-- 0001 claimed the audit log was append-only on the grounds that it had no
-- DELETE policy. That was wrong. RLS is ROW-level: it cannot restrict columns.
-- An unconditional `for update ... using(true) with check(true)` let any
-- authenticated user rewrite every column in every row — flip a record from
-- `blocked` to `executed`, zero out `cost_usd`, blank `blocked_by`, or empty
-- the row entirely. UPDATE-to-empty is equivalent to DELETE for tamper
-- purposes, so the guarantee was not delivered.
--
-- Column-level GRANT is the only mechanism that does what the comment promised.
-- Verified after applying: `authenticated` holds UPDATE on exactly two columns.
-- ═══════════════════════════════════════════════════════════════════════════

revoke update on public.ops_audit_log from authenticated;
grant  update (undone_at, undone_by) on public.ops_audit_log to authenticated;

-- ops_control was `for all`, which includes DELETE — an authenticated user
-- could delete the 'global' row outright. Losing it is not "no limits"
-- (loadGuardState refuses to act without it), but deleting the kill switch
-- should not be something the console can do at all.
drop policy if exists ops_control_rw on public.ops_control;

create policy ops_control_read on public.ops_control
  for select to authenticated using (true);

create policy ops_control_update on public.ops_control
  for update to authenticated using (true) with check (true);

-- Subsystems register themselves server-side; the console may add one but never
-- remove one, so a subsystem cannot be made to vanish along with its caps and
-- its history.
create policy ops_control_insert on public.ops_control
  for insert to authenticated with check (true);
