import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { isConfigured } from '@/lib/env';
import { logError, toUserFacingError } from '@/lib/errors';
import { getCoverage } from '@/server/repositories/enforcement';
import { rateLimit } from '@/server/rate-limit';

/**
 * Binned enforcement activity for a map viewport.
 *
 * The aggregation happens in the database; this route validates the viewport,
 * enforces coverage, and returns a bounded payload. Raw PCN rows never appear here.
 */

const querySchema = z.object({
  authority: z.string().regex(/^[a-z0-9-]{1,64}$/),
  minLon: z.coerce.number().min(-180).max(180),
  minLat: z.coerce.number().min(-90).max(90),
  maxLon: z.coerce.number().min(-180).max(180),
  maxLat: z.coerce.number().min(-90).max(90),
  zoom: z.coerce.number().int().min(0).max(22),
  period: z.enum(['30D', '90D', '12M']).default('12M'),
  contravention: z.string().regex(/^\d{2}$/).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));

  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          what: 'The map requested an area we could not interpret.',
          whatYouCanDo: 'Reload the page. If it keeps happening, please tell us.',
          correlationId: logError('api.map.cells.validation', parsed.error),
        },
      },
      { status: 400 },
    );
  }

  const query = parsed.data;

  // A viewport spanning the world would defeat the point of binning.
  if (query.maxLon - query.minLon > 2 || query.maxLat - query.minLat > 2) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          what: 'That area is too large to summarise.',
          whatYouCanDo: 'Zoom in and try again.',
          correlationId: 'viewport-too-large',
        },
      },
      { status: 400 },
    );
  }

  const limited = await rateLimit(request, { key: 'map-cells', limit: 120, windowSeconds: 60 });
  if (!limited.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          what: 'Too many map requests in a short time.',
          whatYouCanDo: `Wait ${limited.retryAfterSeconds} seconds and try again.`,
          correlationId: 'rate-limited',
        },
      },
      { status: 429, headers: { 'retry-after': String(limited.retryAfterSeconds) } },
    );
  }

  try {
    // Coverage is checked server-side so a crafted request cannot obtain figures
    // for an area we do not claim to cover.
    const coverage = await getCoverage(query.authority);
    if (!coverage.canShowActivity) {
      return NextResponse.json({
        ok: true,
        cells: [],
        totalPcns: 0,
        coverage: { state: coverage.state, headline: coverage.headline, detail: coverage.detail },
      });
    }

    if (!isConfigured('supabase')) throw new Error('SUPABASE_NOT_CONFIGURED');
    const supabase = createSupabaseServiceClient();
    if (!supabase) throw new Error('SUPABASE_CLIENT_UNAVAILABLE');

    const { data, error } = await supabase.rpc('pcnwatch_map_cells', {
      p_authority_slug: query.authority,
      p_min_lon: query.minLon,
      p_min_lat: query.minLat,
      p_max_lon: query.maxLon,
      p_max_lat: query.maxLat,
      p_zoom: query.zoom,
      p_period_key: query.period,
    });
    if (error) throw error;

    const cells = (data ?? []).map((row: Record<string, unknown>) => ({
      cellKey: String(row.cell_key),
      longitude: Number(row.longitude),
      latitude: Number(row.latitude),
      pcnCount: Number(row.pcn_count ?? 0),
      locationCount: Number(row.location_count ?? 0),
      maxScore: row.max_score === null ? null : Number(row.max_score),
      maxClassification: (row.max_classification as string | null) ?? null,
      isSingleLocation: Boolean(row.is_single_location),
      locationSlug: (row.location_slug as string | null) ?? null,
      displayName: (row.display_name as string | null) ?? null,
    }));

    return NextResponse.json(
      {
        ok: true,
        cells,
        totalPcns: cells.reduce((acc: number, c: { pcnCount: number }) => acc + c.pcnCount, 0),
        coverage: { state: coverage.state, headline: coverage.headline, detail: coverage.detail },
      },
      { headers: { 'cache-control': 'public, max-age=60, stale-while-revalidate=300' } },
    );
  } catch (error) {
    const correlationId = logError('api.map.cells', error, { authority: query.authority });
    return NextResponse.json(
      { ok: false, error: { ...toUserFacingError(error, correlationId), correlationId } },
      { status: 503 },
    );
  }
}
