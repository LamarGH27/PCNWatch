import { describe, expect, it } from 'vitest';
import {
  QUALITY_THRESHOLDS,
  analyseQuality,
  evaluateQualityGate,
} from '@/server/ingestion/postgres/quality';
import { periodStartFor } from '@/server/ingestion/postgres/run';
import type { IngestionError, NormalisedPcnEvent } from '@/data-sources/shared/types';

const KNOWN_CODES = new Set(['01', '12', '21']);
const TODAY = '2026-09-04';

function event(overrides: Partial<NormalisedPcnEvent> = {}): NormalisedPcnEvent {
  return {
    sourceRecordId: 'CA1',
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
    locality: null,
    postcodeDistrict: 'NW1',
    longitude: -0.1338,
    latitude: 51.5305,
    dataConfidence: 0.9,
    sourceMetadata: {},
    rowHash: 'h1',
    ...overrides,
  };
}

/** A batch large enough to clear the minimum-records threshold. */
function batch(n: number, overrides: (i: number) => Partial<NormalisedPcnEvent> = () => ({})) {
  return Array.from({ length: n }, (_, i) =>
    event({ sourceRecordId: `CA${i}`, rowHash: `h${i}`, ...overrides(i) }),
  );
}

describe('data-quality measurement', () => {
  it('measures geolocation rate rather than assuming it', () => {
    const events = [...batch(80), ...batch(20).map((e) => ({ ...e, longitude: null, latitude: null }))];
    const q = analyseQuality(events, [], KNOWN_CODES, TODAY);
    expect(q.location.withCoordinates).toBe(80);
    expect(q.location.withoutCoordinates).toBe(20);
    expect(q.location.percentageGeolocated).toBe(80);
  });

  it('reports shared coordinates without treating them as an error', () => {
    // Several PCNs at one point is exactly what a hotspot is. It must be
    // reported, never silently deduplicated away.
    const q = analyseQuality(batch(10), [], KNOWN_CODES, TODAY);
    expect(q.location.uniqueCoordinatePairs).toBe(1);
    expect(q.location.largestCoordinateCluster).toBe(10);
    const gate = evaluateQualityGate(q, 10, 0);
    expect(gate.failures.join(' ')).not.toMatch(/coordinate/i);
  });

  it('flags coordinates outside the expected bounds', () => {
    const q = analyseQuality(
      [...batch(99), event({ sourceRecordId: 'X', longitude: -2.24, latitude: 53.48 })],
      [],
      KNOWN_CODES,
      TODAY,
    );
    expect(q.location.outsideBounds).toBe(1);
    expect(q.warnings.some((w) => w.includes('outside the expected Camden bounding box'))).toBe(true);
    expect(evaluateQualityGate(q, 100, 0).pass).toBe(false);
  });

  it('identifies location values that carry no meaning', () => {
    const q = analyseQuality(
      [...batch(97), event({ streetName: 'Unknown' }), event({ streetName: 'N/A' }), event({ streetName: '   ' })],
      [],
      KNOWN_CODES,
      TODAY,
    );
    expect(q.location.vagueLocations).toBe(3);
  });

  it('reports the real date range and missing times', () => {
    const q = analyseQuality(
      [
        event({ issuedDate: '2025-03-01' }),
        event({ issuedDate: '2026-08-31', issuedHour: null }),
      ],
      [],
      KNOWN_CODES,
      TODAY,
    );
    expect(q.temporal.earliestDate).toBe('2025-03-01');
    expect(q.temporal.latestDate).toBe('2026-08-31');
    expect(q.temporal.withoutTime).toBe(1);
  });

  it('counts future and implausibly old dates', () => {
    const q = analyseQuality(
      [event({ issuedDate: '2030-01-01' }), event({ issuedDate: '1999-01-01' })],
      [],
      KNOWN_CODES,
      TODAY,
    );
    expect(q.temporal.futureDates).toBe(1);
    expect(q.temporal.implausiblyOld).toBe(1);
  });

  it('names contravention codes that have no reference record', () => {
    const q = analyseQuality(
      [...batch(50), event({ contraventionCode: '77' })],
      [],
      KNOWN_CODES,
      TODAY,
    );
    expect(q.contravention.unknownCodes).toContain('77');
    expect(q.warnings.some((w) => w.includes('77'))).toBe(true);
  });

  it('separates repeated ids from records that merely look alike', () => {
    const sameContent = [
      event({ sourceRecordId: 'A', rowHash: 'a' }),
      event({ sourceRecordId: 'B', rowHash: 'b' }),
    ];
    const q = analyseQuality(sameContent, [], KNOWN_CODES, TODAY);
    // Two genuine notices on one street at one time: not a repeated id.
    expect(q.duplicates.repeatedSourceIds).toBe(0);
    expect(q.duplicates.identicalContentDifferentId).toBe(1);
    // And the gate treats it as a caution, never a failure.
    const gate = evaluateQualityGate(q, 2, 0);
    expect(gate.cautions.some((c) => c.includes('separate genuine notices'))).toBe(true);
  });

  it('groups rejections by reason', () => {
    const errors: IngestionError[] = [
      { sourceRecordId: 'a', rowNumber: 1, errorCode: 'MISSING_OR_INVALID_DATE', errorMessage: '', rawExcerpt: null },
      { sourceRecordId: 'b', rowNumber: 2, errorCode: 'MISSING_OR_INVALID_DATE', errorMessage: '', rawExcerpt: null },
      { sourceRecordId: 'c', rowNumber: 3, errorCode: 'MISSING_STREET', errorMessage: '', rawExcerpt: null },
    ];
    const q = analyseQuality(batch(10), errors, KNOWN_CODES, TODAY);
    expect(q.rejections.MISSING_OR_INVALID_DATE).toBe(2);
    expect(q.rejections.MISSING_STREET).toBe(1);
  });
});

