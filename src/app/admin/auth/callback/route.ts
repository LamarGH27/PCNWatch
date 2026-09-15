import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { logError } from '@/lib/errors';

/**
 * Where a magic link lands.
 *
 * `createBrowserClient` uses the PKCE flow, so the link in the email comes back
 * carrying a `code` rather than a session. Something has to trade one for the
 * other, and it has to be a Route Handler: a Server Component cannot write the
 * session cookie, so doing this on the page itself would set nothing and send
 * the operator to a dashboard that still considered them signed out.
 *
 * The destination is a constant. Taking it from the query string is how a
 * sign-in callback becomes an open redirect, and there is only one page an
 * operator is signing in for anyway.
 */
export async function GET(request: Request) {
  const signIn = new URL('/admin/sign-in', request.url);
  const code = new URL(request.url).searchParams.get('code');
  if (!code) return NextResponse.redirect(signIn);

  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.redirect(signIn);

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    // An expired or already-used link. Back to the form, which says nothing
    // about whether the address was real.
    logError('admin.auth.callback', error);
    return NextResponse.redirect(signIn);
  }

  /*
   * A session, not an entitlement. `checkAdminAccess` still decides, so an
   * address that can receive mail but is not on the allow-list arrives here
   * successfully and is shown "Not available" like anybody else.
   */
  return NextResponse.redirect(new URL('/admin/analytics', request.url));
}
