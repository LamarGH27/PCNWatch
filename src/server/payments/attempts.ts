import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { logError } from '@/lib/errors';
import type { Product } from './catalogue';

/**
 * The payment record, from before the money to after it.
 *
 * `payments` was only ever written by the webhook, so a session that was
 * created and then abandoned existed nowhere but Stripe. That is fine until
 * somebody asks why a user says they paid and we have no record of them ever
 * having tried.
 *
 * A row is written when the Checkout Session is created, PENDING, and the
 * webhook promotes it. The database will not let this file promote it: the
 * `payments_paid_requires_webhook` constraint from 0005 refuses status PAID
 * without `confirmed_by_webhook_at`, which only the webhook sets.
 *
 * Service role, because a user must not be able to write their own payment row
 * and RLS grants them no INSERT on this table. Every function here therefore
 * takes the user id from a caller that has already verified the session, and
 * none of them takes it from a request.
 */

export interface PendingAttempt {
  readonly paymentId: string;
  readonly sessionId: string | null;
}

/**
 * An open attempt for this user, case and product, if one exists.
 *
 * Reused so a double-tap does not create a second Checkout Session and a
 * second row. A user who genuinely returns later gets the same session back
 * while it is still valid, which is also what Stripe's own hosted page does.
 */
export async function findOpenAttempt(
  userId: string,
  caseId: string,
  productId: string,
): Promise<PendingAttempt | null> {
  try {
    const supabase = createSupabaseServiceClient();
    if (!supabase) return null;

    const { data, error } = await supabase
      .from('payments')
      .select('id, stripe_checkout_session_id, session_expires_at')
      .eq('user_id', userId)
      .eq('case_id', caseId)
      .eq('product_id', productId)
      .eq('status', 'PENDING')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;

    const row = data?.[0];
    if (!row) return null;

    // An expired session is not reusable; a new attempt is correct.
    const expiresAt = row.session_expires_at ? Date.parse(String(row.session_expires_at)) : null;
    if (expiresAt !== null && expiresAt < Date.now()) return null;

    return {
      paymentId: String(row.id),
      sessionId: (row.stripe_checkout_session_id as string | null) ?? null,
    };
  } catch (error) {
    // A failure to find an existing attempt means a new one, which is safe:
    // two sessions cannot both be paid, and only one grants.
    logError('payments.findOpenAttempt', error, { caseId });
    return null;
  }
}

