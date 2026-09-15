import { z } from 'zod';
import { serverEnv } from '@/lib/env';
import { logError } from '@/lib/errors';
import type { DateWindow } from './window';

/**
 * Vercel Web Analytics, read side.
 *
 * Traffic is the one thing the database genuinely cannot answer. A visitor who
 * reads the homepage and leaves writes no row anywhere, and a visitor who opens
 * `/analyse` and abandons at the upload writes no row either — `pcn_cases` is
 * not touched until the assessment is requested. So the top of the funnel comes
 * from Web Analytics or it does not exist.
 *
 * Two rules shape everything below.
 *
 * The token never reaches the browser. This module is server-only, throws if it
 * is ever constructed client-side, and the page that uses it is a Server
 * Component that renders numbers rather than handing down a fetcher.
 *
 * A failure is reported, never rendered as zero. "0 visitors" and "we could not
 * reach Vercel" look identical on a dashboard and mean opposite things — one is
 * a business emergency and the other is a configuration error. Every path here
 * returns a discriminated result, and the page prints the reason.
 */

const API_ORIGIN = 'https://api.vercel.com';

/** Only Production traffic. Preview deployments are somebody testing. */
const PRODUCTION_FILTER = "environment eq 'production'";

/** The route pattern behind `/case/<uuid>/defence`, as Vercel reports it. */
export const DEFENCE_OFFER_ROUTE = '/case/[id]/defence';
export const ANALYSE_ROUTE = '/analyse';

export interface TrafficTotals {
  readonly pageViews: number;
  readonly visitors: number;
}

export interface DimensionRow {
  readonly label: string;
  readonly pageViews: number;
}

export interface DailyRow {
  readonly date: string;
  readonly pageViews: number;
  readonly visitors: number;
}

export interface Traffic {
  readonly totals: TrafficTotals;
  /** Production page views of `/analyse`. A view, not a person. */
  readonly analyseViews: number | null;
  /** Production page views of the Defence Pack offer page. A view, not a person. */
  readonly defenceOfferViews: number | null;
  readonly topPages: readonly DimensionRow[];
  readonly topSources: readonly DimensionRow[];
  readonly daily: readonly DailyRow[];
  /** Breakdowns whose response shape could not be read. Named, never silently empty. */
  readonly degraded: readonly string[];
}

export type TrafficResult =
  | { readonly kind: 'OK'; readonly traffic: Traffic }
  | { readonly kind: 'NOT_CONFIGURED'; readonly missing: readonly string[] }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string };

/* ------------------------------------------------------------------ */
/* Response shapes                                                     */
/* ------------------------------------------------------------------ */

/**
 * `visits/count` is documented to return `{ data: { pageviews, visitors } }`.
 * Parsed strictly: a response that does not match is a failure to report, not a
 * shape to guess at.
 */
const countSchema = z.object({
  data: z.object({
    pageviews: z.number().nonnegative(),
    visitors: z.number().nonnegative(),
  }),
});

/**
 * `visits/aggregate` returns one row per group. The metric keys match the count
 * endpoint; the dimension key is whatever was asked for in `by`, so it is read
 * by name rather than by position.
 */
const aggregateSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
});

