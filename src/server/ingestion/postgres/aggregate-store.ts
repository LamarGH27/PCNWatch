import type { Pool, PoolClient } from 'pg';
import type { ContraventionLabelCount, DailyActivityCell, LocationFacts } from './aggregate';
import { redactDiagnostic } from '../diagnostics';

/**
 * Writing the compact model, and publishing it safely.
 *
 * Three properties this file exists to hold:
 *
 *  1. A refresh builds a new dataset version alongside the live one. Readers
 *     only ever see the ACTIVE version, so a half-written refresh is invisible
 *     and a failed one leaves the previous data exactly as it was.
 *  2. Run bookkeeping is deliberately outside the data transaction. A run that
 *     rolls back must still be recorded as FAILED; a run whose process is killed
 *     must not sit at RUNNING forever.
 *  3. Nothing becomes ACTIVE that has not reconciled against the source counts.
 */

export interface DatasetVersionProvenance {
  readonly sourceUrl: string;
  readonly sourceDatasetId: string | null;
  readonly sourceFetchedAt: string;
  readonly sourceLastUploaded: string | null;
  readonly sourceSchemaFingerprint: string | null;
  readonly isDemo: boolean;
}

/**
 * Marks abandoned runs FAILED before starting a new one.
 *
 * A run killed mid-flight — out of memory, a closed laptop, a container
 * restart — never reaches any catch block, so its row stays RUNNING forever and
 * the freshness the site reports is a run that will never finish. Nothing else
 * cleans these up, so each new run does it: any earlier RUNNING row for the same
 * source is closed as FAILED with an explicit reason.
 */
export async function reapStaleRuns(
  pool: Pool,
  sourceId: string,
  olderThanMinutes = 60,
): Promise<number> {
  const { rowCount } = await pool.query(
    `update ingestion_runs
        set status = 'FAILED',
            finished_at = now(),
            report = report || jsonb_build_object(
              'abandoned', true,
              'message', 'Run was still RUNNING when a later run started; the process did not finish.'
            )
      where source_id = $1
        and status = 'RUNNING'
        and started_at < now() - make_interval(mins => $2::int)`,
    [sourceId, olderThanMinutes],
  );
  return rowCount ?? 0;
}

/** Records the fatal outcome of a run, with whatever counters are known. */
export async function failRunWithDetail(
  pool: Pool,
  runId: string,
  detail: {
    readonly message: string;
    readonly classification: string;
    readonly authorityId: string | null;
    readonly isDemo: boolean;
    readonly fetched?: number;
    readonly accepted?: number;
    readonly rejected?: number;
    readonly errorCount?: number;
  },
): Promise<void> {
  await pool.query(
    `update ingestion_runs
        set status = 'FAILED',
            finished_at = now(),
            fetched = coalesce($3, fetched),
            accepted = coalesce($4, accepted),
            rejected = coalesce($5, rejected),
            error_count = coalesce($6, error_count),
            report = report || $2::jsonb
      where id = $1`,
    [
      runId,
      JSON.stringify({
        authorityId: detail.authorityId,
        demo: detail.isDemo,
        // Scrubbed here rather than trusted from the caller: the message is
        // whatever threw, and the things that throw during ingestion are the
        // ones holding connection strings and app tokens.
        message: redactDiagnostic(detail.message),
        classification: detail.classification,
      }),
      detail.fetched ?? null,
      detail.accepted ?? null,
      detail.rejected ?? null,
      detail.errorCount ?? null,
    ],
  );
}

