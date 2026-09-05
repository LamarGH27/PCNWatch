import { Pool, type PoolClient } from 'pg';
import type { SourceDescriptor } from '@/data-sources/shared/types';

/**
 * Direct PostgreSQL ingestion store: sources, runs and scores.
 *
 * Ingestion is a batch job that needs no RLS and benefits from real
 * transactions and multi-row statements, so it goes straight to Postgres rather
 * than through the REST endpoint. That also means the pipeline runs against any
 * PostGIS database — a local one for proving it, or the connection string a
 * hosted Supabase project exposes.
 *
 * What used to live here as well was a sink that wrote one `pcn_events` row per
 * notice, and a rebuild that read them all back to derive aggregates. Both are
 * gone: `aggregate-run.ts` counts notices as they stream past and stores the
 * counts. `pcn_events` remains in the schema but production writes nothing to
 * it — see `0011_activity_daily.sql`.
 */

export interface PostgresStoreOptions {
  readonly connectionString: string;
  /** Statement timeout per query, in milliseconds. */
  readonly statementTimeoutMs?: number;
}

export function createPool(options: PostgresStoreOptions): Pool {
  return new Pool({
    connectionString: options.connectionString,
    max: 4,
    statement_timeout: options.statementTimeoutMs ?? 120_000,
    // Hosted Postgres (including Supabase) terminates unencrypted connections.
    // A local socket or localhost connection has no TLS and must not demand it.
    ssl: /^postgres(ql)?:\/\/[^/]*(localhost|127\.0\.0\.1)/.test(options.connectionString)
      ? undefined
      : { rejectUnauthorized: false },
  });
}

/* ------------------------------------------------------------------ */
/* Reference rows                                                      */
/* ------------------------------------------------------------------ */

export async function upsertSource(client: PoolClient, d: SourceDescriptor): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into data_sources
       (slug, name, publisher, licence, licence_url, source_url, attribution_text, coverage_notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (slug) do update set
       name = excluded.name,
       publisher = excluded.publisher,
       licence = excluded.licence,
       licence_url = excluded.licence_url,
       source_url = excluded.source_url,
       attribution_text = excluded.attribution_text,
       coverage_notes = excluded.coverage_notes
     returning id`,
    [d.slug, d.name, d.publisher, d.licence, d.licenceUrl, d.sourceUrl, d.attributionText, d.coverageNotes],
  );
  return rows[0]!.id;
}

export async function upsertSourceVersion(
  client: PoolClient,
  sourceId: string,
  version: {
    versionLabel: string;
    contentHash: string;
    retrievedAt: string;
    recordCount: number;
    sourceEffectiveDate: string | null;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into source_versions
       (source_id, version_label, content_hash, source_effective_date, retrieved_at, record_count)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (source_id, version_label) do update set
       content_hash = excluded.content_hash,
       retrieved_at = excluded.retrieved_at,
       record_count = excluded.record_count
     returning id`,
    [
      sourceId,
      version.versionLabel,
      version.contentHash,
      version.sourceEffectiveDate,
      version.retrievedAt,
      version.recordCount,
    ],
  );
  return rows[0]!.id;
}

export async function requireAuthorityId(client: PoolClient, slug: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    'select id from authorities where slug = $1',
    [slug],
  );
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(
      `The authority "${slug}" is not in the database. Apply supabase/seed/001_reference.sql first.`,
    );
  }
  return id;
}

/* ------------------------------------------------------------------ */
/* Ingestion run lifecycle                                             */
/* ------------------------------------------------------------------ */

export async function startRun(
  client: PoolClient,
  sourceId: string,
  authorityId: string,
  triggerSource: string,
  isDemo: boolean,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into ingestion_runs (source_id, status, trigger_source, report)
     values ($1, 'RUNNING', $2, $3::jsonb)
     returning id`,
    [sourceId, triggerSource, JSON.stringify({ authorityId, demo: isDemo })],
  );
  return rows[0]!.id;
}

export interface RunCompletion {
  readonly status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  readonly sourceVersionId: string | null;
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
  };
  readonly report: Record<string, unknown>;
}

export async function finishRun(
  client: PoolClient,
  runId: string,
  completion: RunCompletion,
): Promise<void> {
  const c = completion.counters;
  await client.query(
    `update ingestion_runs set
       status = $2,
       finished_at = now(),
       source_version_id = $3,
       fetched = $4, accepted = $5, rejected = $6,
       inserted = $7, updated = $8, unchanged = $9,
       geolocated = $10, not_geolocated = $11, error_count = $12,
       report = $13::jsonb
     where id = $1`,
    [
      runId,
      completion.status,
      completion.sourceVersionId,
      c.fetched, c.accepted, c.rejected,
      c.inserted, c.updated, c.unchanged,
      c.geolocated, c.notGeolocated, c.errors,
      JSON.stringify(completion.report),
    ],
  );
}

export interface ScoreRow {
  locationId: string;
  score: number | null;
  classification: string | null;
  refusalReason: string | null;
  components: unknown;
  rawScore: number | null;
  totalPcns: number;
  dataConfidence: number;
  modelVersion: string;
}

export async function persistScores(
  pool: Pool,
  authorityId: string,
  periodKey: string,
  asOf: string,
  scores: readonly ScoreRow[],
): Promise<void> {
  if (scores.length === 0) return;
  await pool.query(
    `insert into pcn_activity_scores (
       authority_id, parking_location_id, period_key, as_of_date,
       score, classification, refusal_reason, components,
       raw_score, total_pcns, data_confidence, model_version
     )
     select
       $1::uuid, loc::uuid, $2, $3::date,
       nullif(score, '')::smallint,
       nullif(classification, '')::score_classification,
       nullif(refusal, ''),
       components::jsonb,
       nullif(raw, '')::numeric,
       total::integer,
       conf::numeric,
       $4
     from unnest($5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[])
       as t(loc, score, classification, refusal, components, raw, total, conf)
     on conflict (parking_location_id, road_segment_id, period_key, as_of_date) do update set
       score = excluded.score,
       classification = excluded.classification,
       refusal_reason = excluded.refusal_reason,
       components = excluded.components,
       raw_score = excluded.raw_score,
       total_pcns = excluded.total_pcns,
       data_confidence = excluded.data_confidence,
       model_version = excluded.model_version,
       computed_at = now()`,
    [
      authorityId,
      periodKey,
      asOf,
      scores[0]!.modelVersion,
      scores.map((s) => s.locationId),
      scores.map((s) => (s.score === null ? '' : String(s.score))),
      scores.map((s) => s.classification ?? ''),
      scores.map((s) => s.refusalReason ?? ''),
      scores.map((s) => JSON.stringify(s.components)),
      scores.map((s) => (s.rawScore === null ? '' : String(s.rawScore))),
      scores.map((s) => String(s.totalPcns)),
      scores.map((s) => String(s.dataConfidence)),
    ],
  );
}
