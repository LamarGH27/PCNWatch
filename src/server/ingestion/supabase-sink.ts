import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { AppError, logError, logInfo } from '@/lib/errors';
import type {
  IngestionAdapter,
  IngestionError,
  NormalisedPcnEvent,
} from '@/data-sources/shared/types';
import type { IngestionSink, RunResult, UpsertOutcome } from '@/data-sources/shared/pipeline';
import { runIngestion, type RunOptions } from '@/data-sources/shared/pipeline';
import { slugify } from '@/data-sources/shared/normalise';

/**
 * Persists ingestion output to Supabase.
 *
 * Everything is upserted rather than inserted, so re-running an ingestion is safe
 * and produces `unchanged` rather than duplicates. The `row_hash` is what
 * distinguishes a genuinely changed record from one that simply appeared again.
 */

type SupabaseClient = NonNullable<ReturnType<typeof createSupabaseServiceClient>>;

export interface IngestionContext {
  readonly supabase: SupabaseClient;
  readonly sourceId: string;
  readonly authorityId: string;
  readonly ingestionRunId: string;
  readonly sourceVersionId: string | null;
  readonly retrievedAt: string;
}

export function createSupabaseSink(context: IngestionContext): IngestionSink {
  // Locations are resolved once per slug per run rather than per event.
  const locationCache = new Map<string, string>();

  return {
    async upsertEvents(events: readonly NormalisedPcnEvent[]): Promise<UpsertOutcome> {
      if (events.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };

      await ensureLocations(context, events, locationCache);

      const rows = events.map((event) => ({
        authority_id: context.authorityId,
        parking_location_id: locationCache.get(event.locationSlug) ?? null,
        contravention_code: event.contraventionCode,
        enforcement_type: event.enforcementType,
        issued_at: event.issuedAt,
        issued_date: event.issuedDate,
        issued_hour: event.issuedHour,
        issued_day_of_week: event.issuedDayOfWeek,
        geom:
          event.longitude !== null && event.latitude !== null
            ? `SRID=4326;POINT(${event.longitude} ${event.latitude})`
            : null,
        source_id: context.sourceId,
        source_version_id: context.sourceVersionId,
        source_record_id: event.sourceRecordId,
        ingestion_run_id: context.ingestionRunId,
        retrieved_at: context.retrievedAt,
        data_confidence: event.dataConfidence,
        source_metadata: event.sourceMetadata,
        row_hash: event.rowHash,
      }));

      // Which of these already exist, and with what hash? Determines the split
      // between inserted / updated / unchanged in the report.
      const { data: existing, error: existingError } = await context.supabase
        .from('pcn_events')
        .select('source_record_id, row_hash')
        .eq('source_id', context.sourceId)
        .in(
          'source_record_id',
          events.map((e) => e.sourceRecordId),
        );
      if (existingError) throw existingError;

      const existingHashes = new Map(
        (existing ?? []).map((r) => [String(r.source_record_id), String(r.row_hash)]),
      );

      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      for (const event of events) {
        const previous = existingHashes.get(event.sourceRecordId);
        if (previous === undefined) inserted += 1;
        else if (previous === event.rowHash) unchanged += 1;
        else updated += 1;
      }

      const { error } = await context.supabase
        .from('pcn_events')
        .upsert(rows, { onConflict: 'source_id,source_record_id' });
      if (error) throw error;

      return { inserted, updated, unchanged };
    },

    async recordErrors(errors: readonly IngestionError[]): Promise<void> {
      if (errors.length === 0) return;
      const { error } = await context.supabase.from('ingestion_errors').insert(
        errors.map((e) => ({
          ingestion_run_id: context.ingestionRunId,
          source_record_id: e.sourceRecordId,
          row_number: e.rowNumber,
          error_code: e.errorCode,
          error_message: e.errorMessage,
          raw_excerpt: e.rawExcerpt,
        })),
      );
      // A failure to record errors must not hide the errors themselves.
      if (error) logError('ingestion.recordErrors', error, { count: errors.length });
    },
  };
}

/**
 * Creates any parking_locations the batch refers to.
 *
 * A location's confidence is the best confidence of any event there — a street
 * with one well-specified record is placeable even if other records for it are not.
 */
async function ensureLocations(
  context: IngestionContext,
  events: readonly NormalisedPcnEvent[],
  cache: Map<string, string>,
): Promise<void> {
  const bySlug = new Map<string, NormalisedPcnEvent>();
  for (const event of events) {
    const existing = bySlug.get(event.locationSlug);
    // Prefer the event that can actually place the location on a map.
    if (
      !existing ||
      (event.longitude !== null && existing.longitude === null) ||
      event.dataConfidence > existing.dataConfidence
    ) {
      bySlug.set(event.locationSlug, event);
    }
  }

  const needed = [...bySlug.keys()].filter((slug) => !cache.has(slug));
  if (needed.length === 0) return;

  const rows = needed.map((slug) => {
    const event = bySlug.get(slug) as NormalisedPcnEvent;
    return {
      authority_id: context.authorityId,
      slug: slugify(slug),
      display_name: event.streetName,
      street_name: event.streetName,
      street_name_normalised: event.streetNameNormalised,
      locality: event.locality,
      postcode_district: event.postcodeDistrict,
      geom:
        event.longitude !== null && event.latitude !== null
          ? `SRID=4326;POINT(${event.longitude} ${event.latitude})`
          : null,
      source_id: context.sourceId,
      source_record_id: event.sourceRecordId,
      retrieved_at: context.retrievedAt,
      data_confidence: event.dataConfidence,
      source_metadata: {},
    };
  });

  const { data, error } = await context.supabase
    .from('parking_locations')
    .upsert(rows, { onConflict: 'authority_id,slug' })
    .select('id, slug');
  if (error) throw error;

  for (const row of data ?? []) cache.set(String(row.slug), String(row.id));
}

