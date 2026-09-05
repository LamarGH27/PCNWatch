import type { Pool } from 'pg';
import { runIngestion, type RunOptions } from '@/data-sources/shared/pipeline';
import type { IngestionAdapter, IngestionError, NormalisedPcnEvent } from '@/data-sources/shared/types';
import { computeTicketActivityScores } from '@/core/scoring/ticket-activity-score';
import { MODEL_VERSION } from '@/core/scoring/config';
import type { LocationActivityInput } from '@/core/scoring/types';
import { trendLabelFor } from '@/server/ingestion/scoring-job';
import { knownContraventionCodes } from '@/core/reference/store';
import {
  createPool,
  createPostgresSink,
  failRun,
  finishRun,
  loadScoringInputs,
  persistScores,
  rebuildAggregates,
  requireAuthorityId,
  startRun,
  upsertSource,
  upsertSourceVersion,
  type ScoreRow,
} from './store';
import { analyseQuality, evaluateQualityGate, type QualityGate, type QualityReport } from './quality';

/**
 * The full real-data ingestion job, end to end.
 *
 * Order matters and is deliberate:
 *   1. Open a transaction and record that a run started — so a crash leaves
 *      evidence rather than silence.
 *   2. Fetch, validate, normalise. A source that has changed shape fails the
 *      whole run and writes nothing.
 *   3. Write events and rejections inside the transaction. Either the batch
 *      lands or none of it does; a half-ingested day is worse than no refresh.
 *   4. Only after commit, recompute aggregates and scores.
 *
 * A failed run never deletes or alters previously ingested data. The transaction
 * rolls back and the last good data stays exactly where it was, with its own
 * (older) last-updated timestamp, which is what the coverage layer then reports.
 */

export type PeriodKey = '30D' | '90D' | '12M';
const SCORED_PERIODS: readonly PeriodKey[] = ['30D', '90D', '12M'];

export interface IngestionJobOptions extends RunOptions {
  readonly connectionString: string;
  readonly authoritySlug: string;
  readonly triggerSource?: string;
  /**
   * True when the rows did not come from the official published source.
   * Recorded on the run so the coverage layer refuses to present it as real.
   */
  readonly isDemo: boolean;
  readonly asOf?: string;
  /** Skip score recomputation, for a fetch-only inspection run. */
  readonly skipScoring?: boolean;
}

export interface ScoreDistribution {
  readonly periodKey: PeriodKey;
  readonly scored: number;
  readonly refused: number;
  readonly refusalsByReason: Readonly<Record<string, number>>;
  readonly min: number | null;
  readonly p25: number | null;
  readonly median: number | null;
  readonly p75: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly byClassification: Readonly<Record<string, number>>;
}

export interface IngestionJobResult {
  readonly runId: string;
  readonly status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  readonly message: string;
  readonly sourceUrl: string | null;
  readonly versionLabel: string;
  readonly contentHash: string;
  readonly retrievedAt: string;
  readonly durationMs: number;
  readonly isDemo: boolean;
  readonly counters: {
    fetched: number;
    accepted: number;
    rejected: number;
    inserted: number;
    updated: number;
    unchanged: number;
    geolocated: number;
    notGeolocated: number;
    errors: number;
    duplicatesInBatch: number;
  };
  readonly warningCounts: Readonly<Record<string, number>>;
  readonly quality: QualityReport | null;
  readonly qualityGate: QualityGate | null;
  readonly scoreDistributions: readonly ScoreDistribution[];
  readonly fatalError: string | null;
  /** Stack of the fatal error. A long run is expensive to repeat blind. */
  readonly fatalStack?: string | null;
}

