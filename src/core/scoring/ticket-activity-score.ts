import {
  CLASSIFICATION_BANDS,
  DEFAULT_SCORING_CONFIG,
  MODEL_VERSION,
  type ScoringConfig,
} from './config';
import {
  clamp01,
  median,
  midrankPercentile,
  monthsBetween,
  recencyWeight,
  round,
  shrinkToward,
  sum,
} from './math';
import type {
  LocationActivityInput,
  ScoreClassification,
  ScoreComponent,
  ScoreResult,
  WindowSelection,
} from './types';

export interface ScoringOptions {
  /** Reference date (ISO, UTC) the score is computed "as of". Required for determinism. */
  readonly asOf: string;
  /** Optional user time/day filter. When present the window component is active. */
  readonly window?: WindowSelection;
  readonly config?: ScoringConfig;
}

export function classify(score: number): ScoreClassification {
  for (const band of CLASSIFICATION_BANDS) {
    if (score <= band.max) return band.key;
  }
  return 'VERY_HIGH';
}

export function classificationLabel(classification: ScoreClassification): string {
  return CLASSIFICATION_BANDS.find((b) => b.key === classification)?.label ?? 'Unknown';
}

interface Features {
  readonly input: LocationActivityInput;
  readonly total: number;
  readonly weightedVolume: number;
  readonly recentVolume: number;
  readonly trendValue: number;
  readonly windowValue: number;
}

function isWindowActive(window: WindowSelection | undefined): boolean {
  if (!window) return false;
  const hoursSelected = (window.hours?.length ?? 0) > 0 && (window.hours?.length ?? 0) < 24;
  const daysSelected =
    (window.daysOfWeek?.length ?? 0) > 0 && (window.daysOfWeek?.length ?? 0) < 7;
  return hoursSelected || daysSelected;
}

/**
 * Share of a location's activity that falls inside the selected window, expressed
 * as a lift over the share you would expect if activity were spread uniformly.
 *
 * A lift of 1.0 means "no more concentrated here than anywhere in the week";
 * 2.0 or above means "at least twice the uniform expectation".
 */
function windowLift(input: LocationActivityInput, window: WindowSelection): number {
  const { hourCounts, dayOfWeekCounts } = input.temporal;

  const hourSel = window.hours?.length ? window.hours : null;
  const daySel = window.daysOfWeek?.length ? window.daysOfWeek : null;

  let lift = 1;

  if (hourSel && hourSel.length < 24) {
    const totalHours = sum(hourCounts);
    if (totalHours > 0) {
      const selected = sum(hourSel.map((h) => hourCounts[h] ?? 0));
      const expectedShare = hourSel.length / 24;
      lift *= selected / totalHours / expectedShare;
    }
  }

  if (daySel && daySel.length < 7) {
    const totalDays = sum(dayOfWeekCounts);
    if (totalDays > 0) {
      const selected = sum(daySel.map((d) => dayOfWeekCounts[d] ?? 0));
      const expectedShare = daySel.length / 7;
      lift *= selected / totalDays / expectedShare;
    }
  }

  return lift;
}

/** Maps a neutral-at-1.0 ratio onto [0,1], saturating at `saturation`. */
function ratioToUnit(ratio: number, saturation: number): number {
  if (!Number.isFinite(ratio) || ratio < 0) return 0.5;
  return clamp01(ratio / saturation);
}

function computeFeatures(
  input: LocationActivityInput,
  options: ScoringOptions,
  config: ScoringConfig,
): Features {
  const { asOf } = options;
  const total = sum(input.buckets.map((b) => b.count));

  let weightedVolume = 0;
  let recentVolume = 0;
  let trendRecent = 0;
  let trendPrior = 0;

  for (const bucket of input.buckets) {
    const age = monthsBetween(bucket.periodStart, asOf);
    weightedVolume += bucket.count * recencyWeight(age, config.recencyHalfLifeMonths);
    if (age < config.recentWindowMonths) recentVolume += bucket.count;
    if (age < config.trendWindowMonths) trendRecent += bucket.count;
    else if (age < config.trendWindowMonths * 2) trendPrior += bucket.count;
  }

  // Trend: recent half vs previous half, shrunk toward "flat" when counts are small.
  const rawTrendRatio = trendPrior > 0 ? trendRecent / trendPrior : trendRecent > 0 ? 2 : 1;
  const trendObservations = trendRecent + trendPrior;
  const trendValue = shrinkToward(
    ratioToUnit(rawTrendRatio, config.ratioSaturation),
    0.5,
    trendObservations,
    config.shrinkagePseudoCount,
  );

  const windowActive = isWindowActive(options.window);
  const windowValue = windowActive
    ? shrinkToward(
        ratioToUnit(windowLift(input, options.window as WindowSelection), config.ratioSaturation),
        0.5,
        total,
        config.shrinkagePseudoCount,
      )
    : 0.5;

  return { input, total, weightedVolume, recentVolume, trendValue, windowValue };
}

