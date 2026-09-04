-- PCNWatch schema — 0008: server-side aggregation.
--
-- The browser must never receive hundreds of thousands of PCN rows. These
-- functions do the aggregation in the database and return bounded, already
-- summarised result sets.
--
-- All are SECURITY INVOKER and read only from tables that are public-readable, so
-- they cannot be used to reach private data.

-- ---------------------------------------------------------------------------
-- Rebuild aggregates from raw events.
-- Called by the ingestion job, never by a request. Idempotent.
-- ---------------------------------------------------------------------------

create or replace function pcnwatch_rebuild_aggregates(p_authority_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  delete from pcn_activity_aggregates where authority_id = p_authority_id;

  -- Monthly totals per location.
  insert into pcn_activity_aggregates
    (authority_id, parking_location_id, bucket_kind, period_start, pcn_count, data_confidence, source_id)
  select
    e.authority_id,
    e.parking_location_id,
    'MONTH',
    date_trunc('month', e.issued_date)::date,
    count(*),
    min(e.data_confidence),
    (array_agg(e.source_id order by e.source_id))[1]
  from pcn_events e
  where e.authority_id = p_authority_id and e.parking_location_id is not null
  group by e.authority_id, e.parking_location_id, date_trunc('month', e.issued_date);

  get diagnostics affected = row_count;

  -- Monthly totals split by contravention code.
  insert into pcn_activity_aggregates
    (authority_id, parking_location_id, bucket_kind, period_start, contravention_code, pcn_count, data_confidence, source_id)
  select
    e.authority_id,
    e.parking_location_id,
    'MONTH_CODE',
    date_trunc('month', e.issued_date)::date,
    e.contravention_code,
    count(*),
    min(e.data_confidence),
    (array_agg(e.source_id order by e.source_id))[1]
  from pcn_events e
  where e.authority_id = p_authority_id
    and e.parking_location_id is not null
    and e.contravention_code is not null
  group by e.authority_id, e.parking_location_id, date_trunc('month', e.issued_date), e.contravention_code;

  -- Hour-of-day profile. Only rows where the source actually recorded a time.
  insert into pcn_activity_aggregates
    (authority_id, parking_location_id, bucket_kind, period_start, hour_of_day, pcn_count, data_confidence, source_id)
  select
    e.authority_id,
    e.parking_location_id,
    'HOUR',
    date '1970-01-01',
    e.issued_hour,
    count(*),
    min(e.data_confidence),
    (array_agg(e.source_id order by e.source_id))[1]
  from pcn_events e
  where e.authority_id = p_authority_id
    and e.parking_location_id is not null
    and e.issued_hour is not null
  group by e.authority_id, e.parking_location_id, e.issued_hour;

  -- Day-of-week profile.
  insert into pcn_activity_aggregates
    (authority_id, parking_location_id, bucket_kind, period_start, day_of_week, pcn_count, data_confidence, source_id)
  select
    e.authority_id,
    e.parking_location_id,
    'DOW',
    date '1970-01-01',
    e.issued_day_of_week,
    count(*),
    min(e.data_confidence),
    (array_agg(e.source_id order by e.source_id))[1]
  from pcn_events e
  where e.authority_id = p_authority_id
    and e.parking_location_id is not null
    and e.issued_day_of_week is not null
  group by e.authority_id, e.parking_location_id, e.issued_day_of_week;

  return affected;
end;
$$;

comment on function pcnwatch_rebuild_aggregates is
  'Rebuilds every aggregate bucket for one authority from pcn_events. Run after ingestion, before scoring.';

-- ---------------------------------------------------------------------------
-- Scoring inputs: one row per location, everything the score needs.
-- Returned to the scoring job, not to the browser.
-- ---------------------------------------------------------------------------

-- Dropped and recreated rather than replaced: adding a parameter changes the
-- signature, which would otherwise create an overload instead of updating it.
drop function if exists pcnwatch_scoring_inputs(text);

create or replace function pcnwatch_scoring_inputs(
  p_authority_slug text,
  p_from_date date default null
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
security definer
set search_path = public
stable
as $$
  with authority as (
    select id from authorities where slug = p_authority_slug
  )
  select
    l.id,
    coalesce((
      select jsonb_agg(jsonb_build_object('periodStart', a.period_start, 'count', a.pcn_count)
             order by a.period_start)
      from pcn_activity_aggregates a
      where a.parking_location_id = l.id
        and a.bucket_kind = 'MONTH'
        -- Restrict to the scoring period. Without this every period key produces
        -- an identical score, so the UI's time filter would change the counts a
        -- user sees without changing the ranking those counts are ordered by.
        and (p_from_date is null or a.period_start >= p_from_date)
    ), '[]'::jsonb),
    coalesce((
      select jsonb_object_agg(a.hour_of_day::text, a.pcn_count)
      from pcn_activity_aggregates a
      where a.parking_location_id = l.id and a.bucket_kind = 'HOUR'
    ), '{}'::jsonb),
    coalesce((
      select jsonb_object_agg(a.day_of_week::text, a.pcn_count)
      from pcn_activity_aggregates a
      where a.parking_location_id = l.id and a.bucket_kind = 'DOW'
    ), '{}'::jsonb),
    l.data_confidence,
    l.geom is not null
  from parking_locations l
  join authority on authority.id = l.authority_id;
$$;

-- ---------------------------------------------------------------------------
-- Hotspot ranking.
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
security invoker
set search_path = public
stable
as $$
  with authority as (
    select id, slug from authorities where slug = p_authority_slug
  ),
  cutoff as (
    select case p_period_key
      when '30D' then current_date - interval '30 days'
      when '90D' then current_date - interval '90 days'
      else current_date - interval '12 months'
    end::date as from_date
  ),
  counts as (
    select
      a.parking_location_id as loc,
      sum(a.pcn_count)::integer as total
    from pcn_activity_aggregates a
    join authority on authority.id = a.authority_id
    cross join cutoff
    where a.bucket_kind = case when p_contravention_code is null then 'MONTH' else 'MONTH_CODE' end
      and a.period_start >= cutoff.from_date
      and (p_contravention_code is null or a.contravention_code = p_contravention_code)
    group by a.parking_location_id
  ),
  dominant as (
    select distinct on (a.parking_location_id)
      a.parking_location_id as loc,
      a.contravention_code as code
    from pcn_activity_aggregates a
    join authority on authority.id = a.authority_id
    cross join cutoff
    where a.bucket_kind = 'MONTH_CODE' and a.period_start >= cutoff.from_date
    group by a.parking_location_id, a.contravention_code
    order by a.parking_location_id, sum(a.pcn_count) desc, a.contravention_code
  ),
  peak as (
    select distinct on (a.parking_location_id)
      a.parking_location_id as loc,
      lpad(a.hour_of_day::text, 2, '0') || ':00–' || lpad(((a.hour_of_day + 1) % 24)::text, 2, '0') || ':00' as window_label
    from pcn_activity_aggregates a
    join authority on authority.id = a.authority_id
    where a.bucket_kind = 'HOUR'
    group by a.parking_location_id, a.hour_of_day
    order by a.parking_location_id, sum(a.pcn_count) desc, a.hour_of_day
  )
  select
    l.id,
    l.slug,
    l.display_name,
    l.street_name,
    authority.slug,
    s.score,
    s.classification,
    s.refusal_reason,
    coalesce(counts.total, 0),
    dominant.code,
    peak.window_label,
    coalesce(
      (s.components -> 'trendLabel') #>> '{}',
      'UNKNOWN'
    ),
    l.data_confidence,
    st_x(l.geom::geometry),
    st_y(l.geom::geometry)
  from parking_locations l
  join authority on authority.id = l.authority_id
  left join counts on counts.loc = l.id
  left join dominant on dominant.loc = l.id
  left join peak on peak.loc = l.id
  left join pcn_activity_scores s
    on s.parking_location_id = l.id
   and s.period_key = p_period_key
   and s.as_of_date = (
     select max(as_of_date) from pcn_activity_scores
     where parking_location_id = l.id and period_key = p_period_key
   )
  where coalesce(counts.total, 0) > 0
  order by s.score desc nulls last, coalesce(counts.total, 0) desc, l.slug
  limit least(p_limit, 200) offset greatest(p_offset, 0);
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
security invoker
set search_path = public
stable
as $$
  with authority as (
    select id, slug from authorities where slug = p_authority_slug
  ),
  loc as (
    select l.* from parking_locations l
    join authority on authority.id = l.authority_id
    where l.slug = p_location_slug
  )
  select
    loc.id,
    loc.slug,
    loc.display_name,
    loc.street_name,
    (select slug from authority),
    s.score,
    s.classification,
    s.refusal_reason,
    coalesce((
      select sum(a.pcn_count)::integer from pcn_activity_aggregates a
      where a.parking_location_id = loc.id and a.bucket_kind = 'MONTH'
    ), 0),
    (
      select a.contravention_code from pcn_activity_aggregates a
      where a.parking_location_id = loc.id and a.bucket_kind = 'MONTH_CODE'
      group by a.contravention_code
      order by sum(a.pcn_count) desc, a.contravention_code
      limit 1
    ),
    (
      select lpad(a.hour_of_day::text, 2, '0') || ':00–' ||
             lpad(((a.hour_of_day + 1) % 24)::text, 2, '0') || ':00'
      from pcn_activity_aggregates a
      where a.parking_location_id = loc.id and a.bucket_kind = 'HOUR'
      group by a.hour_of_day
      order by sum(a.pcn_count) desc, a.hour_of_day
      limit 1
    ),
    coalesce((s.components -> 'trendLabel') #>> '{}', 'UNKNOWN'),
    loc.data_confidence,
    st_x(loc.geom::geometry),
    st_y(loc.geom::geometry),
    (select min(a.period_start) from pcn_activity_aggregates a
     where a.parking_location_id = loc.id and a.bucket_kind = 'MONTH'),
    (select max(a.period_start) from pcn_activity_aggregates a
     where a.parking_location_id = loc.id and a.bucket_kind = 'MONTH'),
    coalesce((
      select jsonb_agg(x order by x->>'count' desc)
      from (
        select jsonb_build_object('code', a.contravention_code, 'count', sum(a.pcn_count)) as x
        from pcn_activity_aggregates a
        where a.parking_location_id = loc.id and a.bucket_kind = 'MONTH_CODE'
        group by a.contravention_code
      ) t
    ), '[]'::jsonb),
    coalesce((
      select jsonb_object_agg(a.hour_of_day::text, a.pcn_count)
      from pcn_activity_aggregates a
      where a.parking_location_id = loc.id and a.bucket_kind = 'HOUR'
    ), '{}'::jsonb),
    coalesce((
      select jsonb_object_agg(a.day_of_week::text, a.pcn_count)
      from pcn_activity_aggregates a
      where a.parking_location_id = loc.id and a.bucket_kind = 'DOW'
    ), '{}'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object('periodStart', a.period_start, 'count', a.pcn_count)
             order by a.period_start)
      from pcn_activity_aggregates a
      where a.parking_location_id = loc.id and a.bucket_kind = 'MONTH'
    ), '[]'::jsonb),
    ds.name,
    ds.attribution_text,
    ds.source_url,
    loc.retrieved_at
  from loc
  left join data_sources ds on ds.id = loc.source_id
  left join pcn_activity_scores s
    on s.parking_location_id = loc.id
   and s.as_of_date = (
     select max(as_of_date) from pcn_activity_scores where parking_location_id = loc.id
   );
$$;

-- ---------------------------------------------------------------------------
-- Map cells: spatially binned counts, so zoomed-out views never ship raw points.
--
-- The grid size is chosen from the zoom level. At close zoom the caller gets
-- individual locations; further out it gets cells.
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
security invoker
set search_path = public
stable
as $$
  with authority as (
    select id from authorities where slug = p_authority_slug
  ),
  cutoff as (
    select case p_period_key
      when '30D' then current_date - interval '30 days'
      when '90D' then current_date - interval '90 days'
      else current_date - interval '12 months'
    end::date as from_date
  ),
  -- Cell size in degrees, halving with each zoom step. At zoom >= 16 each
  -- location is its own cell.
  grid as (
    select case
      when p_zoom >= 16 then 0.0
      else 0.02 / power(2, greatest(p_zoom - 11, 0))
    end as size
  ),
  candidates as (
    select
      l.id, l.slug, l.display_name, l.geom,
      st_x(l.geom::geometry) as lon,
      st_y(l.geom::geometry) as lat,
      coalesce(sum(a.pcn_count), 0)::integer as total
    from parking_locations l
    join authority on authority.id = l.authority_id
    left join pcn_activity_aggregates a
      on a.parking_location_id = l.id
     and a.bucket_kind = 'MONTH'
     and a.period_start >= (select from_date from cutoff)
    where l.geom is not null
      and st_intersects(
        l.geom,
        st_makeenvelope(p_min_lon, p_min_lat, p_max_lon, p_max_lat, 4326)::geography
      )
    group by l.id, l.slug, l.display_name, l.geom
    having coalesce(sum(a.pcn_count), 0) > 0
  ),
  binned as (
    select
      c.*,
      case when (select size from grid) = 0.0 then c.id::text
      else
        floor(c.lon / (select size from grid))::text || ':' ||
        floor(c.lat / (select size from grid))::text
      end as key
    from candidates c
  )
  select
    b.key,
    avg(b.lon),
    avg(b.lat),
    sum(b.total)::integer,
    count(*)::integer,
    max(s.score),
    (array_agg(s.classification order by s.score desc nulls last))[1],
    count(*) = 1,
    case when count(*) = 1 then min(b.slug) end,
    case when count(*) = 1 then min(b.display_name) end
  from binned b
  left join pcn_activity_scores s
    on s.parking_location_id = b.id
   and s.period_key = p_period_key
   and s.as_of_date = (
     select max(as_of_date) from pcn_activity_scores
     where parking_location_id = b.id and period_key = p_period_key
   )
  group by b.key
  order by sum(b.total) desc
  limit 2000;
$$;

comment on function pcnwatch_map_cells is
  'Spatially binned enforcement counts for a viewport. Returns at most 2000 cells so the browser never receives raw event rows.';

grant execute on function pcnwatch_scoring_inputs(text, date) to service_role;
grant execute on function pcnwatch_hotspots(text, text, text, integer, integer) to anon, authenticated;
grant execute on function pcnwatch_location_detail(text, text) to anon, authenticated;
grant execute on function pcnwatch_map_cells(text, double precision, double precision, double precision, double precision, integer, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Rate limit counter.
--
-- Atomic increment-and-return, so concurrent requests cannot both read a stale
-- count and both be allowed through.
-- ---------------------------------------------------------------------------

create or replace function pcnwatch_bump_rate_limit(p_key text, p_window_start timestamptz)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  insert into rate_limit_counters (key, window_start, count)
  values (p_key, p_window_start, 1)
  on conflict (key, window_start)
  do update set count = rate_limit_counters.count + 1
  returning count into new_count;

  -- Opportunistic cleanup of windows older than a day.
  if random() < 0.01 then
    delete from rate_limit_counters where window_start < now() - interval '1 day';
  end if;

  return new_count;
end;
$$;
