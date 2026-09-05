-- Storage readiness and object isolation.
--
-- 0006 cannot create the storage.objects policies on hosted Supabase, because
-- that table is owned by the platform. It therefore attempts them, tolerates the
-- privilege error, and reports the truth through pcnwatch_storage_readiness().
-- This suite pins both halves of that contract: the report must be honest, and
-- the policies, however they were created, must actually isolate users.

\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@example.test'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@example.test')
on conflict (id) do nothing;

insert into storage.objects (bucket_id, name, owner) values
  ('pcn-documents', 'aaaaaaaa-0000-0000-0000-000000000001/case-a/notice.pdf',
   'aaaaaaaa-0000-0000-0000-000000000001'),
  ('pcn-evidence',  'bbbbbbbb-0000-0000-0000-000000000002/case-b/photo.jpg',
   'bbbbbbbb-0000-0000-0000-000000000002')
on conflict do nothing;

-- 1. The readiness report describes the catalogue, not the migration's hopes.
do $$
declare r record;
begin
  select * into r from pcnwatch_storage_readiness();

  if not r.rls_enabled then
    raise exception 'RLS is not enabled on storage.objects';
  end if;
  if r.buckets_present <> 2 then
    raise exception 'Expected both private buckets, found %', r.buckets_present;
  end if;
  if not r.buckets_private then
    raise exception 'A PCNWatch bucket is public. Documents would be readable by URL.';
  end if;
  if r.policies_present <> r.policies_expected then
    raise exception 'Storage policies missing: %', r.missing;
  end if;
  if not r.ready then
    raise exception 'Readiness reported false with every component present.';
  end if;
  raise notice 'Storage readiness reports ready with all 6 policies present.';
end;
$$;

-- 2. Readiness must go false when a policy disappears — otherwise the
--    application would keep accepting uploads into an unprotected bucket.
--    Destructive, so it runs inside a transaction that is rolled back; the
--    fixtures above must survive it for the isolation check below.
begin;

do $$
declare r record;
begin
  drop policy if exists "own objects read pcn-documents" on storage.objects;
  select * into r from pcnwatch_storage_readiness();
  if r.ready then
    raise exception 'Readiness still true with a policy removed.';
  end if;
  if not ('own objects read pcn-documents' = any(r.missing)) then
    raise exception 'Readiness did not name the missing policy: %', r.missing;
  end if;
  raise notice 'Readiness goes false and names the missing policy.';
exception
  when insufficient_privilege then
    raise notice 'Skipped: cannot drop a storage policy as this role (hosted Supabase).';
end;
$$;

rollback;

-- 3. Isolation: one user must never see another's objects.
do $$
declare a_sees int; b_sees int; leaked int;
begin
  set local role authenticated;

  perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);
  select count(*) into a_sees from storage.objects
   where name like 'aaaaaaaa-0000-0000-0000-000000000001/%';
  select count(*) into leaked from storage.objects
   where name like 'bbbbbbbb-0000-0000-0000-000000000002/%';

  perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', true);
  select count(*) into b_sees from storage.objects
   where name like 'bbbbbbbb-0000-0000-0000-000000000002/%';

  reset role;

  if leaked <> 0 then
    raise exception 'User A can see % of User B''s objects.', leaked;
  end if;
  if a_sees < 1 or b_sees < 1 then
    raise exception 'A user cannot see their own objects (a=%, b=%).', a_sees, b_sees;
  end if;
  raise notice 'Isolation holds: A sees own %, B sees own %, cross-user reads %.', a_sees, b_sees, leaked;
end;
$$;

-- Fixtures are removed so the suite leaves nothing behind.
delete from storage.objects
 where name like 'aaaaaaaa-0000-0000-0000-000000000001/%'
    or name like 'bbbbbbbb-0000-0000-0000-000000000002/%';
delete from auth.users
 where id in ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');

\echo 'STORAGE READINESS TESTS PASSED'
