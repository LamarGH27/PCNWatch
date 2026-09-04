-- Aggregation function tests.
--
-- Inserts a small, known set of PCN events and asserts that the aggregate and
-- query functions return exactly what the data says — no more, no less.

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

-- 30 events on Eversholt Street, 10 on Camden High Street, 5 with no geometry.
insert into pcn_events (
  authority_id, parking_location_id, contravention_code, issued_date, issued_hour,
  issued_day_of_week, geom, source_id, source_record_id, retrieved_at, data_confidence, row_hash
)
select
  'bbbbbbbb-0000-0000-0000-000000000001',
  'cccccccc-0000-0000-0000-000000000001',
  case when i % 3 = 0 then '12' else '01' end,
  (current_date - (i % 60))::date,
  9,
  3,
  st_point(-0.1338, 51.5305)::geography,
  'aaaaaaaa-0000-0000-0000-000000000001',
  'EV-' || i,
  now(),
  0.90,
  md5('EV-' || i)
from generate_series(1, 30) i;

insert into pcn_events (
  authority_id, parking_location_id, contravention_code, issued_date, issued_hour,
  issued_day_of_week, geom, source_id, source_record_id, retrieved_at, data_confidence, row_hash
)
select
  'bbbbbbbb-0000-0000-0000-000000000001',
  'cccccccc-0000-0000-0000-000000000002',
  '21',
  (current_date - (i % 60))::date,
  14,
  5,
  st_point(-0.1426, 51.5390)::geography,
  'aaaaaaaa-0000-0000-0000-000000000001',
  'CH-' || i,
  now(),
  0.90,
  md5('CH-' || i)
from generate_series(1, 10) i;

insert into pcn_events (
  authority_id, parking_location_id, contravention_code, issued_date,
  source_id, source_record_id, retrieved_at, data_confidence, row_hash
)
select
  'bbbbbbbb-0000-0000-0000-000000000001',
  'cccccccc-0000-0000-0000-000000000003',
  '24',
  (current_date - i)::date,
  'aaaaaaaa-0000-0000-0000-000000000001',
  'NG-' || i,
  now(),
  0.30,
  md5('NG-' || i)
from generate_series(1, 5) i;

-- ---------------------------------------------------------------------------
-- 1. Rebuilding aggregates reproduces the event counts exactly.
-- ---------------------------------------------------------------------------

select fineradar_rebuild_aggregates('bbbbbbbb-0000-0000-0000-000000000001');

do $$
declare
  total integer;
  ev_total integer;
begin
  select sum(pcn_count) into total
  from pcn_activity_aggregates
  where bucket_kind = 'MONTH';
  select count(*) into ev_total from pcn_events;
  assert total = ev_total,
    format('Monthly aggregates total %s but there are %s events', total, ev_total);

  select sum(pcn_count) into total
  from pcn_activity_aggregates where bucket_kind = 'HOUR';
  -- Only the 40 events that carry an hour.
  assert total = 40, format('Hour profile should cover 40 events, got %s', total);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Rebuilding is idempotent.
-- ---------------------------------------------------------------------------

do $$
declare
  first_count integer;
  second_count integer;
begin
  select count(*) into first_count from pcn_activity_aggregates;
  perform fineradar_rebuild_aggregates('bbbbbbbb-0000-0000-0000-000000000001');
  select count(*) into second_count from pcn_activity_aggregates;
  assert first_count = second_count,
    format('Rebuild is not idempotent: %s then %s rows', first_count, second_count);
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
  select * into top from fineradar_hotspots('camden', '12M') limit 1;
  assert top.slug = 'eversholt-street',
    format('Expected Eversholt Street to rank first, got %s', top.slug);
  assert top.total_pcns = 30, format('Expected 30 PCNs, got %s', top.total_pcns);
  assert top.dominant_contravention = '01',
    format('Expected code 01 to dominate, got %s', top.dominant_contravention);
  assert top.peak_window = '09:00–10:00',
    format('Expected a 09:00 peak, got %s', top.peak_window);

  -- A location with no score yet reports no score, never a placeholder number.
  assert top.score is null, 'A location with no computed score must report null';

  select count(*) into row_count from fineradar_hotspots('camden', '12M');
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
  select * into top from fineradar_hotspots('camden', '12M', '21') limit 1;
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
  select count(*) into row_count from fineradar_hotspots('islington', '12M');
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
  from fineradar_map_cells('camden', -0.25, 51.49, -0.07, 51.61, 16, '12M');

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
  from fineradar_map_cells('camden', -0.25, 51.49, -0.07, 51.61, 11, '12M');
  select count(*) into near_cells
  from fineradar_map_cells('camden', -0.25, 51.49, -0.07, 51.61, 16, '12M');
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
  from fineradar_map_cells('camden', -0.02, 51.50, 0.02, 51.52, 14, '12M');
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
  select * into detail from fineradar_location_detail('camden', 'eversholt-street');
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
  select * into detail from fineradar_location_detail('camden', 'unknown-place');
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
  select count(*) into row_count from fineradar_location_detail('camden', 'does-not-exist');
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
  select count(*) into row_count from fineradar_hotspots('camden', '12M');
  assert row_count = 3, 'Anonymous visitors must be able to read public hotspots';
  select count(*) into row_count
  from fineradar_map_cells('camden', -0.25, 51.49, -0.07, 51.61, 14, '12M');
  assert row_count > 0, 'Anonymous visitors must be able to read the map';
  reset role;
end;
$$;

rollback;

\echo 'AGGREGATION TESTS PASSED'
