-- ═══════════════════════════════════════════════════════════════════════════
-- 0004 — TRUNCATE BYPASSES RLS. Close it.
--
-- This is the same mistake as 0001, made a second time, and it defeats 0002's
-- fix rather than sitting beside it.
--
--   0001 assumed "no DELETE policy" meant the audit log could not be emptied.
--        Wrong: RLS is row-level and cannot restrict columns, so UPDATE could
--        blank every row. 0002 fixed that with a column-level GRANT.
--   0004 (this file) closes the hole BOTH of those missed: PostgreSQL does not
--        apply row-level security to TRUNCATE at all. It is gated purely by the
--        TRUNCATE table privilege. An RLS-enabled table with zero policies is
--        still fully emptiable by any role holding that privilege.
--
-- Supabase's default privileges grant ALL on new public tables to `anon` and
-- `authenticated`. Every table in this database therefore shipped with TRUNCATE
-- granted to both — including `anon`, which is the PUBLIC key baked into the
-- client bundle.
--
-- Verified empirically before writing this, not assumed from the docs: a scratch
-- table with RLS enabled and no policies, holding one row, was emptied by a
-- plain `TRUNCATE` executed as `authenticated`. DELETE was correctly refused by
-- RLS in the same test; TRUNCATE was not.
--
-- Concretely, before this migration:
--   * the audit log described as "append-only" could be erased in one statement
--   * the kill switch row that loadGuardState refuses to act without could be
--     erased, by anyone holding the public anon key
--
-- Neither is a row-level question, so no policy could ever have fixed it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Schema-wide: nothing reachable from a browser should ever TRUNCATE ────
-- Deliberately broad. PostgREST does not expose TRUNCATE, so no application
-- code path can be relying on it — this revokes a capability nothing uses and
-- everything was exposed to. The narrower alternative (ops tables only) would
-- have left every business table wipeable and read as if the class of bug had
-- been dealt with.
revoke truncate on all tables in schema public from anon, authenticated;

-- Future tables must not re-open it. Without this, migration 0005 creating a
-- table reintroduces the same hole silently.
alter default privileges in schema public revoke truncate on tables from anon, authenticated;

-- ── 2. The containment tables, tightened to exactly what they need ───────────
-- `anon` has no business touching any of these at all: every one is reached
-- only by an authenticated operator in the Ops console or by the service role
-- in a scheduled function.
revoke all on public.ops_control   from anon;
revoke all on public.ops_audit_log from anon;
revoke all on public.ops_runs      from anon;
revoke all on public.zts_store_daily from anon;

-- ops_audit_log — append-only, for real this time. The only mutation an
-- operator may perform is marking an entry undone, which 0002 already narrowed
-- to two columns; that column-level grant is re-stated here because `revoke
-- all` above and below would otherwise silently drop it.
revoke all on public.ops_audit_log from authenticated;
grant select on public.ops_audit_log to authenticated;
grant update (undone_at, undone_by) on public.ops_audit_log to authenticated;

-- ops_control — the console reads it, updates settings, and registers a
-- subsystem. It may never remove one, and may never empty the table.
revoke all on public.ops_control from authenticated;
grant select, insert, update on public.ops_control to authenticated;

-- ops_runs — history. Written only by the service role.
revoke all on public.ops_runs from authenticated;
grant select on public.ops_runs to authenticated;

-- zts_store_daily — derived store facts. Read-only to the operator; if it is
-- wrong the fix is to re-run ingestion, not to hand-edit it.
revoke all on public.zts_store_daily from authenticated;
grant select on public.zts_store_daily to authenticated;

-- `service_role` is untouched throughout. It bypasses RLS by design and is what
-- the scheduled functions run as; the guard, not the grant, is what contains it.
