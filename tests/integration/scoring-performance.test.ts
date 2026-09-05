import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

/**
 * Scoring inputs, at the cardinality that killed the first full Camden run.
 *
 * That run wrote all 247,712 aggregate rows, reconciled exactly, and was then
 * cancelled by `statement_timeout` inside `pcnwatch_scoring_inputs`. The cause
 * was shape, not volume: three correlated subqueries each re-scanned a
 * materialised CTE once per location, so the work grew with
 * locations × rows rather than with rows.
 *
 * Nothing about that is visible at test-fixture scale — at 5,000 notices the
 * repeated scan is a few hundred rows and the function returns in
 * milliseconds. So this builds a dataset with Camden's real cardinality and
 * asserts a time budget. It is generated directly in SQL: no network, no
 * adapter, no 485,564 records to download.
 */

const DATABASE_URL = process.env.PCNWATCH_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error(
    'PCNWATCH_TEST_DATABASE_URL (or DATABASE_URL) must point at a migrated PostGIS database. ' +
      'Run these through `npm run db:test`, which creates one.',
  );
}

const AUTHORITY_SLUG = 'perf-borough';
const LOCATIONS = 1_050;
const DAYS = 365;
/** ~236 aggregate rows per location, as the real Camden run produced. */
const ROWS_PER_LOCATION = 236;

/**
 * The measured budget.
 *
 * Before the fix this query took 45.8 s on this cardinality; after, 1.2 s. Five
 * seconds sits far enough above the fixed cost to survive a loaded CI machine
 * and far enough below the old behaviour that any return to a per-location scan
 * fails loudly rather than merely getting slower.
 */
const BUDGET_MS = 5_000;

const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

let versionId: string;

beforeAll(async () => {
  await pool.query(
    `insert into authorities (slug, name, map_coverage_status)
     values ($1, 'Performance Borough', 'LIVE') on conflict (slug) do nothing`,
    [AUTHORITY_SLUG],
  );

  await pool.query(
    `insert into parking_locations (authority_id, slug, display_name, street_name,
                                    street_name_normalised, retrieved_at, data_confidence, geom)
     select a.id, 'perf-street-' || i, 'PERF STREET ' || i, 'PERF STREET ' || i,
            'perf street ' || i, now(), 0.9,
            case when i % 10 < 9
                 then st_setsrid(st_point(-0.13 - (i % 90) * 0.001, 51.52 + (i % 70) * 0.001), 4326)::geography
            end
     from authorities a, generate_series(1, $2) i
     where a.slug = $1
     on conflict (authority_id, slug) do nothing`,
    [AUTHORITY_SLUG, LOCATIONS],
  );

  const { rows } = await pool.query<{ id: string }>(
    `insert into enforcement_dataset_versions (authority_id, status, activated_at, rows_accepted)
     select a.id, 'ACTIVE', now(), 0 from authorities a where a.slug = $1
     returning id`,
    [AUTHORITY_SLUG],
  );
  versionId = rows[0]!.id;

  // ~248,000 rows: every location, every day, one code, a histogram whose
  // shape varies so the hour aggregate has real work to do.
  await pool.query(
    `insert into pcn_activity_daily (dataset_version_id, parking_location_id, activity_date,
                                     contravention_code, enforcement_class, pcn_count,
                                     hour_histogram, data_confidence)
     select $1::uuid, l.id,
            (current_date - (d.n % $3))::date,
            case when d.n % 4 = 0 then '12' else '01' end,
            case when d.n % 7 = 0 then 'MOVING_TRAFFIC'::enforcement_type else 'PARKING'::enforcement_type end,
            1 + (d.n % 5),
            (select array_agg(case when h = 9 + (d.n % 8) then (1 + (d.n % 5))::smallint else 0::smallint end order by h)
               from generate_series(1, 24) h),
            0.9
     from parking_locations l
     join authorities a on a.id = l.authority_id and a.slug = $2
     cross join generate_series(1, $4) d(n)
     on conflict do nothing`,
    [versionId, AUTHORITY_SLUG, DAYS, ROWS_PER_LOCATION],
  );

  await pool.query('analyze pcn_activity_daily');
}, 300_000);

afterAll(async () => {
  // Cascades to the staged activity rows.
  await pool.query('delete from enforcement_dataset_versions where id = $1', [versionId]);
  await pool.query(
    `delete from parking_locations
      where authority_id = (select id from authorities where slug = $1)`,
    [AUTHORITY_SLUG],
  );
  await pool.query('delete from authorities where slug = $1', [AUTHORITY_SLUG]);
  await pool.end();
});

describe('scoring inputs at Camden cardinality', () => {
  it('built a dataset the size of the one that timed out', async () => {
    const { rows } = await pool.query<{ rows: string; locations: string }>(
      `select count(*)::text as rows, count(distinct parking_location_id)::text as locations
         from pcn_activity_daily where dataset_version_id = $1`,
      [versionId],
    );
    expect(Number(rows[0]!.locations)).toBe(LOCATIONS);
    // The real run wrote 247,712. Anything of this order exercises the defect.
    expect(Number(rows[0]!.rows)).toBeGreaterThan(200_000);
  });

  it.each([
    ['12M', 364],
    ['90D', 89],
    ['30D', 29],
  ])('returns the %s window within the time budget', async (_period, days) => {
    const started = Date.now();
    const { rows } = await pool.query(
      `select * from pcnwatch_scoring_inputs($1, (current_date - $2::int)::date, $3::uuid)`,
      [AUTHORITY_SLUG, days, versionId],
    );
    const elapsed = Date.now() - started;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(LOCATIONS);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('returns each location once, with the shape the scorer expects', async () => {
    const { rows } = await pool.query<{
      location_id: string;
      monthly_counts: { periodStart: string; count: number }[];
      hour_counts: Record<string, number>;
      day_counts: Record<string, number>;
      data_confidence: string;
      has_geometry: boolean;
    }>(
      `select * from pcnwatch_scoring_inputs($1, (current_date - 364)::date, $2::uuid)`,
      [AUTHORITY_SLUG, versionId],
    );

    expect(new Set(rows.map((r) => r.location_id)).size).toBe(rows.length);
    for (const row of rows.slice(0, 20)) {
      expect(Array.isArray(row.monthly_counts)).toBe(true);
      expect(row.monthly_counts.length).toBeGreaterThan(0);
      // An hour that saw no notice is absent, never stored as a zero.
      expect(Object.values(row.hour_counts).every((n) => n > 0)).toBe(true);
      expect(Object.keys(row.day_counts).length).toBeGreaterThan(0);
      expect(Number(row.data_confidence)).toBeGreaterThan(0);
    }
    // Geometry travels through untouched: one location in ten was left unplaced.
    expect(rows.some((r) => !r.has_geometry)).toBe(true);
    expect(rows.some((r) => r.has_geometry)).toBe(true);
  });
});
