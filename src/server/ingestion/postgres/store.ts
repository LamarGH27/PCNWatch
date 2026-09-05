import { Pool, type PoolClient } from 'pg';
import type { IngestionError, NormalisedPcnEvent, SourceDescriptor } from '@/data-sources/shared/types';
import type { IngestionSink, UpsertOutcome } from '@/data-sources/shared/pipeline';
import { slugify } from '@/data-sources/shared/normalise';

/**
 * Direct PostgreSQL ingestion store.
 *
 * Why this exists alongside the Supabase sink: ingestion is a batch job that
 * needs no RLS and benefits from real transactions and multi-row statements.
 * Going straight to Postgres also means the pipeline can be run against any
 * PostGIS database — a local one for proving the pipeline, or the connection
 * string a hosted Supabase project exposes — rather than requiring a configured
 * Supabase REST endpoint before a single row can be ingested.
 *
 * The Supabase sink is left untouched and still works; this is an additional
 * path, not a replacement.
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

/** Marks a run FAILED without touching any previously ingested data. */
export async function failRun(pool: Pool, runId: string, message: string, authorityId: string, isDemo: boolean): Promise<void> {
  await pool.query(
    `update ingestion_runs set status = 'FAILED', finished_at = now(), report = $2::jsonb where id = $1`,
    [runId, JSON.stringify({ authorityId, demo: isDemo, message })],
  );
}

/* ------------------------------------------------------------------ */
/* The sink                                                            */
/* ------------------------------------------------------------------ */

export interface PostgresSinkContext {
  readonly client: PoolClient;
  readonly sourceId: string;
  readonly authorityId: string;
  readonly runId: string;
  readonly sourceVersionId: string | null;
  readonly retrievedAt: string;
}

export function createPostgresSink(context: PostgresSinkContext): IngestionSink {
  const locationIds = new Map<string, string>();

  return {
    async upsertEvents(events: readonly NormalisedPcnEvent[]): Promise<UpsertOutcome> {
      if (events.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };

      await ensureLocations(context, events, locationIds);

      // Classify before writing, by comparing row hashes with what is stored.
      const { rows: existing } = await context.client.query<{
        source_record_id: string;
        row_hash: string;
      }>(
        `select source_record_id, row_hash from pcn_events
         where source_id = $1 and source_record_id = any($2::text[])`,
        [context.sourceId, events.map((e) => e.sourceRecordId)],
      );
      const previousHash = new Map(existing.map((r) => [r.source_record_id, r.row_hash]));

      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      for (const event of events) {
        const before = previousHash.get(event.sourceRecordId);
        if (before === undefined) inserted += 1;
        else if (before === event.rowHash) unchanged += 1;
        else updated += 1;
      }

      // One statement for the whole batch. `unnest` keeps the parameter count
      // constant regardless of batch size, which matters at Camden's row counts.
      await context.client.query(
        `insert into pcn_events (
           authority_id, parking_location_id, contravention_code, enforcement_type,
           issued_at, issued_date, issued_hour, issued_day_of_week, geom,
           source_id, source_version_id, source_record_id, ingestion_run_id,
           retrieved_at, data_confidence, source_metadata, row_hash
         )
         select
           $1::uuid,
           nullif(loc, '')::uuid,
           nullif(code, ''),
           etype::enforcement_type,
           nullif(issued_at, '')::timestamptz,
           issued_date::date,
           nullif(hour, '')::smallint,
           nullif(dow, '')::smallint,
           case when lon = '' then null
                else st_setsrid(st_point(lon::double precision, lat::double precision), 4326)::geography
           end,
           $2::uuid, nullif($3, '')::uuid, rec_id, $4::uuid,
           $5::timestamptz, conf::numeric, meta::jsonb, hash
         from unnest(
           $6::text[],  $7::text[],  $8::text[],  $9::text[], $10::text[],
           $11::text[], $12::text[], $13::text[], $14::text[], $15::text[],
           $16::text[], $17::text[], $18::text[]
         ) as t(loc, code, etype, issued_at, issued_date, hour, dow, lon, lat, rec_id, conf, meta, hash)
         on conflict (source_id, source_record_id) do update set
           parking_location_id = excluded.parking_location_id,
           contravention_code = excluded.contravention_code,
           enforcement_type = excluded.enforcement_type,
           issued_at = excluded.issued_at,
           issued_date = excluded.issued_date,
           issued_hour = excluded.issued_hour,
           issued_day_of_week = excluded.issued_day_of_week,
           geom = excluded.geom,
           source_version_id = excluded.source_version_id,
           ingestion_run_id = excluded.ingestion_run_id,
           retrieved_at = excluded.retrieved_at,
           data_confidence = excluded.data_confidence,
           source_metadata = excluded.source_metadata,
           row_hash = excluded.row_hash`,
        [
          context.authorityId,
          context.sourceId,
          context.sourceVersionId ?? '',
          context.runId,
          context.retrievedAt,
          events.map((e) => locationIds.get(e.locationSlug) ?? ''),
          events.map((e) => e.contraventionCode ?? ''),
          events.map((e) => e.enforcementType),
          events.map((e) => e.issuedAt ?? ''),
          events.map((e) => e.issuedDate),
          events.map((e) => (e.issuedHour === null ? '' : String(e.issuedHour))),
          events.map((e) => (e.issuedDayOfWeek === null ? '' : String(e.issuedDayOfWeek))),
          events.map((e) => (e.longitude === null ? '' : String(e.longitude))),
          events.map((e) => (e.latitude === null ? '' : String(e.latitude))),
          events.map((e) => e.sourceRecordId),
          events.map((e) => String(e.dataConfidence)),
          events.map((e) => JSON.stringify(e.sourceMetadata)),
          events.map((e) => e.rowHash),
        ],
      );

      return { inserted, updated, unchanged };
    },

    async recordErrors(errors: readonly IngestionError[]): Promise<void> {
      if (errors.length === 0) return;
      await context.client.query(
        `insert into ingestion_errors
           (ingestion_run_id, source_record_id, row_number, error_code, error_message, raw_excerpt)
         select $1::uuid, nullif(rec, ''), num::integer, code, msg, nullif(excerpt, '')::jsonb
         from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
           as t(rec, num, code, msg, excerpt)`,
        [
          context.runId,
          errors.map((e) => e.sourceRecordId ?? ''),
          errors.map((e) => String(e.rowNumber)),
          errors.map((e) => e.errorCode),
          errors.map((e) => e.errorMessage),
          errors.map((e) => (e.rawExcerpt ? JSON.stringify(e.rawExcerpt) : '')),
        ],
      );
    },
  };
}

