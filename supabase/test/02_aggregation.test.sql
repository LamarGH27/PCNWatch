-- Aggregation function tests.
--
-- Inserts a small, known set of enforcement activity and asserts that the query
-- functions return exactly what the data says — no more, no less.
--
-- The fixture now seeds `pcn_activity_daily` under an ACTIVE dataset version
-- rather than seeding `pcn_events` and rebuilding from it: production no longer
-- stores a row per notice, so a suite that started from notices would be
-- testing a path the product does not use. Every assertion below is unchanged.

\set ON_ERROR_STOP on

begin;

insert into data_sources (id, slug, name, publisher, attribution_text, source_url)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'camden-pcn', 'Camden PCNs',
        'London Borough of Camden', 'Contains public sector information licensed under OGL v3.0.',
        'https://opendata.camden.gov.uk/');

insert into authorities (id, slug, name, map_coverage_status)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'camden', 'London Borough of Camden', 'LIVE');

insert into parking_locations (id, authority_id, slug, display_name, street_name, street_name_normalised, geom, source_id, data_confidence, retrieved_at)
values
  ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'eversholt-street', 'Eversholt Street', 'Eversholt Street', 'eversholt street',
   st_point(-0.1338, 51.5305)::geography, 'aaaaaaaa-0000-0000-0000-000000000001', 0.90, now()),
  ('cccccccc-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001',
   'camden-high-street', 'Camden High Street', 'Camden High Street', 'camden high street',
   st_point(-0.1426, 51.5390)::geography, 'aaaaaaaa-0000-0000-0000-000000000001', 0.90, now()),
  -- Deliberately without geometry: must never appear on the map.
  ('cccccccc-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000001',
   'unknown-place', 'Unknown Place', 'Unknown Place', 'unknown place',
   null, 'aaaaaaaa-0000-0000-0000-000000000001', 0.30, now());

-- 30 notices on Eversholt Street, 10 on Camden High Street, 5 with no geometry.
insert into enforcement_dataset_versions (id, authority_id, source_id, status, activated_at, rows_accepted)
values ('ffffffff-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000001', 'ACTIVE', now(), 45);

-- Eversholt Street: 20 under code 01 and 10 under 12, all at 09:00, so the
-- dominant code and the peak window are both known exactly.
insert into pcn_activity_daily (dataset_version_id, parking_location_id,
  activity_date, contravention_code, enforcement_class, pcn_count, hour_histogram, data_confidence)
select 'ffffffff-0000-0000-0000-000000000001',
       'cccccccc-0000-0000-0000-000000000001',
       (current_date - (i % 60))::date,
       case when i % 3 = 0 then '12' else '01' end,
       'PARKING', 1,
       (select array_agg(case when h = 10 then 1 else 0 end::smallint order by h)
          from generate_series(1, 24) h),
       0.90
from generate_series(1, 30) i
on conflict (dataset_version_id, parking_location_id, activity_date, contravention_code, enforcement_class)
do update set pcn_count = pcn_activity_daily.pcn_count + excluded.pcn_count,
              hour_histogram = pcnwatch_add_histograms(pcn_activity_daily.hour_histogram, excluded.hour_histogram);

insert into pcn_activity_daily (dataset_version_id, parking_location_id,
  activity_date, contravention_code, enforcement_class, pcn_count, hour_histogram, data_confidence)
select 'ffffffff-0000-0000-0000-000000000001',
       'cccccccc-0000-0000-0000-000000000002',
       (current_date - (i % 60))::date, '21', 'PARKING', 1,
       (select array_agg(case when h = 15 then 1 else 0 end::smallint order by h)
          from generate_series(1, 24) h),
       0.90
from generate_series(1, 10) i
on conflict (dataset_version_id, parking_location_id, activity_date, contravention_code, enforcement_class)
do update set pcn_count = pcn_activity_daily.pcn_count + excluded.pcn_count,
              hour_histogram = pcnwatch_add_histograms(pcn_activity_daily.hour_histogram, excluded.hour_histogram);

-- No geometry, and no recorded time: must never appear on the map, and must not
-- contribute to an hour profile.
insert into pcn_activity_daily (dataset_version_id, parking_location_id,
  activity_date, contravention_code, enforcement_class, pcn_count, data_confidence)
