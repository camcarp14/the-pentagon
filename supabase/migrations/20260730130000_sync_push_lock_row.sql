-- ═══════════════════════════════════════════════════════════════════════════
-- sync.push() could lose a whole document under concurrent pushes.
--
-- 20260729044345 read the current row without a lock:
--
--     select * into cur from sync.state where user_id = uid;
--     ... if p_rev <> cur.rev then return not-accepted ...
--     update sync.state set rev = cur.rev + 1 where user_id = uid;
--
-- The rev guard is evaluated against a snapshot, and the UPDATE's predicate is
-- only `user_id = uid`. Two devices holding rev 5 that push in the same instant
-- both read cur.rev = 5, both pass the guard, and both reach the UPDATE. Under
-- READ COMMITTED the second waits on the row lock, then re-checks only
-- `user_id = uid` — still true — and writes rev = 5 + 1 from its own stale
-- snapshot. rev goes 5 -> 6 twice, the first pusher's doc is gone, and both
-- callers are told `accepted: true`, so each sets localRev and reports
-- "synced". The loss is silent and permanent — exactly the clobber this
-- function exists to refuse.
--
-- Taking the row lock on the read serialises the two transactions: the second
-- one blocks until the first commits, then re-reads rev = 6 and returns the
-- not-accepted conflict payload with the newer doc, which is what the client
-- already knows how to reconcile.
--
-- Only the SELECT changes; the body is otherwise identical to 20260729044345.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function sync.push(p_doc jsonb, p_rev bigint, p_device text default '')
returns jsonb
language plpgsql
security invoker
set search_path = sync, public, pg_temp
as $$
declare
  cur sync.state;
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  -- for update: the rev check below is only honest if nobody can advance the
  -- row between the read and the write.
  select * into cur from sync.state where user_id = uid for update;

  if cur.user_id is null then
    insert into sync.state (user_id, doc, rev, device)
    values (uid, p_doc, 1, coalesce(p_device, ''))
    returning * into cur;
    return jsonb_build_object('accepted', true, 'rev', cur.rev, 'updated_at', cur.updated_at);
  end if;

  if p_rev is null or p_rev <> cur.rev then
    return jsonb_build_object(
      'accepted', false, 'rev', cur.rev, 'doc', cur.doc,
      'device', cur.device, 'updated_at', cur.updated_at
    );
  end if;

  update sync.state
     set doc = p_doc,
         rev = cur.rev + 1,
         device = coalesce(p_device, ''),
         updated_at = now()
   where user_id = uid
  returning * into cur;

  return jsonb_build_object('accepted', true, 'rev', cur.rev, 'updated_at', cur.updated_at);
end;
$$;

grant execute on function sync.push(jsonb, bigint, text) to authenticated;
