import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { AppError, logInfo } from '@/lib/errors';
import { computeTicketActivityScores } from '@/core/scoring/ticket-activity-score';
import { MODEL_VERSION } from '@/core/scoring/config';
import type { LocationActivityInput } from '@/core/scoring/types';

/**
 * Recomputes Ticket Activity Scores for an authority.
 *
 * The score itself is computed by the pure function in src/core/scoring, so this
 * module is only responsible for loading inputs and persisting results. That
 * separation is what lets the scoring behaviour be tested exhaustively without a
 * database, and it means a score in the table can always be reproduced from the
 * aggregates plus the model version recorded beside it.
 *
 * Locations that cannot be scored get a row too, carrying the refusal reason.
 * The alternative — no row — is indistinguishable from "not computed yet", and
 * the UI needs to tell a user *why* there is no number.
 */

export type PeriodKey = '30D' | '90D' | '12M';

export interface ScoringJobResult {
  readonly authoritySlug: string;
  readonly periodKey: PeriodKey;
  readonly scored: number;
  readonly refused: number;
  readonly refusalsByReason: Readonly<Record<string, number>>;
  readonly modelVersion: string;
  readonly asOf: string;
}

export async function runScoringJob(
  authoritySlug: string,
  periodKey: PeriodKey = '12M',
  asOf: string = new Date().toISOString().slice(0, 10),
): Promise<ScoringJobResult> {
  const supabase = createSupabaseServiceClient();
  if (!supabase) {
    throw new AppError(
      'SUPABASE_NOT_CONFIGURED',
      'The datastore is not configured, so scores cannot be computed.',
      'Set the Supabase environment variables and try again.',
    );
  }

  const { data: authority, error: authorityError } = await supabase
    .from('authorities')
    .select('id')
    .eq('slug', authoritySlug)
    .maybeSingle();
  if (authorityError) throw authorityError;
  if (!authority) {
    throw new AppError(
      'AUTHORITY_NOT_SEEDED',
      `The authority "${authoritySlug}" does not exist.`,
      'Seed the authority directory first.',
    );
  }

  const { data: rows, error } = await supabase.rpc('fineradar_scoring_inputs', {
    p_authority_slug: authoritySlug,
  });
  if (error) throw error;

  const inputs: LocationActivityInput[] = (rows ?? []).map((row: Record<string, unknown>) => ({
    locationId: String(row.location_id),
    buckets: readBuckets(row.monthly_counts),
    temporal: {
      hourCounts: readIndexedCounts(row.hour_counts, 24),
      dayOfWeekCounts: readIndexedCounts(row.day_counts, 7),
    },
    dataConfidence: Number(row.data_confidence ?? 0),
    hasGeometry: Boolean(row.has_geometry),
  }));

  const results = computeTicketActivityScores(inputs, { asOf });

  const refusalsByReason: Record<string, number> = {};
  let scored = 0;

  const scoreRows = results.map((result) => {
    if (result.scored) {
      scored += 1;
      return {
        authority_id: authority.id,
        parking_location_id: result.locationId,
        period_key: periodKey,
        as_of_date: asOf,
        score: result.score,
        classification: result.classification,
        refusal_reason: null,
        components: {
          components: result.components,
          windowApplied: result.windowApplied,
          trendLabel: trendLabelFor(result.components),
        },
        raw_score: result.rawScore,
        total_pcns: result.totalPcns,
        data_confidence: result.dataConfidence,
        model_version: result.modelVersion,
      };
    }

    refusalsByReason[result.reason] = (refusalsByReason[result.reason] ?? 0) + 1;
    return {
      authority_id: authority.id,
      parking_location_id: result.locationId,
      period_key: periodKey,
      as_of_date: asOf,
      score: null,
      classification: null,
      refusal_reason: result.message,
      components: { reason: result.reason },
      raw_score: null,
      total_pcns: 0,
      data_confidence: 0,
      model_version: MODEL_VERSION,
    };
  });

  for (let i = 0; i < scoreRows.length; i += 500) {
    const { error: upsertError } = await supabase
      .from('pcn_activity_scores')
      .upsert(scoreRows.slice(i, i + 500), {
        onConflict: 'parking_location_id,road_segment_id,period_key,as_of_date',
      });
    if (upsertError) throw upsertError;
  }

  const result: ScoringJobResult = {
    authoritySlug,
    periodKey,
    scored,
    refused: scoreRows.length - scored,
    refusalsByReason,
    modelVersion: MODEL_VERSION,
    asOf,
  };

  logInfo('scoring', 'Scores recomputed', { ...result, refusalsByReason: undefined });
  return result;
}

/**
 * Maps the trend component onto a label the UI can show.
 *
 * The thresholds sit either side of 0.5 (neutral) with a deliberate dead band, so
 * a location does not flip between "rising" and "falling" on noise.
 */
export function trendLabelFor(
  components: readonly { key: string; value: number }[],
): 'RISING' | 'FALLING' | 'STABLE' | 'UNKNOWN' {
  const trend = components.find((c) => c.key === 'trend');
  if (!trend) return 'UNKNOWN';
  if (trend.value >= 0.58) return 'RISING';
  if (trend.value <= 0.42) return 'FALLING';
  return 'STABLE';
}

function readBuckets(value: unknown): { periodStart: string; count: number }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = entry as { periodStart?: unknown; count?: unknown };
      const periodStart = typeof record.periodStart === 'string' ? record.periodStart : null;
      const count = Number(record.count ?? 0);
      return periodStart && Number.isFinite(count) ? { periodStart, count } : null;
    })
    .filter((b): b is { periodStart: string; count: number } => b !== null);
}

function readIndexedCounts(value: unknown, length: number): number[] {
  const counts = Array.from({ length }, () => 0);
  if (value === null || typeof value !== 'object') return counts;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const index = Number(key);
    const count = Number(raw);
    if (Number.isInteger(index) && index >= 0 && index < length && Number.isFinite(count)) {
      counts[index] = count;
    }
  }
  return counts;
}
