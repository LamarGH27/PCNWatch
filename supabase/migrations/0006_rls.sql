-- FineRadar schema — 0006: row level security.
--
-- Policy model:
--   * Public enforcement aggregates are readable by anyone, including anonymous.
--   * Everything belonging to a user is readable and writable ONLY by that user.
--   * Nothing user-owned is writable by anon.
--   * Entitlements and payments are read-only to the owner; only the service role
--     (the Stripe webhook) may write them. This is what makes a success redirect
--     insufficient to unlock a product.
--
-- Every user-owned table carries its own user_id column rather than joining up to
-- pcn_cases, so each policy is a single index-backed predicate.

-- ---------------------------------------------------------------------------
-- Public read: reference and enforcement aggregates
-- ---------------------------------------------------------------------------

alter table data_sources            enable row level security;
alter table source_versions         enable row level security;
alter table authorities             enable row level security;
alter table authority_data_sources  enable row level security;
alter table contravention_codes     enable row level security;
alter table authority_procedures    enable row level security;
alter table parking_locations       enable row level security;
alter table road_segments           enable row level security;
alter table pcn_activity_aggregates enable row level security;
alter table pcn_activity_scores     enable row level security;
alter table products                enable row level security;
alter table dtro_records            enable row level security;
alter table dtro_restrictions       enable row level security;

create policy "public read data_sources"            on data_sources            for select using (true);
create policy "public read source_versions"         on source_versions         for select using (true);
create policy "public read authorities"             on authorities             for select using (true);
create policy "public read authority_data_sources"  on authority_data_sources  for select using (true);
create policy "public read contravention_codes"     on contravention_codes     for select using (true);
create policy "public read authority_procedures"    on authority_procedures    for select using (true);
create policy "public read parking_locations"       on parking_locations       for select using (true);
create policy "public read road_segments"           on road_segments           for select using (true);
create policy "public read pcn_activity_aggregates" on pcn_activity_aggregates for select using (true);
create policy "public read pcn_activity_scores"     on pcn_activity_scores     for select using (true);
create policy "public read active products"         on products                for select using (active);
create policy "public read dtro_records"            on dtro_records            for select using (true);
create policy "public read dtro_restrictions"       on dtro_restrictions       for select using (true);

-- pcn_events holds one row per issued PCN. Even stripped of personal fields it is
-- not exposed to clients: the map and hotspot pages read aggregates only.
alter table pcn_events enable row level security;
-- No policy is created, so only the service role can read it.

-- Ingestion internals are operational data, not public.
alter table ingestion_runs   enable row level security;
alter table ingestion_errors enable row level security;
alter table ai_logs          enable row level security;
alter table audit_events     enable row level security;
alter table rate_limit_counters enable row level security;
-- No policies: service role only.

-- ---------------------------------------------------------------------------
-- User-owned data
-- ---------------------------------------------------------------------------

alter table profiles                enable row level security;
alter table vehicles                enable row level security;
alter table pcn_cases               enable row level security;
alter table pcn_documents           enable row level security;
alter table pcn_evidence            enable row level security;
alter table pcn_deadlines           enable row level security;
alter table pcn_assessments         enable row level security;
alter table pcn_assessment_findings enable row level security;
alter table pcn_drafts              enable row level security;
alter table case_events             enable row level security;
alter table payments                enable row level security;
alter table entitlements            enable row level security;
alter table subscriptions           enable row level security;

create policy "own profile" on profiles
  for all to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Full CRUD for the owner, on every table keyed by user_id.
do $$
declare
  t text;
begin
  foreach t in array array[
    'vehicles',
    'pcn_cases',
    'pcn_documents',
    'pcn_evidence',
    'pcn_deadlines',
    'pcn_assessments',
    'pcn_assessment_findings',
    'pcn_drafts',
    'case_events'
  ]
  loop
    execute format($f$
      create policy "own rows %1$s" on %1$I
        for all to authenticated
        using (user_id = (select auth.uid()))
        with check (user_id = (select auth.uid()))
    $f$, t);
  end loop;
end;
$$;

-- Payments, entitlements and subscriptions: the owner may look, never touch.
-- Writes come from the Stripe webhook running as the service role, which bypasses
-- RLS. A client cannot insert an entitlement for itself.
create policy "read own payments" on payments
  for select to authenticated using (user_id = (select auth.uid()));

create policy "read own entitlements" on entitlements
  for select to authenticated using (user_id = (select auth.uid()));

create policy "read own subscriptions" on subscriptions
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Referential integrity between user_id and the owning case
-- ---------------------------------------------------------------------------
--
-- RLS alone would let a user attach a row to their own user_id but another user's
-- case_id. These triggers close that gap.

create or replace function assert_case_belongs_to_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  if new.case_id is null then
    return new;
  end if;
  select user_id into owner from pcn_cases where id = new.case_id;
  if owner is null then
    raise exception 'Case % does not exist', new.case_id using errcode = '23503';
  end if;
  if owner <> new.user_id then
    raise exception 'Case % does not belong to user %', new.case_id, new.user_id
      using errcode = '42501';
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'pcn_documents',
    'pcn_evidence',
    'pcn_deadlines',
    'pcn_assessments',
    'pcn_drafts',
    'case_events'
  ]
  loop
    execute format(
      'create trigger assert_case_owner_%1$s before insert or update on %1$I
         for each row execute function assert_case_belongs_to_user()',
      t
    );
  end loop;
end;
$$;

-- Findings hang off an assessment rather than a case directly.
create or replace function assert_assessment_belongs_to_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  select user_id into owner from pcn_assessments where id = new.assessment_id;
  if owner is null then
    raise exception 'Assessment % does not exist', new.assessment_id using errcode = '23503';
  end if;
  if owner <> new.user_id then
    raise exception 'Assessment % does not belong to user %', new.assessment_id, new.user_id
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger assert_assessment_owner
  before insert or update on pcn_assessment_findings
  for each row execute function assert_assessment_belongs_to_user();

-- ---------------------------------------------------------------------------
-- Private document storage
-- ---------------------------------------------------------------------------
--
-- Buckets are private. Object paths are "<user_id>/<case_id>/<filename>" so the
-- owning user is the first path segment and policies can check it without a join.

-- Supabase enables RLS on storage.objects by default, but we never rely on a
-- platform default for a security boundary: without this the policies below are
-- decorative and every signed-in user can read every stored document.
alter table storage.objects enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('pcn-documents', 'pcn-documents', false, 12582912,
   array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  ('pcn-evidence', 'pcn-evidence', false, 12582912,
   array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

do $$
declare
  b text;
begin
  foreach b in array array['pcn-documents', 'pcn-evidence']
  loop
    execute format($f$
      create policy "own objects read %1$s" on storage.objects
        for select to authenticated
        using (bucket_id = %1$L and (storage.foldername(name))[1] = (select auth.uid())::text)
    $f$, b);
    execute format($f$
      create policy "own objects write %1$s" on storage.objects
        for insert to authenticated
        with check (bucket_id = %1$L and (storage.foldername(name))[1] = (select auth.uid())::text)
    $f$, b);
    execute format($f$
      create policy "own objects delete %1$s" on storage.objects
        for delete to authenticated
        using (bucket_id = %1$L and (storage.foldername(name))[1] = (select auth.uid())::text)
    $f$, b);
  end loop;
end;
$$;