export async function runCamdenIngestionJob(
  adapter: IngestionAdapter,
  options: IngestionJobOptions,
): Promise<IngestionJobResult> {
  const startedAt = Date.now();
  const pool = createPool({ connectionString: options.connectionString });
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10);

  let runId = '';
  let authorityId = '';

  try {
    authorityId = await withClient(pool, (c) => requireAuthorityId(c, options.authoritySlug));

    const sourceId = await withClient(pool, (c) => upsertSource(c, adapter.descriptor));
    runId = await withClient(pool, (c) =>
      startRun(c, sourceId, authorityId, options.triggerSource ?? 'cli', options.isDemo),
    );

    // Everything the pipeline produces is captured so the report can describe
    // the data, not just count it.
    const acceptedEvents: NormalisedPcnEvent[] = [];
    const allErrors: IngestionError[] = [];

    const client = await pool.connect();
    let sourceVersionId: string | null = null;
    let retrievedAt = new Date().toISOString();
    const sourceUrl: string | null = adapter.descriptor.sourceUrl;

    let pipelineResult;
    try {
      await client.query('begin');

      let sink = createPostgresSink({
        client,
        sourceId,
        authorityId,
        runId,
        sourceVersionId: null,
        retrievedAt,
      });

      pipelineResult = await runIngestion(
        {
          descriptor: adapter.descriptor,
          normalise: adapter.normalise.bind(adapter),
          async fetch(fetchOptions) {
            const fetched = await adapter.fetch(fetchOptions);
            retrievedAt = fetched.retrievedAt;
            sourceVersionId = await upsertSourceVersion(client, sourceId, {
              versionLabel: fetched.versionLabel,
              contentHash: fetched.contentHash,
              retrievedAt: fetched.retrievedAt,
              recordCount: fetched.rows.length,
              sourceEffectiveDate: fetched.sourceEffectiveDate,
            });
            sink = createPostgresSink({
              client,
              sourceId,
              authorityId,
              runId,
              sourceVersionId,
              retrievedAt,
            });
            return fetched;
          },
        },
        {
          async upsertEvents(events) {
            acceptedEvents.push(...events);
            return sink.upsertEvents(events);
          },
          async recordErrors(errors) {
            allErrors.push(...errors);
            return sink.recordErrors(errors);
          },
        },
        options,
      );

      if (pipelineResult.status === 'FAILED') {
        // Nothing is written for a run the pipeline judged unusable.
        await client.query('rollback');
      } else {
        await client.query('commit');
      }
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    const quality = analyseQuality(
      acceptedEvents,
      allErrors,
      new Set(knownContraventionCodes()),
      asOf,
    );
    const qualityGate = evaluateQualityGate(
      quality,
      pipelineResult.report.fetched,
      pipelineResult.report.rejected,
    );

    const duplicatesInBatch = allErrors.filter((e) => e.errorCode === 'DUPLICATE_IN_BATCH').length;

    if (pipelineResult.status === 'FAILED') {
      await failRun(pool, runId, pipelineResult.message, authorityId, options.isDemo);
      return {
        runId,
        status: 'FAILED',
        message: pipelineResult.message,
        sourceUrl,
        versionLabel: pipelineResult.versionLabel,
        contentHash: pipelineResult.contentHash,
        retrievedAt,
        durationMs: Date.now() - startedAt,
        isDemo: options.isDemo,
        counters: { ...pipelineResult.report, duplicatesInBatch },
        warningCounts: pipelineResult.warningCounts,
        quality,
        qualityGate,
        scoreDistributions: [],
        fatalError: pipelineResult.message,
      };
    }

    await withClient(pool, (c) =>
      finishRun(c, runId, {
        status: pipelineResult.status,
        sourceVersionId,
        counters: pipelineResult.report,
        report: {
          authorityId,
          demo: options.isDemo,
          message: pipelineResult.message,
          warningCounts: pipelineResult.warningCounts,
          contentHash: pipelineResult.contentHash,
          quality,
          qualityGate,
        },
      }),
    );

    await rebuildAggregates(pool, authorityId);

    const scoreDistributions: ScoreDistribution[] = [];
    if (!options.skipScoring) {
      for (const period of SCORED_PERIODS) {
        scoreDistributions.push(
          await recomputeScores(pool, options.authoritySlug, authorityId, period, asOf),
        );
      }
    }

    return {
      runId,
      status: pipelineResult.status,
      message: pipelineResult.message,
      sourceUrl,
      versionLabel: pipelineResult.versionLabel,
      contentHash: pipelineResult.contentHash,
      retrievedAt,
      durationMs: Date.now() - startedAt,
      isDemo: options.isDemo,
      counters: { ...pipelineResult.report, duplicatesInBatch },
      warningCounts: pipelineResult.warningCounts,
      quality,
      qualityGate,
      scoreDistributions,
      fatalError: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId && authorityId) {
      await failRun(pool, runId, message, authorityId, options.isDemo).catch(() => {});
    }
    return {
      runId,
      status: 'FAILED',
      message,
      sourceUrl: adapter.descriptor.sourceUrl,
      versionLabel: '',
      contentHash: '',
      retrievedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      isDemo: options.isDemo,
      counters: {
        fetched: 0, accepted: 0, rejected: 0, inserted: 0, updated: 0,
        unchanged: 0, geolocated: 0, notGeolocated: 0, errors: 0, duplicatesInBatch: 0,
      },
      warningCounts: {},
      quality: null,
      qualityGate: null,
      scoreDistributions: [],
      fatalError: message,
      fatalStack: error instanceof Error ? (error.stack ?? null) : null,
    };
  } finally {
    await pool.end();
  }
}

