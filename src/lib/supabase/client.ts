'use client';

import { createBrowserClient } from '@supabase/ssr';
import { publicEnv, supabasePublicConfigured } from '@/lib/env';

/**
 * Browser Supabase client.
 *
 * Returns null when Supabase is not configured, so callers must handle the
 * unconfigured case explicitly rather than crashing at import time. Only the anon
 * key ever reaches the browser.
 */
export function createClient() {
  if (!supabasePublicConfigured) return null;
  return createBrowserClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL as string,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
  );
}
