import type { NormalisedPcnEvent } from '@/data-sources/shared/types';
import type { IngestionError } from '@/data-sources/shared/types';
import { CAMDEN_BBOX } from '@/data-sources/camden/schema';

/**
 * Data-quality measurement over a normalised batch.
 *
 * This runs on the accepted records — the ones that passed validation — because
 * the question it answers is different from "did the row parse". It answers
 * "having parsed, is this good enough to build enforcement intelligence on".
 *
 * Nothing here deletes or alters a record. It measures, and the caller decides.
 * Aggressively dropping records because they look duplicated would destroy real
 * signal: several PCNs on one street at one hour is exactly what a hotspot is.
 */

export interface QualityReport {
  readonly totalAccepted: number;

  readonly location: {
    readonly withCoordinates: number;
    readonly withoutCoordinates: number;
    readonly percentageGeolocated: number;
    readonly uniqueLocations: number;
    readonly uniqueCoordinatePairs: number;
    /** Coordinate pairs shared by more than one record, and the largest cluster. */
    readonly sharedCoordinatePairs: number;
    readonly largestCoordinateCluster: number;
    /** Accepted records whose coordinates sit outside the expected bounding box. */
    readonly outsideBounds: number;
    /** Street values that look like a placeholder rather than a real place. */
    readonly vagueLocations: number;
    readonly vagueExamples: readonly string[];
    /**
     * Whether the *source* publishes coordinates at all, as opposed to
     * publishing them badly. Camden's PCN dataset publishes none, which is a
     * property of the dataset and not a defect in the records.
     */
    readonly geographyAvailability: GeographyAvailability;
    /** Reasons records carry no geometry, counted. */
    readonly noGeometryReasons: Readonly<Record<string, number>>;
  };

  readonly temporal: {
    readonly earliestDate: string | null;
    readonly latestDate: string | null;
    readonly spanDays: number | null;
    readonly withTime: number;
    readonly withoutTime: number;
    readonly futureDates: number;
    readonly implausiblyOld: number;
    /** Distinct months represented, to expose gaps in coverage. */
    readonly distinctMonths: number;
  };

  readonly contravention: {
    readonly withCode: number;
    readonly withoutCode: number;
    readonly uniqueCodes: number;
    readonly codes: readonly { code: string; count: number }[];
    /** Codes with no record in the approved reference store. */
    readonly unknownCodes: readonly string[];
  };

  readonly duplicates: {
    /** Same source record id seen more than once in the payload. */
    readonly repeatedSourceIds: number;
    /**
     * Records identical on (street, timestamp, code) but with different source
     * ids. These are most likely genuine separate notices, not source noise.
     */
    readonly identicalContentDifferentId: number;
  };

  /** Counters taken from rejected rows, grouped by reason. */
  readonly rejections: Readonly<Record<string, number>>;

  readonly warnings: readonly string[];
}

/**
 * Where geography stands for a batch.
 *
 * The distinction matters because the remedies are different and the honest
 * statements to a user are different. A source that publishes no coordinates
 * needs a street-reference dataset; a source whose coordinates we failed to read
 * needs an adapter fix. Reporting both as "only 0% geolocated" would hide which.
 */
export type GeographyAvailability =
  /** No accepted record's source row carried any coordinate column. */
  | 'SOURCE_PUBLISHES_NONE'
  /** Coordinate columns exist but no record yielded a usable position. */
  | 'PUBLISHED_BUT_UNUSABLE'
  /** Some records positioned, some not. */
  | 'PARTIAL'
  /** Every accepted record carries a position. */
  | 'COMPLETE';

/**
 * Reads the geometry provenance the adapter stamped on each record. Absence of
 * the stamp is treated as unknown rather than assumed to be either case.
 */
function readGeometryProvenance(event: NormalisedPcnEvent): {
  origin: string | null;
  reason: string | null;
} {
  const raw = event.sourceMetadata['_geometry'];
  if (typeof raw !== 'object' || raw === null) return { origin: null, reason: null };
  const record = raw as Record<string, unknown>;
  return {
    origin: typeof record['origin'] === 'string' ? record['origin'] : null,
    reason: typeof record['reason'] === 'string' ? record['reason'] : null,
  };
}

