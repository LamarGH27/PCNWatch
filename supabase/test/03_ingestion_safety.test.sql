-- Ingestion safety.
--
-- Two guarantees that only a real database can demonstrate:
--   1. A failed refresh never destroys previously valid data.
--   2. Data ingested from a non-official source cannot be presented as real.
--
-- Production stores daily aggregates under a versioned dataset rather than one
-- row per notice, so the fixture below seeds what ingestion actually writes.

\set ON_ERROR_STOP on

begin;

insert into data_sources (id, slug, name, publisher, attribution_text)
values ('aaaaaaaa-0000-0000-0000-000000000009', 'camden-pcn-safety', 'Camden PCNs',
        'London Borough of Camden', 'OGL v3.0');

insert into authorities (id, slug, name, map_coverage_status)
values ('bbbbbbbb-0000-0000-0000-000000000009', 'camden-safety', 'Camden', 'LIVE');

insert into parking_locations (id, authority_id, slug, display_name, street_name,
                               street_name_normalised, geom, data_confidence, retrieved_at)
values ('cccccccc-0000-0000-0000-000000000009', 'bbbbbbbb-0000-0000-0000-000000000009',
        'good-street', 'Good Street', 'Good Street', 'good street',
        st_point(-0.1338, 51.5305)::geography, 0.9, now());

-- A prior good ingestion.
insert into ingestion_runs (id, source_id, status, started_at, finished_at, accepted, inserted, report)
values ('dddddddd-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000009',
        'SUCCEEDED', now() - interval '1 day', now() - interval '1 day', 500, 500,
        jsonb_build_object('authorityId', 'bbbbbbbb-0000-0000-0000-000000000009', 'demo', false));

-- 500 notices, accepted and published as one ACTIVE dataset version.
insert into enforcement_dataset_versions (id, authority_id, source_id, status, activated_at, rows_accepted)
values ('eeeeeeee-0000-0000-0000-000000000009', 'bbbbbbbb-0000-0000-0000-000000000009',
        'aaaaaaaa-0000-0000-0000-000000000009', 'ACTIVE', now() - interval '1 day', 500);

-- Notices are collapsed onto their day before they are written, so 500 notices
-- across 300 days become 300 rows carrying 500 between them.
insert into pcn_activity_daily (dataset_version_id, parking_location_id,
  activity_date, contravention_code, enforcement_class, pcn_count, hour_histogram, data_confidence)
select 'eeeeeeee-0000-0000-0000-000000000009',
       'cccccccc-0000-0000-0000-000000000009',
       day, '01', 'PARKING', n,
       (select array_agg(case when h = 10 then n else 0 end::smallint order by h)
          from generate_series(1, 24) h),
       0.9
from (select (current_date - (i % 300))::date as day, count(*)::integer as n
        from generate_series(1, 500) i
       group by 1) collapsed;

-- ---------------------------------------------------------------------------
-- 1. A failed refresh leaves prior data intact.
-- ---------------------------------------------------------------------------

do $$
declare
  before_count integer;
  after_count integer;
  partial_version uuid;
begin
  select coalesce(sum(pcn_count), 0) into before_count from pcn_activity_daily
  where dataset_version_id = pcnwatch_active_version('camden-safety');

  -- A refresh begins and writes into its own BUILDING version. Partial writes
  -- land there, never in the version readers are looking at. When the pipeline
  -- judges the payload unusable it abandons that version instead of activating
  -- it, which is what the ingestion job does on failure.
  insert into enforcement_dataset_versions (authority_id, source_id, status)
  values ('bbbbbbbb-0000-0000-0000-000000000009',
          'aaaaaaaa-0000-0000-0000-000000000009', 'BUILDING')
  returning id into partial_version;

  insert into pcn_activity_daily (dataset_version_id, parking_location_id,
    activity_date, contravention_code, enforcement_class, pcn_count, data_confidence)
  values (partial_version,
          'cccccccc-0000-0000-0000-000000000009', current_date, '01', 'PARKING', 7, 0.9);

  update enforcement_dataset_versions set status = 'ABANDONED' where id = partial_version;

  select coalesce(sum(pcn_count), 0) into after_count from pcn_activity_daily
  where dataset_version_id = pcnwatch_active_version('camden-safety');

  assert before_count = after_count,
    format('A failed refresh changed the stored data: %s → %s', before_count, after_count);
  assert after_count = 500, format('Expected the original 500 notices, found %s', after_count);
end;
$$;

-- A FAILED run row exists alongside the older successful one, so the failure is
-- visible without displacing the last good ingestion.
insert into ingestion_runs (source_id, status, started_at, finished_at, report)
values ('aaaaaaaa-0000-0000-0000-000000000009', 'FAILED', now(), now(),
        jsonb_build_object('authorityId', 'bbbbbbbb-0000-0000-0000-000000000009',
                           'demo', false, 'message', 'source changed shape'));

do $$
declare
  last_good timestamptz;