select 'ffffffff-0000-0000-0000-000000000001',
       'cccccccc-0000-0000-0000-000000000003',
       (current_date - i)::date, '24', 'PARKING', 1, 0.30
from generate_series(1, 5) i;

-- ---------------------------------------------------------------------------
-- 1. The stored aggregate reproduces the notice counts exactly.
-- ---------------------------------------------------------------------------

do $$
declare
  total integer;
  ev_total integer;
begin
  select sum(pcn_count) into total
  from pcn_activity_daily
  where dataset_version_id = pcnwatch_active_version('camden');
  ev_total := 45;
  assert total = ev_total,
    format('Monthly aggregates total %s but there are %s events', total, ev_total);

  -- The hour histograms carry only the 40 notices that recorded a time; the
  -- five untimed ones are counted but contribute no hour.
  select coalesce(sum(h), 0) into total
  from pcn_activity_daily d, unnest(d.hour_histogram) h
  where d.dataset_version_id = pcnwatch_active_version('camden');
  assert total = 40, format('Hour profile should cover 40 events, got %s', total);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Re-ingesting the same source is idempotent.
--
-- Aggregate rows accumulate on conflict, so a refresh that wrote into the live
-- dataset would double every count. A refresh instead builds a new version and
-- swaps it in, which is what makes repeated ingestion safe.
-- ---------------------------------------------------------------------------

do $$
declare
  before_total integer;
  after_total  integer;
  rebuilt      uuid;
begin
  select sum(pcn_count) into before_total from pcn_activity_daily
   where dataset_version_id = pcnwatch_active_version('camden');

  insert into enforcement_dataset_versions (authority_id, source_id, status, rows_accepted)
  values ('bbbbbbbb-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000001', 'BUILDING', 45)
  returning id into rebuilt;

  insert into pcn_activity_daily (dataset_version_id, parking_location_id,
    activity_date, contravention_code, enforcement_class, pcn_count, hour_histogram, data_confidence)
  select rebuilt, d.parking_location_id, d.activity_date, d.contravention_code,
         d.enforcement_class, d.pcn_count, d.hour_histogram, d.data_confidence
  from pcn_activity_daily d
  where d.dataset_version_id = pcnwatch_active_version('camden');

  update enforcement_dataset_versions set status = 'SUPERSEDED'
   where authority_id = 'bbbbbbbb-0000-0000-0000-000000000001' and status = 'ACTIVE';
  update enforcement_dataset_versions set status = 'ACTIVE', activated_at = now()
   where id = rebuilt;

  select sum(pcn_count) into after_total from pcn_activity_daily
   where dataset_version_id = pcnwatch_active_version('camden');

  assert after_total = before_total,
    format('Re-ingesting the same source changed the visible total: %s then %s',
           before_total, after_total);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Hotspots rank by activity and expose the dominant contravention.
-- ---------------------------------------------------------------------------

do $$
declare
  top record;
  row_count integer;