/** Street values that carry no locational meaning. */
const VAGUE_PATTERNS: readonly RegExp[] = [
  /^\s*$/,
  /^(unknown|n\/?a|none|null|nil|tbc|tba|various|other)\b/i,
  /^(camden|london)$/i,
  /^[^a-z]*$/i,
];

/** Anything before civil parking enforcement is implausible in this dataset. */
export const IMPLAUSIBLY_OLD_BEFORE = '2004-01-01';

export function analyseQuality(
  events: readonly NormalisedPcnEvent[],
  errors: readonly IngestionError[],
  knownCodes: ReadonlySet<string>,
  today: string,
): QualityReport {
  const warnings: string[] = [];

  /* -- Location ----------------------------------------------------------- */

  const located = events.filter((e) => e.longitude !== null && e.latitude !== null);
  const coordinateCounts = new Map<string, number>();
  for (const e of located) {
    const key = `${e.longitude!.toFixed(6)},${e.latitude!.toFixed(6)}`;
    coordinateCounts.set(key, (coordinateCounts.get(key) ?? 0) + 1);
  }
  const clusters = [...coordinateCounts.values()];
  const outsideBounds = located.filter(
    (e) =>
      e.longitude! < CAMDEN_BBOX.minLon ||
      e.longitude! > CAMDEN_BBOX.maxLon ||
      e.latitude! < CAMDEN_BBOX.minLat ||
      e.latitude! > CAMDEN_BBOX.maxLat,
  ).length;

  const noGeometryReasons: Record<string, number> = {};
  let sourcePublishedCoordinateColumn = false;
  for (const e of events) {
    const { origin, reason } = readGeometryProvenance(e);
    if (origin === 'SOURCE_PUBLISHED') sourcePublishedCoordinateColumn = true;
    if (reason) {
      noGeometryReasons[reason] = (noGeometryReasons[reason] ?? 0) + 1;
      if (reason === 'SOURCE_COORDINATES_UNUSABLE') sourcePublishedCoordinateColumn = true;
    }
  }

  const geographyAvailability: GeographyAvailability =
    events.length > 0 && located.length === events.length
      ? 'COMPLETE'
      : located.length > 0
        ? 'PARTIAL'
        : sourcePublishedCoordinateColumn
          ? 'PUBLISHED_BUT_UNUSABLE'
          : 'SOURCE_PUBLISHES_NONE';

  const vague = events.filter((e) => VAGUE_PATTERNS.some((p) => p.test(e.streetName)));
  const percentageGeolocated =
    events.length === 0 ? 0 : Math.round((located.length / events.length) * 1000) / 10;

  if (events.length > 0 && geographyAvailability === 'SOURCE_PUBLISHES_NONE') {
    warnings.push(
      'This source publishes no coordinates for any record. The records are not defective — the dataset simply does not contain geography. Positions would have to come from a separate street-reference dataset, and none is loaded, so nothing can be placed on the map.',
    );
  } else if (events.length > 0 && geographyAvailability === 'PUBLISHED_BUT_UNUSABLE') {
    warnings.push(
      'This source publishes coordinate columns but no accepted record yielded a usable position. That points at an adapter or source-format problem, not at missing data.',
    );
  } else if (percentageGeolocated < 50 && events.length > 0) {
    warnings.push(
      `Only ${percentageGeolocated}% of accepted records carry usable coordinates. Map coverage will be sparse and many locations will be refused a score.`,
    );
  }
  if (outsideBounds > 0) {
    warnings.push(
      `${outsideBounds} accepted records carry coordinates outside the expected Camden bounding box. This should be impossible — investigate before trusting the map.`,
    );
  }
  if (vague.length > 0) {
    warnings.push(
      `${vague.length} records have a street value that carries no locational meaning (e.g. "Unknown"). They are kept but will not produce a useful location page.`,
    );
  }

  /* -- Temporal ----------------------------------------------------------- */

  const dates = events.map((e) => e.issuedDate).sort();
  const earliest = dates[0] ?? null;
  const latest = dates[dates.length - 1] ?? null;
  const withTime = events.filter((e) => e.issuedHour !== null).length;
  const future = events.filter((e) => e.issuedDate > today).length;
  const old = events.filter((e) => e.issuedDate < IMPLAUSIBLY_OLD_BEFORE).length;
  const months = new Set(events.map((e) => e.issuedDate.slice(0, 7)));

  if (withTime === 0 && events.length > 0) {
    warnings.push(
      'No accepted record carries a time of day. Hour-of-day profiles and time-window filtering will be empty.',
    );
  }
  if (future > 0) warnings.push(`${future} accepted records are dated in the future.`);
  if (old > 0) warnings.push(`${old} accepted records predate civil parking enforcement.`);

  /* -- Contravention ------------------------------------------------------ */

  const codeCounts = new Map<string, number>();
  for (const e of events) {
    if (e.contraventionCode) codeCounts.set(e.contraventionCode, (codeCounts.get(e.contraventionCode) ?? 0) + 1);
  }
  const codes = [...codeCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const unknownCodes = codes.map((c) => c.code).filter((c) => !knownCodes.has(c));
  const withoutCode = events.filter((e) => e.contraventionCode === null).length;

  if (unknownCodes.length > 0) {
    warnings.push(
      `${unknownCodes.length} contravention codes appear in the data but have no reference record: ${unknownCodes.join(', ')}. Their location pages will show the code without an explanation.`,
    );
  }

  /* -- Duplicates --------------------------------------------------------- */

  const idCounts = new Map<string, number>();
  const contentKeys = new Map<string, Set<string>>();
  for (const e of events) {
    idCounts.set(e.sourceRecordId, (idCounts.get(e.sourceRecordId) ?? 0) + 1);
    const key = `${e.streetNameNormalised}|${e.issuedAt ?? e.issuedDate}|${e.contraventionCode ?? ''}`;
    const ids = contentKeys.get(key) ?? new Set<string>();
    ids.add(e.sourceRecordId);
    contentKeys.set(key, ids);
  }
  const repeatedSourceIds = [...idCounts.values()].filter((n) => n > 1).length;
  const identicalContentDifferentId = [...contentKeys.values()].filter((s) => s.size > 1).length;

  /* -- Rejections --------------------------------------------------------- */

  const rejections: Record<string, number> = {};
  for (const error of errors) {
    rejections[error.errorCode] = (rejections[error.errorCode] ?? 0) + 1;
  }

  return {
    totalAccepted: events.length,
    location: {
      withCoordinates: located.length,
      withoutCoordinates: events.length - located.length,
      percentageGeolocated,
      uniqueLocations: new Set(events.map((e) => e.locationSlug)).size,
      uniqueCoordinatePairs: coordinateCounts.size,
      sharedCoordinatePairs: clusters.filter((n) => n > 1).length,
      largestCoordinateCluster: clusters.length === 0 ? 0 : Math.max(...clusters),
      outsideBounds,
      vagueLocations: vague.length,
      vagueExamples: [...new Set(vague.map((e) => e.streetName))].slice(0, 5),
      geographyAvailability,
      noGeometryReasons,
    },
    temporal: {
      earliestDate: earliest,
      latestDate: latest,
      spanDays: earliest && latest ? daysBetween(earliest, latest) : null,
      withTime,
      withoutTime: events.length - withTime,
      futureDates: future,
      implausiblyOld: old,
      distinctMonths: months.size,
    },
    contravention: {
      withCode: events.length - withoutCode,
      withoutCode,
      uniqueCodes: codeCounts.size,
      codes: codes.slice(0, 20),
      unknownCodes,
    },
    duplicates: { repeatedSourceIds, identicalContentDifferentId },
    rejections,
    warnings,
  };
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Whether the measured quality is good enough to present as enforcement
 * intelligence.
 *
 * Deliberately conservative and separate from the ingestion decision: data can be
 * worth storing while still being too poor to build a map on. The caller reports
 * both outcomes rather than conflating them.
 */
export interface QualityGate {
  readonly pass: boolean;
  readonly failures: readonly string[];
  readonly cautions: readonly string[];
  /**
   * Why the map cannot be presented, when it cannot. Separate from `pass` so a
   * caller can say the accurate thing: a dataset with no geography is not a
   * dataset with broken geography, even though neither can be mapped.
   */
  readonly mapReadiness: MapReadiness;
}

export type MapReadiness =
  | 'READY'
  /** Enough records, but too few positioned to draw a map worth showing. */
  | 'SPARSE'
  /** The source publishes no coordinates. Needs a street reference, not a fix. */
  | 'NO_SOURCE_GEOGRAPHY'
  /** Coordinates are published but unreadable. Needs an adapter fix. */
  | 'GEOGRAPHY_UNREADABLE';

export const QUALITY_THRESHOLDS = {
  /** Below this share of geolocated records the map is not worth presenting. */
  minPercentageGeolocated: 20,
  /** Below this many accepted records there is nothing to rank. */
  minAcceptedRecords: 100,
  /** Above this share of rejected rows the source is probably misread. */
  maxRejectionRate: 0.2,
} as const;

export function evaluateQualityGate(
  quality: QualityReport,
  fetched: number,
  rejected: number,
): QualityGate {
  const failures: string[] = [];
  const cautions: string[] = [];

  if (quality.totalAccepted < QUALITY_THRESHOLDS.minAcceptedRecords) {
    failures.push(
      `Only ${quality.totalAccepted} records were accepted; at least ${QUALITY_THRESHOLDS.minAcceptedRecords} are needed before enforcement activity can be presented.`,
    );
  }

  const rejectionRate = fetched === 0 ? 0 : rejected / fetched;
  if (rejectionRate > QUALITY_THRESHOLDS.maxRejectionRate) {
    failures.push(
      `${(rejectionRate * 100).toFixed(1)}% of fetched rows were rejected, above the ${(QUALITY_THRESHOLDS.maxRejectionRate * 100).toFixed(0)}% threshold. The source has probably changed shape.`,
    );
  }

  let mapReadiness: MapReadiness = 'READY';
  if (quality.location.percentageGeolocated < QUALITY_THRESHOLDS.minPercentageGeolocated) {
    switch (quality.location.geographyAvailability) {
      case 'SOURCE_PUBLISHES_NONE':
        // A caution, not a failure — and the distinction is load-bearing.
        //
        // This gate asks whether the stored data can be presented as enforcement
        // intelligence. A dataset with street names, dates, contravention codes
        // and enforcement classes can: streets can be ranked, profiled and
        // explained. What it cannot do is be drawn on a map, and that is stated
        // separately by `mapReadiness` and enforced in SQL, which filters map
        // cells on `geom is not null`. Failing the whole gate here would report
        // sound data as unusable.
        mapReadiness = 'NO_SOURCE_GEOGRAPHY';
        cautions.push(
          'THE MAP WILL BE EMPTY: this source publishes no coordinates for any record. ' +
            'This is a property of the dataset, not a fault in the records or the adapter — ' +
            'the street names, dates and contravention codes are intact, and hotspot ranking ' +
            'works on them. Positions require a separate street-reference dataset ' +
            '(see docs/geography.md); until one is loaded, no notice may be drawn on a map.',
        );
        break;
      case 'PUBLISHED_BUT_UNUSABLE':
        mapReadiness = 'GEOGRAPHY_UNREADABLE';
        failures.push(
          'The map cannot be built: this source publishes coordinate columns but not one ' +
            'accepted record yielded a usable position. Fix the adapter or investigate the ' +
            'source format before ingesting further.',
        );
        break;
      default:
        mapReadiness = 'SPARSE';
        failures.push(
          `Only ${quality.location.percentageGeolocated}% of accepted records are geolocated, below the ${QUALITY_THRESHOLDS.minPercentageGeolocated}% needed for a usable map.`,
        );
    }
  }

  if (quality.location.outsideBounds > 0) {
    failures.push(
      `${quality.location.outsideBounds} records carry coordinates outside the expected bounds.`,
    );
  }

  if (quality.temporal.withTime === 0) {
    cautions.push('No time-of-day information: hour filters and busiest-time figures will be empty.');
  }
  if (quality.contravention.withoutCode > quality.totalAccepted / 2) {
    cautions.push('More than half of records carry no contravention code.');
  }
  if (quality.duplicates.identicalContentDifferentId > 0) {
    cautions.push(
      `${quality.duplicates.identicalContentDifferentId} groups of records share street, time and code but have different source ids. These are most likely separate genuine notices and have been kept.`,
    );
  }

  return { pass: failures.length === 0, failures, cautions, mapReadiness };
}
