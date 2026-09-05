-- PCNWatch schema — 0006: row level security.
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

drop policy if exists "public read data_sources" on data_sources;
create policy "public read data_sources" on data_sources            for select using (true);
drop policy if exists "public read source_versions" on source_versions;
create policy "public read source_versions" on source_versions         for select using (true);
drop policy if exists "public read authorities" on authorities;
create policy "public read authorities" on authorities             for select using (true);
drop policy if exists "public read authority_data_sources" on authority_data_sources;
create policy "public read authority_data_sources" on authority_data_sources  for select using (true);
drop policy if exists "public read contravention_codes" on contravention_codes;
create policy "public read contravention_codes" on contravention_codes     for select using (true);
drop policy if exists "public read authority_procedures" on authority_procedures;
create policy "public read authority_procedures" on authority_procedures    for select using (true);
drop policy if exists "public read parking_locations" on parking_locations;
create policy "public read parking_locations" on parking_locations       for select using (true);
drop policy if exists "public read road_segments" on road_segments;
create policy "public read road_segments" on road_segments           for select using (true);
drop policy if exists "public read pcn_activity_aggregates" on pcn_activity_aggregates;
create policy "public read pcn_activity_aggregates" on pcn_activity_aggregates for select using (true);
drop policy if exists "public read pcn_activity_scores" on pcn_activity_scores;
create policy "public read pcn_activity_scores" on pcn_activity_scores     for select using (true);
drop policy if exists "public read active products" on products;
create policy "public read active products" on products                for select using (active);
drop policy if exists "public read dtro_records" on dtro_records;
create policy "public read dtro_records" on dtro_records            for select using (true);
drop policy if exists "public read dtro_restrictions" on dtro_restrictions;
create policy "public read dtro_restrictions" on dtro_restrictions       for select using (true);

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

drop policy if exists "own profile" on profiles;
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
    execute format($f$drop policy if exists "own rows %1$s" on %1$I$f$, t);
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
drop policy if exists "read own payments" on payments;
create policy "read own payments" on payments
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "read own entitlements" on entitlements;
create policy "read own entitlements" on entitlements
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "read own subscriptions" on subscriptions;
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
set search_path = public, extensions
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
    execute format('drop trigger if exists assert_case_owner_%1$s on %1$I', t);
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
set search_path = public, extensions
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

drop trigger if exists assert_assessment_owner on pcn_assessment_findings;
create trigger assert_assessment_owner
  before insert or update on pcn_assessment_findings
  for each row execute function assert_assessment_belongs_to_user();

-- ---------------------------------------------------------------------------
-- Private document storage
-- ---------------------------------------------------------------------------
--
-- Buckets are private. Object paths are "<user_id>/<case_id>/<filename>" so the
-- owning user is the first path segment and policies can check it without a join.

-- storage.objects belongs to Supabase, not to us.
--
-- On a hosted project the table is owned by `supabase_storage_admin`, and the
-- migration role owns none of it. Every statement below that needs ownership —
-- ALTER TABLE ... ENABLE ROW LEVEL SECURITY, DROP POLICY, CREATE POLICY —
-- fails with `42501: must be owner of table objects`. Seizing ownership is not
-- an option: the platform manages that schema and would be entitled to break us.
--
-- So this section ATTEMPTS the setup and never fails the migration on a
-- privilege error, then records what is actually true. Storage readiness is not
-- assumed from the migration having run; it is read back from the catalogue by
-- `pcnwatch_storage_readiness()`, and the application refuses to accept uploads
-- until that reports ready. A missing policy therefore closes the feature rather
-- than silently exposing one user's documents to another.
--
-- Buckets are private. Object paths are "<user_id>/<case_id>/<filename>" so the
-- owning user is the first path segment and a policy can check it without a join.

do $$
declare
  bucket text;
  attempted_rls boolean := false;
  attempted_buckets boolean := false;
  attempted_policies boolean := false;
