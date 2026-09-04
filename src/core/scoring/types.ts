/** Inputs and outputs for the Ticket Activity Score. Pure data — no I/O types here. */

export type ScoreClassification = 'VERY_LOW' | 'LOW' | 'MODERATE' | 'HIGH' | 'VERY_HIGH';

export type ScoreRefusalReason =
  | 'INSUFFICIENT_SOURCE_QUALITY'
  | 'INSUFFICIENT_OBSERVATIONS'
  | 'NO_COMPARISON_POPULATION'
  | 'NO_GEOMETRY';

/** One PCN observation bucket for a location. Counts are aggregated, never raw events. */
export interface ActivityBucket {
  /** Inclusive start of the bucket, ISO-8601 date (UTC), e.g. "2025-03-01". */
  readonly periodStart: string;
  /** Number of PCNs recorded in this bucket. */
  readonly count: number;
}

/** Hour-of-day (0-23) and day-of-week (0=Sunday..6=Saturday) distributions. */
export interface TemporalProfile {
  /** 24 non-negative counts. */
  readonly hourCounts: readonly number[];
  /** 7 non-negative counts, index 0 = Sunday. */
  readonly dayOfWeekCounts: readonly number[];
}

/** A time-of-day / day-of-week selection the user has filtered to. */
export interface WindowSelection {
  /** Hours included, 0-23. Empty/undefined means "all hours". */
  readonly hours?: readonly number[];
  /** Days included, 0=Sunday. Empty/undefined means "all days". */
  readonly daysOfWeek?: readonly number[];
}

export interface LocationActivityInput {
  readonly locationId: string;
  /** Monthly (or other fixed-width) buckets, ascending by periodStart. */
  readonly buckets: readonly ActivityBucket[];
  readonly temporal: TemporalProfile;
  /**
   * Data confidence in [0,1] describing source quality for this location:
   * geocoding precision, field completeness, source reliability.
   */
  readonly dataConfidence: number;
  /** True when the location has usable geometry. Scores are refused without it. */
  readonly hasGeometry: boolean;
}

export interface ScoreComponent {
  readonly key: 'volume' | 'recent' | 'window' | 'trend';
  readonly label: string;
  /** Normalised component value in [0,1]. */
  readonly value: number;
  /** Effective weight applied for this computation (weights always sum to 1). */
  readonly weight: number;
  /** Human-readable justification, safe to render in the UI. */
  readonly explanation: string;
}

export interface TicketActivityScore {
  readonly locationId: string;
  readonly score: number;
  readonly classification: ScoreClassification;
  readonly components: readonly ScoreComponent[];
  /** Score before confidence shrinkage — retained for auditability. */
  readonly rawScore: number;
  readonly dataConfidence: number;
  readonly totalPcns: number;
  readonly modelVersion: string;
  /** Whether a user time/day filter influenced the computation. */
  readonly windowApplied: boolean;
}

export interface ScoreRefusal {
  readonly locationId: string;
  readonly scored: false;
  readonly reason: ScoreRefusalReason;
  readonly message: string;
}

export type ScoreResult = (TicketActivityScore & { readonly scored: true }) | ScoreRefusal;
