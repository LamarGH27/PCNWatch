import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { isConfigured } from '@/lib/env';
import { logError } from '@/lib/errors';
import { normaliseStreetName, parsePostcodeDistrict } from '@/data-sources/shared/normalise';
import { rateLimit } from '@/server/rate-limit';

/**
 * Location search within a covered authority.
 *
 * Searches only locations FineRadar already holds. It is deliberately not a
 * general geocoder: returning a result for a street we have no data about would
 * imply coverage we do not have.
 */

const querySchema = z.object({
  authority: z.string().regex(/^[a-z0-9-]{1,64}$/),
  q: z.string().trim().min(2).max(120),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, results: [] }, { status: 400 });
  }

  const limited = await rateLimit(request, { key: 'map-search', limit: 60, windowSeconds: 60 });
  if (!limited.allowed) {
    return NextResponse.json({ ok: false, results: [] }, { status: 429 });
  }

  try {
    if (!isConfigured('supabase')) throw new Error('SUPABASE_NOT_CONFIGURED');
    const supabase = createSupabaseServiceClient();
    if (!supabase) throw new Error('SUPABASE_CLIENT_UNAVAILABLE');

    const { data: authority } = await supabase
      .from('authorities')
      .select('id')
      .eq('slug', parsed.data.authority)
      .maybeSingle();
    if (!authority) return NextResponse.json({ ok: true, results: [] });

    const term = normaliseStreetName(parsed.data.q);
    const district = parsePostcodeDistrict(parsed.data.q);

    let builder = supabase
      .from('parking_locations')
      .select('slug, display_name, street_name, geom')
      .eq('authority_id', authority.id)
      .not('geom', 'is', null)
      .limit(8);

    builder = district
      ? builder.eq('postcode_district', district)
      : builder.ilike('street_name_normalised', `%${term}%`);

    const { data, error } = await builder;
    if (error) throw error;

    return NextResponse.json({
      ok: true,
      results: (data ?? [])
        .map((row) => {
          const point = row.geom as unknown as { coordinates?: [number, number] } | null;
          const coordinates = point?.coordinates;
          if (!coordinates) return null;
          return {
            slug: String(row.slug),
            displayName: String(row.display_name),
            longitude: coordinates[0],
            latitude: coordinates[1],
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null),
    });
  } catch (error) {
    logError('api.map.search', error);
    return NextResponse.json({ ok: false, results: [] }, { status: 503 });
  }
}
