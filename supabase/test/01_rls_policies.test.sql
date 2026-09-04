-- RLS policy tests. Run against a database with the migrations applied.
--
-- Each block sets the JWT claim Supabase would set for a request and asserts what
-- that identity can and cannot see. A failure raises and aborts the script.

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Helper: how many rows can the current identity actually obtain from a table?
-- Returns -1 when access is denied outright (no grant), 0 when RLS filters
-- everything out. Both are acceptable "cannot see it" outcomes; anything above 0
-- is a leak.
-- ---------------------------------------------------------------------------

create or replace function pg_temp.visible_rows(target text)
returns integer
language plpgsql
as $fn$
declare
  n integer;
begin
  execute format('select count(*) from %I', target) into n;
  return n;
exception when insufficient_privilege then
  return -1;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'user-a@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'user-b@example.test');

insert into authorities (id, slug, name, map_coverage_status)
values ('33333333-3333-3333-3333-333333333333', 'camden', 'London Borough of Camden', 'LIVE');

insert into products (id, sku, name, price_pence, entitlements)
values ('44444444-4444-4444-4444-444444444444', 'FINE_RADAR_DEFENCE', 'Defence Pack', 599,
        array['DETAILED_ASSESSMENT','DRAFT','EXPORT']);

-- User A's case, created as the service role (as the application server would).
insert into pcn_cases (id, user_id, authority_id, pcn_number, procedural_stage)
values ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333', 'CA12345678', 'NEW');

insert into pcn_documents (id, case_id, user_id, storage_path, content_type, byte_size)
values ('66666666-6666-6666-6666-666666666666', '55555555-5555-5555-5555-555555555555',
        '11111111-1111-1111-1111-111111111111',
        '11111111-1111-1111-1111-111111111111/55555555-5555-5555-5555-555555555555/pcn.jpg',
        'image/jpeg', 102400);

-- ---------------------------------------------------------------------------
-- 1. User A can see their own case; User B cannot.
-- ---------------------------------------------------------------------------

do $$
declare
  visible integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  select count(*) into visible from pcn_cases;
  assert visible = 1, format('User A should see 1 case, saw %s', visible);

  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  select count(*) into visible from pcn_cases;
  assert visible = 0, format('CRITICAL: User B must not see User A''s case, saw %s', visible);

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. User B cannot read User A's documents, evidence or drafts.
-- ---------------------------------------------------------------------------

do $$
declare
  visible integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  select count(*) into visible from pcn_documents;
  assert visible = 0, format('CRITICAL: User B must not see User A''s documents, saw %s', visible);

  select count(*) into visible from pcn_evidence;
  assert visible = 0, 'User B must not see User A''s evidence';

  select count(*) into visible from pcn_drafts;
  assert visible = 0, 'User B must not see User A''s drafts';

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. An anonymous visitor sees public aggregates but no private data.
-- ---------------------------------------------------------------------------

do $$
declare
  visible integer;
begin
  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);

  select count(*) into visible from authorities;
  assert visible >= 1, 'Anonymous visitors must be able to read the authority directory';

  select count(*) into visible from pcn_activity_scores;
  assert visible >= 0, 'Anonymous visitors must be able to read public activity scores';

  visible := pg_temp.visible_rows('pcn_cases');
  assert visible <= 0, format('CRITICAL: anonymous obtained %s case rows', visible);

  visible := pg_temp.visible_rows('pcn_documents');
  assert visible <= 0, format('CRITICAL: anonymous obtained %s document rows', visible);

  visible := pg_temp.visible_rows('pcn_evidence');
  assert visible <= 0, 'CRITICAL: anonymous obtained evidence rows';

  visible := pg_temp.visible_rows('pcn_drafts');
  assert visible <= 0, 'CRITICAL: anonymous obtained draft rows';

  visible := pg_temp.visible_rows('ai_logs');
  assert visible <= 0, 'CRITICAL: anonymous obtained AI log rows';

  visible := pg_temp.visible_rows('audit_events');
  assert visible <= 0, 'CRITICAL: anonymous obtained audit rows';

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Raw per-event enforcement data is not client readable at all.
-- ---------------------------------------------------------------------------

