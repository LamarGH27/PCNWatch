import { NextResponse } from 'next/server';
import { serverEnv, isConfigured } from '@/lib/env';
import { logError, logInfo } from '@/lib/errors';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { interpretCheckoutEvent, verifyWebhookSignature } from '@/server/payments/stripe';
import { grantEntitlementsForPayment } from '@/server/payments/entitlements';
import { getProduct } from '@/server/payments/catalogue';

/**
 * Stripe webhook — the sole authority on whether something was paid for.
 *
 * Order of operations matters:
 *   1. Read the RAW body. Parsing first would change the bytes and break the
 *      signature check.
 *   2. Verify the signature. An unverified body is discarded without being read.
 *   3. Interpret the event, including checking the amount against the catalogue.
 *   4. Record the payment, then grant entitlements.
 *
 * Idempotency: Stripe retries. The payment row is keyed on the checkout session
 * id and entitlements are upserted, so a repeated delivery is a no-op.
 */

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

  const interpretation = interpretCheckoutEvent(event);

  if (interpretation.kind === 'IGNORED') {
    logInfo('stripe.webhook', 'Event ignored', { reason: interpretation.reason });
    return NextResponse.json({ received: true, acted: false });
  }

  if (interpretation.kind === 'INVALID') {
    logError('stripe.webhook.invalid', new Error(interpretation.reason));
    // 200 so Stripe stops retrying an event we will never accept.
    return NextResponse.json({ received: true, acted: false });
  }

  const { checkout } = interpretation;
  const product = getProduct(checkout.productSku);
  if (!product) return NextResponse.json({ received: true, acted: false });

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
      return NextResponse.json({ received: true, acted: false });
    }

    // confirmed_by_webhook_at is what the database CHECK constraint requires
    // before a payment may be PAID. Only this code path sets it.
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
          confirmed_by_webhook_at: new Date().toISOString(),
        },
        { onConflict: 'stripe_checkout_session_id' },
      )
      .select('id')
      .single();
    if (paymentError) throw paymentError;

    if (checkout.caseId) {
      const result = await grantEntitlementsForPayment({
        userId: checkout.userId,
        caseId: checkout.caseId,
        productSku: checkout.productSku,
        paymentId: String(payment.id),
      });
      if (result.error) throw new Error(result.error);
    }

    await supabase.from('audit_events').insert({
      user_id: checkout.userId,
      actor: 'STRIPE_WEBHOOK',
      action: 'PAYMENT_CONFIRMED',
      entity_type: 'payment',
      entity_id: payment.id,
      metadata: { productSku: checkout.productSku, amountPence: checkout.amountPence },
    });

    logInfo('stripe.webhook', 'Payment confirmed', { productSku: checkout.productSku });
    return NextResponse.json({ received: true, acted: true });
  } catch (error) {
    const correlationId = logError('stripe.webhook.persist', error, {
      productSku: checkout.productSku,
    });
    // 500 so Stripe retries: the payment happened and we must not lose it.
    return NextResponse.json({ received: false, correlationId }, { status: 500 });
  }
}