begin
  -- 1. Row level security on storage.objects. Supabase enables this by default,
  --    so on a hosted project the attempt is redundant and the check passes.
  begin
    execute 'alter table storage.objects enable row level security';
    attempted_rls := true;
  exception
    when insufficient_privilege then
      raise notice '[storage] Cannot ALTER storage.objects (owned by Supabase). Relying on the platform default.';
  end;

  -- 2. Buckets. INSERT is a table privilege rather than ownership, so this
  --    normally succeeds on hosted Supabase; it is still guarded, because a
  --    failure here must not stop the public-schema work above from landing.
  begin
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values
      ('pcn-documents', 'pcn-documents', false, 12582912,
       array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
      ('pcn-evidence', 'pcn-evidence', false, 12582912,
       array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
    on conflict (id) do nothing;
    attempted_buckets := true;
  exception
    when insufficient_privilege then
      raise notice '[storage] Cannot INSERT into storage.buckets. Create both buckets in the dashboard, private.';
  end;

  -- 3. Object policies. These are the ones that failed on hosted Supabase.
  begin
    foreach bucket in array array['pcn-documents', 'pcn-evidence']
    loop
      execute format($f$drop policy if exists "own objects read %1$s" on storage.objects$f$, bucket);
      execute format($f$drop policy if exists "own objects write %1$s" on storage.objects$f$, bucket);
      execute format($f$drop policy if exists "own objects delete %1$s" on storage.objects$f$, bucket);
      execute format($f$
        create policy "own objects read %1$s" on storage.objects
          for select to authenticated
          using (bucket_id = %1$L and (storage.foldername(name))[1] = (select auth.uid())::text)
      $f$, bucket);
      execute format($f$
        create policy "own objects write %1$s" on storage.objects
          for insert to authenticated
          with check (bucket_id = %1$L and (storage.foldername(name))[1] = (select auth.uid())::text)
      $f$, bucket);
      execute format($f$
        create policy "own objects delete %1$s" on storage.objects
          for delete to authenticated
          using (bucket_id = %1$L and (storage.foldername(name))[1] = (select auth.uid())::text)
      $f$, bucket);
    end loop;
    attempted_policies := true;
  exception
    when insufficient_privilege then
      raise notice '[storage] Cannot CREATE POLICY on storage.objects (owned by Supabase).';
      raise notice '[storage] Create the six policies through Storage -> Policies. See docs/deployment-supabase.md.';
  end;

  raise notice '[storage] Attempted: rls=% buckets=% policies=%',
    attempted_rls, attempted_buckets, attempted_policies;
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage readiness, read back from the catalogue.
--
-- Deliberately not a record of what this migration tried to do. It reports what
-- is true now, so it gives the same answer whether the policies were created
-- here or by hand in the dashboard afterwards.
-- ---------------------------------------------------------------------------

create or replace function pcnwatch_storage_readiness()
returns table (
  ready boolean,
  rls_enabled boolean,
  buckets_present integer,
  buckets_private boolean,
  policies_present integer,
  policies_expected integer,
  missing text[]
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with expected as (
    select unnest(array[
      'own objects read pcn-documents',
      'own objects write pcn-documents',
      'own objects delete pcn-documents',
      'own objects read pcn-evidence',
      'own objects write pcn-evidence',
      'own objects delete pcn-evidence'
    ]) as policyname
  ),
  found as (
    select p.policyname
    from pg_policies p
    where p.schemaname = 'storage' and p.tablename = 'objects'
  ),
  rls as (
    select coalesce(bool_or(c.relrowsecurity), false) as on
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects'
  ),
  buckets as (
    select count(*)::int as n, coalesce(bool_and(not b.public), false) as all_private
    from storage.buckets b
    where b.id in ('pcn-documents', 'pcn-evidence')
  )
  select
    rls.on
      and buckets.n = 2
      and buckets.all_private
      and (select count(*) from expected e join found f on f.policyname = e.policyname) = 6,
    rls.on,
    buckets.n,
    buckets.all_private,
    (select count(*)::int from expected e join found f on f.policyname = e.policyname),
    6,
    coalesce(
      (select array_agg(e.policyname order by e.policyname)
         from expected e
        where not exists (select 1 from found f where f.policyname = e.policyname)),
      '{}'::text[]
    )
  from rls, buckets;
$$;

comment on function pcnwatch_storage_readiness() is
  'True state of private document storage: RLS, buckets and the six per-bucket object policies. The application refuses uploads unless ready is true.';

-- Called by the application through the service role only.
revoke execute on function pcnwatch_storage_readiness() from public, anon, authenticated;
grant execute on function pcnwatch_storage_readiness() to service_role;