function numberAt(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

interface Credentials {
  readonly token: string;
  readonly projectId: string;
  readonly teamId: string;
}

export function analyticsCredentials():
  | { readonly ok: true; readonly credentials: Credentials }
  | { readonly ok: false; readonly missing: readonly string[] } {
  if (typeof window !== 'undefined') {
    throw new Error('The Vercel Analytics token must never be read in the browser.');
  }

  let env: ReturnType<typeof serverEnv>;
  try {
    env = serverEnv();
  } catch {
    return { ok: false, missing: ['VERCEL_ANALYTICS_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID'] };
  }

  const missing = (
    [
      ['VERCEL_ANALYTICS_TOKEN', env.VERCEL_ANALYTICS_TOKEN],
      ['VERCEL_PROJECT_ID', env.VERCEL_PROJECT_ID],
      ['VERCEL_TEAM_ID', env.VERCEL_TEAM_ID],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    credentials: {
      token: env.VERCEL_ANALYTICS_TOKEN as string,
      projectId: env.VERCEL_PROJECT_ID as string,
      teamId: env.VERCEL_TEAM_ID as string,
    },
  };
}

/** Combines the production filter with an optional extra clause. */
export function buildFilter(extra?: string): string {
  return extra ? `${PRODUCTION_FILTER} and ${extra}` : PRODUCTION_FILTER;
}

export function buildQuery(args: {
  readonly credentials: Credentials;
  readonly window: DateWindow;
  readonly filter?: string;
  readonly by?: readonly string[];
  readonly limit?: number;
}): URLSearchParams {
  const params = new URLSearchParams({
    projectId: args.credentials.projectId,
    teamId: args.credentials.teamId,
    since: args.window.startUtc.toISOString(),
    until: args.window.endUtc.toISOString(),
    filter: buildFilter(args.filter),
  });
  for (const dimension of args.by ?? []) params.append('by', dimension);
  if (args.limit !== undefined) params.set('limit', String(args.limit));
  return params;
}

type Fetcher = typeof fetch;

async function query(
  path: string,
  params: URLSearchParams,
  token: string,
  fetcher: Fetcher,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await fetcher(`${API_ORIGIN}${path}?${params.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
  } catch (error) {
    // The token is in a header, never in the URL, so nothing secret can reach
    // the log through the error.
    logError('admin.vercelAnalytics.fetch', error, { path });
    return { ok: false, reason: 'Could not reach the Vercel Analytics API.' };
  }

  if (!response.ok) {
    logError(
      'admin.vercelAnalytics.status',
      new Error(`Vercel Analytics responded ${response.status}`),
      { path },
    );
    return {
      ok: false,
      reason:
        response.status === 401 || response.status === 403
          ? 'Vercel rejected the analytics token (check its scope and the team).'
          : `Vercel Analytics responded ${response.status}.`,
    };
  }

  try {
    return { ok: true, body: await response.json() };
  } catch (error) {
    logError('admin.vercelAnalytics.parse', error, { path });
    return { ok: false, reason: 'Vercel Analytics returned a body that could not be read.' };
  }
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/**
 * Totals, plus the breakdowns behind them.
 *
 * The totals decide the result. A breakdown that cannot be read degrades to an
 * empty list and names itself in `degraded`, because a missing traffic-source
 * table is a gap in the page, while a missing visitor count is a page that
 * should not claim to know anything.
 */
export async function fetchTraffic(
  window: DateWindow,
  fetcher: Fetcher = fetch,
): Promise<TrafficResult> {
  const credentials = analyticsCredentials();
  if (!credentials.ok) return { kind: 'NOT_CONFIGURED', missing: credentials.missing };
  const { token } = credentials.credentials;
  const base = { credentials: credentials.credentials, window } as const;

  const totalsResponse = await query(
    '/v1/query/web-analytics/visits/count',
    buildQuery(base),
    token,
    fetcher,
  );
  if (!totalsResponse.ok) return { kind: 'UNAVAILABLE', reason: totalsResponse.reason };

  const totalsParsed = countSchema.safeParse(totalsResponse.body);
  if (!totalsParsed.success) {
    return {
      kind: 'UNAVAILABLE',
      reason: 'Vercel Analytics returned totals in an unexpected shape.',
    };
  }

  const degraded: string[] = [];

  const routeViews = async (route: string, label: string): Promise<number | null> => {
    const response = await query(
      '/v1/query/web-analytics/visits/count',
      buildQuery({ ...base, filter: `route eq '${route}'` }),
      token,
      fetcher,
    );
    if (!response.ok) {
      degraded.push(label);
      return null;
    }
    const parsed = countSchema.safeParse(response.body);
    if (!parsed.success) {
      degraded.push(label);
      return null;
    }
    return parsed.data.data.pageviews;
  };

  const breakdown = async (
    dimension: string,
    label: string,
    limit: number,
  ): Promise<DimensionRow[]> => {
    const response = await query(
      '/v1/query/web-analytics/visits/aggregate',
      buildQuery({ ...base, by: [dimension], limit }),
      token,
      fetcher,
    );
    if (!response.ok) {
      degraded.push(label);
      return [];
    }
    const parsed = aggregateSchema.safeParse(response.body);
    if (!parsed.success) {
      degraded.push(label);
      return [];
    }
    /*
     * A row whose dimension key is missing is not guessed at.
     *
     * If Vercel renames the key, taking "the first string field" would quietly
     * produce a plausible-looking table of the wrong thing. An empty table that
     * says so is the better failure.
     */
    const rows = parsed.data.data
      .filter((row) => typeof row[dimension] === 'string')
      .map((row) => ({ label: String(row[dimension]), pageViews: numberAt(row, 'pageviews') }));

    if (rows.length === 0 && parsed.data.data.length > 0) degraded.push(label);

    return rows.sort((a, b) => b.pageViews - a.pageViews).slice(0, limit);
  };

  const daily = async (): Promise<DailyRow[]> => {
    const response = await query(
      '/v1/query/web-analytics/visits/aggregate',
      buildQuery({ ...base, by: ['day'], limit: 60 }),
      token,
      fetcher,
    );
    if (!response.ok) {
      degraded.push('daily trend');
      return [];
    }
    const parsed = aggregateSchema.safeParse(response.body);
    if (!parsed.success) {
      degraded.push('daily trend');
      return [];
    }
    const rows = parsed.data.data
      .filter((row) => typeof row.day === 'string')
      .map((row) => ({
        date: String(row.day).slice(0, 10),
        pageViews: numberAt(row, 'pageviews'),
        visitors: numberAt(row, 'visitors'),
      }));

    if (rows.length === 0 && parsed.data.data.length > 0) degraded.push('daily trend');

    return rows.sort((a, b) => a.date.localeCompare(b.date));
  };

  const [analyseViews, defenceOfferViews, topPages, topSources, dailyRows] = await Promise.all([
    routeViews(ANALYSE_ROUTE, 'analyse page views'),
    routeViews(DEFENCE_OFFER_ROUTE, 'Defence Pack offer views'),
    breakdown('requestPath', 'top pages', 8),
    breakdown('referrerHostname', 'traffic sources', 8),
    daily(),
  ]);

  return {
    kind: 'OK',
    traffic: {
      totals: {
        pageViews: totalsParsed.data.data.pageviews,
        visitors: totalsParsed.data.data.visitors,
      },
      analyseViews,
      defenceOfferViews,
      topPages,
      topSources,
      daily: dailyRows,
      degraded,
    },
  };
}
