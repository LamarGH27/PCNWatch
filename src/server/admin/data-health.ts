import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { integrationStatuses, type IntegrationStatus } from '@/lib/env';
import { logError } from '@/lib/errors';

/**
 * Operational health.
 *
 * Answers the questions an operator actually needs: is each source fresh, did the
 * last run succeed, how many rows were rejected and why, is any run stuck, and is
 * the AI layer rejecting model output.
 */

export interface SourceHealth {
  readonly sourceSlug: string;
  readonly sourceName: string;
  readonly lastRunAt: string | null;
  readonly lastRunStatus: string | null;
  readonly lastSuccessfulRunAt: string | null;
  readonly rowsInserted: number;
  readonly rowsUpdated: number;
  readonly rowsRejected: number;
  readonly notGeolocated: number;
  readonly freshnessHours: number | null;
  readonly stale: boolean;
  readonly topErrorCodes: readonly { code: string; count: number }[];
}

export interface AiHealth {
  readonly totalCalls: number;
  readonly accepted: number;
  readonly schemaRejected: number;
  readonly citationRejected: number;
  readonly errors: number;
}

export interface DataHealth {
  readonly integrations: readonly IntegrationStatus[];
  readonly sources: readonly SourceHealth[];
  readonly stuckRuns: readonly { id: string; sourceSlug: string; startedAt: string }[];
  readonly ai: AiHealth | null;
  readonly datastoreAvailable: boolean;
}

/** A source with no successful run in this many hours is stale. */
export const STALENESS_THRESHOLD_HOURS = 48;
/** A RUNNING row older than this almost certainly means a crashed job. */
export const STUCK_RUN_THRESHOLD_MINUTES = 60;

interface RunRow {
  id: string;
  source_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  inserted: number | null;
  updated: number | null;
  rejected: number | null;
  not_geolocated: number | null;
}

interface SourceRow {
  id: string;
  slug: string;
  name: string;
}

/**
 * Pure summarisation, separated from the queries so it can be tested directly.
 */
export function summariseHealth(
  sources: readonly SourceRow[],
  runs: readonly RunRow[],
  errors: readonly { ingestion_run_id: string; error_code: string }[],
  aiRows: readonly { validation_result: string }[],
  nowMs: number,
): Omit<DataHealth, 'integrations' | 'datastoreAvailable'> {
  const runsBySource = new Map<string, RunRow[]>();
  for (const run of runs) {
    const list = runsBySource.get(run.source_id) ?? [];
    list.push(run);
    runsBySource.set(run.source_id, list);
  }

  const errorsByRun = new Map<string, Map<string, number>>();
  for (const error of errors) {
    const counts = errorsByRun.get(error.ingestion_run_id) ?? new Map<string, number>();
    counts.set(error.error_code, (counts.get(error.error_code) ?? 0) + 1);
    errorsByRun.set(error.ingestion_run_id, counts);
  }

  const sourceHealth: SourceHealth[] = sources.map((source) => {
    const sourceRuns = (runsBySource.get(source.id) ?? []).slice().sort((a, b) =>
      b.started_at.localeCompare(a.started_at),
    );
    const lastRun = sourceRuns[0] ?? null;
    const lastSuccess = sourceRuns.find((r) => r.status === 'SUCCEEDED' || r.status === 'PARTIAL');
    const lastSuccessAt = lastSuccess?.finished_at ?? null;
    const freshnessHours = lastSuccessAt
      ? (nowMs - new Date(lastSuccessAt).getTime()) / 3_600_000
      : null;
    const errorCounts = lastRun ? (errorsByRun.get(lastRun.id) ?? new Map()) : new Map();

    return {
      sourceSlug: source.slug,
      sourceName: source.name,
      lastRunAt: lastRun?.started_at ?? null,
      lastRunStatus: lastRun?.status ?? null,
      lastSuccessfulRunAt: lastSuccessAt,
      rowsInserted: Number(lastRun?.inserted ?? 0),
      rowsUpdated: Number(lastRun?.updated ?? 0),
      rowsRejected: Number(lastRun?.rejected ?? 0),
      notGeolocated: Number(lastRun?.not_geolocated ?? 0),
      freshnessHours,
      // No successful run at all is stale by definition, never "fine".
      stale: freshnessHours === null || freshnessHours > STALENESS_THRESHOLD_HOURS,
      topErrorCodes: [...errorCounts.entries()]
        .map(([code, count]) => ({ code: String(code), count: Number(count) }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
        .slice(0, 5),
    };
  });

  const stuckThreshold = nowMs - STUCK_RUN_THRESHOLD_MINUTES * 60_000;
  const stuckRuns = runs
    .filter((r) => r.status === 'RUNNING' && new Date(r.started_at).getTime() < stuckThreshold)
    .map((r) => ({
      id: r.id,
      sourceSlug: sources.find((s) => s.id === r.source_id)?.slug ?? r.source_id,
      startedAt: r.started_at,
    }));

  const ai: AiHealth = {
    totalCalls: aiRows.length,
    accepted: aiRows.filter((r) => r.validation_result === 'ACCEPTED').length,
    schemaRejected: aiRows.filter((r) => r.validation_result === 'SCHEMA_REJECTED').length,
    citationRejected: aiRows.filter((r) => r.validation_result === 'CITATION_REJECTED').length,
    errors: aiRows.filter((r) => r.validation_result === 'ERROR').length,
  };

  return { sources: sourceHealth, stuckRuns, ai };
}

export async function getDataHealth(): Promise<DataHealth> {
  const integrations = integrationStatuses();

  let supabase: ReturnType<typeof createSupabaseServiceClient> = null;
  try {
    supabase = createSupabaseServiceClient();
  } catch (error) {
    logError('admin.getDataHealth.client', error);
  }

  if (!supabase) {
    return { integrations, sources: [], stuckRuns: [], ai: null, datastoreAvailable: false };
  }

  try {
    const [sourcesResult, runsResult, errorsResult, aiResult] = await Promise.all([
      supabase.from('data_sources').select('id, slug, name'),
      supabase
        .from('ingestion_runs')
        .select(
          'id, source_id, status, started_at, finished_at, inserted, updated, rejected, not_geolocated',
        )
        .order('started_at', { ascending: false })
        .limit(200),
      supabase.from('ingestion_errors').select('ingestion_run_id, error_code').limit(2000),
      supabase.from('ai_logs').select('validation_result').limit(2000),
    ]);

    if (sourcesResult.error) throw sourcesResult.error;

    const summary = summariseHealth(
      (sourcesResult.data ?? []) as SourceRow[],
      (runsResult.data ?? []) as RunRow[],
      (errorsResult.data ?? []) as { ingestion_run_id: string; error_code: string }[],
      (aiResult.data ?? []) as { validation_result: string }[],
      Date.now(),
    );

    return { integrations, ...summary, datastoreAvailable: true };
  } catch (error) {
    logError('admin.getDataHealth', error);
    return { integrations, sources: [], stuckRuns: [], ai: null, datastoreAvailable: false };
  }
}
