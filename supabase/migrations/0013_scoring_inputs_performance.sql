-- ---------------------------------------------------------------------------
-- pcnwatch_scoring_inputs: one pass per aggregate instead of one per location.
--
-- The first full Camden ingestion reached scoring and was killed by
-- `statement_timeout` (SQLSTATE 57014) after writing all 247,712 aggregate
-- rows. The plan explains it exactly.
--
-- `scoped` is referenced several times, so PostgreSQL materialises it — and a
-- materialised CTE has no indexes. The three aggregates were then written as
-- correlated subqueries, one evaluation per location:
--
--     ->  CTE Scan on scoped s_1  (actual time=0.094..9.961 rows=164 loops=1050)
--     ->  CTE Scan on scoped s_2  (actual time=0.091..10.061 rows=164 loops=1050)
--     ->  CTE Scan on scoped s_3  (actual time=0.095..9.947 rows=164 loops=1050)
--
-- Each `loops=1050` is a full scan of all 171,758 in-window rows to find the
-- ~164 belonging to one street. Roughly 720 million rows touched to produce
-- 1,050. Measured 45.8 s locally on 246,759 rows; hosted is slower, which is
-- where the timeout came from. It was invisible at 5,000 notices because the
-- scan being repeated was 400 rows, not 171,758.
--
-- The rewrite groups each aggregate once over the whole window and joins the
-- results by location. Same output, same signature, same grants — four
-- sequential passes rather than 4,200 scans. No index would have fixed the old
-- shape: you cannot index a materialised CTE.
-- ---------------------------------------------------------------------------

create or replace function pcnwatch_scoring_inputs(
  p_authority_slug text,
  p_from_date date default null,
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
  -- Only the columns the aggregates need. The histogram is the widest thing in
  -- the table and it is carried once, not four times.
  scoped as (
    select d.parking_location_id, d.activity_date, d.pcn_count, d.hour_histogram
    from pcn_activity_daily d, v
    where d.dataset_version_id = v.id
      and (p_from_date is null or d.activity_date >= p_from_date)
  ),
  months as (
    select m.parking_location_id,
           jsonb_agg(jsonb_build_object('periodStart', m.month, 'count', m.total)
                     order by m.month) as counts
    from (
      select parking_location_id,
             date_trunc('month', activity_date)::date as month,
             sum(pcn_count)::int as total
      from scoped group by 1, 2
    ) m
    group by m.parking_location_id
  ),
  dows as (
    select d.parking_location_id, jsonb_object_agg(d.dow::text, d.total) as counts
    from (
      select parking_location_id,
             extract(dow from activity_date)::int as dow,
             sum(pcn_count)::int as total
      from scoped group by 1, 2
    ) d
    group by d.parking_location_id
  ),
  hours as (
    -- Hours that never saw a notice are left out rather than stored as zero, so
    -- an untimed street yields {} and is not mistaken for one enforced at 00:00.
    select h.parking_location_id,
           jsonb_object_agg((h.i - 1)::text, h.total) filter (where h.total > 0) as counts
    from (
      select s.parking_location_id, u.i, sum(u.c)::int as total
      from scoped s, unnest(s.hour_histogram) with ordinality as u(c, i)
      group by 1, 2
    ) h
    group by h.parking_location_id
  ),
  active as (select distinct parking_location_id from scoped)
  select
    l.id,
    coalesce(m.counts, '[]'::jsonb),
    coalesce(h.counts, '{}'::jsonb),
    coalesce(dw.counts, '{}'::jsonb),
    l.data_confidence,
    l.geom is not null
  from active
  join parking_locations l on l.id = active.parking_location_id
  join authorities a on a.id = l.authority_id and a.slug = p_authority_slug
  left join months m on m.parking_location_id = l.id
  left join hours  h on h.parking_location_id = l.id
  left join dows  dw on dw.parking_location_id = l.id;
$$;

-- Unchanged from 0012, restated because `create or replace` does not carry
-- privileges forward on a function that is being redefined in a fresh database.
revoke execute on function pcnwatch_scoring_inputs(text, date, uuid) from public, anon, authenticated;
grant execute on function pcnwatch_scoring_inputs(text, date, uuid) to service_role;

comment on function pcnwatch_scoring_inputs(text, date, uuid) is
  'Per-location activity for scoring, over one dataset version and one window. Reads the version being built, so it is service_role only.';
