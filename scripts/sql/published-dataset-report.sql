-- What the currently published dataset actually contains.
--
--   Run against the hosted database (Supabase SQL editor, or psql).
--   Read-only: it measures and queries, it never writes.
--
-- Deliberately one statement returning one result set, because the Supabase SQL
-- editor shows only the last result of a multi-statement script, and a
-- diagnostic whose first two thirds are invisible is worse than none.
--
-- Sections:
--   STORAGE    what the compact model costs on disk, table by table and index
--              by index. `pcn_events` appearing at heap 0 bytes is the proof
--              that production writes no per-notice rows.
--   SCORING    the exact refusal reason behind every unscored location. A
--              location is refused, never given a placeholder number.
--   DATA       the shape of what was published, including how much of it falls
--              inside each scoring window — which is what decides whether a
--              location can be scored at all.
--   READ PATH  every public read function exercised against the live version.
with storage as (
  select 'STORAGE' as section, 'database total' as metric,
         pg_size_pretty(pg_database_size(current_database())) as value, 1 as ord
  union all
  select 'STORAGE', c.relname,
         pg_size_pretty(pg_total_relation_size(c.oid)) || '  (heap ' ||
         pg_size_pretty(pg_relation_size(c.oid)) || ', idx ' ||
         pg_size_pretty(pg_indexes_size(c.oid)) || ')', 2
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname in ('pcn_activity_daily','parking_locations','pcn_activity_scores',
                      'enforcement_dataset_versions','pcn_events','pcn_activity_aggregates',
                      'authority_contravention_labels','ingestion_runs')
  union all
  select 'STORAGE', 'index ' || i.indexrelname,
         pg_size_pretty(pg_relation_size(i.indexrelid)), 3
  from pg_stat_user_indexes i where i.relname = 'pcn_activity_daily'
),
scoring as (
  select 'SCORING' as section,
         s.period_key || ' / ' || coalesce(s.refusal_reason, 'SCORED') as metric,
         count(*)::text || ' locations' as value, 4 as ord
  from pcn_activity_scores s
  group by s.period_key, s.refusal_reason
),
shape as (
  select 'DATA' as section, 'published notices' as metric,
         coalesce(sum(d.pcn_count), 0)::text as value, 5 as ord
  from pcn_activity_daily d where d.dataset_version_id = pcnwatch_active_version('camden')
  union all
  select 'DATA', 'aggregate rows', count(*)::text, 6
  from pcn_activity_daily d where d.dataset_version_id = pcnwatch_active_version('camden')
  union all
  select 'DATA', 'activity date range',
         coalesce(min(d.activity_date)::text, '-') || ' to ' || coalesce(max(d.activity_date)::text, '-'), 7
  from pcn_activity_daily d where d.dataset_version_id = pcnwatch_active_version('camden')
  union all
  -- The crux of the scoring question: how much of the slice falls inside each window.
  select 'DATA', 'notices within last ' || w.days || ' days',
         coalesce(sum(d.pcn_count), 0)::text, 8
  from (values (30), (90), (365)) w(days)
  left join pcn_activity_daily d
    on d.dataset_version_id = pcnwatch_active_version('camden')
   and d.activity_date >= current_date - (w.days - 1)
  group by w.days
  union all
  select 'DATA', 'locations, and how they are positioned',
         count(*)::text || ' total, ' ||
         count(*) filter (where l.geom is not null)::text || ' positioned, sources: ' ||
         coalesce(string_agg(distinct l.geometry_source, ', '), 'none'), 9
  from parking_locations l join authorities a on a.id = l.authority_id where a.slug = 'camden'
),
reads as (
  select 'READ PATH' as section, 'coverage' as metric,
         c.event_count::text || ' notices, ' || c.mapped_event_count::text || ' mappable, demo=' ||
         c.is_demo::text as value, 10 as ord
  from pcnwatch_coverage_counts('camden') c
  union all
  select 'READ PATH', 'hotspots 12M',
         count(*)::text || ' rows, ' || coalesce(sum(h.total_pcns), 0)::text || ' notices', 11
  from pcnwatch_hotspots('camden', '12M') h
  union all
  select 'READ PATH', 'map cells 12M',
         count(*)::text || ' cells, ' || coalesce(sum(m.pcn_count), 0)::text || ' notices', 12
  from pcnwatch_map_cells('camden', -0.25, 51.49, -0.07, 51.61, 14, '12M') m
  union all
  select 'READ PATH', 'contravention filters', count(*)::text || ' codes offered', 13
  from pcnwatch_contravention_filters('camden', 16) f
  union all
  select 'READ PATH', 'location detail (busiest street)',
         coalesce(d.total_pcns::text, 'no row') || ' notices, code ' ||
         coalesce(d.dominant_contravention, '-') || ', peak ' || coalesce(d.peak_window, 'none') ||
         ', coords ' || case when d.longitude is null then 'none' else 'yes' end, 14
  from pcnwatch_hotspots('camden', '12M', null, 1, 0) top
  cross join lateral pcnwatch_location_detail('camden', top.slug) d
)
select section, metric, value from (
  select * from storage union all select * from scoring
  union all select * from shape union all select * from reads
) all_rows
order by ord, metric;
