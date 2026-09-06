import { NextResponse } from 'next/server';
import { z } from 'zod';
import { logError } from '@/lib/errors';
import { queryRows } from '@/server/db/reader';
import { rateLimit } from '@/server/rate-limit';
import { getPostcodeResolver, looksLikePostcode } from '@/server/geocoding/postcodes';
import { COVERED_AUTHORITY_NAME, isWithinCoverage } from '@/core/coverage/area';

/**
 * Where a search takes the map.
 *
 * Two kinds of answer, deliberately kept apart:
 *
 *   - A **street** resolves against PCNWatch's own `parking_locations`, so a
 *     result always corresponds to somewhere we hold enforcement data.
 *   - A **postcode** resolves through a geocoder and moves the map only. It
 *     asserts nothing about enforcement: a postcode is not a place we have
 *     PCN data *for*, it is a place to look. Conflating the two would invent a
 *     postcode-to-PCN relationship the data does not contain.
 *
 * The previous version dropped every result it found. It read `row.geom` as
 * though PostGIS geography arrived as GeoJSON with a `.coordinates` array; over
 * PostgREST it arrives as a WKB hex *string*, so `point?.coordinates` was
 * always undefined, every row was filtered out, and the endpoint returned an
 * empty list however good the match. A `as unknown as { coordinates?: ... }`
 * cast is what let that compile. Coordinates are now taken from the database as
 * numbers, by name.
 */

const querySchema = z.object({
  authority: z.string().regex(/^[a-z0-9-]{1,64}$/),
  q: z.string().trim().min(2).max(120),
});

export interface SearchResult {
  readonly kind: 'LOCATION' | 'POSTCODE';
  readonly slug: string | null;
  readonly displayName: string;
  readonly longitude: number;
  readonly latitude: number;
  /** True when the point sits inside the area we hold enforcement data for. */
  readonly withinCoverage: boolean;
}

export type SearchResponse =
  | { readonly ok: true; readonly results: SearchResult[]; readonly coveredArea: string }
  | { readonly ok: false; readonly reason: 'UNAVAILABLE' | 'RATE_LIMITED' | 'BAD_REQUEST' };

function fail(reason: 'UNAVAILABLE' | 'RATE_LIMITED' | 'BAD_REQUEST', status: number) {
  return NextResponse.json<SearchResponse>({ ok: false, reason }, { status });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return fail('BAD_REQUEST', 400);

  const limited = await rateLimit(request, { key: 'map-search', limit: 60, windowSeconds: 60 });
  if (!limited.allowed) return fail('RATE_LIMITED', 429);

  const { authority, q } = parsed.data;

  // A full postcode is unambiguous, so it never needs to be guessed at against
  // street names. Anything else is a street.
  if (looksLikePostcode(q)) {
    const resolution = await getPostcodeResolver().resolve(q);

    if (resolution.kind === 'PROVIDER_UNAVAILABLE') return fail('UNAVAILABLE', 503);
    if (resolution.kind === 'NOT_FOUND' || resolution.kind === 'NOT_A_POSTCODE') {
      return NextResponse.json<SearchResponse>({
        ok: true,
        results: [],
        coveredArea: COVERED_AUTHORITY_NAME,
      });
    }

    const { place } = resolution;
    return NextResponse.json<SearchResponse>({
      ok: true,
      coveredArea: COVERED_AUTHORITY_NAME,
      results: [
        {
          kind: 'POSTCODE',
          slug: null,
          displayName: place.postcode,
          longitude: place.longitude,
          latitude: place.latitude,
          withinCoverage: isWithinCoverage(place.longitude, place.latitude),
        },
      ],
    });
  }

  // Street search, ranked in the database rather than by pulling every location
  // into the browser: exact name first, then a prefix, then anywhere in the
  // name. `street_name_normalised` is already lower-cased and stripped, which
  // is what makes the comparison case-insensitive.
  const term = q.trim().toLowerCase().replace(/\s+/g, ' ');
  const result = await queryRows<{
    slug: string;
    display_name: string;
    longitude: number;
    latitude: number;
  }>(
    `select l.slug,
            l.display_name,
            st_x(l.geom::geometry) as longitude,
            st_y(l.geom::geometry) as latitude
       from parking_locations l
       join authorities a on a.id = l.authority_id
      where a.slug = $1
        and l.geom is not null
        and l.street_name_normalised like '%' || $2 || '%'
      order by case
                 when l.street_name_normalised = $2 then 0
                 when l.street_name_normalised like $2 || '%' then 1
                 else 2
               end,
               length(l.street_name_normalised),
               l.display_name
      limit 8`,
    [authority, term],
  );

  if (!result.ok) {
    logError('api.map.search', new Error(result.reason), { authority });
    return fail('UNAVAILABLE', 503);
  }

  return NextResponse.json<SearchResponse>({
    ok: true,
    coveredArea: COVERED_AUTHORITY_NAME,
    results: result.rows.map((row) => ({
      kind: 'LOCATION' as const,
      slug: row.slug,
      displayName: row.display_name,
      longitude: Number(row.longitude),
      latitude: Number(row.latitude),
      // A street we hold is by definition within coverage.
      withinCoverage: true,
    })),
  });
}