/* ------------------------------------------------------------------ */
/* Run orchestration                                                   */
/* ------------------------------------------------------------------ */

export interface IngestionJobResult extends RunResult {
  readonly ingestionRunId: string;
}

/**
 * Runs an adapter end to end and records the run.
 *
 * A run row is created BEFORE any work, so a crash mid-ingestion leaves a
 * RUNNING row rather than no evidence that anything was attempted. The
 * data-health page surfaces stuck runs for exactly this reason.
 */
export async function runIngestionJob(
  adapter: IngestionAdapter,
  authoritySlug: string,
  options: RunOptions & { triggerSource?: string } = {},
): Promise<IngestionJobResult> {
  const supabase = createSupabaseServiceClient();
  if (!supabase) {
    throw new AppError(
      'SUPABASE_NOT_CONFIGURED',
      'The datastore is not configured, so ingestion cannot run.',
      'Set the Supabase environment variables and try again.',
    );
  }

  const sourceId = await upsertSource(supabase, adapter);
  const authorityId = await requireAuthority(supabase, authoritySlug);

  const { data: run, error: runError } = await supabase
    .from('ingestion_runs')
    .insert({
      source_id: sourceId,
      status: 'RUNNING',
      trigger_source: options.triggerSource ?? 'manual',
      report: { authorityId },
    })
    .select('id')
    .single();
  if (runError) throw runError;
  const ingestionRunId = String(run.id);

  try {
    let context: IngestionContext = {
      supabase,
      sourceId,
      authorityId,
      ingestionRunId,
      sourceVersionId: null,
      retrievedAt: new Date().toISOString(),
    };

    // The sink closes over `context`, so the version id is filled in before use
    // by re-creating the sink once the fetch reports the version.
    let sink = createSupabaseSink(context);

    const result = await runIngestion(
      {
        descriptor: adapter.descriptor,
        normalise: adapter.normalise.bind(adapter),
        async fetch(fetchOptions) {
          const fetched = await adapter.fetch(fetchOptions);
          const sourceVersionId = await upsertSourceVersion(supabase, sourceId, fetched);
          context = { ...context, sourceVersionId, retrievedAt: fetched.retrievedAt };
          sink = createSupabaseSink(context);
          return fetched;
        },
      },
      {
        upsertEvents: (events) => sink.upsertEvents(events),
        recordErrors: (errors) => sink.recordErrors(errors),
      },
      options,
    );

    await supabase
      .from('ingestion_runs')
      .update({
        status: result.status,
        finished_at: new Date().toISOString(),
        source_version_id: context.sourceVersionId,
        fetched: result.report.fetched,
        accepted: result.report.accepted,
        rejected: result.report.rejected,
        inserted: result.report.inserted,
        updated: result.report.updated,
        unchanged: result.report.unchanged,
        geolocated: result.report.geolocated,
        not_geolocated: result.report.notGeolocated,
        error_count: result.report.errors,
        report: {
          authorityId,
          message: result.message,
          warningCounts: result.warningCounts,
          contentHash: result.contentHash,
        },
      })
      .eq('id', ingestionRunId);

    if (result.status !== 'FAILED') {
      await supabase.rpc('pcnwatch_rebuild_aggregates', { p_authority_id: authorityId });
      logInfo('ingestion', 'Aggregates rebuilt', { authoritySlug });
    }

    return { ...result, ingestionRunId };
  } catch (error) {
    await supabase
      .from('ingestion_runs')
      .update({
        status: 'FAILED',
        finished_at: new Date().toISOString(),
        report: {
          authorityId,
          message: error instanceof Error ? error.message : String(error),
        },
      })
      .eq('id', ingestionRunId);
    throw error;
  }
}

async function upsertSource(supabase: SupabaseClient, adapter: IngestionAdapter): Promise<string> {
  const d = adapter.descriptor;
  const { data, error } = await supabase
    .from('data_sources')
    .upsert(
      {
        slug: d.slug,
        name: d.name,
        publisher: d.publisher,
        licence: d.licence,
        licence_url: d.licenceUrl,
        source_url: d.sourceUrl,
        attribution_text: d.attributionText,
        coverage_notes: d.coverageNotes,
      },
      { onConflict: 'slug' },
    )
    .select('id')
    .single();
  if (error) throw error;
  return String(data.id);
}

async function upsertSourceVersion(
  supabase: SupabaseClient,
  sourceId: string,
  fetched: { versionLabel: string; contentHash: string; retrievedAt: string; rows: readonly unknown[]; sourceEffectiveDate: string | null },
): Promise<string> {
  const { data, error } = await supabase
    .from('source_versions')
    .upsert(
      {
        source_id: sourceId,
        version_label: fetched.versionLabel,
        content_hash: fetched.contentHash,
        source_effective_date: fetched.sourceEffectiveDate,
        retrieved_at: fetched.retrievedAt,
        record_count: fetched.rows.length,
      },
      { onConflict: 'source_id,version_label' },
    )
    .select('id')
    .single();
  if (error) throw error;
  return String(data.id);
}

async function requireAuthority(supabase: SupabaseClient, slug: string): Promise<string> {
  const { data, error } = await supabase
    .from('authorities')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new AppError(
      'AUTHORITY_NOT_SEEDED',
      `The authority "${slug}" does not exist in the database.`,
      'Seed the authority directory before running ingestion.',
    );
  }
  return String(data.id);
}
