-- PCNWatch schema — 0007: explicit table privileges.
--
-- Supabase's default privileges grant ALL on public tables to anon and
-- authenticated, leaving RLS as the only thing standing between an anonymous
-- request and every table. We revoke that and grant least privilege explicitly,
-- so RLS is the second line of defence rather than the only one.
--
-- Read this file as the authoritative statement of who may touch what.

revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Public reference and enforcement aggregates: read-only, for everyone.
-- ---------------------------------------------------------------------------

grant select on
  data_sources,
  source_versions,
  authorities,
  authority_data_sources,
  contravention_codes,
  authority_procedures,
  parking_locations,
  road_segments,
  pcn_activity_aggregates,
  pcn_activity_scores,
  products,
  dtro_records,
  dtro_restrictions
to anon, authenticated;

-- ---------------------------------------------------------------------------
-- User-owned data: signed-in users only, still filtered by RLS to their own rows.
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on
  profiles,
  vehicles,
  pcn_cases,
  pcn_documents,
  pcn_evidence,
  pcn_deadlines,
  pcn_assessments,
  pcn_assessment_findings,
  pcn_drafts,
  case_events
to authenticated;

-- Commercial records are readable by their owner and written only by the webhook.
grant select on payments, entitlements, subscriptions to authenticated;

-- ---------------------------------------------------------------------------
-- Never granted to any client role:
--   pcn_events            raw per-PCN rows
--   ingestion_runs        operational
--   ingestion_errors      operational, may quote rejected source rows
--   ai_logs               model call audit
--   audit_events          security audit
--   rate_limit_counters   abuse protection state
-- The service role reaches these; no client can.
-- ---------------------------------------------------------------------------

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
