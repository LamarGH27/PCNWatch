-- FineRadar schema — 0004: user data (private, RLS-protected in 0006).
--
-- Data minimisation: we never require a home address. Name and address columns
-- exist only because a formal representation may need them, and they are
-- nullable, per-case, and deletable independently of the account.

create table profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  display_name       text,
  -- Optional, and only used when a generated document requires a correspondence
  -- address. Never required to browse or to analyse a notice.
  correspondence_name    text,
  correspondence_address text,
  marketing_opt_in   boolean not null default false,
  -- Retention: cases are removed this many days after closure. NULL = keep.
  retention_days     integer,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint profiles_retention_positive check (retention_days is null or retention_days > 0)
);

create table vehicles (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  -- VRM is sensitive. Stored uppercase, whitespace-stripped, never logged.
  vrm            text not null,
  nickname       text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, vrm)
);
create index vehicles_user_idx on vehicles (user_id);

create table pcn_cases (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id) on delete cascade,
  vehicle_id               uuid references vehicles(id) on delete set null,
  authority_id             uuid references authorities(id) on delete set null,
  -- Free text kept because a notice may name an authority we do not yet hold.
  authority_name_raw       text,
  pcn_number               text,
  notice_category          notice_category not null default 'UNKNOWN',
  notice_type              notice_type not null default 'UNKNOWN',
  contravention_code       text,
  contravention_suffix     text,
  incident_date            date,
  incident_time            time,
  issue_date               date,
  location_text            text,
  location_geom            geography(Point, 4326),
  parking_location_id      uuid references parking_locations(id) on delete set null,
  full_amount_pence        integer,
  discounted_amount_pence  integer,
  procedural_stage         procedural_stage not null default 'UNKNOWN_STAGE',
  -- The user's own account of what happened.
  user_narrative           text,
  asserted_ground_keys     text[] not null default '{}',
  -- Which extracted fields the user has explicitly confirmed.
  verified_fields          jsonb not null default '{}'::jsonb,
  closed_at                timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint pcn_cases_amounts_non_negative check (
    (full_amount_pence is null or full_amount_pence >= 0)
    and (discounted_amount_pence is null or discounted_amount_pence >= 0)
  )
);
create index pcn_cases_user_idx on pcn_cases (user_id, created_at desc);
create index pcn_cases_stage_idx on pcn_cases (user_id, procedural_stage);
create index pcn_cases_closed_idx on pcn_cases (closed_at) where closed_at is not null;

create table pcn_documents (
  id                 uuid primary key default gen_random_uuid(),
  case_id            uuid not null references pcn_cases(id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  -- Path in the private storage bucket. Never a public URL.
  storage_path       text not null,
  original_filename  text,
  content_type       text not null,
  byte_size          integer not null,
  document_kind      text not null default 'NOTICE',
  notice_type        notice_type,
  -- Structured extraction output plus per-field confidence.
  extraction         jsonb,
  extraction_confidence numeric(4,3),
  extraction_model   text,
  extraction_prompt_version text,
  user_verified      boolean not null default false,
  verified_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint pcn_documents_size_positive check (byte_size > 0)
);
create index pcn_documents_case_idx on pcn_documents (case_id);
create index pcn_documents_user_idx on pcn_documents (user_id);

create table pcn_evidence (
  id                uuid primary key default gen_random_uuid(),
  case_id           uuid not null references pcn_cases(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  evidence_type     evidence_type not null,
  storage_path      text,
  original_filename text,
  content_type      text,
  byte_size         integer,
  caption           text,
  captured_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index pcn_evidence_case_idx on pcn_evidence (case_id, evidence_type);
create index pcn_evidence_user_idx on pcn_evidence (user_id);

create table pcn_deadlines (
  id                  uuid primary key default gen_random_uuid(),
  case_id             uuid not null references pcn_cases(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,
  deadline_type       deadline_type not null,
  trigger_date        date not null,
  calculated_due_date date not null,
  calculation_rule    text not null,
  confidence          confidence_level not null,
  user_verified       boolean not null default false,
  warnings            text[] not null default '{}',
  reference_key       text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (case_id, deadline_type)
);
create index pcn_deadlines_due_idx on pcn_deadlines (user_id, calculated_due_date);

create table pcn_assessments (
  id                  uuid primary key default gen_random_uuid(),
  case_id             uuid not null references pcn_cases(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,
  basis               evidence_basis not null,
  basis_explanation   text not null,
  missing_information text[] not null default '{}',
  citations           jsonb not null default '[]'::jsonb,
  engine_version      text not null,
  -- Set when an AI pass rewrote the explanations; null when purely deterministic.
  ai_log_id           uuid,
  out_of_scope        boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index pcn_assessments_case_idx on pcn_assessments (case_id, created_at desc);

create table pcn_assessment_findings (
  id                 uuid primary key default gen_random_uuid(),
  assessment_id      uuid not null references pcn_assessments(id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  finding_key        text not null,
  category           finding_category not null,
  issue              text not null,
  why_it_may_matter  text not null,
  evidence_needed    text[] not null default '{}',
  evidence_available text[] not null default '{}',
  citations          jsonb not null default '[]'::jsonb,
  confidence         confidence_level not null,
  ground_key         text,
  display_order      integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index pcn_assessment_findings_assessment_idx on pcn_assessment_findings (assessment_id, display_order);

create table pcn_drafts (
  id               uuid primary key default gen_random_uuid(),
  case_id          uuid not null references pcn_cases(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  assessment_id    uuid references pcn_assessments(id) on delete set null,
  draft_kind       text not null default 'INFORMAL_CHALLENGE',
  -- The generated text, and the user's edited version. The user's edit always wins.
  generated_body   text not null,
  edited_body      text,
  citations        jsonb not null default '[]'::jsonb,
  model            text,
  prompt_version   text,
  ai_log_id        uuid,
  version          integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index pcn_drafts_case_idx on pcn_drafts (case_id, created_at desc);

create table case_events (
  id           uuid primary key default gen_random_uuid(),
  case_id      uuid not null references pcn_cases(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  event_type   text not null,
  summary      text not null,
  from_stage   procedural_stage,
  to_stage     procedural_stage,
  metadata     jsonb not null default '{}'::jsonb,
  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create index case_events_case_idx on case_events (case_id, occurred_at desc);

select add_touch_trigger('profiles');
select add_touch_trigger('vehicles');
select add_touch_trigger('pcn_cases');
select add_touch_trigger('pcn_documents');
select add_touch_trigger('pcn_evidence');
select add_touch_trigger('pcn_deadlines');
select add_touch_trigger('pcn_assessments');
select add_touch_trigger('pcn_assessment_findings');
select add_touch_trigger('pcn_drafts');
