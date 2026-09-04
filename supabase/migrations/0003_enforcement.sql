-- FineRadar schema — 0003: enforcement intelligence (public, aggregate-only).
--
-- IMPORTANT: nothing in this file may contain personal data. Source datasets can
-- accidentally include a vehicle registration; the ingestion adapter strips those
-- fields before they reach the database and there is no column for them here.

create table parking_locations (
  id                    uuid primary key default gen_random_uuid(),
  authority_id          uuid not null references authorities(id) on delete cascade,
  -- Stable slug used in shareable hotspot URLs, e.g. "camden/eversholt-street".
  slug                  text not null,
  display_name          text not null,
  street_name           text not null,
  street_name_normalised text not null,
  locality              text,
  postcode_district     text,
  geom                  geography(Point, 4326),
  road_segment_id       uuid,
  source_id             uuid references data_sources(id) on delete set null,
  source_record_id      text,
  retrieved_at          timestamptz,
  source_effective_date date,
  -- 0..1. Drives whether the location can be scored at all.
  data_confidence       numeric(4,3) not null default 0,
  source_metadata       jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (authority_id, slug),
  constraint parking_locations_confidence_range check (data_confidence between 0 and 1)
);
create index parking_locations_geom_idx on parking_locations using gist (geom);
create index parking_locations_authority_idx on parking_locations (authority_id);
create index parking_locations_street_trgm_idx on parking_locations using gin (street_name_normalised gin_trgm_ops);
comment on column parking_locations.geom is
  'NULL where the source gave no usable geography. Never populated with an approximation.';

create table road_segments (
  id                     uuid primary key default gen_random_uuid(),
  authority_id           uuid not null references authorities(id) on delete cascade,
  slug                   text not null,
  street_name            text not null,
  street_name_normalised text not null,
  geom                   geography(LineString, 4326),
  centroid               geography(Point, 4326),
  source_id              uuid references data_sources(id) on delete set null,
  source_record_id       text,
  retrieved_at           timestamptz,
  data_confidence        numeric(4,3) not null default 0,
  source_metadata        jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (authority_id, slug)
);
create index road_segments_geom_idx on road_segments using gist (geom);
create index road_segments_centroid_idx on road_segments using gist (centroid);

alter table parking_locations
  add constraint parking_locations_road_segment_fkey
  foreign key (road_segment_id) references road_segments(id) on delete set null;

-- One row per PCN issued, stripped of anything identifying.
create table pcn_events (
  id                    uuid primary key default gen_random_uuid(),
  authority_id          uuid not null references authorities(id) on delete cascade,
  parking_location_id   uuid references parking_locations(id) on delete set null,
  road_segment_id       uuid references road_segments(id) on delete set null,
  contravention_code    text,
  enforcement_type      enforcement_type not null default 'UNKNOWN',
  issued_at             timestamptz,
  issued_date           date not null,
  issued_hour           smallint,
  issued_day_of_week    smallint,
  geom                  geography(Point, 4326),
  -- Provenance
  source_id             uuid not null references data_sources(id) on delete cascade,
  source_version_id     uuid references source_versions(id) on delete set null,
  source_record_id      text not null,
  ingestion_run_id      uuid references ingestion_runs(id) on delete set null,
  retrieved_at          timestamptz not null,
  source_effective_date date,
  data_confidence       numeric(4,3) not null default 0,
  source_metadata       jsonb not null default '{}'::jsonb,
  -- Deterministic hash of the normalised row, used to detect genuine changes.
  row_hash              text not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- Dedup key: the same source record must never be counted twice.
  unique (source_id, source_record_id),
  constraint pcn_events_hour_range check (issued_hour is null or issued_hour between 0 and 23),
  constraint pcn_events_dow_range check (issued_day_of_week is null or issued_day_of_week between 0 and 6),
  constraint pcn_events_confidence_range check (data_confidence between 0 and 1)
);
create index pcn_events_authority_date_idx on pcn_events (authority_id, issued_date desc);
create index pcn_events_location_date_idx on pcn_events (parking_location_id, issued_date desc);
create index pcn_events_segment_date_idx on pcn_events (road_segment_id, issued_date desc);
create index pcn_events_code_idx on pcn_events (contravention_code);
create index pcn_events_geom_idx on pcn_events using gist (geom);
create index pcn_events_hour_dow_idx on pcn_events (issued_hour, issued_day_of_week);