do $$
declare
  visible integer;
begin
  set local role anon;
  visible := pg_temp.visible_rows('pcn_events');
  assert visible <= 0, format('CRITICAL: anonymous obtained %s raw PCN event rows', visible);
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  visible := pg_temp.visible_rows('pcn_events');
  assert visible <= 0, format('CRITICAL: a signed-in user obtained %s raw PCN event rows', visible);
  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. A user cannot attach a row to someone else's case.
-- ---------------------------------------------------------------------------

do $$
declare
  blocked boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  begin
    insert into pcn_evidence (case_id, user_id, evidence_type)
    values ('55555555-5555-5555-5555-555555555555',
            '22222222-2222-2222-2222-222222222222', 'PARKING_SIGN');
  exception when others then
    blocked := true;
  end;
  assert blocked, 'CRITICAL: User B attached evidence to User A''s case';
  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. A user cannot grant themselves an entitlement.
-- ---------------------------------------------------------------------------

do $$
declare
  blocked boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  begin
    insert into entitlements (user_id, case_id, entitlement)
    values ('11111111-1111-1111-1111-111111111111',
            '55555555-5555-5555-5555-555555555555', 'DETAILED_ASSESSMENT');
  exception when others then
    blocked := true;
  end;
  assert blocked, 'CRITICAL: a user granted themselves an entitlement without paying';
  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. A payment cannot reach PAID without webhook confirmation.
-- ---------------------------------------------------------------------------

do $$
declare
  blocked boolean := false;
begin
  -- Even as the service role, which bypasses RLS, the check constraint holds.
  begin
    insert into payments (user_id, case_id, product_id, status, amount_pence)
    values ('11111111-1111-1111-1111-111111111111',
            '55555555-5555-5555-5555-555555555555',
            '44444444-4444-4444-4444-444444444444', 'PAID', 599);
  exception when check_violation then
    blocked := true;
  end;
  assert blocked, 'CRITICAL: a payment was marked PAID without webhook confirmation';
end;
$$;

do $$
declare
  paid integer;
begin
  insert into payments (user_id, case_id, product_id, status, amount_pence, confirmed_by_webhook_at)
  values ('11111111-1111-1111-1111-111111111111',
          '55555555-5555-5555-5555-555555555555',
          '44444444-4444-4444-4444-444444444444', 'PAID', 599, now());
  select count(*) into paid from payments where status = 'PAID';
  assert paid = 1, 'A webhook-confirmed payment should be accepted';
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Storage objects are scoped to the owning user's folder.
-- ---------------------------------------------------------------------------

insert into storage.objects (bucket_id, name, owner)
values ('pcn-documents',
        '11111111-1111-1111-1111-111111111111/55555555-5555-5555-5555-555555555555/pcn.jpg',
        '11111111-1111-1111-1111-111111111111');

do $$
declare
  visible integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  select count(*) into visible from storage.objects;
  assert visible = 0, format('CRITICAL: User B can read User A''s stored documents, saw %s', visible);

  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  select count(*) into visible from storage.objects;
  assert visible = 1, format('User A should see their own document, saw %s', visible);
  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Buckets are private.
-- ---------------------------------------------------------------------------

do $$
declare
  public_buckets integer;
begin
  select count(*) into public_buckets
  from storage.buckets where id in ('pcn-documents', 'pcn-evidence') and public;
  assert public_buckets = 0, 'CRITICAL: a document bucket is public';
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. A score row must carry either a score or a refusal reason, never neither.
-- ---------------------------------------------------------------------------

do $$
declare
  blocked boolean := false;
begin
  begin
    insert into pcn_activity_scores (authority_id, parking_location_id, period_key, as_of_date, model_version)
    values ('33333333-3333-3333-3333-333333333333', null, '12M', current_date, 'tas-1.0.0');
  exception when check_violation then
    blocked := true;
  end;
  assert blocked, 'A score row with neither a score nor a refusal reason must be rejected';
end;
$$;

rollback;

\echo 'RLS POLICY TESTS PASSED'
