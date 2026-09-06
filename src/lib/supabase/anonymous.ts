'use client';

import { createClient } from './client';

/**
 * The anonymous identity a saved case belongs to.
 *
 * PCNWatch asks people to do real work — photograph a notice, check fourteen
 * fields, describe what happened — before it has anything to offer them. Putting
 * a sign-up form in front of that is asking for an email address in exchange for
 * nothing, so instead the first save creates a Supabase anonymous user and the
 * case belongs to that.
 *
 * It is a real identity, not a stand-in for one: a row in `auth.users` holding
 * the `authenticated` role, which is what the existing RLS policy already keys
 * on. Nothing about the security model changes to accommodate it, and no
 * application-level identifier is invented — the database decides the owner from
 * the session, and RLS decides what that owner can see.
 *
 * Its limitation is real and the UI says so: the session lives in this browser.
 * Clear the site data and the identity is gone, and with it the way back to the
 * case. That is why the copy says "saved privately in this browser" rather than
 * "saved to your account".
 */

export type IdentityResult =
  | { readonly kind: 'READY' }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: 'NOT_CONFIGURED' | 'SIGN_IN_FAILED' };

/**
 * Ensures there is a session, creating an anonymous one only if there is none.
 *
 * Called at the point of saving rather than on page load. A visitor who reads
 * the map and leaves should not have an identity created for them, and an
 * identity that exists before there is anything to attach it to is just a
 * cookie nobody asked for.
 */
export async function ensureAnonymousIdentity(): Promise<IdentityResult> {
  const supabase = createClient();
  if (!supabase) return { kind: 'UNAVAILABLE', reason: 'NOT_CONFIGURED' };

  const { data } = await supabase.auth.getSession();
  if (data.session) return { kind: 'READY' };

  const { error } = await supabase.auth.signInAnonymously();
  if (error) {
    // Anonymous sign-ins can be disabled in the Supabase dashboard, and are
    // rate limited per IP. Either way the caller degrades to an unsaved
    // assessment rather than losing the user's work behind an error.
    return { kind: 'UNAVAILABLE', reason: 'SIGN_IN_FAILED' };
  }
  return { kind: 'READY' };
}

/** Whether a session already exists, without creating one. */
export async function hasIdentity(): Promise<boolean> {
  const supabase = createClient();
  if (!supabase) return false;
  const { data } = await supabase.auth.getSession();
  return data.session !== null;
}
