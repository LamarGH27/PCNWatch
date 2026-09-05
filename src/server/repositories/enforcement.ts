import { assessCoverage, isAuthorityInMapScope, type CoverageResult } from '@/core/coverage/coverage';
import { logError } from '@/lib/errors';
import { callFunction, hasReadBackend, queryRows } from '@/server/db/reader';
import { getAuthorityRecord } from './authorities-data';
import type { ScoreClassification } from '@/core/scoring/types';

/**
 * Read access to public enforcement data.
 *
 * Two rules govern everything here:
 *  1. The browser never receives raw PCN rows. Every query returns an aggregate
 *     or a bounded, already-summarised record set.
 *  2. A datastore failure returns `sourceUnavailable`, never an empty list. An
 *     empty list means "we looked and there is genuinely nothing"; those are
 *     different claims and the UI renders them differently.
 */

export interface AuthoritySummary {
  readonly slug: string;
  readonly name: string;
  readonly websiteUrl: string | null;
  readonly challengeInfoUrl: string | null;
  readonly paymentInfoUrl: string | null;
  readonly tribunalRoute: string | null;
  readonly penaltyBands: Record<string, { full?: number; discounted?: number }>;
  readonly mapCoverageStatus: 'LIVE' | 'PLANNED' | 'UNAVAILABLE';
  readonly coverageNotes: string;
  readonly reviewedAt: string | null;
}

export interface HotspotRow {
  readonly locationId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly streetName: string;
  readonly authoritySlug: string;
  readonly score: number | null;
  readonly classification: ScoreClassification | null;
  readonly refusalReason: string | null;
  readonly totalPcns: number;
  readonly dominantContravention: string | null;
  readonly peakWindow: string | null;
  readonly trend: 'RISING' | 'FALLING' | 'STABLE' | 'UNKNOWN';
  readonly dataConfidence: number;
  readonly longitude: number | null;
  readonly latitude: number | null;
}
/**
 * Discriminated so a failure can never be mistaken for an empty result set.
 * "We could not look" and "we looked and found nothing" render differently and
 * must stay structurally distinct.
 */
export type QueryResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly unavailable: true; readonly correlationId: string };

export async function getAuthorities(): Promise<QueryResult<AuthoritySummary[]>> {
  const result = await queryRows<Record<string, unknown>>(
    `select slug, name, website_url, challenge_info_url, payment_info_url, tribunal_route,
            penalty_bands, map_coverage_status, coverage_notes, reviewed_at
     from authorities order by name`,
  );
  if (!result.ok) {
    return { ok: false, unavailable: true, correlationId: result.correlationId };
  }
  return {
    ok: true,
    data: result.rows.map((row) => ({
      slug: String(row.slug),
      name: String(row.name),
      websiteUrl: (row.website_url as string | null) ?? null,
      challengeInfoUrl: (row.challenge_info_url as string | null) ?? null,
      paymentInfoUrl: (row.payment_info_url as string | null) ?? null,
      tribunalRoute: (row.tribunal_route as string | null) ?? null,
      penaltyBands: (row.penalty_bands ?? {}) as AuthoritySummary['penaltyBands'],
      mapCoverageStatus: row.map_coverage_status as AuthoritySummary['mapCoverageStatus'],
      coverageNotes: String(row.coverage_notes ?? ''),
      reviewedAt: (row.reviewed_at as string | null) ?? null,
    })),
  };
}