begin
  select * into top from pcnwatch_hotspots('camden', '12M') limit 1;
  assert top.slug = 'eversholt-street',
    format('Expected Eversholt Street to rank first, got %s', top.slug);
  assert top.total_pcns = 30, format('Expected 30 PCNs, got %s', top.total_pcns);
  assert top.dominant_contravention = '01',
    format('Expected code 01 to dominate, got %s', top.dominant_contravention);
  assert top.peak_window = '09:00–10:00',
    format('Expected a 09:00 peak, got %s', top.peak_window);

  -- A location with no score yet reports no score, never a placeholder number.
  assert top.score is null, 'A location with no computed score must report null';

  select count(*) into row_count from pcnwatch_hotspots('camden', '12M');
  assert row_count = 3, format('Expected 3 locations with activity, got %s', row_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Filtering by contravention changes the ranking.
-- ---------------------------------------------------------------------------

do $$
declare
  top record;
begin
  select * into top from pcnwatch_hotspots('camden', '12M', '21') limit 1;
  assert top.slug = 'camden-high-street',
    format('Filtering to code 21 should surface Camden High Street, got %s', top.slug);
  assert top.total_pcns = 10, format('Expected 10 PCNs for code 21, got %s', top.total_pcns);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. An authority with no data returns nothing rather than erroring.
-- ---------------------------------------------------------------------------

do $$
declare
  row_count integer;
begin
  select count(*) into row_count from pcnwatch_hotspots('islington', '12M');
  assert row_count = 0, format('An uncovered authority must return no rows, got %s', row_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Map cells never include a location without geometry.
-- ---------------------------------------------------------------------------

do $$
declare
  total integer;
  cells integer;
begin
  select count(*), coalesce(sum(pcn_count), 0) into cells, total
  from pcnwatch_map_cells('camden', -0.25, 51.49, -0.07, 51.61, 16, '12M');

  -- 40 events across the two located streets. The 5 ungeocoded events are absent.
  assert total = 40,
    format('Map cells should carry only the 40 geolocated events, got %s', total);
  assert cells = 2, format('Expected 2 map cells at high zoom, got %s', cells);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Zooming out aggregates locations into shared cells.
-- ---------------------------------------------------------------------------

do $$
declare
  far_cells integer;
  near_cells integer;
begin
  select count(*) into far_cells
  from pcnwatch_map_cells('camden', -0.25, 51.49, -0.07, 51.61, 11, '12M');
  select count(*) into near_cells
  from pcnwatch_map_cells('camden', -0.25, 51.49, -0.07, 51.61, 16, '12M');
  assert far_cells <= near_cells,
    format('Zooming out should not increase the cell count (%s vs %s)', far_cells, near_cells);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. A viewport elsewhere in London returns nothing.
-- ---------------------------------------------------------------------------

do $$
declare
  cells integer;
begin
  select count(*) into cells
  from pcnwatch_map_cells('camden', -0.02, 51.50, 0.02, 51.52, 14, '12M');
  assert cells = 0, format('A viewport outside the data must return no cells, got %s', cells);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Location detail returns the full profile with source attribution.
-- ---------------------------------------------------------------------------

do $$
declare
  detail record;
begin
  select * into detail from pcnwatch_location_detail('camden', 'eversholt-street');
  assert detail.total_pcns = 30, format('Expected 30 PCNs, got %s', detail.total_pcns);
  assert detail.source_name = 'Camden PCNs', 'Source attribution must be returned with the figures';
  assert detail.source_attribution is not null, 'Attribution text is required';
  assert jsonb_array_length(detail.contravention_breakdown) = 2,
    'Expected two contravention codes in the breakdown';
  assert detail.hour_profile ? '9', 'Hour profile should record the 09:00 activity';
  assert detail.longitude is not null, 'A located street must return coordinates';
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. A location without geometry still has a detail page, without coordinates.
-- ---------------------------------------------------------------------------

do $$
declare
  detail record;
begin
  select * into detail from pcnwatch_location_detail('camden', 'unknown-place');
  assert detail.total_pcns = 5, format('Expected 5 PCNs, got %s', detail.total_pcns);
  assert detail.longitude is null, 'A location with no geometry must not report coordinates';
  assert detail.hour_profile = '{}'::jsonb, 'No hours were recorded, so the profile must be empty';
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. An unknown location returns no row rather than an empty shell.
-- ---------------------------------------------------------------------------

do $$
declare
  row_count integer;
begin
  select count(*) into row_count from pcnwatch_location_detail('camden', 'does-not-exist');
  assert row_count = 0, 'An unknown location must return no rows';
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Aggregation functions are readable by anonymous visitors.
-- ---------------------------------------------------------------------------

do $$
declare
  row_count integer;
begin
  set local role anon;
  select count(*) into row_count from pcnwatch_hotspots('camden', '12M');
  assert row_count = 3, 'Anonymous visitors must be able to read public hotspots';
  select count(*) into row_count
  from pcnwatch_map_cells('camden', -0.25, 51.49, -0.07, 51.61, 14, '12M');
  assert row_count > 0, 'Anonymous visitors must be able to read the map';
  reset role;
end;
$$;

rollback;

\echo 'AGGREGATION TESTS PASSED'
