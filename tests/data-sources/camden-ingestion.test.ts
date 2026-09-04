import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CamdenFetchError,
  createCamdenAdapter,
  normaliseCamdenRow,
  scoreConfidence,
} from '@/data-sources/camden/adapter';
import { runIngestion, type IngestionSink } from '@/data-sources/shared/pipeline';
import { containsRegistration, sanitiseSourceMetadata } from '@/data-sources/shared/pii';
import {
  normaliseStreetName,
  parseContraventionCode,
  parseCoordinates,
  parsePostcodeDistrict,
  parseSourceTimestamp,
} from '@/data-sources/shared/normalise';
import { CAMDEN_BBOX } from '@/data-sources/camden/schema';
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
    // Confidence is capped so the scoring layer will refuse to rank it.
    expect(result.event.dataConfidence).toBeLessThan(0.4);
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

  it('caps confidence for rows that cannot be placed on a map', () => {
    expect(
      scoreConfidence({ hasCoordinates: false, hasContravention: true, hasTime: true, hasLocality: true }),
    ).toBeLessThan(0.4);
    expect(
      scoreConfidence({ hasCoordinates: true, hasContravention: true, hasTime: true, hasLocality: true }),
    ).toBeGreaterThan(0.9);
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
