-- The evidence lifecycle, enforced by the database.
--
-- Most of the rules about what a piece of evidence is worth live in TypeScript,
-- where they can be explained to the user. Two of them live here, because they
-- are the ones that must hold whatever calls the database:
--
--   * an item past DECLARED has an actual file behind it;
--   * one object belongs to one row.
--
-- The rest of this suite re-checks that adding six columns to `pcn_evidence` in
-- 0016 did not cost it the isolation it had in 0006. A new column is exactly
-- the kind of change that quietly widens a table's exposure, so the policies
-- and the ownership trigger are asserted again against the new shape.

\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('c0000000-0000-0000-0000-00000000000c', null),
  ('d0000000-0000-0000-0000-00000000000d', null);

-- ---------------------------------------------------------------------------
-- 1. A new item is a claim, not a document
-- ---------------------------------------------------------------------------

do $$
declare
  owned_case uuid;
  created    uuid;
  state      evidence_status;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-00000000000c', true);

  insert into pcn_cases (pcn_number, notice_type, procedural_stage, status)
  values ('CM90000001', 'PCN_POSTAL', 'NEW', 'VERIFIED')
  returning id into owned_case;

  insert into pcn_evidence (case_id, user_id, evidence_type)
  values (owned_case, 'c0000000-0000-0000-0000-00000000000c', 'PERMIT')
  returning id into created;

  select status into state from pcn_evidence where id = created;
  assert state = 'DECLARED',
    format('A new evidence row defaulted to %s rather than DECLARED', state);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Anything past DECLARED must have a file behind it
-- ---------------------------------------------------------------------------
--
-- The whole lifecycle rests on "we hold this". A row claiming UPLOADED with no
-- object is a case that believes it has evidence nobody can open.

do $$
declare
  owned_case uuid;
  failed     boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-00000000000c', true);
  select id into owned_case from pcn_cases where pcn_number = 'CM90000001';

  begin
    insert into pcn_evidence (case_id, user_id, evidence_type, status)
    values (owned_case, 'c0000000-0000-0000-0000-00000000000c', 'PERMIT', 'UPLOADED');
  exception when check_violation then
    failed := true;
  end;

  assert failed, 'An UPLOADED evidence row was accepted with no storage path.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Legibility stays inside its vocabulary
-- ---------------------------------------------------------------------------
--
-- `supportsAssessment` refuses an item whose legibility is UNREADABLE. A value
-- outside the vocabulary would pass that check by not matching it, so an
-- illegible photograph recorded as 'poor' or 'BLURRY' would count as support.

do $$
declare
  owned_case uuid;
  failed     boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-00000000000c', true);
  select id into owned_case from pcn_cases where pcn_number = 'CM90000001';

  begin
    insert into pcn_evidence (case_id, user_id, evidence_type, status, storage_path, legibility)
    values (owned_case, 'c0000000-0000-0000-0000-00000000000c', 'PERMIT', 'ANALYSED',
            'c0000000-0000-0000-0000-00000000000c/case/blurry.jpg', 'BLURRY');
  exception when check_violation then
    failed := true;
  end;

  assert failed, 'An unrecognised legibility value was accepted.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. One object, one row
-- ---------------------------------------------------------------------------

do $$
declare
  owned_case uuid;
  failed     boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-00000000000c', true);
  select id into owned_case from pcn_cases where pcn_number = 'CM90000001';

  insert into pcn_evidence (case_id, user_id, evidence_type, status, storage_path)
  values (owned_case, 'c0000000-0000-0000-0000-00000000000c', 'PERMIT', 'UPLOADED',
          'c0000000-0000-0000-0000-00000000000c/case/permit.jpg');

  begin
    insert into pcn_evidence (case_id, user_id, evidence_type, status, storage_path)
    values (owned_case, 'c0000000-0000-0000-0000-00000000000c', 'PAYMENT_RECEIPT', 'UPLOADED',
            'c0000000-0000-0000-0000-00000000000c/case/permit.jpg');
  exception when unique_violation then
    failed := true;
  end;

  assert failed, 'Two rows were allowed to point at the same stored object.';

  -- Several DECLARED rows have no path at all, and the index must not treat
  -- those as duplicates of each other.
  insert into pcn_evidence (case_id, user_id, evidence_type)
  values (owned_case, 'c0000000-0000-0000-0000-00000000000c', 'BLUE_BADGE'),
         (owned_case, 'c0000000-0000-0000-0000-00000000000c', 'CORRESPONDENCE');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Readings and confirmations belong to their owner and nobody else
-- ---------------------------------------------------------------------------
--
-- `analysis` and `verified_facts` hold the contents of somebody's documents:
-- registrations, permit numbers, badge serials. The row-level policy is what
-- keeps them private, and adding the columns must not have changed that.

do $$
declare
  owned_case uuid;
  visible    integer;
  touched    integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-00000000000c', true);
  select id into owned_case from pcn_cases where pcn_number = 'CM90000001';

  update pcn_evidence
     set status = 'VERIFIED',
         legibility = 'CLEAR',
         analysis = '{"legibility":"CLEAR","observations":[],"unreadableRegions":[]}'::jsonb,
         verified_facts = '[{"field":"VEHICLE_REGISTRATION","value":"AB12CDE"}]'::jsonb
   where storage_path = 'c0000000-0000-0000-0000-00000000000c/case/permit.jpg';

  -- Now as somebody else entirely.
  perform set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-00000000000d', true);

  select count(*) into visible from pcn_evidence;
  assert visible = 0,
    format('User D can see %s of user C evidence rows', visible);

  update pcn_evidence set verified_facts = '[]'::jsonb where true;
  get diagnostics touched = row_count;
  assert touched = 0, format('User D changed %s of user C evidence rows', touched);

  delete from pcn_evidence where true;
  get diagnostics touched = row_count;
  assert touched = 0, format('User D deleted %s of user C evidence rows', touched);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Evidence cannot be attached to somebody else's case
-- ---------------------------------------------------------------------------
--
-- RLS alone would allow a row carrying the caller's own user_id and another
-- user's case_id. The 0006 trigger closes that, and it has to keep doing so.

do $$
declare
  other_case uuid;
  failed     boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-00000000000c', true);
  select id into other_case from pcn_cases where pcn_number = 'CM90000001';

  perform set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-00000000000d', true);
  begin
    insert into pcn_evidence (case_id, user_id, evidence_type, status, storage_path)
    values (other_case, 'd0000000-0000-0000-0000-00000000000d', 'PERMIT', 'UPLOADED',
            'd0000000-0000-0000-0000-00000000000d/other/permit.jpg');
  exception when insufficient_privilege or foreign_key_violation then
    failed := true;
  end;

  assert failed, 'User D attached evidence to user C''s case.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Deleting a case takes its evidence with it
-- ---------------------------------------------------------------------------
--
-- Evidence rows carry the contents of the user's documents. A case they delete
-- must not leave those behind.

do $$
declare
  owned_case uuid;
  remaining  integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-00000000000c', true);
  select id into owned_case from pcn_cases where pcn_number = 'CM90000001';

  delete from pcn_cases where id = owned_case;

  set local role postgres;
  select count(*) into remaining from pcn_evidence where case_id = owned_case;
  assert remaining = 0,
    format('%s evidence rows outlived the case they belonged to', remaining);
end;
$$;

rollback;

\echo '✓ 07_evidence_lifecycle'
