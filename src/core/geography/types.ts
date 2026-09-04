/**
 * Geography: source location information versus derived geometry.
 *
 * Camden's published PCN dataset (`4k7m-4gkk`) carries **no coordinates at all**.
 * It carries a street name and a `spatial_accuracy` value of "Street". That is a
 * fact about the source, and the product must not paper over it.
 *
 * Two things are therefore kept apart, permanently and in the type system:
 *
 *   **A. `SourceLocation`** — what the authority actually published about where
 *      the notice was issued: a street name, perhaps a zone, perhaps a postcode,
 *      and the publisher's own claim about how precise that is.
 *
 *   **B. `DerivedGeometry`** — coordinates. Either published by the source
 *      itself, or looked up in a *separate* street-reference dataset. Never
 *      invented, never geocoded by guesswork, never a road centre assigned
 *      without saying where it came from.
 *
 * Every derived geometry must name its reference source, the version of that
 * source, the method used to match, a confidence, and when the lookup happened.
 * `assertGeometryProvenance` enforces that: a geometry that cannot say where it
 * came from is rejected at the point of construction rather than reaching a map.
 */

/** Where a coordinate came from. */
export type GeometryOrigin =
  /** The authority published the coordinate on the record itself. */
  | 'SOURCE_PUBLISHED'
  /** Matched against a separate, versioned street-reference dataset. */
  | 'STREET_REFERENCE'
  /** No coordinate. The honest default. */
  | 'NONE';

/** How the coordinate was arrived at. */
export type GeometryMethod =
  | 'SOURCE_POINT'
  | 'STREET_NAME_EXACT'
  | 'STREET_NAME_NORMALISED'
  | 'USRN'
  | 'NONE';

/**
 * What the coordinate actually locates. This is a claim about precision and it
 * must never be inflated: a street-centreline match locates a street, not a bay.
 */
export type GeometryPrecision =
  /** The position of the notice itself. */
  | 'POINT'
  /** A representative point on a street. Correct street, unknown position along it. */
  | 'STREET'
  /** A zone or area centroid. Coarser than a street. */
  | 'AREA'
  | 'NONE';

export const PRECISION_LABELS: Readonly<Record<GeometryPrecision, string>> = {
  POINT: 'Exact position recorded by the authority',
  STREET: 'Street-level — the correct street, not a position along it',
  AREA: 'Area-level — a zone, not a street',
  NONE: 'No position available',
};

/** A. What the authority published about location. Never modified by us. */
export interface SourceLocation {
  readonly streetName: string;
  readonly streetNameNormalised: string;
  readonly locality: string | null;
  readonly postcodeDistrict: string | null;
  /** The publisher's own precision claim, verbatim (Camden publishes "Street"). */
  readonly publisherSpatialAccuracy: string | null;
}

/** Identity and version of a street-reference dataset. */
export interface StreetReferenceDescriptor {
  /** Stable id, e.g. `os-open-usrn`. */
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly licence: string;
  readonly url: string;
  /** The release actually loaded, e.g. `2026-07`. Not a build version. */
  readonly version: string;
}

/** Provenance carried by every coordinate the product holds. */
export interface GeometryProvenance {
  readonly origin: GeometryOrigin;
  readonly method: GeometryMethod;
  /** Reference dataset id, or the source column name for SOURCE_PUBLISHED. */
  readonly referenceSource: string | null;
  /** Release/version of the reference dataset. Null for source-published points. */
  readonly referenceVersion: string | null;
  /** The matched reference record, e.g. a USRN. Lets a match be re-checked. */
  readonly referenceRecordId: string | null;
  /** Confidence in the match itself, [0,1]. Not the same as row completeness. */
  readonly confidence: number;
  /** ISO timestamp of the lookup, so a stale match can be found and redone. */
  readonly lookedUpAt: string | null;
}

/** B. A coordinate, with the provenance that makes it defensible. */
export interface DerivedGeometry {
  readonly longitude: number;
  readonly latitude: number;
  readonly precision: Exclude<GeometryPrecision, 'NONE'>;
  readonly provenance: GeometryProvenance;
}

/** The absence of a coordinate, with the reason. */
export interface NoGeometry {
  readonly longitude: null;
  readonly latitude: null;
  readonly precision: 'NONE';
  readonly provenance: GeometryProvenance;
  /** Machine-readable reason, surfaced in ingestion reports and the UI. */
  readonly reason: NoGeometryReason;
}