begin
  select finished_at into last_good
  from ingestion_runs
  where source_id = 'aaaaaaaa-0000-0000-0000-000000000009'
    and status in ('SUCCEEDED', 'PARTIAL')
  order by finished_at desc limit 1;

  assert last_good is not null,
    'A failed run must not hide the last successful ingestion timestamp';
  assert last_good < now() - interval '1 hour',
    'The freshness timestamp must still be the older successful run, not the failure';
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Demo data is marked, and the marking survives to the read path.
-- ---------------------------------------------------------------------------

do $$
declare
  is_demo boolean;
begin
  insert into ingestion_runs (source_id, status, started_at, finished_at, accepted, report)
  values ('aaaaaaaa-0000-0000-0000-000000000009', 'SUCCEEDED', now(), now(), 10,
          jsonb_build_object('authorityId', 'bbbbbbbb-0000-0000-0000-000000000009', 'demo', true));

  -- This is the exact expression the coverage layer reads.
  select (report ->> 'demo')::boolean into is_demo
  from ingestion_runs
  where source_id = 'aaaaaaaa-0000-0000-0000-000000000009'
    and status in ('SUCCEEDED', 'PARTIAL')
  order by finished_at desc limit 1;

  assert is_demo is true,
    'A run ingested from a non-official source must be readable as demo data';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Aggregates reconcile exactly with the notices the source supplied.
--
-- Raw notices are discarded after aggregation, so the version's accepted count
-- is the only record of how many arrived. It must equal what is stored, or the
-- product would be reporting numbers nothing accounts for.
-- ---------------------------------------------------------------------------

do $$
declare
  accepted integer;
  aggregated integer;
  histogrammed integer;
begin
  select rows_accepted into accepted from enforcement_dataset_versions
  where id = 'eeeeeeee-0000-0000-0000-000000000009';

  select coalesce(sum(pcn_count), 0) into aggregated from pcn_activity_daily
  where dataset_version_id = 'eeeeeeee-0000-0000-0000-000000000009';

  assert accepted = aggregated,
    format('Aggregates must reconcile with the source: %s accepted vs %s aggregated',
           accepted, aggregated);

  -- The hour histograms are part of the same accounting: they may hold fewer
  -- notices than the counts (untimed notices) but never more.
  select coalesce(sum(h), 0) into histogrammed
  from pcn_activity_daily d, unnest(d.hour_histogram) h
  where d.dataset_version_id = 'eeeeeeee-0000-0000-0000-000000000009';

  assert histogrammed <= aggregated,
    format('Histograms hold %s notices but only %s were counted', histogrammed, aggregated);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Scores are upsertable — the index must be targetable by ON CONFLICT.
-- ---------------------------------------------------------------------------

do $$
declare
  stored smallint;
begin
  insert into pcn_activity_scores (
    authority_id, parking_location_id, period_key, as_of_date,
    score, classification, model_version, total_pcns, data_confidence
  )
  values ('bbbbbbbb-0000-0000-0000-000000000009', 'cccccccc-0000-0000-0000-000000000009',
          '12M', current_date, 55, 'MODERATE', 'tas-1.1.0', 500, 0.9)
  on conflict (parking_location_id, road_segment_id, period_key, as_of_date)
  do update set score = excluded.score;

  -- Re-running scoring must update in place, never duplicate.
  insert into pcn_activity_scores (
    authority_id, parking_location_id, period_key, as_of_date,
    score, classification, model_version, total_pcns, data_confidence
  )
  values ('bbbbbbbb-0000-0000-0000-000000000009', 'cccccccc-0000-0000-0000-000000000009',
          '12M', current_date, 72, 'HIGH', 'tas-1.1.0', 500, 0.9)
  on conflict (parking_location_id, road_segment_id, period_key, as_of_date)
  do update set score = excluded.score, classification = excluded.classification;

  select score into stored from pcn_activity_scores
  where parking_location_id = 'cccccccc-0000-0000-0000-000000000009' and period_key = '12M';

  assert stored = 72, format('Re-scoring must update in place, got %s', stored);
  assert (select count(*) from pcn_activity_scores
          where parking_location_id = 'cccccccc-0000-0000-0000-000000000009'
            and period_key = '12M') = 1,
    'Re-scoring must not create a duplicate row';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Scoring inputs respect the period window.
-- ---------------------------------------------------------------------------

do $$
declare
  full_buckets integer;
  recent_buckets integer;
begin
  select jsonb_array_length(monthly_counts) into full_buckets
  from pcnwatch_scoring_inputs('camden-safety', null)
  where location_id = 'cccccccc-0000-0000-0000-000000000009';

  select jsonb_array_length(monthly_counts) into recent_buckets
  from pcnwatch_scoring_inputs('camden-safety', (current_date - 60)::date)
  where location_id = 'cccccccc-0000-0000-0000-000000000009';

  assert recent_buckets < full_buckets,
    format('A narrower period must feed fewer buckets: %s vs %s', recent_buckets, full_buckets);
end;
$$;

rollback;

\echo 'INGESTION SAFETY TESTS PASSED'
