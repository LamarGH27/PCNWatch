import { NextResponse } from 'next/server';
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server';
import { featureFlags } from '@/lib/env';
import { AppError, logError } from '@/lib/errors';
import { getProduct } from '@/server/payments/catalogue';
import { createCheckoutSession } from '@/server/payments/stripe';
import { attachSession, findOpenAttempt, openAttempt } from '@/server/payments/attempts';
import { stripeReady } from '@/server/payments/mode';
import { checkoutOrigin, checkoutReturnUrls } from '@/server/payments/origin';
import { rateLimit } from '@/server/rate-limit';

/**
 * Starts a Stripe Checkout session.
 *
 * Everything that decides what is charged is decided here, on the server. The
 * request says which case; it does not say the product, the amount, the
 * currency or the entitlement, and there is no parameter through which it
 * could. A caller who posts `{ amountPence: 1 }` is posting a field nothing
 * reads.
 *
 * What this route does not do is more important than what it does: it grants
 * nothing. The success URL returns the user to their case and proves nothing
 * about payment; entitlement comes from the webhook, and the database will not
 * accept a PAID payment without it.
 */

interface CheckoutBody {
  readonly caseId?: unknown;
}

export async function POST(request: Request) {
  if (!featureFlags.payments) {
    return NextResponse.json(
      { ok: false, reason: 'PAYMENTS_DISABLED' as const, message: 'Payments are not enabled on this deployment.' },
      { status: 503 },
    );
  }

  /*
   * Test keys in Production, or Live keys anywhere else, and checkout closes.
   *
   * The second is the one that costs money in the wrong direction: a Test-mode
   * webhook looks exactly like a successful payment to everything downstream,
   * so Production on test keys would hand out the product and take nothing.
   */
  const mode = stripeReady();
  if (!mode.allowed) {
    logError('api.checkout.mode', new Error(mode.reason));
    return NextResponse.json(
      { ok: false, reason: 'PAYMENTS_UNAVAILABLE' as const, message: 'Payments are not available on this deployment.' },
      { status: 503 },
    );
  }

  /*
   * Where the user comes back to, established before anything is written.
   *
   * A Checkout Session that returns to the wrong deployment is worse than no
   * session at all: the payment succeeds and the customer lands somewhere their
   * session cookie does not exist, looking at a case that appears not to be
   * theirs. So an origin we cannot establish refuses checkout.
   */
  const origin = checkoutOrigin();
  if (!origin.ok) {
    logError('api.checkout.origin', new Error(origin.reason));
    return NextResponse.json(
      { ok: false, reason: 'PAYMENTS_UNAVAILABLE' as const, message: 'Payments are not available on this deployment.' },
      { status: 503 },
    );
  }

  const limited = await rateLimit(request, { key: 'checkout', limit: 10, windowSeconds: 600 });
  if (!limited.allowed) {
    return NextResponse.json(
      { ok: false, reason: 'RATE_LIMITED' as const, message: 'Too many attempts. Nothing has been charged.' },
      { status: 429, headers: { 'retry-after': String(limited.retryAfterSeconds) } },
    );
  }

  let caseId: string | null = null;
  try {
    const body = (await request.json()) as CheckoutBody;
    if (typeof body.caseId === 'string') caseId = body.caseId;
  } catch {
    // Falls through to the validation below.
  }
  if (!caseId || !/^[0-9a-f-]{36}$/i.test(caseId)) {
    return NextResponse.json({ ok: false, reason: 'BAD_REQUEST' as const }, { status: 400 });
  }

  /*
   * The product is not a parameter.
   *
   * There is one thing to buy and the server names it. A `sku` from the request
   * would be a field the browser could point at a cheaper product, and the only
   * reason to accept one is a second product that does not exist yet.
   */
  const product = getProduct('PCNWATCH_DEFENCE');
  if (!product) {
    logError('api.checkout.catalogue', new Error('PCNWATCH_DEFENCE is missing from the catalogue.'));
    return NextResponse.json({ ok: false, reason: 'UNAVAILABLE' as const }, { status: 503 });
  }

  try {
    const supabase = await createSupabaseServerClient();
    if (!supabase) throw new Error('SUPABASE_NOT_CONFIGURED');

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ ok: false, reason: 'NOT_SIGNED_IN' as const }, { status: 401 });
    }

    /*
     * The case must be the caller's own, read through their own session.
     *
     * RLS returns no row for somebody else's case, so this is a check on
     * visibility rather than a second authorisation system — and it is what
     * stops a Checkout Session being created against a case the payer does not
     * own, which would grant them an entitlement on it when the webhook lands.
     */
    const { data: ownedCase } = await supabase
      .from('pcn_cases')
      .select('id')
      .eq('id', caseId)
      .maybeSingle();
    if (!ownedCase) {
      return NextResponse.json({ ok: false, reason: 'NOT_FOUND' as const }, { status: 404 });
    }

    const service = createSupabaseServiceClient();
    if (!service) throw new Error('SUPABASE_SERVICE_UNAVAILABLE');

    const { data: productRow } = await service
      .from('products')
      .select('id')
      .eq('sku', product.sku)
      .maybeSingle();
    if (!productRow) {
      logError('api.checkout.product', new Error(`Product ${product.sku} is not seeded.`));
      return NextResponse.json({ ok: false, reason: 'UNAVAILABLE' as const }, { status: 503 });
    }

    // Already paid? Then there is nothing to buy, and offering to charge again
    // would be the product's fault rather than the user's.
    const { data: existing } = await service
      .from('entitlements')
      .select('id')
      .eq('user_id', user.id)
      .eq('case_id', caseId)
      .eq('entitlement', 'CHALLENGE_DRAFT')
      .maybeSingle();
    if (existing) {
      return NextResponse.json({ ok: true as const, alreadyEntitled: true as const });
    }

    const productId = String(productRow.id);
    const open = await findOpenAttempt(user.id, caseId, productId);
    const paymentId = open?.paymentId ?? (await openAttempt({
      userId: user.id,
      caseId,
      productId,
      product,
    }));
    if (!paymentId) throw new Error('PAYMENT_ROW_NOT_CREATED');

    /*
     * Where Stripe sends them back. Derived from the deployment, never from
     * the request — see `origin.ts`. Identifies where to look on return, and
     * proves nothing about payment.
     */
    const { successUrl, cancelUrl } = checkoutReturnUrls(origin.origin, caseId);
    const session = await createCheckoutSession({
      product,
      userId: user.id,
      caseId,
      customerEmail: user.email ?? undefined,
      successUrl,
      cancelUrl,
      // One attempt, one session. See CheckoutSessionRequest.attemptId.
      attemptId: paymentId,
    });

    await attachSession(paymentId, {
      id: session.id,
      expiresAt: session.expiresAt,
      priceId: session.priceId,
    });

    return NextResponse.json({ ok: true as const, url: session.url });
  } catch (error) {
    const correlationId = logError('api.checkout', error, { caseId });
    /*
     * Stripe unreachable, or anything else. Nothing has been charged, and the
     * PENDING row stays PENDING rather than being marked failed: an attempt we
     * could not start is not a payment that failed, and recording it as one
     * would put a phantom failure in front of support.
     */
    if (error instanceof AppError) {
      return NextResponse.json(
        { ok: false, reason: 'UNAVAILABLE' as const, message: error.what, whatYouCanDo: error.whatYouCanDo, correlationId },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        reason: 'UNAVAILABLE' as const,
        message: 'We could not start the payment.',
        whatYouCanDo: 'Nothing has been charged. Please try again in a moment.',
        correlationId,
      },
      { status: 503 },
    );
  }
}
