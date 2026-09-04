/**
 * Ticket Activity Score configuration.
 *
 * Weights and thresholds live here (not scattered through the algorithm) so they
 * can be tuned, reviewed and versioned. Any change to these values MUST bump
 * `MODEL_VERSION`, because persisted scores record the version that produced them.
 *
 * See docs/ticket-activity-score.md for the derivation and the reasoning behind
 * the departure from the original conceptual weighting.
 */

export const MODEL_VERSION = 'tas-1.0.0';

export interface ScoringConfig {
  /** Base weights. Must sum to 1. `window` is redistributed when no filter is active. */
  readonly weights: {
    readonly volume: number;
    readonly recent: number;
    readonly window: number;
    readonly trend: number;
  };
  /** Months at which a PCN counts half as much as one from the current month. */
  readonly recencyHalfLifeMonths: number;
  /** Width of the "recent activity" window, in months. */
  readonly recentWindowMonths: number;
  /** Width of the comparison window used for trend, in months. */
  readonly trendWindowMonths: number;
  /** Pseudo-count for shrinking noisy ratios (trend, window lift) toward neutral. */
  readonly shrinkagePseudoCount: number;
  /** Below this data confidence a location is not scored at all. */
  readonly minDataConfidence: number;
  /** Below this many PCNs a location is not scored at all. */
  readonly minObservations: number;
  /** Fewer eligible comparison locations than this makes percentiles meaningless. */
  readonly minComparisonPopulation: number;
  /** Ratio at or above which a lift/trend component saturates at 1.0. */
  readonly ratioSaturation: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  weights: {
    volume: 0.5,
    recent: 0.2,
    window: 0.2,
    trend: 0.1,
  },
  recencyHalfLifeMonths: 9,
  recentWindowMonths: 3,
  trendWindowMonths: 6,
  shrinkagePseudoCount: 12,
  minDataConfidence: 0.4,
  minObservations: 5,
  minComparisonPopulation: 5,
  ratioSaturation: 2,
};

export const CLASSIFICATION_BANDS = [
  { max: 19, key: 'VERY_LOW', label: 'Very Low' },
  { max: 39, key: 'LOW', label: 'Low' },
  { max: 59, key: 'MODERATE', label: 'Moderate' },
  { max: 79, key: 'HIGH', label: 'High' },
  { max: 100, key: 'VERY_HIGH', label: 'Very High' },
] as const;

/**
 * The single approved wording for what this score is. Rendered verbatim in the UI
 * tooltip; do not paraphrase it into anything resembling a probability.
 */
export const SCORE_DISCLAIMER =
  'The Ticket Activity Score compares historical PCN enforcement activity within available FineRadar data. ' +
  'It does not predict whether you will receive a ticket and does not determine whether parking is permitted.';