/** Opens a PENDING payment row. Returns its id, which becomes the attempt id. */
export async function openAttempt(args: {
  readonly userId: string;
  readonly caseId: string;
  readonly productId: string;
  readonly product: Product;
}): Promise<string | null> {
  try {
    const supabase = createSupabaseServiceClient();
    if (!supabase) return null;

    const { data, error } = await supabase
      .from('payments')
      .insert({
        user_id: args.userId,
        case_id: args.caseId,
        product_id: args.productId,
        // The only status this file may write. PAID is the webhook's, and the
        // database refuses it here regardless.
        status: 'PENDING',
        amount_pence: args.product.pricePence,
        currency: args.product.currency,
        session_created_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error) throw error;

    return String(data.id);
  } catch (error) {
    logError('payments.openAttempt', error, { caseId: args.caseId });
    return null;
  }
}

/** Records the session Stripe created against the attempt that asked for it. */
export async function attachSession(
  paymentId: string,
  session: { id: string; expiresAt: number | null; priceId: string },
): Promise<void> {
  try {
    const supabase = createSupabaseServiceClient();
    if (!supabase) return;

    await supabase
      .from('payments')
      .update({
        stripe_checkout_session_id: session.id,
        stripe_price_id: session.priceId,
        session_expires_at:
          session.expiresAt === null ? null : new Date(session.expiresAt * 1000).toISOString(),
      })
      .eq('id', paymentId);
  } catch (error) {
    logError('payments.attachSession', error, { paymentId });
  }
}

/**
 * Closes an attempt that will not complete.
 *
 * Called for a cancelled or expired session. Never for a failure to reach
 * Stripe at all: an attempt we could not start is not a payment that failed,
 * and marking it as one would put a phantom failure in front of support.
 */
export async function closeAttempt(paymentId: string, reason: string): Promise<void> {
  try {
    const supabase = createSupabaseServiceClient();
    if (!supabase) return;

    await supabase
      .from('payments')
      .update({ status: 'FAILED', failure_reason: reason.slice(0, 200) })
      .eq('id', paymentId)
      // Only an attempt that never completed. A paid row is never reopened by
      // a late cancellation event arriving out of order.
      .eq('status', 'PENDING');
  } catch (error) {
    logError('payments.closeAttempt', error, { paymentId });
  }
}

/**
 * Closes the attempt a Stripe session belongs to.
 *
 * The webhook knows the session id, not our payment id. Guarded on PENDING for
 * the same reason as `closeAttempt`: a late `checkout.session.expired` must not
 * be able to un-pay a row the completed event already promoted.
 */
export async function closeAttemptBySession(sessionId: string, reason: string): Promise<void> {
  try {
    const supabase = createSupabaseServiceClient();
    if (!supabase) return;

    await supabase
      .from('payments')
      .update({ status: 'FAILED', failure_reason: reason.slice(0, 200) })
      .eq('stripe_checkout_session_id', sessionId)
      .eq('status', 'PENDING');
  } catch (error) {
    logError('payments.closeAttemptBySession', error);
  }
}

/** Records the charge id against a paid row. Support metadata; best effort. */
export async function recordCharge(paymentId: string, chargeId: string): Promise<void> {
  try {
    const supabase = createSupabaseServiceClient();
    if (!supabase) return;
    await supabase.from('payments').update({ stripe_charge_id: chargeId }).eq('id', paymentId);
  } catch (error) {
    logError('payments.recordCharge', error, { paymentId });
  }
}

/* ------------------------------------------------------------------ */
/* Webhook event idempotency                                           */
/* ------------------------------------------------------------------ */

export type EventClaim = 'CLAIMED' | 'ALREADY_PROCESSED' | 'UNAVAILABLE';

/**
 * Claims a Stripe event id, or reports that it has been handled.
 *
 * Insert-and-collide rather than read-then-write: two concurrent deliveries of
 * the same event both read "not processed" under the second design and both
 * proceed. The primary key makes the race impossible instead of unlikely.
 */
export async function claimEvent(
  eventId: string,
  type: string,
  livemode: boolean,
): Promise<EventClaim> {
  try {
    const supabase = createSupabaseServiceClient();
    if (!supabase) return 'UNAVAILABLE';

    const { error } = await supabase
      .from('stripe_events')
      .insert({ id: eventId, type, livemode });

    if (error) {
      // 23505: the event id already exists, so somebody has it.
      if (String((error as { code?: string }).code) === '23505') return 'ALREADY_PROCESSED';
      throw error;
    }
    return 'CLAIMED';
  } catch (error) {
    /*
     * Unavailable, not claimed.
     *
     * The caller returns a 5xx so Stripe retries. Processing an event we could
     * not record would risk granting twice; refusing it costs a retry.
     */
    logError('payments.claimEvent', error, { eventId });
    return 'UNAVAILABLE';
  }
}

/** Records what happened to a claimed event. Best effort. */
export async function completeEvent(
  eventId: string,
  outcome: 'ACTED' | 'IGNORED' | 'REJECTED',
  paymentId?: string,
): Promise<void> {
  try {
    const supabase = createSupabaseServiceClient();
    if (!supabase) return;
    await supabase
      .from('stripe_events')
      .update({ outcome, processed_at: new Date().toISOString(), payment_id: paymentId ?? null })
      .eq('id', eventId);
  } catch (error) {
    logError('payments.completeEvent', error, { eventId });
  }
}

/**
 * Releases a claim whose processing failed.
 *
 * Without this, a transient database error after the claim would leave the
 * event permanently marked as seen and never processed — the user pays and
 * never gets the product, and Stripe's retries all short-circuit on the claim.
 */
export async function releaseEvent(eventId: string): Promise<void> {
  try {
    const supabase = createSupabaseServiceClient();
    if (!supabase) return;
    await supabase.from('stripe_events').delete().eq('id', eventId).is('processed_at', null);
  } catch (error) {
    logError('payments.releaseEvent', error, { eventId });
  }
}