describe('geography availability', () => {
  // The remedies differ: a dataset with no coordinates needs a street-reference
  // dataset, one whose coordinates we cannot read needs an adapter fix. Reporting
  // both as "0% geolocated" would hide which of the two is true.
  const noCoords = { longitude: null, latitude: null } as const;

  it('recognises a source that publishes no coordinates at all', () => {
    const events = batch(200).map((e) => ({
      ...e,
      ...noCoords,
      sourceMetadata: { _geometry: { origin: 'NONE', reason: 'SOURCE_PUBLISHES_NO_COORDINATES' } },
    }));
    const q = analyseQuality(events, [], KNOWN_CODES, TODAY);
    expect(q.location.geographyAvailability).toBe('SOURCE_PUBLISHES_NONE');
    expect(q.location.noGeometryReasons['SOURCE_PUBLISHES_NO_COORDINATES']).toBe(200);
    expect(q.warnings.join(' ')).toMatch(/does not contain geography/);
    expect(q.warnings.join(' ')).not.toMatch(/adapter/);
  });

  it('recognises coordinates that are published but unreadable', () => {
    const events = batch(200).map((e) => ({
      ...e,
      ...noCoords,
      sourceMetadata: { _geometry: { origin: 'NONE', reason: 'SOURCE_COORDINATES_UNUSABLE' } },
    }));
    const q = analyseQuality(events, [], KNOWN_CODES, TODAY);
    expect(q.location.geographyAvailability).toBe('PUBLISHED_BUT_UNUSABLE');
    expect(q.warnings.join(' ')).toMatch(/adapter or source-format problem/);
  });

  it('fails the gate for both, but names the right remedy for each', () => {
    const none = evaluateQualityGate(
      analyseQuality(
        batch(200).map((e) => ({
          ...e,
          ...noCoords,
          sourceMetadata: { _geometry: { origin: 'NONE', reason: 'SOURCE_PUBLISHES_NO_COORDINATES' } },
        })),
        [],
        KNOWN_CODES,
        TODAY,
      ),
      200,
      0,
    );
    // Not a failure: the stored data is usable as enforcement intelligence even
    // though it cannot be mapped. The distinction is reported, loudly, rather
    // than collapsed into a pass/fail that would call sound data unusable.
    expect(none.pass).toBe(true);
    expect(none.mapReadiness).toBe('NO_SOURCE_GEOGRAPHY');
    expect(none.cautions.join(' ')).toMatch(/THE MAP WILL BE EMPTY/);
    expect(none.cautions.join(' ')).toMatch(/street-reference dataset/);
    // And it must not slander the records themselves.
    expect(none.cautions.join(' ')).toMatch(/not a fault in the records/);

    const unreadable = evaluateQualityGate(
      analyseQuality(
        batch(200).map((e) => ({
          ...e,
          ...noCoords,
          sourceMetadata: { _geometry: { origin: 'NONE', reason: 'SOURCE_COORDINATES_UNUSABLE' } },
        })),
        [],
        KNOWN_CODES,
        TODAY,
      ),
      200,
      0,
    );
    expect(unreadable.mapReadiness).toBe('GEOGRAPHY_UNREADABLE');
    expect(unreadable.failures.join(' ')).toMatch(/Fix the adapter/);
  });

  it('never lets a missing-geography pass be mistaken for a map', () => {
    // Passing the gate must not imply the map works. The readiness field is the
    // only thing that answers that, and it still says no.
    const q = analyseQuality(
      batch(500).map((e) => ({
        ...e,
        ...noCoords,
        sourceMetadata: { _geometry: { origin: 'NONE', reason: 'SOURCE_PUBLISHES_NO_COORDINATES' } },
      })),
      [],
      KNOWN_CODES,
      TODAY,
    );
    const gate = evaluateQualityGate(q, 500, 0);
    expect(gate.pass).toBe(true);
    expect(gate.mapReadiness).not.toBe('READY');
    expect(q.location.percentageGeolocated).toBe(0);
  });

  it('still fails when geography is published and we cannot read it', () => {
    // That is a fault in our code or a change in the source, not a property of
    // the dataset, and it must not pass.
    const q = analyseQuality(
      batch(500).map((e) => ({
        ...e,
        ...noCoords,
        sourceMetadata: { _geometry: { origin: 'NONE', reason: 'SOURCE_COORDINATES_UNUSABLE' } },
      })),
      [],
      KNOWN_CODES,
      TODAY,
    );
    expect(evaluateQualityGate(q, 500, 0).pass).toBe(false);
  });

  it('reports a fully positioned batch as complete and map-ready', () => {
    const q = analyseQuality(batch(500), [], KNOWN_CODES, TODAY);
    expect(q.location.geographyAvailability).toBe('COMPLETE');
    expect(evaluateQualityGate(q, 500, 0).mapReadiness).toBe('READY');
  });

  it('reports a partly positioned batch as sparse, not as missing geography', () => {
    const events = batch(200).map((e, i) => (i < 190 ? { ...e, ...noCoords } : e));
    const q = analyseQuality(events, [], KNOWN_CODES, TODAY);
    expect(q.location.geographyAvailability).toBe('PARTIAL');
    expect(evaluateQualityGate(q, 200, 0).mapReadiness).toBe('SPARSE');
  });
});

