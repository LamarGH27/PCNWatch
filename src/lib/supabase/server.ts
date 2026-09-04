import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { publicEnv, serverEnv, supabasePublicConfigured } from '@/lib/env';

/**
 * Request-scoped Supabase client that carries the signed-in user's session.
 *
 * Every query made through this client is subject to RLS. Use it for anything
 * touching user data — never the service-role client.
 */
export async function createSupabaseServerClient() {
  if (!supabasePublicConfigured) return null;
  const cookieStore = await cookies();

  return createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL as string,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // Session refresh is handled by middleware instead.
          }
        },
      },
    },
  );
}

/**
 * Service-role client. Bypasses RLS entirely.
 *
 * Permitted uses, and no others:
 *   - the ingestion pipeline writing enforcement data
 *   - the Stripe webhook recording payments and granting entitlements
 *   - the admin data-health page reading operational tables
 *
 * Never construct this in response to a user-supplied identifier without checking
 * ownership yourself first, because RLS will not do it for you.
 */
export function createSupabaseServiceClient() {
  if (typeof window !== 'undefined') {
    throw new Error('The service-role client must never be constructed in the browser.');
  }
  const env = serverEnv();
  if (!publicEnv.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;

  return createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      cookies: { getAll: () => [], setAll: () => {} },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}
