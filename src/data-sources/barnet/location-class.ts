/**
 * What kind of place a Barnet enforcement location is.
 *
 * Geography has to start here rather than at a gazetteer lookup, because the
 * 1,779 locations in the approved 24-month window are not all the same kind of
 * thing and only one kind can be resolved by matching a street name:
 *
 *   * an ordinary street has a name a gazetteer also holds;
 *   * a junction names two streets and sits where they cross, which is not
 *     "a street" and cannot be matched as one;
 *   * a car park is off-street and absent from a road gazetteer entirely;
 *   * a described segment ("20m north of…", "between A and B") is part of a
 *     street, and resolving it to the whole street would place a specific
 *     camera at a road's midpoint.
 *
 * Forcing all four through one resolver is how a plausible-looking coordinate
 * gets attached to something it does not describe. So they are separated first,
 * and only `ORDINARY_STREET` is eligible for name matching. Everything else is
 * refused by class, before any matching is attempted.
 *
 * The patterns below were derived from the real values, not guessed: every rule
 * is checked against the published files in the location-class tests.
 */

export type BarnetLocationClass =
  | 'ORDINARY_STREET'
  | 'JUNCTION'
  | 'CAR_PARK'
  | 'DESCRIPTIVE_SEGMENT'
  | 'CAMERA_SITE'
  | 'UNCLASSIFIED';

export interface LocationClassification {
  readonly class: BarnetLocationClass;
  /** Whether a street-name match may even be attempted for this location. */
  readonly eligibleForNameMatch: boolean;
  /** Why, in words an operator can act on. */
  readonly reason: string;
}

/** Off-street parking. Absent from a road gazetteer; needs its own source. */
const CAR_PARK = /\bcar\s*park\b/i;

/**
 * Two streets and the point where they meet.
 *
 * Barnet writes this four ways across its camera feeds: "junction with X",
 * "Junction X", "J/W X", "A into B", and "between A & B". All of them name more
 * than one street, so none of them is a street.
 */
const JUNCTION = /\bjunct\w*\b|\bj\/w\b|\bjct\b|\binto\b/i;

/**
 * A described part of a road rather than the road.
 *
 * "20M NORTH OF J/W HYDE ESTATE ROAD", "o/side a school", "S/SIDE OF",
 * "Eastbound", "BUS STATION ENTRANCE", "From Ellesmere Avenue". Matching these
 * to the whole street would put a camera at the road's representative point,
 * which is somewhere the description explicitly excludes.
 */
const DESCRIPTIVE =
  /\b\d+\s*m\b|\bmetres?\b|\bo\/s\b|\bo\/side\b|\boutside\b|\bopp\b|\b[nsew]\/side\b|\b(?:north|south|east|west)\s+of\b|\bbetween\b|\bentrance\b|\bexit\b|\b(?:north|south|east|west)bound\b|\bfrom\b|\bat\b|\bto\b/i;

/** A slash between two names is Barnet's shorthand for a junction. */
const SLASHED_PAIR = /[A-Za-z]\s*\/\s*[A-Za-z]/;

/**
 * Feeds whose locations are camera sites rather than streets.
 *
 * This is the rule that matters most, and it is structural rather than textual.
 * A bus lane or moving traffic notice is issued by a camera at one point:
 * a box junction, an entrance, one direction of one carriageway. Even where
 * Barnet writes such a site as a bare street name — "NETHERLANDS RD (EN5)" —
 * the notice did not happen along that street, it happened at a camera on it,
 * and the file does not say where.
 *
 * Reading the text alone missed this: 41 moving traffic sites carrying 33,391
 * notices parse as ordinary street names, and nearly all turn out to be
 * "Eastbound", "BUS STATION ENTRANCE" or "From Ellesmere Avenue". Rather than
 * chase that with ever more patterns, eligibility is decided by the feed: a
 * camera feed is never matched to a street, whatever its text looks like.
 *
 * Parking is genuinely different. A parking contravention happened somewhere
 * along the named street, so a street-representative geometry describes it
 * fairly — which is exactly what a camera point would not do.
 */
const CAMERA_FEEDS: readonly string[] = ['BUS_LANE', 'MOVING_TRAFFIC'];

export function isCameraFeed(enforcementType: string): boolean {
  return CAMERA_FEEDS.includes(enforcementType);
}

export function classifyBarnetLocation(
  raw: string,
  enforcementType?: string,
): LocationClassification {
  const value = (raw ?? '').trim();

  if (value === '') {
    return {
      class: 'UNCLASSIFIED',
      eligibleForNameMatch: false,
      reason: 'The row carried no location text, so there is nothing to classify or match.',
    };
  }

  /*
   * Order matters, and it is ordered by how wrong the alternative would be.
   *
   * A car park named after a street ("Lodge Lane Car Park") would otherwise
   * match Lodge Lane and place every off-street notice on the road outside.
   * That is a worse error than refusing it, so it is tested first.
   */
  if (CAR_PARK.test(value)) {
    return {
      class: 'CAR_PARK',
      eligibleForNameMatch: false,
      reason: 'Off-street car park. A road gazetteer does not contain it, and the street it is named after is not where it is.',
    };
  }

  if (DESCRIPTIVE.test(value)) {
    return {
      class: 'DESCRIPTIVE_SEGMENT',
      eligibleForNameMatch: false,
      reason: 'Describes a point along a road rather than the road. Matching the road would place it somewhere the description excludes.',
    };
  }

  if (JUNCTION.test(value) || SLASHED_PAIR.test(value)) {
    return {
      class: 'JUNCTION',
      eligibleForNameMatch: false,
      reason: 'Names more than one street. A junction is not a street and cannot be matched as one.',
    };
  }

  if (enforcementType !== undefined && isCameraFeed(enforcementType)) {
    return {
      class: 'CAMERA_SITE',
      eligibleForNameMatch: false,
      reason:
        'A camera site on a named street. The notice was issued at one point on that street and the source does not say where, so the street is not a fair position for it.',
    };
  }

  return {
    class: 'ORDINARY_STREET',
    eligibleForNameMatch: true,
    reason: 'A single named street, eligible for a gazetteer name match.',
  };
}
