import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  looksLikePostcode,
  normalisePostcode,
  resetPostcodeResolver,
  setPostcodeResolver,
  type PostcodeResolution,
} from '@/server/geocoding/postcodes';
import {
  COVERED_AUTHORITY_NAME,
  OUTSIDE_COVERAGE_MESSAGE,
  isWithinCoverage,
} from '@/core/coverage/area';

/**
 * Map search, from what a user types to where the map goes.
 *
 * The bug these exist for: the endpoint read PostGIS geography as though it
 * arrived as GeoJSON with a `.coordinates` array. Over PostgREST it arrives as
 * a WKB hex *string*, so every result was discarded and the endpoint returned
 * an empty list however good the match — and the client then did nothing at
 * all with an empty list, so pressing Go looked like a dead button.
 */

afterEach(() => {
  resetPostcodeResolver();
  vi.restoreAllMocks();
});

describe('postcode recognition', () => {
  it('accepts real postcodes whatever the spacing and case', () => {
    for (const input of ['NW1 1AA', 'nw11aa', '  Nw1   1aa ', 'EC1N 8UN', 'w1a0ax']) {
      expect(looksLikePostcode(input), `${input} should be recognised`).toBe(true);
    }
  });

  it('normalises to the canonical outward-inward form', () => {
    expect(normalisePostcode('nw11aa')).toBe('NW1 1AA');
    expect(normalisePostcode('  Nw1   1aa ')).toBe('NW1 1AA');
    expect(normalisePostcode('EC1N8UN')).toBe('EC1N 8UN');
  });

  it('rejects malformed input rather than guessing at it', () => {
    for (const input of ['NW1', 'NW1 1A', 'ZZZZ 999', 'Woburn Place', '12345', 'NW1 1AAA']) {
      expect(normalisePostcode(input), `${input} should not parse`).toBeNull();
    }
  });

  it('does not treat a street name as a postcode', () => {
    for (const street of ['Woburn Place', 'Theobalds Road', 'Camden High Street']) {
      expect(looksLikePostcode(street)).toBe(false);
    }
  });
});

describe('postcode resolution', () => {
  /** Drives the real resolver against a stubbed HTTP layer, not a stubbed resolver. */
  function stubFetch(status: number, body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
  }

  it('resolves a Camden postcode to coordinates inside coverage', async () => {
    stubFetch(200, {
      result: {
        postcode: 'NW1 1AA',
        longitude: -0.1355,
        latitude: 51.5305,
        admin_district: 'Camden',
      },
    });
    const { PostcodesIoResolver } = await import('@/server/geocoding/postcodes');
    const resolution = await new PostcodesIoResolver().resolve('nw11aa');

    expect(resolution.kind).toBe('RESOLVED');
    if (resolution.kind !== 'RESOLVED') return;
    expect(resolution.place.postcode).toBe('NW1 1AA');
    expect(isWithinCoverage(resolution.place.longitude, resolution.place.latitude)).toBe(true);
  });

  it('resolves a postcode outside Camden, and marks it outside coverage', async () => {
    // Manchester. The map may still go there; what must not happen is any
    // claim that no PCNs are issued.
    stubFetch(200, {
      result: { postcode: 'M1 1AE', longitude: -2.2374, latitude: 53.4808, admin_district: 'Manchester' },
    });
    const { PostcodesIoResolver } = await import('@/server/geocoding/postcodes');
    const resolution = await new PostcodesIoResolver().resolve('M1 1AE');

    expect(resolution.kind).toBe('RESOLVED');
    if (resolution.kind !== 'RESOLVED') return;
    expect(isWithinCoverage(resolution.place.longitude, resolution.place.latitude)).toBe(false);
  });

  it('reports a postcode that does not exist as not found, not as a failure', async () => {
    stubFetch(404, { error: 'Postcode not found' });
    const { PostcodesIoResolver } = await import('@/server/geocoding/postcodes');
    expect((await new PostcodesIoResolver().resolve('ZZ1 1ZZ')).kind).toBe('NOT_FOUND');
  });

  it('reports a provider outage as unavailable, which is a different answer', async () => {
    stubFetch(500, {});
    const { PostcodesIoResolver } = await import('@/server/geocoding/postcodes');
    expect((await new PostcodesIoResolver().resolve('NW1 1AA')).kind).toBe('PROVIDER_UNAVAILABLE');
  });

  it('survives the provider throwing, rather than failing the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const { PostcodesIoResolver } = await import('@/server/geocoding/postcodes');
    expect((await new PostcodesIoResolver().resolve('NW1 1AA')).kind).toBe('PROVIDER_UNAVAILABLE');
  });

  it('treats a valid postcode with no coordinates as not found', async () => {
    // Real case: some PO box and new-build codes carry no position.
    stubFetch(200, { result: { postcode: 'NW1 1AA', longitude: null, latitude: null } });
    const { PostcodesIoResolver } = await import('@/server/geocoding/postcodes');
    expect((await new PostcodesIoResolver().resolve('NW1 1AA')).kind).toBe('NOT_FOUND');
  });

  it('is replaceable without touching anything above it', async () => {
    const stub: PostcodeResolution = {
      kind: 'RESOLVED',
      place: { postcode: 'NW1 1AA', longitude: -0.13, latitude: 51.53, district: 'Camden' },
    };
    setPostcodeResolver({ resolve: async () => stub });
    const { getPostcodeResolver } = await import('@/server/geocoding/postcodes');
    expect((await getPostcodeResolver().resolve('anything')).kind).toBe('RESOLVED');
  });
});

describe('coverage honesty', () => {
  it('never claims there are no PCNs outside the covered area', () => {
    const message = OUTSIDE_COVERAGE_MESSAGE.toLowerCase();
    expect(message).toContain(COVERED_AUTHORITY_NAME.toLowerCase());
    // It must say the data is missing, not that enforcement is absent.
    expect(message).toContain('gap in our data');
    expect(message).not.toMatch(/no penalty charge notices are issued(?! in this area)/);
    for (const forbidden of ['no pcns here', 'no enforcement here', 'nothing is enforced']) {
      expect(message).not.toContain(forbidden);
    }
  });

  it('places Camden inside coverage and elsewhere outside it', () => {
    expect(isWithinCoverage(-0.1355, 51.5305)).toBe(true); // Camden
    expect(isWithinCoverage(-2.2374, 53.4808)).toBe(false); // Manchester
    expect(isWithinCoverage(-0.0198, 51.5033)).toBe(false); // Canary Wharf
  });
});
