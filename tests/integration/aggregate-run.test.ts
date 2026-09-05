import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ingestAggregates } from '@/server/ingestion/postgres/aggregate-run';
import type {
  IngestionAdapter,
  NormalisationResult,
  SourceDescriptor,
  SourcePage,
} from '@/data-sources/shared/types';

/**
 * The ingestion pipeline against a real PostGIS database.
 *
 * Everything here is a guarantee that only exists when the whole thing runs:
 * that a killed run stops misreporting freshness, that a failed refresh leaves
 * the live dataset exactly as it was, that a successful one becomes visible in
 * one step, and that no notice is stored individually. None of it can be
 * demonstrated against a stub — each was a real incident, and each was invisible
 * in the unit tests that already passed at the time.
 */

const DATABASE_URL = process.env.PCNWATCH_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!DATABASE_URL) {
  // Deliberately a failure, not a skip: a database suite that quietly passes
  // without a database tells you the pipeline is fine when nothing ran.
  throw new Error(
    'PCNWATCH_TEST_DATABASE_URL (or DATABASE_URL) must point at a migrated PostGIS database. ' +
      'Run these through `npm run db:test`, which creates one.',
  );
}

const AUTHORITY_SLUG = 'integration-borough';
const SOURCE_SLUG = 'integration-borough-pcn';
const SOURCE_URL = 'https://opendata.example.gov.uk/resource/abcd-1234.json';

const descriptor: SourceDescriptor = {
  slug: SOURCE_SLUG,
  name: 'Integration Borough PCNs',
  publisher: 'Integration Borough Council',
  licence: 'OGL v3.0',
  licenceUrl: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
  sourceUrl: SOURCE_URL,
  attributionText: 'Contains public sector information licensed under OGL v3.0.',
  coverageNotes: 'Synthetic dataset used to exercise the ingestion pipeline.',
};

interface SourceRow {
  readonly id: string;
  readonly street: string;
  readonly code: string;
  readonly date: string;
  readonly hour: number;
  readonly lat: number | null;
  readonly lon: number | null;
}

/**
 * A source shaped like Camden's: a handful of streets, a year of days, most
 * notices on streets the authority positioned and some on streets it did not.
 * Deterministic, so two runs over it must produce identical output.
 */
function sourceRows(count: number): SourceRow[] {
  const streets = ['ALPHA STREET', 'BETA ROAD', 'GAMMA LANE', 'DELTA WAY'];
  const codes = ['01', '12', '21', '34'];
  const rows: SourceRow[] = [];
  for (let i = 0; i < count; i++) {
    const streetIndex = i % streets.length;
    const positioned = streetIndex < 3;
    rows.push({
      id: `REC-${i}`,
      street: streets[streetIndex]!,
      code: codes[i % codes.length]!,
      date: new Date(Date.UTC(2026, 0, 1 + (i % 200))).toISOString().slice(0, 10),
      hour: 8 + (i % 10),
      lat: positioned ? 51.52 + streetIndex * 0.001 : null,
      lon: positioned ? -0.13 - streetIndex * 0.001 : null,
    });
  }
  return rows;
}