function effectiveWeights(config: ScoringConfig, windowActive: boolean) {
  const { volume, recent, window, trend } = config.weights;
  if (windowActive) return { volume, recent, window, trend };
  // Redistribute the window weight proportionally across the remaining components
  // rather than silently letting the weights stop summing to 1.
  const remaining = volume + recent + trend;
  return {
    volume: volume / remaining,
    recent: recent / remaining,
    window: 0,
    trend: trend / remaining,
  };
}

/**
 * Compute Ticket Activity Scores for a comparison population.
 *
 * Percentile components are relative to the *eligible* members of `inputs`, so the
 * caller must pass a genuinely comparable set (e.g. all scored road segments in
 * Camden for the same period), not an arbitrary subset.
 *
 * Pure and deterministic: same inputs + same `asOf` + same config → same output.
 */
export function computeTicketActivityScores(
  inputs: readonly LocationActivityInput[],
  options: ScoringOptions,
): ScoreResult[] {
  const config = options.config ?? DEFAULT_SCORING_CONFIG;
  const windowActive = isWindowActive(options.window);
  const weights = effectiveWeights(config, windowActive);

  const results = new Map<string, ScoreResult>();
  const eligible: Features[] = [];

  for (const input of inputs) {
    if (!input.hasGeometry) {
      results.set(input.locationId, {
        locationId: input.locationId,
        scored: false,
        reason: 'NO_GEOMETRY',
        message: 'This location has no verified geometry, so activity cannot be placed on the map.',
      });
      continue;
    }
    if (input.dataConfidence < config.minDataConfidence) {
      results.set(input.locationId, {
        locationId: input.locationId,
        scored: false,
        reason: 'INSUFFICIENT_SOURCE_QUALITY',
        message: 'Source data quality for this location is below the threshold required to score it.',
      });
      continue;
    }
    const features = computeFeatures(input, options, config);
    if (features.total < config.minObservations) {
      results.set(input.locationId, {
        locationId: input.locationId,
        scored: false,
        reason: 'INSUFFICIENT_OBSERVATIONS',
        message: `Fewer than ${config.minObservations} PCNs are recorded here in the available data.`,
      });
      continue;
    }
    eligible.push(features);
  }

  if (eligible.length < config.minComparisonPopulation) {
    for (const features of eligible) {
      results.set(features.input.locationId, {
        locationId: features.input.locationId,
        scored: false,
        reason: 'NO_COMPARISON_POPULATION',
        message:
          'There are too few comparable locations in the available data to rank this one meaningfully.',
      });
    }
    return inputs.map((i) => results.get(i.locationId) as ScoreResult);
  }

  const volumePopulation = eligible.map((f) => f.weightedVolume);
  const recentPopulation = eligible.map((f) => f.recentVolume);

  // Pass 1: raw scores (pre-confidence).
  const raw = eligible.map((features) => {
    const volume = midrankPercentile(features.weightedVolume, volumePopulation);
    const recent = midrankPercentile(features.recentVolume, recentPopulation);
    const rawScore =
      100 *
      (volume * weights.volume +
        recent * weights.recent +
        features.windowValue * weights.window +
        features.trendValue * weights.trend);
    return { features, volume, recent, rawScore };
  });

  // Pass 2: shrink each score toward the population median by its data confidence.
  // Low-confidence locations regress to the middle instead of making a strong claim
  // in either direction. Confidence is never *added* to the score as intensity.
  const medianRaw = median(raw.map((r) => r.rawScore));

  for (const { features, volume, recent, rawScore } of raw) {
    const confidence = clamp01(features.input.dataConfidence);
    const shrunk = medianRaw + (rawScore - medianRaw) * confidence;
    const score = Math.round(clamp01(shrunk / 100) * 100);

    const components: ScoreComponent[] = [
      {
        key: 'volume',
        label: 'Recency-weighted volume',
        value: round(volume),
        weight: round(weights.volume),
        explanation: `More recency-weighted PCN activity than ${Math.round(volume * 100)}% of comparable locations in this dataset.`,
      },
      {
        key: 'recent',
        label: `Activity in the last ${config.recentWindowMonths} months`,
        value: round(recent),
        weight: round(weights.recent),
        explanation: `Recent activity higher than ${Math.round(recent * 100)}% of comparable locations.`,
      },
      {
        key: 'window',
        label: 'Selected time window concentration',
        value: round(features.windowValue),
        weight: round(weights.window),
        explanation: windowActive
          ? 'How concentrated this location’s recorded activity is inside the time window you selected.'
          : 'Not applied — no time or day filter is active.',
      },
      {
        key: 'trend',
        label: 'Recent trend',
        value: round(features.trendValue),
        weight: round(weights.trend),
        explanation:
          'Direction of change between the two most recent comparable periods, damped where counts are small.',
      },
    ];

    results.set(features.input.locationId, {
      scored: true,
      locationId: features.input.locationId,
      score,
      classification: classify(score),
      components,
      rawScore: round(rawScore, 2),
      dataConfidence: round(confidence, 3),
      totalPcns: features.total,
      modelVersion: MODEL_VERSION,
      windowApplied: windowActive,
    });
  }

  return inputs.map((i) => results.get(i.locationId) as ScoreResult);
}
