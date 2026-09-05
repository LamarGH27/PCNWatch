import { Pool } from 'pg';
import type { IngestionAdapter, IngestionError, NormalisedPcnEvent } from '@/data-sources/shared/types';
import { ActivityAccumulator } from './aggregate';
import {
  abandonVersion,
  activateVersion,
  compactActivity,
  createDatasetVersion,
  failRunWithDetail,
  flushActivity,
  pruneVersions,
  reapStaleRuns,
  reapStaleVersions,
  reconcileVersion,
  upsertLocations,
  type Reconciliation,
} from './aggregate-store';
import {
  finishRun,
  requireAuthorityId,
  startRun,
  upsertSource,
  upsertSourceVersion,
  persistScores,
} from './store';
import { analyseQuality, evaluateQualityGate, type QualityGate, type QualityReport } from './quality';
import { computeTicketActivityScores } from '@/core/scoring/ticket-activity-score';
import { MODEL_VERSION } from '@/core/scoring/config';
import { knownContraventionCodes } from '@/core/reference/store';
import { logError, logInfo } from '@/lib/errors';
import { StageTimer, type StageTiming } from './stage-timing';

/**
 * Streaming, aggregate-only Camden ingestion.
 *
 * The old pipeline wrote one row per notice and rebuilt aggregates by reading
 * them back — 769 MB for 485,564 Camden notices, plus 238 MB of dead tuples in
 * `parking_locations` from upserting every street on every batch. Nothing the
 * product shows is asked per notice: every public read function already reads
 * aggregates only.
 *
 * So this counts notices as they stream past and discards them. What lands in
 * the database is one row per (street, day, contravention, class), a hour
 * histogram alongside it, and one row per street carrying one position.
 *
 * Three safety properties, each of which cost us a real incident:
 *
 *  - The run's own bookkeeping is committed outside the data transaction, and
 *    stale RUNNING rows are reaped, so a killed process cannot leave a run
 *    RUNNING for ever.
 *  - The new data is built as an inactive version beside the live one and only
 *    becomes visible after it reconciles. A failed refresh leaves the previous
 *    dataset exactly as it was.
 *  - Nothing is published unless the stored counts sum to the number of notices
 *    accepted from the source.
 */

export interface AggregateIngestionOptions {
  readonly databaseUrl: string;
  readonly authoritySlug: string;
  readonly since?: string;
  readonly limit?: number;
  readonly isDemo: boolean;
  readonly triggerSource?: string;
  readonly sourceUrl: string;
  readonly sourceDatasetId?: string | null;
  /** Cells held before a flush. Bounds memory independently of dataset size. */
  readonly flushEveryCells?: number;
  /** Per-statement ceiling for this ingestion's own connections, in ms. */
  readonly statementTimeoutMs?: number;
  readonly onProgress?: (progress: { fetched: number; cells: number }) => void;
}

export interface AggregateIngestionResult {
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly runId: string;
  readonly datasetVersionId: string | null;
  readonly published: boolean;
  readonly counters: {
    fetched: number;
    accepted: number;
    rejected: number;
    aggregateRows: number;
    locations: number;
    geolocatedLocations: number;
  };
  readonly reconciliation: Reconciliation | null;
  readonly quality: QualityReport | null;
  readonly qualityGate: QualityGate | null;
  readonly scoreDistributions: readonly ScoreDistribution[];
  readonly warningCounts: Readonly<Record<string, number>>;
  readonly classificationCounts: Readonly<Record<string, number>>;
  readonly fatalError: string | null;
  readonly fatalClassification: string | null;
  readonly durationMs: number;
  /** Where the time went, slowest first. Present on failure as well as success. */
  readonly stageTimings: readonly StageTiming[];
}

export interface ScoreDistribution {
  readonly periodKey: string;
  readonly scored: number;
  readonly refused: number;
}

const DEFAULT_FLUSH_EVERY = 50_000;

/**
 * Per-statement ceiling for ingestion connections.
 *
 * Ten minutes: comfortably above every measured stage at Camden scale (the
 * slowest is the index rebuild at a few seconds), and still low enough that a
 * genuinely stuck statement fails the run rather than holding a connection
 * open indefinitely. A run that needs longer than this has a problem a longer
 * timeout will not solve.
 */
const DEFAULT_INGESTION_STATEMENT_TIMEOUT_MS = 600_000;