function slugFor(street: string): string {
  return street.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

interface AdapterOptions {
  readonly rows: readonly SourceRow[];
  readonly pageSize?: number;
  /** Throws once this many rows have been yielded, simulating a mid-run fault. */
  readonly throwAfter?: number;
  readonly throwWith?: Error;
}

function stubAdapter(options: AdapterOptions): IngestionAdapter {
  const pageSize = options.pageSize ?? 100;
  return {
    descriptor,
    async fetch() {
      throw new Error('This adapter streams; fetch() should not be reached.');
    },
    async *fetchPages(): AsyncGenerator<SourcePage> {
      let yielded = 0;
      for (let offset = 0; offset < options.rows.length; offset += pageSize) {
        if (options.throwAfter !== undefined && yielded >= options.throwAfter) {
          throw options.throwWith ?? new Error('simulated source failure');
        }
        const rows = options.rows.slice(offset, offset + pageSize);
        yielded += rows.length;
        yield {
          rows,
          pageIndex: offset / pageSize,
          retrievedAt: '2026-09-01T00:00:00.000Z',
          schemaFingerprint: 'fingerprint-1',
        };
      }
      if (options.throwAfter !== undefined) {
        throw options.throwWith ?? new Error('simulated source failure');
      }
    },
    normalise(raw: unknown): NormalisationResult {
      const row = raw as SourceRow;
      return {
        ok: true,
        warnings: [],
        event: {
          sourceRecordId: row.id,
          authoritySlug: AUTHORITY_SLUG,
          contraventionCode: row.code,
          enforcementType: row.code === '34' ? 'MOVING_TRAFFIC' : 'PARKING',
          issuedDate: row.date,
          issuedAt: `${row.date}T${String(row.hour).padStart(2, '0')}:00:00.000Z`,
          issuedHour: row.hour,
          issuedDayOfWeek: new Date(`${row.date}T00:00:00Z`).getUTCDay(),
          streetName: row.street,
          streetNameNormalised: row.street.toLowerCase(),
          locationSlug: slugFor(row.street),
          locality: null,
          postcodeDistrict: 'NW1',
          longitude: row.lon,
          latitude: row.lat,
          dataConfidence: 0.9,
          sourceMetadata: {
            contravention_code_description: `Contravention ${row.code}`,
            _viaCctv: row.code === '34',
          },
          rowHash: `hash-${row.id}`,
        },
      };
    },
  };
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

async function run(adapter: IngestionAdapter, isDemo = false) {
  return ingestAggregates(pool, adapter, {
    authoritySlug: AUTHORITY_SLUG,
    isDemo,
    triggerSource: 'test',
    sourceUrl: SOURCE_URL,
    sourceDatasetId: 'abcd-1234',
    flushEveryCells: 250,
  });
}

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

async function activeTotal(): Promise<number> {
  return scalar(
    `select coalesce(sum(pcn_count), 0)::text as n from pcn_activity_daily
      where dataset_version_id = pcnwatch_active_version($1)`,
    [AUTHORITY_SLUG],
  );
}

beforeAll(async () => {
  await pool.query(
    `insert into authorities (slug, name, map_coverage_status)
     values ($1, 'Integration Borough', 'LIVE')
     on conflict (slug) do nothing`,
    [AUTHORITY_SLUG],
  );
});

beforeEach(async () => {
  // Each test starts from no published data for this authority, so what it
  // asserts is caused by the run it performed rather than an earlier one.
  await pool.query(
    `delete from enforcement_dataset_versions
      where authority_id = (select id from authorities where slug = $1)`,
    [AUTHORITY_SLUG],
  );
  await pool.query(
    `delete from ingestion_runs
      where source_id in (select id from data_sources where slug = $1)`,
    [SOURCE_SLUG],
  );
  await pool.query('delete from pcn_events');
});

afterAll(async () => {
  await pool.end();
});

describe('a successful refresh', () => {
  it('publishes one active version whose counts reconcile with the source', async () => {
    const rows = sourceRows(600);
    const result = await run(stubAdapter({ rows }));

    expect(result.fatalError).toBeNull();
    expect(result.status).toBe('SUCCEEDED');
    expect(result.published).toBe(true);
    expect(result.counters.accepted).toBe(600);
    expect(result.reconciliation?.reconciles).toBe(true);
    expect(result.reconciliation?.aggregateTotal).toBe(600);

    expect(await activeTotal()).toBe(600);
    expect(
      await scalar(
        `select count(*)::text as n from enforcement_dataset_versions
          where authority_id = (select id from authorities where slug = $1)
            and status = 'ACTIVE'`,
        [AUTHORITY_SLUG],
      ),
    ).toBe(1);
  });

  it('stores far fewer rows than there are notices', async () => {
    const rows = sourceRows(600);
    await run(stubAdapter({ rows }));

    const stored = await scalar(
      `select count(*)::text as n from pcn_activity_daily
        where dataset_version_id = pcnwatch_active_version($1)`,
      [AUTHORITY_SLUG],
    );
    // The point of the model. 600 notices over 4 streets, 200 days and 4 codes
    // collapse; the exact figure is determined by the fixture, so assert the
    // property rather than a magic number.
    expect(stored).toBeLessThan(600);
    expect(await activeTotal()).toBe(600);
  });

  it('writes no per-notice rows at all', async () => {
    await run(stubAdapter({ rows: sourceRows(600) }));
    expect(await scalar('select count(*)::text as n from pcn_events')).toBe(0);
  });

  it('records the run as SUCCEEDED with the counts it reported', async () => {
    const result = await run(stubAdapter({ rows: sourceRows(300) }));
    const { rows } = await pool.query<{ status: string; accepted: number; finished_at: Date | null }>(
      'select status, accepted, finished_at from ingestion_runs where id = $1',
      [result.runId],
    );
    expect(rows[0]?.status).toBe('SUCCEEDED');
    expect(rows[0]?.accepted).toBe(300);
    expect(rows[0]?.finished_at).not.toBeNull();
  });

  it('publishes the authority own wording for each code, counted for this dataset', async () => {
    await run(stubAdapter({ rows: sourceRows(400) }));
    const first = await scalar(
      `select coalesce(sum(event_count), 0)::text as n from authority_contravention_labels
        where authority_id = (select id from authorities where slug = $1)`,
      [AUTHORITY_SLUG],
    );
    expect(first).toBe(400);

    // Running again over the same source must describe the same dataset, not
    // accumulate a running total of every ingestion ever performed.
    await run(stubAdapter({ rows: sourceRows(400) }));
    const second = await scalar(
      `select coalesce(sum(event_count), 0)::text as n from authority_contravention_labels
        where authority_id = (select id from authorities where slug = $1)`,
      [AUTHORITY_SLUG],
    );
    expect(second).toBe(400);
  });
});

describe('re-ingesting the same source', () => {
  it('is deterministic: the same rows twice produce the same published dataset', async () => {
    const rows = sourceRows(500);
    await run(stubAdapter({ rows }));
    const firstShape = await pool.query<{ key: string; n: string; hist: string }>(
      `select parking_location_id::text || ' ' || activity_date::text || ' ' ||
              coalesce(contravention_code, '') || ' ' || enforcement_class::text as key,
              pcn_count::text as n, hour_histogram::text as hist
         from pcn_activity_daily
        where dataset_version_id = pcnwatch_active_version($1)
        order by key`,
      [AUTHORITY_SLUG],
    );

    await run(stubAdapter({ rows }));
    const secondShape = await pool.query<{ key: string; n: string; hist: string }>(
      `select parking_location_id::text || ' ' || activity_date::text || ' ' ||
              coalesce(contravention_code, '') || ' ' || enforcement_class::text as key,
              pcn_count::text as n, hour_histogram::text as hist
         from pcn_activity_daily
        where dataset_version_id = pcnwatch_active_version($1)
        order by key`,
      [AUTHORITY_SLUG],
    );

    expect(secondShape.rows).toEqual(firstShape.rows);
    // And the totals did not double: the second run replaced the first rather
    // than adding to it.
    expect(await activeTotal()).toBe(500);
  });

  it('places a street in the same position every time', async () => {
    const rows = sourceRows(500);
    await run(stubAdapter({ rows }));
    const before = await pool.query<{ slug: string; pos: string | null }>(
      `select slug, st_astext(geom::geometry) as pos from parking_locations
        where authority_id = (select id from authorities where slug = $1) order by slug`,
      [AUTHORITY_SLUG],
    );

    // Same rows, different page boundaries, so a different batch mentions each
    // street first. Position must not depend on that.
    await run(stubAdapter({ rows, pageSize: 37 }));
    const after = await pool.query<{ slug: string; pos: string | null }>(
      `select slug, st_astext(geom::geometry) as pos from parking_locations
        where authority_id = (select id from authorities where slug = $1) order by slug`,
      [AUTHORITY_SLUG],
    );

    expect(after.rows).toEqual(before.rows);
    // The street the source never positioned still has none — never a guess.
    expect(after.rows.find((r) => r.slug === slugFor('DELTA WAY'))?.pos).toBeNull();
  });
});

describe('a failed refresh', () => {
  it('leaves the previously published dataset exactly as it was', async () => {
    await run(stubAdapter({ rows: sourceRows(500) }));
    const before = await activeTotal();
    expect(before).toBe(500);

    const failed = await run(
      stubAdapter({ rows: sourceRows(500), pageSize: 100, throwAfter: 200 }),
    );

    expect(failed.status).toBe('FAILED');
    expect(failed.published).toBe(false);
    expect(await activeTotal()).toBe(before);
  });

  it('records the run as FAILED rather than leaving it RUNNING', async () => {
    const failed = await run(
      stubAdapter({ rows: sourceRows(500), pageSize: 100, throwAfter: 200 }),
    );
    const { rows } = await pool.query<{ status: string; finished_at: Date | null }>(
      'select status, finished_at from ingestion_runs where id = $1',
      [failed.runId],
    );
    expect(rows[0]?.status).toBe('FAILED');
    expect(rows[0]?.finished_at).not.toBeNull();
  });

  it('abandons the half-built version instead of leaving it BUILDING', async () => {
    await run(stubAdapter({ rows: sourceRows(500) }));
    // Fail after the version exists: the throw has to come from publication, so
    // drive it by making reconciliation impossible.
    const rows = sourceRows(500);
    const adapter = stubAdapter({ rows });
    const broken: IngestionAdapter = {
      ...adapter,
      normalise: adapter.normalise.bind(adapter),
      async *fetchPages() {
        for await (const page of adapter.fetchPages!({})) yield page;
        throw new Error('source truncated after the last page');
      },
    };
    const failed = await run(broken);

    expect(failed.status).toBe('FAILED');
    const building = await scalar(
      `select count(*)::text as n from enforcement_dataset_versions
        where authority_id = (select id from authorities where slug = $1) and status = 'BUILDING'`,
      [AUTHORITY_SLUG],
    );
    expect(building).toBe(0);
    expect(await activeTotal()).toBe(500);
  });

  it('stores no credential and no registration in the recorded reason', async () => {
    const leaky = new Error(
      'connect failed: postgres://pcnwatch:hunter2@db.example.supabase.co:5432/postgres ' +
        'while fetching https://opendata.example.gov.uk/resource/abcd-1234.json?$$app_token=SECRETTOKEN123456 ' +
        'for vehicle AB12 CDE',
    );
    const failed = await run(
      stubAdapter({ rows: sourceRows(300), pageSize: 100, throwAfter: 100, throwWith: leaky }),
    );
    expect(failed.status).toBe('FAILED');

    const { rows } = await pool.query<{ message: string }>(
      `select report ->> 'message' as message from ingestion_runs where id = $1`,
      [failed.runId],
    );
    const stored = rows[0]?.message ?? '';
    expect(stored).not.toContain('hunter2');
    expect(stored).not.toContain('SECRETTOKEN123456');
    expect(stored).not.toContain('AB12 CDE');
    // Still says something useful about what went wrong.
    expect(stored).toContain('connect failed');
  });
});

describe('a run that never finished', () => {
  it('is closed as FAILED by the next run rather than misreporting freshness', async () => {
    // First run creates the source row this stale run has to belong to.
    await run(stubAdapter({ rows: sourceRows(200) }));

    const { rows: stale } = await pool.query<{ id: string }>(
      `insert into ingestion_runs (source_id, status, started_at, report)
       select id, 'RUNNING', now() - interval '3 hours',
              jsonb_build_object('demo', false)
         from data_sources where slug = $1
       returning id`,
      [SOURCE_SLUG],
    );
    const staleId = stale[0]!.id;

    await run(stubAdapter({ rows: sourceRows(200) }));

    const { rows } = await pool.query<{ status: string; abandoned: boolean | null }>(
      `select status, (report ->> 'abandoned')::boolean as abandoned
         from ingestion_runs where id = $1`,
      [staleId],
    );
    expect(rows[0]?.status).toBe('FAILED');
    expect(rows[0]?.abandoned).toBe(true);
  });
});

describe('what the product reads', () => {
  it('agrees with the aggregates it was built from', async () => {
    await run(stubAdapter({ rows: sourceRows(600) }));

    const stored = await scalar(
      `select coalesce(sum(pcn_count), 0)::text as n from pcn_activity_daily
        where dataset_version_id = pcnwatch_active_version($1)`,
      [AUTHORITY_SLUG],
    );
    const ranked = await scalar(
      `select coalesce(sum(total_pcns), 0)::text as n from pcnwatch_hotspots($1, '12M')`,
      [AUTHORITY_SLUG],
    );
    const covered = await scalar(
      `select event_count::text as n from pcnwatch_coverage_counts($1)`,
      [AUTHORITY_SLUG],
    );

    expect(ranked).toBe(stored);
    expect(covered).toBe(stored);

    // Only positioned streets reach the map, and none of them was invented.
    const mapped = await scalar(
      `select coalesce(sum(pcn_count), 0)::text as n
         from pcnwatch_map_cells($1, -1, 51, 1, 52, 14, '12M')`,
      [AUTHORITY_SLUG],
    );
    const positioned = await scalar(
      `select coalesce(sum(d.pcn_count), 0)::text as n
         from pcn_activity_daily d
         join parking_locations l on l.id = d.parking_location_id
        where d.dataset_version_id = pcnwatch_active_version($1) and l.geom is not null`,
      [AUTHORITY_SLUG],
    );
    expect(mapped).toBe(positioned);
    expect(mapped).toBeLessThan(stored);
  });

  it('keeps moving-traffic contraventions out of the parking figures', async () => {
    await run(stubAdapter({ rows: sourceRows(600) }));
    const movingTraffic = await scalar(
      `select coalesce(sum(pcn_count), 0)::text as n from pcn_activity_daily
        where dataset_version_id = pcnwatch_active_version($1)
          and enforcement_class = 'MOVING_TRAFFIC'`,
      [AUTHORITY_SLUG],
    );
    // Code 34 is one of four, evenly distributed across the fixture.
    expect(movingTraffic).toBe(150);
  });
});
