import { describe, expect, it } from 'vitest';
import { createSupabaseSink, type IngestionContext } from '@/server/ingestion/supabase-sink';
import { trendLabelFor } from '@/server/ingestion/scoring-job';
import { chooseLocationRepresentatives } from '@/server/ingestion/postgres/store';
import type { NormalisedPcnEvent } from '@/data-sources/shared/types';

/**
 * The sink's job is to classify each event as inserted, updated or unchanged, and
 * to place personal-data-free rows in the right tables. Both are exercised here
 * against a stub client, so the classification logic is covered without a live
 * Supabase instance.
 */

function event(overrides: Partial<NormalisedPcnEvent> = {}): NormalisedPcnEvent {
  return {
    sourceRecordId: 'REC-1',
    authoritySlug: 'camden',
    contraventionCode: '01',
    enforcementType: 'PARKING',
    issuedDate: '2026-01-05',
    issuedAt: '2026-01-05T09:14:00.000Z',
    issuedHour: 9,
    issuedDayOfWeek: 1,
    streetName: 'Eversholt Street',
    streetNameNormalised: 'eversholt street',
    locationSlug: 'eversholt-street',
    locality: 'Somers Town',
    postcodeDistrict: 'NW1',
    longitude: -0.1338,
    latitude: 51.5305,
    dataConfidence: 0.9,
    sourceMetadata: { street: 'Eversholt Street' },
    rowHash: 'hash-1',
    ...overrides,
  };
}

/**
 * Minimal stub of the Supabase query builder covering only what the sink uses.
 */
function stubSupabase(existingRows: { source_record_id: string; row_hash: string }[]) {
  const upserts: { table: string; rows: unknown[] }[] = [];
  const inserts: { table: string; rows: unknown[] }[] = [];

  const client = {
    from(table: string) {
      const builder = {
        upsert(rows: unknown) {
          const list = Array.isArray(rows) ? rows : [rows];
          upserts.push({ table, rows: list });
          return {
            select: () => ({
              // parking_locations upsert resolves ids for the cache.
              then: (resolve: (v: unknown) => void) =>
                resolve({
                  data: list.map((r) => ({
                    id: `loc-${(r as { slug?: string }).slug}`,
                    slug: (r as { slug?: string }).slug,
                  })),
                  error: null,
                }),
            }),
            then: (resolve: (v: unknown) => void) => resolve({ error: null }),
          };
        },
        insert(rows: unknown) {
          inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
          return { then: (resolve: (v: unknown) => void) => resolve({ error: null }) };
        },
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        in() {
          return Promise.resolve({ data: existingRows, error: null });
        },
      };
      return builder;
    },
  };

  return { client, upserts, inserts };
}

function contextFor(client: unknown): IngestionContext {
  return {
    supabase: client as IngestionContext['supabase'],
    sourceId: 'source-1',
    authorityId: 'authority-1',
    ingestionRunId: 'run-1',
    sourceVersionId: 'version-1',
    retrievedAt: '2026-01-15T00:00:00.000Z',
  };
}

