import { NextResponse } from 'next/server';
import { serverEnv, isConfigured } from '@/lib/env';
import { logError, logInfo } from '@/lib/errors';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import {
  fetchLatestCharge,
  interpretCheckoutEvent,
  verifyWebhookSignature,
} from '@/server/payments/stripe';
import { grantEntitlementsForPayment } from '@/server/payments/entitlements';
import { getProduct } from '@/server/payments/catalogue';
import {
  claimEvent,
  closeAttemptBySession,
  completeEvent,
  recordCharge,
  releaseEvent,
} from '@/server/payments/attempts';

/**
 * Stripe webhook — the sole authority on whether something was paid for.
 *
 * Order of operations matters:
 *   1. Read the RAW body. Parsing first would change the bytes and break the
 *      signature check.
 *   2. Verify the signature. An unverified body is discarded without being read.
 *   3. Claim the event id, so a repeat delivery stops here.
 *   4. Interpret the event, including checking the amount against the catalogue.
 *   5. Record the payment, then grant entitlements.
 *
 * Idempotency has two layers, and both are needed. The event claim stops the
 * same event being processed twice, including concurrently. The unique session
 * id and the entitlement upsert stop *different* events about the same session
 * — `completed` and `async_payment_succeeded` are two events, one payment —
 * from granting twice.
 *
 * Every failure path after the claim releases it, so Stripe's retry is not
 * short-circuited by a claim whose work never happened.
 */

interface StripeEventEnvelope {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly livemode?: unknown;
}

