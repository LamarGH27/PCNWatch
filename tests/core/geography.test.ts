import { afterEach, describe, expect, it } from 'vitest';
import {
  assertGeometryProvenance,
  hasGeometry,
  noGeometry,
  sourcePublishedGeometry,
  streetReferenceGeometry,
  type SourceLocation,
  type StreetReferenceDescriptor,
  type StreetReferenceResolver,
  type GeometryResult,
} from '@/core/geography/types';
import {
  UnavailableStreetReference,
  describeGeometryAvailability,
  getStreetReference,
  resetStreetReference,
  setStreetReference,
} from '@/core/geography/street-reference';
import { normaliseCamdenRow } from '@/data-sources/camden/adapter';
import liveRows from '../fixtures/camden/live-schema-rows.json';

afterEach(() => resetStreetReference());

const OS_USRN: StreetReferenceDescriptor = {
  id: 'os-open-usrn',
  name: 'OS Open USRN',
  publisher: 'Ordnance Survey',
  licence: 'Open Government Licence v3.0',
  url: 'https://www.ordnancesurvey.co.uk/products/os-open-usrn',
  version: '2026-07',
};

describe('geometry provenance is mandatory', () => {
  it('rejects a coordinate that cannot say where it came from', () => {
    expect(() =>
      assertGeometryProvenance({
        origin: 'STREET_REFERENCE',
        method: 'STREET_NAME_EXACT',
        referenceSource: null,
        referenceVersion: '2026-07',
        referenceRecordId: '123',
        confidence: 0.8,
        lookedUpAt: '2026-09-04T00:00:00.000Z',
      }),
    ).toThrow(/name its reference source/);
  });

  it('rejects a derived coordinate with no reference version', () => {
    // Without a version the match cannot be reproduced or invalidated when the
    // reference changes, so the position is not defensible.
    expect(() =>
      assertGeometryProvenance({
        origin: 'STREET_REFERENCE',
        method: 'USRN',
        referenceSource: 'os-open-usrn',
        referenceVersion: null,
        referenceRecordId: '123',
        confidence: 0.8,
        lookedUpAt: '2026-09-04T00:00:00.000Z',
      }),
    ).toThrow(/version/);
  });

  it('rejects a derived coordinate with no lookup timestamp', () => {
    expect(() =>
      assertGeometryProvenance({
        origin: 'STREET_REFERENCE',
        method: 'USRN',
        referenceSource: 'os-open-usrn',
        referenceVersion: '2026-07',
        referenceRecordId: '123',
        confidence: 0.8,
        lookedUpAt: null,
      }),
    ).toThrow(/when the lookup happened/);
  });

  it('records a source-published point as POINT precision with full confidence', () => {
    const g = sourcePublishedGeometry(-0.1338, 51.5305, 'longitude/latitude');
    expect(g.precision).toBe('POINT');
    expect(g.provenance.origin).toBe('SOURCE_PUBLISHED');
    expect(g.provenance.referenceSource).toBe('longitude/latitude');
  });

  it('never lets a street match claim point precision', () => {
    const g = streetReferenceGeometry({
      longitude: -0.1338,
      latitude: 51.5305,
      reference: OS_USRN,
      method: 'USRN',
      referenceRecordId: '20901234',
      confidence: 0.9,
      lookedUpAt: '2026-09-04T00:00:00.000Z',
    });
    // The type forbids POINT here; this asserts the runtime default agrees.
    expect(g.precision).toBe('STREET');
    expect(g.provenance.referenceVersion).toBe('2026-07');
    expect(g.provenance.referenceRecordId).toBe('20901234');
  });
});

describe('street reference', () => {
  it('resolves nothing by default and says why', () => {
    const resolver = getStreetReference();
    expect(resolver.available).toBe(false);
    const result = resolver.resolve(location('Eversholt Street'));
    expect(hasGeometry(result)).toBe(false);
    expect(result).toMatchObject({ reason: 'NO_STREET_REFERENCE_CONFIGURED' });
  });

  it('is the only place a real reference would be installed', () => {
    setStreetReference(stubResolver());
    expect(getStreetReference().available).toBe(true);
    resetStreetReference();
    expect(getStreetReference()).toBeInstanceOf(UnavailableStreetReference);
  });
});

