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
 */

export interface AdminCheck {
  readonly allowed: boolean;
  readonly reason: 'OK' | 'NOT_SIGNED_IN' | 'NOT_ON_ALLOWLIST' | 'ALLOWLIST_EMPTY' | 'UNAVAILABLE';
}

export function parseAllowlist(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** Pure decision, extracted so the policy can be tested without a session. */
export function decideAdminAccess(allowlist: readonly string[], email: string | null): AdminCheck {
  if (allowlist.length === 0) return { allowed: false, reason: 'ALLOWLIST_EMPTY' };
  if (!email) return { allowed: false, reason: 'NOT_SIGNED_IN' };
  return allowlist.includes(email.toLowerCase())
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

  return decideAdminAccess(allowlist, user?.email ?? null);
}
