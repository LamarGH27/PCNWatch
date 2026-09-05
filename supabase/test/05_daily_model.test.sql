-- The daily aggregate model: reconciliation, period scoping, safe publication.
--
-- Raw notices are no longer stored, so these are what stand in their place.
-- Every claim the product makes must be derivable from these rows and must
-- reconcile with the counts the ingestion reported.

\set ON_ERROR_STOP on

begin;

-- A dataset for one street: 100 notices, three days, two codes, known hours.
insert into authorities (id, slug, name, map_coverage_status)
values ('cccccccc-0000-0000-0000-00000000000c', 'testshire', 'Testshire', 'LIVE')
on conflict (slug) do nothing;

insert into parking_locations (id, authority_id, slug, display_name, street_name,
                               street_name_normalised, retrieved_at, data_confidence, geom)
values (
  'dddddddd-0000-0000-0000-00000000000d',
  (select id from authorities where slug = 'testshire'),
  'test-street', 'TEST STREET', 'TEST STREET', 'test street',
  now(), 0.9, st_setsrid(st_point(-0.13, 51.52), 4326)::geography
) on conflict (authority_id, slug) do nothing;

insert into enforcement_dataset_versions (id, authority_id, status, rows_accepted)
values ('eeeeeeee-0000-0000-0000-00000000000e',
        (select id from authorities where slug = 'testshire'), 'BUILDING', 100);

-- 60 notices today under code 01 (all at 10:00), 30 sixty days ago under 02,
-- 10 three hundred days ago under 01. Chosen so each window contains a
-- different subset and no two windows can be confused.
insert into pcn_activity_daily (dataset_version_id, parking_location_id,
                                activity_date, contravention_code, enforcement_class,
                                pcn_count, hour_histogram, data_confidence)
values
  ('eeeeeeee-0000-0000-0000-00000000000e',
   'dddddddd-0000-0000-0000-00000000000d',
   current_date, '01', 'PARKING', 60,
   (select array_agg(case when i = 11 then 60 else 0 end::smallint order by i)
      from generate_series(1, 24) i), 0.9),
  ('eeeeeeee-0000-0000-0000-00000000000e',
   'dddddddd-0000-0000-0000-00000000000d',
   current_date - 60, '02', 'MOVING_TRAFFIC', 30,
   (select array_agg(case when i = 15 then 30 else 0 end::smallint order by i)
      from generate_series(1, 24) i), 0.9),
  ('eeeeeeee-0000-0000-0000-00000000000e',
   'dddddddd-0000-0000-0000-00000000000d',
   current_date - 300, '01', 'PARKING', 10,
   (select array_agg(case when i = 9 then 10 else 0 end::smallint order by i)
      from generate_series(1, 24) i), 0.9);

-- 1. Reconciliation: stored counts must equal the notices accepted.
do $$
declare total int;
begin
  select sum(pcn_count) into total from pcn_activity_daily
   where dataset_version_id = 'eeeeeeee-0000-0000-0000-00000000000e';
  if total <> 100 then
    raise exception 'Aggregate total % does not equal the 100 accepted notices', total;
  end if;
  raise notice 'Reconciliation: 100 accepted, 100 stored across 3 rows.';
end;
$$;

-- 2. Histogram totals reconcile with counts, allowing for untimed notices.
do $$
declare mismatch int;
begin
  select count(*) into mismatch
  from pcn_activity_daily d
  where d.dataset_version_id = 'eeeeeeee-0000-0000-0000-00000000000e'
    and (select sum(h) from unnest(d.hour_histogram) h) > d.pcn_count;
  if mismatch > 0 then
    raise exception '% rows have more hours recorded than notices', mismatch;
  end if;
  raise notice 'Hour histograms never exceed their counts.';
end;
$$;

-- 3. Nothing is visible until the version is ACTIVE.
do $$
declare visible int;
begin
  select coalesce(sum(pcn_count), 0) into visible
  from pcn_activity_daily d
  where d.dataset_version_id = pcnwatch_active_version('testshire');
  if visible <> 0 then
    raise exception 'A BUILDING version is visible to readers (% notices)', visible;
  end if;
  raise notice 'A version still building is invisible to the read path.';
end;
$$;

update enforcement_dataset_versions
   set status = 'ACTIVE', activated_at = now()
 where id = 'eeeeeeee-0000-0000-0000-00000000000e';

