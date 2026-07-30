-- ═══════════════════════════════════════════════════════════════════════════
-- Close the self-bootstrap hole in sync.is_owner().
--
-- 20260729044944 defined the gate with three arms, and its comment justified
-- them like this:
--
--     Self-bootstrapping so a mis-seeded allowlist can never lock the real
--     owner out: whoever already owns Board Room rows in this project is the
--     owner. A stranger who signs up with the public key owns none, so they
--     fail every arm.
--
-- The last sentence is false, and it is the whole security argument. The two
-- bootstrap arms test for a row the stranger can simply create:
--
--     or exists (select 1 from boardroom.personal_events e where e.user_id = auth.uid())
--     or exists (select 1 from boardroom.app_settings  s where s.user_id = auth.uid())
--
-- boardroom.personal_events and boardroom.app_settings are the PERSONAL tables
-- — keyed on auth.uid() and writable by the signed-in user, by design. So the
-- predicate reduces to "is the caller authenticated and have they ever used the
-- app", which every account satisfies after one insert. It is self-assertable:
-- the subject supplies the evidence.
--
-- Reaching it needs no UI. A signed-in caller POSTs one row to PostgREST with
-- the public publishable key, then calls sync.pentagon() — which gates solely on
-- `if not sync.is_owner() then raise exception` — and receives the org-wide
-- business data: prospects, outreach (including reply_snippet, draft_subject,
-- replied_at), inbound_leads with customer name/email/website, ops_control, and
-- the pipeline summary. Only the 'clients' and 'findings' branches survive,
-- because those are separately scoped by c.user_id = auth.uid().
--
-- The fix is to keep the one arm that is not self-assertable. The lockout worry
-- the bootstrap was written for does not need them: 20260729044944 seeds the
-- owner's row into sync.allowed_emails in the same transaction that creates the
-- table, and sync.allowed_emails is RLS-on-with-no-policies, so it is reachable
-- only by service_role — which the dashboard SQL editor runs as. Recovering
-- from a mis-seeded allowlist is one INSERT from a surface the owner already
-- has, and that surface is not reachable by a stranger holding a public key.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function sync.is_owner()
returns boolean
language sql
stable
security definer
-- search_path stays pinned: a SECURITY DEFINER function that resolves names
-- through the caller's search_path is a privilege-escalation primitive.
set search_path = sync, public, pg_temp
as $$
  select auth.uid() is not null
     and exists (
       select 1
         from sync.allowed_emails a
        where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
     );
$$;

revoke all on function sync.is_owner() from public, anon;
grant execute on function sync.is_owner() to authenticated;

-- Belt and braces: re-assert the owner row. Idempotent, and it means applying
-- this migration can never be the thing that locks the owner out.
insert into sync.allowed_emails (email, note)
values ('cam.carp14@gmail.com', 'owner')
on conflict (email) do nothing;
