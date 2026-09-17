import { COVERAGE_SCOPE } from './coverage';
import { type BoundingBox, withinBounds } from '@/core/geography/types';

/**
 * The geographic areas PCNWatch holds enforcement data for.
 *
 * Used to tell a visitor the truth when the map moves somewhere we know
 * nothing about. The distinction that matters: outside these areas we are not
 * saying there is no enforcement, we are saying we have no data. Those read
 * very differently to someone deciding whether to park.
 *
 * This was a single borough's name and a single rectangle. It is now keyed by
 * authority because the alternative — a second constant, a second rectangle and
 * an `if` at every call site — is how the first borough's assumptions get
 * copied into the second one's code and then quietly diverge.
 *
 * Two rules keep it honest:
 *
 *   * **Registered is not the same as covered.** An area may be described here
 *     long before its data exists. What a visitor is told comes from
 *     `COVERAGE_SCOPE.liveAuthoritySlugs`, so adding geography for a borough we
 *     have not launched changes nothing anyone can see.
 *   * **Covered requires geography.** A live authority with no registered area
 *     is a configuration error, not a borough with an unknown shape — the map
 *     would show its data while the search told people it was out of coverage.
 *     `liveAuthoritiesWithoutArea` names them and a test refuses to let one
 *     exist.
 */

export interface AuthorityArea {
  readonly slug: string;
  /** Short display name, as it appears mid-sentence: "Camden", not the full legal name. */
  readonly name: string;
  /**
   * Bounding box for the area.
   *
   * A rectangle, not the borough's real outline, and deliberately so: it decides
   * only which sentence to show, never which data to return. Being generous at
   * the edges shows "we cover this" for a street just outside the boundary,
   * which is a smaller error than telling someone standing in the borough that
   * we hold nothing for them.
   *
   * The ingestion quality gate reads the same rectangle through the source
   * descriptor, so "where we say we have data" and "where we expect the
   * source's coordinates to land" cannot drift apart.
   */
  readonly bounds: BoundingBox;
}

/**
 * Every area PCNWatch can describe, live or not.
 *
 * An entry is added when the borough's extent is known. It becomes visible only
 * when the slug also appears in `COVERAGE_SCOPE.liveAuthoritySlugs`.
 */
const AUTHORITY_AREAS: readonly AuthorityArea[] = [
  {
    slug: 'camden',
    name: 'Camden',
    bounds: { minLon: -0.24, minLat: 51.5, maxLon: -0.08, maxLat: 51.6 },
  },
];

/** Looks up a registered area by slug, whether or not it is live. */
export function authorityArea(slug: string): AuthorityArea | null {
  return AUTHORITY_AREAS.find((area) => area.slug === slug) ?? null;
}

/** Every registered area, live or not. For configuration checks, not for display. */
export function registeredAreas(): readonly AuthorityArea[] {
  return AUTHORITY_AREAS;
}

/**
 * The areas a visitor is currently told we cover.
 *
 * Live *and* registered. A live slug with no geography is excluded rather than
 * guessed at, which keeps the coverage sentence and the bounds test agreeing
 * with each other.
 */
export function coveredAreas(): readonly AuthorityArea[] {
  return COVERAGE_SCOPE.liveAuthoritySlugs
    .map((slug) => authorityArea(slug))
    .filter((area): area is AuthorityArea => area !== null);
}

/**
 * Live authorities with no registered geography.
 *
 * Should always be empty. Exported so a test can say so rather than leaving the
 * inconsistency to be discovered from a user's search result.
 */
export function liveAuthoritiesWithoutArea(): readonly string[] {
  return COVERAGE_SCOPE.liveAuthoritySlugs.filter((slug) => authorityArea(slug) === null);
}

/**
 * Which covered area a point falls in, or null. Never consults a non-live area.
 *
 * First match wins, in registration order. The rectangles are deliberately
 * larger than the boroughs they describe, so once there is a second one they
 * will overlap — Camden's already reaches into Barnet. That is fine while the
 * answer is only used to choose a sentence, and it is a decision to make
 * explicitly before it is used for anything else.
 */
export function coveredAreaAt(longitude: number, latitude: number): AuthorityArea | null {
  return coveredAreas().find((area) => withinBounds(area.bounds, longitude, latitude)) ?? null;
}

export function isWithinCoverage(longitude: number, latitude: number): boolean {
  return coveredAreaAt(longitude, latitude) !== null;
}

/** The covered areas as a phrase: "Camden", "Camden and Barnet", "A, B and C". */
export function coveredAreaLabel(areas: readonly AuthorityArea[] = coveredAreas()): string {
  const names = areas.map((area) => area.name);
  if (names.length === 0) return 'no areas';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What PCNWatch currently covers, as a name to drop into a sentence.
 *
 * A constant because every consumer treats it as one and because the live list
 * is fixed at build time. Its value while Camden is the only live borough is
 * exactly the string this used to be hard-coded to.
 */
export const COVERED_AUTHORITY_NAME = coveredAreaLabel();

/** What to tell someone whose search landed outside the covered area. */
export const OUTSIDE_COVERAGE_MESSAGE =
  `Location found. PCNWatch enforcement data currently covers ${COVERED_AUTHORITY_NAME} only, ` +
  'so no activity is shown here — that is a gap in our data, not a statement that no ' +
  'penalty charge notices are issued in this area.';
