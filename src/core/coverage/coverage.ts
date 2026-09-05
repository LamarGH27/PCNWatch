/**
 * Geographic coverage.
 *
 * This module is the single source of truth for what PCNWatch is allowed to
 * claim about a place. Every map, hotspot and location surface asks it before
 * rendering anything, so there is exactly one place to be wrong — and it is
 * written to be wrong in the safe direction.
 *
 * The rule: coverage is asserted from *ingested data*, never from configuration
 * alone. An authority row saying `LIVE` with no successful ingestion and no
 * events is treated as no coverage.
 */

export type CoverageState =
  | 'COVERED'
  | 'NO_COVERAGE'
  | 'TEMPORARILY_UNAVAILABLE'
  | 'DEMO_DATA';

export interface CoverageEvidence {
  /** Whether the authority is configured as in-scope for the map. */
  readonly configuredLive: boolean;
  /** Number of PCN events actually stored for the authority. */
  readonly eventCount: number;
  /** Locations that carry geometry. Zero means nothing can be drawn on a map. */
  readonly geolocatedLocationCount: number;
  /** PCN events whose own row carried a position. */
  readonly geolocatedEventCount: number;
  /** PCN events at a location that carries geometry — what the map shows. */
  readonly mappedEventCount: number;
  /** ISO timestamp of the last ingestion run that succeeded, if any. */
  readonly lastSuccessfulIngestionAt: string | null;
  /** True when the datastore could not be reached for this request. */
  readonly sourceUnavailable: boolean;
  /** True when the stored data is explicitly demo/fixture data. */
  readonly isDemoData: boolean;
}

export interface CoverageResult {
  readonly state: CoverageState;
  readonly authoritySlug: string;
  readonly authorityName: string;
  /** Headline shown to the user. Always honest about what we do and do not have. */
  readonly headline: string;
  readonly detail: string;
  /** Whether any enforcement figure may be rendered at all. */
  readonly canShowActivity: boolean;
  /** Whether the UI must show a prominent demo banner. */
  readonly requiresDemoBanner: boolean;
  readonly lastUpdated: string | null;
  readonly eventCount: number;
  /**
   * Whether any stored location can be placed on a map.
   *
   * False with a non-zero `eventCount` is a real and honest state: the authority
   * publishes enforcement records without coordinates. The map must say that
   * rather than "no recorded PCNs", which would be a false statement about
   * enforcement.
   */
  readonly hasMappableGeography: boolean;
  /**
   * Share of recorded notices that can be placed on a map, 0–1, or null when
   * there is nothing recorded.
   *
   * Camden publishes coordinates for some of its notices and not others. A map
   * drawn from the geolocated subset is true about every point it shows and
   * silent about the rest, and silence here reads as absence of enforcement.
   * The share is carried so a surface can say what it is leaving out.
   */
  readonly mappableEventShare: number | null;
  /**
   * Share of recorded notices that appear on the map at all, 0–1.
   *
   * Larger than `mappableEventShare`, and the difference is the point: the map
   * draws every notice on a street the authority positioned, so a notice with no
   * position of its own still appears — at its street's point. One number says
   * how much of the activity is visible, the other how precisely it is placed.
   */
  readonly mappedEventShare: number | null;
}

/** Below this, a borough does not have enough data to be presented as covered. */
export const MIN_EVENTS_FOR_COVERAGE = 100;

export function assessCoverage(
  authoritySlug: string,
  authorityName: string,
  evidence: CoverageEvidence,
): CoverageResult {
  const base = {
    authoritySlug,
    authorityName,
    eventCount: evidence.eventCount,
    hasMappableGeography: evidence.geolocatedLocationCount > 0,
    mappableEventShare:
      evidence.eventCount > 0 ? evidence.geolocatedEventCount / evidence.eventCount : null,
    mappedEventShare:
      evidence.eventCount > 0 ? evidence.mappedEventCount / evidence.eventCount : null,
  };

  // A datastore failure is never dressed up as "no enforcement here".
  if (evidence.sourceUnavailable) {
    return {
      ...base,
      state: 'TEMPORARILY_UNAVAILABLE',
      headline: 'Data temporarily unavailable',
      detail:
        'We could not load enforcement data for this area just now. This is a problem on our side, not a statement about enforcement activity. Please try again shortly.',
      canShowActivity: false,
      requiresDemoBanner: false,
      lastUpdated: evidence.lastSuccessfulIngestionAt,
    };
  }

  if (evidence.isDemoData) {
    return {
      ...base,
      state: 'DEMO_DATA',
      headline: 'Demonstration data',
      detail:
        'Everything shown here is fabricated sample data for development and testing. It does not describe real enforcement activity anywhere.',
      canShowActivity: true,
      requiresDemoBanner: true,
      lastUpdated: evidence.lastSuccessfulIngestionAt,
    };
  }

  if (
    !evidence.configuredLive ||
    evidence.lastSuccessfulIngestionAt === null ||
    evidence.eventCount < MIN_EVENTS_FOR_COVERAGE
  ) {
    return {
      ...base,
      state: 'NO_COVERAGE',
      headline: `${authorityName} is not covered yet`,
      detail:
        'PCNWatch only shows enforcement activity where we hold enough published data to describe it honestly. We do not hold that for this area, so we are not showing anything rather than guessing.',
      canShowActivity: false,
      requiresDemoBanner: false,
      lastUpdated: null,
    };
  }

  return {
    ...base,
    state: 'COVERED',
    headline: `${authorityName} — enforcement data available`,
    detail:
      'Figures describe penalty charge notices recorded in the published dataset for this area. They show where enforcement has happened, not where parking is or is not permitted.',
    canShowActivity: true,
    requiresDemoBanner: false,
    lastUpdated: evidence.lastSuccessfulIngestionAt,
  };
}

/**
 * The one place the product states its geographic scope.
 *
 * Every surface that mentions coverage reads this rather than hardcoding
 * "Camden only", so widening scope is a data change and not a copy hunt.
 */
export const COVERAGE_SCOPE = {
  liveAuthoritySlugs: ['camden'] as const,
  statement: 'Enforcement data currently covers the London Borough of Camden only.',
  shortStatement: 'Camden only',
  explanation:
    'PCN analysis, deadlines and challenge drafting work for London local-authority notices generally. The enforcement map is a separate thing: it needs a published dataset per borough, and so far that means Camden.',
} as const;

export function isAuthorityInMapScope(slug: string): boolean {
  return (COVERAGE_SCOPE.liveAuthoritySlugs as readonly string[]).includes(slug);
}