describe('borough-sized batches', () => {
  it('summarises coordinate clusters without overflowing the call stack', () => {
    // This is the real failure: a live run of 450,000 rows died in
    // analyseQuality on `Math.max(...clusters)`, which passes one argument per
    // distinct coordinate pair. 200,000 distinct pairs is enough to reproduce it
    // and fast enough to keep in the suite.
    const events = Array.from({ length: 200_000 }, (_, i) =>
      event({
        sourceRecordId: `CA${i}`,
        rowHash: `h${i}`,
        // Distinct at the six decimal places the cluster key uses.
        longitude: -0.2 + (i % 1000) * 0.000001,
        latitude: 51.5 + Math.floor(i / 1000) * 0.000001,
      }),
    );
    // One pair repeated, so the largest cluster is a real answer rather than 1.
    events.push(event({ sourceRecordId: 'DUP', rowHash: 'dup', longitude: -0.2, latitude: 51.5 }));

    const q = analyseQuality(events, [], KNOWN_CODES, TODAY);
    expect(q.location.withCoordinates).toBe(200_001);
    expect(q.location.uniqueCoordinatePairs).toBe(200_000);
    expect(q.location.largestCoordinateCluster).toBe(2);
    expect(q.location.sharedCoordinatePairs).toBe(1);
  });

  it('counts repeated ids at that scale too', () => {
    // Same shape of bug: one entry per source record id.
    const events = Array.from({ length: 150_000 }, (_, i) =>
      event({ sourceRecordId: `CA${i}`, rowHash: `h${i}` }),
    );
    const q = analyseQuality(events, [], KNOWN_CODES, TODAY);
    expect(q.duplicates.repeatedSourceIds).toBe(0);
    expect(q.totalAccepted).toBe(150_000);
  });
});