export async function createDatasetVersion(
  pool: Pool,
  args: {
    readonly authorityId: string;
    readonly sourceId: string;
    readonly sourceVersionId: string | null;
    readonly ingestionRunId: string;
    readonly provenance: DatasetVersionProvenance;
  },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into enforcement_dataset_versions (
       authority_id, source_id, source_version_id, ingestion_run_id, status,
       source_url, source_dataset_id, source_fetched_at, source_last_uploaded,
       source_schema_fingerprint, is_demo
     ) values ($1, $2, $3, $4, 'BUILDING', $5, $6, $7::timestamptz, $8::timestamptz, $9, $10)
     returning id`,
    [
      args.authorityId,
      args.sourceId,
      args.sourceVersionId,
      args.ingestionRunId,
      args.provenance.sourceUrl,
      args.provenance.sourceDatasetId,
      args.provenance.sourceFetchedAt,
      args.provenance.sourceLastUploaded,
      args.provenance.sourceSchemaFingerprint,
      args.provenance.isDemo,
    ],
  );
  return rows[0]!.id;
}

/**
 * Creates or updates the locations a flush is about to reference.
 *
 * One row per street, carrying one derived geometry with its provenance. The
 * activity rows reference it, so a position is stored once however many days of
 * activity point at it.
 */
export async function upsertLocations(
  client: PoolClient,
  authorityId: string,
  sourceId: string,
  retrievedAt: string,
  locations: readonly LocationFacts[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  if (locations.length === 0) return ids;

  const { rows } = await client.query<{ id: string; slug: string }>(
    `insert into parking_locations (
       authority_id, slug, display_name, street_name, street_name_normalised,
       locality, postcode_district, geom, source_id, source_record_id,
       retrieved_at, data_confidence, source_location_raw,
       geometry_source, geometry_method, geometry_confidence, geometry_resolved_at
     )
     select
       $1::uuid, t.slug, t.display_name, t.street_name, t.normalised,
       nullif(t.locality, ''), nullif(t.postcode, ''),
       case when t.lon = '' then null
            else st_setsrid(st_point(t.lon::double precision, t.lat::double precision), 4326)::geography
       end,
       $2::uuid, t.rec_id, $3::timestamptz, t.conf::numeric, t.raw_location,
       nullif(t.geom_source, ''), nullif(t.geom_method, ''),
       nullif(t.geom_conf, '')::numeric,
       case when t.lon = '' then null else $3::timestamptz end
     from unnest(
       $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
       $10::text[], $11::text[], $12::text[], $13::text[], $14::text[],
       $15::text[], $16::text[], $17::text[]
     ) as t(slug, display_name, street_name, normalised, locality, postcode,
            lon, lat, rec_id, conf, raw_location, geom_source, geom_method, geom_conf)
     on conflict (authority_id, slug) do update set
       display_name = excluded.display_name,
       street_name = excluded.street_name,
       street_name_normalised = excluded.street_name_normalised,
       locality = coalesce(excluded.locality, parking_locations.locality),
       postcode_district = coalesce(excluded.postcode_district, parking_locations.postcode_district),
       source_location_raw = coalesce(excluded.source_location_raw, parking_locations.source_location_raw),
       -- Keep the first position found, so re-ingesting the same data places a
       -- street in the same spot every time.
       geom = coalesce(parking_locations.geom, excluded.geom),
       geometry_source = case when parking_locations.geom is null
                              then excluded.geometry_source else parking_locations.geometry_source end,
       geometry_method = case when parking_locations.geom is null
                              then excluded.geometry_method else parking_locations.geometry_method end,
       geometry_confidence = case when parking_locations.geom is null
                              then excluded.geometry_confidence else parking_locations.geometry_confidence end,
       geometry_resolved_at = case when parking_locations.geom is null
                              then excluded.geometry_resolved_at else parking_locations.geometry_resolved_at end,
       retrieved_at = excluded.retrieved_at,
       data_confidence = greatest(excluded.data_confidence, parking_locations.data_confidence)
     returning id, slug`,
    [
      authorityId,
      sourceId,
      retrievedAt,
      locations.map((l) => l.slug),
      locations.map((l) => l.displayName),
      locations.map((l) => l.streetName),
      locations.map((l) => l.streetNameNormalised),
      locations.map((l) => l.locality ?? ''),
      locations.map((l) => l.postcodeDistrict ?? ''),
      locations.map((l) => (l.longitude === null ? '' : String(l.longitude))),
      locations.map((l) => (l.latitude === null ? '' : String(l.latitude))),
      locations.map((l) => l.geometryFromRecordId ?? l.slug),
      locations.map((l) => String(l.bestConfidence)),
      locations.map((l) => l.sourceLocationRaw),
      locations.map((l) => l.geometrySource ?? ''),
      locations.map((l) => l.geometryMethod ?? ''),
      locations.map((l) => (l.geometryConfidence === null ? '' : String(l.geometryConfidence))),
    ],
  );

  for (const row of rows) ids.set(row.slug, row.id);
  return ids;
}

/**
 * Merges a batch of aggregated cells into the version being built.
 *
 * Counts add and histograms add slot by slot, so the same cell arriving in two
 * flushes accumulates. That is what makes it safe to flush partway through a
 * stream rather than holding the whole borough in memory.
 */
export async function flushActivity(
  client: PoolClient,
  args: {
    readonly datasetVersionId: string;
    readonly locationIds: ReadonlyMap<string, string>;
    readonly cells: readonly DailyActivityCell[];
  },
): Promise<number> {
  const usable = args.cells
    .filter((c) => args.locationIds.has(c.locationSlug))
    // Written in the order the unique index stores them. The accumulator hands
    // them over in hash-map order, which is arbitrary; sorting makes the write
    // order a function of the data alone, so two runs over the same source
    // produce the same physical rows and not merely the same totals. It packs
    // each flush's own range of the index too, though what actually reclaims
    // the space across flushes is `compactActivity` below.
    .map((c) => ({ cell: c, locationId: args.locationIds.get(c.locationSlug)! }))
    .sort((a, b) =>
      a.locationId.localeCompare(b.locationId) ||
      a.cell.activityDate.localeCompare(b.cell.activityDate) ||
      (a.cell.contraventionCode ?? '').localeCompare(b.cell.contraventionCode ?? '') ||
      a.cell.enforcementClass.localeCompare(b.cell.enforcementClass),
    );
  if (usable.length === 0) return 0;

  await client.query(
    `insert into pcn_activity_daily (
       dataset_version_id, parking_location_id, activity_date,
       contravention_code, enforcement_class, via_cctv, pcn_count,
       hour_histogram, data_confidence
     )
     select $1::uuid, t.location_id::uuid, t.activity_date::date,
            nullif(t.code, ''), t.class::enforcement_type,
            case t.cctv when 'true' then true when 'false' then false else null end,
            t.count::integer, t.histogram::smallint[], t.confidence::numeric
     from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                 $7::text[], $8::text[], $9::text[])
       as t(location_id, activity_date, code, class, cctv, count, histogram, confidence)
     on conflict (dataset_version_id, parking_location_id, activity_date, contravention_code, enforcement_class)
     do update set
       pcn_count = pcn_activity_daily.pcn_count + excluded.pcn_count,
       hour_histogram = pcnwatch_add_histograms(pcn_activity_daily.hour_histogram, excluded.hour_histogram),
       data_confidence = least(pcn_activity_daily.data_confidence, excluded.data_confidence),
       via_cctv = case when pcn_activity_daily.via_cctv is not distinct from excluded.via_cctv
                       then pcn_activity_daily.via_cctv else null end`,
    [
      args.datasetVersionId,
      usable.map((u) => u.locationId),
      usable.map((u) => u.cell.activityDate),
      usable.map((u) => u.cell.contraventionCode ?? ''),
      usable.map((u) => u.cell.enforcementClass),
      usable.map((u) => (u.cell.viaCctv === null ? '' : String(u.cell.viaCctv))),
      usable.map((u) => String(u.cell.pcnCount)),
      usable.map((u) => `{${u.cell.hourHistogram.join(',')}}`),
      usable.map((u) => String(u.cell.minConfidence)),
    ],
  );

  return usable.length;
}

/**
 * Repacks the activity indexes once the writing is done.
 *
 * The flushes arrive interleaved across the whole key range — each one carries
 * every street, a different slice of days — so the unique index is built by
 * inserting a quarter of a million entries at scattered positions, and splits
 * its pages roughly 60% full. Rebuilding it once at the end costs a few seconds
 * and measured 24 MB down to 16 MB on a 414,658-notice dataset.
 *
 * CONCURRENTLY because the previous version is still live and being read: this
 * runs before the swap, and must not lock readers out of it. Failing to compact
 * is not a reason to withhold a dataset that reconciles, so the caller treats an
 * error here as a warning.
 */
export async function compactActivity(pool: Pool): Promise<void> {
  // Cannot run inside a transaction block, so each goes on its own statement.
  await pool.query('reindex index concurrently pcn_activity_daily_key');
  await pool.query('analyze pcn_activity_daily');
}

export interface Reconciliation {
  readonly reconciles: boolean;
  readonly acceptedFromSource: number;
  readonly aggregateTotal: number;
  readonly difference: number;
  readonly rows: number;
  readonly histogramTotal: number;
  readonly locations: number;
}

/**
 * Proves the published statistics came from the source.
 *
 * Individual notices are gone, so this is what stands in their place: the sum of
 * every stored count must equal the number of notices accepted from the source.
 * If it does not, something was dropped or double-counted and the version must
 * not be published.
 *
 * The histogram total is reported but deliberately not required to match: a
 * notice with no time of day is counted, and contributes to no hour.
 */
export async function reconcileVersion(
  pool: Pool,
  datasetVersionId: string,
  acceptedFromSource: number,
): Promise<Reconciliation> {
  const { rows } = await pool.query<{
    total: string;
    rows: string;
    histogram_total: string;
    locations: string;
  }>(
    `select coalesce(sum(pcn_count), 0)::text as total,
            count(*)::text as rows,
            coalesce(sum((select sum(h) from unnest(hour_histogram) as h)), 0)::text as histogram_total,
            count(distinct parking_location_id)::text as locations
       from pcn_activity_daily
      where dataset_version_id = $1`,
    [datasetVersionId],
  );

  const row = rows[0]!;
  const aggregateTotal = Number(row.total);
  return {
    reconciles: aggregateTotal === acceptedFromSource,
    acceptedFromSource,
    aggregateTotal,
    difference: aggregateTotal - acceptedFromSource,
    rows: Number(row.rows),
    histogramTotal: Number(row.histogram_total),
    locations: Number(row.locations),
  };
}

/**
 * Publishes a version, replacing the previous one in a single transaction.
 *
 * Readers see one ACTIVE version or the other, never both and never neither.
 * A partial index enforces the "at most one ACTIVE" rule in the database, so a
 * bug here cannot publish two.
 */
export async function activateVersion(
  pool: Pool,
  args: {
    readonly datasetVersionId: string;
    readonly authorityId: string;
    readonly reconciliation: Reconciliation;
    readonly rowsFetched: number;
    readonly rowsRejected: number;
    /** The authority's own wording for each code, as seen in this dataset. */
    readonly labels: readonly ContraventionLabelCount[];
  },
): Promise<void> {
  if (!args.reconciliation.reconciles) {
    throw new Error(
      `Refusing to publish: aggregate total ${args.reconciliation.aggregateTotal} does not equal ` +
        `${args.reconciliation.acceptedFromSource} accepted source records ` +
        `(difference ${args.reconciliation.difference}).`,
    );
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `update enforcement_dataset_versions
          set status = 'SUPERSEDED'
        where authority_id = $1 and status = 'ACTIVE' and id <> $2`,
      [args.authorityId, args.datasetVersionId],
    );
    await client.query(
      `update enforcement_dataset_versions
          set status = 'ACTIVE',
              activated_at = now(),
              rows_fetched = $2,
              rows_accepted = $3,
              rows_rejected = $4,
              aggregate_total = $5
        where id = $1`,
      [
        args.datasetVersionId,
        args.rowsFetched,
        args.reconciliation.acceptedFromSource,
        args.rowsRejected,
        args.reconciliation.aggregateTotal,
      ],
    );
    await replaceContraventionLabels(client, args.authorityId, args.labels);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Replaces an authority's published contravention wordings with those in the
 * dataset being activated.
 *
 * Replaced rather than accumulated: the counts are meant to say how often each
 * wording appears in the data now on the site, and adding each run's counts to
 * the last made them a running total of every ingestion ever performed. Run in
 * the activation transaction, so the labels and the figures they describe
 * change together or not at all.
 *
 * The text is stored exactly as the authority published it — never edited,
 * never paraphrased.
 */
async function replaceContraventionLabels(
  client: PoolClient,
  authorityId: string,
  labels: readonly ContraventionLabelCount[],
): Promise<void> {
  // A dataset with no wordings at all is far more likely to be a source that
  // stopped publishing the column than an authority that withdrew every label,
  // so the existing ones are left in place rather than wiped.
  if (labels.length === 0) return;

  await client.query('delete from authority_contravention_labels where authority_id = $1', [
    authorityId,
  ]);
  await client.query(
    `insert into authority_contravention_labels
       (authority_id, code, description, event_count, last_seen_at)
     select $1::uuid, c.code, c.description, c.n, now()
     from unnest($2::text[], $3::text[], $4::int[]) as c(code, description, n)`,
    [
      authorityId,
      labels.map((l) => l.code),
      labels.map((l) => l.description),
      labels.map((l) => l.count),
    ],
  );
}

/** Marks a version that will never be published, so it is not mistaken for one still building. */
export async function abandonVersion(pool: Pool, datasetVersionId: string): Promise<void> {
  await pool.query(
    `update enforcement_dataset_versions set status = 'ABANDONED'
      where id = $1 and status = 'BUILDING'`,
    [datasetVersionId],
  );
}

/**
 * Deletes superseded and abandoned versions, keeping the most recent superseded
 * one so a bad publish can be rolled back by hand.
 */
export async function pruneVersions(pool: Pool, authorityId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from enforcement_dataset_versions
      where authority_id = $1
        and status in ('SUPERSEDED', 'ABANDONED')
        and id not in (
          select id from enforcement_dataset_versions
           where authority_id = $1 and status = 'SUPERSEDED'
           order by activated_at desc nulls last, built_at desc
           limit 1
        )`,
    [authorityId],
  );
  return rowCount ?? 0;
}

/** The version the public product is reading, if any. */
export async function activeVersionId(pool: Pool, authorityId: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `select id from enforcement_dataset_versions
      where authority_id = $1 and status = 'ACTIVE' limit 1`,
    [authorityId],
  );
  return rows[0]?.id ?? null;
}
