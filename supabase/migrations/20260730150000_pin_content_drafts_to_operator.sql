-- ═══════════════════════════════════════════════════════════════════════════
-- 20260730140000 pinned ops_control, ops_audit_log and inbound_leads, and
-- missed this one.
--
-- content_drafts is the tier-2 publish queue: the row an operator approves is
-- exactly what queue-execute pushes to the live Shopify blog. Write access to
-- it is write access to the public site, one approve away.
--
-- Its policy was the form 0005 originally shipped:
--
--     for all to public using (auth.role() = 'authenticated')
--
-- which is the same "authenticated is the operator" mistake as the other three,
-- just spelled differently — and spelled in a way Supabase's rls_policy_always_true
-- linter does not flag, because it only looks for a literal `true`. Any account
-- holding a session could edit a draft's body_html before approval, or move a
-- row's status onto the publish path.
--
-- The engines are unaffected: content-engine writes with the service role,
-- which bypasses RLS entirely.
--
-- NOTE — the same `auth.role() = 'authenticated'` shape remains on the core
-- Clarify tables (prospects, contacts, outreach, messages, sequences,
-- sequence_steps, sequence_enrollments, prospecting_runs, tone_memory,
-- app_settings, tracked_links, audit_requests, email_events). That is a
-- deliberate, documented architecture — 20260729044944's header calls those
-- tables "org-wide with auth.role() = 'authenticated' policies, meaning ANY
-- signed-in account can read them", which is the whole reason sync.pentagon()
-- exists to narrow access rather than widen it. Whether that is safe rests
-- entirely on signups being closed on this project, which is a dashboard
-- setting and not visible from SQL. It is left alone here on purpose: pinning
-- thirteen tables that the entire CRM reads and writes is an architecture
-- change, not a bug fix, and belongs behind a deliberate decision.
-- ═══════════════════════════════════════════════════════════════════════════

drop policy if exists content_drafts_authenticated on public.content_drafts;
create policy content_drafts_operator on public.content_drafts
  for all to authenticated
  using (public.is_operator()) with check (public.is_operator());
