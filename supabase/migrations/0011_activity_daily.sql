-- ---------------------------------------------------------------------------
-- PCNWatch 0011: enforcement intelligence without a row per PCN.
--
-- Forward-only. 0001–0010 are applied to the hosted project and are not edited.
--
-- Why
-- ---
-- `pcn_events` stored one row per notice, each carrying a jsonb metadata blob, a
-- geography point and seven indexes. At Camden's scale that reached ~738 MB for
-- ~485k notices — roughly 1.5 kB per PCN — to answer questions none of which are
-- asked per PCN. Every public read function (hotspots, location detail, map
-- cells, scoring inputs) already reads aggregates only; the events table existed
-- so that `pcnwatch_rebuild_aggregates` could read it back.
--
-- So the aggregate becomes the thing that is stored, built during ingestion, and
-- the raw events are discarded once counted.
--
-- What replaces four bucket kinds
-- -------------------------------
-- `pcn_activity_aggregates` used MONTH / MONTH_CODE / HOUR / DOW rows. Month
-- granularity cannot answer "the trailing 30 days" exactly, and HOUR/DOW rows
-- were period-less, so an hour profile could not be scoped to a window at all.
--
-- One daily fact table replaces all four:
--   * a real date supports exact trailing 30 / 90 / 365-day windows;
--   * day of week is derived from the date, so it needs no rows of its own;
--   * the hour profile rides along as a 24-slot array on the same row, so it is
--     scoped to whatever window the caller filters to.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Dataset versions: how a refresh becomes visible, all at once or not at all.
-- ---------------------------------------------------------------------------
create type dataset_version_status as enum ('BUILDING', 'ACTIVE', 'SUPERSEDED', 'ABANDONED');

