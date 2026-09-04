import type { MetadataRoute } from 'next';
import { publicEnv } from '@/lib/env';

export default function robots(): MetadataRoute.Robots {
  const base = publicEnv.NEXT_PUBLIC_SITE_URL.replace(/\/$/, '');
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Everything behind these paths is a user's own case data.
        disallow: ['/api/', '/case/', '/analyse/', '/account/', '/admin/'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
