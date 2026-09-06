import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { publicEnv, supabasePublicConfigured } from '@/lib/env';

/**
 * Keeps the session alive across visits.
 *
 * A Supabase access token lasts about an hour; the refresh token outlives it.
 * Server Components can read cookies but not write them, so without this the
 * refreshed token would never be written back and a user returning the next day
 * would find their own cases invisible — RLS would be doing exactly its job on
 * a request that had quietly become anonymous-in-the-other-sense.
 *
 * `getUser()` is the call that performs the refresh. Its result is deliberately
 * unused: this exists for the cookie write, not for a decision. No route is
 * protected here, because protection is RLS's job and duplicating it in
 * middleware would create a second place to get it wrong.
 */
export async function middleware(request: NextRequest) {
  if (!supabasePublicConfigured) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL as string,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  try {
    await supabase.auth.getUser();
  } catch {
    // A refresh failure is not a reason to fail the page. The request continues
    // without a session and the user is told their case cannot be found, which
    // is the honest answer.
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and images. The map and the reference
     * pages do not need a session, but excluding them by path would mean
     * maintaining a second list of which routes touch user data.
     */
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