create table enforcement_dataset_versions (
  id                uuid primary key default gen_random_uuid(),
  authority_id      uuid not null references authorities(id) on delete cascade,
  status            dataset_version_status not null default 'BUILDING',
  ingestion_run_id  uuid references ingestion_runs(id) on delete set null,
  source_id         uuid references data_sources(id) on delete set null,
  source_version_id uuid references source_versions(id) on delete set null,
  -- Provenance of the fetch this version was built from.
  source_url        text,
  source_dataset_id text,
  source_fetched_at timestamptz,
  source_last_uploaded timestamptz,
  -- Fingerprint of the column set the source presented, so a schema change is
  -- visible after the fact rather than inferred from broken output.
  source_schema_fingerprint text,
  -- Reconciliation. A version may not go ACTIVE unless these agree.
  rows_fetched      integer not null default 0,
  rows_accepted     integer not null default 0,
  rows_rejected     integer not null default 0,
  aggregate_total   integer not null default 0,
  -- Demo data must never be published as real enforcement activity.
  is_demo           boolean not null default false,
  notes             jsonb not null default '{}'::jsonb,
  built_at          timestamptz not null default now(),
  activated_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- At most one ACTIVE version per authority. Enforced by the database rather than
-- by the code that flips it, so a bug in that code cannot publish two.
create unique index enforcement_dataset_versions_one_active
  on enforcement_dataset_versions (authority_id)
  where status = 'ACTIVE';

create index enforcement_dataset_versions_authority_idx
  on enforcement_dataset_versions (authority_id, status, built_at desc);

create trigger touch_enforcement_dataset_versions
  before update on enforcement_dataset_versions
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- The compact activity model.
--
-- One row per (version, location, day, contravention code, enforcement class).
-- A row represents every notice matching that combination, so a location issuing
-- forty notices under one code on one day is one row, not forty.
-- ---------------------------------------------------------------------------
-- No surrogate key and no authority column.
--
-- A row is identified by the five dimensions below, so an `id` would be a
-- second index over the same rows that nothing ever reads — measured at 5.4 MB
-- per 415,000 notices, for nothing. The authority is likewise reachable from
-- the dataset version and from the location, and a stored copy is 16 bytes a
-- row that can disagree with both. At this table's row count those choices are
-- the difference between a compact index and a warehouse habit.
create table pcn_activity_daily (
  dataset_version_id  uuid not null references enforcement_dataset_versions(id) on delete cascade,
  parking_location_id uuid not null references parking_locations(id) on delete cascade,
  activity_date       date not null,
  -- Null where the source gave no code. Kept as a dimension so the contravention
  -- filter is an index seek rather than a scan of a jsonb map.
  contravention_code  text,
  enforcement_class   enforcement_type not null default 'UNKNOWN',
  -- Whether these notices were camera-issued. The enforcement channel is a
  -- different question from the enforcement class and is kept separate.
  via_cctv            boolean,
  pcn_count           integer not null default 0,
  -- 24 slots, index = hour of day. Sums to pcn_count where the source gave times.
  -- Peak-hour analysis is then a sum of arrays over whatever window is asked for,
  -- reproducible from the stored numbers alone.
  hour_histogram      smallint[] not null default array_fill(0::smallint, array[24]),
  -- Weakest confidence of the notices rolled up here.
  data_confidence     numeric(4,3) not null default 0,

  constraint pcn_activity_daily_count_positive check (pcn_count > 0),
  constraint pcn_activity_daily_histogram_24 check (array_length(hour_histogram, 1) = 24),
  constraint pcn_activity_daily_confidence_range check (data_confidence between 0 and 1)
);

-- NULLS NOT DISTINCT so a null contravention code participates in the key; an
-- index over coalesce() cannot be targeted by `on conflict (columns)`.
create unique index pcn_activity_daily_key
  on pcn_activity_daily (dataset_version_id, parking_location_id, activity_date, contravention_code, enforcement_class)
  nulls not distinct;

-- The read path always filters by version and date window first.
--
-- Deliberately only two beyond the unique key. A (version, location, date) index
-- would be redundant: the unique key above already leads with exactly those
-- three columns, and at this row count a redundant index is not free — the three
-- indexes on this table cost more than its data.
create index pcn_activity_daily_version_date_idx
  on pcn_activity_daily (dataset_version_id, activity_date desc);
create index pcn_activity_daily_version_code_idx
  on pcn_activity_daily (dataset_version_id, contravention_code, activity_date desc);

comment on table pcn_activity_daily is
  'Compact enforcement activity. One row represents many PCNs. Raw notices are counted during ingestion and discarded; this is what the product reads.';

-- ---------------------------------------------------------------------------
-- Element-wise histogram addition.
--
-- Ingestion flushes partial aggregates as it streams, so the same
-- (location, day, code, class) key can arrive more than once and its hour
-- counts must accumulate rather than overwrite. Written as a function so the
-- upsert stays readable and so the addition itself can be tested.
-- ---------------------------------------------------------------------------
create or replace function pcnwatch_add_histograms(a smallint[], b smallint[])
returns smallint[]
language sql
immutable
strict
set search_path = public, extensions
as $$
  select array_agg((coalesce(x, 0) + coalesce(y, 0))::smallint order by i)
  from unnest(a, b) with ordinality as t(x, y, i);
$$;

comment on function pcnwatch_add_histograms(smallint[], smallint[]) is
  'Adds two 24-slot hour histograms slot by slot. Used by the ingestion upsert.';

-- ---------------------------------------------------------------------------
-- Geometry provenance, promoted from a jsonb blob to real columns.
--
-- One location carries one derived geometry, shared by all of its activity rows,
-- so a position is never duplicated across hundreds of rows. The distinction
-- between what the authority published and what we derived stays explicit.
-- ---------------------------------------------------------------------------
alter table parking_locations
  add column if not exists source_location_raw text,
  add column if not exists geometry_source text,
  add column if not exists geometry_method text,
  add column if not exists geometry_confidence numeric(4,3),
  add column if not exists geometry_resolved_at timestamptz,
  add column if not exists geometry_reference_version text;

comment on column parking_locations.source_location_raw is
  'The location string exactly as the authority published it.';
comment on column parking_locations.geometry_source is
  'Where the coordinate came from: SOURCE_PUBLISHED, STREET_REFERENCE, or null when there is none.';
comment on column parking_locations.geometry_method is
  'How it was derived: SOURCE_POINT, REPRESENTATIVE_EVENT, USRN, STREET_NAME_EXACT.';

-- ---------------------------------------------------------------------------
-- Raw event persistence becomes opt-in.
--
-- The table is kept — the RLS, grant and ingestion-safety suites cover it, and a
-- developer may want event-level data locally — but nothing in production writes
-- to it. `pcnwatch_rebuild_aggregates` read it to build the old buckets and has
-- no remaining caller, so it is dropped rather than left as a loaded gun
-- pointing at a table production no longer fills.
-- ---------------------------------------------------------------------------
drop function if exists pcnwatch_rebuild_aggregates(uuid);

comment on table pcn_events is
  'Raw per-notice rows. NOT written by any code path: the pipeline aggregates in flight and discards events, and the sink that used to write here has been removed. The table is retained because dropping it would rewrite already-applied history, and because the RLS suites use it to prove the public tables stay readable and the private ones do not.';

-- ---------------------------------------------------------------------------
-- Privileges. Same shape as 0007 and 0010: public reference data is readable,
-- everything else is service-role only.
-- ---------------------------------------------------------------------------
alter table enforcement_dataset_versions enable row level security;
alter table pcn_activity_daily enable row level security;

drop policy if exists "public read active dataset versions" on enforcement_dataset_versions;
create policy "public read active dataset versions" on enforcement_dataset_versions
  for select using (status = 'ACTIVE');

drop policy if exists "public read pcn_activity_daily" on pcn_activity_daily;
create policy "public read pcn_activity_daily" on pcn_activity_daily
  for select using (true);

grant select on enforcement_dataset_versions, pcn_activity_daily to anon, authenticated;
grant all on enforcement_dataset_versions, pcn_activity_daily to service_role;
