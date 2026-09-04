import { assessCoverage, isAuthorityInMapScope, type CoverageResult } from '@/core/coverage/coverage';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { isConfigured } from '@/lib/env';
import { logError } from '@/lib/errors';
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

/** Discriminated result so a failure can never be mistaken for "no data". */
export type QueryResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly unavailable: true; readonly correlationId: string };

function unavailable(scope: string, error: unknown): QueryResult<never> {
  return { ok: false, unavailable: true, correlationId: logError(scope, error) };
}

/**
 * Supabase client, or null when Supabase is not configured.
 *
 * The public read paths use the service client because enforcement aggregates are
 * public data with public-read policies; using it here avoids a session round-trip
 * on anonymous page loads. It never touches user-owned tables.
 */
function publicClient() {
  if (!isConfigured('supabase')) return null;
  try {
    return createSupabaseServiceClient();
  } catch (error) {
    logError('enforcement.client', error);
    return null;
  }
}

export async function getAuthorities(): Promise<QueryResult<AuthoritySummary[]>> {
  const supabase = publicClient();
  if (!supabase) return unavailable('enforcement.getAuthorities', new Error('SUPABASE_NOT_CONFIGURED'));

  try {
    const { data, error } = await supabase
      .from('authorities')
      .select(
        'slug, name, website_url, challenge_info_url, payment_info_url, tribunal_route, penalty_bands, map_coverage_status, coverage_notes, reviewed_at',
      )
      .order('name');
    if (error) throw error;

    return {
      ok: true,
      data: (data ?? []).map((row) => ({
        slug: String(row.slug),
        name: String(row.name),
        websiteUrl: row.website_url ?? null,
        challengeInfoUrl: row.challenge_info_url ?? null,
        paymentInfoUrl: row.payment_info_url ?? null,
        tribunalRoute: row.tribunal_route ?? null,
        penaltyBands: (row.penalty_bands ?? {}) as AuthoritySummary['penaltyBands'],
        mapCoverageStatus: row.map_coverage_status as AuthoritySummary['mapCoverageStatus'],
        coverageNotes: String(row.coverage_notes ?? ''),
        reviewedAt: row.reviewed_at ?? null,
      })),
    };
  } catch (error) {
    return unavailable('enforcement.getAuthorities', error);
  }
}

/**
 * Coverage for an authority, derived from what is actually stored.
 *
 * This is the function every map surface calls before rendering a figure.
 */
export async function getCoverage(authoritySlug: string): Promise<CoverageResult> {
  const supabase = publicClient();
  const configuredLive = isAuthorityInMapScope(authoritySlug);
  const fallbackName = titleCase(authoritySlug);

  if (!supabase) {
    return assessCoverage(authoritySlug, fallbackName, {
      configuredLive,
      eventCount: 0,
      lastSuccessfulIngestionAt: null,
      // Not configured is a deployment problem, not an absence of enforcement.
      sourceUnavailable: true,
      isDemoData: false,
    });
  }

  try {
    const { data: authority, error: authorityError } = await supabase
      .from('authorities')
      .select('id, name, map_coverage_status')
      .eq('slug', authoritySlug)
      .maybeSingle();
    if (authorityError) throw authorityError;

    if (!authority) {
      return assessCoverage(authoritySlug, fallbackName, {
        configuredLive: false,
        eventCount: 0,
        lastSuccessfulIngestionAt: null,
        sourceUnavailable: false,
        isDemoData: false,
      });
    }

    const [{ count, error: countError }, lastRun] = await Promise.all([
      supabase
        .from('pcn_events')
        .select('id', { count: 'exact', head: true })
        .eq('authority_id', authority.id),
      lastSuccessfulIngestion(supabase, authority.id as string),
    ]);
    if (countError) throw countError;

    return assessCoverage(authoritySlug, String(authority.name), {
      configuredLive: configuredLive && authority.map_coverage_status === 'LIVE',
      eventCount: count ?? 0,
      lastSuccessfulIngestionAt: lastRun.finishedAt,
      sourceUnavailable: false,
      isDemoData: lastRun.isDemo,
    });
  } catch (error) {
    logError('enforcement.getCoverage', error, { authoritySlug });
    return assessCoverage(authoritySlug, fallbackName, {
      configuredLive,
      eventCount: 0,
      lastSuccessfulIngestionAt: null,
      sourceUnavailable: true,
      isDemoData: false,
    });
  }
}

type SupabaseLike = NonNullable<ReturnType<typeof createSupabaseServiceClient>>;

async function lastSuccessfulIngestion(
  supabase: SupabaseLike,
  authorityId: string,
): Promise<{ finishedAt: string | null; isDemo: boolean }> {
  const { data } = await supabase
    .from('ingestion_runs')
    .select('finished_at, report, data_sources!inner(slug)')
    .in('status', ['SUCCEEDED', 'PARTIAL'])
    .order('finished_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return { finishedAt: null, isDemo: false };
  const report = (data.report ?? {}) as { demo?: boolean; authorityId?: string };
  // A run is only relevant to this authority when it says so.
  if (report.authorityId && report.authorityId !== authorityId) {
    return { finishedAt: null, isDemo: false };
  }
  return { finishedAt: data.finished_at ?? null, isDemo: report.demo === true };
}

export interface HotspotQuery {
  readonly authoritySlug: string;
  readonly periodKey: '30D' | '90D' | '12M';
  readonly contraventionCode?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export async function getHotspots(query: HotspotQuery): Promise<QueryResult<HotspotRow[]>> {
  const supabase = publicClient();
  if (!supabase) return unavailable('enforcement.getHotspots', new Error('SUPABASE_NOT_CONFIGURED'));

  const limit = Math.min(query.limit ?? 50, 200);

  try {
    // A database function does the aggregation so the browser never sees raw rows
    // and the ranking happens where the data is.
    const { data, error } = await supabase.rpc('fineradar_hotspots', {
      p_authority_slug: query.authoritySlug,
      p_period_key: query.periodKey,
      p_contravention_code: query.contraventionCode ?? null,
      p_limit: limit,
      p_offset: query.offset ?? 0,
    });
    if (error) throw error;

    return { ok: true, data: (data ?? []).map(toHotspotRow) };
  } catch (error) {
    return unavailable('enforcement.getHotspots', error);
  }
}

export async function getLocation(
  authoritySlug: string,
  locationSlug: string,
): Promise<QueryResult<LocationDetail | null>> {
  const supabase = publicClient();
  if (!supabase) return unavailable('enforcement.getLocation', new Error('SUPABASE_NOT_CONFIGURED'));

  try {
    const { data, error } = await supabase.rpc('fineradar_location_detail', {
      p_authority_slug: authoritySlug,
      p_location_slug: locationSlug,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { ok: true, data: null };
    return { ok: true, data: toLocationDetail(row) };
  } catch (error) {
    return unavailable('enforcement.getLocation', error);
  }
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