/**
 * A sample of accepted events, kept for the quality report only.
 *
 * Quality analysis needs event-shaped rows; keeping every one of them would
 * reintroduce the memory problem this rewrite exists to solve. A bounded
 * reservoir gives the same picture of shape and defects at a fixed cost, and the
 * report says how many notices it stands for so nobody reads a sampled
 * percentage as an exact one.
 */
const QUALITY_SAMPLE_LIMIT = 50_000;

export async function runCamdenAggregateIngestion(
  adapter: IngestionAdapter,
  options: AggregateIngestionOptions,
): Promise<AggregateIngestionResult> {
  const pool = new Pool({
    connectionString: options.databaseUrl,
    max: 4,
    ssl: /localhost|127\.0\.0\.1/.test(options.databaseUrl) ? undefined : { rejectUnauthorized: false },
    // Raised for this pool only, and only because a borough-sized refresh is a
    // legitimately long batch job: the flushes and the index rebuild take tens
    // of seconds each on the full dataset, and Supabase's default cuts them off.
    //
    // This is not a substitute for the query fix in migration 0013. Scoring at
    // Camden scale went from 45.8 s to 1.2 s there, and it would now fit inside
    // any sane default. The ceiling exists so a slow hosted instance does not
    // kill a correct, bounded stage — and it applies to this ingestion's own
    // connections, never to the application serving pages, where a query that
    // takes ten minutes should be killed.
    statement_timeout: options.statementTimeoutMs ?? DEFAULT_INGESTION_STATEMENT_TIMEOUT_MS,
  });
  try {
    return await ingestAggregates(pool, adapter, options);
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * The ingestion itself, against a pool the caller owns.
 *
 * Separated from the entry point above so a caller that already holds a pool —
 * a scheduled job, a test against a real database — does not open a second one
 * and does not have the first closed underneath it.
 */
export async function ingestAggregates(
  pool: Pool,
  adapter: IngestionAdapter,
  options: Omit<AggregateIngestionOptions, 'databaseUrl'>,
): Promise<AggregateIngestionResult> {
  const startedAt = Date.now();

  let runId = '';
  let authorityId = '';
  let datasetVersionId: string | null = null;
  let published = false;

  const counters = {
    fetched: 0,
    accepted: 0,
    rejected: 0,
    aggregateRows: 0,
    locations: 0,
    geolocatedLocations: 0,
  };
  const warningCounts: Record<string, number> = {};
  const classificationCounts: Record<string, number> = {};
  const errors: IngestionError[] = [];
  const qualitySample: NormalisedPcnEvent[] = [];
  const timer = new StageTimer();
  // Kept outside the try so a failure after reconciliation still reports it:
  // returning null said "we never checked", which is a different fact.
  let reconciliation: Reconciliation | null = null;

  try {
    const sourceId = await withClient(pool, (c) => upsertSource(c, adapter.descriptor));
    authorityId = await withClient(pool, (c) => requireAuthorityId(c, options.authoritySlug));

    // Before anything else: close out runs that were left RUNNING by a process
    // that never came back. Nothing else does this, and a run stuck at RUNNING
    // misreports freshness indefinitely.
    const reaped = await reapStaleRuns(pool, sourceId);
    if (reaped > 0) {
      logInfo('ingestion', 'Closed abandoned runs left at RUNNING', { count: reaped });
    }

    // And the versions those runs were filling. A process killed outright never
    // reaches the catch block below, so its staged rows are nobody else's job.
    const reapedVersions = await reapStaleVersions(pool, authorityId);
    if (reapedVersions > 0) {
      logInfo('ingestion', 'Discarded dataset versions left half-built', {
        count: reapedVersions,
      });
    }

    runId = await withClient(pool, (c) =>
      startRun(c, sourceId, authorityId, options.triggerSource ?? 'cli', options.isDemo),
    );

    /* -- Stream, count, discard ------------------------------------------- */

    const accumulator = new ActivityAccumulator();
    const flushEvery = options.flushEveryCells ?? DEFAULT_FLUSH_EVERY;
    let retrievedAt = new Date().toISOString();
    let schemaFingerprint: string | null = null;
    let rowNumber = 0;

    const pages = adapter.fetchPages
      ? adapter.fetchPages({ since: options.since, limit: options.limit })
      : singlePage(adapter, options);

    const pendingFlushes: { cells: ReturnType<ActivityAccumulator['drain']> }[] = [];

    let pageStarted = Date.now();
    for await (const page of pages) {
      // Everything since the last page arrived was spent waiting on the source.
      timer.add('FETCH', Date.now() - pageStarted, page.rows.length);
      const normaliseStarted = Date.now();

      retrievedAt = page.retrievedAt;
      schemaFingerprint ??= page.schemaFingerprint;
      counters.fetched += page.rows.length;

      for (const raw of page.rows) {
        const result = adapter.normalise(raw, rowNumber++);
        if (!result.ok) {
          counters.rejected += 1;
          if (errors.length < 1000) errors.push(result.error);
          continue;
        }
        counters.accepted += 1;
        for (const warning of result.warnings) {
          warningCounts[warning] = (warningCounts[warning] ?? 0) + 1;
        }
        const cls = result.event.enforcementType;
        classificationCounts[cls] = (classificationCounts[cls] ?? 0) + 1;

        accumulator.add(result.event);
        if (qualitySample.length < QUALITY_SAMPLE_LIMIT) qualitySample.push(result.event);
      }

      timer.add('NORMALISE', Date.now() - normaliseStarted, page.rows.length);
      options.onProgress?.({ fetched: counters.fetched, cells: accumulator.cellCount });

      if (accumulator.cellCount >= flushEvery) {
        pendingFlushes.push({ cells: accumulator.drain() });
        accumulator.clearCells();
      }
      pageStarted = Date.now();
    }
    pendingFlushes.push({ cells: accumulator.drain() });
    timer.flushAccumulated();

    if (counters.accepted === 0) {
      throw new IngestionFailure(
        'The source returned no usable records. Refusing to publish an empty dataset over ' +
          'a working one — an empty map would read as "no enforcement here".',
        'NO_ACCEPTED_RECORDS',
      );
    }

    /* -- Build the new version beside the live one ------------------------ */

    const sourceVersionId = await withClient(pool, (c) =>
      upsertSourceVersion(c, sourceId, {
        versionLabel: `${retrievedAt.slice(0, 10)}-${schemaFingerprint ?? 'nofingerprint'}`,
        contentHash: schemaFingerprint ?? '',
        retrievedAt,
        recordCount: counters.fetched,
        sourceEffectiveDate: null,
      }),
    ).catch(() => null);

    datasetVersionId = await createDatasetVersion(pool, {
      authorityId,
      sourceId,
      sourceVersionId,
      ingestionRunId: runId,
      provenance: {
        sourceUrl: options.sourceUrl,
        sourceDatasetId: options.sourceDatasetId ?? null,
        sourceFetchedAt: retrievedAt,
        sourceLastUploaded: null,
        sourceSchemaFingerprint: schemaFingerprint,
        isDemo: options.isDemo,
      },
    });

    const locationIds = new Map<string, string>();
    for (const flush of pendingFlushes) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // Locations first: the activity rows reference them. Written once per
        // flush rather than once per batch — the old pipeline's per-batch upsert
        // of every street left 238 MB of dead tuples behind 1,000 live rows.
        const locationsStarted = Date.now();
        const ids = await upsertLocations(
          client,
          authorityId,
          sourceId,
          retrievedAt,
          flush.cells.locations,
        );
        for (const [slug, id] of ids) locationIds.set(slug, id);
        timer.add('LOCATION_RESOLUTION', Date.now() - locationsStarted, ids.size);

        const flushStarted = Date.now();
        const written = await flushActivity(client, {
          datasetVersionId,
          locationIds,
          cells: flush.cells.cells,
        });
        counters.aggregateRows += written;
        timer.add('AGGREGATE_FLUSH', Date.now() - flushStarted, written);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    counters.locations = locationIds.size;
    timer.flushAccumulated();

    // Repack the indexes now the writing has stopped and before the swap. Never
    // fatal: a dataset that reconciles is publishable whether or not its index
    // is tidy.
    await timer
      .time('INDEX_COMPACTION', () => compactActivity(pool))
      .catch((error) => logError('ingestion.compactActivity', error, { datasetVersionId }));

    /* -- Prove it came from the source ------------------------------------ */

    reconciliation = await timer.time('RECONCILIATION', () =>
      reconcileVersion(pool, datasetVersionId as string, counters.accepted),
    );
    if (!reconciliation.reconciles) {
      throw new IngestionFailure(
        `Aggregate totals do not reconcile: stored ${reconciliation.aggregateTotal} against ` +
          `${reconciliation.acceptedFromSource} accepted source records.`,
        'RECONCILIATION_FAILED',
      );
    }

    /* -- Quality, scoring, publication ------------------------------------ */

    const today = new Date().toISOString().slice(0, 10);
    const { quality, qualityGate } = await timer.time('QUALITY_GATE', async () => {
      const q = analyseQuality(qualitySample, errors, new Set(knownContraventionCodes()), today);
      return { quality: q, qualityGate: evaluateQualityGate(q, counters.fetched, counters.rejected) };
    });

    const geolocated = await pool.query<{ n: string }>(
      `select count(*)::text as n from parking_locations
        where authority_id = $1 and geom is not null`,
      [authorityId],
    );
    counters.geolocatedLocations = Number(geolocated.rows[0]?.n ?? 0);

    const scoreDistributions = await scoreVersion(
      pool,
      authorityId,
      options.authoritySlug,
      datasetVersionId,
      timer,
    );

    await timer.time('PUBLICATION', () =>
      activateVersion(pool, {
        datasetVersionId: datasetVersionId as string,
        authorityId,
        reconciliation: reconciliation as Reconciliation,
        rowsFetched: counters.fetched,
        rowsRejected: counters.rejected,
        labels: accumulator.drainLabels(),
      }),
    );
    published = true;
    await timer
      .time('OLD_VERSION_CLEANUP', () => pruneVersions(pool, authorityId))
      .catch(() => 0);

    await withClient(pool, (c) =>
      finishRun(c, runId, {
        status: 'SUCCEEDED',
        sourceVersionId,
        counters: {
          fetched: counters.fetched,
          accepted: counters.accepted,
          rejected: counters.rejected,
          inserted: counters.aggregateRows,
          updated: 0,
          unchanged: 0,
          geolocated: counters.geolocatedLocations,
          notGeolocated: counters.locations - counters.geolocatedLocations,
          errors: errors.length,
        },
        report: {
          authorityId,
          demo: options.isDemo,
          datasetVersionId,
          aggregateRows: counters.aggregateRows,
          reconciliation,
          classificationCounts,
          schemaFingerprint,
        },
      }),
    );

    return {
      status: 'SUCCEEDED',
      runId,
      datasetVersionId,
      published,
      counters,
      reconciliation,
      quality,
      qualityGate,
      scoreDistributions,
      warningCounts,
      classificationCounts,
      fatalError: null,
      fatalClassification: null,
      durationMs: Date.now() - startedAt,
      stageTimings: timer.report(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const classification =
      error instanceof IngestionFailure
        ? error.classification
        : classifyFailure(error);

    // Bookkeeping happens on its own connection, outside any transaction that
    // may have rolled back, so the run is recorded as FAILED even when the data
    // write is undone.
    if (runId) {
      await failRunWithDetail(pool, runId, {
        message,
        classification,
        authorityId: authorityId || null,
        isDemo: options.isDemo,
        fetched: counters.fetched,
        accepted: counters.accepted,
        rejected: counters.rejected,
        errorCount: errors.length,
      }).catch((bookkeepingError) => {
        // Never swallowed: a failure to record the failure is itself a fault.
        logError('ingestion.failRun', bookkeepingError, { runId });
      });
    }
    if (datasetVersionId) {
      await abandonVersion(pool, datasetVersionId).catch((e) =>
        logError('ingestion.abandonVersion', e, { datasetVersionId }),
      );
    }

    return {
      status: 'FAILED',
      runId,
      datasetVersionId,
      published: false,
      counters,
      // Reported when it was reached. Returning null said "never checked",
      // which hid the fact that the full run reconciled exactly and then died
      // on a later stage.
      reconciliation,
      quality: null,
      qualityGate: null,
      scoreDistributions: [],
      warningCounts,
      classificationCounts,
      fatalError: message,
      fatalClassification: classification,
      durationMs: Date.now() - startedAt,
      stageTimings: timer.report(),
    };
  }
}

/** One location's activity, as the scoring functions want it. */
export interface ScoringInputRow {
  location_id: string;
  monthly_counts: { periodStart: string; count: number }[];
  hour_counts: Record<string, number>;
  day_counts: Record<string, number>;
  data_confidence: string;
  has_geometry: boolean;
}

/** A failure we recognised and classified, rather than an unexpected throw. */
export class IngestionFailure extends Error {
  constructor(
    message: string,
    readonly classification: string,
  ) {
    super(message);
    this.name = 'IngestionFailure';
  }
}

function classifyFailure(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string') {
    if (['NOT_CONFIGURED', 'TRANSPORT_ERROR', 'BAD_STATUS', 'MALFORMED_PAYLOAD'].includes(code)) {
      return `SOURCE_${code}`;
    }
    if (['PAGINATION_NOT_HONOURED', 'PAGE_BUDGET_EXHAUSTED'].includes(code)) return `SOURCE_${code}`;
    // A Postgres SQLSTATE.
    if (/^[0-9A-Z]{5}$/.test(code)) return `DATABASE_${code}`;
  }
  return 'UNEXPECTED';
}

async function withClient<T>(pool: Pool, fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Fallback for an adapter with no streaming support: one page, everything. */
async function* singlePage(
  adapter: IngestionAdapter,
  options: Omit<AggregateIngestionOptions, 'databaseUrl'>,
) {
  const result = await adapter.fetch({ since: options.since, limit: options.limit });
  yield {
    rows: result.rows,
    pageIndex: 0,
    retrievedAt: result.retrievedAt,
    schemaFingerprint: result.schemaFingerprint ?? null,
  };
}

/**
 * Scores the version being built, from its own rows.
 *
 * Each period is scored over its own window, so a 30-day ranking is genuinely
 * the trailing 30 days rather than the same numbers under three labels.
 */
async function scoreVersion(
  pool: Pool,
  authorityId: string,
  authoritySlug: string,
  datasetVersionId: string,
  timer: StageTimer,
): Promise<ScoreDistribution[]> {
  const distributions: ScoreDistribution[] = [];
  const asOf = new Date().toISOString().slice(0, 10);

  for (const periodKey of ['30D', '90D', '12M'] as const) {
    const fromDate = periodStartFor(periodKey, asOf);
    // Timed per period: the 12-month window reads far more rows than the other
    // two, and it was the one that timed out. A single "SCORING" number would
    // have averaged that away.
    const rows = await timer.time(
      `SCORING_${periodKey}` as const,
      () => loadScoringInputsForVersion(pool, authoritySlug, fromDate, datasetVersionId),
      (r) => r.length,
    );
    const results = computeTicketActivityScores(toScoringInputs(rows), { asOf });
    await persistScores(pool, authorityId, periodKey, asOf, toScoreRows(results));
    distributions.push({
      periodKey,
      scored: results.filter((r) => r.scored).length,
      refused: results.filter((r) => !r.scored).length,
    });
  }
  return distributions;
}

/** Scoring inputs for a specific version, including one not yet published. */
async function loadScoringInputsForVersion(
  pool: Pool,
  authoritySlug: string,
  fromDate: string,
  datasetVersionId: string,
): Promise<ScoringInputRow[]> {
  const { rows } = await pool.query<ScoringInputRow>(
    'select * from pcnwatch_scoring_inputs($1, $2::date, $3::uuid)',
    [authoritySlug, fromDate, datasetVersionId],
  );
  return rows;
}

function toScoringInputs(rows: readonly ScoringInputRow[]) {
  return rows.map((row) => ({
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
}

function indexed(source: unknown, length: number): number[] {
  const out = new Array<number>(length).fill(0);
  if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && index < length) out[index] = Number(value);
    }
  }
  return out;
}

function toScoreRows(results: ReturnType<typeof computeTicketActivityScores>) {
  return results.map((r) =>
    r.scored
      ? {
          locationId: r.locationId,
          score: r.score,
          classification: r.classification,
          refusalReason: null,
          components: r.components,
          rawScore: r.rawScore,
          totalPcns: r.totalPcns,
          dataConfidence: r.dataConfidence,
          modelVersion: MODEL_VERSION,
        }
      : {
          locationId: r.locationId,
          score: null,
          classification: null,
          refusalReason: r.reason,
          components: null,
          rawScore: null,
          totalPcns: 0,
          dataConfidence: 0,
          modelVersion: MODEL_VERSION,
        },
  );
}

/**
 * The first day inside a period window.
 *
 * Exact days, not month boundaries: the daily model can answer "the trailing 30
 * days" precisely, and rounding to the start of a month would make a 30-day
 * figure cover up to 60.
 */
export function periodStartFor(periodKey: '30D' | '90D' | '12M', asOf: string): string {
  const days = periodKey === '30D' ? 30 : periodKey === '90D' ? 90 : 365;
  const date = new Date(`${asOf}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (days - 1));
  return date.toISOString().slice(0, 10);
}