-- 4. Period windows contain only their own window.
do $$
declare d30 int; d90 int; d365 int;
begin
  select coalesce(sum(pcn_count), 0) into d30 from pcn_activity_daily
   where dataset_version_id = pcnwatch_active_version('testshire')
     and activity_date >= current_date - (pcnwatch_period_days('30D') - 1);
  select coalesce(sum(pcn_count), 0) into d90 from pcn_activity_daily
   where dataset_version_id = pcnwatch_active_version('testshire')
     and activity_date >= current_date - (pcnwatch_period_days('90D') - 1);
  select coalesce(sum(pcn_count), 0) into d365 from pcn_activity_daily
   where dataset_version_id = pcnwatch_active_version('testshire')
     and activity_date >= current_date - (pcnwatch_period_days('12M') - 1);

  if d30 <> 60 then raise exception '30-day window should hold 60, holds %', d30; end if;
  if d90 <> 90 then raise exception '90-day window should hold 90, holds %', d90; end if;
  if d365 <> 100 then raise exception '12-month window should hold 100, holds %', d365; end if;
  raise notice 'Windows are genuinely scoped: 30D=%, 90D=%, 12M=%.', d30, d90, d365;
end;
$$;

-- 5. Peak hour is period-scoped, and derived from the histogram alone.
do $$
declare peak_30 int; peak_365 int;
begin
  select i - 1 into peak_30
  from pcn_activity_daily d, unnest(d.hour_histogram) with ordinality as u(c, i)
  where d.dataset_version_id = pcnwatch_active_version('testshire')
    and d.activity_date >= current_date - 29
  group by i having sum(c) > 0 order by sum(c) desc, i limit 1;

  select i - 1 into peak_365
  from pcn_activity_daily d, unnest(d.hour_histogram) with ordinality as u(c, i)
  where d.dataset_version_id = pcnwatch_active_version('testshire')
    and d.activity_date >= current_date - 364
  group by i having sum(c) > 0 order by sum(c) desc, i limit 1;

  -- 10:00 dominates the 30-day window; over a year it still leads, but the
  -- point is that the question is answered per window rather than over all time.
  if peak_30 <> 10 then raise exception '30-day peak hour should be 10, is %', peak_30; end if;
  if peak_365 <> 10 then raise exception '12-month peak hour should be 10, is %', peak_365; end if;
  raise notice 'Peak hour is derived per window from the histogram: 30D=%, 12M=%.', peak_30, peak_365;
end;
$$;

-- 6. Contravention and class distributions reconcile with the total.
do $$
declare by_code int; by_class int;
begin
  select sum(n) into by_code from (
    select sum(pcn_count) as n from pcn_activity_daily
     where dataset_version_id = pcnwatch_active_version('testshire')
     group by contravention_code) t;
  select sum(n) into by_class from (
    select sum(pcn_count) as n from pcn_activity_daily
     where dataset_version_id = pcnwatch_active_version('testshire')
     group by enforcement_class) t;
  if by_code <> 100 or by_class <> 100 then
    raise exception 'Distributions do not reconcile: by code %, by class %', by_code, by_class;
  end if;
  raise notice 'Contravention and enforcement-class distributions both sum to 100.';
end;
$$;

-- 7. Moving traffic is not filed as parking.
do $$
declare mt int;
begin
  select coalesce(sum(pcn_count), 0) into mt from pcn_activity_daily
   where dataset_version_id = pcnwatch_active_version('testshire')
     and enforcement_class = 'MOVING_TRAFFIC';
  if mt <> 30 then raise exception 'Expected 30 moving-traffic notices, found %', mt; end if;
  raise notice 'Enforcement classes are preserved: 30 moving traffic, kept apart from parking.';
end;
$$;

-- 8. The filter offers only codes that exist, with real counts.
do $$
declare codes int; bogus int;
begin
  select count(*) into codes from pcnwatch_contravention_filters('testshire', 16);
  select count(*) into bogus from pcnwatch_contravention_filters('testshire', 16) f
   where not exists (
     select 1 from pcn_activity_daily d
      where d.dataset_version_id = pcnwatch_active_version('testshire')
        and d.contravention_code = f.contravention_code);
  if codes <> 2 then raise exception 'Expected 2 codes in the filter, got %', codes; end if;
  if bogus > 0 then raise exception '% filter options lead to an empty result', bogus; end if;
  raise notice 'Filter offers exactly the 2 codes present, none that lead nowhere.';
end;
$$;

