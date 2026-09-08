-- Defence Pack ownership and versioning.
--
-- A pack is the most sensitive thing on a case: it contains the notice details,
-- the user's own account of what happened, what their documents say, and a
-- letter written in their name. The row policy from 0006 is what keeps it
-- private, and 0018 adds columns to a table that has never been written to —
-- exactly the circumstance where a policy is assumed to work rather than known
-- to.
--
-- These inserts use the columns the application sends and no others, which is
-- the mistake 07 was written without and the evidence upload shipped with.

\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('e0000000-0000-0000-0000-00000000000e', null),
  ('f0000000-0000-0000-0000-00000000000f', null);

-- ---------------------------------------------------------------------------
-- 1. A pack is written the way the application writes one
-- ---------------------------------------------------------------------------

do $$
declare
  owned_case uuid;
  created    uuid;
  owner      uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-00000000000e', true);

  insert into pcn_cases (pcn_number, notice_type, procedural_stage, status)
  values ('WM90000001', 'PCN_POSTAL', 'NEW', 'ASSESSED')
  returning id into owned_case;

  -- No user_id: 0018 gives the column the auth.uid() default, as 0017 did for
  -- evidence. An insert that omits it is attributed, not refused.
  insert into pcn_drafts
    (case_id, draft_kind, pack, generated_body, case_fingerprint, evidence_fingerprint,
     engine_version, version)
  values
    (owned_case, 'DEFENCE_PACK',
     '{"caseSummary":{"pcnNumberMasked":"WM****901"}}'::jsonb,
     'Dear Sir or Madam, I am writing about the notice above.',
     'case-abc', 'ev-abc', 'defence-1.0.0', 1)
  returning id into created;

  select user_id into owner from pcn_drafts where id = created;
  assert owner = 'e0000000-0000-0000-0000-00000000000e',
    format('A pack written with no user_id was attributed to %s', owner);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. One current pack per case
-- ---------------------------------------------------------------------------
--
-- A regeneration replaces; it does not accumulate drafts nobody asked for and
-- nothing can then tell apart.

do $$
declare
  owned_case uuid;
  failed     boolean := false;
  remaining  integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-00000000000e', true);
  select id into owned_case from pcn_cases where pcn_number = 'WM90000001';

  begin
    insert into pcn_drafts (case_id, draft_kind, generated_body)
    values (owned_case, 'DEFENCE_PACK', 'a second pack');
  exception when unique_violation then
    failed := true;
  end;

  assert failed, 'A second Defence Pack was created for the same case.';

  -- The upsert path the application uses does replace it.
  insert into pcn_drafts (case_id, draft_kind, generated_body, version)
  values (owned_case, 'DEFENCE_PACK', 'the rebuilt pack', 2)
  on conflict (case_id, draft_kind) do update
    set generated_body = excluded.generated_body, version = excluded.version;

  select count(*) into remaining from pcn_drafts where case_id = owned_case;
  assert remaining = 1, format('Expected one pack after a rebuild, found %s', remaining);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Nobody else can read it, edit it or delete it
-- ---------------------------------------------------------------------------
--
-- The letter is written in somebody's name and the pack quotes their account of
-- their own life. This is the test that matters most in this file.

do $$
declare
  visible integer;
  touched integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-00000000000f', true);

  select count(*) into visible from pcn_drafts;
  assert visible = 0, format('User F can see %s of user E''s packs', visible);

  update pcn_drafts set edited_body = 'replaced by a stranger' where true;
  get diagnostics touched = row_count;
  assert touched = 0, format('User F edited %s of user E''s packs', touched);

  delete from pcn_drafts where true;
  get diagnostics touched = row_count;
  assert touched = 0, format('User F deleted %s of user E''s packs', touched);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. A pack cannot be attached to somebody else's case
-- ---------------------------------------------------------------------------

do $$
declare
  other_case uuid;
  failed     boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-00000000000e', true);
  select id into other_case from pcn_cases where pcn_number = 'WM90000001';

  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-00000000000f', true);
  begin
    insert into pcn_drafts (case_id, draft_kind, generated_body)
    values (other_case, 'DEFENCE_PACK', 'a pack on somebody else''s case');
  exception when insufficient_privilege or foreign_key_violation or unique_violation then
    failed := true;
  end;

  assert failed, 'User F attached a Defence Pack to user E''s case.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Deleting a case takes its pack with it
-- ---------------------------------------------------------------------------

do $$
declare
  owned_case uuid;
  remaining  integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-00000000000e', true);
  select id into owned_case from pcn_cases where pcn_number = 'WM90000001';

  delete from pcn_cases where id = owned_case;

  set local role postgres;
  select count(*) into remaining from pcn_drafts where case_id = owned_case;
  assert remaining = 0,
    format('%s Defence Packs outlived the case they belonged to', remaining);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Where the notice details came from
-- ---------------------------------------------------------------------------
--
-- A scanned notice is a document PCNWatch read and the user confirmed field by
-- field; an evidence upload is something they later attached as support. The
-- Defence Pack needs the difference, and a case that says nothing must default
-- to the weaker claim rather than to "we hold the notice".

do $$
declare
  scanned uuid;
  typed   uuid;
  source  text;
  failed  boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-00000000000e', true);

  -- Saying nothing means typed in.
  insert into pcn_cases (pcn_number, notice_type, procedural_stage, status)
  values ('WM90000002', 'PCN_POSTAL', 'NEW', 'VERIFIED')
  returning id into typed;
  select notice_source into source from pcn_cases where id = typed;
  assert source = 'MANUAL', format('A case that said nothing defaulted to %s', source);

  insert into pcn_cases (pcn_number, notice_type, procedural_stage, status, notice_source)
  values ('WM90000003', 'PCN_POSTAL', 'NEW', 'VERIFIED', 'SCANNED')
  returning id into scanned;
  select notice_source into source from pcn_cases where id = scanned;
  assert source = 'SCANNED', format('A scanned case recorded %s', source);

  -- And the column is a closed pair, so a typo cannot invent a third meaning
  -- that reads as neither.
  begin
    update pcn_cases set notice_source = 'UPLOADED' where id = typed;
  exception when check_violation then
    failed := true;
  end;
  assert failed, 'An unrecognised notice source was accepted.';
end;
$$;

rollback;

\echo '✓ 08_defence_pack'
