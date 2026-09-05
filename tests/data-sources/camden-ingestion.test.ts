import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CamdenFetchError,
  INCREMENTAL_FILTER_COLUMN,
  createCamdenAdapter,
  normaliseCamdenRow,
  scoreConfidence,
} from '@/data-sources/camden/adapter';
import { runIngestion, type IngestionSink } from '@/data-sources/shared/pipeline';
import {
  REDACTION_PLACEHOLDER,
  containsRegistration,
  isForbiddenField,
  redactRegistrations,
  redactionContextFor,
  sanitiseSourceMetadata,
} from '@/data-sources/shared/pii';
import { precisionCeilingFrom, publisherClaimsPrecision } from '@/core/geography/types';
import { DEFAULT_SCORING_CONFIG } from '@/core/scoring/config';
import {
  normaliseStreetName,
  parseContraventionCode,
  parseCoordinates,
  parsePostcodeDistrict,
  parseSourceTimestamp,
  contentHash,
} from '@/data-sources/shared/normalise';
import {
  CAMDEN_BBOX,
  DELIBERATELY_DROPPED_FIELDS,
  isForbiddenEventTimeColumn,
} from '@/data-sources/camden/schema';
import {
  classifyEnforcement,
  describeEnforcementMix,
} from '@/data-sources/camden/enforcement-class';
import type { NormalisedPcnEvent } from '@/data-sources/shared/types';

const FIXTURE_ROWS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/camden/sample-rows.json', import.meta.url)), 'utf8'),
) as unknown[];

function collectingSink() {
  const upserted: NormalisedPcnEvent[] = [];
  const recorded: { errorCode: string; sourceRecordId: string | null }[] = [];
  const sink: IngestionSink = {
    async upsertEvents(events) {
      upserted.push(...events);
      return { inserted: events.length, updated: 0, unchanged: 0 };
    },
    async recordErrors(errors) {
      recorded.push(...errors.map((e) => ({ errorCode: e.errorCode, sourceRecordId: e.sourceRecordId })));
    },
  };
  return { sink, upserted, recorded };
}