export type NoGeometryReason =
  /** The source published no coordinate columns at all. */
  | 'SOURCE_PUBLISHES_NO_COORDINATES'
  /** Coordinate columns exist but this row's values were unusable. */
  | 'SOURCE_COORDINATES_UNUSABLE'
  /** No street-reference dataset is configured, so nothing can be looked up. */
  | 'NO_STREET_REFERENCE_CONFIGURED'
  /** A reference is configured but this street is not in it. */
  | 'STREET_NOT_IN_REFERENCE';

export type GeometryResult = DerivedGeometry | NoGeometry;

export function hasGeometry(result: GeometryResult): result is DerivedGeometry {
  return result.precision !== 'NONE';
}

export const NO_GEOMETRY_PROVENANCE: GeometryProvenance = {
  origin: 'NONE',
  method: 'NONE',
  referenceSource: null,
  referenceVersion: null,
  referenceRecordId: null,
  confidence: 0,
  lookedUpAt: null,
};

export function noGeometry(reason: NoGeometryReason): NoGeometry {
  return {
    longitude: null,
    latitude: null,
    precision: 'NONE',
    provenance: NO_GEOMETRY_PROVENANCE,
    reason,
  };
}

/**
 * The guard that makes fabricated geography a construction error rather than a
 * thing to be caught in review.
 *
 * Throws unless the provenance can answer "where did this coordinate come from".
 * A source-published point must name the column it came from. A derived point
 * must name the reference dataset, its version and when it was looked up.
 */
export function assertGeometryProvenance(provenance: GeometryProvenance): void {
  const { origin, method, referenceSource, referenceVersion, lookedUpAt, confidence } = provenance;

  if (origin === 'NONE') {
    throw new Error('A geometry cannot have origin NONE. Use noGeometry() instead.');
  }
  if (method === 'NONE') {
    throw new Error('A geometry must record the method used to derive it.');
  }
  if (!referenceSource) {
    throw new Error('A geometry must name its reference source.');
  }
  if (confidence <= 0 || confidence > 1) {
    throw new Error(`Geometry confidence must be in (0,1]; got ${confidence}.`);
  }
  if (origin === 'STREET_REFERENCE') {
    if (!referenceVersion) {
      throw new Error(
        'A geometry derived from a street reference must record the version of that reference, ' +
          'so the match can be reproduced or invalidated when the reference changes.',
      );
    }
    if (!lookedUpAt) {
      throw new Error('A derived geometry must record when the lookup happened.');
    }
  }
}

/** Build a geometry the authority itself published. */
export function sourcePublishedGeometry(
  longitude: number,
  latitude: number,
  sourceColumn: string,
): DerivedGeometry {
  const provenance: GeometryProvenance = {
    origin: 'SOURCE_PUBLISHED',
    method: 'SOURCE_POINT',
    referenceSource: sourceColumn,
    referenceVersion: null,
    referenceRecordId: null,
    confidence: 1,
    lookedUpAt: null,
  };
  assertGeometryProvenance(provenance);
  return { longitude, latitude, precision: 'POINT', provenance };
}

/** Build a geometry matched in a street-reference dataset. */
export function streetReferenceGeometry(args: {
  readonly longitude: number;
  readonly latitude: number;
  readonly reference: StreetReferenceDescriptor;
  readonly method: Extract<GeometryMethod, 'STREET_NAME_EXACT' | 'STREET_NAME_NORMALISED' | 'USRN'>;
  readonly referenceRecordId: string;
  readonly confidence: number;
  readonly lookedUpAt: string;
  /** A street match locates a street. Callers may not claim POINT here. */
  readonly precision?: Extract<GeometryPrecision, 'STREET' | 'AREA'>;
}): DerivedGeometry {
  const provenance: GeometryProvenance = {
    origin: 'STREET_REFERENCE',
    method: args.method,
    referenceSource: args.reference.id,
    referenceVersion: args.reference.version,
    referenceRecordId: args.referenceRecordId,
    confidence: args.confidence,
    lookedUpAt: args.lookedUpAt,
  };
  assertGeometryProvenance(provenance);
  return {
    longitude: args.longitude,
    latitude: args.latitude,
    precision: args.precision ?? 'STREET',
    provenance,
  };
}

/**
 * A street-reference dataset that can turn a street name into geometry.
 *
 * Deliberately an interface with one honest implementation today
 * (`UnavailableStreetReference`). Building the boundary without building a
 * geocoding subsystem keeps the option open and the current behaviour truthful.
 */
export interface StreetReferenceResolver {
  readonly descriptor: StreetReferenceDescriptor | null;
  readonly available: boolean;
  resolve(location: SourceLocation): GeometryResult;
}