/**
 * Recomputes and persists scores for one period, returning the resulting
 * distribution so the operator can see whether the thresholds differentiate.
 */
export async function recomputeScores(
  pool: Pool,
  authoritySlug: string,
  authorityId: string,
  periodKey: PeriodKey,
  asOf: string,
): Promise<ScoreDistribution> {
  const rows = await loadScoringInputs(pool, authoritySlug, periodStartFor(periodKey, asOf));

  const inputs: LocationActivityInput[] = rows.map((row) => ({
    locationId: row.location_id,
    buckets: Array.isArray(row.monthly_counts)
      ? row.monthly_counts
          .filter((b) => typeof b?.periodStart === 'string')
          .map((b) => ({ periodStart: String(b.periodStart).slice(0, 10), count: Number(b.count) }))
      : [],
    temporal: {
      hourCounts: indexed(row.hour_counts, 24),
      dayOfWeekCounts: indexed(row.day_counts, 7),
    },
    dataConfidence: Number(row.data_confidence ?? 0),
    hasGeometry: Boolean(row.has_geometry),
  }));

  const results = computeTicketActivityScores(inputs, { asOf });

  const refusalsByReason: Record<string, number> = {};
  const byClassification: Record<string, number> = {};
  const scores: number[] = [];

  const scoreRows: ScoreRow[] = results.map((result) => {
    if (result.scored) {
      scores.push(result.score);
      byClassification[result.classification] = (byClassification[result.classification] ?? 0) + 1;
      return {
        locationId: result.locationId,
        score: result.score,
        classification: result.classification,
        refusalReason: null,
        components: {
          components: result.components,
          windowApplied: result.windowApplied,
          trendLabel: trendLabelFor(result.components),
        },
        rawScore: result.rawScore,
        totalPcns: result.totalPcns,
        dataConfidence: result.dataConfidence,
        modelVersion: result.modelVersion,
      };
    }
    refusalsByReason[result.reason] = (refusalsByReason[result.reason] ?? 0) + 1;
    return {
      locationId: result.locationId,
      score: null,
      classification: null,
      refusalReason: result.message,
      components: { reason: result.reason },
      rawScore: null,
      totalPcns: 0,
      dataConfidence: 0,
      modelVersion: MODEL_VERSION,
    };
  });

  for (let i = 0; i < scoreRows.length; i += 500) {
    await persistScores(pool, authorityId, periodKey, asOf, scoreRows.slice(i, i + 500));
  }

  const sorted = [...scores].sort((a, b) => a - b);
  return {
    periodKey,
    scored: scores.length,
    refused: scoreRows.length - scores.length,
    refusalsByReason,
    min: sorted[0] ?? null,
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    max: sorted[sorted.length - 1] ?? null,
    mean: scores.length === 0 ? null : Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
    byClassification,
  };
}

/**
 * The first month a period includes.
 *
 * A score carries a period key, so it must be computed from that period's data.
 * Feeding every period the full history made all three identical, which meant the
 * time filter changed the numbers on screen without changing the ranking.
 */
export function periodStartFor(periodKey: PeriodKey, asOf: string): string | null {
  const days = periodKey === '30D' ? 30 : periodKey === '90D' ? 90 : 365;
  const from = new Date(`${asOf}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - days);
  // Aggregates are monthly buckets, so align to the start of the month.
  from.setUTCDate(1);
  return from.toISOString().slice(0, 10);
}

function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[index] ?? null;
}

function indexed(value: unknown, length: number): number[] {
  const counts = Array.from({ length }, () => 0);
  if (value === null || typeof value !== 'object') return counts;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const i = Number(key);
    const n = Number(raw);
    if (Number.isInteger(i) && i >= 0 && i < length && Number.isFinite(n)) counts[i] = n;
  }
  return counts;
}

async function withClient<T>(pool: Pool, fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
