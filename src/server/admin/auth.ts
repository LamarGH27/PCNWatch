import { serverEnv } from '@/lib/env';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Admin access control.
 *
 * Deliberately simple: an explicit email allow-list held in an environment
 * variable, checked against the signed-in Supabase user. There is no admin flag
 * in the database, so escalating to admin requires access to the deployment
 * configuration rather than to a row.
 *
 * An empty allow-list denies everyone. A misconfigured deployment must not
 * accidentally expose operational data.
 *
 * Two checks beyond the address itself, both because of how ordinary customers
 * sign in here. PCNWatch identity is `signInAnonymously()` — a real row in
 * `auth.users` holding the `authenticated` role, with no email. An anonymous
 * user is therefore rejected explicitly rather than relying on their email
 * being null, so that a future change which gives anonymous users an address
 * cannot quietly turn one into an administrator. And an unconfirmed address is
 * rejected because an unconfirmed address is a claim, not a proof: it says
 * somebody typed it, not that they can read mail sent to it.
 */

export interface AdminCheck {
  readonly allowed: boolean;
  readonly reason:
    | 'OK'
    | 'NOT_SIGNED_IN'
    | 'ANONYMOUS'
    | 'EMAIL_UNCONFIRMED'
    | 'NOT_ON_ALLOWLIST'
    | 'ALLOWLIST_EMPTY'
    | 'UNAVAILABLE';
}

/** The only facts about a session that admin access is allowed to turn on. */
export interface AdminIdentity {
  readonly email: string | null;
  readonly isAnonymous: boolean;
  readonly emailConfirmed: boolean;
}

export function parseAllowlist(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** Pure decision, extracted so the policy can be tested without a session. */
export function decideAdminAccess(
  allowlist: readonly string[],
  identity: AdminIdentity | null,
): AdminCheck {
  if (allowlist.length === 0) return { allowed: false, reason: 'ALLOWLIST_EMPTY' };
  if (!identity) return { allowed: false, reason: 'NOT_SIGNED_IN' };
  // Before the address is even looked at: an anonymous session is a customer's,
  // whatever it happens to carry.
  if (identity.isAnonymous) return { allowed: false, reason: 'ANONYMOUS' };
  if (!identity.email) return { allowed: false, reason: 'NOT_SIGNED_IN' };
  if (!identity.emailConfirmed) return { allowed: false, reason: 'EMAIL_UNCONFIRMED' };

  return allowlist.includes(identity.email.toLowerCase())
    ? { allowed: true, reason: 'OK' }
    : { allowed: false, reason: 'NOT_ON_ALLOWLIST' };
}

export async function checkAdminAccess(): Promise<AdminCheck> {
  let allowlist: string[];
  try {
    allowlist = parseAllowlist(serverEnv().ADMIN_EMAIL_ALLOWLIST);
  } catch {
    return { allowed: false, reason: 'UNAVAILABLE' };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { allowed: false, reason: 'UNAVAILABLE' };

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return decideAdminAccess(allowlist, null);

  return decideAdminAccess(allowlist, {
    email: user.email ?? null,
    // `is_anonymous` is Supabase's own flag on the user row, not an inference
    // from the absence of an address.
    isAnonymous: user.is_anonymous === true,
    emailConfirmed: Boolean(user.email_confirmed_at ?? user.confirmed_at),
  });
}
