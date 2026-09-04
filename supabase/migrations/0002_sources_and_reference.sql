-- PCNWatch schema — 0002: provenance and reference data.
--
-- Provenance is first-class. Any row that traces to an external dataset points at
-- a data_sources row and a source_versions row, so every displayed statistic can
-- be answered with "where did this come from and when".

create table data_sources (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,
  name             text not null,
  publisher        text not null,
  description      text not null default '',
  licence          text,
  licence_url      text,
  source_url       text,
  attribution_text text not null,
  coverage_notes   text not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table data_sources is 'External datasets PCNWatch ingests. attribution_text is rendered wherever the data appears.';

create table source_versions (
  id                    uuid primary key default gen_random_uuid(),
  source_id             uuid not null references data_sources(id) on delete cascade,
  version_label         text not null,
  -- Hash of the fetched payload; identical hashes mean nothing changed upstream.
  content_hash          text,
  source_effective_date date,
  retrieved_at          timestamptz not null,
  record_count          integer,
  notes                 text not null default '',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (source_id, version_label)
);
create index source_versions_source_retrieved_idx on source_versions (source_id, retrieved_at desc);

create table ingestion_runs (
  id                uuid primary key default gen_random_uuid(),
  source_id         uuid not null references data_sources(id) on delete cascade,
  source_version_id uuid references source_versions(id) on delete set null,
  status            ingestion_status not null default 'RUNNING',
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  -- The full ingestion report. Every counter is recorded, including rejections.
  fetched           integer not null default 0,
  accepted          integer not null default 0,
  rejected          integer not null default 0,
  inserted          integer not null default 0,
  updated           integer not null default 0,
  unchanged         integer not null default 0,
  geolocated        integer not null default 0,
  not_geolocated    integer not null default 0,
  error_count       integer not null default 0,
  trigger_source    text not null default 'manual',
  report            jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index ingestion_runs_source_started_idx on ingestion_runs (source_id, started_at desc);
create index ingestion_runs_status_idx on ingestion_runs (status) where status <> 'SUCCEEDED';

create table ingestion_errors (
  id               uuid primary key default gen_random_uuid(),
  ingestion_run_id uuid not null references ingestion_runs(id) on delete cascade,
  -- Never null: a rejected row must be traceable back to the source record.
  source_record_id text,
  row_number       integer,
  error_code       text not null,
  error_message    text not null,
  -- The offending payload, with any personal fields already stripped by the adapter.
  raw_excerpt      jsonb,
  created_at       timestamptz not null default now()
);
create index ingestion_errors_run_idx on ingestion_errors (ingestion_run_id);
create index ingestion_errors_code_idx on ingestion_errors (error_code);

-- ---------------------------------------------------------------------------
-- Authorities and reference data
-- ---------------------------------------------------------------------------

create table authorities (
  id                       uuid primary key default gen_random_uuid(),
  slug                     text not null unique,
  name                     text not null,
  authority_type           text not null default 'LONDON_BOROUGH',
  website_url              text,
  challenge_info_url       text,
  payment_info_url         text,
  tribunal_route           text,
  -- Penalty bands in pence, e.g. {"HIGHER": {"full": 13000, "discounted": 6500}}.
  penalty_bands            jsonb not null default '{}'::jsonb,
  map_coverage_status      data_coverage_status not null default 'UNAVAILABLE',
  coverage_notes           text not null default '',
  reviewed_at              date,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
comment on column authorities.map_coverage_status is
  'LIVE only when enforcement data has actually been ingested for this authority. The UI reads this to state coverage honestly.';

create table authority_data_sources (
  authority_id uuid not null references authorities(id) on delete cascade,
  source_id    uuid not null references data_sources(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (authority_id, source_id)
);

create table contravention_codes (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null,
  version              integer not null default 1,
  official_description text not null,
  plain_english        text not null,
  enforcement_type     enforcement_type not null default 'PARKING',
  penalty_band         text not null default 'UNKNOWN',
  jurisdiction         text not null default 'ENGLAND_LONDON',
  source_name          text not null,
  source_location      text not null,
  review_status        text not null default 'PENDING_LEGAL_REVIEW',
  reviewed_at          date,
  content              jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (code, version),
  constraint contravention_reviewed_needs_date
    check (review_status <> 'REVIEWED' or reviewed_at is not null)
);
create index contravention_codes_code_idx on contravention_codes (code);

create table authority_procedures (
  id                uuid primary key default gen_random_uuid(),
  authority_id      uuid references authorities(id) on delete cascade,
  reference_key     text not null,
  version           integer not null default 1,
  category          text not null,
  title             text not null,
  jurisdiction      text not null default 'ENGLAND_LONDON',
  notice_type       notice_type,
  procedural_stage  procedural_stage,
  source_name       text not null,
  source_location   text not null,
  effective_from    date not null,
  effective_to      date,
  reviewed_at       date,
  review_status     text not null default 'PENDING_LEGAL_REVIEW',
  summary           text not null,
  content           jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (reference_key, version),
  constraint procedure_effective_range check (effective_to is null or effective_to >= effective_from),
  constraint procedure_reviewed_needs_date
    check (review_status <> 'REVIEWED' or reviewed_at is not null)
);
create index authority_procedures_lookup_idx on authority_procedures (category, procedural_stage);

select add_touch_trigger('data_sources');
select add_touch_trigger('source_versions');
select add_touch_trigger('ingestion_runs');
select add_touch_trigger('authorities');
select add_touch_trigger('contravention_codes');
select add_touch_trigger('authority_procedures');
