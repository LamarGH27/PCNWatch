import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { logError } from '@/lib/errors';
import { type Entitlement, getProduct } from './catalogue';

/**
 * Entitlement checks.
 *
 * The rule this file exists to enforce: **a Stripe success redirect never grants
 * anything.** Entitlement comes from a row written by the webhook handler, which
 * is the only thing that observes a payment actually succeeding.
 *
 * There are three independent layers, so a mistake in any one of them is not
 * sufficient to give away a paid product:
 *   1. The database CHECK constraint on `payments` forbids status PAID without
 *      confirmed_by_webhook_at (migration 0005).
 *   2. RLS grants a client SELECT on entitlements but never INSERT, so a user
 *      cannot write their own (migration 0006).
 *   3. This module reads entitlements only from persisted rows, never from a
 *      request parameter, and the checkout return page treats its parameters as
 *      a hint about where to look, not as proof of anything.
 */

export interface EntitlementCheck {
  readonly granted: boolean;
  readonly entitlement: Entitlement;
  readonly reason: string;
}

/** Every entitlement a user holds on a case, read from persisted rows only. */
export async function getEntitlements(
  userId: string,
  caseId: string,
): Promise<Set<Entitlement>> {
  const granted = new Set<Entitlement>();
  try {
    const supabase = createSupabaseServiceClient();
    if (!supabase) return granted;

    const { data, error } = await supabase
      .from('entitlements')
      .select('entitlement, expires_at')
      .eq('user_id', userId)
      .eq('case_id', caseId);
    if (error) throw error;

    const now = Date.now();
    for (const row of data ?? []) {
      if (row.expires_at && new Date(row.expires_at).getTime() < now) continue;
      granted.add(row.entitlement as Entitlement);
    }
  } catch (error) {
    // Fails closed: an error reading entitlements means the user does not get the
    // paid feature. The opposite default would give the product away on a blip.
    logError('payments.getEntitlements', error, { caseId });
  }
  return granted;
}

export async function requireEntitlement(
  userId: string,
  caseId: string,
  entitlement: Entitlement,
): Promise<EntitlementCheck> {
  const held = await getEntitlements(userId, caseId);
  if (held.has(entitlement)) {
    return { granted: true, entitlement, reason: 'Purchased and confirmed.' };
  }
  return {
    granted: false,
    entitlement,
    reason: 'This part of your case requires the Defence Pack, which has not been purchased yet.',
  };
}

/**
 * Grants the entitlements for a product. Called ONLY by the webhook handler.
 *
 * Idempotent: Stripe can deliver the same event more than once, so a repeated
 * call must not create duplicate rows or double-grant anything.
 */
export async function grantEntitlementsForPayment(args: {
  readonly userId: string;
  readonly caseId: string | null;
  readonly productSku: string;
  readonly paymentId: string;
}): Promise<{ granted: Entitlement[]; error: string | null }> {
  const product = getProduct(args.productSku);
  if (!product) {
    return { granted: [], error: `Unknown product SKU "${args.productSku}".` };
  }

  try {
    const supabase = createSupabaseServiceClient();
    if (!supabase) return { granted: [], error: 'Datastore unavailable.' };

    const rows = product.entitlements.map((entitlement) => ({
      user_id: args.userId,
      case_id: args.caseId,
      entitlement,
      payment_id: args.paymentId,
    }));

    const { error } = await supabase
      .from('entitlements')
      .upsert(rows, { onConflict: 'user_id,case_id,entitlement', ignoreDuplicates: true });
    if (error) throw error;

    return { granted: [...product.entitlements], error: null };
  } catch (error) {
    logError('payments.grantEntitlements', error, { productSku: args.productSku });
    return { granted: [], error: 'Could not record the entitlement.' };
  }
}

/**
 * What the checkout return page may conclude from its query parameters.
 *
 * The answer is: nothing about payment. The parameters tell us which case to look
 * at; the entitlement rows tell us whether anything was bought. This function
 * exists so that intent is written down in code rather than assumed.
 */
export function interpretCheckoutReturn(params: URLSearchParams): {
  readonly caseId: string | null;
  readonly grantsAnything: false;
  readonly message: string;
} {
  const caseId = params.get('case');
  return {
    caseId: caseId && /^[0-9a-f-]{36}$/i.test(caseId) ? caseId : null,
    grantsAnything: false,
    message:
      'Payment is confirmed by Stripe directly with our server. If your purchase has not appeared yet, it will within a few moments.',
  };
}