-- Pre-computed aggregates. The map and hotspot pages read these, never pcn_events.
create table pcn_activity_aggregates (
  id                  uuid primary key default gen_random_uuid(),
  authority_id        uuid not null references authorities(id) on delete cascade,
  parking_location_id uuid references parking_locations(id) on delete cascade,
  road_segment_id     uuid references road_segments(id) on delete cascade,
  -- 'MONTH' buckets drive scoring; 'HOUR'/'DOW' buckets drive the profiles.
  bucket_kind         text not null,
  period_start        date not null,
  contravention_code  text,
  hour_of_day         smallint,
  day_of_week         smallint,
  pcn_count           integer not null default 0,
  -- Weakest confidence of the events rolled up here.
  data_confidence     numeric(4,3) not null default 0,
  source_id           uuid references data_sources(id) on delete set null,
  computed_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint aggregate_target_present
    check (parking_location_id is not null or road_segment_id is not null),
  constraint aggregate_bucket_kind
    check (bucket_kind in ('MONTH', 'HOUR', 'DOW', 'MONTH_CODE'))
);
create unique index pcn_activity_aggregates_key_idx on pcn_activity_aggregates (
  authority_id,
  coalesce(parking_location_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(road_segment_id, '00000000-0000-0000-0000-000000000000'::uuid),
  bucket_kind,
  period_start,
  coalesce(contravention_code, ''),
  coalesce(hour_of_day, -1),
  coalesce(day_of_week, -1)
);
create index pcn_activity_aggregates_lookup_idx on pcn_activity_aggregates (authority_id, bucket_kind, period_start desc);

create table pcn_activity_scores (
  id                  uuid primary key default gen_random_uuid(),
  authority_id        uuid not null references authorities(id) on delete cascade,
  parking_location_id uuid references parking_locations(id) on delete cascade,
  road_segment_id     uuid references road_segments(id) on delete cascade,
  -- The window the score describes, e.g. '30D', '90D', '12M'.
  period_key          text not null,
  as_of_date          date not null,
  score               smallint,
  classification      score_classification,
  -- Populated instead of `score` when the location was not eligible.
  refusal_reason      text,
  components          jsonb not null default '[]'::jsonb,
  raw_score           numeric(6,2),
  total_pcns          integer not null default 0,
  data_confidence     numeric(4,3) not null default 0,
  model_version       text not null,
  computed_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint score_range check (score is null or score between 0 and 100),
  -- A row must either carry a score or say why it does not. Never both null.
  constraint score_or_refusal check (
    (score is not null and classification is not null and refusal_reason is null)
    or (score is null and refusal_reason is not null)
  ),
  constraint score_target_present
    check (parking_location_id is not null or road_segment_id is not null)
);
create unique index pcn_activity_scores_key_idx on pcn_activity_scores (
  coalesce(parking_location_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(road_segment_id, '00000000-0000-0000-0000-000000000000'::uuid),
  period_key,
  as_of_date
);
create index pcn_activity_scores_rank_idx on pcn_activity_scores (authority_id, period_key, score desc nulls last);

-- ---------------------------------------------------------------------------
-- D-TRO (behind a feature flag until coverage is validated)
-- ---------------------------------------------------------------------------

create table dtro_records (
  id                    uuid primary key default gen_random_uuid(),
  source_id             uuid not null references data_sources(id) on delete cascade,
  source_record_id      text not null,
  authority_id          uuid references authorities(id) on delete set null,
  tro_reference         text,
  title                 text,
  status                text,
  effective_from        date,
  effective_to          date,
  -- Raw payload retained because D-TRO is an extract of a legal order and we must
  -- be able to show exactly what the service returned.
  raw_payload           jsonb not null,
  retrieved_at          timestamptz not null,
  source_effective_date date,
  data_confidence       numeric(4,3) not null default 0,
  source_metadata       jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (source_id, source_record_id)
);
create index dtro_records_authority_idx on dtro_records (authority_id);

create table dtro_restrictions (
  id               uuid primary key default gen_random_uuid(),
  dtro_record_id   uuid not null references dtro_records(id) on delete cascade,
  restriction_type text,
  description      text,
  geom             geography(Geometry, 4326),
  time_periods     jsonb not null default '[]'::jsonb,
  exemptions       jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index dtro_restrictions_geom_idx on dtro_restrictions using gist (geom);
comment on table dtro_restrictions is
  'A digital representation derived from D-TRO. This is not the legal traffic order itself and must be labelled as such wherever it is displayed.';

select add_touch_trigger('parking_locations');
select add_touch_trigger('road_segments');
select add_touch_trigger('pcn_events');
select add_touch_trigger('pcn_activity_aggregates');
select add_touch_trigger('pcn_activity_scores');
select add_touch_trigger('dtro_records');
select add_touch_trigger('dtro_restrictions');