describe('adapter geography', () => {
  const rows = liveRows as Record<string, unknown>[];

  it('fabricates no coordinates for a source that publishes none', () => {
    for (const row of rows) {
      const result = normaliseCamdenRow(row, 0);
      if (!result.ok) continue;
      expect(result.event.longitude).toBeNull();
      expect(result.event.latitude).toBeNull();
    }
  });

  it('stamps every record with why it has no position', () => {
    const result = normaliseCamdenRow(rows[0]!, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.sourceMetadata['_geometry']).toMatchObject({
      origin: 'NONE',
      precision: 'NONE',
      reason: 'SOURCE_PUBLISHES_NO_COORDINATES',
    });
  });

  it("preserves the publisher's own precision claim rather than asserting our own", () => {
    const result = normaliseCamdenRow(rows[0]!, 0);
    if (!result.ok) throw new Error('expected acceptance');
    expect(result.event.sourceMetadata['_publisherSpatialAccuracy']).toBe('Street');
  });

  it('uses a configured street reference and records its version and timestamp', () => {
    setStreetReference(stubResolver());
    const result = normaliseCamdenRow(rows[0]!, 0);
    if (!result.ok) throw new Error('expected acceptance');
    expect(result.event.longitude).toBeCloseTo(-0.1338, 4);
    expect(result.event.sourceMetadata['_geometry']).toMatchObject({
      origin: 'STREET_REFERENCE',
      precision: 'STREET',
      referenceSource: 'os-open-usrn',
      referenceVersion: '2026-07',
      lookedUpAt: '2026-09-04T00:00:00.000Z',
    });
  });

  it('reports the street reference declining a street, not the source', () => {
    setStreetReference(stubResolver(new Set()));
    const result = normaliseCamdenRow(rows[0]!, 0);
    if (!result.ok) throw new Error('expected acceptance');
    expect(result.event.sourceMetadata['_geometry']).toMatchObject({
      reason: 'STREET_NOT_IN_REFERENCE',
    });
  });
});

describe('describing what geography is actually held', () => {
  it('says a source publishes none rather than implying a failure', () => {
    const text = describeGeometryAvailability({
      total: 500,
      withGeometry: 0,
      sourcePublishesCoordinates: false,
      referenceName: null,
    });
    expect(text).toMatch(/publishes a street name .* but no coordinates/);
    expect(text).not.toMatch(/error|fail/i);
  });

  it('distinguishes a source whose coordinates we could not read', () => {
    const text = describeGeometryAvailability({
      total: 500,
      withGeometry: 0,
      sourcePublishesCoordinates: true,
      referenceName: null,
    });
    expect(text).toMatch(/publishes coordinates, but none of these records/);
  });
});

function location(street: string): SourceLocation {
  return {
    streetName: street,
    streetNameNormalised: street.toLowerCase(),
    locality: null,
    postcodeDistrict: null,
    publisherSpatialAccuracy: 'Street',
  };
}

/** A reference that knows the fixture streets, for testing the wiring only. */
function stubResolver(known?: ReadonlySet<string>): StreetReferenceResolver {
  return {
    descriptor: OS_USRN,
    available: true,
    resolve(loc: SourceLocation): GeometryResult {
      const matches = known === undefined || known.has(loc.streetNameNormalised);
      if (!matches) return noGeometry('STREET_NOT_IN_REFERENCE');
      return streetReferenceGeometry({
        longitude: -0.1338,
        latitude: 51.5305,
        reference: OS_USRN,
        method: 'USRN',
        referenceRecordId: '20901234',
        confidence: 0.85,
        lookedUpAt: '2026-09-04T00:00:00.000Z',
      });
    },
  };
}
