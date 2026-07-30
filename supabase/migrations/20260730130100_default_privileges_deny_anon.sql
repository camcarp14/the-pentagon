-- ═══════════════════════════════════════════════════════════════════════════
-- 0004 diagnosed the right thing and then subtracted too little.
--
-- Its own comment says Supabase's stock defaults grant ALL on new public tables
-- to `anon` — the key baked into the client bundle — and that "future tables
-- must not re-open it". But the default it altered was only TRUNCATE:
--
--     alter default privileges in schema public revoke truncate on tables from anon, authenticated;
--
-- SELECT/INSERT/UPDATE/DELETE stayed in the default grant, so every future
-- table still ships anon-writable unless the migration that creates it
-- remembers to say so by hand. 0005 proves the shape of it: it had to spend two
-- lines undoing the inherited grant on content_drafts. Nothing forces the next
-- migration to remember, and forgetting fails open.
--
-- No table that exists today is exposed — each one carries its own explicit
-- revoke, and 0005's policy denies anon on top of that. This is about which way
-- the default fails when someone forgets.
--
-- `authenticated` keeps its default grants (0004's TRUNCATE revoke still
-- stands): real signed-in traffic goes through PostgREST as that role and is
-- contained by RLS, which is a barrier `anon` should not be the last line of.
-- ═══════════════════════════════════════════════════════════════════════════

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
