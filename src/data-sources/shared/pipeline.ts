import { emptyReport, type IngestionAdapter, type IngestionError, type IngestionReport, type NormalisedPcnEvent } from './types';

/**
 * Source-agnostic ingestion pipeline.
 *
 * Responsibilities: drive the adapter over every fetched row, collect the report
 * counters, deduplicate within the batch, and hand the accepted events to a sink.
 * The sink is injected so this logic is testable without a database and so the
 * same pipeline serves any future authority.
 */

export interface UpsertOutcome {
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
}

export interface IngestionSink {
  /** Persists a batch of normalised events, returning what actually changed. */
  upsertEvents(events: readonly NormalisedPcnEvent[]): Promise<UpsertOutcome>;
  /** Records rejected rows. Called even when the run otherwise succeeds. */
  recordErrors(errors: readonly IngestionError[]): Promise<void>;
}

export interface RunOptions {
  readonly since?: string;
  readonly limit?: number;
  /** Rows per upsert batch. */
  readonly batchSize?: number;
  /**
   * Proportion of rejected rows above which the run is reported as FAILED rather
   * than PARTIAL. A source that has changed shape should not quietly half-ingest.
   */
  readonly maxRejectionRate?: number;
}

export interface RunResult {
  readonly status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  readonly report: IngestionReport;
  readonly errors: readonly IngestionError[];
  readonly versionLabel: string;
  readonly contentHash: string;
  readonly retrievedAt: string;
  readonly warningCounts: Readonly<Record<string, number>>;
  readonly message: string;
}

export const DEFAULT_MAX_REJECTION_RATE = 0.2;

export async function runIngestion(
  adapter: IngestionAdapter,
  sink: IngestionSink,
  options: RunOptions = {},
): Promise<RunResult> {
  const report = emptyReport();
  const errors: IngestionError[] = [];
  const warningCounts: Record<string, number> = {};
  const batchSize = options.batchSize ?? 500;
  const maxRejectionRate = options.maxRejectionRate ?? DEFAULT_MAX_REJECTION_RATE;

  const fetched = await adapter.fetch({ since: options.since, limit: options.limit });
  report.fetched = fetched.rows.length;

  // Deduplicate within the batch. A source that repeats a record id in one payload
  // must not double-count it; the last occurrence wins, and the collision is
  // recorded so it is visible rather than silent.
  const bySourceRecordId = new Map<string, NormalisedPcnEvent>();

  fetched.rows.forEach((row, index) => {
    const result = adapter.normalise(row, index);
    if (!result.ok) {
      report.rejected += 1;
      report.errors += 1;
      errors.push(result.error);
      return;
    }

    for (const warning of result.warnings) {
      warningCounts[warning] = (warningCounts[warning] ?? 0) + 1;
    }

    const { event } = result;
    const existing = bySourceRecordId.get(event.sourceRecordId);
    if (existing) {
      errors.push({
        rowNumber: index,
        sourceRecordId: event.sourceRecordId,
        errorCode: 'DUPLICATE_IN_BATCH',
        errorMessage:
          existing.rowHash === event.rowHash
            ? 'The same source record appeared more than once in this payload with identical content.'
            : 'The same source record appeared more than once in this payload with different content; the later row was kept.',
        rawExcerpt: null,
      });
      report.errors += 1;
    }

    bySourceRecordId.set(event.sourceRecordId, event);
    if (event.longitude !== null && event.latitude !== null) report.geolocated += 1;
    else report.notGeolocated += 1;
  });

  const accepted = [...bySourceRecordId.values()];
  report.accepted = accepted.length;

  // Rejections are persisted before the upsert, so a later failure still leaves a
  // record of what the source sent.
  if (errors.length > 0) await sink.recordErrors(errors);

  const rejectionRate = report.fetched === 0 ? 0 : report.rejected / report.fetched;
  if (rejectionRate > maxRejectionRate) {
    return {
      status: 'FAILED',
      report,
      errors,
      versionLabel: fetched.versionLabel,
      contentHash: fetched.contentHash,
      retrievedAt: fetched.retrievedAt,
      warningCounts,
      message:
        `${report.rejected} of ${report.fetched} rows were rejected (${(rejectionRate * 100).toFixed(1)}%), ` +
        `above the ${(maxRejectionRate * 100).toFixed(0)}% threshold. No data was written; the source has probably changed shape.`,
    };
  }

  for (let i = 0; i < accepted.length; i += batchSize) {
    const outcome = await sink.upsertEvents(accepted.slice(i, i + batchSize));
    report.inserted += outcome.inserted;
    report.updated += outcome.updated;
    report.unchanged += outcome.unchanged;
  }

  const status = report.rejected > 0 ? 'PARTIAL' : 'SUCCEEDED';
  return {
    status,
    report,
    errors,
    versionLabel: fetched.versionLabel,
    contentHash: fetched.contentHash,
    retrievedAt: fetched.retrievedAt,
    warningCounts,
    message:
      status === 'SUCCEEDED'
        ? `Ingested ${report.accepted} records (${report.inserted} new, ${report.updated} updated, ${report.unchanged} unchanged).`
        : `Ingested ${report.accepted} records with ${report.rejected} rejected. Rejections are recorded against this run.`,
  };
}