function stubAdapter(rows: readonly unknown[]) {
  return createCamdenAdapter({
    datasetUrl: 'https://example.test/resource/abcd.json',
    fetchImpl: (async () =>
      new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
  });
}

/* ------------------------------------------------------------------ */
/* Field-level normalisation                                           */
/* ------------------------------------------------------------------ */

describe('field normalisation', () => {
  it('expands street abbreviations so the same street matches itself', () => {
    expect(normaliseStreetName('Camden High St')).toBe('camden high street');
    expect(normaliseStreetName('CAMDEN HIGH STREET')).toBe('camden high street');
    expect(normaliseStreetName('Camden High Street.')).toBe('camden high street');
  });

  it('does not collapse genuinely different streets together', () => {
    expect(normaliseStreetName('Eversholt Street')).not.toBe(normaliseStreetName('Everholt Street'));
    expect(normaliseStreetName('Camden Road')).not.toBe(normaliseStreetName('Camden Street'));
  });

  it('reads slash dates as day-first, never month-first', () => {
    // 06/01/2026 is 6 January in the UK, not 1 June.
    expect(parseSourceTimestamp('06/01/2026')?.date).toBe('2026-01-06');
    expect(parseSourceTimestamp('13/01/2026')?.date).toBe('2026-01-13');
  });

  it('rejects impossible dates instead of rolling them into the next month', () => {
    expect(parseSourceTimestamp('31/02/2026')).toBeNull();
    expect(parseSourceTimestamp('2026-02-31')).toBeNull();
    expect(parseSourceTimestamp('2026-13-01')).toBeNull();
  });

  it('rejects impossible times', () => {
    expect(parseSourceTimestamp('2026-01-05T25:00:00')).toBeNull();
    expect(parseSourceTimestamp('2026-01-05T10:75:00')).toBeNull();
  });

  it('distinguishes a date-only value from a timestamp', () => {
    const dateOnly = parseSourceTimestamp('2026-01-07');
    expect(dateOnly?.timestamp).toBeNull();
    expect(dateOnly?.hour).toBeNull();
    const withTime = parseSourceTimestamp('2026-01-07T09:30:00');
    expect(withTime?.hour).toBe(9);
  });

  it('parses contravention codes and refuses malformed ones', () => {
    expect(parseContraventionCode('1')).toEqual({ code: '01', suffix: null });
    expect(parseContraventionCode('01a')).toEqual({ code: '01', suffix: 'a' });
    expect(parseContraventionCode('not-a-code')).toBeNull();
    expect(parseContraventionCode('999')).toBeNull();
    expect(parseContraventionCode('')).toBeNull();
  });

  it('rejects coordinates outside the borough bounding box', () => {
    expect(parseCoordinates('-0.1338', '51.5305', CAMDEN_BBOX)).toEqual({
      longitude: -0.1338,
      latitude: 51.5305,
    });
    // Swapped lat/long.
    expect(parseCoordinates('51.53', '-0.13', CAMDEN_BBOX)).toBeNull();
    // Null island.
    expect(parseCoordinates('0', '0', CAMDEN_BBOX)).toBeNull();
    // Unconverted British National Grid easting.
    expect(parseCoordinates('529000', '183000', CAMDEN_BBOX)).toBeNull();
  });

  it('extracts postcode districts', () => {
    expect(parsePostcodeDistrict('NW1 1DN')).toBe('NW1');
    expect(parsePostcodeDistrict('nw1 1dn')).toBe('NW1');
    expect(parsePostcodeDistrict('WC1H')).toBe('WC1H');
    expect(parsePostcodeDistrict('not a postcode')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Row normalisation                                                   */
/* ------------------------------------------------------------------ */

describe('Camden row normalisation', () => {
  it('accepts a well-formed row with full provenance', () => {
    const result = normaliseCamdenRow(FIXTURE_ROWS[0], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.sourceRecordId).toBe('CA00000001');
    expect(result.event.contraventionCode).toBe('01');
    expect(result.event.issuedDate).toBe('2026-01-05');
    expect(result.event.issuedHour).toBe(9);
    expect(result.event.streetNameNormalised).toBe('eversholt street');
    expect(result.event.locationSlug).toBe('eversholt-street');
    expect(result.event.postcodeDistrict).toBe('NW1');
    expect(result.event.longitude).toBeCloseTo(-0.1338);
    expect(result.event.rowHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('combines a separate date and time column', () => {
    const result = normaliseCamdenRow(FIXTURE_ROWS[1], 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.issuedDate).toBe('2026-01-06');
    expect(result.event.issuedHour).toBe(14);
    expect(result.event.streetNameNormalised).toBe('camden high street');
  });

  it('keeps a row with no coordinates but never invents a position', () => {
    const result = normaliseCamdenRow(FIXTURE_ROWS[2], 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.longitude).toBeNull();
    expect(result.event.latitude).toBeNull();
    expect(result.warnings).toContain('COORDINATES_ABSENT');
    // The absence is recorded with its reason rather than papered over.
    expect(result.event.sourceMetadata['_geometry']).toMatchObject({ precision: 'NONE' });
  });

  it('keeps a row with an unparseable contravention code but records the code as null', () => {
    const result = normaliseCamdenRow(FIXTURE_ROWS[3], 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.contraventionCode).toBeNull();
    expect(result.warnings).toContain('CONTRAVENTION_CODE_UNPARSEABLE');
  });

  it('discards swapped coordinates rather than plotting them in the sea', () => {
    const result = normaliseCamdenRow(FIXTURE_ROWS[4], 4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.longitude).toBeNull();
    expect(result.warnings).toContain('COORDINATES_OUT_OF_RANGE');
  });

  it('rejects a row whose date does not exist', () => {
    const result = normaliseCamdenRow(FIXTURE_ROWS[5], 5);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorCode).toBe('MISSING_OR_INVALID_DATE');
    expect(result.error.sourceRecordId).toBe('CA00000006');
  });

  it('rejects a row with no usable street', () => {
    const result = normaliseCamdenRow(FIXTURE_ROWS[6], 6);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorCode).toBe('MISSING_STREET');
  });

  it('rejects a row with no source record id, since it cannot be deduplicated', () => {
    const result = normaliseCamdenRow(FIXTURE_ROWS[7], 7);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorCode).toBe('MISSING_RECORD_ID');
  });

  it('rejects a future-dated row', () => {
    const result = normaliseCamdenRow(FIXTURE_ROWS[8], 8);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorCode).toBe('DATE_IN_FUTURE');
  });

  it('rejects rows that are not objects at all', () => {
    for (const bad of [null, 'a string', 42, [1, 2, 3]]) {
      const result = normaliseCamdenRow(bad, 0);
      expect(result.ok).toBe(false);
    }
  });

  it('measures how well a row is specified, not whether it can be mapped', () => {
    // A row with an exact time, a contravention code, a zone and a district is
    // well specified whether or not the source published a coordinate. Treating
    // it as too poor to rank because it cannot be plotted asks the wrong
    // question of a ranking of streets by recorded activity.
    const wellSpecifiedNoCoords = scoreConfidence({
      hasCoordinates: false,
      hasContravention: true,
      hasTime: true,
      hasLocality: true,
      hasPostcodeDistrict: true,
    });
    expect(wellSpecifiedNoCoords).toBeGreaterThan(0.4);

    // Coordinates still add locational specificity, so they still count.
    const sameRowWithCoords = scoreConfidence({
      hasCoordinates: true,
      hasContravention: true,
      hasTime: true,
      hasLocality: true,
      hasPostcodeDistrict: true,
    });
    expect(sameRowWithCoords).toBeGreaterThan(wellSpecifiedNoCoords);
  });

  it('still refuses a row that identifies a street but characterises nothing', () => {
    // The gate has to keep biting: an id, a date and a street name alone is not
    // enough to rank a location on.
    const bare = scoreConfidence({
      hasCoordinates: false,
      hasContravention: false,
      hasTime: false,
      hasLocality: false,
      hasPostcodeDistrict: false,
    });
    expect(bare).toBeLessThan(DEFAULT_SCORING_CONFIG.minDataConfidence);
  });

  it('scores a real live Camden row above the gate', () => {
    // The end-to-end consequence: with the live schema, Camden streets can be
    // ranked. Under the previous model every one of them was refused.
    const result = normaliseCamdenRow(LIVE_ROWS[0], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.longitude).toBeNull();
    expect(result.event.dataConfidence).toBeGreaterThanOrEqual(
      DEFAULT_SCORING_CONFIG.minDataConfidence,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Personal data                                                       */
/* ------------------------------------------------------------------ */

describe('personal data handling', () => {
  it('never lets a vehicle registration reach the public event record', () => {
    const result = normaliseCamdenRow(FIXTURE_ROWS[9], 9);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialised = JSON.stringify(result.event);
    expect(serialised).not.toContain('AB12 CDE');
    expect(serialised).not.toContain('AB12CDE');
    expect(serialised).not.toContain('A Person');
    expect(result.warnings).toContain('SOURCE_CONTAINED_PERSONAL_FIELDS');
  });

  it('drops fields the adapter has not explicitly allowed', () => {
    const result = sanitiseSourceMetadata(
      { street: 'Eversholt Street', secret_new_column: 'something', vrm: 'AB12CDE' },
      ['street'],
    );
    expect(result.metadata).toEqual({ street: 'Eversholt Street' });
    expect(result.droppedFields).toContain('secret_new_column');
    expect(result.forbiddenFields).toContain('vrm');
  });

  it('redacts registration-shaped text inside an allowed field', () => {
    const result = sanitiseSourceMetadata({ street: 'Outside AB12 CDE on Camden Road' }, ['street']);
    expect(String(result.metadata.street)).not.toContain('AB12 CDE');
    expect(result.redactedFields).toContain('street');
  });

  it('recognises the UK registration formats still on the road', () => {
    expect(containsRegistration('AB12 CDE')).toBe(true);
    expect(containsRegistration('A123 BCD')).toBe(true);
    expect(containsRegistration('ABC 123D')).toBe(true);
  });

  it('keeps error excerpts free of personal data', () => {
    const result = normaliseCamdenRow(
      { pcn_id: 'X1', street: 'Road', vehicle_registration: 'AB12CDE', issue_date: 'nonsense' },
      0,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error.rawExcerpt)).not.toContain('AB12CDE');
  });
});

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

describe('ingestion pipeline', () => {
  it('produces a complete report and never silently drops a malformed row', async () => {
    const { sink, upserted, recorded } = collectingSink();
    const result = await runIngestion(stubAdapter(FIXTURE_ROWS), sink, { maxRejectionRate: 1 });

    expect(result.report.fetched).toBe(12);
    // 4 rejected: impossible date, blank street, no record id, future date.
    expect(result.report.rejected).toBe(4);
    // 8 accepted rows minus 1 in-batch duplicate.
    expect(result.report.accepted).toBe(7);
    expect(result.report.inserted).toBe(7);
    expect(result.report.geolocated + result.report.notGeolocated).toBe(8);
    expect(result.status).toBe('PARTIAL');

    // Every rejection is recorded with its reason.
    expect(recorded.filter((e) => e.errorCode !== 'DUPLICATE_IN_BATCH')).toHaveLength(4);
    expect(recorded.map((e) => e.errorCode)).toContain('DUPLICATE_IN_BATCH');
    expect(upserted).toHaveLength(7);
  });

  it('deduplicates repeated source record ids within a batch', async () => {
    const { sink, upserted } = collectingSink();
    await runIngestion(stubAdapter(FIXTURE_ROWS), sink, { maxRejectionRate: 1 });
    const ids = upserted.map((e) => e.sourceRecordId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('invalid rows do not corrupt the accepted records', async () => {
    const { sink, upserted } = collectingSink();
    await runIngestion(stubAdapter(FIXTURE_ROWS), sink, { maxRejectionRate: 1 });
    for (const event of upserted) {
      expect(event.sourceRecordId).toBeTruthy();
      expect(event.issuedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(event.streetNameNormalised.length).toBeGreaterThan(0);
      expect(event.dataConfidence).toBeGreaterThanOrEqual(0);
      expect(event.dataConfidence).toBeLessThanOrEqual(1);
      if (event.longitude !== null) {
        expect(event.longitude).toBeGreaterThan(CAMDEN_BBOX.minLon);
        expect(event.longitude).toBeLessThan(CAMDEN_BBOX.maxLon);
      }
    }
  });

  it('fails the whole run rather than half-ingesting when the source changes shape', async () => {
    const brokenRows = Array.from({ length: 10 }, (_, i) => ({
      completely_different_column: `value-${i}`,
    }));
    const { sink, upserted } = collectingSink();
    const result = await runIngestion(stubAdapter(brokenRows), sink);

    expect(result.status).toBe('FAILED');
    expect(result.report.inserted).toBe(0);
    expect(upserted).toHaveLength(0);
    expect(result.message).toContain('changed shape');
  });

  it('records rejections even when the run fails', async () => {
    const brokenRows = Array.from({ length: 10 }, () => ({ nope: 'x' }));
    const { sink, recorded } = collectingSink();
    await runIngestion(stubAdapter(brokenRows), sink);
    expect(recorded).toHaveLength(10);
  });

  it('is deterministic — the same payload yields the same hashes', async () => {
    const a = collectingSink();
    const b = collectingSink();
    await runIngestion(stubAdapter(FIXTURE_ROWS), a.sink, { maxRejectionRate: 1 });
    await runIngestion(stubAdapter(FIXTURE_ROWS), b.sink, { maxRejectionRate: 1 });
    expect(a.upserted.map((e) => e.rowHash)).toEqual(b.upserted.map((e) => e.rowHash));
  });
});

/* ------------------------------------------------------------------ */
/* Configuration boundary                                              */
/* ------------------------------------------------------------------ */

describe('unconfigured source', () => {
  it('refuses to run rather than returning an empty result set', async () => {
    const adapter = createCamdenAdapter({});
    await expect(adapter.fetch({})).rejects.toBeInstanceOf(CamdenFetchError);
    await expect(adapter.fetch({})).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('surfaces a bad HTTP status instead of treating it as no data', async () => {
    const adapter = createCamdenAdapter({
      datasetUrl: 'https://example.test/resource/abcd.json',
      fetchImpl: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
    });
    await expect(adapter.fetch({})).rejects.toMatchObject({ code: 'BAD_STATUS' });
  });

  it('surfaces a non-array payload as a malformed response', async () => {
    const adapter = createCamdenAdapter({
      datasetUrl: 'https://example.test/resource/abcd.json',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: 'unauthorised' }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(adapter.fetch({})).rejects.toMatchObject({ code: 'MALFORMED_PAYLOAD' });
  });
});

/* ------------------------------------------------------------------ */
/* Live-source shapes                                                  */
/*                                                                     */
/* Regression cover for the shapes a real Socrata dataset can return    */
/* that a hand-written fixture would not. The nested point column is    */
/* the highest-risk difference: before this was handled, every row of   */
/* such a dataset was rejected and the whole run failed.                */
/* ------------------------------------------------------------------ */

describe('Socrata source shapes', () => {
  const base = {
    pcn_id: 'CA00099001',
    contravention_code: '01',
    issue_datetime: '2026-01-05T09:14:00',
    street: 'Eversholt Street',
  };

  it('reads coordinates from a legacy nested location object', () => {
    const result = normaliseCamdenRow(
      { ...base, location: { latitude: '51.5305', longitude: '-0.1338', human_address: '{}' } },
      0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.longitude).toBeCloseTo(-0.1338);
    expect(result.event.latitude).toBeCloseTo(51.5305);
  });

  it('reads coordinates from a GeoJSON point column', () => {
    const result = normaliseCamdenRow(
      { ...base, point: { type: 'Point', coordinates: [-0.1426, 51.539] } },
      0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.longitude).toBeCloseTo(-0.1426);
    expect(result.event.latitude).toBeCloseTo(51.539);
  });

  it('finds a point column under an unexpected name', () => {
    const result = normaliseCamdenRow(
      { ...base, some_new_geo_column: { latitude: 51.5305, longitude: -0.1338 } },
      0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.longitude).toBeCloseTo(-0.1338);
  });

  it('prefers explicit scalar columns over a nested point', () => {
    const result = normaliseCamdenRow(
      {
        ...base,
        longitude: '-0.1500',
        latitude: '51.5450',
        location: { latitude: '51.5305', longitude: '-0.1338' },
      },
      0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.longitude).toBeCloseTo(-0.15);
  });

  it('still rejects a nested point outside the Camden bounding box', () => {
    const result = normaliseCamdenRow(
      { ...base, location: { latitude: '53.4808', longitude: '-2.2426' } },
      0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.longitude).toBeNull();
    expect(result.warnings).toContain('COORDINATES_OUT_OF_RANGE');
  });

  it('keeps a row that gains an unrecognised nested column', () => {
    // One new column on the source must not discard the entire dataset.
    const result = normaliseCamdenRow(
      { ...base, longitude: '-0.1338', latitude: '51.5305', extra: { nested: { deeply: true } } },
      0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.longitude).toBeCloseTo(-0.1338);
    // And the unreviewable nested value is not retained.
    expect(JSON.stringify(result.event.sourceMetadata)).not.toContain('deeply');
  });

  it('never stringifies a nested object into a street name', () => {
    const result = normaliseCamdenRow(
      { pcn_id: 'CA1', issue_datetime: '2026-01-05T09:14:00', street: { unexpected: true } },
      0,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorCode).toBe('MISSING_STREET');
    expect(JSON.stringify(result.error)).not.toContain('[object Object]');
  });

  it('records which column supplied the coordinates, for traceability', () => {
    const result = normaliseCamdenRow(
      { ...base, location: { latitude: '51.5305', longitude: '-0.1338' } },
      0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const resolved = (result.event.sourceMetadata as { _resolvedFields?: { coordinates?: string } })
      ._resolvedFields;
    expect(resolved?.coordinates).toBe('location');
  });

  it('keeps the source record id readable in a rejection excerpt', () => {
    // A PCN reference is shaped like a dateless registration, so the scrubber
    // redacts it. Without this the one field that makes a rejection debuggable
    // is lost, for no privacy gain.
    const result = normaliseCamdenRow(
      { pcn_id: 'CA1', street: 'Eversholt Street', issue_date: 'not-a-date' },
      0,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.sourceRecordId).toBe('CA1');
    expect((result.error.rawExcerpt as Record<string, unknown>)._sourceRecordId).toBe('CA1');
  });
});

/* ------------------------------------------------------------------ */
/* Live Camden schema (dataset 4k7m-4gkk)                              */
/*                                                                     */
/* Fixture matching the columns the live probe actually returned. The   */
/* first probe accepted 0/50 rows because none of these column names    */
/* were in the alias lists.                                             */
/* ------------------------------------------------------------------ */

const LIVE_ROWS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/camden/live-schema-rows.json', import.meta.url)), 'utf8'),
) as Record<string, unknown>[];

describe('live Camden schema', () => {
  it('accepts every row of the live-shaped sample', () => {
    const results = LIVE_ROWS.map((row, i) => normaliseCamdenRow(row, i));
    const rejected = results.filter((r) => !r.ok);
    expect(rejected).toHaveLength(0);
  });

  it('uses socrata_id as the canonical record identifier', () => {
    const result = normaliseCamdenRow(LIVE_ROWS[0], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.sourceRecordId).toBe('1102');
    const resolved = (result.event.sourceMetadata as { _resolvedFields?: { recordId?: string } })
      ._resolvedFields;
    expect(resolved?.recordId).toBe('socrata_id');
  });

  it('uses contravention_date as the event timestamp', () => {
    const result = normaliseCamdenRow(LIVE_ROWS[0], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.issuedDate).toBe('2025-10-05');
    expect(result.event.issuedHour).toBe(9);
    const resolved = (result.event.sourceMetadata as { _resolvedFields?: { date?: string } })
      ._resolvedFields;
    expect(resolved?.date).toBe('contravention_date');
  });

  it('handles a date-only contravention_date without inventing a time', () => {
    const result = normaliseCamdenRow(LIVE_ROWS[2], 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.issuedDate).toBe('2025-07-14');
    expect(result.event.issuedHour).toBeNull();
    expect(result.event.issuedAt).toBeNull();
  });

  it('NEVER treats last_uploaded as the contravention date', () => {
    // Camden refreshes every row on the same publication date. Reading it as the
    // event time would restate the whole dataset as happening on a few days and
    // destroy every trend, busiest-hour and period figure — while still looking
    // healthy in the ingestion report.
    const result = normaliseCamdenRow(LIVE_ROWS[0], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.issuedDate).not.toBe('2026-08-30');
  });

  it('refuses a publication timestamp even when it is the only date present', () => {
    const result = normaliseCamdenRow(
      { socrata_id: 'x', street: 'Eversholt Street', last_uploaded: '2026-09-01T02:00:00.000' },
      0,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Rejected for having no event date, rather than silently dated to publication.
    expect(result.error.errorCode).toBe('MISSING_OR_INVALID_DATE');
  });

  it('rejects a publication-shaped column added to a date alias by mistake', () => {
    expect(isForbiddenEventTimeColumn('last_uploaded')).toBe(true);
    expect(isForbiddenEventTimeColumn('last_updated')).toBe(true);
    expect(isForbiddenEventTimeColumn(':updated_at')).toBe(true);
    expect(isForbiddenEventTimeColumn('contravention_date')).toBe(false);
  });

  it('takes the contravention suffix from its own column', () => {
    // The live source inlines the suffix in the code as well ("29J") and repeats
    // it in its own column ("J"). Both must reduce to the same numeric code and
    // the same suffix, whichever the row happens to carry.
    const result = normaliseCamdenRow(LIVE_ROWS[0], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.contraventionCode).toBe('29');
    expect((result.event.sourceMetadata as { _contraventionSuffix?: string })._contraventionSuffix).toBe('j');

    // Row 1 carries a code with no suffix column at all.
    const noSuffixColumn = normaliseCamdenRow(LIVE_ROWS[1], 1);
    expect(noSuffixColumn.ok).toBe(true);
    if (!noSuffixColumn.ok) return;
    expect(noSuffixColumn.event.contraventionCode).toBe('99');
    expect(
      (noSuffixColumn.event.sourceMetadata as { _contraventionSuffix?: string | null })
        ._contraventionSuffix,
    ).toBeNull();
  });

  it('keeps the publisher’s own contravention description', () => {
    const result = normaliseCamdenRow(LIVE_ROWS[0], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.event.sourceMetadata)).toContain('one-way restriction');
  });

  it('records the controlled parking zone as the locality', () => {
    const result = normaliseCamdenRow(LIVE_ROWS[0], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.locality).toBe('CA-E');
  });

  it('reads the postcode district Camden buries inside the street value', () => {
    // The source has no postcode column, but every live street carries a
    // district ("MAPLE STREET W1"). Without this the field stays null while the
    // data plainly contains the single most useful disambiguator for a
    // street-reference lookup.
    const result = normaliseCamdenRow(LIVE_ROWS[0], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.postcodeDistrict).toBe('W1');
    // Recorded as derived, so it is never mistaken for a published column.
    expect(
      (result.event.sourceMetadata as { _postcodeDistrictSource?: string })._postcodeDistrictSource,
    ).toBe('DERIVED_FROM_STREET_VALUE');
  });

  it('keeps the district in the location identity so two streets do not merge', () => {
    // "MAPLE STREET W1" and "MAPLE STREET NW1" are different streets. Splitting
    // a street that is sometimes recorded without its district is visible in the
    // data; silently merging two real streets is not.
    const w1 = normaliseCamdenRow({ ...LIVE_ROWS[0], street: 'MAPLE STREET W1' }, 0);
    const nw1 = normaliseCamdenRow({ ...LIVE_ROWS[0], street: 'MAPLE STREET NW1' }, 1);
    expect(w1.ok && nw1.ok).toBe(true);
    if (!w1.ok || !nw1.ok) return;
    expect(w1.event.locationSlug).not.toBe(nw1.event.locationSlug);
    expect(w1.event.postcodeDistrict).toBe('W1');
    expect(nw1.event.postcodeDistrict).toBe('NW1');
  });

  it('never fabricates coordinates for a dataset that has none', () => {
    for (const [i, row] of LIVE_ROWS.entries()) {
      const result = normaliseCamdenRow(row, i);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.event.longitude).toBeNull();
      expect(result.event.latitude).toBeNull();
      expect(result.warnings).toContain('COORDINATES_ABSENT');
    }
  });

  it('does not let a missing coordinate suppress a well-specified record', () => {
    const result = normaliseCamdenRow(LIVE_ROWS[0], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No coordinate, and still rankable: the row carries an exact timestamp, a
    // contravention code, a zone and a district. What it cannot do is appear on
    // the map, and that is enforced separately, in SQL.
    expect(result.event.longitude).toBeNull();
    expect(result.event.dataConfidence).toBeGreaterThanOrEqual(
      DEFAULT_SCORING_CONFIG.minDataConfidence,
    );
  });

  it('drops outcome and vehicle fields rather than storing them', () => {
    const result = normaliseCamdenRow(LIVE_ROWS[0], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialised = JSON.stringify(result.event);
    for (const dropped of DELIBERATELY_DROPPED_FIELDS) {
      expect(serialised).not.toContain(dropped);
    }
    expect(serialised).not.toContain('Paid/Closed');
  });

  it('retains the publisher’s spatial accuracy verbatim, and reads it as no claim', () => {
    const result = normaliseCamdenRow(LIVE_ROWS[0], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Camden publishes "Unknown". Stored verbatim for traceability...
    expect((result.event.sourceMetadata as { spatial_accuracy?: string }).spatial_accuracy).toBe(
      'Unknown',
    );
    expect(
      (result.event.sourceMetadata as { _publisherSpatialAccuracy?: string })
        ._publisherSpatialAccuracy,
    ).toBe('Unknown');
    // ...but never read as a precision claim, which would be worse than having
    // no field at all: it would let a caller believe a claim exists.
    expect(publisherClaimsPrecision('Unknown')).toBe(false);
    expect(precisionCeilingFrom('Unknown')).toBeNull();
    expect(publisherClaimsPrecision('Street')).toBe(true);
    expect(precisionCeilingFrom('Street')).toBe('STREET');
  });

  it('keeps postcode districts and road numbers in a street value', () => {
    // The dateless-registration pattern matches "NW1" and "A5" exactly as it
    // matches an old plate. In a street column those tokens are the ones a
    // street-reference lookup matches on, so redacting them would destroy the
    // geography while protecting nothing the field-name guard has not blocked.
    const result = normaliseCamdenRow(LIVE_ROWS[0], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.streetName).toBe('MAPLE STREET W1');
    expect((result.event.sourceMetadata as { street?: string }).street).toBe('MAPLE STREET W1');
    expect(JSON.stringify(result.event)).not.toContain(REDACTION_PLACEHOLDER);
  });

  it('still removes a real registration leaked into a street value', () => {
    const result = normaliseCamdenRow(
      { ...LIVE_ROWS[0], street: 'MAPLE STREET AB12 CDE' },
      0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.event.sourceMetadata as { street?: string }).street).toContain(
      REDACTION_PLACEHOLDER,
    );
  });
});

describe('fetching at realistic volume', () => {
  // Every one of these was found by running the pipeline end to end against
  // 6000 live-shaped rows rather than by reading the code.

  it('hashes a payload too large to stringify in one go', () => {
    // JSON.stringify on a large array throws RangeError: Invalid string length
    // once the result passes V8's maximum string size, which a full borough
    // dataset reaches. The hash is fed row by row instead.
    const big = Array.from({ length: 50_000 }, (_, i) => ({
      socrata_id: String(i),
      street: 'MAPLE STREET W1',
      padding: 'x'.repeat(200),
    }));
    const hash = contentHash(big);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Still a content hash: a changed row changes it.
    const changed = [...big.slice(0, -1), { ...big[big.length - 1], street: 'GOWER STREET WC1' }];
    expect(contentHash(changed)).not.toBe(hash);
    // And a shorter payload does not collide with it.
    expect(contentHash(big.slice(0, -1))).not.toBe(hash);
  });

  it('filters an incremental refresh on a column the dataset actually has', async () => {
    // `issue_date` was a guess and is not in Camden's schema: every incremental
    // refresh would have been rejected by Socrata with a 400.
    const seen: string[] = [];
    const adapter = createCamdenAdapter({
      datasetUrl: 'https://opendata.camden.gov.uk/resource/4k7m-4gkk.json',
      fetchImpl: async (url: Parameters<typeof fetch>[0]) => {
        seen.push(String(url));
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await adapter.fetch({ since: '2026-01-01' });
    const where = new URL(seen[0]!).searchParams.get('$where');
    expect(where).toContain(INCREMENTAL_FILTER_COLUMN);
    expect(where).toContain('contravention_date');
    expect(where).not.toContain('issue_date');
    // And never the publication timestamp, which would return everything or nothing.
    expect(where).not.toContain('last_uploaded');
  });

  it('refuses a dataset larger than the page budget instead of truncating it', async () => {
    // Found by running against a source with more rows than the budget allowed:
    // the fetch stopped at the ceiling and the run reported SUCCEEDED, having
    // silently stored a truncated copy and rebuilt every aggregate over it.
    const full = (n: number) =>
      JSON.stringify(
        Array.from({ length: n }, (_, i) => ({
          socrata_id: String(i),
          street: 'A STREET W1',
          contravention_date: '2025-06-01T09:00:00.000',
        })),
      );
    let call = 0;
    const adapter = createCamdenAdapter({
      datasetUrl: 'https://opendata.camden.gov.uk/resource/4k7m-4gkk.json',
      pageSize: 10,
      maxPages: 3,
      // Every page is full and distinct, so the source never signals an end.
      fetchImpl: async () => {
        call += 1;
        const rows = JSON.parse(full(10)).map((r: Record<string, unknown>) => ({
          ...r,
          socrata_id: `${call}-${r['socrata_id']}`,
        }));
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await expect(adapter.fetch({})).rejects.toThrow(/truncated copy/);
  });

  it('does not refuse when the caller asked for a bounded slice', async () => {
    // --limit is an explicit request for part of the dataset, so stopping at the
    // budget is what was asked for, not a silent truncation.
    let call = 0;
    const adapter = createCamdenAdapter({
      datasetUrl: 'https://opendata.camden.gov.uk/resource/4k7m-4gkk.json',
      pageSize: 10,
      maxPages: 3,
      fetchImpl: async () => {
        call += 1;
        const rows = Array.from({ length: 10 }, (_, i) => ({
          socrata_id: `${call}-${i}`,
          street: 'A STREET W1',
        }));
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const result = await adapter.fetch({ limit: 10 });
    expect(result.rows).toHaveLength(10);
  });

  it('accumulates a large page without overflowing the call stack', async () => {
    // `rows.push(...payload)` passes every row as a separate argument. At the
    // page size the adapter actually uses that overflows the stack.
    const rows = Array.from({ length: 60_000 }, (_, i) => ({
      socrata_id: String(i),
      street: 'A STREET W1',
      contravention_date: '2025-06-01T09:00:00.000',
    }));
    const adapter = createCamdenAdapter({
      datasetUrl: 'https://opendata.camden.gov.uk/resource/4k7m-4gkk.json',
      pageSize: 100_000,
      maxPages: 2,
      fetchImpl: async () =>
        new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const result = await adapter.fetch({});
    expect(result.rows).toHaveLength(60_000);
  });

  it('stops rather than looping when a source ignores $offset', async () => {
    // An endpoint that returns the same page forever would otherwise be paged
    // 200 times, accumulating duplicates until it ran out of memory.
    const page = JSON.stringify(
      Array.from({ length: 5000 }, (_, i) => ({ socrata_id: String(i), street: 'A STREET W1' })),
    );
    let calls = 0;
    const adapter = createCamdenAdapter({
      datasetUrl: 'https://opendata.camden.gov.uk/resource/4k7m-4gkk.json',
      // Pinned so the page looks full and the loop continues to a second page.
      pageSize: 5000,
      fetchImpl: async () => {
        calls += 1;
        return new Response(page, { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await expect(adapter.fetch({})).rejects.toThrow(/ignoring \$offset/);
    // Caught on the second page, not the two-hundredth.
    expect(calls).toBe(2);
  });
});

describe('registration redaction does not eat geography', () => {
  // Found in the live probe: every street sample rendered as
  // "MAPLE STREET [redacted]". The dateless-registration pattern
  // /\b[A-Z]{1,3}\s?\d{1,4}\b/ matches "NW1" and "A5" exactly as it matches an
  // old plate, and those tokens are what a street-reference lookup keys on.
  const LOCATIONAL = ['MAPLE STREET NW1', 'HAMPSTEAD ROAD A5', 'CANAL STREET E14', 'JUDD STREET N/O 12'];

  it('keeps postcode districts, road numbers and junction refs in location fields', () => {
    for (const value of LOCATIONAL) {
      expect(redactRegistrations(value, redactionContextFor('street'))).toBe(value);
      expect(redactRegistrations(value, redactionContextFor('controlled_parking_zone_area'))).toBe(value);
    }
  });

  it('still removes registrations of every specific format from a location field', () => {
    for (const plate of ['AB12 CDE', 'AB12CDE', 'A123 BCD', 'ABC 123D']) {
      const value = `MAPLE STREET ${plate}`;
      expect(redactRegistrations(value, redactionContextFor('street'))).toContain(REDACTION_PLACEHOLDER);
      expect(redactRegistrations(value, redactionContextFor('street'))).not.toContain(plate);
    }
  });

  it('keeps the ambiguous pattern everywhere else, where a leak actually hides', () => {
    // Outside a location field the registration reading is the one that matters,
    // so the broad pattern stays. Narrowing it is a decision about one column
    // type, not a general relaxation.
    expect(redactRegistrations('seen NW1 again', redactionContextFor('notes'))).toContain(
      REDACTION_PLACEHOLDER,
    );
    expect(redactionContextFor('ticket_description')).toBe('free-text');
    expect(redactionContextFor('charging_band_description')).toBe('free-text');
    expect(redactionContextFor('street')).toBe('location');
    expect(redactionContextFor('controlled_parking_zone_area')).toBe('location');
  });

  it('leaves the field-name guard untouched', () => {
    // The narrowing must not open a hole: columns named for a registration, a
    // keeper or an officer are still refused outright, whatever they contain.
    for (const field of [
      'country_vehicle_registered_to',
      'civil_enforcement_officer_error',
      'vrm',
      'keeper_name',
    ]) {
      expect(isForbiddenField(field)).toBe(true);
    }
    const sanitised = sanitiseSourceMetadata(
      { street: 'MAPLE STREET NW1', country_vehicle_registered_to: 'United Kingdom' },
      ['street', 'country_vehicle_registered_to'],
    );
    expect(sanitised.metadata['street']).toBe('MAPLE STREET NW1');
    expect(sanitised.metadata).not.toHaveProperty('country_vehicle_registered_to');
    expect(sanitised.forbiddenFields).toContain('country_vehicle_registered_to');
  });
});

describe('enforcement classification', () => {
  it('does NOT classify MTC as parking', () => {
    const result = normaliseCamdenRow(LIVE_ROWS[0], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.enforcementType).toBe('MOVING_TRAFFIC');
    expect(result.event.enforcementType).not.toBe('PARKING');
  });

  it('classifies a parking PCN as parking', () => {
    const result = normaliseCamdenRow(LIVE_ROWS[2], 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.enforcementType).toBe('PARKING');
  });

  it('leaves the live O/S TMA type unclassified rather than assuming parking', () => {
    // 34 of the 50 live rows carry ticket_type "O/S TMA". It is plausibly
    // on-street enforcement under the Traffic Management Act, but the source has
    // not said so and the description does not resolve it. A plausible reading is
    // not evidence: it stays UNKNOWN and is counted separately until the source
    // tells us what it is.
    const result = normaliseCamdenRow(LIVE_ROWS[1], 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.enforcementType).toBe('UNKNOWN');
    expect(result.event.enforcementType).not.toBe('PARKING');
    expect(result.warnings).toContain('ENFORCEMENT_TYPE_UNRECOGNISED');
    // The raw value survives so the question can be answered later.
    expect(JSON.stringify(result.event.sourceMetadata)).toContain('O/S TMA');
  });

  it('marks an unrecognised ticket type UNKNOWN rather than guessing', () => {
    const result = normaliseCamdenRow(LIVE_ROWS[3], 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.enforcementType).toBe('UNKNOWN');
    expect(result.warnings).toContain('ENFORCEMENT_TYPE_UNRECOGNISED');
  });

  it('records the CCTV enforcement channel', () => {
    const cctv = normaliseCamdenRow(LIVE_ROWS[0], 0);
    const street = normaliseCamdenRow(LIVE_ROWS[1], 1);
    expect(cctv.ok && (cctv.event.sourceMetadata as { _viaCctv?: boolean })._viaCctv).toBe(true);
    expect(street.ok && (street.event.sourceMetadata as { _viaCctv?: boolean })._viaCctv).toBe(false);
  });

  it('resolves the live O/S TMA type from the contravention description', () => {
    // "On Street Contravention" says where the contravention happened, not what
    // it was. Reading "on street" as "parking" would be our inference, not
    // Camden's statement — so the class comes from Camden's own description of
    // what the driver did, and the basis is recorded so it can be audited.
    const parking = normaliseCamdenRow(LIVE_ROWS[2], 2);
    expect(parking.ok).toBe(true);
    if (!parking.ok) return;
    expect(parking.event.enforcementType).toBe('PARKING');
    expect(
      (parking.event.sourceMetadata as { _enforcementClassBasis?: string })._enforcementClassBasis,
    ).toBe('CONTRAVENTION_DESCRIPTION');
  });

  it('leaves O/S TMA unclassified when the contravention description says nothing decisive', () => {
    const opaque = normaliseCamdenRow(LIVE_ROWS[1], 1);
    expect(opaque.ok).toBe(true);
    if (!opaque.ok) return;
    expect(opaque.event.enforcementType).toBe('UNKNOWN');
    expect(opaque.event.enforcementType).not.toBe('PARKING');
    expect(
      (opaque.event.sourceMetadata as { _enforcementClassBasis?: string })._enforcementClassBasis,
    ).toBe('NONE');
    expect(JSON.stringify(opaque.event.sourceMetadata)).toContain('O/S TMA');
  });

  it('classifies the bus lane rows the live sample contains', () => {
    const bus = normaliseCamdenRow(LIVE_ROWS[5], 5);
    expect(bus.ok).toBe(true);
    if (!bus.ok) return;
    expect(bus.event.enforcementType).toBe('BUS_LANE');
  });

  it('lets an explicit ticket type outrank the contravention description', () => {
    // A code the source uses deliberately is stronger evidence than prose.
    const c = classifyEnforcement('MTC', 'Moving Traffic Contravention', 'Yes', 'Parked in a bay');
    expect(c.enforcementClass).toBe('MOVING_TRAFFIC');
    expect(c.basis).toBe('TICKET_TYPE');
  });

  it('never lets an unrecognised description become parking', () => {
    const c = classifyEnforcement('O/S TMA', 'On Street Contravention', 'No', 'Contravention of an order');
    expect(c.enforcementClass).toBe('UNKNOWN');
    expect(c.basis).toBe('NONE');
  });

  it('classifies exactly, so a code is not matched by a stray substring', () => {
    expect(classifyEnforcement('MTC').enforcementClass).toBe('MOVING_TRAFFIC');
    expect(classifyEnforcement('BL').enforcementClass).toBe('BUS_LANE');
    expect(classifyEnforcement('PCN').enforcementClass).toBe('PARKING');
    expect(classifyEnforcement('').enforcementClass).toBe('UNKNOWN');
    expect(classifyEnforcement(null).enforcementClass).toBe('UNKNOWN');
  });

  it('prefers bus lane over moving traffic when both words appear', () => {
    expect(classifyEnforcement('X', 'Bus lane moving traffic camera').enforcementClass).toBe('BUS_LANE');
  });

  it('describes a mixed set without calling it parking', () => {
    const mixed = describeEnforcementMix({ PARKING: 10, MOVING_TRAFFIC: 5 });
    expect(mixed).toContain('mix');
    expect(mixed).not.toMatch(/^Parking penalty/);

    const mtcOnly = describeEnforcementMix({ MOVING_TRAFFIC: 5 });
    expect(mtcOnly).toContain('not parking');
  });
});

describe('legacy fixture formats still supported', () => {
  it('continues to accept the original pcn_id / issue_datetime shape', () => {
    const result = normaliseCamdenRow(FIXTURE_ROWS[0], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.sourceRecordId).toBe('CA00000001');
    expect(result.event.issuedDate).toBe('2026-01-05');
  });

  it('deduplication stays deterministic across both shapes', () => {
    const a = normaliseCamdenRow(LIVE_ROWS[0], 0);
    const b = normaliseCamdenRow(LIVE_ROWS[0], 99);
    expect(a.ok && b.ok && a.event.rowHash === b.event.rowHash).toBe(true);

    // A different row must hash differently.
    const c = normaliseCamdenRow(LIVE_ROWS[1], 1);
    expect(a.ok && c.ok && a.event.rowHash !== c.event.rowHash).toBe(true);
  });
});
