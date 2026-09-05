import type { MetadataRoute } from 'next';
import { publicEnv } from '@/lib/env';
import { indexableContraventions, referencesByCategory } from '@/core/reference/store';
import { LONDON_AUTHORITIES } from '@/server/repositories/authorities-data';
import { COVERAGE_SCOPE } from '@/core/coverage/coverage';
import { getHotspots } from '@/server/repositories/enforcement';

/**
 * Sitemap.
 *
 * Only pages with real content are listed. Contravention pages awaiting legal
 * review are excluded (they are also `noindex`), and location pages are listed
 * only where enough data exists to make the page worth a visit — mass-generating
 * thin pages is exactly what the product must not do.
 */

/**
 * Rendered per request rather than at build time.
 *
 * The location entries come from the database. Prerendered, a build run while
 * the database was unreachable would ship a sitemap missing every location page
 * and keep serving it — a static sitemap has nothing to revalidate it. Crawler
 * traffic is negligible and the query is one call, so computing it per request
 * costs little and can never be silently wrong.
 */
export const dynamic = 'force-dynamic';

const MIN_PCNS_FOR_INDEXING = 20;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = publicEnv.NEXT_PUBLIC_SITE_URL.replace(/\/$/, '');
  const now = new Date();

  const entries: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: now, changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/map`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/hotspots`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/codes`, lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/boroughs`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${base}/legal/scope`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${base}/legal/privacy`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${base}/legal/sources`, lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
  ];

  // Reviewed contravention pages only.
  for (const record of indexableContraventions()) {
    const code = String((record.content as { code?: string }).code ?? '');
    if (code) {
      entries.push({
        url: `${base}/codes/${code}`,
        lastModified: record.reviewedAt ? new Date(record.reviewedAt) : now,
        changeFrequency: 'yearly',
        priority: 0.6,
      });
    }
  }

  // Location pages with enough activity to be substantive.
  for (const slug of COVERAGE_SCOPE.liveAuthoritySlugs) {
    const result = await getHotspots({ authoritySlug: slug, periodKey: '12M', limit: 200 });
    if (!result.ok) continue;
    for (const row of result.data) {
      if (row.totalPcns < MIN_PCNS_FOR_INDEXING) continue;
      entries.push({
        url: `${base}/hotspots/${row.authoritySlug}/${row.slug}`,
        lastModified: now,
        changeFrequency: 'weekly',
        priority: 0.7,
      });
    }
  }

  // Only list boroughs whose directory entry carries something useful.
  for (const authority of LONDON_AUTHORITIES) {
    if (authority.mapCoverage === 'LIVE' || authority.challengeInfoUrl) {
      entries.push({
        url: `${base}/boroughs#${authority.slug}`,
        lastModified: now,
        changeFrequency: 'monthly',
        priority: 0.4,
      });
    }
  }

  // A sanity check that we are not listing more reference pages than we hold.
  const held = referencesByCategory('CONTRAVENTION').length;
  if (indexableContraventions().length > held) {
    throw new Error('Sitemap would list more contravention pages than the reference store holds.');
  }

  return entries;
}