export async function getCoverage(authoritySlug: string): Promise<CoverageResult> {
  const configuredLive = isAuthorityInMapScope(authoritySlug);
  const fallbackName = getAuthorityRecord(authoritySlug)?.name ?? titleCase(authoritySlug);

  if (!hasReadBackend()) {
    // Not configured is a deployment problem, not an absence of enforcement.
    return assessCoverage(authoritySlug, fallbackName, {
      configuredLive,
      eventCount: 0,
      geolocatedLocationCount: 0,
      geolocatedEventCount: 0,
      mappedEventCount: 0,
      lastSuccessfulIngestionAt: null,
      sourceUnavailable: true,
      isDemoData: false,
    });
  }

  const result = await queryRows<{
    name: string;
    map_coverage_status: string;
    event_count: string;
    geolocated_location_count: string;
    geolocated_event_count: string;
    mapped_event_count: string;
    last_ingested_at: string | null;
    is_demo: boolean | null;
  }>(
    `select
       a.name,
       a.map_coverage_status,
       (select count(*) from pcn_events e where e.authority_id = a.id)::text as event_count,
       -- Whether anything can be drawn at all. A source that publishes no
       -- coordinates yields locations with counts and no geometry, and the map
       -- must say that rather than "no recorded PCNs".
       (select count(*) from parking_locations l
         where l.authority_id = a.id and l.geom is not null)::text
         as geolocated_location_count,
       -- Notices the authority published a position for, counted on the event's
       -- own geometry rather than its street's.
       --
       -- The distinction is the whole point. A street gets its position from one
       -- representative notice, and the map then shows every notice on that
       -- street at that one point — so counting events whose *location* has
       -- geometry reports 100% while most of those notices have no position of
       -- their own. That would state the opposite of the truth.
       (select count(*) from pcn_events e
         where e.authority_id = a.id and e.geom is not null)::text
         as geolocated_event_count,
       -- Notices that actually appear on the map: every notice on a street the
       -- authority positioned, including those with no position of their own.
       -- A different number from the one above, and both are needed — one says
       -- how much of the activity is visible, the other how precisely.
       (select count(*) from pcn_events e
          join parking_locations l on l.id = e.parking_location_id
         where e.authority_id = a.id and l.geom is not null)::text
         as mapped_event_count,
       run.finished_at as last_ingested_at,
       (run.report ->> 'demo')::boolean as is_demo
     from authorities a
     left join lateral (
       select r.finished_at, r.report
       from ingestion_runs r
       where r.status in ('SUCCEEDED', 'PARTIAL')
         and r.report ->> 'authorityId' = a.id::text
       order by r.finished_at desc nulls last
       limit 1
     ) run on true
     where a.slug = $1`,
    [authoritySlug],
  );

  if (!result.ok) {
    logError('enforcement.getCoverage', new Error(result.reason), { authoritySlug });
    return assessCoverage(authoritySlug, fallbackName, {
      configuredLive,
      eventCount: 0,
      geolocatedLocationCount: 0,
      geolocatedEventCount: 0,
      mappedEventCount: 0,
      lastSuccessfulIngestionAt: null,
      sourceUnavailable: true,
      isDemoData: false,
    });
  }

  const row = result.rows[0];
  if (!row) {
    return assessCoverage(authoritySlug, fallbackName, {
      configuredLive: false,
      eventCount: 0,
      geolocatedLocationCount: 0,
      geolocatedEventCount: 0,
      mappedEventCount: 0,
      lastSuccessfulIngestionAt: null,
      sourceUnavailable: false,
      isDemoData: false,
    });
  }

  return assessCoverage(authoritySlug, String(row.name), {
    configuredLive: configuredLive && row.map_coverage_status === 'LIVE',
    eventCount: Number(row.event_count ?? 0),
    geolocatedLocationCount: Number(row.geolocated_location_count ?? 0),
    geolocatedEventCount: Number(row.geolocated_event_count ?? 0),
    mappedEventCount: Number(row.mapped_event_count ?? 0),
    lastSuccessfulIngestionAt: row.last_ingested_at,
    sourceUnavailable: false,
    isDemoData: row.is_demo === true,
  });
}

export interface ContraventionFilter {
  readonly code: string;
  readonly pcnCount: number;
}

/**
 * The contravention codes that actually appear in an authority's data, most
 * common first.
 *
 * The filter used to be a hardcoded list of twelve codes. Against real Camden
 * data that offered six codes the borough may never have issued — clicking one
 * showed an empty ranking, which reads as "no enforcement here" rather than
 * "that code is not in this data" — while hiding three of the four most common
 * ones, including 33, 11 and 52 with roughly 75,000 notices each.
 *
 * Read from the monthly code buckets rather than counted over events: the
 * aggregate is small and already maintained for exactly this shape of question.
 */