/**
 * Creates the parking_locations rows a batch refers to.
 *
 * A location takes its geometry and confidence from the best record seen for it:
 * a street is placeable if *any* of its records can place it, so one vague row
 * does not cost the whole street its position on the map.
 *
 * "Any of its records" means across the whole run, not within one batch. This
 * used to skip a location the moment its id was cached, so whichever batch
 * happened to mention a street first decided permanently whether it had a
 * position. Hatton Garden had 8,774 notices with coordinates and no position on
 * the map, because the first batch that mentioned it happened to contain none of
 * them. Every batch now upserts the locations it refers to; the conflict clause
 * keeps the first position found, so re-ingesting the same data is stable.
 */
/**
 * One representative event per location in a batch: the one best able to place
 * and describe the street.
 *
 * Exported because the rule it encodes is the one that failed in production, and
 * the failure was an omission — a filter that skipped locations already seen —
 * which is invisible in any test that only checks the rows it does return.
 *
 * Note what it deliberately does NOT take: a cache of known location ids. A
 * cached id means we know where the row is, not that the row is right. A later
 * batch may be the first to carry a coordinate for a street, and it must be
 * allowed to say so.
 */
export function chooseLocationRepresentatives(
  events: readonly NormalisedPcnEvent[],
): readonly NormalisedPcnEvent[] {
  const best = new Map<string, NormalisedPcnEvent>();
  for (const event of events) {
    const current = best.get(event.locationSlug);
    const hasPosition = event.longitude !== null;
    const currentHasPosition = current?.longitude != null;
    if (
      !current ||
      (hasPosition && !currentHasPosition) ||
      (hasPosition === currentHasPosition && event.dataConfidence > current.dataConfidence)
    ) {
      best.set(event.locationSlug, event);
    }
  }
  return [...best.values()];
}