describe('ingestion sink', () => {
  it('classifies a record it has never seen as inserted', async () => {
    const { client } = stubSupabase([]);
    const outcome = await createSupabaseSink(contextFor(client)).upsertEvents([event()]);
    expect(outcome).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
  });

  it('classifies an identical record as unchanged, not updated', async () => {
    const { client } = stubSupabase([{ source_record_id: 'REC-1', row_hash: 'hash-1' }]);
    const outcome = await createSupabaseSink(contextFor(client)).upsertEvents([event()]);
    expect(outcome).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
  });

  it('classifies a genuinely changed record as updated', async () => {
    const { client } = stubSupabase([{ source_record_id: 'REC-1', row_hash: 'hash-OLD' }]);
    const outcome = await createSupabaseSink(contextFor(client)).upsertEvents([event()]);
    expect(outcome).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
  });

  it('handles a mixed batch', async () => {
    const { client } = stubSupabase([
      { source_record_id: 'REC-1', row_hash: 'hash-1' },
      { source_record_id: 'REC-2', row_hash: 'hash-OLD' },
    ]);
    const outcome = await createSupabaseSink(contextFor(client)).upsertEvents([
      event(),
      event({ sourceRecordId: 'REC-2', rowHash: 'hash-2' }),
      event({ sourceRecordId: 'REC-3', rowHash: 'hash-3' }),
    ]);
    expect(outcome).toEqual({ inserted: 1, updated: 1, unchanged: 1 });
  });

  it('writes PostGIS geometry only when coordinates exist', async () => {
    const { client, upserts } = stubSupabase([]);
    await createSupabaseSink(contextFor(client)).upsertEvents([
      event(),
      event({ sourceRecordId: 'REC-2', longitude: null, latitude: null, locationSlug: 'no-geo' }),
    ]);

    const eventRows = upserts.find((u) => u.table === 'pcn_events')?.rows as {
      geom: string | null;
      source_record_id: string;
    }[];
    expect(eventRows.find((r) => r.source_record_id === 'REC-1')?.geom).toBe(
      'SRID=4326;POINT(-0.1338 51.5305)',
    );
    // The absent-coordinates row must carry null, never a default position.
    expect(eventRows.find((r) => r.source_record_id === 'REC-2')?.geom).toBeNull();
  });

  it('prefers the located record when creating a location from several events', async () => {
    const { client, upserts } = stubSupabase([]);
    await createSupabaseSink(contextFor(client)).upsertEvents([
      event({ sourceRecordId: 'A', longitude: null, latitude: null, dataConfidence: 0.35 }),
      event({ sourceRecordId: 'B', dataConfidence: 0.9 }),
    ]);

    const locations = upserts.find((u) => u.table === 'parking_locations')?.rows as {
      geom: string | null;
    }[];
    expect(locations).toHaveLength(1);
    expect(locations[0]?.geom).toContain('POINT(-0.1338 51.5305)');
  });

  it('records every rejected row against the run', async () => {
    const { client, inserts } = stubSupabase([]);
    await createSupabaseSink(contextFor(client)).recordErrors([
      {
        sourceRecordId: 'BAD-1',
        rowNumber: 3,
        errorCode: 'MISSING_OR_INVALID_DATE',
        errorMessage: 'No valid issue date.',
        rawExcerpt: { pcn_id: 'BAD-1' },
      },
    ]);
    const errorRows = inserts.find((i) => i.table === 'ingestion_errors')?.rows as {
      ingestion_run_id: string;
      error_code: string;
    }[];
    expect(errorRows).toHaveLength(1);
    expect(errorRows[0]?.ingestion_run_id).toBe('run-1');
    expect(errorRows[0]?.error_code).toBe('MISSING_OR_INVALID_DATE');
  });

  it('does nothing for an empty batch rather than issuing a pointless query', async () => {
    const { client, upserts } = stubSupabase([]);
    const sink = createSupabaseSink(contextFor(client));
    expect(await sink.upsertEvents([])).toEqual({ inserted: 0, updated: 0, unchanged: 0 });
    await sink.recordErrors([]);
    expect(upserts).toHaveLength(0);
  });

  it('carries provenance on every event row', async () => {
    const { client, upserts } = stubSupabase([]);
    await createSupabaseSink(contextFor(client)).upsertEvents([event()]);
    const row = (upserts.find((u) => u.table === 'pcn_events')?.rows as Record<string, unknown>[])[0];
    expect(row?.source_id).toBe('source-1');
    expect(row?.source_version_id).toBe('version-1');
    expect(row?.ingestion_run_id).toBe('run-1');
    expect(row?.retrieved_at).toBe('2026-01-15T00:00:00.000Z');
    expect(row?.row_hash).toBe('hash-1');
  });

  it('never writes a field that could carry personal data', async () => {
    const { client, upserts } = stubSupabase([]);
    await createSupabaseSink(contextFor(client)).upsertEvents([event()]);
    const serialised = JSON.stringify(upserts);
    for (const forbidden of ['vrm', 'registration', 'keeper', 'driver_name', 'address']) {
      expect(serialised.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('scoring job trend labelling', () => {
  const trend = (value: number) => trendLabelFor([{ key: 'trend', value }]);

  it('labels a clearly rising trend', () => {
    expect(trend(0.85)).toBe('RISING');
    expect(trend(0.58)).toBe('RISING');
  });

  it('labels a clearly falling trend', () => {
    expect(trend(0.1)).toBe('FALLING');
    expect(trend(0.42)).toBe('FALLING');
  });

  it('keeps a dead band around neutral so a trend does not flip on noise', () => {
    expect(trend(0.5)).toBe('STABLE');
    expect(trend(0.52)).toBe('STABLE');
    expect(trend(0.45)).toBe('STABLE');
    expect(trend(0.5699)).toBe('STABLE');
  });

  it('reports UNKNOWN when there is no trend component at all', () => {
    expect(trendLabelFor([])).toBe('UNKNOWN');
    expect(trendLabelFor([{ key: 'volume', value: 0.9 }])).toBe('UNKNOWN');
  });
});

describe('choosing the row that places a street', () => {
  // Hatton Garden: 10,175 notices, 8,774 with coordinates, no position on the
  // map. Whichever batch mentioned the street first created the location, and a
  // filter then skipped every later batch for it — so a street's position was
  // decided by batch order rather than by whether any of its notices had one.
  function ev(overrides: Partial<NormalisedPcnEvent>): NormalisedPcnEvent {
    return {
      sourceRecordId: 'X',
      authoritySlug: 'camden',
      contraventionCode: '11',
      enforcementType: 'PARKING',
      issuedDate: '2026-01-05',
      issuedAt: '2026-01-05T09:14:00.000Z',
      issuedHour: 9,
      issuedDayOfWeek: 1,
      streetName: 'Hatton Garden',
      streetNameNormalised: 'hatton garden',
      locationSlug: 'hatton-garden',
      locality: null,
      postcodeDistrict: 'EC1',
      longitude: null,
      latitude: null,
      dataConfidence: 0.8,
      sourceMetadata: {},
      rowHash: 'h',
      ...overrides,
    };
  }

  it('prefers a row that can place the street over one that cannot', () => {
    const chosen = chooseLocationRepresentatives([
      ev({ sourceRecordId: 'A', dataConfidence: 0.95 }),
      ev({ sourceRecordId: 'B', longitude: -0.1084, latitude: 51.5205, dataConfidence: 0.6 }),
    ]);
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.sourceRecordId).toBe('B');
  });

  it('breaks a tie on confidence when both can place it, or neither can', () => {
    const positioned = chooseLocationRepresentatives([
      ev({ sourceRecordId: 'A', longitude: -0.1, latitude: 51.5, dataConfidence: 0.6 }),
      ev({ sourceRecordId: 'B', longitude: -0.2, latitude: 51.6, dataConfidence: 0.9 }),
    ]);
    expect(positioned[0]!.sourceRecordId).toBe('B');

    const unpositioned = chooseLocationRepresentatives([
      ev({ sourceRecordId: 'A', dataConfidence: 0.6 }),
      ev({ sourceRecordId: 'B', dataConfidence: 0.9 }),
    ]);
    expect(unpositioned[0]!.sourceRecordId).toBe('B');
  });

  it('returns a representative for every location in the batch, seen before or not', () => {
    // The actual defect, and it was an omission: the function used to be handed
    // a cache of known location ids and skip anything already in it. Nothing it
    // returned was wrong; what it left out was. It no longer takes a cache at
    // all, so there is nothing to skip with.
    const chosen = chooseLocationRepresentatives([
      ev({ sourceRecordId: 'A', locationSlug: 'hatton-garden' }),
      ev({ sourceRecordId: 'B', locationSlug: 'judd-street' }),
      ev({ sourceRecordId: 'C', locationSlug: 'hatton-garden', longitude: -0.1084, latitude: 51.5205 }),
    ]);
    expect(chooseLocationRepresentatives.length).toBe(1);
    expect(new Set(chosen.map((c) => c.locationSlug))).toEqual(
      new Set(['hatton-garden', 'judd-street']),
    );
    expect(chosen.find((c) => c.locationSlug === 'hatton-garden')!.longitude).not.toBeNull();
  });
});
