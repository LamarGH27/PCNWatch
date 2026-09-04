/**
 * Street reference resolution.
 *
 * There is exactly one implementation today, and it resolves nothing.
 *
 * That is the correct state. Camden's dataset publishes no coordinates, and the
 * options for supplying them are not equal:
 *
 *   - A commercial geocoding API would return a point per street, but the point
 *     is not reproducible (it changes as the provider's index changes), the
 *     licence usually forbids storing the result, and we could not tell a user
 *     which authority stands behind the position. Rejected.
 *   - Postcode centroids would be precise-looking and wrong: a postcode unit
 *     spans several streets and a street spans many postcodes. Rejected.
 *   - Placing notices at a road centre "for display" with no provenance is
 *     fabrication. Rejected outright.
 *   - **OS Open USRN** (Ordnance Survey / GeoPlace, Open Government Licence) is
 *     the national street gazetteer: every street in Great Britain with a stable
 *     Unique Street Reference Number and a geometry, published quarterly as a
 *     free download. A match is reproducible by anyone with the same release,
 *     the identifier can be quoted, and the licence permits storage and display
 *     with attribution. This is the recommendation — see docs/geography.md.
 *
 * Until that reference is loaded, `resolve` returns `NO_STREET_REFERENCE_CONFIGURED`
 * and the map shows nothing for those records, which is the truth.
 */

import {
  type GeometryResult,
  type SourceLocation,
  type StreetReferenceDescriptor,
  type StreetReferenceResolver,
  noGeometry,
} from './types';

/**
 * The active resolver. Swapping in a real one is a one-line change here plus the
 * loader for the reference data; nothing upstream of this file needs to change.
 */
export class UnavailableStreetReference implements StreetReferenceResolver {
  readonly descriptor: StreetReferenceDescriptor | null = null;
  readonly available = false;

  resolve(_location: SourceLocation): GeometryResult {
    return noGeometry('NO_STREET_REFERENCE_CONFIGURED');
  }
}

let active: StreetReferenceResolver = new UnavailableStreetReference();

export function getStreetReference(): StreetReferenceResolver {
  return active;
}

/** Test seam and the single point a real reference would be installed at. */
export function setStreetReference(resolver: StreetReferenceResolver): void {
  active = resolver;
}

export function resetStreetReference(): void {
  active = new UnavailableStreetReference();
}

/**
 * Plain-English description of the geography a set of records actually carries.
 * Used wherever a position is shown, so precision is never overstated.
 */
export function describeGeometryAvailability(args: {
  readonly total: number;
  readonly withGeometry: number;
  readonly sourcePublishesCoordinates: boolean;
  readonly referenceName: string | null;
}): string {
  if (args.total === 0) return 'No records to position.';

  if (!args.sourcePublishesCoordinates && args.withGeometry === 0) {
    return args.referenceName === null
      ? 'The authority publishes a street name for each notice but no coordinates, and no street-reference dataset is loaded, so none of these notices can be placed on a map.'
      : `The authority publishes no coordinates. Positions would come from ${args.referenceName}, which did not match these streets.`;
  }

  if (args.withGeometry === 0) {
    return 'The authority publishes coordinates, but none of these records carried a usable one.';
  }

  const share = Math.round((args.withGeometry / args.total) * 100);
  const basis = args.sourcePublishesCoordinates
    ? 'positions published by the authority'
    : `positions matched against ${args.referenceName ?? 'a street reference'}`;
  return `${share}% of these notices can be placed on a map, using ${basis}.`;
}