export async function getContraventionFilters(
  authoritySlug: string,
  limit = 16,
): Promise<readonly ContraventionFilter[]> {
  const result = await queryRows<{ contravention_code: string; pcn_count: string }>(
    `select a.contravention_code, sum(a.pcn_count)::text as pcn_count
       from pcn_activity_aggregates a
       join authorities auth on auth.id = a.authority_id
      where auth.slug = $1
        and a.bucket_kind = 'MONTH_CODE'
        and a.contravention_code is not null
      group by a.contravention_code
      order by sum(a.pcn_count) desc, a.contravention_code
      limit $2`,
    [authoritySlug, limit],
  );

  if (!result.ok) {
    // No filter is better than a filter that lies about what is available.
    logError('enforcement.getContraventionFilters', new Error(result.reason), { authoritySlug });
    return [];
  }

  return result.rows.map((row) => ({
    code: row.contravention_code,
    pcnCount: Number(row.pcn_count),
  }));
}

export interface HotspotQuery {
  readonly authoritySlug: string;
  readonly periodKey: '30D' | '90D' | '12M';
  readonly contraventionCode?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export async function getHotspots(query: HotspotQuery): Promise<QueryResult<HotspotRow[]>> {
  const limit = Math.min(query.limit ?? 50, 200);

  const result = await callFunction<Row>(
    'pcnwatch_hotspots',
    {
      p_authority_slug: query.authoritySlug,
      p_period_key: query.periodKey,
      p_contravention_code: query.contraventionCode ?? null,
      p_limit: limit,
      p_offset: query.offset ?? 0,
    },
    ['p_authority_slug', 'p_period_key', 'p_contravention_code', 'p_limit', 'p_offset'],
  );

  if (!result.ok) {
    return { ok: false, unavailable: true, correlationId: result.correlationId };
  }
  return { ok: true, data: result.rows.map(toHotspotRow) };
}

export async function getLocation(
  authoritySlug: string,
  locationSlug: string,
): Promise<QueryResult<LocationDetail | null>> {
  const result = await callFunction<Row>(
    'pcnwatch_location_detail',
    { p_authority_slug: authoritySlug, p_location_slug: locationSlug },
    ['p_authority_slug', 'p_location_slug'],
  );

  if (!result.ok) {
    return { ok: false, unavailable: true, correlationId: result.correlationId };
  }
  const row = result.rows[0];
  return { ok: true, data: row ? toLocationDetail(row) : null };
}

export interface LocationDetail extends HotspotRow {
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly contraventionBreakdown: readonly { code: string; count: number }[];
  readonly hourProfile: readonly number[];
  readonly dayProfile: readonly number[];
  readonly monthlyCounts: readonly { periodStart: string; count: number }[];
  readonly sourceName: string | null;
  readonly sourceAttribution: string | null;
  readonly sourceUrl: string | null;
  readonly retrievedAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

function toHotspotRow(row: Row): HotspotRow {
  return {
    locationId: String(row.location_id ?? ''),
    slug: String(row.slug ?? ''),
    displayName: String(row.display_name ?? ''),
    streetName: String(row.street_name ?? ''),
    authoritySlug: String(row.authority_slug ?? ''),
    score: numberOrNull(row.score),
    classification: (row.classification as ScoreClassification | null) ?? null,
    refusalReason: (row.refusal_reason as string | null) ?? null,
    totalPcns: Number(row.total_pcns ?? 0),
    dominantContravention: (row.dominant_contravention as string | null) ?? null,
    peakWindow: (row.peak_window as string | null) ?? null,
    trend: (row.trend as HotspotRow['trend']) ?? 'UNKNOWN',
    dataConfidence: Number(row.data_confidence ?? 0),
    longitude: numberOrNull(row.longitude),
    latitude: numberOrNull(row.latitude),
  };
}

function toLocationDetail(row: Row): LocationDetail {
  return {
    ...toHotspotRow(row),
    periodStart: (row.period_start as string | null) ?? null,
    periodEnd: (row.period_end as string | null) ?? null,
    contraventionBreakdown: Array.isArray(row.contravention_breakdown)
      ? (row.contravention_breakdown as { code: string; count: number }[])
      : [],
    hourProfile: Array.isArray(row.hour_profile) ? (row.hour_profile as number[]) : [],
    dayProfile: Array.isArray(row.day_profile) ? (row.day_profile as number[]) : [],
    monthlyCounts: Array.isArray(row.monthly_counts)
      ? (row.monthly_counts as { periodStart: string; count: number }[])
      : [],
    sourceName: (row.source_name as string | null) ?? null,
    sourceAttribution: (row.source_attribution as string | null) ?? null,
    sourceUrl: (row.source_url as string | null) ?? null,
    retrievedAt: (row.retrieved_at as string | null) ?? null,
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