-- 8a. What the map and the hotspot list show is what the aggregates hold.
--
-- Raw notices are gone, so there is no second source to check the figures
-- against. The read functions must therefore agree exactly with the rows they
-- read, or a number on the page would come from nowhere at all.
do $$
declare stored int; ranked int; mapped int; geolocated int;
begin
  select coalesce(sum(pcn_count), 0) into stored from pcn_activity_daily
   where dataset_version_id = pcnwatch_active_version('testshire')
     and activity_date >= current_date - 364;
  select coalesce(sum(total_pcns), 0) into ranked from pcnwatch_hotspots('testshire', '12M');
  if ranked <> stored then
    raise exception 'Hotspots report % notices, the aggregates hold %', ranked, stored;
  end if;

  -- The map can only show activity on a street that has a position, so it shows
  -- that subset exactly — never the full total drawn at invented coordinates.
  select coalesce(sum(d.pcn_count), 0) into geolocated
    from pcn_activity_daily d
    join parking_locations l on l.id = d.parking_location_id
   where d.dataset_version_id = pcnwatch_active_version('testshire')
     and d.activity_date >= current_date - 364
     and l.geom is not null;
  select coalesce(sum(pcn_count), 0) into mapped
    from pcnwatch_map_cells('testshire', -0.25, 51.49, -0.07, 51.61, 16, '12M');
  if mapped <> geolocated then
    raise exception 'Map cells carry % notices, % are on positioned streets', mapped, geolocated;
  end if;
  raise notice 'Hotspots (%) and map cells (%) both reconcile with the stored aggregates.',
    ranked, mapped;
end;
$$;

-- 9. Only one version can be ACTIVE, enforced by the database.
do $$
begin
  begin
    insert into enforcement_dataset_versions (authority_id, status)
    values ((select id from authorities where slug = 'testshire'), 'ACTIVE');
    raise exception 'Two ACTIVE versions were allowed for one authority.';
  exception
    when unique_violation then
      raise notice 'A second ACTIVE version is refused by the database.';
  end;
end;
$$;

-- 10. A failed refresh leaves the live data untouched.
do $$
declare before_total int; after_total int; failed_version uuid;
begin
  select coalesce(sum(pcn_count), 0) into before_total from pcn_activity_daily
   where dataset_version_id = pcnwatch_active_version('testshire');

  insert into enforcement_dataset_versions (authority_id, status)
  values ((select id from authorities where slug = 'testshire'), 'BUILDING')
  returning id into failed_version;

  insert into pcn_activity_daily (dataset_version_id, parking_location_id,
                                  activity_date, contravention_code, enforcement_class, pcn_count)
  values (failed_version,
          'dddddddd-0000-0000-0000-00000000000d', current_date, '99', 'UNKNOWN', 5);

  update enforcement_dataset_versions set status = 'ABANDONED' where id = failed_version;

  select coalesce(sum(pcn_count), 0) into after_total from pcn_activity_daily
   where dataset_version_id = pcnwatch_active_version('testshire');

  if before_total <> after_total then
    raise exception 'A failed refresh changed the live dataset: % then %', before_total, after_total;
  end if;
  raise notice 'A failed refresh left the live dataset untouched (% notices).', after_total;
end;
$$;

-- 11. Demo data can be published, but never as real enforcement activity.
--
-- Demonstration datasets exist for development, so forbidding them outright
-- would be a lie about how the product is run. What must hold is that the read
-- path always says so: `is_demo` travels from the active version through the
-- coverage function the site reads, which puts the page into DEMO_DATA state
-- behind a banner. A demo dataset that reached readers unlabelled would be
-- indistinguishable from real enforcement, which is the actual harm.
do $$
declare flagged boolean; real_flagged boolean;
begin
  -- The live version is real, and reports itself as real.
  select is_demo into real_flagged from pcnwatch_coverage_counts('testshire');
  if real_flagged is not false then
    raise exception 'A real dataset reported is_demo = %', real_flagged;
  end if;

  -- Publish a demo version over it.
  update enforcement_dataset_versions set status = 'SUPERSEDED'
   where authority_id = (select id from authorities where slug = 'testshire')
     and status = 'ACTIVE';
  insert into enforcement_dataset_versions (authority_id, status, activated_at, is_demo)
  values ((select id from authorities where slug = 'testshire'), 'ACTIVE', now(), true);

  select is_demo into flagged from pcnwatch_coverage_counts('testshire');
  if flagged is not true then
    raise exception 'An ACTIVE demo dataset reported is_demo = % to the read path', flagged;
  end if;
  raise notice 'A demo dataset reaches readers flagged as demo, never as real activity.';
end;
$$;

rollback;

\echo 'DAILY MODEL TESTS PASSED'