export async function POST(request: Request) {
  if (!isConfigured('stripe')) {
    logError('stripe.webhook', new Error('STRIPE_NOT_CONFIGURED'));
    return NextResponse.json({ received: false }, { status: 503 });
  }

  const env = serverEnv();
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');

  const verification = verifyWebhookSignature(
    rawBody,
    signature,
    env.STRIPE_WEBHOOK_SECRET as string,
  );

  if (!verification.valid) {
    // A failed signature is a security event, logged without the body.
    logError('stripe.webhook.signature', new Error(verification.reason ?? 'invalid signature'), {
      hasSignature: Boolean(signature),
    });
    return NextResponse.json({ received: false }, { status: 400 });
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch (error) {
    logError('stripe.webhook.parse', error);
    return NextResponse.json({ received: false }, { status: 400 });
  }

  const envelope = (event ?? {}) as StripeEventEnvelope;
  const eventId = typeof envelope.id === 'string' ? envelope.id : null;
  const eventType = typeof envelope.type === 'string' ? envelope.type : 'unknown';
  const eventLivemode = envelope.livemode === true;

  if (!eventId) {
    logError('stripe.webhook.envelope', new Error('The event carried no id.'));
    // 200: an event without an id cannot be claimed, and retrying it would
    // arrive in exactly the same state.
    return NextResponse.json({ received: true, acted: false });
  }

  /*
   * Claim before acting, not after.
   *
   * Two concurrent deliveries of the same event would both pass a
   * read-then-write check and both grant. The primary key on `stripe_events`
   * makes the second one collide instead.
   */
  const claim = await claimEvent(eventId, eventType, eventLivemode);
  if (claim === 'ALREADY_PROCESSED') {
    logInfo('stripe.webhook', 'Duplicate event ignored', { eventType });
    return NextResponse.json({ received: true, acted: false, duplicate: true });
  }
  if (claim === 'UNAVAILABLE') {
    // 500 so Stripe retries. Acting on an event we could not record risks
    // granting twice; refusing it costs a retry.
    logError('stripe.webhook.claim', new Error('The event could not be claimed.'), { eventType });
    return NextResponse.json({ received: false }, { status: 500 });
  }

  const interpretation = interpretCheckoutEvent(event);

  if (interpretation.kind === 'IGNORED') {
    logInfo('stripe.webhook', 'Event ignored', { reason: interpretation.reason });
    await completeEvent(eventId, 'IGNORED');
    return NextResponse.json({ received: true, acted: false });
  }

  if (interpretation.kind === 'INVALID') {
    logError('stripe.webhook.invalid', new Error(interpretation.reason));
    await completeEvent(eventId, 'REJECTED');
    // 200 so Stripe stops retrying an event we will never accept.
    return NextResponse.json({ received: true, acted: false });
  }

  if (interpretation.kind === 'EXPIRED') {
    /*
     * The attempt ended without a payment. Nothing is granted and nothing is
     * revoked: `closeAttemptBySession` only touches a PENDING row, so an
     * expiry arriving after the completion cannot undo it.
     */
    try {
      await closeAttemptBySession(interpretation.sessionId, 'SESSION_EXPIRED');
      await completeEvent(eventId, 'ACTED');
      logInfo('stripe.webhook', 'Checkout session expired');
      return NextResponse.json({ received: true, acted: true });
    } catch (error) {
      const correlationId = logError('stripe.webhook.expire', error);
      await releaseEvent(eventId);
      return NextResponse.json({ received: false, correlationId }, { status: 500 });
    }
  }

  const { checkout } = interpretation;
  const product = getProduct(checkout.productSku);
  if (!product) {
    await completeEvent(eventId, 'REJECTED');
    return NextResponse.json({ received: true, acted: false });
  }

  try {
    const supabase = createSupabaseServiceClient();
    if (!supabase) throw new Error('SUPABASE_CLIENT_UNAVAILABLE');

    const { data: productRow } = await supabase
      .from('products')
      .select('id')
      .eq('sku', checkout.productSku)
      .maybeSingle();

    if (!productRow) {
      logError('stripe.webhook.product', new Error(`Product ${checkout.productSku} is not seeded.`));
      await completeEvent(eventId, 'REJECTED');
      return NextResponse.json({ received: true, acted: false });
    }

    /*
     * Upsert on the session id, which is what makes the PENDING row written at
     * checkout become the PAID row rather than a second row beside it — and
     * what makes `async_payment_succeeded` after `completed` a no-op update.
     *
     * confirmed_by_webhook_at is what the database CHECK constraint requires
     * before a payment may be PAID. Only this code path sets it.
     */
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .upsert(
        {
          user_id: checkout.userId,
          case_id: checkout.caseId,
          product_id: productRow.id,
          status: 'PAID',
          amount_pence: checkout.amountPence,
          currency: checkout.currency,
          stripe_checkout_session_id: checkout.sessionId,
          stripe_payment_intent_id: checkout.paymentIntentId,
          // What actually happened, read off the event rather than inferred
          // from how this deployment happens to be configured.
          livemode: checkout.livemode,
          confirmed_by_webhook_at: new Date().toISOString(),
          failure_reason: null,
        },
        { onConflict: 'stripe_checkout_session_id' },
      )
      .select('id')
      .single();
    if (paymentError) throw paymentError;

    const paymentId = String(payment.id);

    if (checkout.caseId) {
      const result = await grantEntitlementsForPayment({
        userId: checkout.userId,
        caseId: checkout.caseId,
        productSku: checkout.productSku,
        paymentId,
      });
      if (result.error) throw new Error(result.error);
    }

    await supabase.from('audit_events').insert({
      user_id: checkout.userId,
      actor: 'STRIPE_WEBHOOK',
      action: 'PAYMENT_CONFIRMED',
      entity_type: 'payment',
      entity_id: payment.id,
      metadata: {
        productSku: checkout.productSku,
        amountPence: checkout.amountPence,
        livemode: checkout.livemode,
      },
    });

    await completeEvent(eventId, 'ACTED', paymentId);

    // After the claim is completed and the entitlement granted, so a slow or
    // failing lookup cannot cost the customer their product.
    if (checkout.paymentIntentId) {
      const chargeId = await fetchLatestCharge(checkout.paymentIntentId);
      if (chargeId) await recordCharge(paymentId, chargeId);
    }

    logInfo('stripe.webhook', 'Payment confirmed', {
      productSku: checkout.productSku,
      livemode: checkout.livemode,
    });
    return NextResponse.json({ received: true, acted: true });
  } catch (error) {
    const correlationId = logError('stripe.webhook.persist', error, {
      productSku: checkout.productSku,
    });
    /*
     * Release the claim, then 500.
     *
     * Without the release the retry would find the event already claimed and
     * stop — the customer would have paid and never been granted anything,
     * which is the worst outcome this route has.
     */
    await releaseEvent(eventId);
    return NextResponse.json({ received: false, correlationId }, { status: 500 });
  }
}