async function ensureLocations(
  context: PostgresSinkContext,
  events: readonly NormalisedPcnEvent[],
  cache: Map<string, string>,
): Promise<void> {
  const chosen = chooseLocationRepresentatives(events);
  if (chosen.length === 0) return;

  const { rows } = await context.client.query<{ id: string; slug: string }>(
    `insert into parking_locations (
       authority_id, slug, display_name, street_name, street_name_normalised,
       locality, postcode_district, geom, source_id, source_record_id,
       retrieved_at, data_confidence, source_metadata
     )
     select
       $1::uuid, slug, display_name, street_name, normalised,
       nullif(locality, ''), nullif(postcode, ''),
       case when lon = '' then null
            else st_setsrid(st_point(lon::double precision, lat::double precision), 4326)::geography
       end,
       $2::uuid, rec_id, $3::timestamptz, conf::numeric,
       -- Provenance for the street's position, because it is derived, not
       -- observed. The point comes from ONE notice on this street; every other
       -- notice here is drawn at it. Recording where it came from is what
       -- separates street-level positioning from an invented coordinate.
       case when lon = '' then '{}'::jsonb
            else jsonb_build_object(
              '_geometry', jsonb_build_object(
                'origin', 'SOURCE_PUBLISHED',
                'method', 'REPRESENTATIVE_EVENT',
                'precision', 'STREET',
                'referenceSource', 'pcn_events.geom',
                'referenceRecordId', rec_id,
                'confidence', conf::numeric,
                'lookedUpAt', $3::timestamptz
              ))
       end
     from unnest(
       $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
       $9::text[], $10::text[], $11::text[], $12::text[], $13::text[]
     ) as t(slug, display_name, street_name, normalised, locality, postcode, lon, lat, rec_id, conf)
     on conflict (authority_id, slug) do update set
       display_name = excluded.display_name,
       street_name = excluded.street_name,
       street_name_normalised = excluded.street_name_normalised,
       locality = coalesce(excluded.locality, parking_locations.locality),
       postcode_district = coalesce(excluded.postcode_district, parking_locations.postcode_district),
       -- Keep the first position found. Preferring excluded would never lose a
       -- position either, but it would let the last batch carrying a coordinate
       -- move the street, so the same input could place a street differently
       -- depending on batch order.
       geom = coalesce(parking_locations.geom, excluded.geom),
       source_metadata = case
         when parking_locations.geom is null and excluded.geom is not null
           then excluded.source_metadata
         else parking_locations.source_metadata
       end,
       retrieved_at = excluded.retrieved_at,
       data_confidence = greatest(excluded.data_confidence, parking_locations.data_confidence)
     returning id, slug`,
    [
      context.authorityId,
      context.sourceId,
      context.retrievedAt,
      chosen.map((e) => slugify(e.locationSlug)),
      chosen.map((e) => e.streetName),
      chosen.map((e) => e.streetName),
      chosen.map((e) => e.streetNameNormalised),
      chosen.map((e) => e.locality ?? ''),
      chosen.map((e) => e.postcodeDistrict ?? ''),
      chosen.map((e) => (e.longitude === null ? '' : String(e.longitude))),
      chosen.map((e) => (e.latitude === null ? '' : String(e.latitude))),
      chosen.map((e) => e.sourceRecordId),
      chosen.map((e) => String(e.dataConfidence)),
    ],
  );

  for (const row of rows) cache.set(row.slug, row.id);
}

/* ------------------------------------------------------------------ */
/* Post-ingestion recomputation                                        */
/* ------------------------------------------------------------------ */

/**
 * Records what the authority itself calls each contravention code.
 *
 * Kept strictly apart from `contravention_codes`, which is the reviewed legal
 * reference. This is descriptive labelling of enforcement data: the publisher's
 * own words, verbatim, so a location page can say what a code means where no
 * reviewed record exists — with the authority named as the source.
 *
 * Written inside the same transaction as the events, so the labels can never
 * describe codes that were rolled back.
 */
export async function upsertContraventionLabels(
  client: PoolClient,
  authorityId: string,
  events: readonly NormalisedPcnEvent[],
): Promise<number> {
  const counts = new Map<string, { code: string; description: string; count: number }>();
  for (const event of events) {
    if (!event.contraventionCode) continue;
    const description = event.sourceMetadata['contravention_code_description'];
    if (typeof description !== 'string') continue;
    const trimmed = description.trim();
    if (trimmed === '') continue;
    const key = `${event.contraventionCode}\u0000${trimmed}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { code: event.contraventionCode, description: trimmed, count: 1 });
  }
  if (counts.size === 0) return 0;

  const rows = [...counts.values()];
  await client.query(
    `insert into authority_contravention_labels
       (authority_id, code, description, event_count, last_seen_at)
     select $1::uuid, c.code, c.description, c.n, now()
     from unnest($2::text[], $3::text[], $4::int[]) as c(code, description, n)
     on conflict (authority_id, code, description) do update
       set event_count = authority_contravention_labels.event_count + excluded.event_count,
           last_seen_at = excluded.last_seen_at`,
    [authorityId, rows.map((r) => r.code), rows.map((r) => r.description), rows.map((r) => r.count)],
  );
  return rows.length;
}

export async function rebuildAggregates(pool: Pool, authorityId: string): Promise<number> {
  const { rows } = await pool.query<{ pcnwatch_rebuild_aggregates: number }>(
    'select pcnwatch_rebuild_aggregates($1::uuid)',
    [authorityId],
  );
  return Number(rows[0]?.pcnwatch_rebuild_aggregates ?? 0);
}

export interface ScoringInputRow {
  location_id: string;
  monthly_counts: { periodStart: string; count: number }[];
  hour_counts: Record<string, number>;
  day_counts: Record<string, number>;
  data_confidence: string;
  has_geometry: boolean;
}

export async function loadScoringInputs(
  pool: Pool,
  authoritySlug: string,
  fromDate: string | null,
): Promise<ScoringInputRow[]> {
  const { rows } = await pool.query<ScoringInputRow>(
    'select * from pcnwatch_scoring_inputs($1, $2::date)',
    [authoritySlug, fromDate],
  );
  return rows;
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