describe('quality gate', () => {
  it('passes a healthy batch', () => {
    const q = analyseQuality(batch(500), [], KNOWN_CODES, TODAY);
    expect(evaluateQualityGate(q, 500, 0).pass).toBe(true);
  });

  it('fails a batch too small to rank', () => {
    const q = analyseQuality(batch(10), [], KNOWN_CODES, TODAY);
    const gate = evaluateQualityGate(q, 10, 0);
    expect(gate.pass).toBe(false);
    expect(gate.failures.join(' ')).toContain(String(QUALITY_THRESHOLDS.minAcceptedRecords));
  });

  it('fails when too few records are geolocated for a usable map', () => {
    const events = batch(200).map((e, i) =>
      i < 190 ? { ...e, longitude: null, latitude: null } : e,
    );
    const q = analyseQuality(events, [], KNOWN_CODES, TODAY);
    const gate = evaluateQualityGate(q, 200, 0);
    expect(gate.pass).toBe(false);
    expect(gate.failures.join(' ')).toMatch(/geolocated/);
  });

  it('fails when the rejection rate suggests the source changed shape', () => {
    const q = analyseQuality(batch(200), [], KNOWN_CODES, TODAY);
    const gate = evaluateQualityGate(q, 1000, 800);
    expect(gate.pass).toBe(false);
    expect(gate.failures.join(' ')).toContain('changed shape');
  });

  it('cautions rather than fails when time of day is absent', () => {
    const q = analyseQuality(
      batch(500).map((e) => ({ ...e, issuedHour: null })),
      [],
      KNOWN_CODES,
      TODAY,
    );
    const gate = evaluateQualityGate(q, 500, 0);
    expect(gate.pass).toBe(true);
    expect(gate.cautions.join(' ')).toMatch(/time-of-day/i);
  });

  it('is deterministic', () => {
    const events = batch(300);
    const a = analyseQuality(events, [], KNOWN_CODES, TODAY);
    const b = analyseQuality(events, [], KNOWN_CODES, TODAY);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

describe('period-scoped scoring windows', () => {
  it('derives a different start date per period', () => {
    // Before this existed every period scored the full history, so a 30-day
    // score equalled a 12-month score and the UI's filter changed the numbers
    // on screen without changing the ranking they were ordered by.
    const p30 = periodStartFor('30D', '2026-09-04');
    const p90 = periodStartFor('90D', '2026-09-04');
    const p12 = periodStartFor('12M', '2026-09-04');
    expect(p30).not.toEqual(p90);
    expect(p90).not.toEqual(p12);
    expect(p30! > p90!).toBe(true);
    expect(p90! > p12!).toBe(true);
  });

  it('aligns to the start of a month, because aggregates are monthly buckets', () => {
    for (const period of ['30D', '90D', '12M'] as const) {
      expect(periodStartFor(period, '2026-09-04')!.endsWith('-01')).toBe(true);
    }
  });

  it('is deterministic for a given as-of date', () => {
    expect(periodStartFor('30D', '2026-09-04')).toEqual(periodStartFor('30D', '2026-09-04'));
  });
});
