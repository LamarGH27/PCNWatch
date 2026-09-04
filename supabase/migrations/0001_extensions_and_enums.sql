-- FineRadar schema — 0001: extensions, enums, shared helpers.
--
-- Conventions used throughout:
--   * Every table has created_at/updated_at (touch_updated_at trigger).
--   * Sourced records carry source_id, source_record_id, retrieved_at,
--     source_effective_date, data_confidence and source_metadata.
--   * Money is stored in pence as integer. Never floats.
--   * Geometry is geography(Point, 4326) so distance maths is in metres.

create extension if not exists "postgis";
create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type procedural_stage as enum (
  'NEW',
  'INFORMAL_CHALLENGE',
  'NOTICE_TO_OWNER',
  'FORMAL_REPRESENTATION',
  'NOTICE_OF_ACCEPTANCE',
  'NOTICE_OF_REJECTION',
  'TRIBUNAL_ELIGIBLE',
  'TRIBUNAL_APPEAL',
  'CLOSED_WON',
  'CLOSED_PAID',
  'CLOSED_LOST',
  'UNKNOWN_STAGE'
);

create type notice_type as enum (
  'PCN_ON_STREET',
  'PCN_POSTAL',
  'NOTICE_TO_OWNER',
  'NOTICE_OF_REJECTION',
  'NOTICE_OF_ACCEPTANCE',
  'CHARGE_CERTIFICATE',
  'ORDER_FOR_RECOVERY',
  'PRIVATE_PARKING_CHARGE',
  'UNKNOWN'
);

create type notice_category as enum (
  'LOCAL_AUTHORITY_PCN',
  'PRIVATE_PARKING_CHARGE',
  'UNKNOWN'
);

create type evidence_type as enum (
  'PCN_IMAGE',
  'COUNCIL_PHOTOGRAPHS',
  'PARKING_SIGN',
  'ROAD_MARKINGS',
  'VEHICLE_POSITION',
  'PAYMENT_RECEIPT',
  'PARKING_APP_RECEIPT',
  'PERMIT',
  'BLUE_BADGE',
  'LOADING_EVIDENCE',
  'WITNESS_INFORMATION',
  'BREAKDOWN_EVIDENCE',
  'CORRESPONDENCE',
  'OTHER'
);

create type deadline_type as enum (
  'DISCOUNT_EXPIRY',
  'FULL_AMOUNT_DUE',
  'INFORMAL_CHALLENGE_WINDOW',
  'FORMAL_REPRESENTATION_DEADLINE',
  'TRIBUNAL_APPEAL_DEADLINE',
  'CHARGE_CERTIFICATE_RISK'
);

create type confidence_level as enum ('HIGH', 'MEDIUM', 'LOW');

create type evidence_basis as enum (
  'STRONG_EVIDENCE_BASIS',
  'MODERATE_EVIDENCE_BASIS',
  'WEAK_EVIDENCE_BASIS',
  'INSUFFICIENT_INFORMATION'
);

create type finding_category as enum (
  'STATUTORY_GROUND',
  'FACTUAL_DISPUTE',
  'PROCEDURAL_ISSUE',
  'DISCRETIONARY'
);

create type score_classification as enum ('VERY_LOW', 'LOW', 'MODERATE', 'HIGH', 'VERY_HIGH');

create type ingestion_status as enum ('RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL');

create type enforcement_type as enum ('PARKING', 'BUS_LANE', 'MOVING_TRAFFIC', 'UNKNOWN');

create type data_coverage_status as enum ('LIVE', 'PLANNED', 'UNAVAILABLE');

create type ai_job_type as enum (
  'DOCUMENT_EXTRACTION',
  'DOCUMENT_CLASSIFICATION',
  'CASE_SUMMARISATION',
  'ASSESSMENT_EXPLANATION',
  'CHALLENGE_DRAFTING',
  'RESPONSE_COMPARISON'
);

create type ai_validation_result as enum ('ACCEPTED', 'SCHEMA_REJECTED', 'CITATION_REJECTED', 'ERROR');

create type payment_status as enum ('PENDING', 'PAID', 'FAILED', 'REFUNDED');

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Applies the updated_at trigger to a table.
create or replace function add_touch_trigger(target regclass)
returns void
language plpgsql
as $$
begin
  execute format(
    'create trigger %I before update on %s for each row execute function touch_updated_at()',
    'touch_' || replace(target::text, '.', '_'),
    target
  );
end;
$$;
