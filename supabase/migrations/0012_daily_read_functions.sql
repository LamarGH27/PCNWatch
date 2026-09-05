-- ---------------------------------------------------------------------------
-- PCNWatch 0012: the read path, moved onto the daily model.
--
-- Same function names, same return shapes, same grants — the application is not
-- changed by this file. What changes underneath is where the numbers come from:
-- `pcn_activity_daily` rows belonging to the ACTIVE dataset version, instead of
-- the four bucket kinds in `pcn_activity_aggregates`.
--
-- Two behaviours improve as a consequence, neither of them optional:
--
--   * Period windows are exact. The month buckets could only approximate "the
--     trailing 30 days" by rounding to a month boundary, which could cover up to
--     60 days. A date column does not need to approximate.
--   * Hour profiles are period-scoped. HOUR buckets carried no period at all, so
--     a peak-time claim was over all history whatever window the page showed.
--     The histogram now rides on the same row as the date and is filtered with it.
-- ---------------------------------------------------------------------------

-- The version every public read is answered from. Nothing else is visible.
create or replace function pcnwatch_active_version(p_authority_slug text)
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select v.id
  from enforcement_dataset_versions v
  join authorities a on a.id = v.authority_id
  where a.slug = p_authority_slug and v.status = 'ACTIVE'
  limit 1;
$$;

-- Days in a period. One place, so no caller can disagree about what "90D" means.
create or replace function pcnwatch_period_days(p_period_key text)
returns integer
language sql
immutable
set search_path = public, extensions
as $$
  select case p_period_key
    when '30D' then 30
    when '90D' then 90
    else 365
  end;
$$;

-- ---------------------------------------------------------------------------
-- Scoring inputs.
--
-- Monthly buckets are derived from daily rows rather than stored, so scoring is
-- unchanged while the storage behind it collapses. Hour and day profiles are
-- computed over the same window as the counts.
-- ---------------------------------------------------------------------------
-- Replaced rather than overloaded: two functions of the same name with
-- different arities would be ambiguous to a caller passing defaults.
drop function if exists pcnwatch_scoring_inputs(text, date);

