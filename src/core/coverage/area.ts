/**
 * The geographic area PCNWatch holds enforcement data for.
 *
 * Used to tell a visitor the truth when the map moves somewhere we know
 * nothing about. The distinction that matters: outside this area we are not
 * saying there is no enforcement, we are saying we have no data. Those read
 * very differently to someone deciding whether to park.
 */

export const COVERED_AUTHORITY_NAME = 'Camden';

/**
 * Bounding box for the covered area.
 *
 * A rectangle, not the borough's real outline, and deliberately so: it decides
 * only which sentence to show, never which data to return. Being generous at
 * the edges shows "we cover this" for a street just outside the boundary,
 * which is a smaller error than telling someone standing in Camden that we
 * hold nothing for them.
 */
export const COVERAGE_BOUNDS = {
  minLon: -0.24,
  minLat: 51.5,
  maxLon: -0.08,
  maxLat: 51.6,
} as const;

export function isWithinCoverage(longitude: number, latitude: number): boolean {
  return (
    longitude >= COVERAGE_BOUNDS.minLon &&
    longitude <= COVERAGE_BOUNDS.maxLon &&
    latitude >= COVERAGE_BOUNDS.minLat &&
    latitude <= COVERAGE_BOUNDS.maxLat
  );
}

/** What to tell someone whose search landed outside the covered area. */
export const OUTSIDE_COVERAGE_MESSAGE =
  `Location found. PCNWatch enforcement data currently covers ${COVERED_AUTHORITY_NAME} only, ` +
  'so no activity is shown here — that is a gap in our data, not a statement that no ' +
  'penalty charge notices are issued in this area.';
