import { normaliseStreetName } from '../shared/normalise';

/**
 * The key two publishers' spellings of one street must agree on.
 *
 * `normaliseStreetName` settles case and spacing but keeps apostrophes, which
 * is right for a location slug and wrong for a cross-source join: Barnet writes
 * REGENTS PARK ROAD and Ordnance Survey writes Regent's Park Road. They are the
 * same street, and 83 Barnet locations carrying 6,976 notices failed to match
 * for no other reason.
 *
 * This is a second key layered on top, not a change to the shared normaliser —
 * that one produces Camden's location slugs, and altering it would silently
 * repartition a borough that is already live.
 *
 * Still deterministic and still exact: punctuation is removed from both sides
 * and the result must be equal. Nothing here measures similarity.
 */
export function joinKey(name: string): string {
  return normaliseStreetName(name).replace(/['’]/g, '');
}
import { classifyBarnetLocation } from './location-class';
import { districtForBarnetLocality } from './locality-districts';

/**
 * Matching a Barnet enforcement street to an official gazetteer entry.
 *
 * The gazetteer is not bundled: OS Open Names is an Ordnance Survey download
 * and nothing here fetches it. What lives here is the decision — given
 * candidate entries, which match may be accepted — so that the rule is written,
 * reviewed and tested before any data arrives to be matched by it.
 *
 * The principle, and every clause of it is load-bearing:
 *
 *     normalised Barnet street
 *   + an official road name that equals it
 *   + inside Barnet
 *   + exactly one surviving candidate
 *   = accepted
 *
 * Anything else is refused, with a reason. There is deliberately no fuzzy
 * comparison, no nearest-match, no "first result wins" and no similarity
 * threshold: a street placed on the wrong road is indistinguishable, to a
 * reader, from one placed on the right road, and the map offers no way to tell
 * them apart. Refusing is visible; being wrong is not.
 */

export type StreetMatchRefusal =
  | 'NOT_ELIGIBLE_CLASS'
  | 'NO_CANDIDATE'
  | 'AMBIGUOUS_NAME'
  | 'OUTSIDE_AUTHORITY'
  | 'POSTCODE_CONFLICT';

/** One official gazetteer entry, reduced to what a match decision needs. */
export interface GazetteerEntry {
  /** Stable identifier from the source, quoted in provenance. */
  readonly id: string;
  /** The official name, as published. */
  readonly name: string;
  /**
   * The gazetteer's own classification.
   *
   * `NAMED_ROAD` is one record for a whole road. `ROAD_SECTION` is a piece of
   * one, and OS publishes no persistent identifier for sections — so a section
   * match cannot be quoted as reproducible in the way a named road can.
   */
  readonly kind: 'NAMED_ROAD' | 'ROAD_SECTION' | 'OTHER';
  /** Administrative district, e.g. "Barnet". */
  readonly district: string | null;
  /** Postcode district, e.g. "N3". Absent on many entries. */
  readonly postcodeDistrict: string | null;
  /** Populated place, e.g. "Finchley". Absent on many entries. */
  readonly populatedPlace: string | null;
  readonly longitude: number;
  readonly latitude: number;
}

export type StreetMatch =
  | {
      readonly ok: true;
      readonly entry: GazetteerEntry;
      /** How precisely the accepted geometry describes the notice. */
      readonly precision: 'STREET_REPRESENTATIVE_POINT';
      readonly reason: string;
    }
  | { readonly ok: false; readonly refusal: StreetMatchRefusal; readonly reason: string };

export interface MatchOptions {
  /** The authority the enforcement belongs to, as the gazetteer spells it. */
  readonly district: string;
  /** Barnet's own postcode district for this street, when it published one. */
  readonly postcodeDistrict?: string | null;
  /**
   * Barnet's own locality for this street, when it published one.
   *
   * "HIGH ROAD, North Finchley" and "STATION ROAD, Edgware" are how Barnet
   * distinguishes streets that share a name, and Ordnance Survey records the
   * same thing as a populated place. Discarding it left the two busiest
   * ambiguities in Barnet unresolvable when the publisher had already said
   * which one it meant.
   */
  readonly locality?: string | null;
  /** The feed the location came from; camera feeds are never matched. */
  readonly enforcementType?: string;
}

const refuse = (refusal: StreetMatchRefusal, reason: string): StreetMatch => ({
  ok: false,
  refusal,
  reason,
});

/**
 * Decides whether a Barnet street may take a gazetteer entry's position.
 *
 * `candidates` is every entry whose normalised name equals the street's. The
 * caller does the lookup; this does the judging, which is the part that has to
 * be right.
 */
export function matchStreet(
  barnetLocation: string,
  candidates: readonly GazetteerEntry[],
  options: MatchOptions,
): StreetMatch {
  const classification = classifyBarnetLocation(barnetLocation, options.enforcementType);
  if (!classification.eligibleForNameMatch) {
    return refuse('NOT_ELIGIBLE_CLASS', classification.reason);
  }

  const wanted = joinKey(barnetLocation);

  // Name equality on the normalised form, never similarity.
  const named = candidates.filter((c) => joinKey(c.name) === wanted);
  if (named.length === 0) {
    return refuse('NO_CANDIDATE', 'No official road of that name was found.');
  }

  /*
   * Inside Barnet, or not at all.
   *
   * "Station Road" and "High Road" exist in most London boroughs. Without this
   * the nearest thing to a match would routinely be a road with the right name
   * in the wrong borough, which is the single most likely way this produces a
   * confidently wrong point.
   */
  const inDistrict = named.filter((c) => c.district === options.district);
  if (inDistrict.length === 0) {
    return refuse(
      'OUTSIDE_AUTHORITY',
      `A road of that name exists, but none of them is in ${options.district}.`,
    );
  }

  /*
   * Barnet's own postcode district, where it gave one, is a second constraint
   * rather than a tie-break of last resort — it is evidence the publisher
   * supplied about this street, and ignoring it to force a match would be
   * discarding the best disambiguator available.
   */
  let surviving = inDistrict;

  /*
   * Locality first, because it is the coarser and more reliable of the two:
   * Barnet's own "North Finchley" against Ordnance Survey's populated place.
   * Applied only when it narrows the field, never when it would empty it — a
   * publisher naming a locality OS spells differently is a reason to fall back
   * to the postcode, not a reason to refuse.
   */
  if (options.locality) {
    const wantedPlace = joinKey(options.locality);
    const byPlace = surviving.filter(
      (c) => c.populatedPlace !== null && joinKey(c.populatedPlace) === wantedPlace,
    );
    if (byPlace.length > 0) surviving = byPlace;
  }

  /*
   * Where Barnet named a locality but no postcode, the reviewed table supplies
   * the district that locality names.
   *
   * This is why the place-name comparison above is not enough: Ordnance Survey
   * calls both North Finchley and East Finchley "Finchley", so its own place
   * name cannot separate the two High Roads it holds. The postal district can.
   *
   * Barnet's own postcode always wins — the table is consulted only when the
   * publisher gave none, and it narrows candidates rather than supplying any
   * position.
   */
  const effectivePostcode =
    options.postcodeDistrict ?? districtForBarnetLocality(options.locality);

  if (effectivePostcode) {
    const byPostcode = surviving.filter(
      (c) => c.postcodeDistrict?.toUpperCase() === effectivePostcode.toUpperCase(),
    );
    if (byPostcode.length === 0 && surviving.every((c) => c.postcodeDistrict !== null)) {
      return refuse(
        'POSTCODE_CONFLICT',
        `Barnet records this street in ${effectivePostcode}, and every official road of that name in ${options.district} is somewhere else.`,
      );
    }
    if (byPostcode.length > 0) surviving = byPostcode;
  }

  /*
   * A whole road beats its sections.
   *
   * One road commonly appears as several `ROAD_SECTION` records. They are the
   * same street, so several of them is not an ambiguity to refuse — but a
   * section carries no persistent identifier, so the road-level record is
   * preferred where one exists and the match stays quotable.
   */
  const roads = surviving.filter((c) => c.kind === 'NAMED_ROAD');
  const chosen = roads.length > 0 ? roads : surviving;

  if (chosen.length > 1) {
    return refuse(
      'AMBIGUOUS_NAME',
      `${chosen.length} distinct official roads of that name are in ${options.district}, and nothing in the source says which one this is.`,
    );
  }

  const entry = chosen[0] as GazetteerEntry;
  if (entry.kind === 'OTHER') {
    return refuse('NO_CANDIDATE', 'The only entry of that name is not a road.');
  }

  return {
    ok: true,
    entry,
    /*
     * What the accepted position actually is, carried so the interface cannot
     * describe it as anything better. A gazetteer point is a label position for
     * a whole road, not where the notice was issued — and the road may be a
     * mile long.
     */
    precision: 'STREET_REPRESENTATIVE_POINT',
    reason:
      entry.kind === 'NAMED_ROAD'
        ? 'Exactly one official road of this name in the authority.'
        : 'Exactly one official road section of this name in the authority.',
  };
}