create or replace function pcnwatch_scoring_inputs(
  p_authority_slug text,
  p_from_date date default null,
  -- The version being scored. Defaults to the live one; ingestion passes the
  -- version it is building, which is not yet visible to anybody else.
  p_dataset_version_id uuid default null
)
returns table (
  location_id uuid,
  monthly_counts jsonb,
  hour_counts jsonb,
  day_counts jsonb,
  data_confidence numeric,
  has_geometry boolean
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with v as (
    select coalesce(p_dataset_version_id, pcnwatch_active_version(p_authority_slug)) as id
  ),
  scoped as (
    select d.*
    from pcn_activity_daily d, v
    where d.dataset_version_id = v.id
      and (p_from_date is null or d.activity_date >= p_from_date)
  ),
  hours as (
    select s.parking_location_id,
           jsonb_object_agg((h.i - 1)::text, h.total) filter (where h.total > 0) as counts
    from (
      select parking_location_id, i, sum(c)::int as total
      from scoped, unnest(scoped.hour_histogram) with ordinality as u(c, i)
      group by parking_location_id, i
    ) h
    join scoped s on s.parking_location_id = h.parking_location_id
    group by s.parking_location_id
  )
  select
    l.id,
    coalesce((
      select jsonb_agg(jsonb_build_object('periodStart', m.month, 'count', m.total) order by m.month)
      from (
        select date_trunc('month', s.activity_date)::date as month, sum(s.pcn_count)::int as total
        from scoped s where s.parking_location_id = l.id
        group by 1
      ) m
    ), '[]'::jsonb),
    coalesce((select counts from hours where hours.parking_location_id = l.id), '{}'::jsonb),
    coalesce((
      select jsonb_object_agg(dow::text, total)
      from (
        select extract(dow from s.activity_date)::int as dow, sum(s.pcn_count)::int as total
        from scoped s where s.parking_location_id = l.id
        group by 1
      ) d
    ), '{}'::jsonb),
    l.data_confidence,
    l.geom is not null
  from parking_locations l
  join authorities a on a.id = l.authority_id
  where a.slug = p_authority_slug
    and exists (select 1 from scoped s where s.parking_location_id = l.id);
$$;

-- ---------------------------------------------------------------------------
-- Hotspots.
-- ---------------------------------------------------------------------------
create or replace function pcnwatch_hotspots(
  p_authority_slug text,
  p_period_key text default '12M',
  p_contravention_code text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  location_id uuid,
  slug text,
  display_name text,
  street_name text,
  authority_slug text,
  score smallint,
  classification score_classification,
  refusal_reason text,
  total_pcns integer,
  dominant_contravention text,
  peak_window text,
  trend text,
  data_confidence numeric,
  longitude double precision,
  latitude double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  -- Ranked first, enriched second.
  --
  -- Peak hour and dominant contravention are wanted for the page of results, not
  -- for every location in the borough. Computing them before the limit meant
  -- unnesting every histogram in the window — around six million slots — to
  -- throw nearly all of it away, which took three seconds. The lateral joins
  -- below run over the returned page only.
  with v as (select pcnwatch_active_version(p_authority_slug) as id),
  cutoff as (
    select (current_date - (pcnwatch_period_days(p_period_key) - 1))::date as from_date
  ),
  totals as (
    select d.parking_location_id, sum(d.pcn_count)::int as total
    from pcn_activity_daily d, v, cutoff
    where d.dataset_version_id = v.id
      and d.activity_date >= cutoff.from_date
      and (p_contravention_code is null or d.contravention_code = p_contravention_code)
    group by d.parking_location_id
  ),
  ranked as (
    select l.id, l.slug, l.display_name, l.street_name, a.slug as authority_slug,
           l.data_confidence, l.geom,
           s.score, s.classification, s.refusal_reason, s.components,
           t.total
    from totals t
    join parking_locations l on l.id = t.parking_location_id
    join authorities a on a.id = l.authority_id
    left join pcn_activity_scores s
      on s.parking_location_id = l.id and s.period_key = p_period_key
    where a.slug = p_authority_slug
    order by s.score desc nulls last, t.total desc, l.display_name
    limit p_limit offset p_offset
  )
  select
    r.id, r.slug, r.display_name, r.street_name, r.authority_slug,
    r.score, r.classification, r.refusal_reason,
    r.total,
    dm.contravention_code,
    case when pk.hour is null then null
         else to_char(pk.hour, 'FM00') || ':00–' || to_char((pk.hour + 1) % 24, 'FM00') || ':00'
    end,
    (r.components -> 'trendLabel') #>> '{}',
    r.data_confidence,
    st_x(r.geom::geometry),
    st_y(r.geom::geometry)
  from ranked r
  left join lateral (
    select d.contravention_code
    from pcn_activity_daily d, v, cutoff
    where d.dataset_version_id = v.id
      and d.parking_location_id = r.id
      and d.activity_date >= cutoff.from_date
      and d.contravention_code is not null
      and (p_contravention_code is null or d.contravention_code = p_contravention_code)
    group by d.contravention_code
    order by sum(d.pcn_count) desc, d.contravention_code
    limit 1
  ) dm on true
  left join lateral (
    select (u.i - 1) as hour
    from pcn_activity_daily d, v, cutoff, unnest(d.hour_histogram) with ordinality as u(c, i)
    where d.dataset_version_id = v.id
      and d.parking_location_id = r.id
      and d.activity_date >= cutoff.from_date
      and (p_contravention_code is null or d.contravention_code = p_contravention_code)
    group by u.i
    having sum(u.c) > 0
    order by sum(u.c) desc, u.i
    limit 1
  ) pk on true
  order by r.score desc nulls last, r.total desc, r.display_name;
$$;

-- ---------------------------------------------------------------------------
-- Location detail.
-- ---------------------------------------------------------------------------
create or replace function pcnwatch_location_detail(
  p_authority_slug text,
  p_location_slug text
)
returns table (
  location_id uuid,
  slug text,
  display_name text,
  street_name text,
  authority_slug text,
  score smallint,
  classification score_classification,
  refusal_reason text,
  total_pcns integer,
  dominant_contravention text,
  peak_window text,
  trend text,
  data_confidence numeric,
  longitude double precision,
  latitude double precision,
  period_start date,
  period_end date,
  contravention_breakdown jsonb,
  hour_profile jsonb,
  day_profile jsonb,
  monthly_counts jsonb,
  source_name text,
  source_attribution text,
  source_url text,
  retrieved_at timestamptz
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with v as (select pcnwatch_active_version(p_authority_slug) as id),
  loc as (
    select l.*, a.slug as authority_slug
    from parking_locations l
    join authorities a on a.id = l.authority_id
    where a.slug = p_authority_slug and l.slug = p_location_slug
    limit 1
  ),
  scoped as (
    select d.* from pcn_activity_daily d, v, loc
    where d.dataset_version_id = v.id and d.parking_location_id = loc.id
  ),
  hourly as (
    select i, sum(c)::int as total
    from scoped, unnest(scoped.hour_histogram) with ordinality as u(c, i)
    group by i
  )
  select
    loc.id, loc.slug, loc.display_name, loc.street_name, loc.authority_slug,
    s.score, s.classification, s.refusal_reason,
    coalesce((select sum(pcn_count)::int from scoped), 0),
    (select contravention_code from (
        select contravention_code, sum(pcn_count) as n from scoped
        where contravention_code is not null group by 1
      ) t order by n desc, contravention_code limit 1),
    (select case when total = 0 then null
                 else to_char(i - 1, 'FM00') || ':00–' || to_char(i % 24, 'FM00') || ':00' end
       from hourly order by total desc, i limit 1),
    coalesce((s.components -> 'trendLabel') #>> '{}', 'UNKNOWN'),
    loc.data_confidence,
    st_x(loc.geom::geometry), st_y(loc.geom::geometry),
    (select min(activity_date) from scoped),
    (select max(activity_date) from scoped),
    coalesce((select jsonb_agg(jsonb_build_object('code', code, 'count', n) order by n desc, code)
              from (select contravention_code as code, sum(pcn_count)::int as n from scoped
                    where contravention_code is not null group by 1) c), '[]'::jsonb),
    coalesce((select jsonb_object_agg((i - 1)::text, total) from hourly where total > 0), '{}'::jsonb),
    coalesce((select jsonb_object_agg(dow::text, total)
              from (select extract(dow from activity_date)::int as dow, sum(pcn_count)::int as total
                    from scoped group by 1) d), '{}'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('periodStart', month, 'count', total) order by month)
              from (select date_trunc('month', activity_date)::date as month,
                           sum(pcn_count)::int as total from scoped group by 1) m), '[]'::jsonb),
    ds.name, ds.attribution_text, ds.source_url,
    loc.retrieved_at
  from loc
  left join pcn_activity_scores s on s.parking_location_id = loc.id and s.period_key = '12M'
  left join data_sources ds on ds.id = loc.source_id;
$$;

-- ---------------------------------------------------------------------------
-- Map cells. Unchanged in shape and in the property that made it fast: the grid
-- is computed from pre-aggregated counts, never from individual notices.
-- ---------------------------------------------------------------------------
create or replace function pcnwatch_map_cells(
  p_authority_slug text,
  p_min_lon double precision,
  p_min_lat double precision,
  p_max_lon double precision,
  p_max_lat double precision,
  p_zoom integer default 13,
  p_period_key text default '12M'
)
returns table (
  cell_key text,
  longitude double precision,
  latitude double precision,
  pcn_count integer,
  location_count integer,
  max_score smallint,
  max_classification score_classification,
  is_single_location boolean,
  location_slug text,
  display_name text
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with v as (select pcnwatch_active_version(p_authority_slug) as id),
  cutoff as (
    select (current_date - (pcnwatch_period_days(p_period_key) - 1))::date as from_date
  ),
  grid as (select greatest(0.0005, 0.5 / power(2, greatest(p_zoom, 1))) as size),
  candidates as (
    select l.id, l.slug, l.display_name,
           st_x(l.geom::geometry) as lon, st_y(l.geom::geometry) as lat
    from parking_locations l
    join authorities a on a.id = l.authority_id
    where a.slug = p_authority_slug
      and l.geom is not null
      and st_x(l.geom::geometry) between p_min_lon and p_max_lon
      and st_y(l.geom::geometry) between p_min_lat and p_max_lat
  ),
  counts as (
    select d.parking_location_id, sum(d.pcn_count)::int as total
    from pcn_activity_daily d, v, cutoff
    where d.dataset_version_id = v.id and d.activity_date >= cutoff.from_date
    group by d.parking_location_id
  ),
  binned as (
    select
      floor(c.lon / g.size)::text || ':' || floor(c.lat / g.size)::text as key,
      avg(c.lon) as lon, avg(c.lat) as lat,
      sum(coalesce(n.total, 0))::int as pcns,
      count(*)::int as locations,
      max(s.score) as max_score,
      max(s.classification::text) as max_classification,
      min(c.slug) as any_slug,
      min(c.display_name) as any_name
    from candidates c
    cross join grid g
    left join counts n on n.parking_location_id = c.id
    left join pcn_activity_scores s
      on s.parking_location_id = c.id and s.period_key = p_period_key
    group by 1
  )
  select key, lon, lat, pcns, locations, max_score, max_classification::score_classification,
         locations = 1, case when locations = 1 then any_slug end,
         case when locations = 1 then any_name end
  from binned
  where pcns > 0
  order by pcns desc
  limit 400;
$$;

-- ---------------------------------------------------------------------------
-- Coverage and filter values, so the application stops counting pcn_events.
-- ---------------------------------------------------------------------------
create or replace function pcnwatch_coverage_counts(p_authority_slug text)
returns table (
  event_count integer,
  geolocated_event_count integer,
  mapped_event_count integer,
  geolocated_location_count integer,
  dataset_version_id uuid,
  source_fetched_at timestamptz,
  is_demo boolean
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with v as (
    select ver.* from enforcement_dataset_versions ver
    join authorities a on a.id = ver.authority_id
    where a.slug = p_authority_slug and ver.status = 'ACTIVE'
    limit 1
  )
  select
    coalesce((select sum(d.pcn_count)::int from pcn_activity_daily d, v where d.dataset_version_id = v.id), 0),
    -- Notices on a street whose position the authority published. The daily
    -- model has no per-notice geometry, so "carries its own position" is
    -- answered at the street level: activity on a positioned street.
    coalesce((select sum(d.pcn_count)::int from pcn_activity_daily d
               join parking_locations l on l.id = d.parking_location_id, v
              where d.dataset_version_id = v.id and l.geom is not null
                and l.geometry_source = 'SOURCE_PUBLISHED'), 0),
    coalesce((select sum(d.pcn_count)::int from pcn_activity_daily d
               join parking_locations l on l.id = d.parking_location_id, v
              where d.dataset_version_id = v.id and l.geom is not null), 0),
    coalesce((select count(*)::int from parking_locations l
               join authorities a on a.id = l.authority_id
              where a.slug = p_authority_slug and l.geom is not null), 0),
    (select id from v),
    (select source_fetched_at from v),
    coalesce((select is_demo from v), false);
$$;

create or replace function pcnwatch_contravention_filters(
  p_authority_slug text,
  p_limit integer default 16
)
returns table (contravention_code text, pcn_count integer)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with v as (select pcnwatch_active_version(p_authority_slug) as id)
  select d.contravention_code, sum(d.pcn_count)::int
  from pcn_activity_daily d, v
  where d.dataset_version_id = v.id and d.contravention_code is not null
  group by d.contravention_code
  order by sum(d.pcn_count) desc, d.contravention_code
  limit p_limit;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: same posture as 0007 and 0010.
-- ---------------------------------------------------------------------------
revoke execute on function pcnwatch_scoring_inputs(text, date, uuid) from public, anon, authenticated;
grant execute on function pcnwatch_scoring_inputs(text, date, uuid) to service_role;

grant execute on function pcnwatch_hotspots(text, text, text, integer, integer) to anon, authenticated;
grant execute on function pcnwatch_location_detail(text, text) to anon, authenticated;
grant execute on function pcnwatch_map_cells(text, double precision, double precision, double precision, double precision, integer, text) to anon, authenticated;
grant execute on function pcnwatch_active_version(text) to anon, authenticated;
grant execute on function pcnwatch_period_days(text) to anon, authenticated;
grant execute on function pcnwatch_coverage_counts(text) to anon, authenticated;
grant execute on function pcnwatch_contravention_filters(text, integer) to anon, authenticated;
