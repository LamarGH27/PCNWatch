-- Anonymous case ownership.
--
-- PCNWatch saves a case before it knows who the user is, by creating a Supabase
-- anonymous user and letting the case belong to that. These assert that doing so
-- did not cost anything: an anonymous identity is a real `auth.users` row with
-- the `authenticated` role, so the policy written in 0006 applies to it
-- unchanged, and nothing was granted to `anon` to make it work.
--
-- Every block sets the JWT claims Supabase would set for the request. A failure
-- raises and aborts the script.

\set ON_ERROR_STOP on

begin;

-- Two anonymous users. Supabase marks these with `is_anonymous`, which the shim
-- does not model; what matters here is that they are ordinary auth.users rows
-- and carry the `authenticated` role, exactly as the real ones do.
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-00000000000a', null),
  ('b0000000-0000-0000-0000-00000000000b', null);

-- ---------------------------------------------------------------------------
-- 1. An anonymous user can create their own case, without naming themselves
-- ---------------------------------------------------------------------------

do $$
declare
  created uuid;
  owner   uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);

  -- No user_id in the insert. The column defaults to auth.uid(), so the owner
  -- comes from the session rather than from anything the client sent.
  insert into pcn_cases (pcn_number, notice_type, procedural_stage, status)
  values ('WM11112222', 'PCN_POSTAL', 'NEW', 'VERIFIED')
  returning id into created;

  select user_id into owner from pcn_cases where id = created;
  assert owner = 'a0000000-0000-0000-0000-00000000000a',
    format('A case created by A is owned by %s', owner);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. A user cannot create a case owned by somebody else
-- ---------------------------------------------------------------------------

do $$
declare
  refused boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);

  begin
    -- Naming B as the owner. The WITH CHECK clause is what refuses this; the
    -- default only covers the case where nothing was named.
    insert into pcn_cases (user_id, pcn_number, notice_type, procedural_stage)
    values ('b0000000-0000-0000-0000-00000000000b', 'WM99998888', 'PCN_POSTAL', 'NEW');
  exception when insufficient_privilege then
    refused := true;
  end;

  assert refused, 'A was able to create a case owned by B';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. A can read and update their own case; B can do neither
-- ---------------------------------------------------------------------------

do $$
declare
  a_case   uuid;
  visible  integer;
  affected integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);
  select id into a_case from pcn_cases where pcn_number = 'WM11112222';

  select count(*) into visible from pcn_cases where id = a_case;
  assert visible = 1, 'A cannot see their own case';

  update pcn_cases set location_text = 'STRAND' where id = a_case;
  get diagnostics affected = row_count;
  assert affected = 1, 'A cannot update their own case';

  -- Now as B, who knows the id. This is the URL-manipulation case: guessing or
  -- being told a case id must not be enough to reach it.
  perform set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-00000000000b', true);

  select count(*) into visible from pcn_cases where id = a_case;
  assert visible = 0, format('B can see A''s case (%s rows)', visible);

  update pcn_cases set location_text = 'HACKED' where id = a_case;
  get diagnostics affected = row_count;
  assert affected = 0, 'B was able to update A''s case';

  delete from pcn_cases where id = a_case;
  get diagnostics affected = row_count;
  assert affected = 0, 'B was able to delete A''s case';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The update did not silently become an insert
-- ---------------------------------------------------------------------------

do $$
declare
  total integer;
begin
  set local role postgres;
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into total from pcn_cases where pcn_number in ('WM11112222', 'WM99998888', 'HACKED');
  assert total = 1, format('Expected exactly one case to exist, found %s', total);

  -- And A's data is as A left it.
  perform 1 from pcn_cases where pcn_number = 'WM11112222' and location_text = 'STRAND';
  assert found, 'A''s case was modified by B or lost its own update';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. An unauthenticated request reaches nothing
-- ---------------------------------------------------------------------------

do $$
declare
  visible integer;
begin
  -- The `anon` role is what a request with no session carries. The policy is
  -- written `to authenticated`, so anon is not merely filtered — it has no
  -- policy at all, and no grant either.
  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);

  begin
    select count(*) into visible from pcn_cases;
  exception when insufficient_privilege then
    visible := -1;
  end;

  assert visible <= 0, format('An unauthenticated request saw %s cases', visible);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. A signed-in user with no cases sees an empty list, not an error
-- ---------------------------------------------------------------------------

do $$
declare
  visible integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-00000000000b', true);
  select count(*) into visible from pcn_cases;
  assert visible = 0, format('B should see no cases, saw %s', visible);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Several cases per user, isolated from each other's owners
-- ---------------------------------------------------------------------------

do $$
declare
  mine integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);
  insert into pcn_cases (pcn_number, notice_type, procedural_stage)
  values ('WM33334444', 'PCN_ON_STREET', 'NEW'), ('WM55556666', 'NOTICE_TO_OWNER', 'NOTICE_TO_OWNER');

  select count(*) into mine from pcn_cases;
  assert mine = 3, format('A should now have 3 cases, has %s', mine);

  perform set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-00000000000b', true);
  select count(*) into mine from pcn_cases;
  assert mine = 0, format('B should still see nothing, sees %s', mine);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. The narrative has nowhere to go
-- ---------------------------------------------------------------------------

do $$
declare
  present integer;
begin
  set local role postgres;
  select count(*) into present
  from information_schema.columns
  where table_name = 'pcn_cases' and column_name = 'user_narrative';

  -- Migration 0014 dropped it. A privacy boundary enforced by the schema cannot
  -- be forgotten by a future code path the way a convention can.
  assert present = 0, 'pcn_cases still has a column the user''s account could be written to';
end;
$$;

rollback;

\echo '✓ anonymous case ownership'
